export * as ProxyRotator from "./proxy-rotator.js"

import { chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import * as SocksBridge from "./socks-bridge.js"

// Free proxies are short-lived. The pool is validated against a small HTTPS
// endpoint before use, and a proxy stays sticky until it fails or rate limits.

type FetchInput = string | URL | Request
type FetchInit = BunFetchRequestInit
type FetchResponse = Response

interface Entry {
  proxy: string
  checkedAt: number
  /** Host of the list that offered this proxy, kept so burned exits can be traced. */
  source?: string
}

const POOL_TARGET = 256
const POOL_CACHE_LIMIT = 4096
// Cached exits go "stale" after this and used to vanish from pickable → cold
// boots did only `direct=429` while 40 HTTP rows sat in proxy-pool.json.
const POOL_FRESH_MS = 6 * 60 * 60_000
// Free lists churn every few minutes; 4 min left the bag recycling burned IPs.
const REFRESH_MS = 2 * 60_000
const VALIDATE_TIMEOUT_MS = 6_000
// Validation shares the network with the request that triggered it, so a wide
// fan-out starves the real attempt and turns a fast quota error into a timeout.
const VALIDATE_CONCURRENCY = 24
const MAX_CANDIDATES = 2500
// Public lists grow to megabytes. Reading a prefix keeps discovery usable on a
// slow link, and the candidate cache stops a refresh from downloading them again.
const SOURCE_MAX_BYTES = 512 * 1024
// xyzs/ProxyScrape republish ~1–5 min. A 30 min dump reused the same burned /24s.
const CANDIDATE_CACHE_MS = 8 * 60_000
const CANDIDATE_CACHE_LIMIT = 20_000
const ATTEMPT_TIMEOUT_MS = 5_000
// Headers can succeed while the upstream resets before the first SSE byte. Wait
// for that byte inside the hunt so ECONNRESET rotates silently instead of
// painting "Retry due · ECONNRESET" on the chat.
// Covers the first SSE event (`\\n\\n`), not just one byte — flaky free exits
// reset between headers and the first event, and that must stay inside the hunt.
const FIRST_BYTE_TIMEOUT_MS = 8_000
// Public exits mostly die between discovery and use, so a serial hunt spends the
// whole budget dialing addresses that never opened a tunnel. Probe a batch in
// parallel with a cheap request and only pay a real attempt for survivors.
const PROBE_CONCURRENCY = 16
const PROBE_TIMEOUT_MS = 4_000
// After probes, race several POSTs at once — serial 429s burned the 90s budget
// on ~7 tries while dozens of pickable exits sat unused.
const POST_RACE = 12
// After a free-tier 429 wall, header waits are wasted on soft probe-timeouts.
const QUOTA_RACE_TIMEOUT_MS = 2_500
const EXHAUST_DETAIL_MAX = 8
// Free SOCKS lists burned every hunt (hookzof/xyzs socks → ECONNRESET wall) and
// also filled pickMany so the HTTP bag never ran. Off unless OPENCODE_PROXY_SOCKS=1.
const POST_RACE_SOCKS = 0
const BAG_SOCKS_SHARE = 0
const allowSocks = () => process.env.OPENCODE_PROXY_SOCKS === "1"
// Stay under the AI headerTimeout (5 min). Override with OPENCODE_PROXY_BUDGET_MS.
const DEFAULT_ROTATION_BUDGET_MS = 240_000
const MAX_ATTEMPTS = Number.POSITIVE_INFINITY
const MAX_POOL_ADVANCES = 24
// After the direct exit answers a quota status, every direct attempt only burns a
// round trip on the same error. Keep the block short anyway: a fresh VPN or a new
// network is exactly what recovers a burned address, and one request a minute is
// cheaper than never noticing the change.
const DIRECT_BLOCK_MS = 60_000
const FAILURES_BEFORE_BLOCK = 2
const BLOCK_MS = 10 * 60_000
// A proxy that already spent the daily free quota stays useless for hours, so it
// leaves the pool instead of wasting an attempt on every request.
const QUOTA_BLOCK_MS = 6 * 60 * 60_000
// Soft 429 from free lists is often per-IP burst, not a day-long ban. One hour
// left the pool looking full while every recently-tried exit stayed unpickable.
// Soft 429 used to park every HTTP exit for 15 min, leaving only SOCKS pickable.
const THROTTLE_BLOCK_MS = 3 * 60_000
// Validate against the endpoint that actually matters. The marketing site answers
// 200 from exits that the API rejects, so probing the homepage fills the pool with
// proxies that only produce failed tunnels. An unauthenticated GET answers 401/404,
// which still proves the exit can carry the traffic.
const DEFAULT_VALIDATION_URL = "https://opencode.ai/inference/systemone/v1/chat/completions"
// A reachable exit answers 400/401/404/405 to an unauthenticated probe. Blocks and
// quota errors mean the tunnel is useless for the traffic it would carry.
const UNUSABLE_STATUS = new Set([402, 403, 407, 429])
const reachable = (status: number) => status < 500 && !UNUSABLE_STATUS.has(status)

// OpenCode Zen reports an exhausted free quota as 402 as well as 429, so both rotate.
// 403 is what a filtered exit returns instead of a quota error, so it must rotate
// as well: keeping the response would surface a proxy block as a model failure.
const ROTATE_STATUS = new Set([402, 403, 407, 408, 425, 429, 529])

const localHost = (hostname: string) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "0.0.0.0") return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true
  return /^(?:fc|fd)[0-9a-f]{2}:/.test(host)
}

// Local and private targets stay direct unless explicitly opted in.
const local = (target: string) => {
  if (process.env.OPENCODE_PROXY_LOCAL === "1") return false
  const url = URL.canParse(target) ? new URL(target) : undefined
  return url ? localHost(url.hostname) : false
}

type Source = {
  readonly url: string
  readonly fallback?: string
  // Most lists are one `host:port` per line. The other kinds need their own parse.
  readonly kind?: "hideip" | "geonode" | "advanced"
}

