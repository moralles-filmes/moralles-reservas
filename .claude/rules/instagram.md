---
paths:
  - "supabase/functions/*instagram*/**"
  - "supabase/functions/_shared/instagram-*"
  - "supabase/migrations/*instagram*"
  - "src/**/instagram/**"
  - "src/pages/gestao/Instagram*"
  - "src/pages/InstagramCallback*"
  - "src/lib/instagram-*"
---

# Instagram (Direct pela Instagram API with Instagram Login)

Plano e decisões: [2026-10-20-instagram-fase-1-direct-conversas.md](../../docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md) (D1–D9, S1–S7, contrato C1–C6). Spec: [2026-10-19-instagram-modulo-design.md](../../docs/superpowers/specs/2026-10-19-instagram-modulo-design.md). Banco: tabelas FORCE RLS e RPCs em [banco-de-dados.md](banco-de-dados.md); jobs de cron em [edge-functions.md](edge-functions.md).

## Identidade e tenant

- **A conta é identificada pelo `user_id` de `GET /me?fields=user_id,username,account_type`, que é o `entry[].id` do webhook (S1).** O `user_id` da troca do código é "app-scoped" e nunca é gravado. [instagram-graph-core.ts](../../supabase/functions/_shared/instagram-graph-core.ts) `parseMe`.
- **`ig_user_id` é string; número só se `Number.isSafeInteger`.** Ids do IG têm 17 dígitos e `String(numero)` grava outro id válido, que quebra o roteamento do webhook em silêncio. `parseMe`.
- **O webhook resolve unidade e conta no mesmo select de `instagram_accounts` (`status='connected'`), nunca pelo payload (C3).** Um POST mistura várias contas e lojas; cada linha da fila leva o `unit_id` da própria conta. [webhook-instagram/index.ts](../../supabase/functions/webhook-instagram/index.ts).
- **No `instagram-connect`, a unidade do callback vem só do `state` assinado, e `state.userId` tem de ser o usuário da sessão (C1).** Papel e grant são reconferidos no callback; operador e não membro recebem o mesmo 403 em todas as ações; erro de leitura de papel/admin/grant dá 503. A EF lê papel direto de `unit_members` + `platform_admins` (mesma consulta de `hasUnitAccess`, que não expõe o papel). [instagram-connect/index.ts](../../supabase/functions/instagram-connect/index.ts), [instagram-access-core.ts](../../supabase/functions/_shared/instagram-access-core.ts).
- **`get_instagram_account_status` e `get_instagram_diagnostics` são chamadas com o JWT do usuário (C6).** Com service role `auth.uid()` é nulo e a RPC recusa.
- **O `state` do OAuth não tem nonce store (R2-d): o uso único depende do código da Meta (uso único) e do frontend.** O callback da tela guarda o `state` devolvido pelo `start`, compara com o que voltou da Meta, apaga antes de chamar a EF e recusa quando não há `state` guardado; e chama `callback` uma vez só (StrictMode/reload gastariam o código). [instagram-oauth-state.ts](../../supabase/functions/_shared/instagram-oauth-state.ts).

## Segredos

- **`instagram_app_secret`, `instagram_verify_token` e `meta_app_secret` vivem só em `platform_secrets`, sem fallback de `Deno.env` e sem env de mesmo nome (S5).** Cópia em env seria credencial viva fora do painel; erro de leitura é `read_failed` → 503. [instagram-config-core.ts](../../supabase/functions/_shared/instagram-config-core.ts).
- **A leitura de `platform_secrets` fica no `index.ts` de cada EF, com `.from("platform_secrets")` literal (D3).** Constante ou indireção para escapar do `check-portabilidade` é proibida; o leitor é criado uma vez por isolate e cacheia só sucesso por 5 min.
- **`INSTAGRAM_APP_ID` e `INSTAGRAM_OAUTH_STATE_SECRET` (≥32 caracteres) são Edge secrets, lidos só no `index.ts`.** Segredo do `state` curto faz o `start` responder 503. Rotação: [RUNBOOK-ROTACAO-CREDENCIAIS.md](../../docs/RUNBOOK-ROTACAO-CREDENCIAIS.md).
- **O adapter do Graph não redige: ele nunca devolve texto remoto nem de runtime.** Quem acrescentar log com URL, corpo ou mensagem de erro passa o texto por `redactSecrets` com todas as credenciais da chamada. [instagram-graph.ts](../../supabase/functions/_shared/instagram-graph.ts).
- **Token só no header `Authorization: Bearer`, exceto nos GETs que a Meta só aceita com query (`toLongLived`, `refresh`, R2-e).** POST nunca leva token na query.

