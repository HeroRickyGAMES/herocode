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
// - The search is continuous: `keepFresh()` starts a background loop that keeps
//   re-discovering and re-validating a fresh pool for the whole process
//   lifetime, so a provider request almost always has a warm pool to rotate
//   through even when most public proxies have died.
// - Discovery prefers proxy lists that are already curated/sorted by "last
//   checked" (Geonode, ProxyScrape) and validates concurrently with a short
//   per-proxy timeout. A search stops as soon as enough working proxies are
//   found, so it never spends minutes scanning dead lists.
// - Rotation is bounded per request by both `maxAttempts` and a wall-clock
//   `maxRotationMs` budget. A request may try each proxy in the pool at most
//   once; the active proxy stays sticky across requests.
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
  /**
   * Optional ceiling on how many times a single provider request may be retried
   * across proxy switches. Defaults to a finite budget so a request can never
   * rotate forever when every proxy is dead or the upstream keeps failing.
   */
  readonly maxAttempts?: number
  /**
   * Per-attempt hard timeout in milliseconds. The rotator aborts a request that
   * has not produced a response (headers) within this window and treats it as a
   * dead proxy, so a hung connection never parks the session. Defaults to 45s
   * for a direct connection and 20s for a proxy attempt. Pass `false` to rely
   * solely on the caller's own timeouts.
   */
  readonly requestTimeoutMs?: number | false
  /**
   * Wall-clock ceiling for a single request's proxy rotation. Once exceeded the
   * last response/error is surfaced to the caller instead of searching again.
   * Defaults to 90s. Pass `false` for no wall-clock limit (attempt budget still
   * applies).
   */
  readonly maxRotationMs?: number | false
  /** Override the cache directory (defaults to `~/.cache/opencode/proxies`). */
  readonly cacheDir?: string
  /** Extra proxy list URLs to fetch on top of the built-in sources. */
  readonly extraSources?: readonly string[]
  /**
   * Interval between background pool refreshes started by `keepFresh()`.
   * Defaults to four minutes. Pass `false` to disable refreshing.
   */
  readonly refreshIntervalMs?: number | false
  /** Override proxy discovery+validation (used by tests; defaults to the
   * public proxy lists). Must return validated, currently-working proxies. */
  readonly search?: () => Promise<string[]>
}

const RATE_LIMIT_STATUSES = new Set([429, 529])

// Statuses a different egress IP can plausibly fix. Client errors such as 400,
// 401 and 404 come from the provider and rotate forever without ever
// succeeding, so they are surfaced to the caller instead of retried.
const ROTATE_STATUSES = new Set([407, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529])

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

// A proxy source is a URL plus an optional parser. Without a parser the body is
// treated as one candidate (`host:port` or URL) per line. `max` overrides the
// per-source sample size; `max` of a huge list keeps the search cheap.
interface ProxySource {
  readonly url: string
  readonly parse?: (body: string) => string[]
  readonly max?: number
}

