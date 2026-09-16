import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "os"
import path from "path"

// Bypass provider rate limits by rotating the outbound IP through HTTP proxies.
//
// This is an in-process, free-flow version of the standalone `ipswap` script:
// instead of a background watchdog that swaps a global `HTTP_PROXY` and
// restarts opencode, the provider's fetch path detects a rate limit (429/529)
// or a connection failure, finds a fresh working proxy on the fly, and retries
// the same request through it while the session keeps running. The user is
// informed of every switch so the rotation stays transparent (no terminal, no
// restart).
//
// Design notes:
// - Proxies are applied with Bun's per-request `fetch(input, { proxy })`
//   option, so nothing global is mutated and only the target request is routed.
// - Proxies are validated by proxying a lightweight request to the provider
//   host (e.g. `https://opencode.ai`). The validated pool is cached on disk and
//   reused for a short TTL, mirroring `ipswap`.
// - Rate limits rotate to another *working* proxy.
// - Connection failures ("Cannot connect to API: Unable to connect ...")
//   mean the current proxy is dead/unreachable, so that proxy is discarded and
//   the search restarts from scratch with a brand-new list.
//
// This module is intentionally dependency-free (only global `fetch` and Node
// builtins) so it stays simple and testable.

export type ProxyStatus =
  | { readonly kind: "keep" }
  | { readonly kind: "switch"; readonly proxy: string }
  | { readonly kind: "discard"; readonly proxy: string; readonly reason: string }
  | { readonly kind: "rescan"; readonly reason: string }

export interface ProxyRotatorOptions {
  /** Validation target host (just the origin), e.g. `https://opencode.ai`. */
  readonly target: string
  /** Identifier used for logs/cache, e.g. `opencode`. */
  readonly id: string
  /** Called with the latest proxy event so the UI can surface it. */
  readonly onStatus?: (status: ProxyStatus) => void
  /** Maximum times we retry the same provider request across proxy switches. */
  readonly maxAttempts?: number
  /**
   * Per-attempt hard timeout in milliseconds. The rotator aborts a request that
   * has not produced a response (headers) within this window and treats it as a
   * dead proxy, so a hung connection never parks the session. Defaults to 30s.
   * Pass `false` to rely solely on the caller's own timeouts.
   */
  readonly requestTimeoutMs?: number | false
  /** Override the cache directory (defaults to `~/.cache/opencode/proxies`). */
  readonly cacheDir?: string
  /** Extra proxy list URLs to fetch on top of the built-in sources. */
  readonly extraSources?: readonly string[]
  /** Override proxy discovery+validation (used by tests; defaults to the
   * public proxy lists). Must return validated, currently-working proxies. */
  readonly search?: () => Promise<string[]>
}

const RATE_LIMIT_STATUSES = new Set([429, 529])

const CONNECTION_ERROR_PATTERNS = [
  /cannot connect to api/i,
  /unable to connect/i,
  /fetch failed/i,
  /failed to fetch/i,
  /network error/i,
  /connection\s+(?:was\s+)?(?:refused|reset|closed|lost|terminated)/i,
  /socket hang up/i,
  /reset before headers/i,
  /getaddrinfo/i,
  /enotfound/i,
  /eai_again/i,
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /undici error/i,
  /terminated/i,
  /timed out/i,
  /the operation was aborted/i,
  /aborted/i,
]

// Public HTTP proxy lists used to discover candidate IPs. Same sources as the
// standalone `ipswap` script (GitHub raw). Each line is `ip:port` or a URL.
const PROXY_SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
  "https://raw.githubusercontent.com/UptimerBot/proxy-list/main/http.txt",
  "https://raw.githubusercontent.com/MuRongDeHei/ProxyNode/main/http.txt",
  "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
  "https://raw.githubusercontent.com/mertguvencli/http-proxy-list/main/proxy-list.txt",
  "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy.txt",
  "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
]

const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000
const VALIDATION_TIMEOUT_MS = 6_000
const CACHE_TTL_MS = 5 * 60_000
// Don't re-run an expensive proxy search more often than this.
const SEARCH_MIN_INTERVAL_MS = 20_000
const MAX_TESTED = 200
const TEST_CONCURRENCY = 30

interface CachedProxy {
  readonly timestamp: number
  readonly url: string
}

export class ProxyRotator {
  private readonly target: string
  private readonly id: string
  private onStatus?: ProxyRotatorOptions["onStatus"]
  private readonly maxAttempts: number
  private readonly requestTimeoutMs: number | false
  private readonly cachePath: string
  private readonly extraSources: readonly string[]
  private readonly searchOverride?: () => Promise<string[]>

