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
// - Proxies are validated by proxying a request to the provider host (e.g.
//   `https://opencode.ai`) and requiring a 2xx. Bun reports a rejected HTTPS
//   CONNECT as a normal 400 response, so accepting 4xx lets fake proxies pass
//   and turns every provider call into `Bad Request`. The validated pool is
//   cached on disk, but a new process distrusts it until it has validated its
//   own pool, since a previous run's cache is mostly dead.
// - Rate limits rotate to another *working* proxy.
// - Connection failures ("Cannot connect to API: Unable to connect ...")
//   mean the current proxy is dead/unreachable, so that proxy is discarded and
//   the search restarts from scratch with a brand-new list.
// - The search is continuous: `keepFresh()` starts a background loop that keeps
//   re-discovering and re-validating a fresh pool for the whole process
//   lifetime, so a provider request almost always has a warm pool to rotate
//   through even when most public proxies have died.
// - Discovery prefers sources that report liveness (`alive`, `last_seen`,
//   `upTime`) and keeps their freshest entries at the front of the validation
//   queue, then validates concurrently with a short per-proxy timeout. A search
//   stops as soon as enough working proxies are found, so it never spends
//   minutes scanning dead lists.
// - A cached proxy is revalidated immediately before it is handed to a real
//   request, so a pool entry that died seconds after discovery is never used
//   as a live connection. Preflights run concurrently, so one dead batch costs
//   a few seconds, not one attempt timeout per proxy.
// - Proxies that completed a real provider request are remembered in a
//   per-provider `known.txt` file and validated first on the next search, so a
//   restart starts from proxies that demonstrably worked instead of the whole
//   public internet.
// - TLS handshake failures (e.g. `unable to verify the first certificate`)
//   mean the proxy is intercepting the tunnel. They rotate like any other
//   transport failure and the proxy is parked for a long time.
// - Rotation is bounded by a wall-clock budget (2 minutes by default): the
//   request keeps trying fresh proxies until one answers, the budget expires,
//   or the caller aborts. A request never retries the same proxy twice; the
//   active proxy stays sticky across requests.
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
   * across proxy switches. Unlimited by default: the request keeps hunting for
   * a working proxy until one answers or the caller aborts.
   */
  readonly maxAttempts?: number
  /**
   * Per-attempt hard timeout in milliseconds. The rotator aborts a request that
   * has not produced a response (headers) within this window and treats it as a
   * dead proxy, so a hung connection never parks the session. Defaults to 30s
   * for a direct connection and 10s for a proxy attempt. Pass `false` to rely
   * solely on the caller's own timeouts.
   */
  readonly requestTimeoutMs?: number | false
  /**
   * Wall-clock ceiling for a single request's proxy rotation. Once exceeded the
   * last response/error is surfaced to the caller instead of searching again.
   * Defaults to two minutes so a bad public pool can never park a session for
   * hours; pass `false` to hunt until the caller aborts.
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
  /** Override the per-proxy preflight check (used by tests). Returns true when
   * the proxy can carry a request to the target right now. */
  readonly validate?: (proxy: string) => Promise<boolean>
  /** How long a proxy that completed a real provider request may skip
   * preflight. Discovery cache entries are always preflighted. Defaults to
   * 45s; tests set it to 0. */
  readonly preflightTrustMs?: number
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
  /unable to verify the first certificate/i,
  /unable to get local issuer certificate/i,
  /certificate[_ ]verify[_ ]failed/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
  /altname/i,
  /err_tls/i,
  /tls handshake/i,
  /ssl routines/i,
]

// TLS failures usually mean the proxy is intercepting HTTPS (MITM) instead of
// tunnelling it. Even if the proxy later answers, its certificate chain cannot
// be trusted, so keep it parked for a long time.
const TLS_ERROR_PATTERNS = [
  /unable to verify the first certificate/i,
  /unable to get local issuer certificate/i,
  /certificate[_ ]verify[_ ]failed/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
  /altname/i,
  /err_tls/i,
  /tls handshake/i,
  /ssl routines/i,
]

