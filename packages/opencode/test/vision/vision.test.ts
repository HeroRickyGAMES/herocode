import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpBody } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Config } from "@/config/config"
import { Vision } from "@/vision/vision"
import { LLMRequestPrep } from "@/session/llm/request"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import type { Info as ConfigInfo } from "@opencode-ai/core/v1/config/config"

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const chatCompletion = (content: string) => ({
  choices: [{ message: { role: "assistant", content } }],
})

const bodyOf = (request: HttpClientRequest.HttpClientRequest): Record<string, unknown> | undefined => {
  const body = request.body
  if (body instanceof HttpBody.Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body.body)) as Record<string, unknown>
  }
  if (body instanceof HttpBody.Raw) {
    return body.body as Record<string, unknown>
  }
  return undefined
}

function visionLayer(client: HttpClient.HttpClient, config: ConfigInfo) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(Vision.node, [
    replacement,
    [Config.node, TestConfig.layer({ get: () => Effect.succeed(config) })],
  ])
}

function enabledConfig(): ConfigInfo {
  return {
    vision: {
      enabled: true,
      api_key: "sk-test",
      model: "vision/test-model",
      fallbacks: [],
      force: false,
      timeout: 5000,
    },
  } as ConfigInfo
}

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENCODE_VISION", "OPENCODE_VISION_FORCE", "VISION_MODEL", "VISION_FALLBACKS"] as const
const savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {} as never

beforeAll(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const lastRequest: { body: Record<string, unknown> | undefined } = { body: undefined }
const calls: { count: number } = { count: 0 }
const descriptionClient = HttpClient.make((request) => {
  calls.count += 1
  lastRequest.body = bodyOf(request)
  return Effect.succeed(json(request, chatCompletion("uma foto de um gato laranja")))
})
const it = testEffect(visionLayer(descriptionClient, enabledConfig()))

const fallbackBodies: Array<Record<string, unknown>> = []
const fallbackClient = HttpClient.make((request) => {
  const body = bodyOf(request)
  fallbackBodies.push(body ?? {})
  return Effect.succeed(
    body?.model === "vision/fallback"
      ? json(request, chatCompletion("imagem com texto OCR: HELLO 12345"))
      : json(request, chatCompletion("")),
  )
})
const itFallback = testEffect(
  visionLayer(fallbackClient, {
    ...enabledConfig(),
    vision: { ...enabledConfig().vision!, model: "vision/broken", fallbacks: ["vision/fallback"] },
  } as ConfigInfo),
)

const noKeyClient = HttpClient.make(() => Effect.die("unexpected http call"))
const itNoKey = testEffect(visionLayer(noKeyClient, { vision: { enabled: true } } as ConfigInfo))

describe("Vision", () => {
  it.effect("describes an image with the configured vision model", () =>
    Effect.gen(function* () {
      const vision = yield* Vision.Service
      const description = yield* vision.describe({
        imageUrls: ["data:image/png;base64,aGVsbG8="],
        userText: "o que tem aqui?",
      })

      expect(description).toBe("uma foto de um gato laranja")
      expect(lastRequest.body?.model).toBe("vision/test-model")
      const messages = lastRequest.body?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }> | undefined
      const user = messages?.find((message) => message.role === "user")
      expect(user?.content[0].type).toBe("text")
      expect(user?.content[1].type).toBe("image_url")
      expect(user?.content[1].image_url).toEqual({ url: "data:image/png;base64,aGVsbG8=" })
    }),
  )

  it.effect("caches identical descriptions without a second HTTP call", () =>
    Effect.gen(function* () {
      const vision = yield* Vision.Service
      const input = { imageUrls: ["data:image/png;base64,Y2FjaGU="], userText: "repete" }
      const before = calls.count

      const first = yield* vision.describe(input)
      const second = yield* vision.describe(input)

      expect(first).toBe("uma foto de um gato laranja")
      expect(second).toBe(first)
      expect(calls.count).toBe(before + 1)
    }),
  )

  itNoKey.effect("disables the layer without a configured API key", () =>
    Effect.gen(function* () {
      const vision = yield* Vision.Service
      const exit = yield* vision.describe({ imageUrls: ["data:image/png;base64,c2VtLWNoYXZl"] }).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
    }),
  )

  itFallback.effect("falls back to the next model when the first returns an empty response", () =>
    Effect.gen(function* () {
      const vision = yield* Vision.Service
      const description = yield* vision.describe({ imageUrls: ["data:image/png;base64,b3Jy"] })

      expect(description).toBe("imagem com texto OCR: HELLO 12345")
      expect(fallbackBodies.map((body) => body.model)).toEqual(["vision/broken", "vision/fallback"])
    }),
  )
})

const agent = {
  name: "test",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
} as const

