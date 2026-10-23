import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ProxyRotator } from "../../src/provider/proxy-rotator"

const proxy = (n: number) => `http://10.0.0.${n}:8080`
const validateCachedTestProxies = async (url: string) => /^http:\/\/10\.0\.0\.\d+:8080$/.test(url)

describe("provider.ProxyRotator.shouldRotate", () => {
  test("rotates only on proxy-relevant statuses", () => {
    expect(ProxyRotator.shouldRotate(200)).toBe(false)
    expect(ProxyRotator.shouldRotate(301)).toBe(false)
    expect(ProxyRotator.shouldRotate(400)).toBe(false)
    expect(ProxyRotator.shouldRotate(401)).toBe(false)
    expect(ProxyRotator.shouldRotate(403)).toBe(false)
    expect(ProxyRotator.shouldRotate(404)).toBe(false)
    expect(ProxyRotator.shouldRotate(407)).toBe(true)
    expect(ProxyRotator.shouldRotate(429)).toBe(true)
    expect(ProxyRotator.shouldRotate(500)).toBe(true)
    expect(ProxyRotator.shouldRotate(503)).toBe(true)
    expect(ProxyRotator.shouldRotate(504)).toBe(true)
    expect(ProxyRotator.shouldRotate(529)).toBe(true)
  })
})

describe("provider.ProxyRotator.isConnectionFailure", () => {
  test("recognizes Bun abort/timeout errors as connection failures", () => {
    expect(ProxyRotator.isConnectionFailure(new Error("The operation timed out."))).toBe(true)
    expect(ProxyRotator.isConnectionFailure(new Error("The operation was aborted."))).toBe(true)
    expect(ProxyRotator.isConnectionFailure(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true)
    expect(ProxyRotator.isConnectionFailure(new Error("Cannot connect to API: Unable to connect"))).toBe(true)
    expect(ProxyRotator.isConnectionFailure(new Error("some unrelated thing broke"))).toBe(false)
  })
})

describe("provider.ProxyRotator.withRetry", () => {
  test("rotates across proxies on 503/500 and succeeds through a fresh one", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1), proxy(2), proxy(3)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      const status = seen.length === 1 ? 503 : seen.length === 2 ? 500 : 200
      return { status, response: new Response(null, { status }) }
    }

    const { status } = await rotator.withRetry(send)
    expect(status).toBe(200)
    expect(seen).toStrictEqual([undefined, proxy(1), proxy(2)])
  })

  test("returns provider client errors without rotating", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1), proxy(2)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      return { status: 401, response: new Response(null, { status: 401 }) }
    }

    const { status } = await rotator.withRetry(send)
    expect(status).toBe(401)
    expect(seen).toStrictEqual([undefined])
  })

  test("returns a successful response without retrying", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
    })
    const send = async () => ({ status: 200, response: new Response(null, { status: 200 }) })
    const { status } = await rotator.withRetry(send)
    expect(status).toBe(200)
  })

  test("tries each proxy at most once and then gives up", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      maxAttempts: 4,
      search: async () => [proxy(1), proxy(2), proxy(3)],
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1), proxy(2), proxy(3)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const error = new Error("Cannot connect to API: Unable to connect to the provider")
    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      throw error
    }

    await expect(rotator.withRetry(send)).rejects.toBe(error)
    expect(seen).toStrictEqual([undefined, proxy(1), proxy(2), proxy(3)])
  })

  test("honors a finite attempt budget", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      maxAttempts: 2,
      search: async () => [proxy(1), proxy(2)],
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1), proxy(2)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const error = new Error("Cannot connect to API: Unable to connect to the provider")
    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      throw error
    }

    await expect(rotator.withRetry(send)).rejects.toBe(error)
    expect(seen).toStrictEqual([undefined, proxy(1)])
  })

  test("replaces a dead proxy with a fresh one on a later request", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      maxAttempts: 2,
      search: async () => [proxy(2)],
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const error = new Error("Cannot connect to API: Unable to connect to the provider")
    const firstSeen: Array<string | undefined> = []
    const failSend = async (p: string | undefined) => {
      firstSeen.push(p)
      throw error
    }
    await expect(rotator.withRetry(failSend)).rejects.toBe(error)
    expect(firstSeen).toStrictEqual([undefined, proxy(1)])

    // The dead proxy is now parked, so a later request must not start by
    // retrying it; it should use a freshly discovered proxy instead.
    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      if (!p) throw error
      return { status: 200, response: new Response(null, { status: 200 }) }
    }
    const { status } = await rotator.withRetry(send)
    expect(status).toBe(200)
    expect(seen).toStrictEqual([undefined, proxy(2)])
  })

  test("abandons a hung proxy once the request timeout fires and rotates", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      requestTimeoutMs: 50,
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1), proxy(2)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined, signal?: AbortSignal) => {
      seen.push(p)
      if (p === undefined) return { status: 500, response: new Response(null, { status: 500 }) }
      if (p === proxy(1)) {
        // Simulate a proxy that accepts the connection but never responds.
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"))
          })
        })
      }
      return { status: 200, response: new Response(null, { status: 200 }) }
    }

    const { status } = await rotator.withRetry(send)
    expect(status).toBe(200)
    expect(seen).toStrictEqual([undefined, proxy(1), proxy(2)])
  })

  test("rescans for fresh proxies after the cached pool is exhausted", async () => {
    await using tmp = await tmpdir()
    let searches = 0
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      maxAttempts: 3,
      // Proxy (1) is in the cache; once it is used, the rescan finds proxy (2)
      // so the request keeps moving instead of reusing proxy (1).
      search: async () => {
        searches++
        return [proxy(2)]
      },
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      return { status: 503, response: new Response(null, { status: 503 }) }
    }

    const { status } = await rotator.withRetry(send)
    expect(status).toBe(503)
    expect(seen).toStrictEqual([undefined, proxy(1), proxy(2)])
    expect(searches).toBe(1)
  })

  test("gives up when the total rotation budget is exhausted", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      maxAttempts: 100,
      maxRotationMs: 500,
      search: async () => [proxy(1), proxy(2), proxy(3), proxy(4), proxy(5)],
      validate: validateCachedTestProxies,
    })
    const cache = [proxy(1), proxy(2), proxy(3), proxy(4), proxy(5)]
      .map((url) => `${Date.now()}|${url}`)
      .join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      await Bun.sleep(30)
      return { status: 503, response: new Response(null, { status: 503 }) }
    }

    const { status } = await rotator.withRetry(send)
    expect(status).toBe(503)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.length).toBeLessThan(10)
  })

  test("keepFresh keeps searching in the background while the pool is empty", async () => {
    await using tmp = await tmpdir()
    let searches = 0
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "keep-fresh",
      cacheDir: tmp.path,
      refreshIntervalMs: 20,
      // Empty results never get cached, so every background tick retries.
      search: async () => {
        searches++
        return []
      },
    })
    rotator.keepFresh()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (searches >= 3) break
      await new Promise((r) => setTimeout(r, 10))
    }
    rotator.stop()
    const after = searches
    await new Promise((r) => setTimeout(r, 80))
    // stop() must halt the loop.
    expect(searches).toBe(after)
    expect(after).toBeGreaterThanOrEqual(3)
  })
})
describe("provider.ProxyRotator TLS failures", () => {
  test("rotates on certificate verification errors", () => {
    const error = new Error("unable to verify the first certificate")
    expect(ProxyRotator.isConnectionFailure(error)).toBe(true)
    expect(ProxyRotator.isTlsFailure(error)).toBe(true)
  })

  test("does not classify unrelated errors as TLS failures", () => {
    expect(ProxyRotator.isTlsFailure(new Error("Cannot connect to API: Unable to connect"))).toBe(false)
  })
})