// Strategy for free-tier longevity (OpenCode burns exit IPs fast):
// 1) Prefer verified / residential / elite shards over giant datacenter dumps.
// 2) Add country shards that are less saturated for opencode.ai free quota.
// 3) Keep a small volume fallback last. SOCKS stays opt-in (OPENCODE_PROXY_SOCKS=1).
const SOURCES: ReadonlyArray<Source> = [
  // xyzs996 — rechecked ~30 min; shards beat the monolithic http.txt dump.
  {
    url: "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/proxies/network/likely-residential/data.txt",
    fallback: "http",
  },
  {
    url: "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/proxies/latency/fast/data.txt",
    fallback: "http",
  },
  {
    url: "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/proxies/quality/top-1000/data.txt",
    fallback: "http",
  },
  {
    url: "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/proxies/anonymity/elite/data.txt",
    fallback: "http",
  },
  {
    url: "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/proxies/protocols/http/data.txt",
    fallback: "http",
  },
  // Relayglass — tiny, every entry answered a real request in the last ~5 min.
  { url: "https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/http/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/https/https.txt", fallback: "https" },
  // ProxyScrape filtered (API ~1 min). Elite/anonymous ≪ raw dump of burned hosts.
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&anonymity=elite&timeout=5000",
    fallback: "http",
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&anonymity=anonymous&timeout=5000",
    fallback: "http",
  },
  // Country HTTP shards (jsDelivr mirror, ~5 min) — diversify away from US/EU DC /24s.
  { url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/id/http/data.txt", fallback: "http" },
  { url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/br/http/data.txt", fallback: "http" },
  { url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/ph/http/data.txt", fallback: "http" },
  { url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/vn/http/data.txt", fallback: "http" },
  { url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/in/http/data.txt", fallback: "http" },
  { url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/eg/http/data.txt", fallback: "http" },
  // Volume fallback last (still HTTP-only).
  {
    url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/http/data.txt",
    fallback: "http",
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=5000",
    fallback: "http",
  },
]

// Lists measured at ~100% dead / quota-only in production. Kept out of SOURCES
// and also seeded into the runtime purge set so old caches cannot revive them.
const HARD_PURGED_SOURCES = [
  "raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt",
  "raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks4.txt",
  "raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks5.txt",
  "raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt",
  "raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt",
  "raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks4.txt",
  "raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt",
  "raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
  "raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt",
  "raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt",
  "raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt",
  "raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
  "raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
  "raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt",
  "raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt",
  "raw.githubusercontent.com/zevtyardt/proxy-list/main/socks5.txt",
  "raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt",
  "raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt",
  "raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/HTTP.txt",
  "raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/SOCKS5.txt",
  "raw.githubusercontent.com/prxchk/proxy-list/main/http.txt",
  "raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt",
  "raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt",
  "raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt",
  "raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt",
  "raw.githubusercontent.com/proxy-free/free-proxy-list/main/http.txt",
  "raw.githubusercontent.com/proxy-free/free-proxy-list/main/socks4.txt",
  "raw.githubusercontent.com/proxy-free/free-proxy-list/main/socks5.txt",
  "raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/all.txt",
  "raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/http.txt",
  "raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/socks4.txt",
  "raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/socks5.txt",
  "raw.githubusercontent.com/saisuiu/Lionkings-Http-Proxys-Proxies/main/cnfree.txt",
  "api.openproxylist.xyz/http.txt",
  "api.openproxylist.xyz/https.txt",
  "api.openproxylist.xyz/socks4.txt",
  "api.openproxylist.xyz/socks5.txt",
  "proxyspace.pro/http.txt",
  "proxyspace.pro/https.txt",
  "proxyspace.pro/socks5.txt",
  "advanced.name/freeproxy?http",
  "advanced.name/freeproxy?https",
  "advanced.name/freeproxy?socks4",
  "advanced.name/freeproxy?socks5",
  // Production pool: validate-"ok" at 85–90% bad, thousands of POST 429s, near-zero sticky.
  "raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt",
  "raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
  "raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
  "raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt",
  "raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt",
  "raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
  "raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
  "raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt",
  // Live EXPUNGED / hunt-flooders (POST 429 walls, 0 sticky). Removed from SOURCES too.
  "raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "raw.githubusercontent.com/monosans/proxy-list/main/proxies/https.txt",
  "raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt",
  "raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
  "raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
  "raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt",
  "raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt",
  "raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt",
  "raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt",
  "raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt",
  "raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt",
  "raw.githubusercontent.com/zloi-user/hideip.me/main/socks4.txt",
  "raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt",
  "api.proxyscrape.com/v4/free-proxy-list/get?socks5",
  "api.proxyscrape.com/v4/free-proxy-list/get?socks4",
  // Free-tier wall: probe-alive then POST 429 for minutes until headerTimeout.
  "proxylist.geonode.com/api/proxy-list",
  // SOCKS-only lists removed from SOURCES — keep purged so old caches cannot revive.
  "raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
  "raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks4.txt",
  "raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks4.txt",
  "raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks5.txt",
  "raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks4.txt",
  "raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt",
  "raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/socks4/socks4.txt",
  "raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/socks5/socks5.txt",
  "raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/socks4.txt",
  "raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/socks5.txt",
] as const

// v6: thaw runtime EXPUNGEs of good free shards (residential/elite/relayglass).
const YIELD_VERSION = 6

let entries: Entry[] = []
let active: string | undefined
let directBlockedUntil = 0
let starting: Promise<void> | undefined
let lastRefresh = 0
// The cached pool is the only warm state a fresh standalone process has, so every
// read path waits for it instead of racing the background refresh.
let loading: Promise<void> | undefined
const failures = new Map<string, { count: number; blockedUntil: number }>()
// Free-tier quota is shared across a datacenter /24. Burning only the exits already
// in `entries` left validateMany free to re-add cousins of the same block, so the
// hunt spent the whole AI headerTimeout (5 min) re-429ing `45.74.31.*`.
const subnetBlocks = new Map<string, number>()
// Per-list outcome counts. Host-only labels collapsed every GitHub mirror into one
// bucket, so bad lists could not be skipped — keep path (+ protocol query) instead.
const yields = new Map<string, { ok: number; bad: number; quota: number }>()
// After a quota-burned generation, refresh must download new lists instead of
// recycling the same candidate dump that just returned 429 for every exit.
let forceDiscover = false
// Raw discover bag for the hunt. Validated `entries` often sit at pickable 1–5
// while thousands of untried IPs wait on validate — inject them into POST races.
let candidateBag: { proxy: string; source?: string }[] = []
const sourceHints = new Map<string, string>()
// Runtime + persisted purge. Once a list proves ~100% dead it never rediscovers.
const purgedSources = new Set<string>(HARD_PURGED_SOURCES)
// Runtime EXPUNGE is effectively off for free lists. Thresholds that looked sane
// on sticky paid exits (8 dead → delete source) wiped residential/elite/relayglass
// after one 429 wall (`EXPUNGED …/likely-residential` with 1ok/15bad) and left only
// the burned volume dump. Permanent deletes stay in HARD_PURGED only.
const EXPUNGE_MIN_BAD = 10_000
const EXPUNGE_NEAR_DEAD_TOTAL = 10_000
const EXPUNGE_NEAR_DEAD_RATIO = 0.99

export const sourceLabel = (url: string) => {
  const parsed = new URL(url)
  // Geonode uses `protocols=`; ProxyScrape uses `protocol=`. Without both, every
  // Geonode page collapsed into one bucket and one EXPUNGE killed the whole API.
  const protocol =
    parsed.searchParams.get("protocol") ??
    parsed.searchParams.get("protocols") ??
    parsed.searchParams.get("type")
  const path = parsed.pathname.replace(/\/+$/, "")
  const page = parsed.searchParams.get("page")
  // Elite/anonymous/raw must stay distinct — otherwise score/retire collapses the
  // filtered ProxyScrape shards into the burned volume dump.
  const anonymity = parsed.searchParams.get("anonymity")
  const base = protocol ? `${parsed.host}${path}?${protocol}` : `${parsed.host}${path}`
  const withAnon = anonymity && anonymity !== "all" ? `${base}&${anonymity}` : base
  return page && page !== "1" ? `${withAnon}&page=${page}` : withAnon
}

const debug = (...values: unknown[]) => {
  if (process.env.OPENCODE_PROXY_DEBUG) console.error("[proxy-rotator]", ...values)
}

// `monosans/proxy-list/.../http.txt : proxy: 1.2.3.4:8080` — makes dead lists obvious in the log.
export const proxyTrace = (proxy: string | undefined, source?: string) => {
  if (!proxy) return "direct"
  const label = source ?? sourceOf(proxy) ?? "unknown"
  const host = URL.canParse(proxy)
    ? (() => {
        const url = new URL(proxy)
        return url.port ? `${url.hostname}:${url.port}` : url.hostname
      })()
    : proxy
  return `${label} : proxy: ${host}`
}

const cachePath = () => {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(root, "opencode", "proxy-pool.json")
}

const isSocksProxy = (proxy: string) => {
  const protocol = URL.canParse(proxy) ? new URL(proxy).protocol : ""
  return protocol === "socks4:" || protocol === "socks5:" || protocol === "socks5h:"
}

const isHttpProxy = (proxy: string) => {
  const protocol = URL.canParse(proxy) ? new URL(proxy).protocol : ""
  return protocol === "http:" || protocol === "https:"
}

// Mixed "residential/elite" txt shards still ship classic SOCKS ports. With
// SOCKS off, treating them as http:// only burns the race on refuse/reset.
const LIKELY_SOCKS_PORTS = new Set([1080, 1081, 1082, 1090, 4145, 4153, 5678, 9050, 9051])

const likelySocksPort = (proxy: string) => {
  if (!URL.canParse(proxy)) return false
  const port = Number(new URL(proxy).port || (isSocksProxy(proxy) ? 1080 : 0))
  return LIKELY_SOCKS_PORTS.has(port)
}

// HTTP(S) exit that is allowed into the hunt. Classic SOCKS ports mislabeled as
// http:// (1080/4145/…) used to refill pickable from cache and burn every wave.
const huntHttp = (proxy: string) => isHttpProxy(proxy) && (allowSocks() || !likelySocksPort(proxy))

// Prefer HTTP(S) in the race; SOCKS free exits mostly ECONNRESET under load.
const balanceRace = (proxies: ReadonlyArray<string>, limit = POST_RACE) => {
  const http: string[] = []
  const socks: string[] = []
  for (const proxy of proxies) {
    if (isSocksProxy(proxy)) {
      if (allowSocks()) socks.push(proxy)
      continue
    }
    if (!huntHttp(proxy)) continue
    http.push(proxy)
  }
  return [...http, ...socks.slice(0, POST_RACE_SOCKS)].slice(0, limit)
}

const socksHeavy = (list: ReadonlyArray<{ proxy: string }>) => {
  if (list.length < 40) return false
  const socks = list.reduce((count, item) => count + (isSocksProxy(item.proxy) ? 1 : 0), 0)
  return socks / list.length >= 0.7
}

const preferHttpBag = (list: ReadonlyArray<{ proxy: string; source?: string }>, limit: number) => {
  const http = list.filter((item) => huntHttp(item.proxy))
  const socks = list.filter((item) => isSocksProxy(item.proxy))
  const socksCap = Math.max(0, Math.floor(limit * BAG_SOCKS_SHARE))
  return interleaveBySource(
    [...interleaveBySource(http, limit), ...interleaveBySource(socks, socksCap)],
    limit,
  )
}

export const normalize = (value: string, fallback = "http"): string | undefined => {
  const raw = value.trim()
  if (!raw || raw.startsWith("#")) return
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (!explicitScheme && !/:\d{1,5}$/.test(raw)) return
  // Free "https" lists mean CONNECT proxies that can reach https:// sites — not
  // TLS-to-the-proxy. `https://ip:port` made Bun handshake the proxy and throw
  // EPROTO ("Does the server speak TLS on this port?") instead of discarding it.
  const scheme = fallback === "https" ? "http" : fallback
  const withScheme = explicitScheme ? raw : `${scheme}://${raw}`
  const url = URL.canParse(withScheme) ? new URL(withScheme) : undefined
  // Lists pad their output with unroutable placeholders such as 0.0.0.0.
  if (!url || !url.hostname || url.hostname === "0.0.0.0") return
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "socks4:" &&
    url.protocol !== "socks5:" &&
    url.protocol !== "socks5h:"
  )
    return
  // Coerce https:// proxies to http:// — same mislabel, same EPROTO. Keep the
  // original port (https default 443) so we do not silently rewrite :443 → :80.
  const protocol = url.protocol === "https:" ? "http:" : url.protocol
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : protocol === "http:"
        ? 80
        : 1080
  if (!Number.isInteger(port) || port < 1 || port > 65535) return
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : ""
  return `${protocol}//${auth}${url.hostname}:${port}`
}

export const parseProxyLines = (text: string, fallback = "http") =>
  text.split(/\r?\n/).flatMap((line) => {
    const token = line.trim().split(/[\s,;]+/)[0]
    const proxy = token ? normalize(token, fallback) : undefined
    return proxy ? [proxy] : []
  })

const seeded = async () => {
  const file = process.env.OPENCODE_PROXY_FILE
  const fromFile = file ? await Bun.file(file).text().catch(() => "") : ""
  const values = `${process.env.OPENCODE_PROXY ?? ""}\n${process.env.OPENCODE_PROXY_LIST ?? ""}\n${fromFile}`
  return parseProxyLines(values, "http")
}

const fetchText = async (url: string) => {
  const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < SOURCE_MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => {})
  return Buffer.concat(chunks).subarray(0, SOURCE_MAX_BYTES).toString("utf8")
}

// hideip.me writes `host:port:Country`, so the country suffix must be dropped.
const parseHideip = (text: string, fallback: string) =>
  text.split(/\r?\n/).flatMap((line) => {
    const [host, port] = line.trim().split(":")
    const proxy = host && port ? normalize(`${host}:${port}`, fallback) : undefined
    return proxy ? [proxy] : []
  })

const schemeOf = (protocols: readonly string[]) =>
  protocols.includes("https") ? "https" : protocols.includes("socks5") ? "socks5" : protocols.includes("http") ? "http" : undefined

const parseGeonode = (text: string) => {
  const data: unknown = JSON.parse(text)
  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data)) return []
  return data.data.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return []
    const ip = "ip" in entry && typeof entry.ip === "string" ? entry.ip : undefined
    const port = "port" in entry && typeof entry.port === "string" ? entry.port : undefined
    const protocols = "protocols" in entry && Array.isArray(entry.protocols) ? entry.protocols.filter((p) => typeof p === "string") : []
    const scheme = schemeOf(protocols)
    const proxy = ip && port && scheme ? normalize(`${scheme}://${ip}:${port}`) : undefined
    return proxy ? [proxy] : []
  })
}

