# Instalação no Windows (HEROCODE / OpenCode custom)

Fork com recursos extras: TTS (read-aloud), terminal embutido, proxy anti rate-limit e banner custom.

## Como instalar

1. Baixe o zip correspondente à sua arquitetura:
   - **64 bits (quase todos os PCs)**: `opencode-windows-x64.zip`
   - **ARM (Surface / laptops ARM)**: `opencode-windows-arm64.zip`

2. Extraia o zip. Dentro terá `opencode.exe`.

3. Crie a pasta `%USERPROFILE%\.opencode\bin` e copie o `opencode.exe` para lá:

   ```powershell
   mkdir "$env:USERPROFILE\.opencode\bin" -Force
   Copy-Item .\opencode.exe "$env:USERPROFILE\.opencode\bin\opencode.exe"
   ```

4. Adicione ao PATH (uma vez só):

   ```powershell
   setx PATH "$env:USERPROFILE\.opencode\bin;$env:PATH"
   ```

   Feche e reabra o terminal (PowerShell ou CMD).

5. Teste:

   ```powershell
   opencode --version
   ```

## Uso

```powershell
cd C:\caminho\do\projeto
opencode
```

## Problemas comuns

- **`opencode` não é reconhecido**: verifique a etapa 4 e reabra o terminal.
- **SmartScreen / Defender avisa sobre o executável**: o binário não é assinado (é um fork). Clique em "Mais informações" → "Executar assim mesmo".
- **Free tier bloqueado**: use a versão mais recente de cada release — a versão reportada ao servidor é fixada no mínimo suportado.

## Windows ARM

Em ARM o Windows emula x64, então graças ao Rosetta/emulação o `opencode-windows-x64.zip` também funciona, mas o binário ARM nativo (`opencode-windows-arm64.zip`) é mais rápido.