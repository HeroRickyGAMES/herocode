import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Socket } from "effect/socket"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { ProxyRotator } from "../proxy/proxy-rotator.js"
import { WebSocketConstructor } from "./websocket-constructor.js"

// Bun's fetch ends a request after five quiet minutes, before provider routes' own header and chunk timeouts.
const withoutBunTimeout = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transformResponse(
      client,
      Effect.provideService(FetchHttpClient.RequestInit, { timeout: false } as BunFetchRequestInit),
    )
  }),
)

const proxyFetch = Object.assign(ProxyRotator.fetch, { preconnect: globalThis.fetch.preconnect })

export const proxyHttpClient = makeGlobalNode({
  service: HttpClient.HttpClient,
  layer: FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeedContext(Context.make(FetchHttpClient.Fetch, proxyFetch))),
  ),
  deps: [],
})

export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer.pipe(Layer.provide(withoutBunTimeout)),
  deps: [proxyHttpClient],
})

export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export const webSocketConstructor = makeGlobalNode({
  service: Socket.WebSocketConstructor,
  layer: WebSocketConstructor.layer,
  deps: [],
})

export * as LayerNodePlatform from "./app-node-platform.js"