// advanced.name hides every address as base64 inside `data-ip` and `data-port` cells.
const parseAdvanced = (text: string, fallback: string) => {
  const ips = [...text.matchAll(/data-ip="([^"]+)"/g)].map((match) => Buffer.from(match[1], "base64").toString())
  const ports = [...text.matchAll(/data-port="([^"]+)"/g)].map((match) => Buffer.from(match[1], "base64").toString())
  return ips.flatMap((ip, index) => {
    const port = ports[index]
    const proxy = ip && port ? normalize(`${ip}:${port}`, fallback) : undefined
    return proxy ? [proxy] : []
  })
}

const parseSource = (source: Source, text: string) => {
  if (source.kind === "hideip") return parseHideip(text, source.fallback ?? "http")
  if (source.kind === "advanced") return parseAdvanced(text, source.fallback ?? "http")
  if (source.kind === "geonode")
    try {
      return parseGeonode(text)
    } catch {
      return []
    }
  return parseProxyLines(text, source.fallback)
}

const discover = async () => {
  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const text = await fetchText(source.url)
      const label = sourceLabel(source.url)
      // Download even while a list is cooling/toxic — those skips are for pick only.
      // Cooling discover used to starve the only lists that still opened tunnels.
      if (sourcePurged(label)) {
        debug("skip source", label, "expunged")
        return []
      }
      return text ? parseSource(source, text).map((proxy) => ({ proxy, source: label })) : []
    }),
  )
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
}

const add = (proxy: string, checkedAt: number, source?: string) => {
  if (source && sourcePurged(source)) return
  // SOCKS free exits are opt-in — they dominated pickable and starved HTTP hunts.
  if (isSocksProxy(proxy) && !allowSocks()) return
  if (isHttpProxy(proxy) && !huntHttp(proxy)) return
  // Do not grow the pool with neighbours of a /24 that already shared a free-tier ban.
  if (subnetBlocked(proxy)) return
  const existing = entries.find((entry) => entry.proxy === proxy)
  if (existing) {
    existing.checkedAt = Math.max(existing.checkedAt, checkedAt)
    existing.source ??= source
    return
  }
  entries.push({ proxy, checkedAt, source })
}

// Burned exits are usually traceable to the list that offered them, so the source
// rides along in every debug line and in the cache.
const sourceOf = (proxy: string) =>
  entries.find((entry) => entry.proxy === proxy)?.source ?? sourceHints.get(proxy)

const noteYield = (proxy: string, kind: "ok" | "dead" | "quota") => {
  const source = sourceOf(proxy)
  // Host-only labels are legacy; counting them re-creates the toxic-GitHub bug.
  if (!source || !source.includes("/")) return
  if (sourceSkipped(source)) return
  const state = yields.get(source) ?? { ok: 0, bad: 0, quota: 0 }
  if (kind === "ok") state.ok++
  else if (kind === "dead") state.bad++
  else state.quota++
  yields.set(source, state)
  // Free-tier 429 is shared quota, not a dead list — only tunnel deaths expunge.
  if (kind === "dead") maybeExpunge(source)
}

const sourceScore = (source: string | undefined) => {
  if (!source || sourceSkipped(source)) return -1
  const state = yields.get(source)
  if (!state) return 0
  const total = state.ok + state.bad + state.quota
  if (total === 0) return 0
  return (state.ok - state.bad - state.quota) / total
}

// Ranking signal only — free HTTP lists always look "toxic" (ok≪bad) and used to
// skip every pickable exit + the whole candidate bag, leaving only `direct=429`.
const sourceToxic = (source: string | undefined) => {
  if (!source || !source.includes("/") || sourcePurged(source)) return false
  const state = yields.get(source)
  if (!state) return false
  const total = state.ok + state.bad
  if (total < 40) return false
  return state.ok === 0 && state.bad / total >= 0.95
}

const shouldExpunge = (source: string) => {
  const state = yields.get(source)
  if (!state) return false
  const total = state.ok + state.bad
  // Pure dead list (tunnel failures only — not free-tier 429).
  if (state.ok === 0 && state.bad >= EXPUNGE_MIN_BAD) return true
  // Effectively dead (one lucky ok amid a graveyard) — still delete the source.
  return total >= EXPUNGE_NEAR_DEAD_TOTAL && state.bad / total >= EXPUNGE_NEAR_DEAD_RATIO
}

// Delete the list forever: no discover, no pick, drop its exits from the pool.
const expungeSource = (source: string) => {
  if (!source.includes("/") || sourcePurged(source)) return
  const state = yields.get(source)
  purgedSources.add(source)
  yields.delete(source)
  const before = entries.length
  entries = entries.filter((entry) => entry.source !== source)
  if (active && sourceOf(active) === source) active = undefined
  forceDiscover = true
  lastRefresh = 0
  void saveCache()
  console.error(
    `[proxy-rotator] EXPUNGED source ${source} (${state?.ok ?? 0}ok/${state?.bad ?? 0}bad/${state?.quota ?? 0}quota) removed ${before - entries.length} exits`,
  )
}

const maybeExpunge = (source: string) => {
  if (shouldExpunge(source)) expungeSource(source)
}

// Brief pick-skip after a burned generation so validate can refill with fresh IPs.
// Ten minutes used to idle the only surviving lists while pickable sat at 0–3.
const SOURCE_RETIRE_MS = 45_000
const sourceCooldown = new Map<string, number>()

// HARD_PURGED may be a path prefix (geonode) so page/protocol labels still match.
const sourcePurged = (source: string | undefined) => {
  if (!source) return false
  if (purgedSources.has(source)) return true
  for (const purged of purgedSources) {
    if (source.startsWith(purged)) return true
  }
  return false
}

// Only hard-purged lists are unpickable. Toxic is score-only — free-tier HTTP
// sources trip toxic after a handful of dead dials and then the hunt never
// touches the 15k candidate bag (log: `pool 43 pickable 0 stale 0 bag 15252`).
const sourceSkipped = (source: string | undefined) => !source || sourcePurged(source)

const liftOldestCooldowns = (fraction = 0.5) => {
  const cooling = [...sourceCooldown.entries()].filter(([, until]) => until > Date.now()).toSorted((a, b) => a[1] - b[1])
  const drop = Math.max(1, Math.ceil(cooling.length * fraction))
  for (const [source] of cooling.slice(0, drop)) sourceCooldown.delete(source)
  return drop
}

// A generation of POST 429s burned specific exits — not every neighbour on the
// same list. Marking the whole source empty left pickable at 0–3 and then
// cooling discover for 10 minutes made the next hunt exhaust after ~7 tries.
const retireQuotaPool = (quotaProxies: ReadonlyArray<string>) => {
  active = undefined
  const sources = new Set<string>()
  const burned = new Set(quotaProxies)
  for (const proxy of burned) {
    const source = sourceOf(proxy)
    if (source) sources.add(source)
    if (!blocked(proxy)) markQuota(proxy, 429, false, true)
  }
  const until = Date.now() + SOURCE_RETIRE_MS
  for (const source of sources) {
    if (sourcePurged(source)) continue
    sourceCooldown.set(source, until)
  }
  entries = entries.filter((entry) => !blocked(entry.proxy))
  forceDiscover = true
  lastRefresh = 0
  void saveCache()
  debug("retire pool", burned.size, "exits", sources.size, "sources", [...sources].slice(0, 8))
}

const subnetBlocked = (proxy: string) => {
  const subnet = subnetOf(proxy)
  if (!subnet) return false
  const until = subnetBlocks.get(subnet)
  if (!until) return false
  if (until > Date.now()) return true
  subnetBlocks.delete(subnet)
  return false
}

const blocked = (proxy: string) => {
  if (subnetBlocked(proxy)) return true
  const state = failures.get(proxy)
  if (!state) return false
  if (state.blockedUntil > Date.now()) return true
  failures.delete(proxy)
  return false
}

const usable = () => {
  const now = Date.now()
  return entries.filter((entry) => !blocked(entry.proxy) && now - entry.checkedAt < POOL_FRESH_MS)
}

// Same filter pickMany uses. Decisions like "skip direct" must look at this, not
// usable() — otherwise toxic sources inflate the count and the hunt never starts.
const pickable = (exclude: Set<string> = new Set()) =>
  entries.filter(
    (entry) =>
      (allowSocks() ? isSocksProxy(entry.proxy) || huntHttp(entry.proxy) : huntHttp(entry.proxy)) &&
      !blocked(entry.proxy) &&
      !exclude.has(entry.proxy) &&
      !sourceSkipped(entry.source) &&
      Date.now() - entry.checkedAt < POOL_FRESH_MS,
  )

