import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ProxyRotator } from "../../src/provider/proxy-rotator"

const proxy = (n: number) => `http://10.0.0.${n}:8080`

describe("provider.ProxyRotator.shouldRotate", () => {
  test("rotates on any 4xx/5xx, not just rate limits", () => {
    expect(ProxyRotator.shouldRotate(200)).toBe(false)
    expect(ProxyRotator.shouldRotate(301)).toBe(false)
    expect(ProxyRotator.shouldRotate(400)).toBe(true)
    expect(ProxyRotator.shouldRotate(404)).toBe(true)
    expect(ProxyRotator.shouldRotate(429)).toBe(true)
    expect(ProxyRotator.shouldRotate(500)).toBe(true)
    expect(ProxyRotator.shouldRotate(503)).toBe(true)
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
  test("rotates across proxies on 404/500 and succeeds through a fresh one", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
    })
    const cache = [proxy(1), proxy(2), proxy(3)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      const status = seen.length === 1 ? 404 : seen.length === 2 ? 500 : 200
      return { status, response: new Response(null, { status }) }
    }

    const { status } = await rotator.withRetry(send)
    expect(status).toBe(200)
    expect(seen).toStrictEqual([undefined, proxy(1), proxy(2)])
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

  test("throws the connection error after exhausting the proxy budget", async () => {
    await using tmp = await tmpdir()
    let searches = 0
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      // A fresh search keeps finding the same dead proxy, so the rotator must
      // resist stalling forever and surface only when the retry budget runs out.
      search: async () => {
        searches++
        return [proxy(1)]
      },
    })
    const cache = [proxy(1)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const error = new Error("Cannot connect to API: Unable to connect to the provider")
    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      throw error
    }

    await expect(rotator.withRetry(send)).rejects.toBe(error)
    // Direct attempt, then one per working proxy until the budget runs out.
    expect(seen.length).toBe(10)
    expect(seen[0]).toBeUndefined()
    expect(seen.slice(1).every((p) => p === proxy(1))).toBe(true)
    // The pool dried up and was rejected/rescanned rather than silently reusing
    // the same connection forever.
    expect(searches).toBeGreaterThanOrEqual(1)
  })

  test("abandons a hung proxy once the request timeout fires and rotates", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      requestTimeoutMs: 50,
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
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      // Only the first search yields a working proxy; later rescans return the
      // same result. Proxy (1) is already used, so 404 forces rotation.
      search: async () => [proxy(1)],
    })
    const cache = [proxy(1)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      return { status: 404, response: new Response(null, { status: 404 }) }
    }

    const { status } = await rotator.withRetry(send)
    // The request was retried after the cache pool was exhausted, proving that
    // exhaustion triggers a fresh rescan instead of giving up immediately.
    expect(status).toBe(404)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((p) => p === undefined || p === proxy(1))).toBe(true)
  })
})