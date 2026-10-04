import { describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

describe("LayerNode", () => {
  // A bundler chunk cycle leaves the imported binding undefined while the
  // referencing node is built. Reading deps eagerly captured that hole and later
  // walks dereferenced it, which is what broke the Windows builds.
  test("resolves a dependency that is only assigned after the referencing node", () => {
    let late: LayerNode.Node<object> | undefined
    const early = LayerNode.make({ name: "early", layer: Layer.empty, deps: () => [late!] })
    late = LayerNode.make({ name: "late", layer: Layer.empty, deps: () => [] })

    expect(early.dependencies).toEqual([late])
  })

  test("resolves group members lazily", () => {
    let late: LayerNode.Node<object> | undefined
    const group = LayerNode.group(() => [late!])
    late = LayerNode.make({ name: "late", layer: Layer.empty, deps: () => [] })

    expect(group.dependencies).toEqual([late])
  })

  test("names the owning node when a dependency never resolves", () => {
    const broken = LayerNode.make({ name: "broken", layer: Layer.empty, deps: () => [undefined as never] })

    expect(() => broken.dependencies).toThrow('Layer node "broken" has an unresolved dependency at index 0')
  })

  test("reads a dependency thunk only once", () => {
    let calls = 0
    const node = LayerNode.make({
      name: "memo",
      layer: Layer.empty,
      deps: () => {
        calls++
        return []
      },
    })

    void node.dependencies
    void node.dependencies

    expect(calls).toBe(1)
  })
})