// Same as pickable without the freshness window — used when the warm pool is
// empty so a >1h-old cache still feeds the hunt instead of only direct=429.
const stalePickable = (exclude: Set<string> = new Set()) =>
  entries.filter(
    (entry) =>
      (allowSocks() ? isSocksProxy(entry.proxy) || huntHttp(entry.proxy) : huntHttp(entry.proxy)) &&
      !blocked(entry.proxy) &&
      !exclude.has(entry.proxy) &&
      !sourceSkipped(entry.source),
  )

const huntFuel = (exclude: Set<string> = new Set()) =>
  pickable(exclude).length > 0 ||
  stalePickable(exclude).length > 0 ||
  candidateBag.some(
    (candidate) =>
      huntHttp(candidate.proxy) &&
      !exclude.has(candidate.proxy) &&
      !blocked(candidate.proxy) &&
      !sourceSkipped(candidate.source),
  )

const markFailure = (proxy: string) => {
  if (active === proxy) active = undefined
  const state = failures.get(proxy) ?? { count: 0, blockedUntil: 0 }
  state.count++
  if (state.count >= FAILURES_BEFORE_BLOCK) {
    state.blockedUntil = Date.now() + BLOCK_MS
    // Soft block only — timeouts used to inflate yield-bad and EXPUNGE survivors.
  }
  failures.set(proxy, state)
  debug("failed", proxyTrace(proxy))
  void saveCache()
}

// A public exit that cannot open a tunnel now will not open one on the next
// request either, so it leaves immediately instead of costing a second dial.
const markDead = (proxy: string) => {
  if (active === proxy) active = undefined
  const state = failures.get(proxy) ?? { count: 0, blockedUntil: 0 }
  state.count = FAILURES_BEFORE_BLOCK
  state.blockedUntil = Math.max(state.blockedUntil, Date.now() + BLOCK_MS)
  failures.set(proxy, state)
  noteYield(proxy, "dead")
  // Cousins in the same /24 that all ECONNRESET (118.71.227.*, 171.245.71.*)
  // used to refill every race. Ban the subnet briefly after a few deaths.
  const subnet = subnetOf(proxy)
  if (subnet) {
    const hit = [...failures.entries()].filter(([item, fail]) => {
      if (fail.blockedUntil <= Date.now()) return false
      return subnetOf(item) === subnet
    }).length
    if (hit >= SUBNET_QUOTA_BEFORE_BLOCK) {
      const until = Date.now() + THROTTLE_BLOCK_MS
      subnetBlocks.set(subnet, Math.max(subnetBlocks.get(subnet) ?? 0, until))
      debug("subnet dead", subnet, hit)
    }
  }
  debug("dead", proxyTrace(proxy))
  void saveCache()
}

const markQuota = (proxy: string, status: number, daily: boolean, fromProbe = false) => {
  // Only the sticky exit itself may clear `active`. Probe/neighbour quota used to
  // subnet-ban the live sticky between messages, so the next prompt rediscovered
  // from scratch and looked like sticky was never pinned.
  if (active === proxy) active = undefined
  const until = Date.now() + (daily || status === 402 ? QUOTA_BLOCK_MS : THROTTLE_BLOCK_MS)
  const state = failures.get(proxy) ?? { count: 0, blockedUntil: 0 }
  state.count = FAILURES_BEFORE_BLOCK
  state.blockedUntil = Math.max(state.blockedUntil, until)
  failures.set(proxy, state)
  noteYield(proxy, "quota")
  debug(
    "quota",
    proxyTrace(proxy),
    status,
    daily || status === 402 ? "daily" : "throttle",
    fromProbe ? "probe" : "POST",
  )
  // Neighbours in the same /24 usually share the free-tier bucket — but only after
  // real POSTs. Probe 429s must not wipe the sticky that just answered a chat turn.
  const subnet = !fromProbe ? subnetOf(proxy) : undefined
  if (subnet) {
    const hit = entries.filter((entry) => {
      if (subnetOf(entry.proxy) !== subnet) return false
      const state = failures.get(entry.proxy)
      return state !== undefined && state.blockedUntil > Date.now()
    }).length
    if (hit >= SUBNET_QUOTA_BEFORE_BLOCK) {
      // Remember the /24 itself so later-validated cousins stay unpickable for `until`.
      subnetBlocks.set(subnet, Math.max(subnetBlocks.get(subnet) ?? 0, until))
      let burned = 0
      for (const entry of entries) {
        if (subnetOf(entry.proxy) !== subnet) continue
        if (entry.proxy === active) continue
        const neighbour = failures.get(entry.proxy) ?? { count: 0, blockedUntil: 0 }
        if (neighbour.blockedUntil >= until) continue
        neighbour.count = FAILURES_BEFORE_BLOCK
        neighbour.blockedUntil = Math.max(neighbour.blockedUntil, until)
        failures.set(entry.proxy, neighbour)
        burned++
      }
      debug("subnet quota", subnet, burned, status, "kept sticky", active ?? "none")
    }
  }
  void saveCache()
  // A burned proxy shrinks the pool, so look for replacements in the background.
  if (usable().length < POOL_TARGET / 2) {
    lastRefresh = 0
    warm()
  }
}

const markSuccess = (proxy: string) => {
  active = proxy
  // A just-proven exit must not stay blocked from an earlier false probe/subnet hit.
  failures.delete(proxy)
  const entry = entries.find((item) => item.proxy === proxy)
  if (entry) entry.checkedAt = Date.now()
  else add(proxy, Date.now())
  noteYield(proxy, "ok")
  debug("sticky", proxyTrace(proxy))
  void saveCache()
}

const proxyFor = (proxy: string) => {
  const url = new URL(proxy)
  if (url.protocol === "socks4:" || url.protocol === "socks5:" || url.protocol === "socks5h:")
    return SocksBridge.httpProxy(proxy)
  return proxy
}

const validate = async (proxy: string) => {
  try {
    const response = await globalThis.fetch(process.env.OPENCODE_PROXY_VALIDATE_URL || DEFAULT_VALIDATION_URL, {
      proxy: await proxyFor(proxy),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
    await response.body?.cancel()
    return reachable(response.status)
  } catch {
    return false
  }
}

// The probe reports the status instead of a boolean so the caller can tell a dead
// exit from one that only exhausted its quota.
const probe = async (proxy: string, target: string, signal: AbortSignal | undefined, deadline: number) => {
  const remaining = Math.max(500, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()))
  const timeout = AbortSignal.timeout(remaining)
  try {
    const response = await globalThis.fetch(target, {
      method: "GET",
      proxy: await proxyFor(proxy),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    await response.body?.cancel()
    return response.status
  } catch {
    return
  }
}

const validateMany = async (candidates: ReadonlyArray<{ proxy: string; source?: string }>, stop: () => boolean) => {
  let index = 0
  await Promise.all(
    Array.from({ length: VALIDATE_CONCURRENCY }, async () => {
      while (!stop() && index < candidates.length) {
        const candidate = candidates[index++]
        if (candidate.source && sourcePurged(candidate.source)) continue
        // Skip dialing exits in a /24 already burned for free-tier quota — validate
        // used to re-admit them and the next hunt dialed the same datacenter again.
        if (subnetBlocked(candidate.proxy)) continue
        if (await validate(candidate.proxy)) {
          add(candidate.proxy, Date.now(), candidate.source)
          debug("validated", proxyTrace(candidate.proxy, candidate.source))
        } else {
          // Validate is pool hygiene only. Counting invalids as yield-bad EXPUNGEd
          // every survivor (hookzof/hproxy/rdavydov/geonode) after ~8 dead dials
          // and left `pool 0` with nothing left to discover.
          debug("invalid", proxyTrace(candidate.proxy, candidate.source))
        }
      }
    }),
  )
}

const shuffle = <A>(values: A[]) => {
  for (let index = values.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1))
    const value = values[index]
    values[index] = values[target]
    values[target] = value
  }
  return values
}

// Spread validate work across lists so the first source in SOURCES cannot eat the
// whole MAX_CANDIDATES budget alone.
const interleaveBySource = <A extends { source?: string }>(candidates: ReadonlyArray<A>, limit: number) => {
  const buckets = new Map<string, A[]>()
  for (const candidate of candidates) {
    const key = candidate.source ?? ""
    const list = buckets.get(key)
    if (list) list.push(candidate)
    else buckets.set(key, [candidate])
  }
  const queues = [...buckets.entries()]
    .toSorted((left, right) => sourceScore(right[0]) - sourceScore(left[0]))
    .map((entry) => entry[1])
  const out: A[] = []
  while (out.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      if (out.length >= limit) break
      const next = queue.shift()
      if (next) out.push(next)
    }
  }
  return out
}

const candidatePath = () => {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(root, "opencode", "proxy-candidates.json")
}

const readCandidates = async () => {
  try {
    const data: unknown = JSON.parse(await Bun.file(candidatePath()).text())
    if (!data || typeof data !== "object") return
    if (!("savedAt" in data) || typeof data.savedAt !== "number") return
    if (!("proxies" in data) || !Array.isArray(data.proxies)) return
    const sources =
      "sources" in data && data.sources && typeof data.sources === "object"
        ? (data.sources as Record<string, unknown>)
        : {}
    const candidates = data.proxies.flatMap((value) => {
      if (typeof value !== "string") return []
      const proxy = normalize(value)
      if (!proxy) return []
      const source = sources[proxy]
      return [{ proxy, source: typeof source === "string" ? source : undefined }]
    })
    return { savedAt: data.savedAt, candidates }
  } catch {}
}