  private activeProxy: string | undefined
  private readonly used = new Set<string>()
  private lastSearchAt = 0

  constructor(options: ProxyRotatorOptions) {
    this.target = options.target.replace(/\/$/, "")
    this.id = options.id
    this.onStatus = options.onStatus
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.cachePath = path.join(options.cacheDir ?? proxyCacheDir(), "working.txt")
    this.extraSources = options.extraSources ?? []
    this.searchOverride = options.search
  }

  get proxy(): string | undefined {
    return this.activeProxy
  }

  clearProxy(): void {
    this.activeProxy = undefined
  }

  /** Replace the status callback (used when a cached rotator is reused). */
  setStatus(onStatus?: ProxyRotatorOptions["onStatus"]): void {
    if (onStatus) this.onStatus = onStatus
  }

  /** True when a response is a rate limit that a fresh IP can dodge. */
  static isRateLimit(status: number): boolean {
    return RATE_LIMIT_STATUSES.has(status)
  }

  /**
   * True when a response status means the proxy should be rotated. Any 4xx/5xx
   * is treated as a proxy/upstream problem worth a fresh connection instead of
   * surfacing straight to the caller — that includes 404s served by a shared
   * gateway, 5xx, and auth/forbidden blocks that a different egress IP dodges.
   */
  static shouldRotate(status: number): boolean {
    return status >= 400
  }

  /** True when a thrown error means the proxy cannot reach the target at all. */
  static isConnectionFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  }

  /**
   * Execute `send(proxy)` and retry it across proxies until it succeeds, the
   * attempt budget is exhausted, or an error surfaces that a fresh connection
   * cannot plausibly fix. `send` is the actual provider request given the
   * current proxy (or `undefined` for a direct connection); it returns the HTTP
   * status and throws when the transport fails before a response is available.
   */
  async withRetry(
    send: (proxy: string | undefined, signal?: AbortSignal) => Promise<{ status: number; response: Response }>,
  ): Promise<{
    status: number
    response: Response
  }> {
    let proxy = this.activeProxy
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const timeout = this.requestTimeoutMs
      const controller = timeout !== false && timeout > 0 ? new AbortController() : undefined
      const timer = controller && timeout !== false ? setTimeout(() => controller.abort(), timeout) : undefined
      let result
      try {
        result = await send(proxy, controller?.signal)
      } catch (error) {
        clearTimeout(timer)
        // A failure to even connect (or a timeout before any response) means
        // this proxy (or a direct connection) is unusable — discard it and
        // restart the search from scratch.
        if (!ProxyRotator.isConnectionFailure(error)) throw error
        this.discard(proxy)
        proxy = await this.nextProxy(messageOf(error))
        // If the rescan didn't find any fresh proxies, there's nothing left
        // to try — throw instead of looping back with an undefined proxy.
        if (!proxy || attempt === this.maxAttempts) throw error
        continue
      }
      clearTimeout(timer)
      // Any non-2xx status is grounds for rotating to a fresh connection; a
      // working response is returned untouched.
      if (!ProxyRotator.shouldRotate(result.status)) return result
      if (attempt === this.maxAttempts) return result
      // A problem status must never retry through the same (or no) connection:
      // only continue when we actually have a fresh proxy to rotate to.
      const next = await this.nextProxy()
      if (!next) return result
      proxy = next
    }
    throw new Error("proxy retry budget exhausted")
  }

  /**
   * Pick the next unused proxy from the working pool. When the pool has no
   * candidate left (stale cache or an earlier empty search), force a fresh
   * list + validation pass before giving up so a rate limited request stands a
   * real chance of finding a new egress IP instead of parking the session.
   */
  private async nextProxy(reason = "no proxy available"): Promise<string | undefined> {
    const pool = await this.workingPool()
    const candidate = pool.find((url) => !this.used.has(url))
    if (candidate) {
      this.used.add(candidate)
      this.activeProxy = candidate
      this.onStatus?.({ kind: "switch", proxy: candidate })
      return candidate
    }

    // Every proxy in the cached pool has already been tried (typically each one
    // returned 429/5xx). Never reuse a dead/rate limited proxy: rescan the
    // internet for a fresh batch and validate it against the target before
    // falling back to a recycled proxy.
    this.onStatus?.({ kind: "rescan", reason })
    await this.search()
    const fresh = await this.workingPool()
    const next = fresh.find((url) => !this.used.has(url)) ?? fresh[0]
    if (!next) return undefined
    this.used.add(next)
    this.activeProxy = next
    this.onStatus?.({ kind: "switch", proxy: next })
    return next
  }

  private discard(proxy: string | undefined): void {
    if (!proxy) return
    this.used.add(proxy)
    if (this.activeProxy === proxy) this.activeProxy = undefined
    this.onStatus?.({ kind: "discard", proxy, reason: "could not connect through this proxy" })
  }

  /** Return a validated pool of proxies, reusing the on-disk cache when fresh. */
  private async workingPool(): Promise<readonly string[]> {
    const cached = readCache(this.cachePath)
    if (cached.length > 0) {
      const fresh = cached.filter((entry) => Date.now() - entry.timestamp < CACHE_TTL_MS).map((entry) => entry.url)
      if (fresh.length > 0) return fresh
    }
    // Don't hammer the proxy lists when the last search came up empty.
    if (Date.now() - this.lastSearchAt < SEARCH_MIN_INTERVAL_MS) return []
    await this.search()
    return readCache(this.cachePath)
      .filter((entry) => Date.now() - entry.timestamp < CACHE_TTL_MS)
      .map((entry) => entry.url)
  }

  /** Fetch fresh proxy lists and validate them against the target. */
  private async search(): Promise<void> {
    if (Date.now() - this.lastSearchAt < SEARCH_MIN_INTERVAL_MS) return
    const working = this.searchOverride ? await this.searchOverride() : await defaultSearch(this.target, [...PROXY_SOURCES, ...this.extraSources])
    this.lastSearchAt = Date.now()
    if (working.length === 0) return
    writeCache(this.cachePath, working)
  }
}

