import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AppNodeBuilder } from "../../src/effect/app-node-builder.js"
import { LayerNodePlatform } from "../../src/effect/app-node-platform.js"
import * as SocksBridge from "../../src/proxy/socks-bridge.js"

test("rotates a rate-limited request through the configured proxy", async () => {
  let direct = 0
  let proxied = 0
  const origin = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("x-proxied")) {
        proxied++
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
    expect(direct).toBe(1)
    expect(proxied).toBe(1)
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
