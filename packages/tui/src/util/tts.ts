import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { platform } from "node:os"
import path from "node:path"
import { createSignal } from "solid-js"
import { which } from "@opencode-ai/core/util/which"
import { isRecord } from "./record"

export type TTSLanguage = "en" | "pt" | "es" | "fr" | "de" | "it" | "nl" | "ja" | "zh" | "ko" | "ru" | "hi" | "ar"

export type TTSCommand = {
  command: string
  args: string[]
  stdin?: string
}

export type TTSCommandOptions = {
  voice?: string
  rate?: string
  pitch?: string
}

export type MacVoice = {
  name: string
  locale: string
}

function splitTtsCommand(value: string) {
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
  if (quote) throw new Error("OPENCODE_TTS_COMMAND tem aspas não fechadas")
  if (token) tokens.push(token)
  return tokens
}

function parseJsonTtsCommand(value: unknown): TTSCommand | undefined {
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
    throw new Error("OPENCODE_TTS_COMMAND.args deve ser uma lista de strings")
  }
  return { command: value.command, args: value.args ?? [] }
}

export function parseTtsCommand(value: string | undefined): TTSCommand | undefined {
  const input = value?.trim()
  if (!input) return undefined
  if (input.startsWith("[") || input.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      throw new Error("OPENCODE_TTS_COMMAND precisa ser um argv JSON válido")
    }
    return parseJsonTtsCommand(parsed)
  }
  const tokens = splitTtsCommand(input)
  if (tokens.length === 0) return undefined
  return { command: tokens[0], args: tokens.slice(1) }
}

export function buildCustomTtsCommand(value: string | undefined, text: string): TTSCommand | undefined {
  const command = parseTtsCommand(value)
  if (!command) return undefined
  const hasPlaceholder = command.command.includes("{text}") || command.args.some((arg) => arg.includes("{text}"))
  return {
    command: command.command.replaceAll("{text}", text),
    args: hasPlaceholder ? command.args.map((arg) => arg.replaceAll("{text}", text)) : command.args,
    stdin: hasPlaceholder ? undefined : text,
  }
}

type ActiveTTS = {
  child: ChildProcess
  finish: (failed: boolean, cancelled?: boolean) => void
}

const LANGUAGES: TTSLanguage[] = ["en", "pt", "es", "fr", "de", "it", "nl", "ja", "zh", "ko", "ru", "hi", "ar"]

const STOPWORDS: Record<TTSLanguage, string[]> = {
  en: [
    "the",
    "and",
    "you",
    "that",
    "this",
    "with",
    "have",
    "are",
    "your",
    "for",
    "not",
    "but",
    "what",
    "hello",
    "hi",
    "how",
    "is",
    "to",
    "of",
    "in",
    "it",
    "we",
    "can",
  ],
  pt: [
    "a",
    "o",
    "as",
    "os",
    "um",
    "uma",
    "uns",
    "umas",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "em",
    "no",
    "na",
    "nos",
    "nas",
    "por",
    "para",
    "com",
    "sem",
    "sob",
    "sobre",
    "entre",
    "até",
    "depois",
    "antes",
    "que",
    "como",
    "quando",
    "onde",
    "porque",
    "pois",
    "mas",
    "porém",
    "contudo",
    "e",
    "ou",
    "se",
    "não",
    "sim",
    "já",
    "ainda",
    "mais",
    "menos",
    "muito",
    "também",
    "assim",
    "então",
    "agora",
    "isso",
    "essa",
    "essas",
    "esses",
    "aquele",
    "aquela",
    "aquilo",
    "aqui",
    "ali",
    "lá",
    "eu",
    "você",
    "vocês",
    "meu",
    "minha",
    "meus",
    "minhas",
    "nosso",
    "nossa",
    "ele",
    "ela",
    "eles",
    "elas",
    "ser",
    "sou",
    "são",
    "é",
    "foi",
    "foram",
    "estar",
    "está",
    "estão",
    "estou",
    "tenho",
    "tem",
    "têm",
    "fazer",
    "faz",
    "feito",
    "fala",
    "falar",
    "oi",
    "tudo",
    "dia",
    "pode",
    "podem",
    "quero",
    "preciso",
    "gostaria",
    "vamos",
    "olá",
    "oi",
    "bom",
    "tudo",
    "bem",
    "pra",
    "pro",
    "né",
    "tô",
    "obg",
    "obrigado",
    "obrigada",
    "gente",
    "pessoal",
    "hoje",
    "amanhã",
    "ontem",
    "trabalho",
    "vida",
    "favor",
    "ação",
    "ações",
    "atenção",
    "informação",
    "informações",
    "código",
    "códigos",
  ],
  es: [
    "que",
    "como",
    "para",
    "con",
    "usted",
    "porque",
    "también",
    "esta",
    "esto",
    "pero",
    "hola",
    "gracias",
    "está",
    "estás",
    "estas",
    "muy",
    "bien",
    "y",
    "el",
    "la",
    "de",
    "por",
    "no",
    "nos",
    "yo",
    "se",
  ],
  fr: [
    "que",
    "avec",
    "pour",
    "vous",
    "aussi",
    "c'est",
    "comme",
    "mais",
    "cette",
    "bonjour",
    "salut",
    "merci",
    "comment",
    "allez",
    "est",
    "ce",
    "nous",
    "je",
    "et",
    "une",
    "des",
    "dans",
    "sur",
    "pas",
  ],
  de: [
    "und",
    "ich",
    "du",
    "mit",
    "für",
    "das",
    "wie",
    "auch",
    "nicht",
    "ist",
    "ein",
    "eine",
    "einen",
    "wir",
    "sie",
    "aber",
    "oder",
    "dass",
    "hallo",
  ],
  it: [
    "che",
    "con",
    "per",
    "come",
    "anche",
    "questa",
    "ma",
    "più",
    "ciao",
    "stai",
    "sono",
    "non",
    "del",
    "della",
    "gli",
    "una",
  ],
  nl: ["en", "het", "een", "met", "voor", "ook", "niet", "dat", "hallo", "is", "zijn", "maar", "ik", "je"],
  ja: [],
  zh: [],
  ko: [],
  ru: [],
  hi: [],
  ar: [],
}

