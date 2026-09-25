import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import { which } from "@opencode-ai/core/util/which"
import { detectLanguage, speak, stopTTS } from "./tts"
import { isRecord } from "./record"

export const MICROPHONE_STATES = [
  "idle",
  "recording",
  "transcribing",
  "waiting",
  "speaking",
  "paused",
  "error",
  "unsupported",
] as const

export type MicrophoneState = (typeof MICROPHONE_STATES)[number]

export type MicrophoneTranscription = {
  text: string
  language?: string
}

export type MicrophoneRecordingResult = {
  interrupted: boolean
  error?: string
}

export type MicrophoneRecording = {
  file: string
  result: Promise<MicrophoneRecordingResult>
  stop: () => void | Promise<void>
  dispose?: () => void | Promise<void>
}

export type MicrophoneTranscriptionResult = void | boolean | "paused"

export type MicrophoneControllerOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  which?: (command: string) => string | null | undefined
  startRecording?: () => MicrophoneRecording | Promise<MicrophoneRecording>
  transcribe?: (file: string, signal: AbortSignal) => Promise<MicrophoneTranscription>
  onTranscription?: (
    transcription: MicrophoneTranscription,
  ) => MicrophoneTranscriptionResult | Promise<MicrophoneTranscriptionResult>
  speak?: (text: string, language?: string) => void | boolean | Promise<void | boolean>
  stopSpeak?: () => void
  onState?: (state: MicrophoneState, error?: string) => void
}

export type SttCommand = {
  command: string
  args: string[]
}

export type SttBackend = "local" | "openai" | "auto"

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions"
const DEFAULT_LOCAL_STT_MESSAGE =
  "Nenhum STT local encontrado. Configure OPENCODE_STTS_COMMAND, OPENCODE_WHISPER_MODEL ou OPENCODE_STT_MODEL; OpenAI exige OPENCODE_STT_BACKEND=openai"

function voiceRoot(env: NodeJS.ProcessEnv) {
  const configured = env.OPENCODE_VOICE_DIR?.trim()
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".opencode", "voice")
}

function resolveWhisperBinary(env: NodeJS.ProcessEnv, lookup: (command: string) => string | null | undefined) {
  const configured = env.OPENCODE_WHISPER_BIN?.trim()
  if (configured) return configured
  const local = path.join(voiceRoot(env), "whisper", "bin", "whisper-cli")
  if (existsSync(local)) return local
  return lookup("whisper-cli") ?? undefined
}

function resolveWhisperModel(env: NodeJS.ProcessEnv) {
  const configured = env.OPENCODE_WHISPER_MODEL?.trim()
  if (configured) return configured
  const root = voiceRoot(env)
  return ["ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin"]
    .map((name) => path.join(root, "whisper", name))
    .find((candidate) => existsSync(candidate))
}

function abortError() {
  const error = new Error("STT cancelado")
  error.name = "AbortError"
  return error
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function buildFfmpegArgs(platform: NodeJS.Platform, file: string, device?: string) {
  const source = device?.trim()
  const macSource = !source || source === "default" ? ":default" : source.startsWith(":") ? source : `:${source}`
  const input =
    platform === "darwin"
      ? ["-f", "avfoundation", "-i", macSource]
      : platform === "win32"
        ? ["-f", "dshow", "-i", source?.startsWith("audio=") ? source : `audio=${source || "default"}`]
        : ["-f", "alsa", "-i", source || "default"]
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...input,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    file,
  ]
}

