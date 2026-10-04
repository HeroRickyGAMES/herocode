# Instalação do OpenCode Desktop no Windows

Instruções para instalar o app Desktop (Electron) no Windows a partir dos instaladores
gerados por este repositório.

Para **gerar** os instaladores a partir de Linux, veja
[BUILD-WINDOWS.md](./BUILD-WINDOWS.md).

---

## 1. Qual instalador usar

| Arquivo | Arquitetura | Quando usar |
| --- | --- | --- |
| `opencode-desktop-win-x64.exe` | Intel/AMD 64 bits | quase todo PC, notebook e desktop |
| `opencode-desktop-win-arm64.exe` | ARM 64 bits | Surface, Snapdragon, Windows ARM |

Para descobrir a arquitetura do seu Windows:

```powershell
$env:PROCESSOR_ARCHITECTURE
```

- `AMD64` → use o **x64**
- `ARM64` → use o **arm64**

Em Windows ARM o instalador x64 também roda, por emulação, e é uma opção válida se
preferir. O arm64 nativo é mais rápido e usa menos bateria.

## 2. Instalação

O instalador é **NSIS one-click, por usuário** (`perMachine: false`): basta dar duplo
clique e ele instala sem pedir elevação de administrador.

1. Copie o `.exe` para o Windows (pendrive, rede, ou `scp`).
2. Dê duplo clique em `opencode-desktop-win-x64.exe` (ou `-arm64`).
3. Aguarde a extração. O app abre automaticamente.

Instalado em:

```
%LOCALAPPDATA%\Programs\OpenCode Dev\OpenCode Dev.exe
```

O nome é **OpenCode Dev** porque o build usa o canal `dev`, que convive com o OpenCode
oficial sem sobrescrever a instalação existente. Em `%APPDATA%\ai.opencode.desktop.dev\`
ficam as configurações, sessões e logs desse build.

### Desinstalar

`Configurações → Aplicativos → OpenCode Dev → Desinstalar`, ou o item no menu Iniciar.

## 3. O aviso do SmartScreen

Os instaladores deste repositório **não são assinados**. O hook de assinatura em
`electron-builder.config.ts` só roda em `GITHUB_ACTIONS=true` e depende do Azure Trusted
Signing, então um build local sai sem assinatura Authenticode.

Na primeira execução o Windows Defender SmartScreen mostra "O Windows protegeu seu PC":

1. clique em **Mais informações**;
2. clique em **Executar assim mesmo**.

Isso acontece uma vez por máquina. Se preferir liberar antes de instalar:

```powershell
# apenas para este arquivo, na pasta atual
Unblock-File .\opencode-desktop-win-x64.exe
```

Opcionalmente, para o seu usuário:

```powershell
Set-MpPreference -PUAAudit Disable
```

## 4. Terminal integrado e WSL

O app abre o terminal integrado usando o shell padrão do Windows. O módulo WSL aparece
automaticamente quando existe uma distribuição instalada.

Para instalar o WSL a partir do app, ou manualmente:

```powershell
wsl --install -d Ubuntu
```

Depois, dentro da distro, o backend do OpenCode precisa estar instalado:

```bash
curl -fsSL https://opencode.ai/install | bash
```

O app gerencia isso sozinho na primeira conexão, mas você pode adiantar.

## 5. Diagnóstico

Os logs ficam em:

```
%APPDATA%\ai.opencode.desktop.dev\logs\main.log
```

Para ver as últimas linhas:

```powershell
Get-Content "$env:APPDATA\ai.opencode.desktop.dev\logs\main.log" -Tail 50
```

Problemas comuns:

| Sintoma | Causa provável |
| --- | --- |
| "OpenCode Dev Won't Run" no clique duplo | SmartScreen; veja a seção 3 |
| app abre e fecha na hora | `main.log` mostra o erro de inicialização |
| terminal integrado não abre | WSL ausente ou `bash` faltando na distro |
| app pede modelo/API key | configure a chave no app, ou `OPENCODE_API_KEY` |

## 6. Instalação sem instalador (portable)

Se não quiser instalar, use a pasta descompactada vinda do build:

```
packages/desktop/dist/win-unpacked/          # x64
packages/desktop/dist/win-arm64-unpacked/    # arm64
```

Copie a pasta inteira para o Windows e execute `OpenCode Dev.exe` de dentro dela. Nesse
modo o app fica portável, mas perde o atalho no menu Iniciar e a instalação registrada.