// A proxy source is a URL plus an optional parser. Without a parser the body is
// treated as one candidate (`host:port` or URL) per line. `max` overrides the
// per-source sample size; `max` of a huge list keeps the search cheap.
// `ordered` sources are already sorted from freshest/best to oldest, so their
// first entries are validated before any shuffled entry.
interface ProxySource {
  readonly url: string
  readonly parse?: (body: string) => string[]
  readonly max?: number
  readonly ordered?: boolean
}

// Curated free HTTP proxy providers. GitHub raw lists plus public APIs that
// expose plain-text or JSON endpoints; all are free and require no key. One
// large list cannot crowd out the others (see MAX_PER_SOURCE). APIs that sort
// by `lastChecked`/uptime are preferred because they hand back proxies that
// were alive minutes ago instead of ancient dead entries.
const PROXY_SOURCES: readonly ProxySource[] = [
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt" },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt" },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt", max: 160 },
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
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt" },
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
  // ProxyScrape's JSON endpoint reports `alive`, `last_seen`, `uptime` and
  // `ssl`. Keeping only live CONNECT-capable proxies removes most of the dead
  // entries a plain `ip:port` list still carries.
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=json&timeout=5000&ssl=yes",
    parse: parseProxyScrape,
    ordered: true,
    max: 300,
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=json&timeout=5000",
    parse: parseProxyScrape,
    ordered: true,
    max: 300,
  },
  // Geonode sorts by last check / uptime and exposes uptime and latency. Sort
  // by uptime so proxies that kept answering recently are validated first.
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=upTime&sort_type=desc&protocols=http",
    parse: parseGeonode,
    ordered: true,
    max: 240,
  },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=2&sort_by=upTime&sort_type=desc&protocols=http",
    parse: parseGeonode,
    ordered: true,
    max: 240,
  },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=3&sort_by=upTime&sort_type=desc&protocols=http",
    parse: parseGeonode,
    ordered: true,
    max: 240,
  },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=4&sort_by=upTime&sort_type=desc&protocols=http",
    parse: parseGeonode,
    ordered: true,
    max: 240,
  },
]