export async function startFfmpegRecording(
  input: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<MicrophoneRecording> {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-mic-"))
  await chmod(directory, 0o700).catch(() => undefined)
  const file = path.join(directory, "capture.wav")
  let child: ChildProcess
  try {
    child = spawn("ffmpeg", buildFfmpegArgs(input.platform ?? process.platform, file, input.env?.OPENCODE_MIC_DEVICE), {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let output = ""
  let stopped = false
  let resolveResult!: (result: MicrophoneRecordingResult) => void
  const result = new Promise<MicrophoneRecordingResult>((resolve) => {
    resolveResult = resolve
  })
  let finished = false
  const finish = (value: MicrophoneRecordingResult) => {
    if (finished) return
    finished = true
    void chmod(file, 0o600).catch(() => undefined)
    resolveResult(value)
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    if (output.length >= 4096) return
    output += chunk.toString()
  })
  child.once("error", (error) => finish({ interrupted: false, error: messageOf(error) }))
  child.once("close", (code, signal) => {
    const interrupted = stopped || signal === "SIGINT"
    finish({
      interrupted,
      error:
        interrupted || code === 0 ? undefined : output.trim() || `ffmpeg encerrou com código ${code ?? "desconhecido"}`,
    })
  })
  const stop = async () => {
    if (!stopped) {
      stopped = true
      child.kill("SIGINT")
    }
    await result
  }
  const dispose = async () => {
    if (!stopped) {
      stopped = true
      child.kill("SIGINT")
    }
    await result
    await rm(directory, { recursive: true, force: true })
  }
  return { file, result, stop, dispose }
}

function splitCommand(value: string) {
  const tokens: string[] = []
  let token = ""
  let quote: '"' | "'" | undefined
  for (const character of value.trim()) {
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token)
      token = ""
      continue
    }
    token += character
  }
  if (quote) throw new Error("OPENCODE_STTS_COMMAND tem aspas não fechadas")
  if (token) tokens.push(token)
  return tokens
}

function parseJsonCommand(value: unknown): SttCommand | undefined {
  if (Array.isArray(value)) {
    if (!value.every((item): item is string => typeof item === "string") || value.length === 0 || !value[0].trim())
      return undefined
    return { command: value[0], args: value.slice(1) }
  }
  if (!isRecord(value)) return undefined
  if (Array.isArray(value.argv)) {
    if (
      !value.argv.every((item): item is string => typeof item === "string") ||
      value.argv.length === 0 ||
      !value.argv[0].trim()
    )
      return undefined
    return { command: value.argv[0], args: value.argv.slice(1) }
  }
  if (typeof value.command !== "string" || !value.command.trim()) return undefined
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || !value.args.every((item): item is string => typeof item === "string"))
  ) {
    throw new Error("OPENCODE_STTS_COMMAND.args deve ser uma lista de strings")
  }
  return { command: value.command, args: value.args ?? [] }
}

export function parseSttCommand(value: string | undefined): SttCommand | undefined {
  const input = value?.trim()
  if (!input) return undefined
  if (input.startsWith("[") || input.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      throw new Error("OPENCODE_STTS_COMMAND precisa ser um argv JSON válido")
    }
    return parseJsonCommand(parsed)
  }
  const tokens = splitCommand(input)
  if (tokens.length === 0) return undefined
  return { command: tokens[0], args: tokens.slice(1) }
}

export function parseSttBackend(value: string | undefined): SttBackend {
  const backend = value?.trim().toLowerCase()
  if (!backend) return "local"
  if (backend === "local" || backend === "openai" || backend === "auto") return backend
  throw new Error("OPENCODE_STT_BACKEND precisa ser local, openai ou auto")
}

function localStt(
  env: NodeJS.ProcessEnv,
  lookup: (command: string) => string | null | undefined,
): { kind: "command"; command: SttCommand } | { kind: "ffmpeg"; model: string } | undefined {
  const command = parseSttCommand(env.OPENCODE_STTS_COMMAND)
  if (command) return { kind: "command", command }
  const whisperBinary = resolveWhisperBinary(env, lookup)
  const whisperModel = resolveWhisperModel(env)
  if (whisperBinary && whisperModel) {
    return {
      kind: "command",
      command: {
        command: whisperBinary,
        args: ["-m", whisperModel, "-f", "{file}", "-nt", "-np", "-l", env.OPENCODE_STT_LANGUAGE?.trim() || "auto"],
      },
    }
  }
  const model = env.OPENCODE_STT_HMM?.trim() || env.OPENCODE_STT_MODEL?.trim()
  if (model && existsSync(model) && lookup("ffmpeg")) return { kind: "ffmpeg", model }
  return undefined
}

export function buildFfmpegAsrArgs(file: string, env: NodeJS.ProcessEnv = process.env) {
  const model = env.OPENCODE_STT_HMM?.trim() || env.OPENCODE_STT_MODEL?.trim()
  if (!model || !existsSync(model)) return undefined
  const options = [`hmm=${model}`]
  if (env.OPENCODE_STT_DICT?.trim()) options.push(`dict=${env.OPENCODE_STT_DICT.trim()}`)
  if (env.OPENCODE_STT_LM?.trim()) options.push(`lm=${env.OPENCODE_STT_LM.trim()}`)
  const filter = `asr=${options.join(":")},ametadata=mode=print`
  return ["-nostdin", "-hide_banner", "-loglevel", "info", "-i", file, "-af", filter, "-f", "null", "-"]
}

