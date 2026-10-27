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
const POOL_FRESH_MS = 60 * 60_000
const REFRESH_MS = 4 * 60_000
const VALIDATE_TIMEOUT_MS = 6_000
// Validation shares the network with the request that triggered it, so a wide
// fan-out starves the real attempt and turns a fast quota error into a timeout.
const VALIDATE_CONCURRENCY = 24
const MAX_CANDIDATES = 2500
// Public lists grow to megabytes. Reading a prefix keeps discovery usable on a
// slow link, and the candidate cache stops a refresh from downloading them again.
const SOURCE_MAX_BYTES = 512 * 1024
const CANDIDATE_CACHE_MS = 30 * 60_000
const CANDIDATE_CACHE_LIMIT = 20_000
const ATTEMPT_TIMEOUT_MS = 10_000
// Headers can succeed while the upstream resets before the first SSE byte. Wait
// for that byte inside the hunt so ECONNRESET rotates silently instead of
// painting "Retry due · ECONNRESET" on the chat.
const FIRST_BYTE_TIMEOUT_MS = 8_000
// Public exits mostly die between discovery and use, so a serial hunt spends the
// whole budget dialing addresses that never opened a tunnel. Probe a batch in
// parallel with a cheap request and only pay a real attempt for survivors.
const PROBE_CONCURRENCY = 12
const PROBE_TIMEOUT_MS = 6_000
// The AI transport's default headerTimeout is 5 minutes. Finish the hunt before
// that fires so a dry pool surfaces as rotation exhausted instead of a frozen
// "Timed out waiting for response headers" that the session then retries forever
// on the same sticky exit.
const DEFAULT_ROTATION_BUDGET_MS = 3 * 60_000
const MAX_ATTEMPTS = 200
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
const THROTTLE_BLOCK_MS = 15 * 60_000
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

