import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AppNodeBuilder } from "../../src/effect/app-node-builder.js"
import { LayerNodePlatform } from "../../src/effect/app-node-platform.js"
import { ProxyRotator } from "../../src/proxy/proxy-rotator.js"
import * as SocksBridge from "../../src/proxy/socks-bridge.js"

test("bans a /24 after shared free-tier quotas so cousins stay unpickable", async () => {
  ProxyRotator.reset()
  let goodPosts = 0
  const origin = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("x-exit") === "good" && request.method === "POST") {
        goodPosts++
        return new Response(request.body)
      }
      if (request.method === "GET" || request.method === "HEAD") return new Response("no", { status: 404 })
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
    },
  })
  const validator = Bun.serve({
    port: 0,
    fetch: () => new Response("1.2.3.4"),
  })
  // Two exits in 127.0.0.0/24 share quota; 127.0.1.1 is a different /24 on loopback.
  const limitedA = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.set("x-exit", "a")
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      return fetch(request.url, { method: request.method, headers, body, redirect: "manual" })
    },
  })
  const limitedB = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.set("x-exit", "b")
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      return fetch(request.url, { method: request.method, headers, body, redirect: "manual" })
    },
  })
  const limitedCousin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.set("x-exit", "cousin")
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      return fetch(request.url, { method: request.method, headers, body, redirect: "manual" })
    },
  })
  const good = Bun.serve({
    hostname: "127.0.1.1",
    port: 0,
    async fetch(request) {
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.set("x-exit", "good")
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      return fetch(request.url, { method: request.method, headers, body, redirect: "manual" })
    },
  })
  const proxyA = `http://127.0.0.1:${limitedA.port}`
  const proxyB = `http://127.0.0.1:${limitedB.port}`
  const proxyCousin = `http://127.0.0.1:${limitedCousin.port}`
  const proxyGood = `http://127.0.1.1:${good.port}`

  const environment = {
    XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "opencode-proxy-subnet-")),
    // Only the shared /24 first so the hunt must burn it before a good exit appears.
    OPENCODE_PROXY: `${proxyA}\n${proxyB}`,
    OPENCODE_PROXY_ONLY: "1",
    OPENCODE_PROXY_VALIDATE_URL: `http://127.0.0.1:${validator.port}`,
    OPENCODE_PROXY_FORCE: undefined,
    OPENCODE_PROXY_LOCAL: "1",
    OPENCODE_PROXY_BUDGET_MS: "8000",
  }
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
  Object.assign(process.env, environment)

  try {
    ProxyRotator.warm()
    const ready = Date.now() + 5_000
    while (Date.now() < ready && ProxyRotator.status().proxies.length < 2) await Bun.sleep(50)
    expect(ProxyRotator.status().proxies.length).toBeGreaterThanOrEqual(2)

    await expect(
      ProxyRotator.fetch(`http://127.0.0.1:${origin.port}/completion`, { method: "POST", body: "{}" }),
    ).rejects.toThrow(/rotation exhausted/i)
    expect(ProxyRotator.status().subnets["127.0.0.0/24"]).toBeGreaterThan(Date.now())

    // Let any in-flight warm from the hunt finish before seeding replacements.
    await Bun.sleep(500)
    process.env.OPENCODE_PROXY = `${proxyGood}\n${proxyCousin}`
    ProxyRotator.warm(true)
    const filled = Date.now() + 8_000
    while (Date.now() < filled && !ProxyRotator.status().proxies.includes(proxyGood)) {
      ProxyRotator.warm(true)
      await Bun.sleep(100)
    }
    expect(ProxyRotator.status().proxies).toContain(proxyGood)
    expect(ProxyRotator.status().proxies).not.toContain(proxyCousin)

    const response = await ProxyRotator.fetch(`http://127.0.0.1:${origin.port}/completion`, {
      method: "POST",
      body: "{}",
    })
    expect(await response.text()).toBe("{}")
    expect(goodPosts).toBe(1)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    origin.stop(true)
    validator.stop(true)
    limitedA.stop(true)
    limitedB.stop(true)
    limitedCousin.stop(true)
    good.stop(true)
    SocksBridge.stop()
    ProxyRotator.reset()
  }
})

test("rotates a rate-limited request through the configured proxy", async () => {
  ProxyRotator.reset()
  let direct = 0
  let proxied = 0
  let limited = false
  const origin = Bun.serve({
    port: 0,
    fetch(request) {
      // The rotator probes with a GET before spending the real POST, so only count
      // the request that actually carries the body.
      if (request.headers.get("x-proxied")) {
        if (request.method === "POST") proxied++
        return new Response(request.body)
      }
      direct++
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
    },
  })
  const validator = Bun.serve({
    port: 0,
    fetch: () => new Response("1.2.3.4"),
  })
  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      if (limited) return new Response('{"error":{"type":"FreeUsageLimitError"}}', { status: 429 })
      if (request.method === "CONNECT") return new Response("unsupported", { status: 405 })
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.set("x-proxied", "1")
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      return fetch(request.url, { method: request.method, headers, body, redirect: "manual" })
    },
  })

  const environment = {
    XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "opencode-proxy-")),
    OPENCODE_PROXY: `http://127.0.0.1:${proxy.port}`,
    OPENCODE_PROXY_ONLY: "1",
    OPENCODE_PROXY_VALIDATE_URL: `http://127.0.0.1:${validator.port}`,
    OPENCODE_PROXY_FORCE: undefined,
    OPENCODE_PROXY_LOCAL: "1",
    OPENCODE_PROXY_BUDGET_MS: "1500",
  }
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
  Object.assign(process.env, environment)

  try {
    const body = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const request = HttpClientRequest.post(`http://127.0.0.1:${origin.port}/completion`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ hello: "world" }),
        )
        const response = yield* client.execute(request)
        return yield* response.text
      }).pipe(Effect.provide(AppNodeBuilder.build(LayerNodePlatform.proxyHttpClient))),
    )
    expect(body).toBe('{"hello":"world"}')
    // A warm pool skips the direct attempt so a burned home IP is not tried first.
    expect(direct).toBe(0)
    expect(proxied).toBe(1)

    // A limited proxy is discarded and the exhausted rotation must surface as a
    // rotation failure, never as the provider's quota response.
    limited = true
    await expect(
      ProxyRotator.fetch(`http://127.0.0.1:${origin.port}/completion`, { method: "POST", body: "{}" }),
    ).rejects.toThrow(/rotation exhausted/i)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    origin.stop(true)
    validator.stop(true)
    proxy.stop(true)
    SocksBridge.stop()
  }
})