describe("Vision in LLMRequestPrep.prepare", () => {
  const blindModel = {
    id: "test/blind",
    providerID: "test",
    api: { id: "blind", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
    name: "Blind model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    } as const,
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    status: "active" as const,
    options: {},
    headers: {},
  }
  const visionModel = {
    ...blindModel,
    capabilities: {
      ...blindModel.capabilities,
      input: { ...blindModel.capabilities.input, image: true },
    },
  }

  const plugin = {
    trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }

  const visionMock = (force: boolean) =>
    Layer.mock(Vision.Service, {
      describe: (input) => Effect.succeed(`IMAGEM-DESCRITA[${input.imageUrls[0] ?? ""}]`),
      settings: () => Effect.succeed({ apiKey: "sk-test", force, model: "vision/mock", fallbacks: [], timeoutMs: 5000 }),
    })

  const prepare = (model: unknown, messages: unknown, force: boolean, withVision = true) => {
    const effect = LLMRequestPrep.prepare({
      user: { id: "msg_user", role: "user", time: { created: Date.now() }, agent: "test", model: { providerID: "test", modelID: "blind" } } as never,
      sessionID: "session-test-vision",
      model: model as never,
      agent: agent as never,
      system: [],
      messages: messages as never,
      tools: {},
      provider: { id: "test", options: {} } as never,
      auth: undefined,
      plugin: plugin as never,
      flags: { outputTokenMax: 32_000, client: "test" } as never,
      isWorkflow: false,
    })
    return withVision ? effect.pipe(Effect.provide(visionMock(force))) : effect
  }

  test("replaces image file parts with vision descriptions for a blind model", async () => {
    const result = await Effect.runPromise(
      prepare(blindModel, [
        {
          role: "user",
          content: [
            { type: "text", text: "o que mostra essa imagem?" },
            { type: "file", data: "aGVsbG8=", mediaType: "image/png", filename: "pic.png" },
          ],
        },
      ], false),
    )

    const content = result.messages[1].content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: "text", text: "o que mostra essa imagem?" })
    expect(content[1]).toEqual({
      type: "text",
      text: "[Imagem #1: IMAGEM-DESCRITA[data:image/png;base64,aGVsbG8=]]",
    })
  })

  test("leaves image parts untouched when the model supports images and force is off", async () => {
    const result = await Effect.runPromise(
      prepare(visionModel, [
        { role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png", filename: "pic.png" }] },
      ], false),
    )

    expect((result.messages[1].content as Array<Record<string, unknown>>)[0].type).toBe("file")
  })

  test("force describes images even when the model advertises image support", async () => {
    const result = await Effect.runPromise(
      prepare(visionModel, [
        { role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png", filename: "pic.png" }] },
      ], true),
    )

    expect((result.messages[1].content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "text",
      text: "[Imagem #1: IMAGEM-DESCRITA[data:image/png;base64,aGVsbG8=]]",
    })
  })

  test("does not call describe when the vision service is absent", async () => {
    const result = await Effect.runPromise(
      prepare(blindModel, [
        { role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png", filename: "pic.png" }] },
      ], false, false),
    )

    expect((result.messages[1].content as Array<Record<string, unknown>>)[0].type).toBe("file")
  })

  test("replaces UIMessage file parts (parts[].url) for a blind model", async () => {
    const result = await Effect.runPromise(
      prepare(blindModel, [
        {
          role: "user",
          id: "msg-ui-1",
          parts: [
            { type: "text", text: "o que tem na imagem?" },
            { type: "file", url: "data:image/png;base64,aGVsbG8=", mediaType: "image/png", filename: "Screenshot.png" },
          ],
        },
      ], false),
    )

    const parts = (result.messages[1] as { parts?: Array<Record<string, unknown>>; content?: Array<Record<string, unknown>> }).parts
    expect(parts?.[0]).toEqual({ type: "text", text: "o que tem na imagem?" })
    expect(parts?.[1]).toEqual({
      type: "text",
      text: "[Imagem #1: IMAGEM-DESCRITA[data:image/png;base64,aGVsbG8=]]",
    })
  })

  test("leaves non-image uimessage parts untouched", async () => {
    const result = await Effect.runPromise(
      prepare(blindModel, [
        {
          role: "user",
          id: "msg-ui-2",
          parts: [
            { type: "text", text: "vc não fez o seu trabalho" },
            { type: "file", url: "file:///tmp/notes.txt", mediaType: "text/plain", filename: "notes.txt" },
          ],
        },
      ], false),
    )

    const parts = (result.messages[1] as { parts?: Array<Record<string, unknown>> }).parts
    expect(parts?.[1]).toEqual({
      type: "file",
      url: "file:///tmp/notes.txt",
      mediaType: "text/plain",
      filename: "notes.txt",
    })
  })

  test("replaces data-url and http image parts for a blind model", async () => {
    const result = await Effect.runPromise(
      prepare(blindModel, [
        {
          role: "user",
          content: [
            { type: "file", data: "data:image/png;base64,ZGF0YS11cmw=", mediaType: "image/png", filename: "a.png" },
            { type: "image", image: "https://example.com/b.png", mediaType: "image/png" },
          ],
        },
      ], false),
    )

    const content = result.messages[1].content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({
      type: "text",
      text: "[Imagem #1: IMAGEM-DESCRITA[data:image/png;base64,ZGF0YS11cmw=]]",
    })
    expect(content[1]).toEqual({
      type: "text",
      text: "[Imagem #2: IMAGEM-DESCRITA[https://example.com/b.png]]",
    })
  })
})