const saveCandidates = async (candidates: ReadonlyArray<{ proxy: string; source?: string }>) => {
  const path = candidatePath()
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const kept = candidates.slice(0, CANDIDATE_CACHE_LIMIT)
    const sources = Object.fromEntries(
      kept.flatMap((candidate) => (candidate.source ? [[candidate.proxy, candidate.source]] : [])),
    )
    await Bun.write(
      path,
      JSON.stringify({ savedAt: Date.now(), proxies: kept.map((candidate) => candidate.proxy), sources }),
    )
    await chmod(path, 0o600)
  } catch (cause) {
    debug("candidate cache write failed", cause)
  }
}

const readCache = async () => {
  try {
    const text = await Bun.file(cachePath()).text()
    const data: unknown = JSON.parse(text)
    if (!data || typeof data !== "object" || !("entries" in data) || !Array.isArray(data.entries)) return
    for (const value of data.entries) {
      if (!value || typeof value !== "object") continue
      const proxy = "proxy" in value && typeof value.proxy === "string" ? normalize(value.proxy) : undefined
      const checkedAt = "checkedAt" in value && typeof value.checkedAt === "number" ? value.checkedAt : 0
      const blockedUntil = "blockedUntil" in value && typeof value.blockedUntil === "number" ? value.blockedUntil : 0
      const source = "source" in value && typeof value.source === "string" ? value.source : undefined
      if (!proxy) continue
      add(proxy, checkedAt, source)
      // Burned proxies stay cached so a later run skips them instead of retrying.
      if (blockedUntil > Date.now())
        failures.set(proxy, { count: FAILURES_BEFORE_BLOCK, blockedUntil })
    }
    // A restart should resume on the exit that last answered instead of hunting
    // again, which is the slowest possible start.
    if ("active" in data && typeof data.active === "string") {
      const proxy = normalize(data.active)
      if (proxy && !blocked(proxy)) active = proxy
    }
    const yieldVersion = "yieldVersion" in data && typeof data.yieldVersion === "number" ? data.yieldVersion : 0
    // v3: caches that EXPUNGEd survivors via validate-bad are poison — keep only
    // the compile-time HARD_PURGED set, then re-learn POST yields from scratch.
    if (yieldVersion >= YIELD_VERSION && "purged" in data && Array.isArray(data.purged)) {
      for (const value of data.purged) {
        if (typeof value === "string" && value.includes("/")) purgedSources.add(value)
      }
    }
    if ("subnets" in data && data.subnets && typeof data.subnets === "object") {
      for (const [subnet, until] of Object.entries(data.subnets as Record<string, unknown>)) {
        if (typeof until !== "number" || until <= Date.now()) continue
        if (!/^\d{1,3}(?:\.\d{1,3}){3}\/24$/.test(subnet)) continue
        subnetBlocks.set(subnet, until)
      }
    }
    // Pre-v3 caches mixed validate into yields — ignore them.
    if (yieldVersion >= YIELD_VERSION && "yields" in data && data.yields && typeof data.yields === "object") {
      for (const [source, value] of Object.entries(data.yields as Record<string, unknown>)) {
        // Drop host-only yield rows left by the old labeler — they poison every
        // GitHub list under one toxic key.
        if (!source.includes("/")) continue
        if (sourcePurged(source)) continue
        if (!value || typeof value !== "object") continue
        const ok = "ok" in value && typeof value.ok === "number" ? value.ok : 0
        const bad = "bad" in value && typeof value.bad === "number" ? value.bad : 0
        const quota = "quota" in value && typeof value.quota === "number" ? value.quota : 0
        if (ok > 0 || bad > 0 || quota > 0) yields.set(source, { ok, bad, quota })
        // Cached evidence of a dead list → expunge on load, do not thaw it back.
        if (shouldExpunge(source)) expungeSource(source)
      }
    }
    // Drop exits that belonged to lists we already deleted, and SOCKS / SOCKS-port
    // mislabels unless opted in (old caches refilled :1080/:4145 into every wave).
    entries = entries.filter(
      (entry) =>
        (!entry.source || !sourcePurged(entry.source)) &&
        (allowSocks() ? isSocksProxy(entry.proxy) || huntHttp(entry.proxy) : huntHttp(entry.proxy)),
    )
    if (
      active &&
      (sourcePurged(sourceOf(active)) ||
        (isSocksProxy(active) && !allowSocks()) ||
        (isHttpProxy(active) && !huntHttp(active)))
    )
      active = undefined
  } catch {}
}

const saveCache = async () => {
  const path = cachePath()
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // Burned exits must stay in the cache with blockedUntil. Dropping them made
    // every restart rediscover the same dead addresses from the candidate list.
    const now = Date.now()
    const data = JSON.stringify({
      version: 1,
      yieldVersion: YIELD_VERSION,
      active,
      purged: [...purgedSources],
      subnets: Object.fromEntries([...subnetBlocks].filter(([, until]) => until > now)),
      yields: Object.fromEntries([...yields].filter(([source]) => !sourcePurged(source))),
      entries: entries
        .filter((entry) => !entry.source || !sourcePurged(entry.source))
        .toSorted((left, right) => left.checkedAt - right.checkedAt)
        .slice(-POOL_CACHE_LIMIT)
        .map((entry) => ({
          proxy: entry.proxy,
          checkedAt: entry.checkedAt,
          blockedUntil: failures.get(entry.proxy)?.blockedUntil ?? 0,
          source: entry.source,
        })),
    })
    await Bun.write(path, data)
    await chmod(path, 0o600)
  } catch (cause) {
    debug("cache write failed", cause)
  }
}

const load = () =>
  (loading ??= (async () => {
    await readCache().catch(() => {})
    // Seed the hunt bag from disk before the first refresh finishes — otherwise
    // a stale pool does direct=429 while proxy-candidates.json sits unused.
    if (candidateBag.length > 0) return
    const cached = await readCandidates()
    if (!cached) return
    candidateBag = preferHttpBag(
      cached.candidates.filter(
        (candidate) =>
          !blocked(candidate.proxy) &&
          (allowSocks() ? isSocksProxy(candidate.proxy) || huntHttp(candidate.proxy) : huntHttp(candidate.proxy)),
      ),
      CANDIDATE_CACHE_LIMIT,
    )
  })())

const refresh = async () => {
  await load()
  const now = Date.now()
  const fresh = entries.filter((entry) => now - entry.checkedAt < POOL_FRESH_MS && !blocked(entry.proxy))
  const stale = entries.filter((entry) => now - entry.checkedAt >= POOL_FRESH_MS || blocked(entry.proxy))
  const known = new Set(fresh.map((entry) => entry.proxy))
  const cached = await readCandidates()
  // A dry usable pool must not keep recycling the same burned candidate dump —
  // that is how the first message fails with only `direct=429` and no proxy try.
  const dry = usable().length === 0
  // 20k SOCKS5-only dumps (hookzof) used to reuse for 30 min and starve HTTP.
  const poisoned = Boolean(cached && socksHeavy(cached.candidates))
  const discoverNow = forceDiscover || dry || poisoned
  forceDiscover = false
  const reuse =
    !discoverNow &&
    process.env.OPENCODE_PROXY_ONLY !== "1" &&
    cached &&
    now - cached.savedAt < CANDIDATE_CACHE_MS
  const discovered = reuse
    ? cached.candidates
    : process.env.OPENCODE_PROXY_ONLY === "1"
      ? []
      : await discover()
  if (!reuse && discovered.length > 0) void saveCandidates(preferHttpBag(discovered, CANDIDATE_CACHE_LIMIT))
  const filtered = [
    ...stale.map((entry) => ({ proxy: entry.proxy, source: entry.source })),
    ...(await seeded()).map((proxy) => ({ proxy, source: "env" as string | undefined })),
    ...discovered,
  ].filter((candidate) => {
    // A previously burned exit is still in the candidate dump for hours; skip it
    // here so validation does not spend slots re-probing known-dead addresses.
    if (blocked(candidate.proxy) || known.has(candidate.proxy) || sourceSkipped(candidate.source)) return false
    known.add(candidate.proxy)
    return true
  })
  // Round-robin across lists + HTTP-first. Hookzof SOCKS used to fill the bag
  // alone and the hunt spent 240s on ECONNRESET with almost no HTTP try.
  const candidates = preferHttpBag(filtered, MAX_CANDIDATES)
  // Hunt bag is HTTP-first. SOCKS stay for validated probe survivors only.
  candidateBag = preferHttpBag(
    [
      ...candidates.filter((candidate) => !blocked(candidate.proxy)),
      ...candidateBag.filter(
        (candidate) =>
          !blocked(candidate.proxy) && !candidates.some((next) => next.proxy === candidate.proxy),
      ),
    ],
    CANDIDATE_CACHE_LIMIT,
  )

  await validateMany(
    [...fresh.map((entry) => ({ proxy: entry.proxy, source: entry.source })), ...candidates],
    () => usable().length >= POOL_TARGET,
  )
  await saveCache()
  debug(
    "pool",
    usable().length,
    "toxic",
    [...yields.entries()].filter(([source]) => sourceToxic(source)).map(([source]) => source).slice(0, 8),
  )
}

export const warm = (force = false) => {
  if (process.env.OPENCODE_PROXY_DISABLE === "1") return
  const now = Date.now()
  if (starting) return
  // An empty usable pool must refresh even inside the normal interval — otherwise
  // the first model call races a no-op warm and dies on direct=429 alone.
  if (!force && usable().length > 0 && now - lastRefresh < REFRESH_MS) return
  lastRefresh = now
  starting = refresh()
    .catch((cause) => debug("refresh failed", cause))
    .finally(() => {
      starting = undefined
    })
}

const awaitWarm = async (budgetMs: number) => {
  warm(true)
  if (!starting) return
  await Promise.race([starting, Bun.sleep(budgetMs)])
}

