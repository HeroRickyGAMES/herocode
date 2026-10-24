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
}

const POOL_TARGET = 256
const POOL_CACHE_LIMIT = 4096
const POOL_FRESH_MS = 60 * 60_000
const REFRESH_MS = 4 * 60_000
const VALIDATE_TIMEOUT_MS = 8_000
const VALIDATE_CONCURRENCY = 96
const MAX_CANDIDATES = 2500
// Public lists grow to megabytes. Reading a prefix keeps discovery usable on a
// slow link, and the candidate cache stops a refresh from downloading them again.
const SOURCE_MAX_BYTES = 512 * 1024
const CANDIDATE_CACHE_MS = 30 * 60_000
const CANDIDATE_CACHE_LIMIT = 20_000
const ATTEMPT_TIMEOUT_MS = 10_000
const ROTATION_BUDGET_MS = 30_000
const MAX_ATTEMPTS = 7
const FAILURES_BEFORE_BLOCK = 2
const BLOCK_MS = 10 * 60_000
// A proxy that already spent the daily free quota stays useless for hours, so it
// leaves the pool instead of wasting an attempt on every request.
const QUOTA_BLOCK_MS = 6 * 60 * 60_000
const THROTTLE_BLOCK_MS = 60 * 60_000
// Validate against the endpoint that actually matters: a proxy that cannot reach
// OpenCode is not compatible with the model traffic it will carry.
const DEFAULT_VALIDATION_URL = "https://opencode.ai/"

// OpenCode Zen reports an exhausted free quota as 402 as well as 429, so both rotate.
const ROTATE_STATUS = new Set([402, 407, 408, 425, 429, 529])

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
let starting: Promise<void> | undefined
let lastRefresh = 0
const failures = new Map<string, { count: number; blockedUntil: number }>()

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
      return text ? parseSource(source, text) : []
    }),
  )
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
}

const add = (proxy: string, checkedAt: number) => {
  const existing = entries.find((entry) => entry.proxy === proxy)
  if (existing) {
    existing.checkedAt = Math.max(existing.checkedAt, checkedAt)
    return
  }
  entries.push({ proxy, checkedAt })
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

const markFailure = (proxy: string) => {
  if (active === proxy) active = undefined
  const state = failures.get(proxy) ?? { count: 0, blockedUntil: 0 }
  state.count++
  if (state.count >= FAILURES_BEFORE_BLOCK) state.blockedUntil = Date.now() + BLOCK_MS
  failures.set(proxy, state)
  debug("failed", proxy)
  void saveCache()
}

const markQuota = (proxy: string, status: number) => {
  if (active === proxy) active = undefined
  const state = failures.get(proxy) ?? { count: 0, blockedUntil: 0 }
  state.count = FAILURES_BEFORE_BLOCK
  state.blockedUntil = Math.max(state.blockedUntil, Date.now() + (status === 402 ? QUOTA_BLOCK_MS : THROTTLE_BLOCK_MS))
  failures.set(proxy, state)
  debug("quota", proxy, status)
  void saveCache()
  // A burned proxy shrinks the pool, so look for replacements in the background.
  if (usable().length < POOL_TARGET / 2) {
    lastRefresh = 0
    warm()
  }
}

const markSuccess = (proxy: string) => {
  active = proxy
  failures.delete(proxy)
  const entry = entries.find((item) => item.proxy === proxy)
  if (entry) entry.checkedAt = Date.now()
  debug("using", proxy)
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
    return response.ok
  } catch {
    return false
  }
}

