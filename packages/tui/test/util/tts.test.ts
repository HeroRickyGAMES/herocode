import { describe, expect, test } from "bun:test"
import {
  buildCustomTtsCommand,
  buildLinuxCommand,
  buildMacCommand,
  buildWindowsCommand,
  cleanTTStext,
  detectLanguage,
  normalizeTTSLanguage,
  parseMacVoices,
  selectMacVoice,
} from "../../src/util/tts"

describe("util.tts", () => {
  test("detects Brazilian Portuguese using accented stopwords", () => {
    expect(detectLanguage("Olá, tudo bem? Não sei.")).toBe("pt")
    expect(detectLanguage("Bom dia, tudo bem?")).toBe("pt")
    expect(detectLanguage("A ação foi feita com atenção.")).toBe("pt")
    expect(detectLanguage("Hello, how are you?")).toBe("en")
    expect(detectLanguage("Hola, ¿cómo estás?")).toBe("es")
    expect(detectLanguage("Fala")).toBe("pt")
    expect(normalizeTTSLanguage("Português (Brasil)")).toBe("pt")
  })

  test("maps Portuguese to the regional eSpeak and spd-say locales", () => {
    expect(buildLinuxCommand("Olá", "pt", new Set(["espeak-ng"]))).toEqual({
      command: "espeak-ng",
      args: ["-v", "pt-br", "Olá"],
    })
    expect(buildLinuxCommand("Olá", "pt", new Set(["spd-say", "espeak-ng"]))).toEqual({
      command: "spd-say",
      args: ["-l", "pt-BR", "-w", "Olá"],
    })
    expect(buildLinuxCommand("Hello", "en", new Set())).toBeUndefined()
  })

  test("supports a local TTS command with stdin or a text placeholder", () => {
    expect(buildCustomTtsCommand("piper --model voice.onnx", "Olá")).toEqual({
      command: "piper",
      args: ["--model", "voice.onnx"],
      stdin: "Olá",
    })
    expect(buildCustomTtsCommand('["voice-cli","--text","{text}"]', "Olá")).toEqual({
      command: "voice-cli",
      args: ["--text", "Olá"],
    })
  })

  test("passes optional voice controls to spd-say", () => {
    expect(
      buildLinuxCommand("Olá", "pt", new Set(["spd-say"]), {
        voice: "Portuguese (Brazil)+female3",
        rate: "-10",
        pitch: "5",
      }),
    ).toEqual({
      command: "spd-say",
      args: ["-l", "pt-BR", "-y", "Portuguese (Brazil)+female3", "-r", "-10", "-p", "5", "-w", "Olá"],
    })
  })

  test("prefers an installed Brazilian macOS voice and falls back safely", () => {
    const voices = parseMacVoices(
      [
        "Samantha             en_US    # Most people recognize me by my voice.",
        "Luciana               pt_BR    # Brazilian Portuguese",
        "Joana                 pt_PT    # Portuguese",
      ].join("\n"),
    )
    expect(selectMacVoice(voices, "pt")?.name).toBe("Luciana")
    expect(selectMacVoice([{ name: "Joana", locale: "pt_PT" }], "pt")?.name).toBe("Joana")
    expect(buildMacCommand("Olá", "pt", voices)).toEqual({
      command: "say",
      args: ["-v", "Luciana", "-r", "175", "Olá"],
    })
    expect(buildMacCommand("Hello", "en", [])).toEqual({
      command: "say",
      args: ["-r", "175", "Hello"],
    })
  })

  test("sends Windows text through stdin and selects an enabled regional voice", () => {
    const text = "Segredo 'quoted' com ç"
    const command = buildWindowsCommand(text, "pt")
    const script = command.args.at(-1) ?? ""
    expect(command.command).toBe("powershell.exe")
    expect(command.stdin).toBe(text)
    expect(command.args).not.toContain(text)
    expect(script).toContain("System.Speech")
    expect(script).toContain("Enabled")
    expect(script).toContain("pt-BR")
    expect(script).toContain("ReadToEnd")
  })

  test("removes technical Markdown without changing spoken prose", () => {
    expect(cleanTTStext("**Olá**, veja [isto](https://example.test).\n\n```ts\nconst secret = 1\n```")).toBe(
      "Olá, veja isto.",
    )
    expect(cleanTTStext("A resposta é simples.")).toBe("A resposta é simples.")
  })
})
