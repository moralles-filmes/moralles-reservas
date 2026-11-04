# Texto e mídia na mesma rajada — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a resposta da IA ao texto nunca se perde quando chega mídia na mesma rajada; o aviso de "só leio texto" sai uma vez, na ordem de chegada (WhatsApp e Instagram).

**Architecture:** a decisão "aviso agora × depois da resposta" e a reivindicação do aviso adiado viram dois RPCs atômicos sobre a linha de `conversations` (mesma linha do lock da IA e do histórico). O caminho de mídia de cada canal grava o placeholder com `media_kind` por `record_conversation_media`. O `turn.ts` ignora mídia no debounce e na mensagem combinada e, depois de uma resposta `success`, reivindica os avisos adiados por `claim_conversation_media_notices` e manda um aviso variante, antes de soltar o lock. As chamadas aos RPCs ficam num adapter (`_shared/adapters/`), fora do núcleo, então a portabilidade não sobe.

**Tech Stack:** Deno Edge Functions (TypeScript, `strict: false`), Postgres/Supabase (plpgsql `SECURITY DEFINER`), Vitest (harness de Request), pré-voo SQL local.

**Spec:** [docs/superpowers/specs/2026-11-04-texto-midia-rajada-design.md](../specs/2026-11-04-texto-midia-rajada-design.md)

## Global Constraints

- Texto variante: `Recebi também ${palavra}, mas por aqui só consigo ler texto. Se tiver mais alguma dúvida, é só me escrever.` com `palavra` ∈ {`sua foto` (image), `seu áudio` (audio), `seu vídeo` (video), `seu documento` (document), `sua figurinha` (sticker), `sua localização` (location), `seu contato` (contacts), `seu arquivo` (qualquer outro, ou mais de um tipo distinto)}.
- `MEDIA_REPLY_TEXT` atual não muda.
- O aviso variante sai **exatamente uma vez** por rajada; ele nunca é reenviado depois de uma falha de envio (no máximo uma vez).
- Mídia nunca torna `debounced_superseded` um turno de texto; texto mais novo continua superando.
- Mídia é reconhecida só pelo campo `media_kind` da mensagem, nunca pelo texto do placeholder.
- O aviso adiado sai só depois do desfecho `success`/`success_history_degraded`. Qualquer outro desfecho não chama o claim.
- Conversa `human_active`/`awaiting_human`: mídia não gera aviso (como hoje).
- Constantes: `MEDIA_BURST_SECONDS = 60`, `MEDIA_DEBOUNCE_GRACE_SECONDS = INBOUND_DEBOUNCE_WINDOW_MS / 1000 + 5` (= 11), `MEDIA_NOTICE_MAX_AGE_SECONDS = 120`.
- Função nova: `revoke execute … from public, anon, authenticated` depois do último `create`, `grant` só a `service_role`; `security definer set search_path = ''` (AGENTS §8, `.claude/rules/banco-de-dados.md`).
- `node scripts/check-portabilidade.mjs` não pode subir da linha de base (489): `.rpc(` novo só em `supabase/functions/_shared/adapters/**`.
- Typecheck é `npm run typecheck` (`tsc -b --noEmit`); gate Deno: `npx -y deno@2.9.6 check`.
- Snapshot de paridade: cenários sem mídia mudam só pela entrada `rpc:claim_conversation_media_notices` nos turnos `success` (regravação em commit próprio, Task 3).

## Review Focus

- O cliente digita literalmente `[imagem]` ou `[mídia]`: é texto comum, entra na mensagem combinada e supera no debounce (teste na Task 3).
- Mídia adiada de uma rajada cujo turno falhou não reaparece num turno bem-sucedido 10 minutos depois: o `p_since` do claim é limitado a 120 s (testes nas Tasks 1 e 3).
- Turno que termina `empty_response`, `send_error`, `ai_reply_suppressed_by_human` ou `agent_error` com mídia adiada: não chama o claim e não manda aviso (teste na Task 3).
- Várias mídias de tipos diferentes enquanto a IA responde: um aviso só, com "seu arquivo" (testes nas Tasks 2 e 3).
- Mensagem antiga sem `received_at` (legado): a chegada cai para `timestamp` no SQL, sem erro de cast (teste na Task 1).

