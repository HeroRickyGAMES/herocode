import { createMemo, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import type { MicrophoneState } from "../../util/microphone"

const StateGlyph: Record<MicrophoneState, string> = {
  idle: "○",
  recording: "●",
  transcribing: "…",
  waiting: "◌",
  speaking: "♪",
  paused: "‖",
  error: "!",
  unsupported: "?",
}

export function MicrophoneButton(props: { state: () => MicrophoneState; onToggle: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const color = createMemo(() => {
    if (props.state() === "recording" || props.state() === "error") return theme.error
    if (props.state() === "speaking") return theme.primary
    if (props.state() === "transcribing" || props.state() === "waiting") return theme.warning
    return theme.textMuted
  })

  return (
    <box
      width={3}
      height={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={hover() ? theme.backgroundPanel : theme.backgroundElement}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onToggle}
    >
      <text fg={color()}>{StateGlyph[props.state()]}</text>
    </box>
  )
}