// Curated free HTTP proxy providers. GitHub raw lists plus public APIs that
// expose plain-text or JSON endpoints; all are free and require no key. One
// large list cannot crowd out the others (see MAX_PER_SOURCE). APIs that sort
// by `lastChecked`/uptime are preferred because they hand back proxies that
// were alive minutes ago instead of ancient dead entries.
const PROXY_SOURCES: readonly ProxySource[] = [
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt" },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt" },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text",
  },
  {
    url: "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
  },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt" },
  { url: "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt" },
  { url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt" },
  { url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt" },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt" },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt" },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt" },
  { url: "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt" },
  { url: "https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt" },
  { url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt" },
  { url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt" },
  { url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt" },
  { url: "https://openproxylist.xyz/http.txt" },
  { url: "https://raw.githubusercontent.com/proxylist-to/proxy-list/main/http.txt" },
  { url: "https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/HTTP.txt" },
  { url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt" },
  { url: "https://raw.githubusercontent.com/saisuiu/uiu/main/free.txt" },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt", max: 120 },
  { url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt", max: 120 },
  { url: "https://spys.me/proxy.txt", parse: parseSpys },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http",
    parse: parseGeonode,
    max: 160,
  },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=2&sort_by=lastChecked&sort_type=desc&protocols=http",
    parse: parseGeonode,
    max: 160,
  },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=3&sort_by=lastChecked&sort_type=desc&protocols=http",
    parse: parseGeonode,
    max: 160,
  },
]

// Finite by default: every proxy in a fresh pool gets one chance, then the
// request fails so the session can surface the upstream error instead of
// looping in proxy searches forever.
const DEFAULT_MAX_ATTEMPTS = 12
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000
const PROXY_ATTEMPT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_ROTATION_MS = 90_000
const VALIDATION_TIMEOUT_MS = 3_000
const SEARCH_DEADLINE_MS = 18_000
// Stop searching once this many proxies passed validation. A handful is enough
// to rotate through while the background refresh replenishes the pool.
const SEARCH_TARGET = 12
const CACHE_TTL_MS = 2 * 60_000
// Refresh the pool once the newest cached proxy is older than this.
const REFRESH_AGE_MS = 45_000
const DEFAULT_REFRESH_INTERVAL_MS = 60_000
// Don't re-run an expensive proxy search more often than this.
const SEARCH_MIN_INTERVAL_MS = 5_000
const MAX_TESTED = 5_000
// Cap each source so a single huge list can't crowd out the rest of the pool.
const MAX_PER_SOURCE = 100
const TEST_CONCURRENCY = 120

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
  private readonly maxRotationMs: number | false
  private readonly cachePath: string
  private readonly extraSources: readonly string[]
  private readonly refreshIntervalMs: number | false
  private readonly searchOverride?: () => Promise<string[]>

  private activeProxy: string | undefined
  private lastSearchAt = 0
  private searching?: Promise<void>
  private refreshTimer?: ReturnType<typeof setInterval>

  constructor(options: ProxyRotatorOptions) {
    this.target = options.target.replace(/\/$/, "")
    this.id = options.id
    this.onStatus = options.onStatus
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxRotationMs = options.maxRotationMs ?? DEFAULT_MAX_ROTATION_MS
    this.cachePath = path.join(options.cacheDir ?? proxyCacheDir(), "working.txt")
    this.extraSources = options.extraSources ?? []
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
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

  /**
   * Keep the validated pool fresh for the whole process lifetime by periodically
   * re-discovering and re-validating proxies in the background. Idempotent, and
   * the timer is unref'd so it never keeps the process alive on its own.
   */
  keepFresh(): void {
    if (this.refreshTimer || this.refreshIntervalMs === false) return
    // Warm the pool immediately so the first request does not have to wait for
    // a full discovery pass.
    void this.refresh().catch(() => {})
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, this.refreshIntervalMs)
    this.refreshTimer.unref?.()
  }

  /** Stop the background refresh loop. */
  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
  }

  /** True when a response is a rate limit that a fresh IP can dodge. */
  static isRateLimit(status: number): boolean {
    return RATE_LIMIT_STATUSES.has(status)
  }

  /**
   * True when a response status means the proxy should be rotated. Only
   * statuses a fresh egress IP can fix qualify: proxy auth/timeout, rate
   * limits, upstream 5xx and Cloudflare edge errors. Provider-side client
   * errors (400, 401, 403, 404) are returned to the caller immediately.
   */
  static shouldRotate(status: number): boolean {
    return ROTATE_STATUSES.has(status)
  }

  /** True when a thrown error means the proxy cannot reach the target at all. */
  static isConnectionFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  }

  /**
   * Execute `send(proxy)` and rotate across proxies until it succeeds, the
   * attempt budget or wall-clock budget is exhausted, or the caller aborts.
   * `send` is the actual provider request given the current proxy (or
   * `undefined` for a direct connection); it returns the HTTP status and throws
   * when the transport fails before a response is available.
   *
   * Each request tracks the proxies it already tried. The active proxy remains
   * sticky across requests, but one request never retries the same proxy and a
   * single request can never spend more than `maxRotationMs` waiting for a
   * replacement, so a resumed session cannot park for hours.
   */
  async withRetry(
    send: (proxy: string | undefined, signal?: AbortSignal) => Promise<{ status: number; response: Response }>,
    signal?: AbortSignal,
  ): Promise<{
    status: number
    response: Response
  }> {
    const deadline = this.maxRotationMs === false ? Infinity : Date.now() + this.maxRotationMs
    const used = new Set<string>()
    let proxy = this.activeProxy
    let lastResult: { status: number; response: Response } | undefined
    let lastError: unknown

    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw abortError(signal)
      if (attempt > 1 && Date.now() >= deadline) {
        if (lastResult) return lastResult
        throw lastError
      }

      const remaining = deadline - Date.now()
      const baseTimeout =
        this.requestTimeoutMs === false
          ? false
          : proxy
            ? Math.min(this.requestTimeoutMs, PROXY_ATTEMPT_TIMEOUT_MS)
            : this.requestTimeoutMs
      const timeout = baseTimeout === false ? false : Math.max(1, Math.min(baseTimeout, remaining))
      const controller = timeout !== false && timeout > 0 ? new AbortController() : undefined
      const timer = controller && timeout !== false ? setTimeout(() => controller.abort(), timeout) : undefined
      let result
      try {
        result = await send(proxy, controller?.signal)
      } catch (error) {
        clearTimeout(timer)
        // A caller cancellation is not a proxy problem: stop immediately.
        if (signal?.aborted) throw abortError(signal)
        // A failure to even connect (or a timeout before any response) means
        // this proxy (or a direct connection) is unusable — discard it and
        // restart the search from scratch.
        if (!ProxyRotator.isConnectionFailure(error)) throw error
        lastError = error
        this.discard(proxy, used)
        if (attempt >= this.maxAttempts) throw error
        proxy = await this.nextProxy(used, messageOf(error), deadline)
        if (!proxy) await waitForPool(deadline, signal)
        continue
      }
      clearTimeout(timer)
      // A successful response is returned untouched. Statuses that a different
      // egress IP cannot fix (auth errors, bad requests) surface immediately.
      if (!ProxyRotator.shouldRotate(result.status)) return result
      lastResult = result
      if (attempt >= this.maxAttempts) return result
      // Never retry through the same (or no) connection: mark it used, rotate
      // to a fresh proxy, and if the pool is empty keep rescanning within the
      // attempt/time budget.
      if (proxy) used.add(proxy)
      proxy = await this.nextProxy(used, "rate limited", deadline)
      if (!proxy) await waitForPool(deadline, signal)
    }
  }

  /**
   * Pick the next proxy from the working pool that this request has not tried
   * yet. When the pool is exhausted, force a fresh list + validation pass. If
   * the rescan only returns already-tried proxies, return `undefined` so the
   * caller waits or gives up instead of hammering the same connection.
   */
  private async nextProxy(
    used: Set<string>,
    reason = "no proxy available",
    deadline = Infinity,
  ): Promise<string | undefined> {
    const pool = await this.workingPool(deadline)
    const candidate = pool.find((url) => !used.has(url))
    if (candidate) {
      used.add(candidate)
      this.activeProxy = candidate
      this.onStatus?.({ kind: "switch", proxy: candidate })
      return candidate
    }

    // Every proxy in the cached pool has already been tried (typically each one
    // returned 429/5xx). Never reuse a dead/rate limited proxy: rescan the
    // internet for a fresh batch and validate it against the target.
    if (Date.now() >= deadline - 1_000) return undefined
    this.onStatus?.({ kind: "rescan", reason })
    await this.search()
    const fresh = await this.workingPool(deadline)
    const next = fresh.find((url) => !used.has(url))
    if (!next) return undefined
    used.add(next)
    this.activeProxy = next
    this.onStatus?.({ kind: "switch", proxy: next })
    return next
  }

  private discard(proxy: string | undefined, used: Set<string>): void {
    if (!proxy) return
    used.add(proxy)
    if (this.activeProxy === proxy) this.activeProxy = undefined
    this.onStatus?.({ kind: "discard", proxy, reason: "could not connect through this proxy" })
  }

  /** Return a validated pool of proxies, reusing the on-disk cache when fresh. */
  private async workingPool(deadline = Infinity): Promise<readonly string[]> {
    const cached = readCache(this.cachePath)
    if (cached.length > 0) {
      const fresh = cached.filter((entry) => Date.now() - entry.timestamp < CACHE_TTL_MS).map((entry) => entry.url)
      if (fresh.length > 0) return fresh
    }
    // Don't hammer the proxy lists when the last search came up empty, and
    // don't start a slow search when this request is nearly out of time.
    if (Date.now() >= deadline - 1_000) return []
    if (Date.now() - this.lastSearchAt < SEARCH_MIN_INTERVAL_MS) return []
    await this.search()
    return readCache(this.cachePath)
      .filter((entry) => Date.now() - entry.timestamp < CACHE_TTL_MS)
      .map((entry) => entry.url)
  }

  /**
   * Fetch fresh proxy lists and validate them against the target. Concurrent
   * callers share one in-flight search so the background refresh and a
   * request-driven rescan never scan the internet twice at once. The
   * min-interval throttle guards request-driven searches; the background
   * refresh loop forces its own searches because it is already rate limited.
   */
  private async search(force = false): Promise<void> {
    if (this.searching) return this.searching
    if (!force && Date.now() - this.lastSearchAt < SEARCH_MIN_INTERVAL_MS) return
    this.lastSearchAt = Date.now()
    const sources: ProxySource[] = [...PROXY_SOURCES, ...this.extraSources.map((url) => ({ url }))]
    this.searching = (this.searchOverride
      ? this.searchOverride()
      : defaultSearch(this.target, sources)
    )
      .then((working) => {
        if (working.length > 0) writeCache(this.cachePath, working)
      })
      .catch(() => {
        // Discovery is best-effort; never let a source/parse failure abort a
        // provider request.
      })
      .finally(() => {
        this.searching = undefined
      })
    return this.searching
  }

  /** Re-validate the pool when the cache has gone stale. */
  private async refresh(): Promise<void> {
    const cached = readCache(this.cachePath)
    if (cached.some((entry) => Date.now() - entry.timestamp < REFRESH_AGE_MS)) return
    await this.search(true)
  }
}