describe("provider.ProxyRotator preflight", () => {
  test("drops a stale dead cached proxy before a request uses it", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "preflight",
      cacheDir: tmp.path,
      maxAttempts: 2,
      preflightTrustMs: 0,
      validate: async (url) => url === proxy(2),
      search: async () => [proxy(2)],
    })
    const stale = Date.now()
    await Bun.write(`${tmp.path}/working.txt`, `${stale}|${proxy(1)}\n${stale}|${proxy(2)}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      if (p === undefined) return { status: 503, response: new Response(null, { status: 503 }) }
      return { status: 200, response: new Response(null, { status: 200 }) }
    }

    const { status } = await rotator.withRetry(send)
    expect(status).toBe(200)
    expect(seen).toStrictEqual([undefined, proxy(2)])
  })

  test("preflights every discovery cache entry even when it was validated seconds ago", async () => {
    await using tmp = await tmpdir()
    const checked: string[] = []
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "preflight-discovery",
      cacheDir: tmp.path,
      maxAttempts: 2,
      validate: async (url) => {
        checked.push(url)
        return url === proxy(1)
      },
    })
    await Bun.write(`${tmp.path}/working.txt`, `${Date.now()}|${proxy(1)}\n`)

    const send = async (p: string | undefined) => {
      if (p === undefined) return { status: 503, response: new Response(null, { status: 503 }) }
      return { status: 200, response: new Response(null, { status: 200 }) }
    }

    expect((await rotator.withRetry(send)).status).toBe(200)
    expect(checked).toContain(proxy(1))
  })
})

describe("provider.ProxyRotator stickiness", () => {
  test("reuses the working proxy on the next request", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "sticky",
      cacheDir: tmp.path,
      validate: validateCachedTestProxies,
    })
    await Bun.write(`${tmp.path}/working.txt`, `${Date.now()}|${proxy(1)}\n`)

    const first: Array<string | undefined> = []
    const firstSend = async (p: string | undefined) => {
      first.push(p)
      const status = p ? 200 : 503
      return { status, response: new Response(null, { status }) }
    }
    expect((await rotator.withRetry(firstSend)).status).toBe(200)
    expect(first).toStrictEqual([undefined, proxy(1)])

    const second: Array<string | undefined> = []
    const secondSend = async (p: string | undefined) => {
      second.push(p)
      return { status: 200, response: new Response(null, { status: 200 }) }
    }
    expect((await rotator.withRetry(secondSend)).status).toBe(200)
    expect(second).toStrictEqual([proxy(1)])
  })
})