---

### Task 1: RPCs `record_conversation_media` e `claim_conversation_media_notices`

**Files:**
- Create: `supabase/migrations/20261105120000_conversation_media_notice.sql` (confira antes que é posterior à última migration do remoto e da `main`)
- Create: `supabase/tests/local-preflight/83a-conversation-media-notice-bootstrap.sql`, `supabase/tests/local-preflight/83-conversation-media-notice.sql`
- Modify: `supabase/tests/local-preflight/README.md` (seção `### 83`, mesma forma da 82), `scripts/function-acl-allowlist.json` (se o gate estático exigir a entrada, como nas migrations anteriores)

**Interfaces:**
- Produces:
  - `public.record_conversation_media(p_conversation_id uuid, p_message jsonb, p_notice_allowed boolean, p_burst_seconds int, p_debounce_grace_seconds int) returns jsonb`. Devolve `{"decision": "deferred"|"notice_now"|"suppressed"|"duplicate", "variant": boolean}`.
  - `public.claim_conversation_media_notices(p_conversation_id uuid, p_since timestamptz) returns text[]`. Devolve os `media_kind` reivindicados, na ordem do histórico; vazio quando não há.
  - Campos novos no elemento de `conversations.messages`: `media_kind text` e `media_notice` ∈ `none|deferred|claimed`.

Regras do `record_conversation_media`, todas sob `select … for update` da conversa:
- Valida `p_message` como o `append_conversation_message` (objeto; `role`, `content`, `timestamp`; `author` válido; `event_id` ≤ 1024). Exige `role = 'user'` e `media_kind` texto não vazio de até 32 caracteres. Conversa inexistente: `raise` igual ao append.
- Se o `event_id` já existe no histórico, devolve `duplicate` sem escrever.
- A chegada de cada mensagem é `coalesce(received_at, timestamp)::timestamptz`. A última resposta é o último elemento com `role in ('assistant','human')`. Um texto sem resposta é um elemento depois dela com `role = 'user'`, sem `media_kind` e com `content` não vazio.
- `variant` = existe mensagem `user` sem `media_kind` com chegada ≥ `now() - p_burst_seconds`.
- A decisão segue a primeira linha que valer:
  1. `p_notice_allowed` falso → grava com `media_notice = 'none'` → `suppressed`;
  2. existe texto sem resposta com chegada ≥ `now() - p_burst_seconds` **e** (`ai_lock_until > now()` **ou** o texto sem resposta mais novo chegou ≥ `now() - p_debounce_grace_seconds`) → grava `deferred` → `deferred`;
  3. senão → grava `claimed` → `notice_now`.
- Atualiza `last_message_at` e `updated_at` como o append.

Regras do `claim_conversation_media_notices`:
- Sob `for update`, troca `media_notice` de `deferred` para `claimed` em todo elemento com chegada ≥ `p_since`.
- Devolve os `media_kind`. A segunda chamada com o mesmo `p_since` devolve `{}`.