// Unlimited attempts, but always bounded by a wall clock. A session must never
// sit for hours on a dead public pool: two minutes is enough to preflight a
// batch, try a few live proxies and surface a real error to the user.
const DEFAULT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const PROXY_ATTEMPT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ROTATION_MS = 2 * 60_000
// Dead connections are blacklisted for a while so later requests never start
// by retrying the same corpse. Rate-limited IPs are parked a bit shorter.
const CONNECTION_BLOCK_MS = 10 * 60_000
const RATE_LIMIT_BLOCK_MS = 5 * 60_000
// Certificate-injecting proxies cannot be fixed by retrying, so park them for
// a long time and never spend another validation slot on them.
const TLS_BLOCK_MS = 6 * 60 * 60_000
const VALIDATION_TIMEOUT_MS = 3_000
const SEARCH_DEADLINE_MS = 25_000
// Stop searching once this many proxies passed validation. A larger pool is
// important because free proxies die constantly and many are already burned.
const SEARCH_TARGET = 32
// A cached proxy is trusted for at most five minutes. Entries are still
// preflighted right before use; this TTL only controls how long discovery
// results are kept before a full rescan.
const CACHE_TTL_MS = 5 * 60_000
// Only proxies that already carried a real provider request may skip
// preflight, and only for this long. Bulk discovery cache entries are never
// trusted without a fresh check — public lists are mostly corpses.
const PREFLIGHT_TRUST_MS = 45_000
// Validate this many cached candidates concurrently before giving up on a pool.
const PREFLIGHT_BATCH = 12
// Do not start a full internet rescan when less than this remains on the
// request rotation budget (a rescan needs SEARCH_DEADLINE_MS).
const RESCAN_MIN_REMAINING_MS = 20_000
// Proxies that completed a real provider request are kept for this long and
// validated first on every new search.
const HISTORY_TTL_MS = 6 * 60 * 60_000
const HISTORY_MAX = 200
// Refresh the pool once the newest cached proxy is older than this.
const REFRESH_AGE_MS = 60_000
const DEFAULT_REFRESH_INTERVAL_MS = 40_000
// Don't re-run an expensive proxy search more often than this.
const SEARCH_MIN_INTERVAL_MS = 4_000
const MAX_TESTED = 6_000
// Cap each source so a single huge list can't crowd out the rest of the pool.
const MAX_PER_SOURCE = 200
const TEST_CONCURRENCY = 200

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
  private readonly historyPath: string
  private readonly extraSources: readonly string[]
  private readonly refreshIntervalMs: number | false
  private readonly searchOverride?: () => Promise<string[]>
  private readonly validateOverride?: (proxy: string) => Promise<boolean>
  private readonly preflightTrustMs: number

  private activeProxy: string | undefined
  private lastSearchAt = 0
  private searching?: Promise<void>
  private refreshTimer?: ReturnType<typeof setInterval>
  // Cache entries written before this process started were validated by a
  // previous run and are usually dead. Never serve them until this process has
  // validated its own pool.
  private readonly startedAt = Date.now()
  // Proxies that recently failed are parked so later requests do not start
  // their rotation with the same dead/burned connections.
  private readonly blockedUntil = new Map<string, number>()
  // Avoid rewriting the cache/history files on every successful request.
  private readonly confirmedAt = new Map<string, number>()

  constructor(options: ProxyRotatorOptions) {
    this.target = options.target.replace(/\/$/, "")
    this.id = options.id
    this.onStatus = options.onStatus
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxRotationMs = options.maxRotationMs ?? DEFAULT_MAX_ROTATION_MS
    const cacheDir = options.cacheDir ?? proxyCacheDir()
    this.cachePath = path.join(cacheDir, "working.txt")
    this.historyPath = path.join(cacheDir, "known.txt")
    this.extraSources = options.extraSources ?? []
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    this.searchOverride = options.search
    this.validateOverride = options.validate
    this.preflightTrustMs = options.preflightTrustMs ?? PREFLIGHT_TRUST_MS
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
    // Rebuild the pool immediately. A cache from a previous run can be full of
    // proxies that were alive minutes ago and are dead now, so the first
    // request must not trust it.
    void this.search(true)
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

  /** True when the tunnel failed TLS verification (usually a MITM proxy). */
  static isTlsFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return TLS_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  }

  /**
   * Execute `send(proxy)` and rotate across proxies until it succeeds, the
   * attempt budget or wall-clock budget is exhausted, or the caller aborts.
   * `send` is the actual provider request given the current proxy (or
   * `undefined` for a direct connection); it returns the HTTP status and throws
   * when the transport fails before a response is available.
   *
   * Each request tracks the proxies it already tried. The active proxy remains
   * sticky across requests, but one request never retries the same proxy. By
   * default there is no attempt or wall-clock limit: it keeps hunting until a
   * proxy answers or the caller aborts.
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
    if (proxy && this.isBlocked(proxy)) {
      this.activeProxy = undefined
      proxy = undefined
    }
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
        this.discard(proxy, used, ProxyRotator.isTlsFailure(error))
        if (attempt >= this.maxAttempts) throw error
        proxy = await this.nextProxy(used, messageOf(error), deadline)
        if (!proxy) await waitForPool(deadline, signal)
        continue
      }
      clearTimeout(timer)
      // A successful response is returned untouched. Statuses that a different
      // egress IP cannot fix (auth errors, bad requests) surface immediately.
      if (!ProxyRotator.shouldRotate(result.status)) {
        // The proxy demonstrably carried a real request to the provider, so
        // remember it as a known-good candidate for the next search.
        if (proxy) this.confirm(proxy)
        return result
      }
      lastResult = result
      if (attempt >= this.maxAttempts) return result
      // Never retry through the same (or no) connection: mark it used, park it
      // for a while (its IP is burned), rotate to a fresh proxy, and if the
      // pool is empty keep rescanning within the attempt/time budget.
      if (proxy) this.burn(proxy, used)
      proxy = await this.nextProxy(used, "rate limited", deadline)
      if (!proxy) await waitForPool(deadline, signal)
    }
  }

  /**
   * Pick the next proxy that this request has not tried yet, after proving it
   * still works. Every candidate is either trusted because it was validated
   * seconds ago or preflighted against the target right now, so a corpse left
   * in the cache is discarded before the provider request spends its attempt
   * timeout on it. When the whole pool fails, rescan once and preflight the
   * fresh batch.
   */
  private async nextProxy(
    used: Set<string>,
    reason = "no proxy available",
    deadline = Infinity,
  ): Promise<string | undefined> {
    let rescanned = false
    for (;;) {
      const pool = this.readPool()
      const live = await this.preflight(
        pool.filter((entry) => !used.has(entry.url)),
        deadline,
      )
      const candidate = live[0]
      if (candidate) {
        used.add(candidate)
        this.activeProxy = candidate
        this.onStatus?.({ kind: "switch", proxy: candidate })
        return candidate
      }

      // Never reuse a dead/rate limited proxy. Rescan the internet for a fresh
      // batch, validate it against the target, then preflight again. If that
      // also yields nothing (or the search was throttled), let the caller wait
      // or give up instead of spinning.
      if (rescanned || deadline - Date.now() < RESCAN_MIN_REMAINING_MS) return undefined
      rescanned = true
      this.onStatus?.({ kind: "rescan", reason })
      await this.search()
    }
  }

  /**
   * Return proxies that answer right now. Only proxies that recently completed
   * a real provider request skip the check; discovery cache entries are always
   * preflighted concurrently in batches until at least one passes or the pool
   * is exhausted.
   */
  private async preflight(entries: readonly CachedProxy[], deadline: number): Promise<string[]> {
    const now = Date.now()
    const trusted = entries
      .filter((entry) => this.preflightTrusted(entry.url, now))
      .map((entry) => entry.url)
    if (trusted.length > 0) return trusted

    const check = entries.filter((entry) => !this.preflightTrusted(entry.url, now))
    const live: string[] = []
    for (let offset = 0; offset < check.length; offset += PREFLIGHT_BATCH) {
      const remaining = deadline - Date.now()
      if (remaining < 50) break
      const batch = check.slice(offset, offset + PREFLIGHT_BATCH)
      const results = await Promise.all(
        batch.map(async (entry) => {
          const left = deadline - Date.now()
          if (left < 50) return undefined
          const timeout = Math.min(VALIDATION_TIMEOUT_MS, Math.max(1, left))
          const ok = this.validateOverride
            ? await this.validateOverride(entry.url)
            : await testProxy(this.target, entry.url, undefined, timeout)
          if (ok) return entry.url
          this.block(entry.url, CONNECTION_BLOCK_MS)
          this.removeFromCache(entry.url)
          return undefined
        }),
      )
      for (const url of results) {
        if (url) live.push(url)
      }
      if (live.length > 0) return live
    }
    return live
  }

  /** Skip preflight only for proxies that recently completed a real request. */
  private preflightTrusted(url: string, now: number): boolean {
    if (this.preflightTrustMs === 0) return false
    const confirmed = this.confirmedAt.get(url)
    if (confirmed === undefined) return false
    return now - confirmed < this.preflightTrustMs
  }

  /** Remember a proxy that completed a real provider request. */
  private confirm(proxy: string): void {
    const now = Date.now()
    const last = this.confirmedAt.get(proxy)
    if (last !== undefined && now - last < 60_000) return
    this.confirmedAt.set(proxy, now)

    const cached = readCache(this.cachePath)
    const updated = cached.some((entry) => entry.url === proxy)
      ? cached.map((entry) => (entry.url === proxy ? { timestamp: now, url: proxy } : entry))
      : [...cached, { timestamp: now, url: proxy }]
    writeCacheEntries(this.cachePath, updated)

    const history = readCache(this.historyPath)
      .filter((entry) => entry.url !== proxy && now - entry.timestamp < HISTORY_TTL_MS)
      .slice(0, HISTORY_MAX - 1)
    writeCacheEntries(this.historyPath, [{ timestamp: now, url: proxy }, ...history])
  }

  private discard(proxy: string | undefined, used: Set<string>, tls = false): void {
    if (!proxy) return
    used.add(proxy)
    this.block(proxy, tls ? TLS_BLOCK_MS : CONNECTION_BLOCK_MS)
    this.removeFromCache(proxy)
    if (this.activeProxy === proxy) this.activeProxy = undefined
    this.onStatus?.({
      kind: "discard",
      proxy,
      reason: tls ? "proxy intercepted TLS (certificate not trusted)" : "could not connect through this proxy",
    })
  }

  private burn(proxy: string, used: Set<string>): void {
    used.add(proxy)
    this.block(proxy, RATE_LIMIT_BLOCK_MS)
    this.removeFromCache(proxy)
    if (this.activeProxy === proxy) this.activeProxy = undefined
  }

  private block(proxy: string, ms: number): void {
    this.blockedUntil.set(proxy, Date.now() + ms)
  }

  private isBlocked(proxy: string): boolean {
    const until = this.blockedUntil.get(proxy)
    if (until === undefined) return false
    if (Date.now() < until) return true
    this.blockedUntil.delete(proxy)
    return false
  }

  /** Drop a failed proxy from the on-disk pool so a new session cannot reuse it. */
  private removeFromCache(proxy: string): void {
    const cached = readCache(this.cachePath)
    const remaining = cached.filter((entry) => entry.url !== proxy)
    if (remaining.length !== cached.length) writeCacheEntries(this.cachePath, remaining)
  }

  /** Validated proxies from this process, still inside the cache TTL. */
  private readPool(): CachedProxy[] {
    return readCache(this.cachePath)
      .filter((entry) => entry.timestamp >= this.startedAt && Date.now() - entry.timestamp < CACHE_TTL_MS)
      .filter((entry) => !this.isBlocked(entry.url))
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
      : defaultSearch(this.target, sources, this.knownProxies())
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

  /** Proxies that completed a real request recently, best first. */
  private knownProxies(): string[] {
    const now = Date.now()
    return readCache(this.historyPath)
      .filter((entry) => now - entry.timestamp < HISTORY_TTL_MS)
      .filter((entry) => !this.isBlocked(entry.url))
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((entry) => entry.url)
  }

  /** Re-validate the pool when the cache has gone stale. */
  private async refresh(): Promise<void> {
    const cached = readCache(this.cachePath)
    if (cached.some((entry) => Date.now() - entry.timestamp < REFRESH_AGE_MS)) return
    await this.search(true)
  }
}

