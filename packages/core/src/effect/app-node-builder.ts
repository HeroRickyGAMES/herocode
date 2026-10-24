import { buildLocationServiceMap } from "../location-services.js"
import { LocationServiceMap } from "../location-service-map.js"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { proxyFetch } from "./app-node-platform.js"
import { Instance } from "../instance/service.js"

const instances = makeGlobalNode({
  service: Instance.Service,
  layer: Layer.effect(
    Instance.Service,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return Instance.Service.of({
        provide: (session) => Effect.provide(locations.get(session.location)),
      })
    }),
  ),
  deps: [LocationServiceMap.node],
})

export function build<A, E>(root: LayerNode.Graph<A, E>, replacements: LayerNode.Replacements = []) {
  const bindings = [Instance.node.replace(instances), ...replacements]
  // `FetchHttpClient` resolves its `Fetch` reference from the request fiber, so a
  // layer-local provide cannot win over the runtime context. Pin the rotator at the
  // graph root so every HTTP request in the process can rotate proxies.
  return LayerNode.compile(root, {
    replacements: [LocationServiceMap.node.replace(buildLocationServiceMap(bindings)), ...bindings],
  }).pipe(Layer.provideMerge(Layer.succeedContext(Context.make(FetchHttpClient.Fetch, proxyFetch))))
}

export * as AppNodeBuilder from "./app-node-builder.js"
