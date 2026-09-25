import { createContext, useContext, type ParentProps } from "solid-js"
import { createMicrophoneController } from "../util/microphone"
import { usePromptRef } from "./prompt"
import { useToast } from "../ui/toast"

type Voice = ReturnType<typeof createMicrophoneController>

const VoiceContext = createContext<Voice>()

export function VoiceProvider(props: ParentProps) {
  const promptRef = usePromptRef()
  const toast = useToast()
  const controller = createMicrophoneController({
    onTranscription: (transcription) => {
      const prompt = promptRef.current
      if (!prompt?.insert) return false
      const text = transcription.text.trim()
      prompt.insert(text)
      if (prompt.mode?.() !== "normal" || text.startsWith("/") || ["exit", "quit", ":q"].includes(text.toLowerCase())) {
        return "paused"
      }
      prompt.submit()
      return true
    },
    onState: (state, error) => {
      if (state === "unsupported") {
        toast.show({
          variant: "warning",
          message: error ?? "Microfone indisponível",
          duration: 6000,
        })
      }
      if (state === "error") {
        toast.show({
          variant: "error",
          message: error ? `Falha no microfone: ${error}` : "Falha no microfone",
          duration: 6000,
        })
      }
    },
  })

  const toggle = () => {
    const prompt = promptRef.current
    if (!prompt) {
      toast.show({ message: "Abra um prompt para usar o microfone", variant: "warning", duration: 3000 })
      return
    }
    if (prompt.mode?.() !== "normal") {
      toast.show({ message: "O microfone só pode ser usado no prompt normal", variant: "warning", duration: 3000 })
      return
    }
    controller.toggle()
  }

  return <VoiceContext.Provider value={{ ...controller, toggle }}>{props.children}</VoiceContext.Provider>
}

export function useVoice() {
  const value = useContext(VoiceContext)
  if (!value) throw new Error("Voice context must be used within a VoiceProvider")
  return value
}