test(
  "pins sticky only after a terminal SSE finish_reason, not a clean mid-stream FIN",
  async () => {
    ProxyRotator.reset()
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "GET" || request.method === "HEAD") return new Response("no", { status: 404 })
        return new Response("slow down", { status: 429 })
      },
    })
    const validator = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    })
    let wave = 0
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "CONNECT") return new Response("unsupported", { status: 405 })
        if (request.method === "GET" || request.method === "HEAD") {
          const headers = new Headers(request.headers)
          headers.delete("host")
          return fetch(request.url, { method: request.method, headers, redirect: "manual" })
        }
        wave++
        const incomplete =
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
        const complete =
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n"
        return new Response(wave === 1 ? incomplete : complete, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const proxyURL = `http://127.0.0.1:${proxy.port}`

    const environment = {
      XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "opencode-proxy-sse-")),
      OPENCODE_PROXY: proxyURL,
      OPENCODE_PROXY_ONLY: "1",
      OPENCODE_PROXY_VALIDATE_URL: `http://127.0.0.1:${validator.port}`,
      OPENCODE_PROXY_FORCE: undefined,
      OPENCODE_PROXY_LOCAL: "1",
      OPENCODE_PROXY_BUDGET_MS: "15000",
    }
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
    Object.assign(process.env, environment)

    try {
      ProxyRotator.warm()
      const ready = Date.now() + 10_000
      while (Date.now() < ready && ProxyRotator.status().proxies.length < 1) await Bun.sleep(50)
      expect(ProxyRotator.status().proxies.length).toBeGreaterThan(0)

      const cut = await ProxyRotator.fetch(`http://127.0.0.1:${origin.port}/completion`, {
        method: "POST",
        body: "{}",
      })
      expect(await cut.text()).toContain("partial")
      expect(ProxyRotator.status().active).toBeUndefined()

      // markDead blocked the exit; clear so the same env proxy can prove a full SSE.
      ProxyRotator.reset()
      Object.assign(process.env, environment)
      ProxyRotator.warm()
      const again = Date.now() + 10_000
      while (Date.now() < again && ProxyRotator.status().proxies.length < 1) await Bun.sleep(50)

      const ok = await ProxyRotator.fetch(`http://127.0.0.1:${origin.port}/completion`, {
        method: "POST",
        body: "{}",
      })
      expect(await ok.text()).toContain("[DONE]")
      expect(ProxyRotator.status().active).toBe(proxyURL)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      ProxyRotator.reset()
      origin.stop(true)
      validator.stop(true)
      proxy.stop(true)
      SocksBridge.stop()
    }
  },
  60_000,
)

test(
  "times out a proxy that hangs on response headers instead of freezing the chat",
  async () => {
    ProxyRotator.reset()
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        // Probes use GET and must look reachable so the hanging exit is selected
        // for the real POST — that is the ProviderHeaderTimeoutError path.
        if (request.method === "GET" || request.method === "HEAD") return new Response("no", { status: 404 })
        return new Response("slow down", { status: 429 })
      },
    })
    const validator = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    })
    const hanging = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "CONNECT") return new Response("unsupported", { status: 405 })
        // Validation and probes succeed; the POST never returns headers.
        if (request.method === "GET" || request.method === "HEAD") {
          const headers = new Headers(request.headers)
          headers.delete("host")
          return fetch(request.url, { method: request.method, headers, redirect: "manual" })
        }
        return new Promise(() => {})
      },
    })

    const environment = {
      XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "opencode-proxy-hang-")),
      OPENCODE_PROXY: `http://127.0.0.1:${hanging.port}`,
      OPENCODE_PROXY_ONLY: "1",
      OPENCODE_PROXY_VALIDATE_URL: `http://127.0.0.1:${validator.port}`,
      OPENCODE_PROXY_FORCE: undefined,
      OPENCODE_PROXY_LOCAL: "1",
      // One hung attempt (~10s) plus a short wait for a replacement must fail
      // fast — never the AI transport's 5-minute header timeout.
      OPENCODE_PROXY_BUDGET_MS: "15000",
    }
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
    Object.assign(process.env, environment)

    try {
      ProxyRotator.warm()
      const ready = Date.now() + 10_000
      while (Date.now() < ready && ProxyRotator.status().proxies.length < 1) await Bun.sleep(50)

      const started = Date.now()
      await expect(
        ProxyRotator.fetch(`http://127.0.0.1:${origin.port}/completion`, { method: "POST", body: "{}" }),
      ).rejects.toThrow(/rotation exhausted/i)
      expect(Date.now() - started).toBeLessThan(25_000)
      expect(ProxyRotator.status().active).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      origin.stop(true)
      validator.stop(true)
      hanging.stop(true)
      SocksBridge.stop()
    }
  },
  60_000,
)
