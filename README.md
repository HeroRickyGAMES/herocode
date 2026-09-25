<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### What's new in this build

- **Background terminal** — long-running shell commands run in the background, so the agent stays responsive. You get notified when they finish, and live output is streamed while they run.
- **Live Shell panel** — the TUI shows the current output of running background commands in a panel above the prompt. Click a command to focus it and scroll with ↑/↓.
- **Edit last message** — press `↑` in the prompt to reload the last message you sent in the current session and edit it.
- **Natural read-aloud and voice conversation** — the TUI uses a Brazilian Portuguese voice when available, cleans up Markdown, and can record, transcribe, submit, and speak a conversation from the microphone beside the prompt.

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

### TUI voice and read-aloud

The microphone control is shown next to the prompt on both the home screen and active sessions, and `Ctrl+Alt+V` toggles it. The first click records, the second stops and submits the transcript, the completed response is spoken, and the next click resumes listening. `OPENCODE_MIC_DEVICE` selects another `ffmpeg` input device.

The default speech-to-text path is local and never uploads audio:

```bash
sudo apt install ffmpeg
export OPENCODE_STTS_COMMAND='["python3","/path/to/stt.py","{file}"]'
# stt.py receives the WAV path and prints {"text":"...","language":"pt-BR"}
```

You can also use `whisper.cpp` when `whisper-cli` and a multilingual model are installed:

```bash
export OPENCODE_WHISPER_MODEL=/path/to/ggml-base.bin
```

The TUI also detects project-local assets automatically under `.opencode/voice/` (`whisper/bin/whisper-cli`, `whisper/ggml-small.bin`, and `piper/piper/piper` with `pt_BR-faber-medium.onnx`). Set `OPENCODE_VOICE_DIR` to use another project-local directory.

For a local PocketSphinx model, set `OPENCODE_STT_MODEL` to the model directory. OpenAI is opt-in only; set `OPENCODE_STT_BACKEND=openai` and `OPENAI_API_KEY` if you explicitly want remote transcription.

System read-aloud voices are used by default. For a natural Brazilian voice, install Piper and a `pt-BR` model; OpenCode plays it automatically when `piper` and `OPENCODE_TTS_MODEL` are available. The project-local `.opencode/voice/piper/` layout is detected automatically as well:

```bash
export OPENCODE_TTS_MODEL=/path/to/pt_BR-faber-medium.onnx
```

You can also provide any local TTS command with `OPENCODE_TTS_COMMAND`; text is sent through stdin unless the command contains `{text}`. `OPENCODE_TTS_VOICE`, `OPENCODE_TTS_RATE`, and `OPENCODE_TTS_PITCH` tune the system `spd-say` fallback.

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