export function buildSttInvocation(command: SttCommand, file: string): SttCommand {
  const hasPlaceholder = command.command.includes("{file}") || command.args.some((arg) => arg.includes("{file}"))
  return {
    command: command.command.replaceAll("{file}", file),
    args: hasPlaceholder ? command.args.map((arg) => arg.replaceAll("{file}", file)) : [...command.args, file],
  }
}

export function parseTranscriptionResponse(output: string): MicrophoneTranscription {
  const text = output.trim()
  if (!text) throw new Error("STT não retornou texto")
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    const spoken = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\[[^\]]+-->[^\]]*\]\s*/, "").trim())
      .filter(Boolean)
    return { text: spoken.length > 0 ? spoken.join(" ") : text }
  }
  if (typeof parsed === "string") return { text: parsed.trim() }
  if (!isRecord(parsed) || typeof parsed.text !== "string" || !parsed.text.trim()) {
    throw new Error("STT não retornou texto")
  }
  const detectedLanguage =
    typeof parsed.language === "string"
      ? parsed.language
      : Array.isArray(parsed.languages) && isRecord(parsed.languages[0]) && typeof parsed.languages[0].code === "string"
        ? parsed.languages[0].code
        : undefined
  return detectedLanguage ? { text: parsed.text.trim(), language: detectedLanguage } : { text: parsed.text.trim() }
}