async function defaultSearch(target: string, sources: readonly ProxySource[]): Promise<string[]> {
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

async function fetchCandidates(sources: readonly ProxySource[]): Promise<string[]> {
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

  const results = await Promise.allSettled(sources.map((source) => fetchSource(source)))
  for (const [index, result] of results.entries()) {
    if (result.status !== "fulfilled") continue
    // Cap and shuffle each source independently so an enormous list can't
    // dominate, and so repeated searches sample different proxies.
    for (const line of shuffle(result.value).slice(0, sources[index]?.max ?? MAX_PER_SOURCE)) add(line)
  }

  // Cap the pool to keep validation fast.
  shuffle(lines)
  return lines.slice(0, MAX_TESTED)
}

async function fetchSource(source: ProxySource): Promise<string[]> {
  const body = await fetchText(source.url)
  if (!body) return []
  return source.parse ? source.parse(body) : body.split("\n")
}

function parseSpys(body: string): string[] {
  // `ip:port CC-Anonymity-SSL` — take the leading `ip:port` token and skip the
  // header/footer lines that don't start with a digit.
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d/.test(line))
    .map((line) => line.split(/\s+/)[0] ?? "")
}

function parseGeonode(body: string): string[] {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) return []
  const data = (parsed as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return []
    const { ip, port, upTime } = entry as { ip?: unknown; port?: unknown; upTime?: unknown }
    if (typeof upTime === "number" && upTime < 20) return []
    return typeof ip === "string" && (typeof port === "string" || typeof port === "number") ? [`${ip}:${port}`] : []
  })
}

