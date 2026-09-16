import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { JobInfo } from "@opencode-ai/sdk/v2"
import type { KeyEvent, MouseEvent } from "@opentui/core"
import { Spinner } from "../../component/spinner"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import stripAnsi from "strip-ansi"

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

const maxTailLines = 6

function ShellJobBlock(props: { command: string; status: JobInfo["status"]; output: string }) {
  const { theme } = useTheme()
  const [focused, setFocused] = createSignal(false)
  const [offset, setOffset] = createSignal(0)
  const lines = createMemo(() => (props.output ? props.output.split("\n") : []))
  const maxOffset = createMemo(() => Math.max(0, lines().length - maxTailLines))
  const visible = createMemo(() => {
    const start = Math.max(0, lines().length - maxTailLines - offset())
    return lines().slice(start)
  })

  return (
    <box
      flexShrink={0}
      onMouseDown={(event: MouseEvent) => {
        setFocused(true)
        event.target?.focus()
      }}
      onKeyDown={(event: KeyEvent) => {
        if (!focused()) return
        if (event.name === "up") {
          setOffset((value) => Math.min(maxOffset(), value + 1))
          event.preventDefault()
        } else if (event.name === "down") {
          setOffset((value) => Math.max(0, value - 1))
          event.preventDefault()
        } else {
          return
        }
        event.stopPropagation()
      }}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={focused() ? theme.borderActive : theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} wrapMode="none">
              $ {props.command}
            </text>
            <Show
              when={props.status === "running"}
              fallback={<text fg={theme.textMuted}>{props.status}</text>}
            >
              <Spinner color={theme.textMuted}>running</Spinner>
            </Show>
          </box>
          <Show when={offset() > 0}>
            <text fg={theme.textMuted}>
              ↑ {offset()} {offset() === 1 ? "line" : "lines"}
            </text>
          </Show>
        </box>
        <Show when={visible().length > 0}>
          <box marginTop={1}>
            <text fg={theme.text} wrapMode="none">
              {visible().join("\n")}
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}

function jobTail(job: JobInfo) {
  const live = stringValue(job.metadata?.output_tail)
  return stripAnsi(live ?? job.output ?? "")
}

export function ShellPanel(props: { sessionID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const [jobs, setJobs] = createSignal<JobInfo[]>([])

  const fromParts = createMemo(() => {
    const out = new Map<string, string>()
    for (const msg of sync.data.message[props.sessionID] ?? []) {
      if (msg.role !== "assistant") continue
      for (const part of sync.data.part[msg.id] ?? []) {
        if (part.type !== "tool" || part.tool !== "bash") continue
        if (part.state.status === "pending") continue
        const meta = part.state.metadata
        if (meta?.background !== true) continue
        const jobId = stringValue(meta.jobId)
        if (!jobId) continue
        out.set(jobId, stringValue(meta.command) ?? "")
      }
    }
    return out
  })

  const poll = async () => {
    try {
      const res = await sdk.client.experimental.job.list({ sessionID: props.sessionID }, { throwOnError: true })
      // Only live jobs are shown; once a job finishes, the notifier surfaces the
      // result in the transcript so the panel can drop the entry.
      const running = (res.data ?? []).filter((job) => job.status === "running")
      const byId = new Map(running.map((job) => [job.id, job] as const))
      for (const [jobId, command] of fromParts()) {
        const job = byId.get(jobId)
        if (!job || stringValue(job.metadata?.command)) continue
        byId.set(jobId, { ...job, metadata: { ...job.metadata, command } })
      }
      const next = [...byId.values()]
      setJobs((prev) => {
        if (prev.length === next.length && prev.every((job, index) => job.id === next[index]?.id)) return prev
        return next
      })
    } catch {
      // Keep the last known state on transient failures.
    }
  }

  onMount(() => {
    void poll()
    const timer = setInterval(poll, 1500)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={jobs().length > 0}>
      <box flexShrink={0}>
        <For each={jobs()}>
          {(job) => (
            <ShellJobBlock
              command={stringValue(job.metadata?.command) ?? job.title ?? job.id}
              status={job.status}
              output={jobTail(job)}
            />
          )}
        </For>
      </box>
    </Show>
  )
}