import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { Vision } from "@/vision/vision"
import { Config } from "@/config/config"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import * as Option from "effect/Option"
import {
  jsonSchema,
  tool as aiTool,
  type FilePart,
  type ImagePart,
  type ModelMessage,
  type TextPart,
  type Tool,
  type UIMessage,
} from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  const vision = Option.getOrUndefined(yield* Effect.serviceOption(Vision.Service))
  const visionSettings = vision ? yield* vision.settings() : undefined
  const imageParts: Array<{ role: string; content: "content" | "parts" | "string" | "none" }> = []
  for (const msg of input.messages) {
    const content =
      Array.isArray(msg.content)
        ? msg.content
        : (msg as ModelMessage & { parts?: readonly RequestPart[] }).parts
    if (!content || content.length === 0) continue
    if (content.some(isImagePart))
      imageParts.push({
        role: msg.role,
        content: Array.isArray(msg.content) ? "content" : "parts",
      })
  }
  if (imageParts.length > 0) {
    const hasConfig = yield* Effect.serviceOption(Config.Service).pipe(Effect.map(Option.isSome))
    const hasPermission = yield* Effect.serviceOption(Permission.Service).pipe(Effect.map(Option.isSome))
    yield* Effect.logInfo("vision.prepare", {
      hasVision: vision !== undefined,
      hasSettings: visionSettings !== undefined,
      force: visionSettings?.force ?? null,
      imageCapable: input.model.capabilities.input.image,
      config: hasConfig,
      permission: hasPermission,
      imageMessages: imageParts.map((part) => `${part.role}:${part.content}`).join(","),
    })
  }
  const finalMessages =
    vision && visionSettings
      ? yield* withVisionDescriptions({
          messages,
          model: input.model,
          force: visionSettings.force,
          describe: (imageUrls, userText) => vision.describe({ imageUrls, userText }),
        })
      : messages

  return {
    system,
    messages: finalMessages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            "User-Agent": USER_AGENT,
          }),
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      ...input.model.headers,
      ...headers,
    },
  }
})

type ImageFilePart = FilePart | ImagePart | Extract<UIMessage["parts"][number], { type: "file" }>

type RequestPart = TextPart | ImagePart | FilePart | UIMessage["parts"][number]

const isImagePart = (part: unknown): part is ImageFilePart => {
  if (part === null || typeof part !== "object") return false
  const candidate = part as { type?: unknown; mediaType?: unknown }
  return (
    candidate.type === "image" ||
    (candidate.type === "file" && typeof candidate.mediaType === "string" && candidate.mediaType.startsWith("image/"))
  )
}

const toDataUrl = (part: ImageFilePart) => {
  const mime = part.type === "image" ? undefined : part.mediaType
  const data =
    part.type === "image"
      ? part.image
      : "data" in part && part.data !== undefined
        ? part.data
        : "url" in part
          ? part.url
          : undefined
  if (data instanceof URL) return data.toString()
  if (typeof data === "string") {
    if (data.startsWith("data:") || data.startsWith("http://") || data.startsWith("https://")) return data
    return `data:${mime ?? "image/png"};base64,${data}`
  }
  if (data === undefined) return `data:${mime ?? "image/png"};base64,`
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return `data:${mime ?? "image/png"};base64,${Buffer.from(bytes).toString("base64")}`
}

const isTextPart = (part: RequestPart | undefined): part is TextPart =>
  !!part && part.type === "text" && typeof part.text === "string"

const withVisionDescriptions = Effect.fn("LLMRequestPrep.withVisionDescriptions")(function* (input: {
  messages: ModelMessage[]
  model: Provider.Model
  force: boolean
  describe: (imageUrls: readonly string[], userText: string) => Effect.Effect<string, Vision.Error>
}) {
  if (!input.force && input.model.capabilities.input.image) return input.messages

  const describeMessage = Effect.fn("LLMRequestPrep.describeMessage")(function* (msg: ModelMessage) {
    if (msg.role !== "user") return msg
    const content =
      msg.content !== undefined && Array.isArray(msg.content)
        ? msg.content
        : (msg as ModelMessage & { parts?: readonly RequestPart[] }).parts
    if (!content || content.length === 0) return msg
    const userText = content
      .filter(isTextPart)
      .map((part) => part.text)
      .join(" ")
      .slice(0, 2000)
    let imageIndex = 0
    const next: RequestPart[] = []
    for (const part of content) {
      if (!isImagePart(part)) {
        next.push(part)
        continue
      }
      imageIndex += 1
      const description = yield* input
        .describe([toDataUrl(part)], userText)
        .pipe(Effect.orElseSucceed(() => "não foi possível descrever a imagem"))
      next.push({ type: "text", text: `[Imagem #${imageIndex}: ${description}]` })
    }
    const isUIMessage = msg.content === undefined && "parts" in msg
    yield* Effect.logInfo("vision.describe-message", {
      role: msg.role,
      shape: isUIMessage ? "parts" : "content",
      partTypes: content.map((part) => part.type).join(","),
      images: imageIndex,
    })
    return isUIMessage ? ({ ...msg, parts: next } as ModelMessage) : ({ ...msg, content: next } as ModelMessage)
  })

  return yield* Effect.forEach(input.messages, (msg) => describeMessage(msg))
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