async function testProxies(target: string, proxies: readonly string[]): Promise<string[]> {
  const working: string[] = []
  const queue = [...proxies]
  const deadline = Date.now() + SEARCH_DEADLINE_MS
  const controller = new AbortController()
  let cursor = 0
  let done = false

  const worker = async (): Promise<void> => {
    while (!done && cursor < queue.length) {
      if (Date.now() >= deadline) return
      const proxy = queue[cursor++]
      if (proxy && (await testProxy(target, proxy, controller.signal))) {
        working.push(proxy)
        if (working.length >= SEARCH_TARGET) {
          done = true
          controller.abort()
        }
      }
    }
  }

  await Promise.all(Array.from({ length: TEST_CONCURRENCY }, () => worker()))
  controller.abort()
  return working
}

async function testProxy(target: string, proxy: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  try {
    const response = await fetch(target, { proxy, signal: combined, redirect: "follow" })
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
  const timer = setTimeout(() => controller.abort(), 5_000)
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

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

/** Wait out the search throttle without ever sleeping past the request deadline. */
async function waitForPool(deadline: number, signal?: AbortSignal): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return
  await sleep(Math.min(SEARCH_MIN_INTERVAL_MS, remaining), signal)
}

/** Abortable delay so a request waiting for a fresh pool still honors cancel. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
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
