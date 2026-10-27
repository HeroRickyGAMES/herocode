# ProxyRotator

O `ProxyRotator` (`packages/core/src/proxy/proxy-rotator.ts`) envolve o `fetch` do processo Node/Bun e desvia tráfego HTTP(S) por um pool de proxies públicos quando o caminho direto bate quota, bloqueio ou falha transitória — em especial o free tier do OpenCode (`FreeUsageLimitError` / 429 / 402).

Ele é injetado como `FetchHttpClient.Fetch` em `packages/core/src/effect/app-node-platform.ts`. SOCKS4/5 passam por um bridge local HTTP CONNECT (`socks-bridge.ts`), porque o `fetch` do Bun só aceita proxy HTTP(S) nativo.

## Objetivo

1. **Não mostrar ratelimit/free-limit ao usuário** quando ainda há exits utilizáveis.
2. **Reusar** o proxy que está funcionando (sticky).
3. **Descartar** exits mortos, com quota gasta ou que travam em headers.
4. **Continuar a busca** até achar uma resposta usável ou esgotar o budget.

## Fluxo de um request

```
fetch(url)
  ├─ desabilitado / alvo local? → fetch direto
  ├─ load() do cache
  ├─ pool vazio? → await warm (até ~15s) + rediscovery forçada
  ├─ prepara body (buffer) para poder reenviar
  └─ loop até budget (3 min) ou MAX_ATTEMPTS (200)
        ├─ sticky `active` se ainda válido
        ├─ senão pool com exits? → probe/POST nos proxies (pula direct)
        ├─ senão pool vazio? → 1× direct (IP/VPN), depois espera fill
        ├─ probe paralelo (GET) em até 12 candidatos (diversifica /24)
        │     ├─ 402/429 → markQuota (+ ban /24 após 2 hits no POST)
        │     ├─ 403 / 407 → markDead
        │     ├─ timeout → NÃO mata; ainda tenta POST + first-byte
        │     └─ reachable → POST real
        ├─ resposta OK (não rotate) → markSuccess (vira sticky) → return
        ├─ 402/403/407/429/… → descarta exit, NÃO devolve pro caller
        └─ hang de headers (>10s) → markDead, tenta outro
  fim → throw "Proxy rotation exhausted …"
```

Com pool quente o **direct não roda primeiro** — evita o caso `direct=429` sozinho enquanto proxies bons esperam.

Status que **obrigam rotação** (nunca voltam pro caller como free-limit):

`402, 403, 407, 408, 425, 429, 529`

## Sticky

- Depois de um sucesso, `active` guarda o proxy (`[proxy-rotator] sticky …`).
- A próxima mensagem **reusa** esse exit (`sticky try`) sem probe prévio.
- Só troca se **esse** exit falhar de verdade num POST (quota/dead/timeout/ECONNRESET).
- Ban de /24 por vizinhos **não** derruba o sticky; probe GET também não.
- Antes de devolver a Response, espera o **primeiro byte** do body; `ECONNRESET` nessa fase troca de proxy em silêncio (não aparece no chat).
- Sticky só é pinado quando o body **termina** limpo. Em SSE (`text/event-stream`), exige `finish_reason` ≠ null ou `[DONE]`; FIN limpo no meio (o clássico `without finish_reason`) chama `markDead` na hora.
- Backup: `toSessionError` também queima sticky em `incomplete-stream` / ECONNRESET.
- `invalidateActive()` força a queima do sticky (ex.: após timeout de transporte).

## Discovery e pool

Fontes públicas (`SOURCES`): conjunto enxuto (hookzof, hproxy http/https/socks4, ProxyScraper socks, rdavydov, ProxyScrape http/https/socks4, Geonode). Famílias que o log/EXPUNGE mataram (monosans, vakhov, hideip, TheSpeedX, proxifly, iplocate, proxyscrape socks5, …) saem do array e ficam em `HARD_PURGED`.

1. Download (prefixo até 512 KiB) → parse → candidatos.
2. Candidatos intercalados **por source** (round-robin) até 2500 — senão a 1ª lista (ex.: hookzof) engolia o budget e o warm ocioso parecia monofonte.
3. Validação concorrente contra  
   `https://opencode.ai/inference/systemone/v1/chat/completions`  
   (GET sem auth: 401/404 conta como vivo; 402/403/407/429 = inútil).
4. Pool alvo: **256** exits frescos (`POOL_FRESH_MS` = 1 h).
5. Refresh em background a cada ~4 min (também no boot: fetch de models/`models.dev` passa pelo rotator **sem** você ter mandado chat).

Cada proxy carrega uma **source** legível:

`raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt`

(não só o host — senão todas as listas do GitHub viram o mesmo balde).

### Yield por source

Contadores `ok` / `bad` por lista (path completo, não só o host). **Só POST/sticky** — validate não mexe em yield (nem `ok` nem `bad`). Contar invalid como `bad` EXPURGOU todas as fontes restantes após ~8 dials e deixou `pool 0`.

- Sticky / POST ok → `ok`; quota/dead/failure no POST → `bad`.
- ≥ 5 amostras e ≥ 80% `bad` → **toxic**: discovery e pick pulam.
- Expunge permanente: `0 ok` + ≥ 8 `bad` (POST), ou ≥ 85% `bad` com ≥ 16 amostras.
- Cache `yieldVersion < 3` descarta yields/`purged` runtime (mantém só `HARD_PURGED`).
- Geonode usa `protocols=` no label (antes todas as pages viravam um balde só).
- Megadumps (TheSpeedX, proxifly, hideip, monosans, …) em `HARD_PURGED_SOURCES`.
- Label legado só-host (`raw.githubusercontent.com`) **nunca** fica toxic.

## Cache em disco