- [ ] **Step 1: escrever o pré-voo 83 (deve falhar antes da migration)** com os casos, cada um com `raise exception` em caso de erro e o marcador `GREEN83` no fim:
  - 8301: sem texto, `notice_allowed` → `notice_now`, `variant` falso, elemento com `media_kind` e `media_notice = 'claimed'`;
  - 8302: texto sem resposta de 3 s atrás e lock livre → `deferred`;
  - 8303: texto sem resposta de 40 s atrás com `ai_lock_until` no futuro → `deferred`;
  - 8304: texto sem resposta de 40 s atrás com o lock livre → `notice_now`, `variant` verdadeiro;
  - 8305: texto respondido (assistant depois dele) há 5 s → `notice_now`, `variant` verdadeiro;
  - 8306: `p_notice_allowed` falso → `suppressed`, `media_notice = 'none'`;
  - 8307: mesmo `event_id` duas vezes → `duplicate`, histórico com um elemento só;
  - 8308: texto do cliente cujo conteúdo é `[imagem]`, sem `media_kind` → conta como texto (8302 repetido com esse conteúdo);
  - 8309: mensagem legada sem `received_at` → usa `timestamp`, sem erro;
  - 8310: o claim devolve `{image,audio}` para duas adiadas e `{}` na segunda chamada;
  - 8311: o claim com `p_since = now() - 120 s` ignora uma adiada de 10 min atrás;
  - 8312: ACL: `has_function_privilege` falso para `anon` e `authenticated` e verdadeiro para `service_role` nas duas funções; `prosecdef` verdadeiro; `proconfig` com `search_path=""`.
- [ ] **Step 2: rodar o pré-voo sem a migration.** No cluster descartável da receita do README, com `lc_messages = 'C'`, rode `83a` → `83`. Esperado: erro "function … does not exist".
- [ ] **Step 3: escrever a migration** com as duas funções, os `revoke`/`grant`, um `comment on function` em cada e o bloco `-- ROLLBACK` comentado (`drop function` das duas).
- [ ] **Step 4: rodar o pré-voo com a migration.** Esperado: `GREEN83`, duas vezes seguidas, com as migrations em CRLF e em LF. Rode também `npx vitest run scripts/function-acl-allowlist.test.ts` (gate estático do CI). Esperado: PASS.
- [ ] **Step 5: commit** `feat(db): RPCs atômicos do aviso de mídia na rajada`.

### Task 2: texto variante e adapter

**Files:**
- Modify: `supabase/functions/_shared/media-reply-text.ts`
- Create: `supabase/functions/_shared/adapters/conversation-media-notice.ts`
- Test: `src/lib/media-notice.test.ts`

**Interfaces:**
- Consumes: os RPCs da Task 1.
- Produces:
  - `mediaNoticeText(kinds: readonly string[]): string` (Global Constraints);
  - `MEDIA_NOTICE_TEXTS: readonly string[]` (as 8 variantes);
  - `MEDIA_BURST_SECONDS`, `MEDIA_DEBOUNCE_GRACE_SECONDS`, `MEDIA_NOTICE_MAX_AGE_SECONDS`;
  - `type MediaDecision = "deferred" | "notice_now" | "suppressed" | "duplicate"`;
  - `recordInboundMedia(supabase: SupabaseClient, input: { conversationId: string; message: Record<string, unknown>; noticeAllowed: boolean }): Promise<{ decision: MediaDecision; variant: boolean }>`, que lança `media_message_persist_failed` em erro do RPC ou resposta fora do contrato;
  - `claimDeferredMediaNotices(supabase: SupabaseClient, conversationId: string, sinceIso: string): Promise<string[]>`, que lança em erro.

- [ ] **Step 1: testes que falham:**
  - `mediaNoticeText(["image"])` dá o texto exato com `sua foto`; `["audio","audio"]` dá `seu áudio`; `["image","audio"]` e `["media"]` dão `seu arquivo`;
  - `MEDIA_NOTICE_TEXTS` tem 8 entradas distintas e inclui as três acima;
  - `recordInboundMedia` chama `rpc("record_conversation_media", { p_conversation_id, p_message, p_notice_allowed, p_burst_seconds: 60, p_debounce_grace_seconds: 11 })` e devolve a decisão; erro do RPC e `decision` desconhecida lançam `media_message_persist_failed`;
  - `claimDeferredMediaNotices` passa `p_since` e devolve `[]` para `data: null`.
- [ ] **Step 2:** `npx vitest run src/lib/media-notice.test.ts`. Esperado: FAIL (módulo inexistente).
- [ ] **Step 3: implementar.** `MEDIA_DEBOUNCE_GRACE_SECONDS` é derivado de `INBOUND_DEBOUNCE_WINDOW_MS` (`_shared/whatsapp-inbound-queue-core.ts`), nunca redigitado.
- [ ] **Step 4:** o mesmo comando, depois `node scripts/check-portabilidade.mjs`. Esperado: PASS e 489.
- [ ] **Step 5: commit** `feat(agent): texto variante do aviso de mídia e adapter dos RPCs`.