async function defaultSearch(
  target: string,
  sources: readonly ProxySource[],
  known: readonly string[] = [],
): Promise<string[]> {
  const candidates = await fetchCandidates(sources)
  // Known-good proxies from previous runs are validated first, so a new
  // process starts from connections that already carried real requests.
  const seen = new Set(known)
  return testProxies(target, [...known, ...candidates.filter((url) => !seen.has(url))])
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
  writeCacheEntries(
    file,
    proxies.map((url) => ({ timestamp: now, url })),
  )
}

function writeCacheEntries(file: string, entries: readonly CachedProxy[]): void {
  const body = entries.map((entry) => `${entry.timestamp}|${entry.url}`).join("\n")
  try {
    mkdirSyncSafe(path.dirname(file))
    writeFileSyncSafe(file, body ? `${body}\n` : "")
  } catch {
    // cache is best-effort
  }
}

async function fetchCandidates(sources: readonly ProxySource[]): Promise<string[]> {
  const ordered: string[] = []
  const rest: string[] = []
  const seen = new Set<string>()

  const add = (target: string[], line: string): void => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return
    const url = toProxyUrl(trimmed)
    if (url && !seen.has(url)) {
      seen.add(url)
      target.push(url)
    }
  }

  const results = await Promise.allSettled(sources.map((source) => fetchSource(source)))
  for (const [index, result] of results.entries()) {
    if (result.status !== "fulfilled") continue
    const source = sources[index]
    const max = source?.max ?? MAX_PER_SOURCE
    // Sources that already report liveness (`alive`, `last_seen`, `upTime`) are
    // kept in their own order so the freshest entries get validated first.
    // Plain lists are shuffled to sample different entries across searches.
    if (source?.ordered) {
      for (const line of result.value.slice(0, max)) add(ordered, line)
      continue
    }
    for (const line of shuffle(result.value).slice(0, max)) add(rest, line)
  }

  // Validate the freshest known proxies first, then fill the remaining budget
  // with the shuffled long tail.
  return [...ordered, ...shuffle(rest)].slice(0, MAX_TESTED)
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
  return data
    .flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return []
      const { ip, port, upTime } = entry as { ip?: unknown; port?: unknown; upTime?: unknown }
      if (typeof upTime === "number" && upTime < 20) return []
      return typeof ip === "string" && (typeof port === "string" || typeof port === "number")
        ? [{ url: `${ip}:${port}`, upTime: typeof upTime === "number" ? upTime : 0 }]
        : []
    })
    .sort((a, b) => b.upTime - a.upTime)
    .map((entry) => entry.url)
}