export function transcribeWithCommand(
  file: string,
  command: SttCommand,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MicrophoneTranscription> {
  if (signal.aborted) return Promise.reject(abortError())
  const invocation = buildSttInvocation(command, file)
  return new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    const child = spawn(invocation.command, invocation.args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      action()
    }
    const onAbort = () => child.kill("SIGINT")
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.resume()
    child.once("error", () => finish(() => reject(new Error("STT local não pôde ser iniciado"))))
    child.once("close", (code, signalName) => {
      if (signal.aborted || signalName === "SIGINT") {
        finish(() => reject(abortError()))
        return
      }
      if (code !== 0) {
        finish(() => reject(new Error(`STT local encerrou com código ${code ?? "desconhecido"}`)))
        return
      }
      try {
        const result = parseTranscriptionResponse(output)
        finish(() => resolve(result))
      } catch (error) {
        finish(() => reject(error))
      }
    })
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export function parseFfmpegAsrResponse(output: string, language?: string): MicrophoneTranscription {
  const text = Array.from(output.matchAll(/lavfi\.asr\.text\s*[=:]\s*(.*)/gi))
    .map((match) => match[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "")
    .filter(Boolean)
    .join(" ")
    .trim()
  if (!text) throw new Error("STT local (PocketSphinx) não retornou texto")
  return language ? { text, language } : { text }
}

export function transcribeWithFfmpegAsr(
  file: string,
  args: string[],
  signal: AbortSignal,
  language?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MicrophoneTranscription> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    const child = spawn("ffmpeg", args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      action()
    }
    const onAbort = () => child.kill("SIGINT")
    const collect = (chunk: Buffer) => {
      if (output.length < 16384) output += chunk.toString()
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.once("error", () => finish(() => reject(new Error("STT local do FFmpeg não pôde ser iniciado"))))
    child.once("close", (code, signalName) => {
      if (signal.aborted || signalName === "SIGINT") {
        finish(() => reject(abortError()))
        return
      }
      if (code !== 0) {
        finish(() => reject(new Error(`STT local do FFmpeg encerrou com código ${code ?? "desconhecido"}`)))
        return
      }
      try {
        finish(() => resolve(parseFfmpegAsrResponse(output, language)))
      } catch (error) {
        finish(() => reject(error))
      }
    })
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export async function transcribeWithOpenAI(
  file: string,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrophoneTranscription> {
  if (signal.aborted) throw abortError()
  const bytes = await readFile(file)
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "capture.wav")
  form.append("model", "whisper-1")
  form.append("response_format", "verbose_json")
  const response = await fetchImpl(OPENAI_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  if (!response.ok) throw new Error(`STT remoto falhou (${response.status})`)
  return parseTranscriptionResponse(await response.text())
}

export function createTranscriber(
  input: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; which?: (command: string) => string | null | undefined } = {},
) {
  const env = input.env ?? process.env
  const lookup = input.which ?? ((command: string) => which(command, env))
  return (file: string, signal: AbortSignal) => {
    const backend = parseSttBackend(env.OPENCODE_STT_BACKEND)
    const local = localStt(env, lookup)
    if (local?.kind === "command") return transcribeWithCommand(file, local.command, signal, env)
    if (local?.kind === "ffmpeg") {
      const args = buildFfmpegAsrArgs(file, env)
      if (args) return transcribeWithFfmpegAsr(file, args, signal, env.OPENCODE_STT_LANGUAGE, env)
    }
    const apiKey = env.OPENAI_API_KEY?.trim()
    if (backend === "openai" || (backend === "auto" && apiKey)) {
      if (!apiKey) return Promise.reject(new Error("OPENCODE_STT_BACKEND=openai exige OPENAI_API_KEY"))
      return transcribeWithOpenAI(file, apiKey, signal, input.fetch)
    }
    return Promise.reject(new Error(DEFAULT_LOCAL_STT_MESSAGE))
  }
}

export function microphoneSupport(input: {
  env: NodeJS.ProcessEnv
  hasFfmpeg: boolean
  which?: (command: string) => string | null | undefined
}) {
  if (!input.hasFfmpeg) return { supported: false as const, reason: "ffmpeg não encontrado no PATH" }
  try {
    const backend = parseSttBackend(input.env.OPENCODE_STT_BACKEND)
    const lookup = input.which ?? ((command: string) => which(command, input.env))
    if (localStt(input.env, lookup)) return { supported: true as const }
    if (backend === "openai" && input.env.OPENAI_API_KEY?.trim()) return { supported: true as const }
    if (backend === "auto" && input.env.OPENAI_API_KEY?.trim()) return { supported: true as const }
    return { supported: false as const, reason: DEFAULT_LOCAL_STT_MESSAGE }
  } catch (error) {
    return { supported: false as const, reason: messageOf(error) }
  }
}

export function createMicrophoneController(options: MicrophoneControllerOptions = {}) {
  const env = options.env ?? process.env
  const lookup = options.which ?? ((command: string) => which(command, env))
  const recorder =
    options.startRecording ??
    (() =>
      startFfmpegRecording({
        platform: options.platform,
        env,
      }))
  const transcriber = options.transcribe ?? createTranscriber({ env, which: lookup })
  const stopSpeak = options.stopSpeak ?? stopTTS
  const [store, setStore] = createStore<{
    state: MicrophoneState
    language?: string
    error?: string
  }>({ state: "idle" })
  let disposed = false
  let operation = 0
  let modeActive = false
  let recording: MicrophoneRecording | undefined
  let stopRequested = false
  let transcriptionAbort: AbortController | undefined

  const setState = (state: MicrophoneState, error?: string) => {
    if (disposed) return
    if (store.state === state && store.error === error) return
    setStore("state", state)
    setStore("error", error)
    options.onState?.(state, error)
  }

  const fail = (token: number, message: string) => {
    if (disposed || token !== operation) return
    setState("error", message)
  }

  const disposeRecording = async (value: MicrophoneRecording) => {
    await Promise.resolve(value.dispose?.()).catch(() => undefined)
  }

  const processRecording = async (value: MicrophoneRecording, result: MicrophoneRecordingResult, token: number) => {
    if (disposed || token !== operation) {
      await disposeRecording(value)
      return
    }
    recording = undefined
    if (result.error) {
      await disposeRecording(value)
      fail(token, result.error)
      return
    }
    if (!options.onTranscription) {
      await disposeRecording(value)
      fail(token, "Nenhum prompt disponível para receber a transcrição")
      return
    }
    const abort = new AbortController()
    transcriptionAbort = abort
    setState("transcribing")
    try {
      const transcription = await transcriber(value.file, abort.signal)
      if (disposed || token !== operation) return
      if (!transcription.text.trim()) throw new Error("STT não retornou texto")
      setStore("language", transcription.language ?? detectLanguage(transcription.text))
      const accepted = await options.onTranscription(transcription)
      if (disposed || token !== operation) return
      if (accepted === false) {
        fail(token, "Não foi possível inserir a transcrição no prompt")
        return
      }
      if (accepted === "paused") {
        setState("paused")
        return
      }
      setState("waiting")
    } catch (error) {
      if (!disposed && token === operation && !abort.signal.aborted) fail(token, messageOf(error))
    } finally {
      if (transcriptionAbort === abort) transcriptionAbort = undefined
      await disposeRecording(value)
    }
  }

  const stopRecording = async (value: MicrophoneRecording) => {
    await Promise.resolve(value.stop())
  }

  const beginRecording = async () => {
    if (disposed) return
    const token = ++operation
    stopSpeak()
    const hasRecorder = options.startRecording !== undefined || Boolean(lookup("ffmpeg"))
    const hasTranscriber = options.transcribe !== undefined || parseConfiguredStt(env, lookup) !== undefined
    if (!hasRecorder || !hasTranscriber) {
      const support = microphoneSupport({ env, hasFfmpeg: hasRecorder, which: lookup })
      if (!support.supported) {
        modeActive = false
        setState("unsupported", support.reason)
        return
      }
    }
    modeActive = true
    stopRequested = false
    setState("recording")
    try {
      const value = await recorder()
      if (disposed || token !== operation) {
        await stopRecording(value).catch(() => undefined)
        await disposeRecording(value)
        return
      }
      recording = value
      const completion = Promise.resolve(value.result).then(
        (result) => processRecording(value, result, token),
        async (error) => {
          if (recording === value) recording = undefined
          await disposeRecording(value)
          fail(token, messageOf(error))
        },
      )
      if (stopRequested) {
        stopRequested = false
        await stopRecording(value).catch((error) => fail(token, messageOf(error)))
      }
      void completion
    } catch (error) {
      fail(token, messageOf(error))
    }
  }

  const pause = () => {
    if (disposed) return
    const current = store.state
    if (current === "recording") {
      const token = operation
      setState("transcribing")
      if (!recording) {
        stopRequested = true
        return
      }
      const value = recording
      void stopRecording(value).catch((error) => fail(token, messageOf(error)))
      return
    }
    if (current === "transcribing") {
      operation += 1
      transcriptionAbort?.abort()
      setState("paused")
      return
    }
    if (current === "waiting" || current === "speaking") {
      operation += 1
      transcriptionAbort?.abort()
      stopSpeak()
      setState("paused")
      return
    }
    void beginRecording()
  }

  const speakResponse = async (text: string, language?: string) => {
    if (disposed || !modeActive || !text.trim()) return false
    const token = ++operation
    stopSpeak()
    transcriptionAbort?.abort()
    const current = recording
    recording = undefined
    if (current) {
      await stopRecording(current).catch(() => undefined)
      await disposeRecording(current)
    }
    if (disposed || token !== operation) return false
    setState("speaking")
    try {
      const result = await (options.speak ?? speak)(text, language)
      if (disposed || token !== operation) return false
      if (result === false) {
        setState("error", "TTS indisponível")
        return false
      }
      setState("paused")
      return true
    } catch (error) {
      if (!disposed && token === operation) setState("error", messageOf(error))
      return false
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    operation += 1
    transcriptionAbort?.abort()
    stopSpeak()
    const current = recording
    recording = undefined
    if (!current) return
    void (async () => {
      await stopRecording(current).catch(() => undefined)
      await disposeRecording(current)
    })()
  }

  const api = {
    state: () => store.state,
    language: () => store.language,
    error: () => store.error,
    active: () => modeActive && store.state !== "error" && store.state !== "unsupported",
    toggle: pause,
    start: beginRecording,
    speakResponse,
    dispose,
  }

  onCleanup(api.dispose)
  return api
}

function parseConfiguredStt(env: NodeJS.ProcessEnv, lookup: (command: string) => string | null | undefined) {
  try {
    if (localStt(env, lookup)) return "local"
    const backend = parseSttBackend(env.OPENCODE_STT_BACKEND)
    if ((backend === "openai" || backend === "auto") && env.OPENAI_API_KEY?.trim()) return "openai"
  } catch {
    return undefined
  }
  return undefined
}

export function insertPromptAtCursor(value: string, cursor: number, text: string) {
  const offset = Math.max(0, Math.min(cursor, value.length))
  return {
    value: value.slice(0, offset) + text + value.slice(offset),
    cursor: offset + text.length,
  }
}