### Task 3: núcleo do turno (`turn.ts`)

**Files:**
- Modify: `supabase/functions/_shared/agent/turn.ts` (debounce em "Append imediato + debounce de rajada"; `pendingUserMsgs`; `HARDCODED_AGENT_NOISE`; caminho `success` antes do `releaseAiLock`)
- Modify: `src/test/fixtures/whatsapp-automation-fixtures.ts` (o `rpc` do chat emula os dois RPCs com a semântica da Task 1), mais o fake de `src/lib/agent-core-channel.test.ts` se ele recusar o RPC novo
- Test: `src/lib/agent-turn-media-burst.test.ts` (novo), `src/lib/__snapshots__/agent-turn-parity.test.ts.snap` (regravado)

**Interfaces:**
- Consumes: `claimDeferredMediaNotices`, `mediaNoticeText`, `MEDIA_NOTICE_TEXTS`, `MEDIA_NOTICE_MAX_AGE_SECONDS` (Task 2).
- Produces:
  - no debounce, `newestUserTs` ignora elementos com `media_kind`;
  - `pendingUserMsgs` exclui elementos com `media_kind`;
  - novos logs `media_notice_sent` (`{ count }`) e `media_notice_failed` (`{ stage: "claim"|"send" }`). Os desfechos do turno não mudam.

O passo novo do caminho `success` vem depois do `appendToConversation` final e antes do `settleTurnBudget`/`finish`/`releaseAiLock`:
1. `since` = o maior entre a chegada do primeiro elemento de `pendingUserMsgs` (ou do inbound desta invocação) e `now − 120 s`;
2. `kinds = await claimDeferredMediaNotices(...)`;
3. com `kinds` não vazio: `sendAutomatic(mediaNoticeText(kinds))` e, se der certo, `appendToConversation(..., "assistant", texto, { author: "automation" })`;
4. erro no claim ou no envio: log `media_notice_failed` e o turno segue `success`. Nunca lança.

- [ ] **Step 1: testes que falham** em `agent-turn-media-burst.test.ts`, pelo webhook real no harness:
  - `mídia mais nova não supera o texto`: o histórico ganha `{role:'user', content:'[imagem]', media_kind:'image', media_notice:'deferred', received_at: depois do texto}` durante o sleep do debounce. Esperado: desfecho `success`, o LLM recebe o texto sem `[imagem]`, e saem duas mensagens nesta ordem: a resposta e `mediaNoticeText(['image'])`;
  - `texto mais novo continua superando`: um texto mais novo durante o sleep dá `debounced_superseded`;
  - `cliente digitou [imagem]`: um elemento `user` `[imagem]` **sem** `media_kind` supera o turno como texto;
  - `mídia durante a chamada da IA`: o fake do SDK insere a adiada antes de devolver a resposta. Esperado: o aviso sai depois da resposta;
  - `duas mídias de tipos diferentes`: um aviso só, com `seu arquivo`;
  - `sem mídia adiada`: o claim devolve `[]` e o turno manda só a resposta;
  - `empty_response`, `send_error` e `ai_reply_suppressed_by_human` com uma adiada: nenhum `rpc:claim_conversation_media_notices` no trace e nenhum aviso;
  - `p_since` do claim ≥ `now − 120 s`, mesmo com um `pendingUserMsgs` antigo semeado;
  - claim que falha: desfecho `success`, log `media_notice_failed`, nenhum aviso.