function parseProxyScrape(body: string): string[] {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== "object" || parsed === null || !("proxies" in parsed)) return []
  const proxies = (parsed as { proxies?: unknown }).proxies
  if (!Array.isArray(proxies)) return []
  return proxies
    .flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return []
      const { ip, port, alive, last_seen, uptime } = entry as {
        ip?: unknown
        port?: unknown
        alive?: unknown
        last_seen?: unknown
        uptime?: unknown
      }
      // `alive` is the provider's own online flag. Reject proxies it already
      // knows are down instead of spending a validation slot on them.
      if (alive === false) return []
      if (typeof ip !== "string" || (typeof port !== "string" && typeof port !== "number")) return []
      return [
        {
          url: `${ip}:${port}`,
          lastSeen: typeof last_seen === "number" ? last_seen : 0,
          uptime: typeof uptime === "number" ? uptime : 0,
        },
      ]
    })
    // Freshest-reported and most reliable proxies first.
    .sort((a, b) => b.lastSeen - a.lastSeen || b.uptime - a.uptime)
    .map((entry) => entry.url)
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

async function testProxy(
  target: string,
  proxy: string,
  signal?: AbortSignal,
  timeoutMs = VALIDATION_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  try {
    const response = await fetch(target, {
      proxy,
      signal: combined,
      redirect: "follow",
      headers: { accept: "*/*" },
    })
    // Require a 2xx from the provider itself. Bun surfaces a proxy that rejects
    // the HTTPS CONNECT as a regular 400 response, so accepting any status made
    // fake "proxies" (Cloudflare edge IPs, open ports) pass validation and every
    // provider request then failed with `Bad Request`. A real tunnel to the
    // provider origin answers 2xx; a broken one never does. Reject redirects
    // that land off-origin (common captive-portal / junk-proxy behaviour).
    if (!response.ok) return false
    try {
      return new URL(response.url).origin === new URL(target).origin
    } catch {
      return false
    }
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
