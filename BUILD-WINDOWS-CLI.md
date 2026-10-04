# CLI/TUI para Windows (x64 e arm64) — build e instalação

Guia para gerar o binário de terminal (`opencode.exe`) para Windows a partir de
**Linux, macOS ou Windows**, e para instalá-lo no Windows.

> Este guia é da **CLI/TUI** (terminal). O app Desktop (Electron/GUI) é outra coisa e
> exige wine ou um runner Windows — veja `packages/desktop/README.md`.

---

## 1. Docker não é necessário

O binário é um executável autocontido produzido por `Bun.build` com
`compile.target = bun-windows-*`. O Bun faz **cross-compile nativo** para Windows a
partir de qualquer sistema operacional: basta ter o `bun` instalado.

O `build.ts` também baixa os binários do runtime Bun do Windows durante o build
(`bun-windows-x64.zip` / `bun-windows-aarch64.zip`) e os embute no executável. Nada
disso precisa de wine, NSIS ou container.

Docker só seria necessário para o **empacotamento** do app Desktop em instalador
`.exe`, porque o `electron-builder` executa `makensis.exe` (Windows 32 bits) durante o
build. Para a CLI isso não existe.

### Pré-requisitos

- [`bun`](https://bun.sh) instalado
- dependências do repositório instaladas:

```bash
bun install
```

## 2. Build

De dentro de `packages/opencode`:

```bash
bun run build:windows
```

O script `build:windows` equivale a `bun run script/build.ts --windows`, que restringe
os alvos a `win32` e monta apenas `arm64` e `x64` (sem as variantes *baseline*).

Defina a versão explicitamente. Sem `OPENCODE_VERSION`, o build em uma branch que não
seja `main` gera `0.0.0-dev-<timestamp>`, e o servidor pode barrar essa versão:

```bash
OPENCODE_CHANNEL=dev OPENCODE_VERSION=1.18.31 bun run build:windows
```

O build também compila a Web UI embutida em `packages/app` (para o comando `web`) e
baixa as dependências nativas de todas as plataformas, então leva alguns minutos.

### Saída

```
packages/opencode/dist/
├── opencode-windows-x64/
│   ├── bin/opencode.exe      ~166 MB
│   └── package.json
├── opencode-windows-arm64/
│   ├── bin/opencode.exe      ~157 MB
│   └── package.json
├── opencode-windows-x64.zip    ~60 MB
└── opencode-windows-arm64.zip  ~56 MB
```

`dist/` é ignorado pelo git.

### Gerar os zips

O passo de release (`OPENCODE_RELEASE` faz upload para o GitHub) é o que normalmente
cria os `.zip`, então em build local eles não são gerados. Para empacotar:

```bash
cd packages/opencode/dist
for a in x64 arm64; do
  python3 -c "import zipfile,sys; zipfile.ZipFile('opencode-windows-$a.zip','w',zipfile.ZIP_DEFLATED).write('opencode-windows-$a/bin/opencode.exe','opencode.exe')"
done
```

Cada zip contém um único arquivo, `opencode.exe`.

## 3. Instalação no Windows

Escolha o zip pela arquitetura:

| Arquivo | Arquitetura | Quando usar |
| --- | --- | --- |
| `opencode-windows-x64.zip` | Intel/AMD 64 bits | quase todo PC, notebook e desktop |
| `opencode-windows-arm64.zip` | ARM 64 bits | Surface, Snapdragon, Windows ARM |

Para descobrir a sua:

```powershell
$env:PROCESSOR_ARCHITECTURE
```

`AMD64` → **x64**. `ARM64` → **arm64**. Em Windows ARM o binário x64 também roda por
emulação, mas o arm64 nativo é mais rápido.

### x64

1. Extraia o zip. Dentro terá `opencode.exe`.
2. Crie a pasta `%USERPROFILE%\.opencode\bin` e copie o executável para lá:

```powershell
mkdir "$env:USERPROFILE\.opencode\bin" -Force
Copy-Item .\opencode.exe "$env:USERPROFILE\.opencode\bin\opencode.exe"
```

3. Adicione ao `PATH` (uma vez só):

```powershell
setx PATH "$env:USERPROFILE\.opencode\bin;$env:PATH"
```

4. Feche e reabra o terminal.

### arm64

Mesmos passos, usando `opencode-windows-arm64.zip`.

### Teste

```powershell
opencode --version
```

### Uso

```powershell
cd C:\caminho\do\projeto
opencode
```

Sem argumentos o comando abre a TUI interativa. Para uma execução única, não
interativa:

```powershell
opencode run "explique este repositório"
```

## 4. Problemas comuns

| Sintoma | Causa e solução |
| --- | --- |
| `opencode` não é reconhecido | refaça o passo do `PATH` e reabra o terminal |
| SmartScreen / Defender avisa | o binário não é assinado (fork). Clique em **Mais informações** → **Executar assim mesmo**, ou rode `Unblock-File .\opencode.exe` antes |
| Versão antiga barrada pelo servidor | o build local usa `OPENCODE_VERSION`; recompile com a versão da release |
| TUI abre e sai sozinho | falta terminal com suporte a cores/Unicode; prefira o Windows Terminal em vez do `cmd.exe` antigo |
| `opencode.exe --version` dá erro de DLL | o zip foi extraído parcialmente; reextraia e confira o tamanho (≈166 MB no x64) |

## 5. Voz em português brasileiro

Recurso do fork. O botão de microfone aparece na tela inicial e nas sessões ativas, ao
lado do prompt: o primeiro clique grava, o segundo interrompe e envia, e a resposta é
falada automaticamente. `Ctrl+Alt+V` alterna o microfone e `OPENCODE_MIC_DEVICE`
seleciona o dispositivo de entrada quando necessário.

A transcrição é local por padrão. No PowerShell, instale `ffmpeg` e configure um
comando local:

```powershell
$env:OPENCODE_STTS_COMMAND='["python3","C:\\caminho\\stt.py","{file}"]'
```

O comando recebe o WAV e pode imprimir texto simples ou
`{"text":"...","language":"pt-BR"}`. A OpenAI só é usada quando
`OPENCODE_STT_BACKEND=openai` e `OPENAI_API_KEY` estiverem definidos explicitamente.

Para uma voz brasileira mais natural, instale um motor local como Piper e configure
`OPENCODE_TTS_MODEL`; para outro motor, use `OPENCODE_TTS_COMMAND`. Sem esses modelos,
a TUI usa a voz `pt-BR` instalada pelo Windows como fallback.