- [ ] **Step 2:** `npx vitest run src/lib/agent-turn-media-burst.test.ts --testTimeout=30000`. Esperado: FAIL.
- [ ] **Step 3: implementar no `turn.ts`.** Acrescente `MEDIA_NOTICE_TEXTS` ao `HARDCODED_AGENT_NOISE` pela lista, nunca redigitando os textos.
- [ ] **Step 4:** o mesmo comando, depois `npx vitest run src/lib/agent-core-channel.test.ts src/lib/instagram-inbound-request.test.ts --testTimeout=30000`. Esperado: PASS. A paridade falha só pela entrada nova do claim nos cenários `success`.
- [ ] **Step 5: commit do código** `fix(agent): mídia não supera o texto da rajada; aviso depois da resposta`.
- [ ] **Step 6: regravar a paridade em commit próprio.** Rode `npx vitest run src/lib/agent-turn-parity.test.ts -u --testTimeout=30000` e confira com `git diff` do `.snap` que só entrou `rpc:claim_conversation_media_notices` nos cenários `success`. Commit `test(agent): paridade com o claim do aviso de mídia`, com essa justificativa no corpo.

### Task 4: caminho de mídia do WhatsApp

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (bloco de mídia depois de `peekInboundMedia`, hoje "append do placeholder → handoff → gates → `MEDIA_REPLY_TEXT`")
- Test: `src/lib/whatsapp-media-burst-request.test.ts` (novo, com o `kind: 'media'` do chat fixture)

**Interfaces:**
- Consumes: `recordInboundMedia`, `mediaNoticeText`, `MEDIA_REPLY_TEXT` (Task 2).
- Produces: o desfecho novo `media_notice_deferred` (o aviso fica com o turno). Os de hoje continuam: `media_response`, `media_response_history_degraded`, `media_during_handoff`, `org_billing_blocked`, `whatsapp_service_suspended`, `send_error`, mais `duplicate`.

Ordem nova:
1. `noticeAllowed` = a conversa lida não está em `human_active`/`awaiting_human`;
2. `recordInboundMedia` com a mensagem de hoje mais `media_kind: media.mediaKind`, no lugar do `appendToConversation`. Erro → `throw new Error("media_message_persist_failed")` (reentrega, como o `required` de hoje);
3. a decisão:
   - `suppressed` → `media_during_handoff`, como hoje;
   - `deferred` → `media_notice_deferred`;
   - `duplicate` → `duplicate`;
   - `notice_now` → gates de serviço como hoje → envio de `variant ? mediaNoticeText([mediaKind]) : MEDIA_REPLY_TEXT` → append do assistant como hoje.

- [ ] **Step 1: testes que falham:**
  - mídia sem texto: `MEDIA_REPLY_TEXT`, `media_response`, elemento com `media_kind: 'audio'`;
  - mídia com texto sem resposta recente (fake devolve `deferred`): nada enviado, `media_notice_deferred`;
  - `notice_now` com `variant`: `mediaNoticeText(['audio'])`;
  - handoff: `media_during_handoff`, sem envio;
  - gates bloqueados: desfechos de hoje, sem envio;
  - erro do RPC: reentrega (status e desfecho iguais aos de hoje para `required` que falha).
- [ ] **Step 2:** `npx vitest run src/lib/whatsapp-media-burst-request.test.ts --testTimeout=30000`. Esperado: FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** o mesmo comando, mais `npx vitest run src/lib/agent-turn-parity.test.ts src/lib/whatsapp-ad-touchpoint-coupling.test.ts src/lib/ai-budget-wiring-guard.test.ts --testTimeout=30000` e `npx -y deno@2.9.6 check supabase/functions/webhook-whatsapp/index.ts`. Esperado: PASS e exit 0.
- [ ] **Step 5: commit** `fix(whatsapp): mídia na rajada respeita o turno do texto`.

### Task 5: caminho de mídia do Instagram

**Files:**
- Modify: `supabase/functions/process-instagram-inbound/index.ts` (`item.kind === "media"`)
- Modify: `src/features/instagram/outcome-labels.ts` (`media_notice_deferred: "Mídia: aviso depois da resposta"`)
- Test: `src/lib/instagram-inbound-request.test.ts` (fake de `rpc` com os dois RPCs; casos novos)