const LANGUAGE_HINTS: Partial<Record<TTSLanguage, RegExp[]>> = {
  pt: [/[ãõ]/iu, /\b(?:ção|ções|nh|lh|mente|ário|ória|ável|ível|ãe|õe)\b/iu],
}

const ESpeakLang: Record<TTSLanguage, string> = {
  en: "en-us",
  pt: "pt-br",
  es: "es",
  fr: "fr",
  de: "de",
  it: "it",
  nl: "nl",
  ja: "ja",
  zh: "cmn",
  ko: "ko",
  ru: "ru",
  hi: "hi",
  ar: "ar",
}

const WindowsCulture: Record<TTSLanguage, string> = {
  en: "en-US",
  pt: "pt-BR",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  nl: "nl-NL",
  ja: "ja-JP",
  zh: "zh-CN",
  ko: "ko-KR",
  ru: "ru-RU",
  hi: "hi-IN",
  ar: "ar-SA",
}

const DefaultMacVoice: Record<TTSLanguage, string> = {
  en: "Samantha",
  pt: "Luciana",
  es: "Paulina",
  fr: "Amelie",
  de: "Anna",
  it: "Alice",
  nl: "Xander",
  ja: "Kyoko",
  zh: "Mei-Jia",
  ko: "Yuna",
  ru: "Milena",
  hi: "Lekha",
  ar: "Maged",
}

const BrazilianVoicePriority = [
  "Luciana",
  "Joana",
  "Fernanda",
  "Marina",
  "Daniel",
  "Antonio",
  "Carol",
  "Yara",
  "Helena",
]
const MacRate = "175"

let active: ActiveTTS | undefined
let cachedMacVoices: MacVoice[] | undefined

export const [speaking, setSpeaking] = createSignal(false)

