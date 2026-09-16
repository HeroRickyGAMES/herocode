import { spawn, type ChildProcess } from "node:child_process"
import { platform } from "node:os"
import { createSignal } from "solid-js"
import { which } from "@opencode-ai/core/util/which"

type TTSLanguage = "en" | "pt" | "es" | "fr" | "de" | "it" | "nl" | "ja" | "zh" | "ko" | "ru" | "hi" | "ar"

const LANGUAGES: TTSLanguage[] = ["en", "pt", "es", "fr", "de", "it", "nl", "ja", "zh", "ko", "ru", "hi", "ar"]

const STOPWORDS: Record<TTSLanguage, string[]> = {
  en: ["the", "and", "you", "that", "this", "with", "have", "are", "your", "for", "not", "but", "what"],
  pt: ["que", "para", "com", "uma", "não", "você", "como", "mas", "isso", "também", "essa", "estar"],
  es: ["que", "como", "para", "con", "usted", "porque", "también", "esta", "esto", "pero"],
  fr: ["que", "avec", "pour", "vous", "aussi", "c'est", "comme", "mais", "cette"],
  de: ["und", "ich", "du", "mit", "für", "das", "wie", "auch", "nicht"],
  it: ["che", "con", "per", "come", "anche", "questa", "ma", "più"],
  nl: ["en", "het", "een", "met", "voor", "ook", "niet", "dat"],
  ja: [],
  zh: [],
  ko: [],
  ru: [],
  hi: [],
  ar: [],
}

const ESpeakLang: Record<TTSLanguage, string> = {
  en: "en-us",
  pt: "pt",
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

const SayVoice: Record<TTSLanguage, string> = {
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

export const [speaking, setSpeaking] = createSignal(false)

let active: ChildProcess | undefined

export function stopTTS() {
  active?.kill()
  active = undefined
  setSpeaking(false)
}

function detectLanguage(text: string): TTSLanguage {
  if (/[\u3040-\u30ff]/.test(text)) return "ja"
  if (/[\uac00-\ud7af]/.test(text)) return "ko"
  if (/[\u4e00-\u9fff]/.test(text)) return "zh"
  if (/[\u0400-\u04ff]/i.test(text)) return "ru"
  if (/[\u0900-\u097f]/.test(text)) return "hi"
  if (/[\u0600-\u06ff]/.test(text)) return "ar"

  const words = text.toLowerCase().match(/[a-zà-ÿ']+/g) ?? []
  const freq = new Map<string, number>()
  for (const word of words) freq.set(word, (freq.get(word) ?? 0) + 1)

  let best: TTSLanguage = "en"
  let bestScore = 0
  for (const lang of LANGUAGES) {
    let score = 0
    for (const stop of STOPWORDS[lang]) score += freq.get(stop) ?? 0
    if (score > bestScore) {
      best = lang
      bestScore = score
    }
  }
  return best
}

export function toggleSpeak(text: string) {
  if (speaking()) {
    stopTTS()
    return
  }
  const trimmed = text.trim()
  if (!trimmed) return

  const lang = detectLanguage(trimmed)
  const os = platform()
  let child: ChildProcess | undefined

  if (os === "darwin") {
    if (!which("say")) return
    child = spawn("say", ["-v", SayVoice[lang], trimmed], { stdio: "ignore" })
  } else if (os === "win32") {
    if (!which("powershell.exe")) return
    const escaped = trimmed.replace(/'/g, "''")
    const script =
      "Add-Type -AssemblyName System.Speech;$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.Speak('" +
      escaped +
      "')"
    child = spawn("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", script], { stdio: "ignore" })
  } else {
    const engine = ["espeak-ng", "espeak", "spd-say"].find((name) => which(name))
    if (!engine) return
    child =
      engine === "spd-say"
        ? spawn("spd-say", [trimmed], { stdio: "ignore" })
        : spawn(engine, ["-v", ESpeakLang[lang], trimmed], { stdio: "ignore" })
  }

  if (!child) return
  active = child
  setSpeaking(true)
  child.on("error", () => stopTTS())
  child.on("exit", () => {
    if (active === child) stopTTS()
  })
}