## Webhook e fila

- **A assinatura `X-Hub-Signature-256` é conferida sobre os bytes crus, em tempo constante, com os candidatos `instagram` e depois `meta`, antes de qualquer parse ou leitura de conta (S6).** Só o **nome** do candidato que casou é gravado (`signature_secret`); sem nenhum segredo configurado, 503. `instagram-webhook-core.ts`.
- **O corpo é lido em stream com teto de 2 MiB (`readBodyWithCap`), nunca `arrayBuffer()`/`text()` cru.** O endpoint não tem autenticação antes da leitura.
- **`raw_body` guarda os bytes exatos (hex dos bytes, nunca texto re-codificado, R2-a).** A revalidação do HMAC no worker exige o byte exato; o CHECK do banco confere `sha256(raw_body) = body_sha256`.
- **Fila antes do ACK; gates sem cache (grant ativo e `dm_enabled`) fecham com 503 em erro de leitura; `23505` é duplicata.** Conta desconhecida, `reauth_required`, sem grant ou com Direct desligado dão 200 sem gravar.
- **O kick pós-ACK é best-effort e leva só `{ event_id }` com `x-internal-key` (R2-b); a varredura de 1 min é a rede.** O `process-instagram-inbound` (Task 4.1) precisa de `verify_jwt = false` e `requireInternalAuth` como primeira instrução, senão o gateway devolve 401 e só o sweep processa, sem erro visível.
- **Falha do turno ANTES de qualquer efeito externo libera o claim da mensagem por `release_instagram_message_claim` (mesma cerca do `complete_…`), depois de soltar o lock da IA; depois do efeito externo a mensagem fecha `webhook_error` e nunca é liberada.** Liberar depois do envio repetiria a resposta ao cliente. [migration](../../supabase/migrations/20261029200900_instagram_message_claim_release.sql), [worker](../../supabase/functions/process-instagram-inbound/index.ts).
- **A linha da fila guarda o corpo inteiro, com entradas de outras contas; o worker processa só `entry.id === account.ig_user_id`.** Nenhuma RPC ou diagnóstico devolve `raw_body`. O worker espelha `INBOUND_MAX_ATTEMPTS` e fecha como `dead` logo depois do claim quando estourou.

## Graph e envio

- **Texto enviado tem no máximo 1000 bytes UTF-8 por mensagem (`INSTAGRAM_MAX_TEXT_BYTES`), sem markdown.** O limite é em bytes, não caracteres; a divisão não quebra code point.
- **Resultado com `ok:false` e HTTP 2xx, HTTP nulo, ou `transient` em POST é "desfecho desconhecido": a mensagem pode ter saído.** Use `isGraphOutcomeUnknown`; nunca reenviar sozinho nem gravar como "não enviada" (Tasks 4.1/4.2).
- **Classes de erro do Graph são as da tabela do plano (`190` → `reauth_required` etc.), mais 429/17/32 → `rate_limited` e 1/2 → `transient`.** Código `10` sem permissão também cai em `window_closed`: medir no piloto. `classifyGraphError`.

## Token

- **A idade do token é `coalesce(token_refreshed_at, connected_at)`; a renovação começa aos 30 dias e o vencido vira `reauth_required` sem chamar o Graph.** [process-instagram-token-refresh/index.ts](../../supabase/functions/process-instagram-token-refresh/index.ts), [instagram-token-refresh-core.ts](../../supabase/functions/_shared/instagram-token-refresh-core.ts).
- **O refresh processa as contas devidas mais antigas primeiro, com orçamento de tempo por execução.** Ordem fixa sem orçamento deixaria as mesmas contas do fim sem renovar até vencer.
- **A renovação continua para conta `connected` de unidade com grant revogado.** A revogação desliga a ingestão (webhook/worker), não a credencial; desconectar é ato do dono ou da plataforma.
- **`set_instagram_account_status` e `record_instagram_token_refresh` exigem o `connected_at` que o chamador leu e devolvem `false`, sem efeito, se a conta reconectou depois (CAS).** Sem isso, a escrita atrasada de uma leitura antiga derruba a conexão nova para `reauth_required` ou sobrescreve o token novo; quem chama trata `false` como `skipped_stale`/`reauth_stale`, nunca como falha nem sucesso. [migration](../../supabase/migrations/20261029200800_instagram_account_cas_connected_at.sql).
