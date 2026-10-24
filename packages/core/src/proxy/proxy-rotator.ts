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

const POOL_TARGET = 16
const POOL_CACHE_LIMIT = 64
const POOL_FRESH_MS = 15 * 60_000
const REFRESH_MS = 4 * 60_000
const VALIDATE_TIMEOUT_MS = 6_000
const VALIDATE_CONCURRENCY = 24
const MAX_CANDIDATES = 240
const ATTEMPT_TIMEOUT_MS = 20_000
const ROTATION_BUDGET_MS = 60_000
const MAX_ATTEMPTS = 7
const FAILURES_BEFORE_BLOCK = 2
const BLOCK_MS = 10 * 60_000
const DEFAULT_VALIDATION_URL = "https://api.ipify.org"

const ROTATE_STATUS = new Set([407, 408, 425, 429, 529])

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

const SOURCES: ReadonlyArray<{ url: string; fallback: string }> = [
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/http/data.txt", fallback: "http" },
  {
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/socks5/data.txt",
    fallback: "socks5",
  },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt", fallback: "socks5" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt", fallback: "http" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt", fallback: "socks5" },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text",
    fallback: "http",
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text",
    fallback: "socks5",
  },
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
  if (!url || !url.hostname) return
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
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

const seeded = () => {
  const values = `${process.env.OPENCODE_PROXY ?? ""}\n${process.env.OPENCODE_PROXY_LIST ?? ""}`
  return parseProxyLines(values, "http")
}

const fetchText = async (url: string) => {
  const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    await response.body?.cancel()
    return
  }
  return response.text()
}

const discover = async () => {
  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const text = await fetchText(source.url)
      return text ? parseProxyLines(text, source.fallback) : []
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
}

const remove = (proxy: string) => {
  if (proxy === active) return
  entries = entries.filter((entry) => entry.proxy !== proxy)
  SocksBridge.release(proxy)
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
  if (url.protocol === "socks5:" || url.protocol === "socks5h:") return SocksBridge.httpProxy(proxy)
  return proxy
}

const validate = async (proxy: string) => {
  try {
    const response = await globalThis.fetch(process.env.OPENCODE_PROXY_VALIDATE_URL || DEFAULT_VALIDATION_URL, {
      proxy: await proxyFor(proxy),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return false
    }
    const text = (await response.text()).trim()
    return /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)$/i.test(text)
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
        } else {
          remove(proxy)
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

const readCache = async () => {
  try {
    const text = await Bun.file(cachePath()).text()
    const data: unknown = JSON.parse(text)
    if (!data || typeof data !== "object" || !("entries" in data) || !Array.isArray(data.entries)) return
    for (const value of data.entries) {
      if (!value || typeof value !== "object") continue
      const proxy = "proxy" in value && typeof value.proxy === "string" ? normalize(value.proxy) : undefined
      const checkedAt = "checkedAt" in value && typeof value.checkedAt === "number" ? value.checkedAt : 0
      if (proxy) add(proxy, checkedAt)
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
        .map((entry) => ({ proxy: entry.proxy, checkedAt: entry.checkedAt })),
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
  const discovered = process.env.OPENCODE_PROXY_ONLY === "1" ? [] : await discover()
  const candidates = shuffle(
    [...stale, ...seeded(), ...discovered].filter((proxy) => {
      if (known.has(proxy)) return false
      known.add(proxy)
      return true
    }),
  ).slice(0, MAX_CANDIDATES)

  await validateMany([...fresh.map((entry) => entry.proxy), ...candidates], () => usable().length >= POOL_TARGET)
  entries = entries.filter((entry) => !blocked(entry.proxy))
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
  const list = usable().filter((entry) => !exclude.has(entry.proxy))
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
    for (const proxy of seeded()) {
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
      markFailure(selected)
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