async function defaultSearch(target: string, sources: readonly string[]): Promise<string[]> {
  const candidates = await fetchCandidates(sources)
  return testProxies(target, candidates)
}

function proxyCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  return path.join(xdg ?? path.join(os.homedir(), ".cache"), "opencode", "proxies")
}

function readCache(file: string): CachedProxy[] {
  try {
    const text = readFileSyncSafe(file)
    if (!text) return []
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [timestamp, ...rest] = line.split("|")
        const url = rest.join("|")
        const ts = Number(timestamp)
        if (!Number.isFinite(ts) || !url) return undefined
        return { timestamp: ts, url }
      })
      .filter((entry): entry is CachedProxy => entry !== undefined)
  } catch {
    return []
  }
}

function writeCache(file: string, proxies: readonly string[]): void {
  const now = Date.now()
  const body = proxies.map((url) => `${now}|${url}`).join("\n")
  try {
    mkdirSyncSafe(path.dirname(file))
    writeFileSyncSafe(file, `${body}\n`)
  } catch {
    // cache is best-effort
  }
}

async function fetchCandidates(sources: readonly string[]): Promise<string[]> {
  const lines: string[] = []
  const seen = new Set<string>()

  const add = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return
    const url = toProxyUrl(trimmed)
    if (url && !seen.has(url)) {
      seen.add(url)
      lines.push(url)
    }
  }

  const results = await Promise.allSettled(sources.slice(0, 8).map((src) => fetchText(src)))
  for (const result of results) {
    if (result.status !== "fulfilled") continue
    for (const line of result.value.split("\n")) add(line)
  }

  // Cap the pool to keep validation fast.
  shuffle(lines)
  return lines.slice(0, MAX_TESTED)
}

async function testProxies(target: string, proxies: readonly string[]): Promise<string[]> {
  const working: string[] = []
  const queue = [...proxies]
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const index = cursor++
      const proxy = queue[index]
      if (proxy && (await testProxy(target, proxy))) working.push(proxy)
    }
  }

  const workers = Array.from({ length: TEST_CONCURRENCY }, () => worker())
  await Promise.all(workers)
  return working
}

async function testProxy(target: string, proxy: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    const response = await fetch(target, { proxy, signal: controller.signal, redirect: "follow" })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function toProxyUrl(value: string): string | undefined {
  if (/^https?:\/\//i.test(value)) return value
  // Accepts `ip:port` and numeric hosts only (avoids garbage lines).
  if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(value)) return `http://${value}`
  return undefined
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return ""
    return response.text()
  } finally {
    clearTimeout(timer)
  }
}

function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j]!, array[i]!]
  }
  return array
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Small fs helpers that never throw so proxy maintenance can't break requests.
function readFileSyncSafe(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
function writeFileSyncSafe(file: string, data: string): void {
  try {
    writeFileSync(file, data, "utf8")
  } catch {
    // ignore
  }
}
function mkdirSyncSafe(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
}
