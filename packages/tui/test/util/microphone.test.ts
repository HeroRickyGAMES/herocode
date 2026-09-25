import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  buildFfmpegArgs,
  buildFfmpegAsrArgs,
  buildSttInvocation,
  createMicrophoneController,
  insertPromptAtCursor,
  microphoneSupport,
  parseFfmpegAsrResponse,
  parseSttBackend,
  parseSttCommand,
  parseTranscriptionResponse,
  type MicrophoneRecordingResult,
} from "../../src/util/microphone"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("util.microphone", () => {
  test("builds platform-specific ffmpeg arguments without a shell", () => {
    expect(buildFfmpegArgs("linux", "/tmp/capture.wav")).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "alsa",
      "-i",
      "default",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "/tmp/capture.wav",
    ])
    expect(buildFfmpegArgs("darwin", "/tmp/capture.wav")).toContain(":default")
    expect(buildFfmpegArgs("darwin", "/tmp/capture.wav", ":1")).toContain(":1")
    expect(buildFfmpegArgs("win32", "/tmp/capture.wav", "Microphone")).toContain("audio=Microphone")
  })

  test("parses local argv forms and appends the WAV path", () => {
    expect(parseSttCommand('["whisper-cli", "--model", "small"]')).toEqual({
      command: "whisper-cli",
      args: ["--model", "small"],
    })
    expect(parseSttCommand('{"command":"python","args":["transcribe.py","{file}"]}')).toEqual({
      command: "python",
      args: ["transcribe.py", "{file}"],
    })
    expect(parseSttCommand('python "transcribe.py" --json')).toEqual({
      command: "python",
      args: ["transcribe.py", "--json"],
    })
    expect(buildSttInvocation({ command: "whisper-cli", args: ["--json"] }, "/tmp/a b.wav")).toEqual({
      command: "whisper-cli",
      args: ["--json", "/tmp/a b.wav"],
    })
    expect(buildSttInvocation({ command: "whisper-cli", args: ["{file}"] }, "/tmp/a.wav")).toEqual({
      command: "whisper-cli",
      args: ["/tmp/a.wav"],
    })
    expect(buildSttInvocation({ command: "{file}", args: [] }, "/tmp/a.wav")).toEqual({
      command: "/tmp/a.wav",
      args: [],
    })
  })

  test("parses JSON and plain STT responses while preserving language", () => {
    expect(parseTranscriptionResponse('{"text":"Olá","language":"pt-BR"}')).toEqual({
      text: "Olá",
      language: "pt-BR",
    })
    expect(parseTranscriptionResponse("  hello  ")).toEqual({ text: "hello" })
    expect(parseTranscriptionResponse('{"text":"Olá","languages":[{"code":"pt-BR"}]}')).toEqual({
      text: "Olá",
      language: "pt-BR",
    })
    expect(() => parseTranscriptionResponse('{"text":""}')).toThrow()
  })

  test("uses local STT by default and requires an explicit opt-in for OpenAI", () => {
    expect(microphoneSupport({ env: {}, hasFfmpeg: true })).toEqual({
      supported: false,
      reason:
        "Nenhum STT local encontrado. Configure OPENCODE_STTS_COMMAND, OPENCODE_WHISPER_MODEL ou OPENCODE_STT_MODEL; OpenAI exige OPENCODE_STT_BACKEND=openai",
    })
    expect(microphoneSupport({ env: { OPENAI_API_KEY: "secret" }, hasFfmpeg: true }).supported).toBe(false)
    expect(
      microphoneSupport({
        env: { OPENAI_API_KEY: "secret", OPENCODE_STT_BACKEND: "openai" },
        hasFfmpeg: true,
      }),
    ).toEqual({ supported: true })
  })

  test("parses backend selection and FFmpeg ASR responses", () => {
    expect(parseSttBackend(undefined)).toBe("local")
    expect(parseSttBackend("AUTO")).toBe("auto")
    expect(() => parseSttBackend("other")).toThrow("OPENCODE_STT_BACKEND")
    expect(parseFfmpegAsrResponse("lavfi.asr.text: 'Olá do microfone'")).toEqual({
      text: "Olá do microfone",
    })
    expect(buildFfmpegAsrArgs("/tmp/capture.wav", { OPENCODE_STT_MODEL: "/missing/model" })).toBeUndefined()
    expect(buildFfmpegAsrArgs("/tmp/capture.wav", { OPENCODE_STT_MODEL: process.execPath })?.join(" ")).toContain(
      "ametadata=mode=print",
    )
  })

  test("owns recording and transcription state without audio or network", async () => {
    const result = deferred<MicrophoneRecordingResult>()
    const spoken = deferred<boolean>()
    const recordings: string[] = []
    const stops: string[] = []
    let rootDispose: (() => void) | undefined
    const controller = createRoot((dispose) => {
      rootDispose = dispose
      return createMicrophoneController({
        env: { OPENCODE_STTS_COMMAND: "local-stt" },
        which: () => "/fake/ffmpeg",
        startRecording: () => ({
          file: "/private/capture.wav",
          result: result.promise,
          stop: async () => {
            stops.push("/private/capture.wav")
            result.resolve({ interrupted: true })
          },
          dispose: () => {
            recordings.push("disposed")
          },
        }),
        transcribe: async () => ({ text: "fale", language: "pt-BR" }),
        onTranscription: (transcription) => {
          expect(transcription.text).toBe("fale")
          return true
        },
        speak: () => spoken.promise,
      })
    })

    try {
      controller.toggle()
      await flush()
      expect(controller.state()).toBe("recording")
      controller.toggle()
      expect(controller.state()).toBe("transcribing")
      expect(stops).toEqual(["/private/capture.wav"])
      await flush()
      expect(controller.state()).toBe("waiting")
      expect(controller.language()).toBe("pt-BR")
      expect(recordings).toEqual(["disposed"])

      const speaking = controller.speakResponse("resposta", controller.language())
      expect(controller.state()).toBe("speaking")
      controller.toggle()
      spoken.resolve(true)
      expect(await speaking).toBe(false)
      expect(controller.state()).toBe("paused")
    } finally {
      controller.dispose()
      rootDispose?.()
    }
  })

  test("reports unsupported when capture or transcription is unavailable", async () => {
    let rootDispose: (() => void) | undefined
    const controller = createRoot((dispose) => {
      rootDispose = dispose
      return createMicrophoneController({
        env: {},
        which: () => null,
      })
    })
    try {
      controller.toggle()
      await flush()
      expect(controller.state()).toBe("unsupported")
      expect(controller.error()).toContain("ffmpeg")
    } finally {
      controller.dispose()
      rootDispose?.()
    }
  })

  test("inserts prompt text at the cursor without replacing existing text", () => {
    expect(insertPromptAtCursor("ab", 1, "XY")).toEqual({ value: "aXYb", cursor: 3 })
    expect(insertPromptAtCursor("ab", 99, "!")).toEqual({ value: "ab!", cursor: 3 })
  })
})
