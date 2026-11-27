# Instagram: nome do cliente no prompt e Páginas já conectadas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No Instagram, o prompt separa o nome do cliente (primeiro nome do perfil) do nome da persona; e a conexão de uma loja ignora Páginas cujo Instagram já está conectado a outra unidade.

**Architecture:** Parte 1: campo opcional `declaredFirstName` no `ChannelContext`, preenchido só pelo adapter do Instagram e repassado pelo turno ao loader do prompt, que o usa na frase existente (ou numa âncora negativa quando vazio). Parte 2: núcleo puro `selectPage` em `instagram-graph-core.ts` descarta as Páginas em uso antes de `choosePage`; o `instagram-connect` só faz a leitura service-role e traduz o desfecho.

**Tech Stack:** Deno Edge Functions (Supabase), TypeScript, Vitest (núcleos e harness de request).

**Spec:** [docs/superpowers/specs/2026-11-26-instagram-nome-cliente-e-paginas-design.md](../specs/2026-11-26-instagram-nome-cliente-e-paginas-design.md)

## Global Constraints

- WhatsApp: prompt byte a byte idêntico — `src/lib/agent-turn-parity.test.ts` passa sem regravar snapshot.
- Nada do cadastro privado no prompt do Instagram (o nome vem só do perfil, via `contact.name`).
- Frase do nome = a existente em `composeAgentSystemPrompt` ("O cliente com quem você está falando se chama X — esse é o nome do CLIENTE, NÃO o seu. Você continua sendo {agente}. …").
- Âncora negativa exata: `Você é ${agentName}; não chame o cliente por esse nome. ` (com espaço final, mesma posição da frase do nome).
- A trava SQL `instagram_account_in_use` continua intocada; sem migration.
- Mensagem de "em uso" = `MSG.inUse` atual ("Esta conta do Instagram já está conectada a outra unidade"); "várias" = `MSG.manyPages` atual.
- Log novo sem ids nem @: `instagram_connect_pages_in_use_skipped` com `{ action, skipped }`.
- Erro na leitura de contas em uso → 503 `MSG.unavailable`, sem Graph adicional, sem gravar.
- Typecheck é `npm run typecheck` (`tsc -b --noEmit`); EFs conferidas com `deno check`.

## Review Focus

- Nome de perfil só com pontuação/emoji (`". - '"`, `"👨🏻‍💻"`) → sem nome; prompt traz a âncora, nunca "se chama ." → teste na Task 1 e na Task 2.
- Nome com marca bidi/zero-width (`"‮Yuri"`) → primeiro nome limpo `"Yuri"` → Task 1.
- Página da PRÓPRIA unidade já conectada (reconexão) nunca entra no conjunto "em uso" → teste de request (a) existente continua 200, Task 4.
- Todas as Páginas autorizadas em uso noutra unidade → 409 `inUse`, sem `debug_token`, sem store → Task 3 (núcleo) e Task 4 (request).
- Página em uso + Página livre sem tarefa suficiente → mensagem de tarefa insuficiente (não "em uso") → Task 3.

---

### Task 1: Primeiro nome do perfil do Instagram

**Files:**
- Modify: `supabase/functions/_shared/instagram-format.ts` (depois de `cleanInstagramProfileName`)
- Test: `src/lib/instagram-format.test.ts`

**Interfaces:**
- Produces: `export function instagramProfileFirstName(name: string | null | undefined): string` — o primeiro token (separado por espaço) de `cleanInstagramProfileName(name)` que contenha ao menos uma letra (`\p{L}`); `""` se nenhum contiver.

- [ ] **Step 1: Escrever o teste** — `describe('instagramProfileFirstName')` com:
  - `"Yuri Moraes 👨🏻‍💻"` → `"Yuri"`; `"  Ana   Paula "` → `"Ana"`; `"José"` → `"José"`
  - `null`, `undefined`, `""`, `"👨🏻‍💻"`, `". - '"` → `""`
  - `"‮Yuri"` → `"Yuri"`
  - `"- Bia"` → `"Bia"` (primeiro token com letra)
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run src/lib/instagram-format.test.ts` → FAIL (função não exportada).
- [ ] **Step 3: Implementar** `instagramProfileFirstName` em `instagram-format.ts`.
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git add supabase/functions/_shared/instagram-format.ts src/lib/instagram-format.test.ts` + `git commit -m "feat(instagram): primeiro nome limpo do perfil"`.

### Task 2: Frase de separação de nomes no prompt do Instagram

**Files:**
- Modify: `supabase/functions/_shared/agent/channel-context.ts` (junto de `identityLine`)
- Modify: `supabase/functions/_shared/agent/turn.ts:1026-1040` (chamada a `loadAgentSystemPrompt`)
- Modify: `supabase/functions/_shared/agent/system-prompt.ts` (`AgentPromptParts`, args do loader ~L400, `customerFirstName` ~L716-725, `composeAgentSystemPrompt` ~L296-298)
- Modify: `supabase/functions/process-instagram-inbound/index.ts:~886` (montagem do `ctx`)
- Modify: `.claude/rules/agente-ia.md` (uma frase no bullet "Regra de canal entra no prompt…")
- Test: `src/lib/agent-core-channel.test.ts`

