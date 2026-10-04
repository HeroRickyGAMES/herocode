# Build do app Desktop para Windows (x64 e arm64)

Este documento explica como gerar os instaladores `.exe` do app OpenCode Desktop para
Windows a partir de uma máquina **Linux**, e como instalar o resultado no Windows.

- **x64** (`x86_64-pc-windows-msvc`) → `opencode-desktop-win-x64.exe`
- **arm64** (`aarch64-pc-windows-msvc`) → `opencode-desktop-win-arm64.exe`

Instalação do app no Windows: veja [INSTALL-WINDOWS-DESKTOP.md](./INSTALL-WINDOWS-DESKTOP.md).

---

## 1. Por que precisa de Docker + wine

O app é **Electron** e o empacotamento é feito pelo `electron-builder`. O alvo `nsis`
do Windows roda programas Windows `.exe` durante o build:

1. o `makensis.exe` (NSIS, **32 bits**) para gerar o instalador;
2. o `__uninstaller.exe` gerado, também 32 bits, para extrair o desinstalador.

Em Linux, o `electron-builder` executa esses binários via **wine**, que precisa do
suporte **i386** além do x86_64. Instalar wine direto no host exigiria `sudo`, então a
solução é uma imagem Docker que já traz wine 32+64, bun e as ferramentas de build.

## 2. A imagem Docker é só ferramenta de build

**A imagem não instala nada no boot do sistema.** Ela não é um serviço, não tem
`restart policy`, não cria unit de systemd e não fica em execução. Todo uso é um
`docker run --rm` de execução única: o container sobe, faz o trabalho e é removido no
final. A imagem fica apenas guardada em disco até você precisar de novo.

Nenhum dos containers deste processo usa `--restart always`, então nada é iniciado
automaticamente junto com a máquina.

O que fica persistido (e é seguro apagar quando quiser):

| Recurso | Finalidade |
| --- | --- |
| imagem `opencode-winbuilder:latest` | toolchain wine + bun (≈2,7 GB) |
| volume `opencode-winbuilder-apt` | cache de download do Electron/NSIS |
| volume `opencode-winbuilder-wine` | prefixo wine, evita recriar o prefixo a cada build |

Para apagar tudo:

```bash
docker image rm opencode-winbuilder:latest
docker volume rm opencode-winbuilder-apt opencode-winbuilder-wine
```

## 3. Pré-requisitos no host

- Docker instalado e o daemon rodando (`docker info`)
- `bun` instalado (o build dos assets roda no host)
- o repositório com as dependências instaladas (`bun install` na raiz)

## 4. Construir a imagem

O `Dockerfile` usado está em [`script/docker/win.Dockerfile`](./script/docker/win.Dockerfile).
O `--network=host` é necessário porque o apt dentro do build do Docker não resolve os
índices neste ambiente:

```bash
docker build --network=host -t opencode-winbuilder:latest script/docker
```

## 5. Gerar os instaladores

### 5.1 Compilar os assets (no host)

```bash
OPENCODE_CHANNEL=dev bun run --cwd packages/desktop build
```

Isso roda o `prebuild` (ícones, metainfo, bundle do servidor em
`packages/opencode/dist/node`, e o download do `opencode-cli` do host) e depois o
`electron-vite build`.

### 5.2 Empacotar (no container)

```bash
docker run --rm \
  -v "$PWD":/workspace \
  -v opencode-winbuilder-apt:/root/.cache/electron \
  -v opencode-winbuilder-wine:/root/.wine \
  -w /workspace/packages/desktop \
  -e OPENCODE_CHANNEL=dev \
  opencode-winbuilder:latest \
  bun run package:win:all
```

Para gerar só uma arquitetura, passe o argumento:

```bash
# somente x64
docker run --rm ... opencode-winbuilder:latest bun run package:win:all x64

# somente arm64
docker run --rm ... opencode-winbuilder:latest bun run package:win:all arm64
```

### 5.3 Resultado

```
packages/desktop/dist/
├── opencode-desktop-win-x64.exe          instalador x64  (~110 MB)
├── opencode-desktop-win-x64.exe.blockmap
├── opencode-desktop-win-arm64.exe        instalador arm64 (~105 MB)
├── opencode-desktop-win-arm64.exe.blockmap
├── win-unpacked/                         app x64 descompactado
└── win-arm64-unpacked/                   app arm64 descompactado
```

Os arquivos dentro de `dist/` são criados pelo container como `root`. Para devolver o
dono ao seu usuário:

```bash
sudo chown -R "$(id -u):$(id -g)" packages/desktop/dist
```

## 6. O que mudou no código para o cross-build funcionar

Sem essas correções o empacotamento para Windows falha ou gera um app quebrado:

| Arquivo | Mudança |
| --- | --- |
| `packages/desktop/electron-builder.config.ts` | removido o `extraResources` de `native/`, diretório que não existe mais e quebrava o empacotamento |
| `packages/desktop/electron.vite.config.ts` | `@lydell/node-pty` virou external **sem** fixar plataforma/arquitetura |
| `packages/desktop/scripts/utils.ts` | `downloadCliToResources` aceita um alvo explícito e deriva a extensão `.exe` do alvo, não do host |
| `packages/desktop/scripts/package-windows.ts` | novo: baixa o `opencode-cli` da arquitetura certa **imediatamente antes** de cada build |
| `packages/desktop/package.json` | scripts `package:win:x64`, `package:win:arm64`, `package:win:all`; removido `native:build` |

O detalhe do `node-pty`: o plugin `opencode:node-pty-narrower` resolvia
`@lydell/node-pty` para `@lydell/node-pty-<platform>-<arch>` do **host** de build. Num
build Linux isso gravava `@lydell/node-pty-linux-x64` no bundle, que não existe no
Windows. O pacote `@lydell/node-pty` já faz essa escolha sozinho em runtime a partir de
`process.platform`/`process.arch`, então basta deixá-lo externalizado e não forçar
nada.

## 7. Canal de release

O build usa `OPENCODE_CHANNEL=dev` de propósito:

| Canal | appId | Auto-update |
| --- | --- | --- |
| `dev` | `ai.opencode.desktop.dev` | desativado |
| `beta` | `ai.opencode.desktop.beta` | ativo, repo `opencode-beta` |
| `prod` | `ai.opencode.desktop` | ativo, repo `opencode` |

`dev` usa um `userData` separado, não registra o protocolo `opencode://` do build
oficial e não tenta baixar atualizações do repositorio upstream. Para gerar o instalador
com identidade de produção, use `OPENCODE_CHANNEL=prod` — e note que esse canal não
embute o `opencode-cli`.

## 8. Assinatura

O build local sai **sem assinatura**. O hook em `electron-builder.config.ts` só roda em
`GITHUB_ACTIONS=true` e delega para `script/sign-windows.ps1` (Azure Trusted Signing).
Fora do CI o passo é ignorado, então o Windows Defender SmartScreen vai avisar o
usuário no primeiro launch. Detalhes e como aceitar o aviso:
[INSTALL-WINDOWS-DESKTOP.md](./INSTALL-WINDOWS-DESKTOP.md).

Para assinar localmente com um certificado, preencha `CSC_LINK` / `CSC_KEY_PASSWORD`.