const validateMany = async (candidates: string[], stop: () => boolean) => {
  let index = 0
  await Promise.all(
    Array.from({ length: VALIDATE_CONCURRENCY }, async () => {
      while (!stop() && index < candidates.length) {
        const proxy = candidates[index++]
        if (await validate(proxy)) {
          add(proxy, Date.now())
          debug("validated", proxy)
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
    const proxies = data.proxies.flatMap((value) => {
      if (typeof value !== "string") return []
      const proxy = normalize(value)
      return proxy ? [proxy] : []
    })
    return { savedAt: data.savedAt, proxies }
  } catch {}
}

const saveCandidates = async (proxies: string[]) => {
  const path = candidatePath()
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await Bun.write(path, JSON.stringify({ savedAt: Date.now(), proxies: proxies.slice(0, CANDIDATE_CACHE_LIMIT) }))
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
      if (!proxy) continue
      add(proxy, checkedAt)
      // Burned proxies stay cached so a later run skips them instead of retrying.
      if (blockedUntil > Date.now())
        failures.set(proxy, { count: FAILURES_BEFORE_BLOCK, blockedUntil })
    }
  } catch {}
}

const saveCache = async () => {
  const path = cachePath()
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const data = JSON.stringify({
      version: 1,
      entries: entries
        .toSorted((left, right) => left.checkedAt - right.checkedAt)
        .slice(-POOL_CACHE_LIMIT)
        .map((entry) => ({
          proxy: entry.proxy,
          checkedAt: entry.checkedAt,
          blockedUntil: failures.get(entry.proxy)?.blockedUntil ?? 0,
        })),
    })
    await Bun.write(path, data)
    await chmod(path, 0o600)
  } catch (cause) {
    debug("cache write failed", cause)
  }
}

const refresh = async () => {
  await readCache()
  const now = Date.now()
  const fresh = entries.filter((entry) => now - entry.checkedAt < POOL_FRESH_MS)
  const stale = entries.filter((entry) => now - entry.checkedAt >= POOL_FRESH_MS).map((entry) => entry.proxy)
  const known = new Set(fresh.map((entry) => entry.proxy))
  const cached = await readCandidates()
  const reuse = process.env.OPENCODE_PROXY_ONLY !== "1" && cached && now - cached.savedAt < CANDIDATE_CACHE_MS
  const discovered = reuse ? cached.proxies : process.env.OPENCODE_PROXY_ONLY === "1" ? [] : await discover()
  if (!reuse && discovered.length > 0) void saveCandidates(discovered)
  const candidates = shuffle(
    [...stale, ...(await seeded()), ...discovered].filter((proxy) => {
      if (known.has(proxy)) return false
      known.add(proxy)
      return true
    }),
  ).slice(0, MAX_CANDIDATES)

  await validateMany([...fresh.map((entry) => entry.proxy), ...candidates], () => usable().length >= POOL_TARGET)
  await saveCache()
  debug("pool", usable().length)
}

export const warm = () => {
  if (process.env.OPENCODE_PROXY_DISABLE === "1") return
  const now = Date.now()
  if (starting || now - lastRefresh < REFRESH_MS) return
  lastRefresh = now
  starting = refresh()
    .catch((cause) => debug("refresh failed", cause))
    .finally(() => {
      starting = undefined
    })
}

const pick = (exclude: Set<string>) => {
  const fresh = usable().filter((entry) => !exclude.has(entry.proxy))
  // A stale entry only lost its freshness stamp, so it is still worth an attempt
  // instead of waiting for a revalidation that the slow network delays.
  const list = fresh.length > 0 ? fresh : entries.filter((entry) => !blocked(entry.proxy) && !exclude.has(entry.proxy))
  if (list.length === 0) return
  return list[Math.floor(Math.random() * list.length)].proxy
}

const waitForProxy = async (timeout: number, exclude: Set<string>) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const proxy = pick(exclude)
    if (proxy) return proxy
    await Bun.sleep(100)
  }
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

const send = (
  input: FetchInput,
  init: FetchInit | undefined,
  proxy: string | undefined,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
) => {
  // Clone even the direct attempt: the original stays unconsumed for a retry.
  const request: FetchInput = input instanceof Request ? (input.clone() as FetchInput) : input
  if (!proxy) return globalThis.fetch(request, init)
  const external = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const timeout = AbortSignal.timeout(timeoutMs)
  return globalThis.fetch(request, {
    ...init,
    proxy,
    signal: external ? AbortSignal.any([external, timeout]) : timeout,
  })
}

export const shouldRotate = (status: number) => ROTATE_STATUS.has(status)

export const fetch = async (input: FetchInput, init?: FetchInit): Promise<FetchResponse> => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!/^https?:/i.test(target) || process.env.OPENCODE_PROXY_DISABLE === "1" || local(target))
    return globalThis.fetch(input, init)

  const force = process.env.OPENCODE_PROXY_FORCE === "1"
  warm()
  if (force && !active) {
    for (const proxy of await seeded()) {
      if (!(await validate(proxy))) continue
      add(proxy, Date.now())
      active = proxy
      break
    }
  }
  const canRetry = replayable(input, init)
  const excluded = new Set<string>()
  const deadline = Date.now() + ROTATION_BUDGET_MS
  let directTried = false
  let proxyTried = false
  let fallback: FetchResponse | undefined
  let failure: unknown

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const selected = active ?? (!force && !directTried && !proxyTried ? undefined : pick(excluded))
    if (!selected && (force || directTried || proxyTried)) {
      // The pool validates in the background, so a limited request waits for the
      // first proxy instead of failing with the direct quota error.
      const proxy = await waitForProxy(Math.min(10_000, Math.max(0, deadline - Date.now())), excluded)
      if (!proxy) break
      continue
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

    try {
      const remaining = Math.max(1_000, deadline - Date.now())
      const response = await send(input, init, proxy, Math.min(ATTEMPT_TIMEOUT_MS, remaining))
      debug("response", proxy ?? "direct", response.status)
      if (!shouldRotate(response.status)) {
        if (selected) markSuccess(selected)
        return response
      }

      if (!canRetry) return response
      fallback ??= response.clone() as FetchResponse
      await response.body?.cancel()

      if (!selected) {
        directTried = true
        continue
      }
      if (response.status === 402 || response.status === 429) markQuota(selected, response.status)
      else markFailure(selected)
      excluded.add(selected)
      if (Date.now() > deadline) break
    } catch (cause) {
      if (init?.signal?.aborted) throw cause
      failure = cause
      if (!selected) throw cause
      markFailure(selected)
      excluded.add(selected)
      if (Date.now() > deadline) break
    }
  }

  if (fallback) return fallback
  if (failure) throw failure
  return globalThis.fetch(input, init)
}

export const status = () => ({
  active,
  proxies: usable().map((entry) => entry.proxy),
})