const SOURCES: ReadonlyArray<Source> = [
  // Mirrored GitHub lists, one `host:port` per line.
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/https.txt", fallback: "https" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt", fallback: "http" },
  {
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt",
    fallback: "https",
  },
  {
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt",
    fallback: "socks4",
  },
  {
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
    fallback: "socks5",
  },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt", fallback: "https" },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/HTTP.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/SOCKS5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt", fallback: "http" },
  { url: "https://api.openproxylist.xyz/http.txt", fallback: "http" },
  { url: "https://api.openproxylist.xyz/https.txt", fallback: "https" },
  { url: "https://api.openproxylist.xyz/socks4.txt", fallback: "socks4" },
  { url: "https://api.openproxylist.xyz/socks5.txt", fallback: "socks5" },
  { url: "https://proxyspace.pro/http.txt", fallback: "http" },
  { url: "https://proxyspace.pro/https.txt", fallback: "https" },
  { url: "https://proxyspace.pro/socks5.txt", fallback: "socks5" },
  // Sources that publish their own hourly verification and a per-protocol file.
  { url: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/https.txt", fallback: "https" },
  { url: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/all.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks4.txt", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/saisuiu/Lionkings-Http-Proxys-Proxies/main/cnfree.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt", kind: "hideip", fallback: "https" },
  { url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt", kind: "hideip", fallback: "http" },
  { url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks4.txt", kind: "hideip", fallback: "socks4" },
  { url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt", kind: "hideip", fallback: "socks5" },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text",
    fallback: "http",
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=https&proxy_format=ipport&format=text",
    fallback: "https",
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks4&proxy_format=ipport&format=text",
    fallback: "socks4",
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text",
    fallback: "socks5",
  },
  { url: "https://advanced.name/freeproxy?type=http", kind: "advanced", fallback: "http" },
  { url: "https://advanced.name/freeproxy?type=https", kind: "advanced", fallback: "https" },
  { url: "https://advanced.name/freeproxy?type=socks4", kind: "advanced", fallback: "socks4" },
  { url: "https://advanced.name/freeproxy?type=socks5", kind: "advanced", fallback: "socks5" },
  ...["http,https", "socks4", "socks5"].flatMap((protocols) =>
    [1, 2, 3].map((page) => ({
      url: `https://proxylist.geonode.com/api/proxy-list?limit=500&page=${page}&sort_by=lastChecked&sort_type=desc&protocols=${protocols}`,
      kind: "geonode" as const,
    })),
  ),
]

let entries: Entry[] = []
let active: string | undefined
let directBlockedUntil = 0
let starting: Promise<void> | undefined
let lastRefresh = 0
// The cached pool is the only warm state a fresh standalone process has, so every
// read path waits for it instead of racing the background refresh.
let loading: Promise<void> | undefined
const failures = new Map<string, { count: number; blockedUntil: number }>()
// Per-list outcome counts. Host-only labels collapsed every GitHub mirror into one
// bucket, so bad lists could not be skipped — keep path (+ protocol query) instead.
const yields = new Map<string, { ok: number; bad: number }>()
// After a quota-burned generation, refresh must download new lists instead of
// recycling the same candidate dump that just returned 429 for every exit.
let forceDiscover = false
// Cap how many times one request can throw away the pool and refill — each
// advance spends discovery+validate time inside the rotation budget.
const MAX_POOL_ADVANCES = 4

export const sourceLabel = (url: string) => {
  const parsed = new URL(url)
  const protocol = parsed.searchParams.get("protocol") ?? parsed.searchParams.get("type")
  const path = parsed.pathname.replace(/\/+$/, "")
  return protocol ? `${parsed.host}${path}?${protocol}` : `${parsed.host}${path}`
}

const debug = (...values: unknown[]) => {
  if (process.env.OPENCODE_PROXY_DEBUG) console.error("[proxy-rotator]", ...values)
}

const cachePath = () => {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(root, "opencode", "proxy-pool.json")
}

export const normalize = (value: string, fallback = "http"): string | undefined => {
  const raw = value.trim()
  if (!raw || raw.startsWith("#")) return
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (!explicitScheme && !/:\d{1,5}$/.test(raw)) return
  const withScheme = explicitScheme ? raw : `${fallback}://${raw}`
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
  const fallbackPort = url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : 1080
  const port = url.port ? Number(url.port) : fallbackPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) return
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : ""
  return `${url.protocol}//${auth}${url.host}${url.port ? "" : `:${port}`}`
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
      if (sourceSkipped(label)) {
        debug("skip source", label)
        return []
      }
      return text ? parseSource(source, text).map((proxy) => ({ proxy, source: label })) : []
    }),
  )
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
}

