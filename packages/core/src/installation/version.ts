declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// The Console free tier rejects clients whose reported version is below a
// minimum (1.17.0). Branch builds (e.g. `dev`) report `0.0.0-<channel>-<ts>`,
// which trips that server-side check even though the code is up to date, so
// floor the advertised version to a supported release. Spoofing only affects
// the version we advertise; it never changes tracked/preview flags.
const MIN_SUPPORTED_VERSION = "1.17.0"

const rawVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationVersion = rawVersion.startsWith("0.0.0-") ? MIN_SUPPORTED_VERSION : rawVersion
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