**Interfaces:**
- Consumes: `instagramProfileFirstName` (Task 1).
- Produces:
  - `ChannelContext.declaredFirstName?: string` — só canal de identidade declarada; ausente no WhatsApp.
  - Args de `loadAgentSystemPrompt` ganham `declaredFirstName?: string`.
  - `AgentPromptParts.declaredNameAnchor?: boolean` — `true` quando `declaredFirstName` foi fornecido e o nome final ficou vazio.
  - Regra no loader: `customerFirstName` = regra atual do cadastro privado; se vazio **e** `privateCustomer === null` **e** `declaredFirstName` não vazio → `shortStoreText(declaredFirstName, SHORT_TEXT_LIMITS.personName)`.

- [ ] **Step 1: Escrever os testes** em `agent-core-channel.test.ts`, reusando `recordingClient` e o `args(...)` do describe "prompt do contato declarado" (acrescente `declaredFirstName` por spread):
  - `args(null)` + `declaredFirstName: 'Yuri'` → `out.text` contém `'se chama Yuri — esse é o nome do CLIENTE, NÃO o seu. Você continua sendo Yumi.'` e não contém nenhum item de `PRIVADOS`.
  - `args(null)` + `declaredFirstName: ''` → contém `'Você é Yumi; não chame o cliente por esse nome. '` e não contém `'se chama'`.
  - `args(null)` sem `declaredFirstName` → não contém `'se chama'` nem `'não chame o cliente por esse nome'` (forma do WhatsApp).
  - `args(cadastro)` + `declaredFirstName: 'Yuri'` → contém `'se chama Fulana'`, não contém `'se chama Yuri'` (cadastro vence; combinação não ocorre em produção, mas fixa a precedência).
  - `composeAgentSystemPrompt(parts({ customerFirstName: '', declaredNameAnchor: true }))` contém a âncora com o `agentName` de `parts`; com `declaredNameAnchor` ausente o texto é igual ao de antes (compare com `parts({ customerFirstName: '' })`).
  - Estático (no `it` "o WhatsApp passa o rótulo…"): os args da chamada em `turn.ts` contêm `'declaredFirstName: ctx.declaredFirstName,'`; `webhook-whatsapp/index.ts` **não** contém `'declaredFirstName'`; `process-instagram-inbound/index.ts` contém `'declaredFirstName: instagramProfileFirstName(contact.name),'`.
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run src/lib/agent-core-channel.test.ts` → FAIL nos novos casos.
- [ ] **Step 3: Implementar** os quatro pontos (contexto, repasse no `turn.ts`, loader + compose, `ctx` do worker com `declaredFirstName: instagramProfileFirstName(contact.name),` e o import). Comentário curto no campo do contexto: por que existe (sem a frase, o modelo chama o cliente pelo nome da persona).
- [ ] **Step 4: Rodar e ver passar** — `npx vitest run src/lib/agent-core-channel.test.ts src/lib/agent-turn-parity.test.ts src/lib/agent-global-prompt-loader.test.ts` → PASS, **sem** regravar snapshot.
- [ ] **Step 5: Controle positivo** — remover temporariamente a linha do repasse em `turn.ts`, rodar `npx vitest run src/lib/agent-core-channel.test.ts` → o teste estático falha; restaurar e confirmar PASS.
- [ ] **Step 6: Regra** — em `.claude/rules/agente-ia.md`, no bullet "Regra de canal entra no prompt…", acrescentar uma frase: o nome do cliente no Instagram vem só do perfil (`declaredFirstName`, primeiro nome limpo) para a frase de separação persona × cliente; perfil sem nome recebe a âncora negativa; o WhatsApp não preenche o campo.
- [ ] **Step 7: Commit** — `git add` dos 6 arquivos + `git commit -m "fix(instagram): prompt separa o nome do cliente do nome da persona"`.

### Task 3: Núcleo `selectPage` descarta Páginas em uso

**Files:**
- Modify: `supabase/functions/_shared/instagram-graph-core.ts` (depois de `choosePage`)
- Test: `src/lib/instagram-graph-core.test.ts`

**Interfaces:**
- Consumes: `PageCandidate`, `PageChoice`, `choosePage` (existentes).
- Produces: `export function selectPage(pages: PageCandidate[], inUseIgUserIds: ReadonlySet<string>): { choice: PageChoice | { kind: "in_use" }; skippedInUse: number }`
  - Descarta Páginas com `igUserId` no conjunto (`skippedInUse` = quantas).
  - Se `pages` não era vazio e **todas** foram descartadas → `{ kind: "in_use" }`.
  - Senão → `choosePage(restantes)`.

- [ ] **Step 1: Escrever os testes** (`describe("selectPage")`, usando `cand` e variando `igUserId` com spread):
  - conjunto vazio → igual a `choosePage(pages)` e `skippedInUse: 0`
  - `[moralles(em uso), ren(livre)]` → `{ kind: "one", page: ren }`, `skippedInUse: 1`
  - controle positivo: mesmas Páginas com conjunto vazio → `kind: "many"`
  - `[moralles(em uso)]` → `{ kind: "in_use" }`, `skippedInUse: 1`
  - `[]` → `{ kind: "none", reason: "no_instagram" }`, `skippedInUse: 0`
  - `[a(em uso), b(livre, tasks ["ADVERTISE"])]` → `{ kind: "none", reason: "insufficient_task" }`
  - três aptas, uma em uso → `kind: "many"` com só as duas livres em `usernames`
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run src/lib/instagram-graph-core.test.ts` → FAIL.
- [ ] **Step 3: Implementar** `selectPage`.
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git add` dos 2 arquivos + `git commit -m "feat(instagram): escolha de Página ignora contas em uso noutra unidade"`.

### Task 4: `instagram-connect` usa `selectPage`

**Files:**
- Modify: `supabase/functions/instagram-connect/index.ts:~326-350` (entre `listPages` e a escolha)
- Modify: `.claude/rules/instagram.md` (seção Identidade e tenant, uma linha)
- Test: `src/lib/instagram-connect-request.test.ts`

**Interfaces:**
- Consumes: `selectPage` (Task 3).
- Leitura nova (só quando `pages.value.length > 0`): service role, `from("instagram_accounts").select("ig_user_id").in("ig_user_id", ids).neq("status", "disconnected").neq("unit_id", unitId)`. `unitId` é o do `state` assinado.

- [ ] **Step 1: Estender o banco falso** — no `from` do fixture: método `in(k, v)` gravando `f["in:ig_user_id"]`; em `instagram_accounts`, quando houver `in:ig_user_id`, devolver `{ data: [{ ig_user_id }], error: null }` das contas com `ig_user_id ∈ lista`, `status !== "disconnected"` e `unit_id !== f["neq:unit_id"]` (com `expect(columns).toBe("ig_user_id")`); novo `ErrorFlag` `"in_use_read"` → `err("08006")` só nessa leitura. A leitura existente (por `unit_id`) segue como está.
- [ ] **Step 2: Escrever os testes** no describe do callback:
  - "Página de outra unidade marcada junto → conecta a livre": `two()` com `IG` semeado conectado em `UNIT_B` (`f.seedAccount(UNIT_B)`) → 200, store com `p_ig_user_id: IG_2, p_page_id: PAGE_2`, log contém `instagram_connect_pages_in_use_skipped` com `"skipped":1`, sem `IG`/@ no log.
  - "erro ao ler contas em uso → 503": flag `in_use_read` → 503, `f.writes()` vazio, nenhum `debug_token`/`subscribed_apps`.
  - Ajustar "conta já conectada a outra unidade → 409": continua 409 com a mesma mensagem, agora também sem chamada a `debug_token` e sem `store_instagram_account_connection`.
  - O caso (a) de "várias Páginas aptas" continua 200 sem alteração (a própria unidade não entra no conjunto).
- [ ] **Step 3: Rodar e ver falhar** — `npx vitest run src/lib/instagram-connect-request.test.ts` → FAIL nos novos.
- [ ] **Step 4: Implementar** no `handleCallback`: leitura → erro 503 com `jsonLog("error", { evt: "instagram_connect_gate_unavailable"…})` no padrão do arquivo; `selectPage`; `skippedInUse > 0` → log `instagram_connect_pages_in_use_skipped`; `kind: "in_use"` → `json(ctx.req, 409, { error: MSG.inUse })`; demais `kind` seguem o fluxo atual (`none`/`many`/`one`) com o mesmo código de hoje.
- [ ] **Step 5: Rodar e ver passar** — mesmo comando → PASS (todo o arquivo).
- [ ] **Step 6: Regra** — em `.claude/rules/instagram.md`, seção "Identidade e tenant": **No callback, Páginas cujo IG já tem conta não desconectada em outra unidade são descartadas antes da escolha (`selectPage`); a trava `instagram_account_in_use` da RPC continua sendo a garantia.** O Facebook lembra Páginas liberadas e marca a de outra loja; ler conta em uso que falha dá 503. Ponteiro para `instagram-graph-core.ts`.
- [ ] **Step 7: Commit** — `git add` dos 3 arquivos + `git commit -m "fix(instagram): conexão ignora a Página de outra loja já conectada"`.

---

## Verificação final (antes do merge)

- `npm run typecheck` → 0 erros.
- `npx eslint` nos arquivos tocados → 0 erros.
- `npm test` → tudo verde.
- `deno check supabase/functions/process-instagram-inbound/index.ts supabase/functions/instagram-connect/index.ts` → sem erro.
- `node scripts/ef-import-graph.mjs` para cada `_shared/` alterado (`instagram-format.ts`, `instagram-graph-core.ts`, `agent/channel-context.ts`, `agent/turn.ts`, `agent/system-prompt.ts`) → lista de EFs a redeployar (esperado: `process-instagram-inbound`, `instagram-connect` e, por `agent/*`, também `webhook-whatsapp` — o WhatsApp não muda de comportamento, mas o bundle muda).
- Gates `saas-shield-br`: `tenant-isolation-auditor` e `identity-access-auditor` sobre o diff (leitura cross-unit nova no `instagram-connect`).
