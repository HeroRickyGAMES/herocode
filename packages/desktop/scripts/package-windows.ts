#!/usr/bin/env bun
import { $ } from "bun"
import { rm } from "node:fs/promises"

import { downloadCliToResources, resolveChannel } from "./utils"

// One main bundle feeds both installers: @lydell/node-pty and @parcel/watcher pick
// their prebuilt addon from process.platform/process.arch at runtime. Only the
// opencode-cli sidecar is genuinely per-architecture, so it must be re-downloaded
// immediately before each packaging pass to avoid shipping a foreign-arch binary.
const ARCHES = [
  { arch: "x64", rustTarget: "x86_64-pc-windows-msvc" },
  { arch: "arm64", rustTarget: "aarch64-pc-windows-msvc" },
]

const only = process.argv[2]
const selected = only ? ARCHES.filter((item) => item.arch === only) : ARCHES
if (selected.length === 0) throw new Error(`Unknown architecture '${only}'. Use x64 or arm64.`)

// The dev channel is the only one that ships the opencode-cli sidecar.
const shipsCli = resolveChannel() === "dev"

for (const item of selected) {
  if (shipsCli) {
    // Drop whatever the host prebuild downloaded plus the previous architecture's
    // binary; the extraResources glob would otherwise ship a foreign-arch CLI.
    await rm("resources/opencode-cli", { force: true })
    await rm("resources/opencode-cli.exe", { force: true })
    console.log(`\n=== opencode-cli for ${item.arch} (${item.rustTarget}) ===`)
    await downloadCliToResources(item.rustTarget)
  }
  console.log(`\n=== electron-builder --win --${item.arch} ===`)
  await $`bunx electron-builder --win --${item.arch} --config electron-builder.config.ts`
}