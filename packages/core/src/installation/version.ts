declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// The Console free tier rejects clients whose reported version is below a
// minimum. Branch builds (e.g. `dev`) report `0.0.0-<channel>-<ts>`, and
// `bun dev` reports `local`, both of which trip that server-side check even
// though the code is up to date, so floor the advertised version to a supported
// release. Spoofing only affects the version we advertise; it never changes
// tracked/preview flags.
const MIN_SUPPORTED_VERSION = "1.18.0"
const VersionPattern = /^\d+\.\d+\.\d+$/

const rawVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationVersion = VersionPattern.test(rawVersion) ? rawVersion : MIN_SUPPORTED_VERSION
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