const add = (proxy: string, checkedAt: number, source?: string) => {
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
const sourceOf = (proxy: string) => entries.find((entry) => entry.proxy === proxy)?.source

const noteYield = (proxy: string, kind: "ok" | "bad") => {
  const source = sourceOf(proxy)
  // Host-only labels are legacy; counting them re-creates the toxic-GitHub bug.
  if (!source || !source.includes("/")) return
  const state = yields.get(source) ?? { ok: 0, bad: 0 }
  if (kind === "ok") state.ok++
  else state.bad++
  yields.set(source, state)
}

const sourceScore = (source: string | undefined) => {
  if (!source) return 0
  const state = yields.get(source)
  if (!state) return 0
  const total = state.ok + state.bad
  if (total === 0) return 0
  return (state.ok - state.bad) / total
}

// A list that almost only produces dead or quota exits is not worth probing again
// this process — discovery and pick skip it until the yield window is forgotten.
// Host-only labels (legacy `raw.githubusercontent.com`) must never go toxic: that
// single bucket used to ban every GitHub mirror at once and empty the pickable pool
// while usable() still looked full — the rotator then skipped direct and quit.
const sourceToxic = (source: string | undefined) => {
  if (!source || !source.includes("/")) return false
  const state = yields.get(source)
  if (!state) return false
  const total = state.ok + state.bad
  if (total < 8) return false
  return state.bad / total >= 0.85
}

// Temporary skip after a generation of pure 429s. Permanent force-toxic used to
// poison every GitHub list in the yield cache, leaving discover with nothing and
// the session retrying "rotation exhausted" forever on an empty pool.
const SOURCE_RETIRE_MS = 10 * 60_000
const sourceCooldown = new Map<string, number>()

const sourceCooling = (source: string | undefined) => {
  if (!source) return false
  const until = sourceCooldown.get(source)
  if (until === undefined) return false
  if (until > Date.now()) return true
  sourceCooldown.delete(source)
  return false
}

const sourceSkipped = (source: string | undefined) => sourceToxic(source) || sourceCooling(source)

// Soft-reset yield poison so discovery can refill when every list looks toxic.
const thawToxicYields = () => {
  let thawed = 0
  for (const [source, state] of yields) {
    if (!sourceToxic(source)) continue
    yields.set(source, {
      ok: Math.max(1, Math.floor(state.ok / 2)),
      bad: Math.min(3, Math.floor(state.bad / 4)),
    })
    thawed++
  }
  if (thawed > 0) {
    debug("thaw toxic yields", thawed)
    void saveCache()
  }
  return thawed
}

const liftOldestCooldowns = (fraction = 0.5) => {
  const cooling = [...sourceCooldown.entries()].filter(([, until]) => until > Date.now()).toSorted((a, b) => a[1] - b[1])
  const drop = Math.max(1, Math.ceil(cooling.length * fraction))
  for (const [source] of cooling.slice(0, drop)) sourceCooldown.delete(source)
  return drop
}

// Whole generation answered quota: burn sibling exits from the same lists, cool
// those sources briefly, drop the dead weight, and force a fresh discover.
const retireQuotaPool = (quotaProxies: ReadonlyArray<string>) => {
  active = undefined
  const sources = new Set<string>()
  for (const proxy of quotaProxies) {
    const source = sourceOf(proxy)
    if (source) sources.add(source)
  }
  for (const entry of entries) {
    if (!entry.source || !sources.has(entry.source)) continue
    if (!blocked(entry.proxy)) markQuota(entry.proxy, 429, false, true)
  }
  const until = Date.now() + SOURCE_RETIRE_MS
  for (const source of sources) sourceCooldown.set(source, until)
  entries = entries.filter((entry) => !blocked(entry.proxy) && !sourceSkipped(entry.source))
  forceDiscover = true
  lastRefresh = 0
  void saveCache()
  debug("retire pool", sources.size, "sources", [...sources].slice(0, 8))
}

const blocked = (proxy: string) => {
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
      !blocked(entry.proxy) &&
      !exclude.has(entry.proxy) &&
      !sourceSkipped(entry.source) &&
      Date.now() - entry.checkedAt < POOL_FRESH_MS,
  )

const markFailure = (proxy: string) => {
  if (active === proxy) active = undefined
  const state = failures.get(proxy) ?? { count: 0, blockedUntil: 0 }
  state.count++
  if (state.count >= FAILURES_BEFORE_BLOCK) {
    state.blockedUntil = Date.now() + BLOCK_MS
    noteYield(proxy, "bad")
  }
  failures.set(proxy, state)
  debug("failed", proxy, sourceOf(proxy) ?? "unknown")
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
  noteYield(proxy, "bad")
  debug("dead", proxy, sourceOf(proxy) ?? "unknown")
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
  noteYield(proxy, "bad")
  debug("quota", proxy, sourceOf(proxy) ?? "unknown", status, daily || status === 402 ? "daily" : "throttle", fromProbe ? "probe" : "POST")
  // Neighbours in the same /24 usually share the free-tier bucket — but only after
  // real POSTs. Probe 429s must not wipe the sticky that just answered a chat turn.
  const subnet = !fromProbe ? subnetOf(proxy) : undefined
  if (subnet) {
    const hit = entries.filter((entry) => subnetOf(entry.proxy) === subnet && blocked(entry.proxy)).length
    if (hit >= SUBNET_QUOTA_BEFORE_BLOCK) {
      let burned = 0
      for (const entry of entries) {
        if (subnetOf(entry.proxy) !== subnet || blocked(entry.proxy)) continue
        if (entry.proxy === active) continue
        const neighbour = failures.get(entry.proxy) ?? { count: 0, blockedUntil: 0 }
        neighbour.count = FAILURES_BEFORE_BLOCK
        neighbour.blockedUntil = Math.max(neighbour.blockedUntil, until)
        failures.set(entry.proxy, neighbour)
        burned++
      }
      if (burned > 0) debug("subnet quota", subnet, burned, status, "kept sticky", active ?? "none")
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
  debug("sticky", proxy, sourceOf(proxy) ?? "unknown")
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
        if (await validate(candidate.proxy)) {
          add(candidate.proxy, Date.now(), candidate.source)
          debug("validated", candidate.proxy, candidate.source ?? "unknown")
        }
        // A failed probe keeps the entry stale instead of deleting it: a slow or
        // filtered network must not throw away proxies that work later.
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
    if ("yields" in data && data.yields && typeof data.yields === "object") {
      for (const [source, value] of Object.entries(data.yields as Record<string, unknown>)) {
        // Drop host-only yield rows left by the old labeler — they poison every
        // GitHub list under one toxic key.
        if (!source.includes("/")) continue
        if (!value || typeof value !== "object") continue
        const ok = "ok" in value && typeof value.ok === "number" ? value.ok : 0
        const bad = "bad" in value && typeof value.bad === "number" ? value.bad : 0
        if (ok > 0 || bad > 0) yields.set(source, { ok, bad })
      }
    }
    // forceSourceToxic used to persist permanent bans across restarts. Thaw when
    // the live pool is too thin so the next refresh can use public lists again.
    if (usable().length < POOL_TARGET / 8) thawToxicYields()
  } catch {}
}

const saveCache = async () => {
  const path = cachePath()
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // Burned exits must stay in the cache with blockedUntil. Dropping them made
    // every restart rediscover the same dead addresses from the candidate list.
    const data = JSON.stringify({
      version: 1,
      active,
      yields: Object.fromEntries(yields),
      entries: entries
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

const load = () => (loading ??= readCache().catch(() => {}))

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
  const discoverNow = forceDiscover || dry
  forceDiscover = false
  // A yield cache poisoned by permanent force-toxic left discover skipping every
  // public list while usable stayed empty — thaw before asking the network again.
  if (discoverNow && dry) thawToxicYields()
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
  if (!reuse && discovered.length > 0) void saveCandidates(discovered)
  const candidates = [
    ...stale.map((entry) => ({ proxy: entry.proxy, source: entry.source })),
    ...(await seeded()).map((proxy) => ({ proxy, source: "env" as string | undefined })),
    ...discovered,
  ]
    .filter((candidate) => {
      // A previously burned exit is still in the candidate dump for hours; skip it
      // here so validation does not spend slots re-probing known-dead addresses.
      if (blocked(candidate.proxy) || known.has(candidate.proxy) || sourceSkipped(candidate.source)) return false
      known.add(candidate.proxy)
      return true
    })
    .toSorted((left, right) => sourceScore(right.source) - sourceScore(left.source))
    .slice(0, MAX_CANDIDATES)

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
  const list = pickable(exclude)
  if (list.length === 0) return []
  // Prefer exits from lists that still yield successes, then the newest half of
  // that set. Uniform picks across an hour-old pool mostly dial already-dead IPs.
  const ranked = list.toSorted((left, right) => {
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
  }
}

export const shouldRotate = (status: number) => ROTATE_STATUS.has(status)

// Soft ceiling on POST 402/429 in one hunt. Probe 429s do not count — a batch of
// dead probes used to hit 24 and quit while hundreds of untried exits remained.
const DEFAULT_QUOTA_LIMIT = 96
// After proxies already failed, keep hunting for a refill instead of quitting in
// a few seconds — users still prefer a longer wait over an instant exhausted error
// when public lists are slow to validate.
const EMPTY_POOL_WAIT_MS = 45_000
// Cold start / fully burned cache: the first request often lands before any exit
// has validated. Give discovery time to put at least one proxy in the pool instead
// of failing on `direct=429` alone.
const INITIAL_POOL_WAIT_MS = 90_000
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
const dailyQuota = (status: number, body: string) =>
  status === 402 || /freeusagelimiterror|usage limit|quota[-_\s]?exceeded/i.test(body)

export const fetch = async (input: FetchInput, init?: FetchInit): Promise<FetchResponse> => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!/^https?:/i.test(target) || process.env.OPENCODE_PROXY_DISABLE === "1" || local(target))
    return globalThis.fetch(input, init)

  const force = process.env.OPENCODE_PROXY_FORCE === "1"
  await load()
  // Prefer a warm pickable pool before hunting. usable() alone is not enough —
  // toxic legacy labels can leave usable high while pickMany returns nothing.
  if (pickable().length === 0) await awaitWarm(Math.min(20_000, INITIAL_POOL_WAIT_MS))
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
  debug("replayable", canRetry, "pool", usable().length, "pickable", pickable().length)
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
    if (poolAdvances >= MAX_POOL_ADVANCES) return false
    if (quotaTried.length === 0) return false
    poolAdvances++
    const burned = [...new Set(quotaTried)]
    quotaTried.length = 0
    retireQuotaPool(burned)
    quotaHits = 0
    emptySince = 0
    const warmMs = Math.min(20_000, Math.max(0, deadline - Date.now()))
    await awaitWarm(warmMs)
    if (pickable(excluded).length === 0) {
      // Every list still cooling or yield-toxic — lift some bans and discover again
      // instead of surfacing exhausted while candidates.json still has tens of thousands.
      thawToxicYields()
      liftOldestCooldowns(0.5)
      forceDiscover = true
      lastRefresh = 0
      await awaitWarm(warmMs)
    }
    debug("advanced pool", poolAdvances, "pickable", pickable(excluded).length)
    return pickable(excluded).length > 0
  }
  // The deadline bounds the hunt. This guard only stops a pathologically uniform
  // stream of real attempts from pinning a request forever.
  let attempts = 0
  while (Date.now() < deadline && attempts < MAX_ATTEMPTS) {
    // Keep the last exit that answered until it fails. Reusing a live proxy avoids
    // re-hunting a replacement on every single model call, while a rate-limited or
    // dead exit is discarded below and never selected again.
    // Sticky wins every time until THAT exit fails a real POST.
    const sticky =
      active && !excluded.has(active) && !blocked(active) && !sourceSkipped(sourceOf(active)) ? active : undefined
    if (sticky) debug("sticky try", sticky)
    // Skip direct only when something is actually pickable — not merely "usable".
    const direct =
      !force &&
      !proxyTried &&
      !sticky &&
      directAttempts === 0 &&
      !directBlocked &&
      pickable(excluded).length === 0
    let selected = direct ? undefined : sticky

    if (!direct && !selected) {
      const batch = pickMany(excluded, PROBE_CONCURRENCY)
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
        if (Date.now() - emptySince >= waitMs && tried.length > 0) {
          if (await tryAdvancePool()) continue
          debug("pool empty", quotaHits, tried.length, "pickable", pickable(excluded).length)
          break
        }
        if (Date.now() - emptySince >= waitMs && tried.length === 0 && directAttempts === 0) {
          // Force a direct attempt once so the error trace is not blank.
          directBlocked = false
          emptySince = 0
          continue
        }
        if (Date.now() - emptySince >= waitMs) {
          if (await tryAdvancePool()) continue
          debug("pool empty", quotaHits, tried.length, "pickable", pickable(excluded).length)
          break
        }
        await awaitWarm(Math.min(3_000, Math.max(0, deadline - Date.now())))
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await Bun.sleep(Math.min(250, remaining))
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
      const alive = probed.find((result) => result.status !== undefined && reachable(result.status))?.proxy
      // Prefer a probe-alive exit; otherwise POST through a probe-timeout candidate.
      // The first-byte gate decides if the tunnel is real.
      selected =
        alive ??
        probed.find((result) => result.status === undefined && !excluded.has(result.proxy))?.proxy
      debug("probe", batch.length, alive ? "alive" : selected ? "post-anyway" : "none", "quota", quotaHits)
      if (quotaDry(quotaHits, excluded) && attempts > 0) {
        if (await tryAdvancePool()) continue
        debug("quota dry", quotaHits, "pickable", pickable(excluded).length)
        break
      }
      if (!selected) {
        // Entire batch had hard probe failures (403/429/…). Soft-exclude timeouts
        // so the next pickMany can move on if nothing is left to POST.
        for (const result of probed) {
          if (result.status === undefined) excluded.add(result.proxy)
        }
        continue
      }
    }

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
      debug("attempt", selected ?? "direct", new URL(target).host)
      const response = await send(input, init, proxy, Math.min(ATTEMPT_TIMEOUT_MS, remaining))
      tried.push(`${selected ?? "direct"}=${response.status}`)
      debug("response", selected ?? "direct", response.status)
      if (!shouldRotate(response.status)) {
        // Do not return until the first body byte arrives. Public proxies often
        // answer headers and then ECONNRESET; that must stay inside the hunt.
        const opened = await openStream(response, selected, external, Math.min(FIRST_BYTE_TIMEOUT_MS, remaining))
        if ("drop" in opened) {
          tried.push(`${selected ?? "direct"}=${networkDropLabel(opened.drop)}`)
          failure = opened.drop
          debug("first byte", selected ?? "direct", opened.drop instanceof Error ? opened.drop.message : opened.drop)
          if (!selected) {
            directAttempts++
            directBlocked = true
          } else {
            markDead(selected)
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
        debug("quota dry", quotaHits, "pickable", pickable(excluded).length)
        break
      }
      if (Date.now() > deadline) break
    } catch (cause) {
      const label = networkDropLabel(cause)
      tried.push(`${selected ?? "direct"}=${label}`)
      failure = cause
      debug("error", selected ?? "direct", cause instanceof Error ? cause.message : cause)
      // A hang waiting for headers is the worst case: the AI layer reports
      // ProviderHeaderTimeoutError, the chat freezes on that message, and a silent
      // session retry reuses the same sticky exit. Burn the exit before rethrowing
      // an outer abort so the next attempt hunts a replacement.
      if (!selected) {
        directAttempts++
        directBlocked = true
      } else {
        markDead(selected)
        excluded.add(selected)
      }
      // Only a real caller abort may escape. ECONNRESET / proxy drops must keep
      // rotating — rethrowing them is what paints "Retry due · ECONNRESET" with no
      // useful hunt.
      if (external?.aborted && isAbortError(cause)) throw cause
      if (Date.now() > deadline) break
    }
  }

  const detail = tried.join(" ")
  console.error(`[proxy-rotator] rotation exhausted: ${detail || "no attempt"}`)
  throw new Error(
    `Proxy rotation exhausted for ${new URL(target).host}: no exit returned a usable response${
      detail ? ` (${detail})` : ""
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
  if (/EPIPE|other side closed|socket connection was closed/i.test(text)) return "closed"
  if (/timeout|aborted/i.test(text)) return "timeout"
  return "error"
}

// OpenAI-compatible SSE ends with a non-null finish_reason and/or data: [DONE].
// A clean TCP FIN mid-response is `done` without those markers — that is the
// "stream ended without finish_reason" chat retry, not an ECONNRESET.
const SSE_TERMINAL = /\[DONE\]|"finish_reason"\s*:\s*"(?!null\b)[^"]+"/

// Await the first body byte before returning to the AI layer. Pin sticky only
// when the body finishes cleanly (and, for SSE, with a terminal marker).
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
    const first = await reader.read()
    if (first.done) {
      if (proxy) markSuccess(proxy)
      return {
        response: new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      }
    }
    const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true
    const decoder = new TextDecoder()
    let pending = ""
    let sawTerminal = false
    const note = (chunk: Uint8Array) => {
      if (!sse || sawTerminal) return
      pending = (pending + decoder.decode(chunk, { stream: true })).slice(-256)
      if (SSE_TERMINAL.test(pending)) sawTerminal = true
    }
    note(first.value)
    const finish = (ok: boolean) => {
      if (!proxy) return
      if (ok) markSuccess(proxy)
      else {
        debug("stream incomplete", proxy, sse ? "sse" : "body")
        markDead(proxy)
      }
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first.value)
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
          debug("stream drop", proxy ?? "direct", cause instanceof Error ? cause.message : cause)
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
  failures.clear()
  yields.clear()
  sourceCooldown.clear()
}
