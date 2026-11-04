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

# Instagram (Direct pelo Login do Facebook para Empresas, com a Página)

Plano e decisões: [2026-10-20-instagram-fase-1-direct-conversas.md](../../docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md) (D1–D9, S1–S7, contrato C1–C6). Spec: [2026-10-19-instagram-modulo-design.md](../../docs/superpowers/specs/2026-10-19-instagram-modulo-design.md). Banco: tabelas FORCE RLS e RPCs em [banco-de-dados.md](banco-de-dados.md); jobs de cron em [edge-functions.md](edge-functions.md).

## Identidade e tenant

- **A conta é identificada pelo `instagram_business_account.id` da Página escolhida em `GET /me/accounts`, que é o `entry[].id` do webhook; o `page_id` fica em `instagram_accounts.page_id` e é a base do envio (`POST /{page_id}/messages`).** [instagram-graph-core.ts](../../supabase/functions/_shared/instagram-graph-core.ts) `parsePages`.
- **`ig_user_id` e `page_id` são string só de dígitos (`parseId`); número só se `Number.isSafeInteger`.** Ids do IG têm 17 dígitos e `String(numero)` grava outro id válido, que quebra o roteamento do webhook em silêncio.
- **O webhook resolve unidade e conta no mesmo select de `instagram_accounts` (`status='connected'`), nunca pelo payload (C3).** Um POST mistura várias contas e lojas; cada linha da fila leva o `unit_id` da própria conta. [webhook-instagram/index.ts](../../supabase/functions/webhook-instagram/index.ts).
- **No `instagram-connect`, a unidade do callback vem só do `state` assinado, e `state.userId` tem de ser o usuário da sessão (C1).** Papel e grant são reconferidos no callback; operador e não membro recebem o mesmo 403 em todas as ações; erro de leitura de papel/admin/grant dá 503. A EF lê papel direto de `unit_members` + `platform_admins` (mesma consulta de `hasUnitAccess`, que não expõe o papel). [instagram-connect/index.ts](../../supabase/functions/instagram-connect/index.ts), [instagram-access-core.ts](../../supabase/functions/_shared/instagram-access-core.ts).
- **O painel de Conversas lê a conexão pela RPC `get_instagram_account_status` (`readInstagramConnection`), que vale para qualquer membro da unidade, inclusive operador, e não devolve token; a EF `instagram-connect` segue restrita a owner/gerente (C1) e só o cartão de status da página da loja a usa.** O operador atende Direct mas a EF o recusa. Em erro de leitura o envio do IG não é bloqueado (polaridade aberta): o servidor é o gate e responde 409/503. [api.ts](../../src/features/instagram/api.ts), [Conversas.tsx](../../src/pages/gestao/Conversas.tsx).
- **`get_instagram_account_status` e `get_instagram_diagnostics` são chamadas com o JWT do usuário (C6).** Com service role `auth.uid()` é nulo e a RPC recusa.
- **O `state` do OAuth não tem nonce store (R2-d): o uso único depende do código da Meta (uso único) e do frontend.** O callback da tela guarda o `state` devolvido pelo `start`, compara com o que voltou da Meta, apaga antes de chamar a EF e recusa quando não há `state` guardado; e chama `callback` uma vez só (StrictMode/reload gastariam o código). [instagram-oauth-state.ts](../../supabase/functions/_shared/instagram-oauth-state.ts).

## Segredos

- **`instagram_app_secret`, `instagram_verify_token` e `meta_app_secret` vivem só em `platform_secrets`, sem fallback de `Deno.env` e sem env de mesmo nome (S5).** Cópia em env seria credencial viva fora do painel; erro de leitura é `read_failed` → 503. [instagram-config-core.ts](../../supabase/functions/_shared/instagram-config-core.ts).
- **A leitura de `platform_secrets` fica no `index.ts` de cada EF, com `.from("platform_secrets")` literal (D3).** Constante ou indireção para escapar do `check-portabilidade` é proibida; o leitor é criado uma vez por isolate e cacheia só sucesso por 5 min.
- **`INSTAGRAM_APP_ID` e `INSTAGRAM_OAUTH_STATE_SECRET` (≥32 caracteres) são Edge secrets, lidos só no `index.ts`.** Segredo do `state` curto faz o `start` responder 503. Rotação: [RUNBOOK-ROTACAO-CREDENCIAIS.md](../../docs/RUNBOOK-ROTACAO-CREDENCIAIS.md).
- **O adapter do Graph não redige: ele nunca devolve texto remoto nem de runtime.** Quem acrescentar log com URL, corpo ou mensagem de erro passa o texto por `redactSecrets` com todas as credenciais da chamada. [instagram-graph.ts](../../supabase/functions/_shared/instagram-graph.ts).
- **Token só no header `Authorization: Bearer`, exceto nos GETs que a Meta só aceita com query (`exchangeCode`, `toLongLivedUser`, `debugToken` com `input_token`, R2-e).** POST nunca leva token na query.