Em `$XDG_CACHE_HOME/opencode/` (ou `~/.cache/opencode/`):

| Arquivo | Conteúdo |
|---|---|
| `proxy-pool.json` | entries, `active`, `yields` (`yieldVersion`), `subnets`, `purged` |
| `proxy-candidates.json` | até 20k candidatos + mapa `sources` (TTL 30 min) |

Exits queimados **permanecem** no pool com `blockedUntil`, para o próximo restart não redescobrir o mesmo IP morto.

## Timeouts (por que o chat não congela mais)

| Camada | Tempo | Papel |
|---|---|---|
| Tentativa via proxy | **10 s** | Timer duro + AbortController (Bun às vezes ignora AbortSignal em proxy/SOCKS) |
| Probe GET | 6 s | Filtra mortos antes do POST |
| Budget de rotação | **3 min** | Teto do hunt; pool vazio após falhas reais só espera **8 s** |
| Pool vazio (já tentou) | **8 s** | Evita freeze de minutos antes de `rotation exhausted` |
| AI `headerTimeout` | 5 min | Se o rotator não devolver a tempo → “Timed out waiting for response headers” |

Hang em headers → `markDead` **antes** de relançar abort externo, para o retry da session não reediscar o mesmo sticky.

## Bloqueios

| Evento | Bloqueio |
|---|---|
| Dead / hang / falhas ≥ 2 | 10 min |
| Quota diária (402 / FreeUsageLimit) | 6 h |
| Throttle 429 | 15 min |
| Direct com quota | 60 s (retesta se o pool secar — VPN / rede nova) |
| 2+ quotas POST no mesmo **/24** | Ban persistente do subnet (`subnetBlocks` + cache) até o window acabar — exits *novos* do mesmo bloco não reentram via validate (ex.: `45.74.31.0/24`) |

Quando a **pool inteira** toma 402/429: `retireQuotaPool` queima os exits, cooldown 10 min nas listas, e força `discover` da próxima pool. Budget default é **infinito** (só para com abort do caller; `OPENCODE_PROXY_BUDGET_MS` limita se setado).

### Expurgo de fontes

Listas ~100% mortas **saem de vez** (`expungeSource`):

- `0 ok` + `≥ 8 bad`, ou `≥ 95% bad` com `≥ 20` amostras
- Removidas do discover/pick, dos `entries`, e persistidas em `proxy-pool.json` → `purged`
- Fontes já medidas como lixo (ALIILAPRO, ErcinDedeoglu, mmpx12, roosterkid, …) nem entram em `SOURCES`

Debug (`OPENCODE_PROXY_DEBUG=1`):

```
raw.githubusercontent.com/monosans/.../http.txt : proxy: 1.2.3.4:8080
[proxy-rotator] EXPUNGED source … (0ok/12bad) removed 40 exits
```

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `OPENCODE_PROXY_DISABLE=1` | Desliga o rotator |
| `OPENCODE_PROXY_DEBUG=1` | Logs `[proxy-rotator] …` |
| `OPENCODE_PROXY` / `_LIST` / `_FILE` | Proxies seed (source `env`) |
| `OPENCODE_PROXY_ONLY=1` | Só seeds, sem discovery pública |
| `OPENCODE_PROXY_FORCE=1` | Obriga proxy (sem preferir direct) |
| `OPENCODE_PROXY_LOCAL=1` | Também rotaciona alvos localhost/privados |
| `OPENCODE_PROXY_VALIDATE_URL` | URL de validação |
| `OPENCODE_PROXY_BUDGET_MS` | Budget do hunt |
| `OPENCODE_PROXY_QUOTA_LIMIT` | Limite de quotas por request |

### Debug útil

```bash
OPENCODE_PROXY_DEBUG=1 OPENCODE_PRINT_LOGS=1 bun run dev 2>/tmp/opencode-dev.log
tail -f /tmp/opencode-dev.log | grep -i proxy
```

Linhas típicas: `validated`, `probe`, `attempt`, `using <proxy> <source>`, `dead`, `quota`, `rotation exhausted`, `skip source`, `pool … toxic […]`.

## API exportada

| Função | Uso |
|---|---|
| `ProxyRotator.fetch` | Drop-in de `fetch` com rotação |
| `ProxyRotator.shouldRotate(status)` | Status que devem rotacionar |
| `ProxyRotator.normalize` / `parseProxyLines` | Parse de listas |
| `ProxyRotator.sourceLabel(url)` | Label estável de uma lista |
| `ProxyRotator.warm()` | Dispara refresh do pool |
| `ProxyRotator.status()` | `{ active, proxies, yields }` |
| `ProxyRotator.invalidateActive()` | Queima o sticky |
| `ProxyRotator.reset()` | Limpa estado in-memory (testes) |

## Testes

- Unit: `packages/core/test/proxy/proxy-rotator.test.ts`
- Integration: `packages/core/test/proxy/proxy-rotator.integration.test.ts`  
  (rotação 429 → proxy; hang de headers → timeout rápido, não 5 min)

```bash
cd packages/core
bun test test/proxy/proxy-rotator.test.ts test/proxy/proxy-rotator.integration.test.ts
```

## O que o usuário vê

| Situação | Comportamento |
|---|---|
| Direct/proxy com quota, outro exit vivo | Rotaciona em silêncio; resposta normal |
| Exit sticky ok | Reusa; mensagem rápida |
| Sticky morre no meio | Próximo request caça outro; pode demorar |
| Pool seco / todos queimados | `rotation exhausted` (erro de transporte), **não** FreeLimitNotice |
| Hang de headers no proxy | Descarta em ~10 s e segue |

O aviso “You've used today's free messages” só aparece se um 429/FreeUsageLimit **vazar** para a camada de session (rotator desligado, body não replayable antigo, ou serviço instalado sem este código).