export function cleanTTStext(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*(?:```|~~~)[ \t]*|$)/g, "")
    .replace(/<\/?[A-Za-z][^>\n]*>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/`+[^`\n]*`+/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])(?:\s+|$)/gm, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function foldWord(word: string) {
  return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

export function detectLanguage(text: string): TTSLanguage {
  if (/[\u3040-\u30ff]/.test(text)) return "ja"
  if (/[\uac00-\ud7af]/.test(text)) return "ko"
  if (/[\u4e00-\u9fff]/.test(text)) return "zh"
  if (/[\u0400-\u04ff]/i.test(text)) return "ru"
  if (/[\u0900-\u097f]/.test(text)) return "hi"
  if (/[\u0600-\u06ff]/.test(text)) return "ar"

  const words =
    text
      .toLowerCase()
      .match(/[\p{L}\p{M}']+/gu)
      ?.map(foldWord) ?? []
  const frequency = words.reduce(
    (counts, word) => counts.set(word, (counts.get(word) ?? 0) + 1),
    new Map<string, number>(),
  )
  const scores = LANGUAGES.map((language) => ({
    language,
    score:
      STOPWORDS[language].reduce(
        (score, stopword) => score + (stopword.length === 1 ? 0 : (frequency.get(foldWord(stopword)) ?? 0)),
        0,
      ) + (LANGUAGE_HINTS[language]?.reduce((score, pattern) => score + (pattern.test(text) ? 2 : 0), 0) ?? 0),
  }))

  return scores.reduce((best, current) => (current.score > best.score ? current : best), {
    language: "en" as TTSLanguage,
    score: 0,
  }).language
}

export function normalizeTTSLanguage(language: string | undefined) {
  if (!language) return undefined
  const aliases: Record<string, string> = {
    português: "pt",
    portuguese: "pt",
    "português (brasil)": "pt",
  }
  const value = language.trim().replace(/_/g, "-").toLowerCase()
  const code = aliases[value] ?? value.split("-")[0]
  return LANGUAGES.find((item) => item === code)
}

export function parseMacVoices(output: string): MacVoice[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.+?)\s+([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,})?)(?:\s+#.*)?$/)
    if (!match) return []
    return [{ name: match[1].trim(), locale: match[2].trim() }]
  })
}

function localeLanguage(locale: string) {
  return locale.replace(/_/g, "-").toLowerCase().split("-")[0] ?? ""
}

export function selectMacVoice(voices: MacVoice[], language: TTSLanguage) {
  const matching = voices.filter((voice) => localeLanguage(voice.locale) === language)
  if (language !== "pt") return voices.find((voice) => voice.name === DefaultMacVoice[language]) ?? matching[0]

  const brazilian = matching.filter(
    (voice) => localeLanguage(voice.locale) === "pt" && voice.locale.replace(/_/g, "-").toLowerCase() === "pt-br",
  )
  const preferred = brazilian
    .filter((voice) => BrazilianVoicePriority.includes(voice.name))
    .toSorted(
      (left, right) => BrazilianVoicePriority.indexOf(left.name) - BrazilianVoicePriority.indexOf(right.name),
    )[0]
  return preferred ?? brazilian[0] ?? matching[0]
}

export function buildMacCommand(text: string, language: TTSLanguage, voices: MacVoice[] = []): TTSCommand {
  const voice = selectMacVoice(voices, language)
  return {
    command: "say",
    args: [...(voice ? ["-v", voice.name] : []), "-r", MacRate, text],
  }
}

function discoverMacVoices() {
  if (cachedMacVoices) return cachedMacVoices
  const result = spawnSync("say", ["-v", "?"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) return (cachedMacVoices = [])
  return (cachedMacVoices = parseMacVoices(result.stdout || ""))
}

function windowsScript(language: TTSLanguage) {
  return [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$voices = @($synth.GetInstalledVoices()) | Where-Object { $_.Enabled }",
    `$voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq '${WindowsCulture[language]}' } | Select-Object -First 1`,
    "if ($null -eq $voice) { $voice = $voices | Select-Object -First 1 }",
    "if ($null -ne $voice) { try { $null = $synth.SelectVoice($voice.VoiceInfo.Name) } catch {} }",
    "try { $synth.Rate = 0 } catch {}",
    "try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding } catch {}",
    "try { $synth.Speak([Console]::In.ReadToEnd()) } finally { $synth.Dispose() }",
  ].join("; ")
}

export function buildWindowsCommand(text: string, language: TTSLanguage): TTSCommand {
  return {
    command: "powershell.exe",
    args: ["-NonInteractive", "-NoProfile", "-Command", windowsScript(language)],
    stdin: text,
  }
}

function buildESpeakCommand(text: string, language: TTSLanguage, available: ReadonlySet<string>) {
  const engine = ["espeak-ng", "espeak"].find((name) => available.has(name))
  return engine
    ? {
        command: engine,
        args: ["-v", ESpeakLang[language], text],
      }
    : undefined
}

export function buildLinuxCommand(
  text: string,
  language: TTSLanguage,
  available: ReadonlySet<string>,
  options: TTSCommandOptions = {},
): TTSCommand | undefined {
  if (available.has("spd-say")) {
    return {
      command: "spd-say",
      args: [
        "-l",
        language === "pt" ? "pt-BR" : language,
        ...(options.voice ? ["-y", options.voice] : []),
        ...(options.rate ? ["-r", options.rate] : []),
        ...(options.pitch ? ["-p", options.pitch] : []),
        "-w",
        text,
      ],
    }
  }
  return buildESpeakCommand(text, language, available)
}

function voiceRoot(env: NodeJS.ProcessEnv) {
  const configured = env.OPENCODE_VOICE_DIR?.trim()
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".opencode", "voice")
}

function resolvePiperBinary(env: NodeJS.ProcessEnv) {
  const configured = env.OPENCODE_PIPER_BIN?.trim()
  if (configured) return configured
  const local = path.join(voiceRoot(env), "piper", "piper", "piper")
  if (existsSync(local)) return local
  return which("piper") ?? undefined
}

function resolvePiperModel(env: NodeJS.ProcessEnv) {
  const configured = env.OPENCODE_TTS_MODEL?.trim()
  if (configured) return configured
  const local = path.join(voiceRoot(env), "piper", "pt_BR-faber-medium.onnx")
  return existsSync(local) ? local : undefined
}

function buildPiperCommand(text: string, os: NodeJS.Platform, env: NodeJS.ProcessEnv): TTSCommand | undefined {
  if (os === "win32") return undefined
  const piper = resolvePiperBinary(env)
  const model = resolvePiperModel(env)
  if (!piper || !model || !which("bash")) return undefined
  const player =
    os === "darwin"
      ? which("afplay")
        ? 'afplay "$tmp"'
        : undefined
      : which("paplay")
        ? 'paplay "$tmp"'
        : which("pw-play")
          ? 'pw-play "$tmp"'
          : which("aplay")
            ? 'aplay "$tmp"'
            : which("ffplay")
              ? 'ffplay -nodisp -autoexit -loglevel quiet "$tmp"'
              : undefined
  if (!player) return undefined
  const script = [
    'tmp=$(mktemp "${TMPDIR:-/tmp}/opencode-voice-XXXXXX.wav")',
    '"$1" --model "$2" --output_file "$tmp"',
    "status=$?",
    'if [ "$status" -eq 0 ]; then ' + player + "; status=$?; fi",
    'rm -f "$tmp"',
    'exit "$status"',
  ].join("; ")
  return { command: "bash", args: ["-c", script, "opencode-tts", piper, model], stdin: text }
}

function speakWithSystem(text: string, language: TTSLanguage): Promise<boolean> {
  const os = platform()
  if (os === "darwin") {
    if (!which("say")) return Promise.resolve(false)
    return new Promise((resolve) => {
      spawnTTS(buildMacCommand(text, language, discoverMacVoices()), undefined, resolve)
    })
  }

  if (os === "win32") {
    if (!which("powershell.exe")) return Promise.resolve(false)
    return new Promise((resolve) => {
      spawnTTS(buildWindowsCommand(text, language), undefined, resolve)
    })
  }

  const available = new Set(["spd-say", "espeak-ng", "espeak"].filter((name) => Boolean(which(name))))
  const command = buildLinuxCommand(text, language, available, {
    voice: process.env.OPENCODE_TTS_VOICE,
    rate: process.env.OPENCODE_TTS_RATE,
    pitch: process.env.OPENCODE_TTS_PITCH,
  })
  if (!command) return Promise.resolve(false)
  const fallback = command.command === "spd-say" ? buildESpeakCommand(text, language, available) : undefined
  return new Promise((resolve) => {
    const launch = (value: TTSCommand, retry?: TTSCommand) => {
      spawnTTS(value, retry ? () => launch(retry) : undefined, resolve)
    }
    launch(command, fallback)
  })
}

function spawnTTS(command: TTSCommand, onFailure?: () => void, onFinish?: (success: boolean) => void) {
  if (active) {
    onFinish?.(false)
    return
  }
  const child = spawn(command.command, command.args, {
    stdio: command.stdin === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
  })
  let owner: ActiveTTS
  const finish = (failed: boolean, cancelled = false) => {
    if (active !== owner) return
    active = undefined
    setSpeaking(false)
    if (cancelled) {
      onFinish?.(false)
      return
    }
    if (failed && onFailure) {
      onFailure()
      return
    }
    onFinish?.(!failed)
  }
  owner = { child, finish }
  active = owner
  setSpeaking(true)

  child.on("error", () => finish(true))
  child.on("exit", (code) => finish(code !== 0))
  if (command.stdin !== undefined) {
    child.stdin?.on("error", () => {
      finish(false)
      child.kill()
    })
    child.stdin?.end(command.stdin, "utf8")
  }
}

export function stopTTS() {
  const owner = active
  if (!owner) return
  owner.finish(true, true)
  owner.child.kill()
}

export function speak(text: string, language?: string): Promise<boolean> {
  if (active || speaking()) return Promise.resolve(false)
  const prepared = cleanTTStext(text)
  if (!prepared) return Promise.resolve(false)

  const selectedLanguage = normalizeTTSLanguage(language) ?? detectLanguage(prepared)
  let custom: TTSCommand | undefined
  try {
    custom = buildCustomTtsCommand(process.env.OPENCODE_TTS_COMMAND, prepared)
  } catch {
    return Promise.resolve(false)
  }
  const system = () => speakWithSystem(prepared, selectedLanguage)
  if (custom) {
    return new Promise((resolve) => {
      spawnTTS(custom, () => system().then(resolve), resolve)
    })
  }
  const piper = buildPiperCommand(prepared, platform(), process.env)
  if (piper) {
    return new Promise((resolve) => {
      spawnTTS(piper, () => system().then(resolve), resolve)
    })
  }
  return system()
}

export function toggleSpeak(text: string, language?: string) {
  if (active || speaking()) {
    stopTTS()
    return
  }
  void speak(text, language)
}
