import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Config } from "@/config/config"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"

// Vision layer: describes images with an OpenRouter vision model so blind
// models (that cannot read image parts) still get the image content as text
// context. It mirrors the "third eye" used by the claude-zen-proxy.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
const DEFAULT_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
const DEFAULT_TIMEOUT_MS = 60_000
const CACHE_MAX = 128

export class NoApiKeyError extends Schema.TaggedErrorClass<NoApiKeyError>()("VisionNoApiKeyError", {}) {
  override get message() {
    return "Vision layer requires an OpenRouter API key (config vision.api_key or the OPENROUTER_API_KEY environment variable)"
  }
}

export class DescribeError extends Schema.TaggedErrorClass<DescribeError>()("VisionDescribeError", {
  detail: Schema.String,
}) {
  override get message() {
    return `Could not describe image: ${this.detail}`
  }
}

export type Error = NoApiKeyError | DescribeError

const VisionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.String,
      }),
    }),
  ),
})

export type Settings = {
  readonly apiKey: string
  readonly force: boolean
  readonly model: string
  readonly fallbacks: readonly string[]
  readonly timeoutMs: number
}

export interface Interface {
  readonly describe: (input: {
    readonly imageUrls: readonly string[]
    readonly userText?: string
  }) => Effect.Effect<string, Error>
  readonly settings: () => Effect.Effect<Settings | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vision") {}

const firstNonEmpty = (...values: Array<string | undefined>) => {
  for (const value of values) {
    if (value && value.trim() !== "") return value.trim()
  }
  return ""
}

const splitCSV = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")

const cacheKey = (imageUrls: readonly string[], userText: string) =>
  createHash("sha256").update(imageUrls.join("\u0000")).update("\u0001").update(userText).digest("hex")

const descriptionCache = new Map<string, string>()

function remember(key: string, value: string) {
  descriptionCache.set(key, value)
  if (descriptionCache.size > CACHE_MAX) {
    const oldest = descriptionCache.keys().next().value
    if (oldest) descriptionCache.delete(oldest)
  }
}

const buildPrompt = (userText: string) => {
  const base =
    "Você é o 'terceiro olho' de um assistente: vê uma imagem e a descreve em texto para outro modelo (que não lê imagens). " +
    "Descreva com riqueza de detalhes relevantes: texto/OCR visível, elementos, layout, cores, contexto. Seja objetivo e factual; se não der para ver algo, diga que não dá. " +
    "Nunca invente conteúdo que não está na imagem."
  if (userText.trim() === "") return base
  return `${base}\n\nO usuário também escreveu: "${userText}"\nDescreva a imagem de olho nessa pergunta/contexto.`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient

    const resolveSettings = Effect.fn("Vision.resolveSettings")(function* () {
      const cfg = yield* config.get()
      const vision = cfg.vision
      const apiKey = firstNonEmpty(vision?.api_key, process.env.OPENROUTER_API_KEY)
      const envEnable = process.env.OPENCODE_VISION
      const enabled = vision?.enabled ?? (envEnable === "0" || envEnable === "false" ? false : apiKey !== "")
      if (!enabled) return undefined
      return {
        apiKey,
        force: vision?.force ?? process.env.OPENCODE_VISION_FORCE === "1",
        model: firstNonEmpty(vision?.model, process.env.VISION_MODEL, DEFAULT_MODEL),
        fallbacks: vision?.fallbacks ?? splitCSV(process.env.VISION_FALLBACKS),
        timeoutMs: vision?.timeout ?? DEFAULT_TIMEOUT_MS,
      }
    })

    const attempt = Effect.fn("Vision.attempt")(function* (input: {
      apiKey: string
      model: string
      userText: string
      imageUrls: readonly string[]
      timeoutMs: number
    }) {
      const body = {
        model: input.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt(input.userText) },
              ...input.imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
            ],
          },
        ],
        max_tokens: 1500,
      }
      const response = yield* HttpClientRequest.post(OPENROUTER_URL).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((request) => http.execute(request)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(VisionResponse)),
        Effect.timeout(input.timeoutMs),
        Effect.mapError((error) => new DescribeError({ detail: String(error) })),
        Effect.tapError((error) => Effect.logWarning("vision model failed", { model: input.model, error })),
      )
      const content = response.choices[0]?.message.content ?? ""
      if (content.trim() === "") return yield* new DescribeError({ detail: "vision model returned an empty response" })
      return content.trim()
    })

    const describe = Effect.fn("Vision.describe")(function* (input: {
      readonly imageUrls: readonly string[]
      readonly userText?: string
    }) {
      const settings = yield* resolveSettings()
      if (!settings || settings.apiKey === "") return yield* new NoApiKeyError()
      const userText = input.userText ?? ""
      const key = cacheKey(input.imageUrls, userText)
      const cached = descriptionCache.get(key)
      if (cached) return cached

      const models = [settings.model, ...settings.fallbacks]
      const attempts = models.map((model) =>
        attempt({
          apiKey: settings.apiKey,
          model,
          userText,
          imageUrls: input.imageUrls,
          timeoutMs: settings.timeoutMs,
        }),
      )
      const description = yield* Effect.firstSuccessOf(attempts).pipe(
        Effect.mapError(
          () =>
            new DescribeError({
              detail: `no vision model responded [${models.join(", ")}]`,
            }),
        ),
        Effect.tapError((error) => Effect.logWarning("all vision models failed", { error })),
      )
      remember(key, description)
      return description
    })

    return Service.of({
      describe,
      settings: resolveSettings,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, httpClient],
})

export * as Vision from "./vision"