**Interfaces:**
- Consumes: as mesmas da Task 4. No Instagram, `media_kind` é sempre `"media"`, então o aviso variante sai com `seu arquivo`.
- Produces: os desfechos de mensagem `media_notice_deferred` e `duplicate`. Os de hoje continuam: `media_response`, `media_during_handoff`, `send_error`.

O ramo de billing bloqueado não muda (continua no `appendToConversation`). O ramo de mídia segue a mesma ordem da Task 4, sem gates de serviço do WhatsApp; os gates do IG já rodaram antes.

- [ ] **Step 1: testes que falham:**
  - o caso atual "mídia recebe MEDIA_REPLY_TEXT" continua `media_response`, agora com `media_kind: 'media'` no histórico;
  - `deferred` → `media_notice_deferred`, sem envio;
  - `notice_now` com `variant` → `mediaNoticeText(['media'])`;
  - **mesma entrega:** texto e mídia no mesmo corpo, em sequência. O texto sai `success`, e a mídia sai `media_response` com `seu arquivo` depois da resposta;
  - o caso atual de handoff continua `media_during_handoff`;
  - o cartão `template` continua `ignored_auto_card`.
- [ ] **Step 2:** `npx vitest run src/lib/instagram-inbound-request.test.ts src/lib/instagram-inbound-core.test.ts --testTimeout=30000`. Esperado: FAIL nos novos.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** o mesmo comando, mais `npx -y deno@2.9.6 check supabase/functions/process-instagram-inbound/index.ts`. Esperado: PASS e exit 0.
- [ ] **Step 5: commit** `fix(instagram): mídia na rajada respeita o turno do texto`.

### Task 6: regras, gates e release

**Files:**
- Modify:
  - `.claude/rules/agente-ia.md`: na linha da mídia e na do debounce, o invariante "mídia (`media_kind`) não supera texto; aviso adiado exatamente uma vez por `claim_conversation_media_notices`, só depois de `success`";
  - `.claude/rules/whatsapp.md`: desfechos novos na lista de `webhook_executions`;
  - `.claude/rules/instagram.md`: o mesmo na linha de mídia;
  - este plano: Evidências.

- [ ] **Step 1:** atualize as três regras (formato do AGENTS §3, uma frase com o porquê e o ponteiro) e faça o commit `docs(rules): aviso de mídia na rajada`.
- [ ] **Step 2: gates locais.** Rode `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test`, `node scripts/check-padrao.mjs`, `node scripts/check-portabilidade.mjs` (489), `node scripts/ef-import-graph.mjs` para cada arquivo de `_shared` tocado, o `deno check` das EFs da matriz e o pré-voo 83. Falhas aceitas: só as preexistentes, que falham igual num checkout limpo de `origin/main`. Registre as contagens nas Evidências.
- [ ] **Step 3: review e gates de segurança.** Review da branch inteira (`superpowers:requesting-code-review`). Depois, `saas-shield-br:migration-validator` na migration, `integration-reliability-auditor` (webhooks e fila) e `tenant-isolation-auditor` (RPC `service_role` por `conversation_id` resolvido do recurso).
- [ ] **Step 4: parar e pedir autorização para cada passo do release, na ordem:**
  1. push e PR, conferindo `acl-estatico`;
  2. `supabase migration list` do remoto e `db push` só da `20261105120000`;
  3. deploy de `webhook-whatsapp`;
  4. deploy de `process-instagram-inbound` (as duas EFs chamam o RPC novo: nunca antes do `db push`);
  5. merge.

  Rollback: redeploy das duas EFs a partir da `main` anterior. A migration é aditiva e fica.
- [ ] **Step 5: smoke em produção, com o responsável,** nos dois canais (Moralles no Instagram; uma loja de teste no WhatsApp):
  - texto e depois foto: resposta e aviso variante;
  - foto e depois texto: aviso de hoje e resposta.

  Confira os desfechos em `webhook_executions` e registre nas Evidências. Atualize a memória do follow-up.

## Evidências

_(preencher na execução)_