const pickMany = (exclude: Set<string>, count: number) => {
  const list = pickable(exclude).length > 0 ? pickable(exclude) : stalePickable(exclude)
  if (list.length === 0) return []
  // Prefer exits from lists that still yield successes, then the newest half of
  // that set. Uniform picks across an hour-old pool mostly dial already-dead IPs.
  const ranked = list.toSorted((left, right) => {
    // HTTP first — SOCKS free exits dominate dead dials and starve the race.
    const schemeGap = Number(isHttpProxy(right.proxy)) - Number(isHttpProxy(left.proxy))
    if (schemeGap !== 0) return schemeGap
    const yieldGap = sourceScore(right.source) - sourceScore(left.source)
    if (Math.abs(yieldGap) > 0.15) return yieldGap
    return right.checkedAt - left.checkedAt
  })
  const window = ranked.slice(0, Math.max(count * 3, Math.ceil(ranked.length / 2)))
  // Spread across /24s so one burned datacenter block (e.g. 45.74.31.0/24) does
  // not fill the whole probe batch with cousins of the same dead exit.
  const picked: string[] = []
  const seen = new Set<string>()
  for (const entry of shuffle(window)) {
    if (picked.length >= count) break
    const subnet = subnetOf(entry.proxy) ?? entry.proxy
    if (seen.has(subnet)) continue
    seen.add(subnet)
    picked.push(entry.proxy)
  }
  if (picked.length >= count) return picked
  for (const entry of shuffle(window)) {
    if (picked.length >= count) break
    if (picked.includes(entry.proxy)) continue
    picked.push(entry.proxy)
  }
  return picked
}

// Pull unvalidated discover exits into the hunt. Without this, POST_RACE sits idle
// while validate dribbles one alive proxy at a time and the budget dies on ~30 tries.
const takeCandidates = (exclude: Set<string>, count: number) => {
  if (count <= 0) return [] as string[]
  // HTTP(S) only from the bag. Injecting SOCKS here is what produced a 100-line
  // exhaust of socks5 ECONNRESET after the candidate cache went 20000/20000 SOCKS.
  const eligible = candidateBag.filter(
    (candidate) =>
      huntHttp(candidate.proxy) &&
      !exclude.has(candidate.proxy) &&
      !blocked(candidate.proxy) &&
      !sourceSkipped(candidate.source) &&
      !subnetBlocked(candidate.proxy),
  )
  const interleaved = interleaveBySource(eligible, Math.max(count * 4, count))
  const picked: string[] = []
  const seen = new Set<string>()
  const taken = new Set<string>()
  for (const candidate of interleaved) {
    if (picked.length >= count) break
    const subnet = subnetOf(candidate.proxy) ?? candidate.proxy
    if (seen.has(subnet)) continue
    seen.add(subnet)
    if (candidate.source) sourceHints.set(candidate.proxy, candidate.source)
    picked.push(candidate.proxy)
    taken.add(candidate.proxy)
  }
  candidateBag = candidateBag.filter((candidate) => !taken.has(candidate.proxy))
  return picked
}

const fillBatch = (exclude: Set<string>, count: number) => {
  // Never let a SOCKS-heavy pool fill the batch alone — always top up from the
  // HTTP candidate bag so pickable-socks cannot skip takeCandidates.
  const fromPool = balanceRace(pickMany(exclude, count), count)
  const skip = new Set(exclude)
  for (const proxy of fromPool) skip.add(proxy)
  if (fromPool.length >= count) return fromPool
  return [...fromPool, ...takeCandidates(skip, count - fromPool.length)]
}

const replayable = (input: FetchInput, init: FetchInit | undefined) => {
  // Effect hands the executor a Request with a body stream. Cloning keeps the
  // original unconsumed so a rate-limited POST can be replayed through a proxy.
  if (input instanceof Request) return !input.bodyUsed
  const body = init?.body
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  )
}

// A streamed body cannot be replayed, so buffer it once: rotation must not depend
// on how the caller happened to hand over the request payload.
const prepareBody = async (input: FetchInput, init: FetchInit | undefined) => {
  if (init?.body instanceof ReadableStream)
    return {
      input,
      init: { ...init, body: await new Response(init.body).arrayBuffer() },
      canRetry: true,
    }
  // Effect often hands a Request whose body is a one-shot stream. Buffer it into
  // init so every rotate attempt can rebuild the same POST instead of leaking the
  // first 429 when clone() is no longer available.
  if (input instanceof Request && input.body && !input.bodyUsed) {
    const body = await input.clone().arrayBuffer()
    const headers = new Headers(input.headers)
    return {
      input: input.url,
      init: { ...init, method: input.method, headers, body },
      canRetry: true,
    }
  }
  return { input, init, canRetry: replayable(input, init) }
}

const send = async (
  input: FetchInput,
  init: FetchInit | undefined,
  proxy: string | undefined,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
  raceSignal?: AbortSignal,
) => {
  // Clone even the direct attempt: the original stays unconsumed for a retry.
  const request: FetchInput = input instanceof Request ? (input.clone() as FetchInput) : input
  if (!proxy) return globalThis.fetch(request, init)
  const external = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  // Bun's proxy/SOCKS path sometimes ignores AbortSignal while waiting for
  // response headers. A sticky exit that hangs then burns the whole AI header
  // timeout (5 min) and the session retries the same proxy forever. Abort through
  // a controller and also race a hard timer so rotation always moves on.
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  external?.addEventListener("abort", onAbort)
  raceSignal?.addEventListener("abort", onAbort)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Proxy header timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      globalThis.fetch(request, {
        ...init,
        proxy,
        signal: controller.signal,
      }),
      timedOut,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    external?.removeEventListener("abort", onAbort)
    raceSignal?.removeEventListener("abort", onAbort)
  }
}

export const shouldRotate = (status: number) => ROTATE_STATUS.has(status)

// Soft ceiling on POST 402/429 in one hunt. Probe 429s do not count — a batch of
// dead probes used to hit 24 and quit while hundreds of untried exits remained.
const DEFAULT_QUOTA_LIMIT = 96
// After proxies already failed, keep hunting for a refill instead of quitting in
// a few seconds — users still prefer a longer wait over an instant exhausted error
// when public lists are slow to validate.
const EMPTY_POOL_WAIT_MS = 8_000
// Cold start: enough time for one validate wave, not enough to burn headerTimeout.
const INITIAL_POOL_WAIT_MS = 25_000
// Free-tier quota is often shared across a datacenter /24. Burning one exit and
// then dialing its neighbours only repeats the same 429.
const SUBNET_QUOTA_BEFORE_BLOCK = 2

