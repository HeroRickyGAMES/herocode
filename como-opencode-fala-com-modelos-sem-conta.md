# Como o opencode se comunica com modelos como o Big Pickle (OpenCode Zen) sem precisar de conta

> O modelo "big-pickle" não é hospedado por um serviço externo que você autentica.
> Ele é servido pelo **OpenCode Zen** (`opencode.ai/zen`), que é o gateway de
> modelos da própria opencode. A parte interessante é que, para os modelos
> **gratuitos**, o Zen aceita requisições **sem nenhuma conta/chave real** — o
> cliente só manda um placeholder `public`. É por isso que você abre o opencode
> num PC novo, sem logar em nada, e o `opencode/big-pickle` simplesmente funciona.

---

## Visão geral (30 segundos)

1. O opencode baixa um **catálogo** de todos os modelos (models.dev).
2. Nesse catálogo existe um provider chamado **`opencode`** (nome de exibição "OpenCode Zen"), cujo endpoint é `https://opencode.ai/zen/v1` e cujos modelos usam o SDK `@ai-sdk/openai-compatible`.
3. Ao carregar esse provider, o opencode verifica se você tem chave. Se **não tiver**:
   - **apaga do catálogo todos os modelos pagos** (deixa só os de custo zero, ex. `big-pickle`);
   - define `apiKey: "public"` (uma chave falsa/placeholder).
4. Quando você manda uma mensagem, o opencode faz um `POST` para `https://opencode.ai/zen/v1/chat/completions` com `Authorization: Bearer public`.
5. O gateway do Zen **aceita** esse pedido para modelos gratuitos (sem billing, sem conta) e devolve o stream.

---

## Os arquivos que fazem isso acontecer

| Papel | Arquivo |
| --- | --- |
| Baixa o catálogo de modelos (models.dev) e faz cache em disco | `packages/core/src/models-dev.ts` |
| Registra o provider `opencode` + a lógica "sem chave = só free + key `public`" (V1) | `packages/opencode/src/provider/provider.ts:179-201` |
| Mesma lógica no catálogo V2 (com integração de conta) | `packages/core/src/plugin/provider/opencode.ts:165-177` |
| Resolve o SDK/`baseURL`/`apiKey` e envia a requisição | `packages/opencode/src/provider/provider.ts:1673-1805` (resolver) e `:1835-1864` (`getLanguage`) |
| Big Pickle: custo zero, prioridade na lista, sem variantes de reasoning | `provider.ts:1986`, `provider/transform.ts:783`, `packages/stats/core/src/domain/inference.ts:97` |

---

## Passo a passo detalhado

### 1. O catálogo de modelos vem do models.dev

`packages/core/src/models-dev.ts:160`:

```ts
const source = Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"
```

- O opencode baixa `https://models.opencode.ai/api.json` (`models-dev.ts:176`).
- Guarda em cache em disco (`~/.cache/opencode/models.json`) e revalida a cada 5 min (`models-dev.ts:161-165`). Um fixture desse catálogo está em `packages/opencode/test/tool/fixtures/models-api.json`.

O provider `opencode` é descrito assim (fixture, linha 90322):

```json
"opencode": {
  "env": ["OPENCODE_API_KEY"],
  "npm": "@ai-sdk/openai-compatible",
  "api": "https://opencode.ai/zen/v1",
  "name": "OpenCode Zen",
  "models": { "big-pickle": { "id": "big-pickle", ... "cost": { "input": 0, "output": 0 } } }
}
```

E o Big Pickle em si tem `cost` totalmente zero:

```json
"big-pickle": {
  "name": "Big Pickle",
  "cost": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 }
}
```

### 2. O loader customizado do provider `opencode` (a "mágica")

`packages/opencode/src/provider/provider.ts:179-201`:

```ts
opencode: Effect.fnUntraced(function* (input: Info) {
  const env = yield* dep.env()
  const hasKey = iife(() => {
    if (input.env.some((item) => env[item])) return true   // OPENCODE_API_KEY etc.
    return false
  })
  const ok =
    hasKey ||
    Boolean(yield* dep.auth(input.id)) ||                  // `opencode auth` guardado
    Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey) // opencode.json

  if (!ok) {
    // SEM chave: remove todos os modelos que custam dinheiro
    for (const [key, value] of Object.entries(input.models)) {
      if (value.cost.input === 0) continue                 // mantém os FREE
      delete input.models[key]                             // remove os pagos
    }
  }

  return {
    autoload: Object.keys(input.models).length > 0,        // sobe o provider se sobrou modelo
    options: ok ? {} : { apiKey: "public" },               // sem chave → placeholder "public"
  }
}),
```

Traduzindo:

- **"Tenho conta?"** → procura em três lugares: variáveis de ambiente do provider (`OPENCODE_API_KEY`), credencial salva via `opencode auth`, ou `apiKey` no `opencode.json`.
- **Se NÃO tiver conta**: varre o catálogo e **deleta todo modelo cujo custo de entrada > 0**. Sobra apenas os modelos de custo zero — entre eles o `big-pickle`.
- **`apiKey: "public"`** é definida como opção do provider. O gateway do Zen ignora o conteúdo dela para os modelos gratuitos.

O plugin V2 faz exatamente o mesmo para o catálogo novo (`packages/core/src/plugin/provider/opencode.ts:167-177`):

```ts
const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || item.provider.request.body.apiKey)
if (!hasKey) provider.request.body.apiKey = "public"
for (const model of item.models.values()) {
  if (!model.cost.some((cost) => cost.input > 0)) continue
  draft.enabled = false   // desliga modelos pagos
}
```

### 3. Montando o SDK (baseURL + apiKey)

Quando um modelo é selecionado, `getLanguage` chama `resolveSDK` (`provider.ts:1835-1864` e `:1673-1805`).

- `baseURL` vem de `model.api.url` do catálogo → `https://opencode.ai/zen/v1` (`provider.ts:1698-1717`).
- `apiKey` vem de `provider.options.apiKey` (o `"public"`) ou da chave real se existir (`provider.ts:1720`).
- Como `npm` é `@ai-sdk/openai-compatible`, ele carrega o bundle `createOpenAICompatible` (`provider.ts:117` e `:1770-1779`) com `{ name: "opencode", baseURL, apiKey: "public", ... }`.

### 4. A requisição que sai da sua máquina

O `@ai-sdk/openai-compatible` (que o opencode usa para mandar a mensagem) monta um POST estilo OpenAI:

```
POST https://opencode.ai/zen/v1/chat/completions
Authorization: Bearer public
Content-Type: application/json

{
  "model": "big-pickle",
  "messages": [ { "role": "user", "content": "..." }, ... ],
  "stream": true
}
```

- O caminho `/chat/completions` é o descrito na doc do Zen para o Big Pickle (`packages/web/src/content/docs/zen.mdx:116`).
- A resposta é um stream de eventos `text/event-stream` (SSE), tratado em `provider.ts:37-83` (`wrapSSE`) com timeouts de chunk/header.

### 5. Por que funciona sem conta

- O **Zen é um gateway** que serve os modelos "oficiais" da opencode. Para os modelos **free**, o gateway não exige conta/billing — qualquer chave (até `"public"`) é aceita, provavelmente para simples telemetria/limite de uso.
- O opencode só **expõe** esses modelos free quando você não tem chave. Ou seja: o cliente faz sozinho o "escolhe só o que dá pra usar de graça".
- Para os modelos **pagos**, você precisa de créditos/conta no Zen; sem isso eles nem aparecem na lista (`/models`).

---

## Onde o Big Pickle aparece de forma especial

| Onde | O que faz | Arquivo:linha |
| --- | --- | --- |
| Custo zero no catálogo | é por isso que ele **sobrevive** à limpeza do passo 2 | `models-api.json` (fixture) |
| Prioridade na ordenação | o `priority` inclui `big-pickle`, então ele fica no topo da lista do provider `opencode` | `provider.ts:1986` |
| Sem variantes de reasoning | `id.includes("big-pickle")` → retorna `{}` (sem botões de esforço de raciocínio) | `provider/transform.ts:783` |
| Classificado como "Free" nos stats | `WHEN raw_model IN (... 'big-pickle' ...) THEN 'Free'` | `packages/stats/core/src/domain/inference.ts:97` |

---

## Resumo em um diagrama

```
                 +-------------------------------------------+
                 |            opencode (seu PC)               |
                 |                                           |
  catálogo ------+--> models.opencode.ai/api.json            |
  (models.dev)   |    └─ provider "opencode"                 |
                 |       npm  = @ai-sdk/openai-compatible    |
                 |       api  = https://opencode.ai/zen/v1   |
                 |       models: big-pickle (cost 0), ...    |
                 |                                           |
  loader custom  |    sem chave?                            |
  (provider.ts)  |    ├─ remove modelos pagos  (cost > 0)    |
                 |    └─ apiKey = "public"                  |
                 |                                           |
  requisição ----+--> POST https://opencode.ai/zen/v1/       |
                 |              chat/completions             |
                 |         Authorization: Bearer public      |
                 |         { model: "big-pickle", ... }      |
                 +----------------+--------------------------+
                                  |
                                  v
                 +-------------------------------------------+
                 |   OpenCode Zen gateway (opencode.ai)      |
                 |   aceita chave "public" p/ modelos FREE   |
                 |   → streama a resposta (SSE)              |
                 +-------------------------------------------+
```

**Em uma frase:** o "sem conta" funciona porque (1) o opencode carrega o catálogo do Zen localmente, (2) sem chave ele esconde só os modelos pagos e usa a chave placeholder `public`, e (3) o gateway `opencode.ai/zen` aceita requisições com essa chave para os modelos gratuitos — como o Big Pickle.