## Webhook e fila

- **A assinatura `X-Hub-Signature-256` é conferida sobre os bytes crus, em tempo constante, com os candidatos `instagram` e depois `meta`, antes de qualquer parse ou leitura de conta (S6).** Só o **nome** do candidato que casou é gravado (`signature_secret`); sem nenhum segredo configurado, 503. `instagram-webhook-core.ts`.
- **O corpo é lido em stream com teto de 2 MiB (`readBodyWithCap`), nunca `arrayBuffer()`/`text()` cru.** O endpoint não tem autenticação antes da leitura.
- **`raw_body` guarda os bytes exatos (hex dos bytes, nunca texto re-codificado, R2-a).** O byte exato mantém o HMAC verificável depois (o worker hoje não revalida: só o `webhook-instagram` grava na fila, e só depois da assinatura, com INSERT por coluna a `service_role`); o CHECK do banco confere `sha256(raw_body) = body_sha256`.
- **Fila antes do ACK; gates sem cache (grant ativo e `dm_enabled`) fecham com 503 em erro de leitura; `23505` é duplicata.** Conta desconhecida, `reauth_required`, sem grant ou com Direct desligado dão 200 sem gravar.
- **O kick pós-ACK é best-effort e leva só `{ event_id }` com `x-internal-key` (R2-b); a varredura de 1 min é a rede.** O `process-instagram-inbound` tem `verify_jwt = false` em `config.toml` e `requireInternalAuth` como primeira instrução, senão o gateway devolve 401 e só o sweep processa, sem erro visível.
- **Falha do turno ANTES de qualquer efeito externo libera o claim da mensagem por `release_instagram_message_claim` (mesma cerca do `complete_…`), depois de soltar o lock da IA; depois do efeito externo a mensagem fecha `webhook_error` e nunca é liberada.** Liberar depois do envio repetiria a resposta ao cliente. [migration](../../supabase/migrations/20261103120900_instagram_message_claim_release.sql), [worker](../../supabase/functions/process-instagram-inbound/index.ts).
- **A linha da fila guarda o corpo inteiro, com entradas de outras contas; o worker processa só `entry.id === account.ig_user_id`.** Nenhuma RPC ou diagnóstico devolve `raw_body`. O worker espelha `INBOUND_MAX_ATTEMPTS` e fecha como `dead` logo depois do claim quando estourou.

## Worker e turno