const rotationBudget = () => {
  const value = Number(process.env.OPENCODE_PROXY_BUDGET_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROTATION_BUDGET_MS
}

// Cap POST quota answers per hunt so a wall of 429s cannot pin the request for
// the full budget when nothing pickable remains. While pickable exits still
// exist, keep rotating — each public IP has its own free-tier bucket.
const quotaLimit = () => {
  const value = Number(process.env.OPENCODE_PROXY_QUOTA_LIMIT)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_QUOTA_LIMIT
}

const quotaDry = (hits: number, exclude: Set<string>) =>
  hits >= quotaLimit() && pickable(exclude).length === 0

export const subnetOf = (proxy: string) => {
  const host = URL.canParse(proxy) ? new URL(proxy).hostname : undefined
  if (!host) return
  const parts = host.split(".")
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
}

// The provider's own quota wording decides whether the exit is burned for the
// day or only throttled for a while. Both leave the pool, but the daily case comes
// back much later.
// Only hard daily language gets the 6h ban. Generic "usage limit" on every free
// 429 was parking working exits for hours and emptying the pickable pool.
const dailyQuota = (status: number, body: string) =>
  status === 402 || /freeusagelimiterror|daily[-_\s]?limit|quota[-_\s]?exceeded/i.test(body)

export const fetch = async (input: FetchInput, init?: FetchInit): Promise<FetchResponse> => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!/^https?:/i.test(target) || process.env.OPENCODE_PROXY_DISABLE === "1" || local(target))
    return globalThis.fetch(input, init)

  const force = process.env.OPENCODE_PROXY_FORCE === "1"
  await load()
  // Prefer a warm pickable pool before hunting. usable() alone is not enough —
  // toxic legacy labels can leave usable high while pickMany returns nothing.
  // Cold start: wait for validate, but also keep stale cache / candidate bag as
  // hunt fuel so we never burn the first attempt on direct=429 alone.
  if (!huntFuel()) await awaitWarm(Math.min(20_000, INITIAL_POOL_WAIT_MS))
  else warm()
  if (force && !active) {
    for (const proxy of await seeded()) {
      if (!(await validate(proxy))) continue
      add(proxy, Date.now())
      active = proxy
      break
    }
  }
  const prepared = await prepareBody(input, init)
  const canRetry = prepared.canRetry
  input = prepared.input
  init = prepared.init
  debug(
    "replayable",
    canRetry,
    "pool",
    usable().length,
    "pickable",
    pickable().length,
    "stale",
    stalePickable().length,
    "bag",
    candidateBag.length,
  )
  const excluded = new Set<string>()
  const deadline = Date.now() + rotationBudget()
  // A recently limited direct exit only repeats its quota error, so start on the
  // pool and give the direct attempt another chance after the block expires. When
  // every known exit is blocked the pool is dry, so ignore the block: the caller's
  // own network may have changed (VPN) or the allowance may have reset.
  let directBlocked = Date.now() < directBlockedUntil && !entries.every((entry) => blocked(entry.proxy))
  let directAttempts = 0
  let quotaHits = 0
  let proxyTried = false
  let failure: unknown
  let emptySince = 0
  let poolAdvances = 0
  // Always leave a trace: a failed rotation is the one case users need to report.
  const tried: string[] = []
  const quotaTried: string[] = []

  const external = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const tryAdvancePool = async () => {
    // Finite budgets still cap advances; forever-hunt keeps retiring lists.
    if (Number.isFinite(deadline) && poolAdvances >= MAX_POOL_ADVANCES) return false
    // Cold empty pool (no quotaTried yet) must still rediscover — otherwise the
    // hunt idles until deadline and exhausts with only `direct=429`.
    if (quotaTried.length === 0 && huntFuel(excluded)) return false
    poolAdvances++
    const burned = [...new Set(quotaTried)]
    quotaTried.length = 0
    if (burned.length > 0) retireQuotaPool(burned)
    quotaHits = 0
    emptySince = 0
    const warmMs = Math.min(20_000, Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 20_000)
    forceDiscover = true
    lastRefresh = 0
    await awaitWarm(warmMs)
    if (!huntFuel(excluded)) {
      // Cooldowns only — purged sources stay deleted. Lift temporary bans and
      // rediscover surviving lists instead of exhausting while candidates remain.
      liftOldestCooldowns(0.5)
      forceDiscover = true
      lastRefresh = 0
      await awaitWarm(warmMs)
    }
    debug("advanced pool", poolAdvances, "pickable", pickable(excluded).length, "stale", stalePickable(excluded).length, "purged", purgedSources.size)
    return huntFuel(excluded)
  }
  // The deadline bounds the hunt. This guard only stops a pathologically uniform
  // stream of real attempts from pinning a request forever.
  let attempts = 0
  while (Date.now() < deadline && attempts < MAX_ATTEMPTS) {
    // The AI headerTimeout aborts the signal when the rotator has already spent
    // minutes hunting. Bail before the next probe so the session retry can start
    // clean instead of racing a timed-out outer Effect.
    if (external?.aborted) {
      throw external.reason instanceof Error
        ? external.reason
        : new DOMException("The operation was aborted.", "AbortError")
    }
    // Keep the last exit that answered until it fails. Reusing a live proxy avoids
    // re-hunting a replacement on every single model call, while a rate-limited or
    // dead exit is discarded below and never selected again.
    // Sticky wins every time until THAT exit fails a real POST.
    const sticky =
      active && !excluded.has(active) && !blocked(active) && !sourceSkipped(sourceOf(active)) ? active : undefined
    if (sticky) debug("sticky try", proxyTrace(sticky))
    // Never open with direct while the cache/bag still has HTTP fuel — that is
    // the `exhaust: direct=429` failure after a >1h-old proxy-pool.json load.
    const direct =
      !force &&
      !proxyTried &&
      !sticky &&
      directAttempts === 0 &&
      !directBlocked &&
      !huntFuel(excluded)
    let selected = direct ? undefined : sticky

    if (!direct && !selected) {
      const batch = fillBatch(excluded, PROBE_CONCURRENCY)
      if (batch.length === 0) {
        // The pool ran dry. A block inherited from a previous request may be stale
        // because the caller switched networks, so give direct one more look before
        // waiting for discovery.
        if (directAttempts === 0 && directBlocked) {
          directBlocked = false
          continue
        }
        // Keep filling until the budget says stop. Never abort with an empty `tried`
        // after a few seconds — that is the "desistindo fácil" failure mode.
        const waitMs = proxyTried || quotaHits > 0 ? EMPTY_POOL_WAIT_MS : INITIAL_POOL_WAIT_MS
        emptySince ||= Date.now()
        if (Date.now() - emptySince >= waitMs && tried.length === 0 && directAttempts === 0 && !huntFuel(excluded)) {
          // Force a direct attempt once so the error trace is not blank.
          directBlocked = false
          emptySince = 0
          continue
        }
        if (Date.now() - emptySince >= waitMs) {
          if (await tryAdvancePool()) {
            emptySince = 0
            continue
          }
          // Default budget is infinite — keep rediscovering instead of exhausting.
          if (Number.isFinite(deadline) && Date.now() >= deadline) {
            debug("pool empty", quotaHits, tried.length, "pickable", pickable(excluded).length)
            break
          }
          emptySince = Date.now()
          forceDiscover = true
          lastRefresh = 0
          await awaitWarm(Math.min(5_000, Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 5_000))
          continue
        }
        const warmMs = Math.min(3_000, Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 3_000)
        await awaitWarm(warmMs)
        if (Number.isFinite(deadline) && Date.now() >= deadline) break
        await Bun.sleep(Math.min(250, Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 250))
        continue
      }
      emptySince = 0
      const probed = await Promise.all(
        batch.map(async (proxy) => ({ proxy, status: await probe(proxy, target, external, deadline) })),
      )
      for (const result of probed) {
        if (result.status !== undefined && reachable(result.status)) continue
        // Probe timeout (undefined) must NOT markDead — that was burning the whole
        // pool on slow SOCKS GETs and leaving only `probe:timeout` in the UI with
        // zero real POST attempts. Keep them eligible for a POST + first-byte try.
        if (result.status === undefined) continue
        excluded.add(result.proxy)
        // Probe 429 marks the exit for this request but does not burn the POST
        // quota budget — otherwise 2 probe batches quit the hunt at ~24. Still
        // record it so a fully rate-limited generation can retire its sources.
        if (result.status === 402 || result.status === 429) {
          quotaTried.push(result.proxy)
          markQuota(result.proxy, result.status, false, true)
        } else if (result.status === 403 || result.status === 407) markDead(result.proxy)
        else markFailure(result.proxy)
      }
      const alive = probed
        .filter((result) => result.status !== undefined && reachable(result.status))
        .map((result) => result.proxy)
      const soft = probed
        .filter((result) => result.status === undefined && !excluded.has(result.proxy))
        .map((result) => result.proxy)
      // Race only probe survivors. Padding with unvalidated bag made
      // `alive:1 race 12` → 11 timeouts per wave (…+424 more). Soft dials only
      // before any free-tier 429, and never alongside a live exit.
      let race = balanceRace(alive, POST_RACE)
      if (race.length === 0 && soft.length > 0 && quotaHits === 0)
        race = balanceRace(soft, Math.min(3, POST_RACE))
      debug(
        "probe",
        batch.length,
        alive.length ? `alive:${alive.length}` : soft.length && quotaHits === 0 ? "post-anyway" : "none",
        "race",
        race.length,
        "bag",
        candidateBag.length,
        "quota",
        quotaHits,
        race[0] ? proxyTrace(race[0]) : "",
      )
      if (quotaDry(quotaHits, excluded) && attempts > 0) {
        if (await tryAdvancePool()) continue
        if (Number.isFinite(deadline) && Date.now() >= deadline) {
          debug("quota dry", quotaHits, "pickable", pickable(excluded).length)
          break
        }
        continue
      }
      if (race.length === 0) {
        for (const result of probed) {
          if (result.status === undefined) excluded.add(result.proxy)
        }
        continue
      }

      // Race several POSTs. First usable response wins; cancel the rest so a slow
      // timeout does not hold the wave after a fast 429 wall.
      proxyTried = true
      const remaining = Math.max(1_000, deadline - Date.now())
      // 429 answers in <1s — keep the wave short once we are on a free-tier wall.
      const timeoutMs = Math.min(
        quotaHits >= 8 ? QUOTA_RACE_TIMEOUT_MS : ATTEMPT_TIMEOUT_MS,
        remaining,
      )
      attempts += race.length
      const controllers = race.map(() => new AbortController())
      let won = false
      const raced = await Promise.all(
        race.map(async (candidate, index) => {
          debug("attempt", proxyTrace(candidate), new URL(target).host)
          try {
            const via = await proxyFor(candidate)
            const response = await send(input, init, via, timeoutMs, controllers[index].signal)
            if (!shouldRotate(response.status) && !won) {
              won = true
              for (let other = 0; other < controllers.length; other++) {
                if (other !== index) controllers[other].abort()
              }
            }
            return { candidate, response, cancelled: false }
          } catch (cause) {
            return {
              candidate,
              cause,
              cancelled: controllers[index].signal.aborted && won,
            }
          }
        }),
      )

      let winner: { candidate: string; response: Response } | undefined
      for (const result of raced) {
        if ("cause" in result) {
          excluded.add(result.candidate)
          // Race losers aborted after a winner — do not soft-block them as failures.
          if (result.cancelled) continue
          const label = networkDropLabel(result.cause)
          tried.push(`${result.candidate}=${label}`)
          failure = result.cause
          debug(
            "error",
            proxyTrace(result.candidate),
            result.cause instanceof Error ? result.cause.message : result.cause,
          )
          markAttemptDrop(result.candidate, result.cause)
          continue
        }
        tried.push(`${result.candidate}=${result.response.status}`)
        debug("response", proxyTrace(result.candidate), result.response.status)
        if (!shouldRotate(result.response.status)) {
          if (!winner) winner = { candidate: result.candidate, response: result.response }
          else void result.response.body?.cancel()
          continue
        }
        const body = await result.response.text().catch(() => "")
        if (!canRetry) {
          tried.push(`${result.candidate}=${result.response.status}/noreplay`)
          excluded.add(result.candidate)
          break
        }
        if (result.response.status === 402 || result.response.status === 429) {
          quotaHits++
          quotaTried.push(result.candidate)
          markQuota(result.candidate, result.response.status, dailyQuota(result.response.status, body))
        } else markFailure(result.candidate)
        excluded.add(result.candidate)
      }

      if (winner) {
        const opened = await openStream(
          winner.response,
          winner.candidate,
          external,
          Math.min(FIRST_BYTE_TIMEOUT_MS, Math.max(1_000, deadline - Date.now())),
        )
        if ("drop" in opened) {
          tried.push(`${winner.candidate}=${networkDropLabel(opened.drop)}`)
          failure = opened.drop
          debug("first byte", proxyTrace(winner.candidate), opened.drop instanceof Error ? opened.drop.message : opened.drop)
          markAttemptDrop(winner.candidate, opened.drop)
          excluded.add(winner.candidate)
        } else {
          return opened.response
        }
      }

      if (!canRetry && tried.some((item) => item.includes("/noreplay"))) break
      if (quotaDry(quotaHits, excluded)) {
        if (await tryAdvancePool()) continue
        if (Number.isFinite(deadline) && Date.now() >= deadline) {
          debug("quota dry", quotaHits, "pickable", pickable(excluded).length)
          break
        }
        continue
      }
      if (Number.isFinite(deadline) && Date.now() > deadline) break
      if (external?.aborted) {
        throw external.reason instanceof Error
          ? external.reason
          : new DOMException("The operation was aborted.", "AbortError")
      }
      continue
    }

    // Sticky or direct — single POST (races above already `continue`).
    let proxy: string | undefined
    if (selected) {
      proxyTried = true
      try {
        proxy = await proxyFor(selected)
      } catch (cause) {
        markFailure(selected)
        excluded.add(selected)
        failure = cause
        continue
      }
    }

    attempts++
    try {
      const remaining = Math.max(1_000, deadline - Date.now())
      debug("attempt", proxyTrace(selected), new URL(target).host)
      const response = await send(input, init, proxy, Math.min(ATTEMPT_TIMEOUT_MS, remaining))
      tried.push(`${selected ?? "direct"}=${response.status}`)
      debug("response", proxyTrace(selected), response.status)
      if (!shouldRotate(response.status)) {
        // Do not return until the first body byte arrives. Public proxies often
        // answer headers and then ECONNRESET; that must stay inside the hunt.
        const opened = await openStream(response, selected, external, Math.min(FIRST_BYTE_TIMEOUT_MS, remaining))
        if ("drop" in opened) {
          tried.push(`${selected ?? "direct"}=${networkDropLabel(opened.drop)}`)
          failure = opened.drop
          debug("first byte", proxyTrace(selected), opened.drop instanceof Error ? opened.drop.message : opened.drop)
          if (!selected) {
            directAttempts++
            directBlocked = true
          } else {
            markAttemptDrop(selected, opened.drop)
            excluded.add(selected)
          }
          continue
        }
        // Sticky is pinned when the body finishes (see openStream), not on first
        // byte — free exits often FIN cleanly mid-SSE and that used to keep a
        // dead sticky for the session retry.
        if (!selected) directBlockedUntil = 0
        return opened.response
      }

      // Never hand a quota/block status to the caller: that is what paints the
      // FreeLimitNotice. Discard the exit and keep hunting, or fail as rotation
      // exhausted once the body cannot be replayed.
      const body = await response.text().catch(() => "")
      if (!canRetry) {
        tried.push(`${selected ?? "direct"}=${response.status}/noreplay`)
        break
      }
      if (!selected) {
        directAttempts++
        directBlocked = true
        directBlockedUntil = Date.now() + DIRECT_BLOCK_MS
        continue
      }
      if (response.status === 402 || response.status === 429) {
        quotaHits++
        quotaTried.push(selected)
        markQuota(selected, response.status, dailyQuota(response.status, body))
      } else markFailure(selected)
      excluded.add(selected)
      if (quotaDry(quotaHits, excluded)) {
        if (await tryAdvancePool()) continue
        if (Number.isFinite(deadline) && Date.now() >= deadline) {
          debug("quota dry", quotaHits, "pickable", pickable(excluded).length)
          break
        }
        continue
      }
      if (Number.isFinite(deadline) && Date.now() > deadline) break
    } catch (cause) {
      const label = networkDropLabel(cause)
      tried.push(`${selected ?? "direct"}=${label}`)
      failure = cause
      debug("error", proxyTrace(selected), cause instanceof Error ? cause.message : cause)
      // A hang waiting for headers is the worst case: the AI layer reports
      // ProviderHeaderTimeoutError, the chat freezes on that message, and a silent
      // session retry reuses the same sticky exit. Burn the exit before rethrowing
      // an outer abort so the next attempt hunts a replacement.
      if (!selected) {
        directAttempts++
        directBlocked = true
      } else {
        markAttemptDrop(selected, cause)
        excluded.add(selected)
      }
      // Only a real caller abort may escape. ECONNRESET / proxy drops must keep
      // rotating — rethrowing them is what paints "Retry due · ECONNRESET" with no
      // useful hunt.
      if (external?.aborted && isAbortError(cause)) throw cause
      if (Date.now() > deadline) break
    }
  }

  const summary = (() => {
    if (tried.length === 0) return ""
    if (tried.length <= EXHAUST_DETAIL_MAX) return tried.join(" ")
    const head = tried.slice(0, EXHAUST_DETAIL_MAX).join(" ")
    return `${head} …+${tried.length - EXHAUST_DETAIL_MAX} more`
  })()
  console.error(`[proxy-rotator] rotation exhausted: ${tried.join(" ") || "no attempt"}`)
  throw new Error(
    `Proxy rotation exhausted for ${new URL(target).host}: no exit returned a usable response${
      summary ? ` (${summary})` : ""
    }`,
    { cause: failure },
  )
}

