export * as ConfigVisionV1 from "./vision"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Describe images with a vision model before sending them to a model that cannot read them (default: enabled when an OpenRouter API key is available)",
  }),
  api_key: Schema.optional(Schema.String).annotate({
    description: "OpenRouter API key used to describe images. Prefer the OPENROUTER_API_KEY environment variable.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Vision model used to describe images (default: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free)",
  }),
  fallbacks: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Alternative vision models tried in order when the primary model fails",
  }),
  force: Schema.optional(Schema.Boolean).annotate({
    description: "Describe images even when the selected model advertises image support (default: false)",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in milliseconds for each vision request (default: 60000)",
  }),
}).annotate({ identifier: "VisionConfig" })
export type Info = Schema.Schema.Type<typeof Info>