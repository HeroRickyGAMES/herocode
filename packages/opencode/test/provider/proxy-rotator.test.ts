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

  test("keeps rotating across proxies until the caller aborts", async () => {
    await using tmp = await tmpdir()
    let searches = 0
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      // A fresh search keeps finding the same dead proxy, so the rotator must
      // keep swapping (never stalling) until the caller cancels.
      search: async () => {
        searches++
        return [proxy(1)]
      },
    })
    const cache = [proxy(1)].map((url) => `${Date.now()}|${url}`).join("\n")
    await Bun.write(`${tmp.path}/working.txt`, `${cache}\n`)

    const controller = new AbortController()
    const error = new Error("Cannot connect to API: Unable to connect to the provider")
    const seen: Array<string | undefined> = []
    const send = async (p: string | undefined) => {
      seen.push(p)
      if (seen.length >= 6) controller.abort(new Error("cancelled"))
      throw error
    }

    await expect(rotator.withRetry(send, controller.signal)).rejects.toThrow("cancelled")
    // Direct attempt, then one per working proxy, well past any fixed budget.
    expect(seen.length).toBeGreaterThanOrEqual(6)
    expect(seen[0]).toBeUndefined()
    expect(seen.slice(1).every((p) => p === proxy(1))).toBe(true)
    // The pool dried up and was rejected/rescanned rather than silently reusing
    // the same connection forever.
    expect(searches).toBeGreaterThanOrEqual(1)
  })

  test("honors a finite attempt budget when one is provided", async () => {
    await using tmp = await tmpdir()
    const rotator = new ProxyRotator({
      target: "https://opencode.ai",
      id: "with-retry",
      cacheDir: tmp.path,
      maxAttempts: 4,
      search: async () => [proxy(1)],
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
    expect(seen.length).toBe(4)
    expect(seen[0]).toBeUndefined()
    expect(seen.slice(1).every((p) => p === proxy(1))).toBe(true)
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
      maxAttempts: 5,
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
    expect(seen.length).toBe(5)
    expect(seen.every((p) => p === undefined || p === proxy(1))).toBe(true)
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