const isAbortError = (cause: unknown) => {
  if (!cause || typeof cause !== "object") return false
  const name = "name" in cause && typeof cause.name === "string" ? cause.name : ""
  const message = "message" in cause && typeof cause.message === "string" ? cause.message : ""
  return name === "AbortError" || /operation was aborted|aborted without reason/i.test(message)
}

const networkDropLabel = (cause: unknown) => {
  const text = cause instanceof Error ? `${cause.message} ${String(cause.cause ?? "")}` : String(cause)
  if (/ECONNRESET/i.test(text)) return "ECONNRESET"
  if (/ECONNREFUSED/i.test(text)) return "ECONNREFUSED"
  if (/EHOSTUNREACH|ENETUNREACH/i.test(text)) return "unreachable"
  if (/EPROTO|TLS handshake|speak TLS/i.test(text)) return "EPROTO"
  if (/EPIPE|other side closed|socket connection was closed/i.test(text)) return "closed"
  if (/timeout|aborted/i.test(text)) return "timeout"
  return "error"
}

// Connect-time deaths must leave the pool. EPROTO used to map to soft "error" and
// stay pickable — then a sticky/mid-stream hit painted "Retry due · EPROTO".
const markAttemptDrop = (proxy: string, cause: unknown) => {
  const label = networkDropLabel(cause)
  if (
    label === "ECONNREFUSED" ||
    label === "closed" ||
    label === "ECONNRESET" ||
    label === "EPROTO" ||
    label === "unreachable"
  )
    markDead(proxy)
  else markFailure(proxy)
}

// OpenAI-compatible SSE ends with a non-null finish_reason and/or data: [DONE].
// A clean TCP FIN mid-response is `done` without those markers — that is the
// "stream ended without finish_reason" chat retry, not an ECONNRESET.
const SSE_TERMINAL = /\[DONE\]|"finish_reason"\s*:\s*"(?!null\b)[^"]+"/

// Hold the response inside the hunt until the body looks real. Free exits often
// answer headers (or one byte) and then ECONNRESET — returning at first byte is
// what painted "Retry due · ECONNRESET" after a sticky that had already "worked".
const openStream = async (
  response: Response,
  proxy: string | undefined,
  signal: AbortSignal | undefined,
  budgetMs: number,
): Promise<{ response: Response } | { drop: unknown }> => {
  if (!response.body) {
    if (proxy) markSuccess(proxy)
    return { response }
  }
  const reader = response.body.getReader()
  const timeout = AbortSignal.timeout(Math.max(500, budgetMs))
  const onAbort = () => {
    void reader.cancel("aborted").catch(() => {})
  }
  signal?.addEventListener("abort", onAbort)
  timeout.addEventListener("abort", onAbort)
  try {
    const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true
    const decoder = new TextDecoder()
    const chunks: Uint8Array[] = []
    let text = ""
    let pending = ""
    let sawTerminal = false
    const note = (chunk: Uint8Array) => {
      if (!sse || sawTerminal) return
      pending = (pending + decoder.decode(chunk, { stream: true })).slice(-256)
      if (SSE_TERMINAL.test(pending)) sawTerminal = true
    }
    // SSE: wait for one event boundary (`\n\n`). Plain body: wait for any bytes.
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
      note(next.value)
      text += decoder.decode(next.value, { stream: true })
      if (!sse) break
      if (text.includes("\n\n") || sawTerminal) break
    }
    if (chunks.length === 0) {
      if (proxy) markSuccess(proxy)
      return {
        response: new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      }
    }
    const finish = (ok: boolean) => {
      if (!proxy) return
      if (ok) markSuccess(proxy)
      else {
        debug("stream incomplete", proxyTrace(proxy), sse ? "sse" : "body")
        markDead(proxy)
      }
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
      },
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            if (sse) decoder.decode()
            finish(!sse || sawTerminal)
            controller.close()
            return
          }
          note(next.value)
          controller.enqueue(next.value)
        } catch (cause) {
          debug("stream drop", proxyTrace(proxy), cause instanceof Error ? cause.message : cause)
          if (proxy) markDead(proxy)
          controller.error(cause)
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
    return {
      response: new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    }
  } catch (cause) {
    await reader.cancel().catch(() => {})
    return { drop: cause }
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

export const status = () => ({
  active,
  proxies: usable().map((entry) => entry.proxy),
  yields: Object.fromEntries(yields),
  purged: [...purgedSources],
  subnets: Object.fromEntries([...subnetBlocks].filter(([, until]) => until > Date.now())),
})

// Drop the sticky exit after a transport-level header timeout so a session retry
// does not dial the same hung proxy again.
export const invalidateActive = () => {
  if (!active) return
  markDead(active)
}

// Tests share one process-wide rotator; clear in-memory pool state between cases.
export const reset = () => {
  entries = []
  active = undefined
  directBlockedUntil = 0
  starting = undefined
  lastRefresh = 0
  loading = undefined
  forceDiscover = false
  candidateBag = []
  sourceHints.clear()
  failures.clear()
  subnetBlocks.clear()
  yields.clear()
  sourceCooldown.clear()
  purgedSources.clear()
  for (const source of HARD_PURGED_SOURCES) purgedSources.add(source)
}