- **O `process-instagram-inbound` nunca recebe payload: o kick leva só `{ event_id }` e o `?sweep=1` não tem corpo, e o worker relê a linha da fila e a reivindica por claim cercado (lease de 90 s).** Corpo aceito seria caminho sem assinatura. [index.ts](../../supabase/functions/process-instagram-inbound/index.ts).
- **Conta `connected` da própria linha, grant ativo e `dm_enabled` são relidos a cada evento, sem cache; descarte fecha `done/discarded_<motivo>` e erro de leitura reagenda.** `attempts` estourado fecha como `dead` logo depois do claim (espelho de `INBOUND_MAX_ATTEMPTS`). Unidade e organização vêm da conta e da unidade lida; contato e conversa são conferidos contra elas antes do turno e divergência é terminal com alerta, sem LLM.
- **Cada item (`mid`) é reivindicado por `claim_instagram_message`; `null` é "já concluída ou em voo" e a falha do turno ANTES de efeito externo libera pela cerca (ver Webhook e fila).** O eco só gera desfecho (`echo_own` se o `mid` está em `provider_message_ids` de uma mensagem da conversa, senão `echo_unknown`), sem append e sem silenciar a IA; `story_mention` fecha `ignored_story_mention` sem resposta. Mensagem só com anexos `template` (cartão que o próprio IG gera, ex. "Phone number" após um texto com telefone) fecha `ignored_auto_card`, sem append: tratada como mídia, ela superava o texto no debounce e respondia `MEDIA_REPLY_TEXT`. [instagram-inbound-core.ts](../../supabase/functions/_shared/instagram-inbound-core.ts).
- **Billing usa o mesmo predicado e a mesma polaridade do WhatsApp (`isOrgBillingBlocked`, FALHA ABERTA: erro de leitura de `organizations` não bloqueia).** Org bloqueada não descarta o evento: o inbound entra no histórico e a mensagem fecha `org_billing_blocked`, sem LLM nem envio. Mudar a polaridade de um canal sem o outro cria dois comportamentos para o mesmo cliente.
- **O telefone que o contato digita é declarado, não verificado: o adapter entrega ao núcleo a porta `claimedIdentity` e nada do cadastro privado (contexto leva só `{ id, phone }` do cliente ligado).** A porta tem três ofícios: `reservationIds` (ledger do contato na unidade, paginado, erro lança), `insertReservation` e `linkPhone`. Regras do núcleo com porta em `.claude/rules/agente-ia.md`.
- **`linkPhone` relê o contato e confere o teto de trocas ANTES de tocar `customers`; estourando, devolve `unavailable` (religar o mesmo cliente não é troca).** O teto também limita a criação de cadastro com telefone de terceiro. Cadastro novo usa só o nome limpo do perfil, cadastro existente preserva o nome, nunca grava e-mail (`email: null`), e qualquer erro vira `unavailable`, sem revelar se o cadastro existe.
- **Reserva do contato nasce só por `create_instagram_contact_reservation` (reserva e ledger na mesma transação, sob lock do contato, no máximo 3 reservas ativas); `record_instagram_contact_reservation` não tem `EXECUTE` para ninguém.** A segunda não aplica o teto, e dar grant a `service_role` o furaria. `link_instagram_contact_customer` aceita no máximo 3 trocas de cliente por contato em 30 dias (`P0001 instagram_contact_link_limit`). [migration](../../supabase/migrations/20261103120600_instagram_contact_reservation_atomic.sql).

## Graph e envio

- **Texto enviado tem no máximo 1000 bytes UTF-8 por mensagem (`INSTAGRAM_MAX_TEXT_BYTES`), sem markdown.** O limite é em bytes, não caracteres; a divisão não quebra code point.
- **Resultado com `ok:false` e HTTP 2xx, HTTP nulo, ou `transient` em POST é "desfecho desconhecido": a mensagem pode ter saído.** Use `isGraphOutcomeUnknown`; nunca reenviar sozinho nem gravar como "não enviada".
- **A inscrição da Página (`POST /{page_id}/subscribed_apps`, `messages`) só passa com `pages_manage_metadata` E `pages_messaging` na configuração de login (caso de uso "Interagir com os clientes no Messenger" no app).** Faltando uma, a Meta devolve HTTP 403 com código 200 e o webhook nunca chega, sem outro erro visível; reconectar depois de mudar a config. Visto no piloto.
- **Classes de erro do Graph são as da tabela do plano (`190` → `reauth_required` etc.), mais 429/17/32 → `rate_limited` e 1/2 → `transient`.** Código `10` sem permissão também cai em `window_closed`: medir no piloto. `classifyGraphError`.

## Token

- **O token da Página não expira e nenhum worker o renova.** O `debug_token` do conectar grava `data_access_expires_at` (90 dias da última atividade do usuário) em `token_expires_at`; o painel avisa "Reconecte até DD/MM/AAAA" e reconectar renova. Token expirado ou revogado é `190` → `reauth_required`. [instagram-connect/index.ts](../../supabase/functions/instagram-connect/index.ts).
- **`page_id` nulo ou inválido no envio vira `reauth_required` com `page_missing`.** Sem a Página não há endpoint de envio; a conta precisa reconectar. [send-manual-message/index.ts](../../supabase/functions/send-manual-message/index.ts).
- **`set_instagram_account_status` exige o `connected_at` que o chamador leu e devolve `false`, sem efeito, se a conta reconectou depois (CAS).** Sem isso, a escrita atrasada de uma leitura antiga derruba a conexão nova para `reauth_required`; quem chama trata `false` como `skipped_stale`/`reauth_stale`, nunca como falha nem sucesso. [migration](../../supabase/migrations/20261103120800_instagram_account_cas_connected_at.sql).
