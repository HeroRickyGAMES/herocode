import { Option, Schema } from "effect"

declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_RELEASE_HIGHLIGHTS: string

const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
// The Console free tier rejects clients below a minimum advertised version.
// Branch and local builds report versions like `0.0.0-dev-...` or `local`, so
// advertise a supported stable release without changing tracked/preview flags.
const MIN_SUPPORTED_VERSION = "2.1.4"
const StableVersion = /^\d+\.\d+\.\d+$/
const advertised = StableVersion.test(version) ? version : MIN_SUPPORTED_VERSION
const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
// Stable release builds embed the release notes' Highlights; every other build has none.
const highlights =
  typeof OPENCODE_RELEASE_HIGHLIGHTS === "string"
    ? Option.getOrElse(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }))),
        )(OPENCODE_RELEASE_HIGHLIGHTS),
        () => [],
      )
    : []

export {
  version as OPENCODE_VERSION,
  advertised as OPENCODE_ADVERTISED_VERSION,
  channel as OPENCODE_CHANNEL,
  artifact as OPENCODE_ARTIFACT,
  highlights as OPENCODE_HIGHLIGHTS,
}
export const OPENCODE_LOCAL = channel === "local"
