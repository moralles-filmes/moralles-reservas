# Instagram Fase 1 — Direct + Conversas: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a loja piloto atende pelo Direct do Instagram com o mesmo agente do WhatsApp; a reserva cai no sistema com `source='instagram'` e a conversa aparece em Conversas com filtro de canal.

**Architecture:** canal novo com tabelas próprias (conta, contato, fila, ledger por mensagem), webhook que só autentica, persiste e dá ACK, e worker que monta o `ChannelContext` do Instagram e roda `createAgentTurn`. O núcleo do agente ganha cliente opcional e uma porta de "identidade declarada" (o telefone digitado no Direct não é verificado). Conversas passa a ter `channel` e `customer_id` opcional.

**Tech Stack:** Supabase (Postgres, Vault, pg_cron + pg_net, Edge Functions Deno), Instagram API com Instagram Login (Graph `v26.0`), Vite + React + TanStack Query, Vitest, pré-voo SQL local.

**Spec:** [2026-10-19-instagram-modulo-design.md](../specs/2026-10-19-instagram-modulo-design.md). Evidências da Fase 0: [2026-10-19-instagram-fase-0-pre-requisitos.md](2026-10-19-instagram-fase-0-pre-requisitos.md) (seções "Task 3" e "Task 4").

**Estado:** plano escrito em 2026-10-20 na branch `feat/instagram-fase-1` (worktree `.claude/worktrees/instagram-fase-1`, a partir de `origin/main` `bab6033`). Nenhum código, migration, deploy ou chamada à Meta. Push, PR, `supabase db push`, deploy, secrets e grant da loja exigem autorização própria, cada um.

---

## Decisões do responsável (2026-10-20)

| # | Tema | Decisão |
|---|---|---|
| D1 | Loja piloto | **Moralles**. A conta IG Profissional dela entra no app com papel até haver Advanced Access. |
| D2 | `ctx.send` cru no auto-resolve e no lembrete de handoff | **Corrigir nesta fase** com compare-and-set antes do envio. O snapshot de paridade é regravado num commit separado, com o diff revisado linha a linha. |
| D3 | Porta de dados do núcleo (`check-portabilidade`) | **Adiada.** O código novo do Instagram fica em `index.ts` (adapter), em `src/features/instagram/api.ts` e em núcleos puros. Se a contagem de um arquivo subir acima da linha de base, a execução **para e pergunta**. |
| D4 | Telefone informado no Direct | **Ligação não verificada.** A reserva vai para o cadastro do telefone, como no portal público. O prompt do Instagram nunca recebe dados privados do cadastro (nome gravado, alergias, preferências, vouchers, aniversário). Consultar, alterar e cancelar alcançam só as reservas criadas por este contato do Instagram (ledger `instagram_contact_reservations`). |
| D5 | Eco (`is_echo`) | **Descartar e medir.** O eco não entra na conversa nem silencia a IA. O worker grava só o desfecho `echo_own` ou `echo_unknown`, sem conteúdo. A tela avisa que a resposta pelo app do Instagram não pausa a IA. |
| D6 | Confirmação da reserva `source='instagram'` | **Vai pelo WhatsApp.** O trigger `enqueue_confirmation_notification` continua pulando só `'whatsapp'`. A migration só amplia o CHECK, e a IA diz que a confirmação e os lembretes chegam pelo WhatsApp. |
| D7 | Ordem com a Entrega B (prompt global) | **Intercalar.** Os Blocos 1 e 2 não tocam o núcleo e podem rodar antes ou durante a Entrega B. O Bloco 3 começa depois que a B3 estiver em `main`, ou rebaseia sobre ela no início do chat. |
| D8 | Política de privacidade e exclusão de dados (exigidas para publicar o app) | **Páginas no portal**, `/privacidade` e `/privacidade/exclusao-de-dados`, com **texto fornecido pelo responsável**. O agente não redige texto jurídico. |
| D9 (2026-10-20, Bloco 1) | Rota gerenciada de automação recusa `source='instagram'` (`captureExpected` em `_shared/whatsapp-automation-resources.ts` e `app_private.whatsapp_automation_post_inner` da `20261019193132`) | **Ampliar a rota gerenciada.** Sem isso, numa unidade adotada a reserva do Instagram fica sem confirmação, lembrete, pesquisa e cancelamento, em silêncio (fail-closed). Task 4.5, antes do grant do piloto. |

### Desvios da spec (deliberados, com o motivo)

- **S1 — chave do tenant:** a conta é identificada pelo `user_id` de `GET /me?fields=user_id,username,account_type`, que é o `entry[].id` do webhook. Nunca se usa o `user_id` da troca do código: a doc o chama de "app-scoped".
- **S2 — concessão do módulo:** a spec previa uma EF que confere `platform_admin`. Fica uma RPC `SECURITY DEFINER` com a guarda `app_private.is_platform_admin(auth.uid())` no próprio corpo. O pré-voo prova a guarda em SQL; uma EF não acrescentaria nada.
- **S3 — `instagram_settings`:** só `dm_enabled` nesta fase. As colunas de Stories e Comentários entram com as Fases 2 e 3 (YAGNI).
- **S4 — confirmação:** a decisão D6 dispensa a mudança no trigger que a spec previa.
- **S5 — segredos novos sem fallback de `Deno.env`:** `instagram_app_secret`, `instagram_verify_token` e `meta_app_secret` (opcional) são lidos de `platform_secrets` no padrão do leitor Datafy (`datafy-account-config-core.ts`). Uma falha de leitura é tratada como falha, não como env. Por isso **não se cria env com o mesmo nome**: uma cópia em env seria credencial viva fora do painel (AGENTS §5). Os segredos de Edge `INSTAGRAM_APP_ID` e `INSTAGRAM_OAUTH_STATE_SECRET` vão por `supabase secrets set`.
- **S6 — assinatura do webhook:** a doc da Meta não diz se a chave do HMAC é o segredo do app Instagram ou o do app Meta. A verificação aceita os dois segredos configurados, ambos nossos, em tempo constante, e registra só o **nome** do que casou. O piloto mede, e o não usado sai do painel depois.
- **S7 — Stories na Fase 1:** `story_mention` é descartado com o desfecho `ignored_story_mention`, sem resposta. A resposta a story com texto é tratada como texto.

### Fatos da Meta reconferidos em 2026-10-20

Fonte: doc oficial em `developers.facebook.com/documentation/instagram-platform/`, lida só para leitura, sem chamar API.

**Confirmados:**
- os escopos `instagram_business_*`;
- Advanced Access + App Review + Business Verification para contas de terceiros;
- conta Profissional;
- token curto de 1h e longo de 60 dias, com renovação a partir de 24h de idade;
- o `subscribed_apps` de cada conta;
- o desafio `hub.*`;
- o `story_mention` em `messages`;
- a resposta privada a comentário (1 por comentário, em até 7 dias).

**Mudou ou é novo em relação à spec:**
1. A chave da conta é o `user_id` de `/me` (S1).
2. O texto tem limite de **1000 bytes** UTF-8, não de caracteres.
3. A reentrega dura **36h**. Um lote traz até 1000 updates, de várias contas, e eventos podem chegar fora de ordem. A Messenger Platform pede resposta em ≤5s e desliga o webhook depois de 1h de falha contínua.
4. Qual segredo assina o webhook não está documentado (S6).
5. O eco (`is_echo`) não distingue API de humano (D5).
6. A versão atual do Graph é a `v26.0`.
7. Publicar o app (Live) é exigido para webhooks, com política de privacidade e URL de exclusão de dados (D8).
8. Há um tipo de anexo novo, `ig_post`, tratado como `media`.
9. O CA de mTLS da Meta mudou. Isso só importa se um dia usarmos mTLS.
10. Nomes de campo divergem entre páginas da doc (`messaging_referral` × `messaging_referrals`).

**Não verificáveis na doc oficial (medir no piloto):**
- o caminho "Ferramentas conectadas → Permitir acesso às mensagens" no app;
- o fluxo de convite de testador;
- se o Standard Access recebe webhook só de contas com papel;
- a validade da URL de CDN de story.

---

## Global Constraints

- Graph API `INSTAGRAM_GRAPH_VERSION = "v26.0"`. Endpoints:
  - autorização `https://www.instagram.com/oauth/authorize`;
  - troca do código `POST https://api.instagram.com/oauth/access_token`;
  - token longo `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`;
  - renovação `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`;
  - identidade `GET https://graph.instagram.com/v26.0/me?fields=user_id,username,account_type`;
  - assinatura `POST https://graph.instagram.com/v26.0/{ig_user_id}/subscribed_apps?subscribed_fields=messages`;
  - envio `POST https://graph.instagram.com/v26.0/{ig_user_id}/messages`;
  - perfil `GET https://graph.instagram.com/v26.0/{igsid}?fields=name,username`.
- Escopos da Fase 1: `instagram_business_basic,instagram_business_manage_messages`. `instagram_business_manage_comments` só entra na Fase 3.
- Código OAuth: vale 1h e é de uso único. Tire o sufixo `#_`. A resposta da troca vem num array `data`.
- Token curto dura 1h e o longo, 60 dias. A renovação exige token com ≥24h e ainda válido, e o sistema renova a partir de 30 dias de idade. `account_type` aceito: `Business` ou `Media_Creator`.
- Texto enviado: **UTF-8 com no máximo 1000 bytes** por mensagem (`INSTAGRAM_MAX_TEXT_BYTES = 1000`). Sem markdown.
- Janela de 24h desde o último inbound do cliente. A tag `HUMAN_AGENT` fica fora da Fase 1.
- Webhook:
  - responde em ≤5s;
  - a Meta reentrega por até 36h, então a premissa de reentrega é `documented`;
  - um POST traz até 1000 updates e pode misturar **várias contas**;
  - eventos chegam duplicados e fora de ordem: ordenar por `timestamp` e deduplicar.
- Assinatura: `X-Hub-Signature-256: sha256=<64 hex>`, HMAC-SHA256 sobre os **bytes crus** do corpo. A comparação é em tempo constante, com os candidatos `instagram` e depois `meta`.
- Classes de erro do Graph:
  - `190` → `reauth_required`
  - `10`/`2534022` → `window_closed`
  - `4`, `613` → `rate_limited`
  - `551`, `2018108`, `2534014`, `2018001` → `recipient_unavailable`
  - HTTP 5xx e rede → `transient`
  - o resto → `invalid_request`
- Nenhum token aparece em log, DTO, erro, `bodySnippet` ou prompt. URL do Graph com token é redigida na origem.
- **Não alterar** `_shared/security.ts` (47 EFs) nem `_shared/authz.ts`.
- Migration nova:
  - timestamp maior que a última migration de `origin/main` no momento da execução;
  - `revoke all on function <assinatura completa> from public, anon, authenticated` antes de qualquer grant;
  - helper `app_private.*` qualificado;
  - sem URL do projeto e sem segredo (leia do Vault `project_url`/`internal_api_key`).
- Pré-voo: arquivos `79a-instagram-bootstrap.sql` e `79-instagram-module.sql`, ordinais `7901–7999` (a `78` é da Entrega B). Todo caso tem controle positivo.
- Gates locais:
  - `npm run typecheck` (`tsc -b --noEmit`), com zero erros;
  - `npm run lint`, sem erro novo;
  - `npm run test`: só as ~45 falhas preexistentes listadas no Bloco 6;
  - `npm run build`;
  - `npx -y deno@2.1.4 check` de cada EF tocada;
  - `node scripts/check-padrao.mjs`;
  - `node scripts/check-portabilidade.mjs`.
- `strict: false`: use `x.ok === false` e nunca `!x.ok` para estreitar união.
- CLI: `npx -y supabase@2.121.0 <cmd> --project-ref gbabxcrntkwgblgqsiit --use-api`.
- Antes de qualquer chamada paga ou destrutiva a provider (Meta, Graph), confirmar com o responsável a conta pelo nome (`@` da Moralles).
- Copy da interface em PT-BR. O título da tela de conversas é "Conversas".

## Review Focus

1. **POST com entradas de duas contas (duas lojas):** cada linha da fila processa só as entradas da própria conta e nenhuma mensagem de A vira turno na unidade de B. Testes: Task 2.3 (`webhook grava uma linha por conta do lote`) e Task 4.1 (`worker ignora entradas de outra conta no mesmo corpo`).
2. **Reentrega da mesma mensagem dentro de outro lote:** um único turno de IA por `mid`. Teste: Task 4.1 (`mesmo mid em dois corpos diferentes roda um turno`).
3. **Grant revogado, Direct desligado ou conta desconectada entre o ACK e o processamento:** descarte sem resposta e sem custo. Teste: Task 4.1 (`revogação depois do ACK descarta sem LLM`).
4. **Telefone digitado de um cliente que tem vouchers, alergias e reservas:** nada disso entra no prompt, e consultar, listar ou cancelar não encontram reserva que o contato não criou. Testes: Task 3.3 (`prompt do contato declarado não lê vouchers nem preferências`) e Task 3.4 (`identidade declarada só alcança reservas do ledger`).
5. **Texto com acento ou emoji perto de 1000 bytes, e mensagem manual de 4096 caracteres:** divisão por bytes sem quebrar code point, e falha parcial reportada sem mentir na thread. Testes: Task 3.2 (`divide por bytes sem quebrar par substituto`) e Task 4.2 (`envio manual parcial grava só o que saiu`).

---

## Leitores de `conversations.customer_id` e suposições de "conversa = WhatsApp"

Mapeados em 2026-10-20 sobre `bab6033`. Cada linha tem uma task responsável. Nenhuma linha com `channel='instagram'` ou `customer_id` nulo pode existir antes do grant do piloto, que é o último passo do Bloco 6. Por isso todos os leitores entram no mesmo release, antes do grant.

| Ponto | Impacto | Task |
|---|---|---|
| `get_or_create_whatsapp_conversation` (`20260905143453…:204`): busca por `(customer_id, unit_id)` sem canal | devolveria a conversa IG de um cliente ligado e sobrescreveria `contact_name`/`wa_chat_lid` | 1.4 |
| `app_private.reconcile_whatsapp_automation_acceptance_inner` (`20261019183559…:900-907`) | mesmo defeito no `exists` | 1.4 |
| `appendOutboundToConversation` ([conversation-log.ts](../../../supabase/functions/_shared/conversation-log.ts)) via a RPC acima | log de automação WhatsApp cairia na conversa IG | 1.4 (corrigido pela RPC) |
| Dead-letter do `webhook-whatsapp` (`index.ts:1135-1188`): lookup por `(unit_id, customer_id)` | promoveria a conversa IG | 4.3 |
| `send-manual-message` (`index.ts:98-174`): exige canal WhatsApp e envia ao `customer.phone` | resposta do painel a uma conversa IG sairia pelo WhatsApp | 4.2 |
| `_shared/agent/turn.ts:320,1099-1132` e `system-prompt.ts:484-567`: `customer.id`, `customer.birthday` etc. | crash com cliente nulo | 3.3, 3.4 |
| `channel-context.ts:75,81,90`: `customer` e `phone` obrigatórios, `reservationSource:"whatsapp"` | tipo | 3.4 |
| `src/types/reserva.ts:513-529` (`Conversation.customer_id: string`, sem `channel`) | tipo | 5.1 |
| `useConversations.ts:14-15` `LIST_COLUMNS` | falta `channel` e o embed do contato | 5.4 |
| `getConversationDisplayName` (`src/lib/utils.ts:143-156`) | sem fonte IG | 5.4 |
| `Conversas.tsx:34,123,195-198,243-492` (`canSend` pelo canal WhatsApp, copy "WhatsApp", telefone vazio) | exibição e envio | 5.4 |
| `useSendManualMessage.ts:15,27,82` | copy e invalidação | 5.4 |
| `useAwaitingHumanCount.ts` conta todos os canais | intencional: o badge soma os canais | — |
| `anonymize_customer` não alcança o contato ligado | LGPD | 1.2 (trigger) |
| FK `conversations.customer_id … on delete cascade` | nenhum caminho apaga cliente de fato; mantém-se | — |
| Fixtures: `whatsapp-automation-fixtures.ts:102,135`, pré-voos `67d`, `08`, `38`, `whatsapp-inbound-reentry.test.ts:539-670` | schema de teste | 1.4, 4.3 |

---

## Mapa de arquivos

**Migrations** (`supabase/migrations/<ts>_*.sql`):

| Arquivo | Conteúdo |
|---|---|
| `_instagram_module_grants.sql` | `unit_module_grants`, `instagram_settings`, `set_unit_module_grant`, `get_unit_modules` |
| `_instagram_accounts_contacts.sql` | `instagram_accounts` + RPCs com Vault; `instagram_contacts`, `instagram_contact_reservations`; trigger de anonimização |
| `_instagram_inbound_queue.sql` | `instagram_inbound_events`, `instagram_processed_messages`, RPCs de claim/finalize/purge, `get_instagram_diagnostics`, wrappers de cron |
| `_conversations_instagram_channel.sql` | `conversations.channel`/`instagram_contact_id`, `customer_id` opcional, guardas, RPCs de conversa e ligação, filtro de canal nas duas RPCs WhatsApp |
| `_reservations_source_instagram.sql` | CHECK de `reservations.source` |
| `_instagram_cron.sql` | `cron.schedule` dos três jobs |

**`_shared/` novos:**
- `instagram-graph-core.ts` (puro) e `instagram-graph.ts` (adapter `fetch`);
- `instagram-oauth-state.ts`;
- `instagram-config-core.ts` e `instagram-config.ts`;
- `instagram-webhook-core.ts`;
- `instagram-access-core.ts`;
- `instagram-token-refresh-core.ts`;
- `instagram-format.ts`;
- `instagram-inbound-core.ts`;
- `media-reply-text.ts`;
- `agent/tool-dispatch.ts`.

**`_shared/` alterados:**
- `agent/channel-context.ts`, `agent/turn.ts`, `agent/system-prompt.ts`, `agent/tools.ts`;
- `agent-reservation-tools.ts`;
- `availability.ts` (só o tipo de `source`);
- `org-billing-gate-core.ts` (novo, se o predicado do webhook for inline; ver 4.1).

**EFs novas:** `webhook-instagram`, `instagram-connect`, `process-instagram-inbound`, `process-instagram-token-refresh`.

**EFs alteradas:** `webhook-whatsapp`, `send-manual-message`, `manage-platform-secrets`.

**Configuração:** `supabase/config.toml` ganha quatro entradas.

**Frontend:**
- novos: `src/features/instagram/{api.ts,types.ts}`, `src/hooks/useInstagram.ts`, `src/components/instagram/InstagramAdminCard.tsx`, `src/pages/gestao/Instagram.tsx`, `src/pages/InstagramCallback.tsx`, `src/pages/public/{Privacidade.tsx,PrivacidadeExclusao.tsx}`, `src/lib/conversation-channel.ts`;
- alterados: `App.tsx`, `GestaoLayout.tsx`, `Automacao.tsx`, `Conversas.tsx`, `useConversations.ts`, `useSendManualMessage.ts`, `utils.ts`, `types/reserva.ts`, `platform/Integracoes.tsx`, `useFluxoClientes.ts`, `useDashboardMetrics.ts`, `exportCsv.ts`.

**Testes:**
- harness de Request: `src/test/fixtures/edge-request-harness.ts` (`EdgeName` e `ENDPOINTS` ganham as quatro EFs novas);
- `src/lib/instagram-*.test.ts`;
- `src/lib/agent-*.test.ts`;
- pré-voo `79*`.

**Regras:** nova `.claude/rules/instagram.md` (com `paths:` das EFs, cores, migrations e telas do Instagram), mais uma linha na tabela do AGENTS.md §2. Também `agente-ia.md`, `whatsapp.md`, `reservas.md`, `banco-de-dados.md` e `edge-functions.md`.

---

## Blocos, chats e modelos

Um bloco por chat, em sequência, nunca em paralelo. Cada chat:
1. começa com `git fetch` e rebase de `feat/instagram-fase-1` sobre `origin/main`;
2. relê as regras dos assuntos que vai tocar;
3. termina com commits, checkboxes marcados, a seção "Evidências" do bloco preenchida e a memória do módulo atualizada.

O push só acontece com autorização.

| Bloco | Conteúdo | Pré-requisito | Implementador | Reviews |
|---|---|---|---|---|
| 1 | Banco: 6 migrations + pré-voo | — | **Opus** (SQL/RLS/ACL) | spec: Sonnet; qualidade e segurança: Opus |
| 2 | EFs da Meta: Graph, OAuth, segredos, webhook, connect, refresh | Bloco 1 | **Opus** em 2.2–2.4; **Sonnet** em 2.1 e 2.5 (núcleo puro com teste) | segurança: Opus em todas |
| 3 | Núcleo do agente: CAS, formatação, prompt, cliente opcional, identidade declarada | Bloco 2 **e** B3 da Entrega B em `main` (ou rebase sobre ela) | **Opus** em 3.1, 3.3 e 3.4 (caminho de produção do WhatsApp); **Sonnet** em 3.2 | segurança: Opus |
| 4 | Worker, envio manual, dead-letter | Blocos 1–3 | **Opus** (webhook, adapter, tenant) | segurança: Opus |
| 5 | Frontend | Blocos 1, 2 e 4 (contratos) | **Sonnet** (UI) | qualidade: Sonnet; Opus só em 5.1 (`api.ts`, chaves por unidade) e na rota de callback |
| 6 | Release: review da branch, gates, PR, banco, deploy, Meta, piloto | Blocos 1–5 | **Opus** | — |

Motivo da escolha: o Opus fica onde um erro vaza dado entre lojas, abre credencial ou duplica envio ao cliente. O Sonnet fica onde o teste gêmeo ou a tela prova o resultado, e o Opus revisa o que toca autorização.

---

## Bloco 1 — Banco

Antes de começar: leia `.claude/rules/banco-de-dados.md`, o `supabase/tests/local-preflight/README.md` (seções "Rodar" e §75) e as migrations citadas abaixo. Copie o padrão do grant Datafy (`20261014120000_datafy_partner_onboarding.sql:48-80,223-295`), o do Vault UazAPI (`20261004025039…:191-287`, `20260817170753…:534`) e o da fila (`20260924120000_111…`, `…120200_113…`).

Cada task termina com o arquivo `79-instagram-module.sql` executando os casos dela e com o controle positivo registrado.

### Task 1.1: `unit_module_grants` e `instagram_settings`

**Files:**
- Create: `supabase/migrations/<ts>_instagram_module_grants.sql`
- Create: `supabase/tests/local-preflight/79a-instagram-bootstrap.sql`, `supabase/tests/local-preflight/79-instagram-module.sql`
- Modify: `scripts/function-acl-allowlist.json`

**Interfaces:**
- Produces:
  - tabela `public.unit_module_grants(id, organization_id, unit_id, module text check (module in ('instagram')), granted_by, granted_at, revoked_by, revoked_at)`, com um grant ativo por `(unit_id, module)` (índice único parcial `where revoked_at is null`);
  - tabela `public.instagram_settings(unit_id pk, organization_id, dm_enabled boolean not null default false, updated_by, updated_at)`;
  - `public.set_unit_module_grant(p_unit_id uuid, p_module text, p_active boolean) returns table(module text, active boolean, granted_at timestamptz, revoked_at timestamptz)`, com `EXECUTE` para `authenticated`. A guarda interna é `app_private.is_platform_admin(auth.uid())`, senão `42501`. O ator vem de `auth.uid()`, nunca de parâmetro. A organização sai de `units`. A função é idempotente nos dois sentidos. Ao conceder, cria a linha de `instagram_settings` com `on conflict do nothing`.
  - `public.get_unit_modules(p_unit_id uuid) returns table(module text, active boolean, granted_at timestamptz)`, com `EXECUTE` para `authenticated`. A guarda é `app_private.is_unit_member(auth.uid(), p_unit_id) or app_private.is_platform_admin(auth.uid())`, senão `42501`.

- [x] **Step 1: Escreva os casos do pré-voo (falham sem a migration).**
  - IG-1.1: um owner da unidade chama `set_unit_module_grant` e recebe `42501`. Um `platform_admin` sem membership concede e recebe `active=true`.
  - IG-1.2: conceder duas vezes deixa uma linha ativa. Revogar grava `revoked_at` e `revoked_by = auth.uid()`.
  - IG-1.3: `get_unit_modules` de B chamado por um membro de A recebe `42501`. Um membro de A lê o de A.
  - IG-1.4: um operador faz `update instagram_settings set dm_enabled=true` e o valor fica `false`. Gerente e `platform_admin` sem membership mudam o valor. Um membro de A não lê o `instagram_settings` de B.
  - IG-1.5: ACL. `has_function_privilege('anon', …)` é `false` nas duas RPCs. `authenticated` não tem `INSERT`/`DELETE` em `instagram_settings`, e não tem nada em `unit_module_grants`.
  - Controle positivo de IG-1.1: troque a guarda por `true` via `pg_get_functiondef`, veja o caso reprovar e restaure.
- [x] **Step 2: Rode o pré-voo e confira que IG-1.x falham.** Use a receita do README §75, com o bootstrap `79a` emulando os privilégios padrão do Supabase como o `61a` faz. Esperado: falha por objeto inexistente.
- [x] **Step 3: Escreva a migration.**
  - Guard trigger: `organization_id` igual a `units.organization_id` (padrão `whatsapp_official_connection_grants_guard`).
  - Tabelas: `enable` + `force row level security`. `unit_module_grants` fica sem policy, com `revoke all … from public, anon, authenticated` e grants a `service_role`.
  - `instagram_settings`: policy de select para membro ou `platform_admin`; policy de update para owner/gerente (`exists … unit_members … role in ('owner','gerente')`) ou `platform_admin`. `authenticated` recebe `select` e `update (dm_enabled)`, sem insert nem delete.
  - Trigger `BEFORE UPDATE` grava `updated_by = auth.uid()` e `updated_at = now()` e congela `unit_id`/`organization_id`.
  - Auditoria: `unit_module_grants_audit` com `audit_trigger_func()`. A tabela não entra na allowlist de membro.
  - Revokes com a assinatura completa nas quatro funções. Entradas na allowlist para `set_unit_module_grant(uuid,text,boolean)` e `get_unit_modules(uuid)` com o `why`.
- [x] **Step 4: Rode o pré-voo e confira IG-1.1–1.5 `ok` e o controle positivo reprovando/restaurado.**
- [x] **Step 5: Rode `npx vitest run scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts` e confira PASS.**
- [x] **Step 6: Commit** `feat(instagram): grant de módulo por unidade e configurações do Direct`.

### Task 1.2: conta, contato, ledger de reservas e anonimização

**Files:**
- Create: `supabase/migrations/<ts>_instagram_accounts_contacts.sql`
- Modify: `79-instagram-module.sql`, `79a-instagram-bootstrap.sql`, `scripts/function-acl-allowlist.json`

**Interfaces:**
- Produces:
  - Tabela `instagram_accounts`:
    - colunas `id, organization_id, unit_id, ig_user_id text not null, username, account_type, status text check (status in ('connected','reauth_required','disconnected')), token_secret_id uuid references vault.secrets(id) on delete set null, token_expires_at, token_refreshed_at, subscribed_fields text[] not null default '{}', last_error_code text, connected_by uuid not null, connected_at, disconnected_at, updated_at`;
    - únicos parciais `(ig_user_id) where status <> 'disconnected'` e `(unit_id) where status <> 'disconnected'`;
    - FORCE RLS sem policy.
  - RPCs só `service_role`:
    - `store_instagram_account_connection(p_unit_id uuid, p_ig_user_id text, p_username text, p_account_type text, p_token text, p_expires_at timestamptz, p_actor uuid) returns uuid`:
      - `ig_user_id` ativo noutra unidade → `raise … 'instagram_account_in_use'` com `errcode 'P0001'`;
      - outra conta ativa na mesma unidade é desconectada antes;
      - a mesma conta reaproveita a linha;
      - o Vault guarda o segredo com o nome `'instagram-account-'||id||'-token'` (`vault.update_secret` se já existir, senão `vault.create_secret`).
    - `get_instagram_account_token(p_account_id uuid) returns text`: `P0002` se não houver.
    - `record_instagram_account_subscription(p_account_id uuid, p_fields text[]) returns void`.
    - `record_instagram_token_refresh(p_account_id uuid, p_token text, p_expires_at timestamptz) returns void`.
    - `set_instagram_account_status(p_account_id uuid, p_status text, p_error_code text) returns void`: só `connected` ↔ `reauth_required`.
    - `disconnect_instagram_account(p_account_id uuid, p_actor uuid) returns void`: sobrescreve o segredo no Vault com valor aleatório, zera `token_secret_id` e grava `disconnected`.
  - `get_instagram_account_status(p_unit_id uuid) returns table(username text, status text, token_expires_at timestamptz, connected_at timestamptz, subscribed boolean, last_error_code text)`: `authenticated`, com a guarda membro ou `platform_admin` (`42501` caso contrário). Zero linhas quando não há conta ativa. `subscribed = 'messages' = any(subscribed_fields)`.
  - Tabela `instagram_contacts`:
    - colunas `id, organization_id, unit_id, instagram_account_id references instagram_accounts on delete restrict, igsid text, username, name, customer_id references customers(id) on delete set null, customer_linked_at, anonymized_at, created_at, updated_at`;
    - `check ((anonymized_at is null) = (igsid is not null))`;
    - `unique (instagram_account_id, igsid)`;
    - RLS com select para membro ou `platform_admin`; `authenticated` só lê.
  - `upsert_instagram_contact(p_account_id uuid, p_igsid text, p_username text, p_name text) returns uuid`: `service_role`. Unidade e organização vêm da conta. Só sobrescreve `username`/`name` com valor não nulo.
  - Tabela `instagram_contact_reservations(reservation_id uuid primary key references reservations on delete cascade, instagram_contact_id uuid not null references instagram_contacts on delete cascade, unit_id uuid not null, created_at)`: FORCE RLS sem policy.
  - `record_instagram_contact_reservation(p_contact_id uuid, p_reservation_id uuid) returns void`: `service_role`. Recusa com `42501` se `reservation.unit_id ≠ contact.unit_id` ou `reservation.customer_id ≠ contact.customer_id`. Usa `on conflict do nothing`.
  - Trigger `instagram_contacts_anonymize_on_customer_trg` em `customers` (`after update of deleted_at … when (old.deleted_at is null and new.deleted_at is not null)`), função `SECURITY DEFINER` com `search_path=''`. Zera `igsid`, `username` e `name` e grava `anonymized_at` nos contatos do cliente. Padrão: `20260927120000_115…:171-200`.
  - Guarda de coerência do contato: unidade e organização iguais às da conta; se houver cliente, a organização do cliente é a do contato.

- [x] **Step 1: Escreva os casos.**
  - IG-2.1 (A×B): o membro de A não lê contato de B. `get_instagram_account_status(B)` chamado por A recebe `42501`. `authenticated` não lê `instagram_accounts` nem `instagram_contact_reservations`.
  - IG-2.2: `store_…` com `ig_user_id` ativo na unidade B, chamado para a unidade A, recebe `instagram_account_in_use`. Desconectar em B e conectar em A funciona.
  - IG-2.3: o token gravado é lido só por `get_instagram_account_token` como `service_role`, e `authenticated` recebe `42501` no `EXECUTE`. Depois de `disconnect`, o token lido não é o original e `token_secret_id` é nulo.
  - IG-2.4: ligar um contato a um cliente de outra organização é recusado pela guarda.
  - IG-2.5: `record_instagram_contact_reservation` com reserva de outra unidade ou de outro cliente recebe `42501`.
  - IG-2.6: anonimizar o cliente pela RPC `anonymize_customer` como `platform_admin` deixa o contato com `igsid` nulo e `anonymized_at` preenchido. Um contato de outro cliente fica intacto.
  - Controles positivos: tirar a cláusula de unidade da guarda do ledger reprova IG-2.5; tirar o `when` do trigger reprova IG-2.6.
- [x] **Step 2: Rode e confira a falha.**
- [x] **Step 3: Escreva a migration**, com os revokes e as entradas na allowlist só para as funções expostas a `authenticated`.
- [x] **Step 4: Rode e confira IG-2.x `ok` e os controles positivos.**
- [x] **Step 5: Commit** `feat(instagram): conta com token no Vault, contato e ledger de reservas do contato`.

### Task 1.3: fila de inbound, ledger por mensagem e diagnóstico

**Files:**
- Create: `supabase/migrations/<ts>_instagram_inbound_queue.sql`
- Create: `src/lib/instagram-queue-migration-twin.test.ts`
- Modify: `79-instagram-module.sql`, `scripts/function-acl-allowlist.json`

**Interfaces:**
- Consumes: `instagram_accounts` (1.2); constantes `INBOUND_LEASE_TTL_MS`, `PURGE_DONE_AFTER_DAYS`, `PURGE_DEAD_AFTER_DAYS` e `INBOUND_SWEEP_INTERVAL_MS` de [whatsapp-inbound-queue-core.ts](../../../supabase/functions/_shared/whatsapp-inbound-queue-core.ts).
- Produces:
  - Tabela `instagram_inbound_events`:
    - colunas `id, instagram_account_id (fk cascade), unit_id (fk cascade), raw_body bytea not null, body_sha256 text check (~ '^[0-9a-f]{64}$'), signature_secret text check (in ('instagram','meta')), received_at, status (received/processing/done/dead), attempts, next_attempt_at, claim_id, claimed_until, outcome, last_error, updated_at`;
    - `unique (instagram_account_id, body_sha256)`;
    - guarda `unit_id = conta.unit_id`;
    - FORCE RLS sem policy.
  - RPCs `service_role`, espelho da 113:
    - `claim_instagram_inbound_event(p_event_id uuid) returns table(id uuid, instagram_account_id uuid, unit_id uuid, raw_body bytea, attempts integer, claim_id uuid)` (lease de 90s);
    - `finalize_instagram_inbound_event(p_event_id uuid, p_claim_id uuid, p_status text, p_outcome text, p_error text, p_retry_delay_seconds integer) returns integer`;
    - `select_due_instagram_inbound_events(p_limit integer default 20) returns setof uuid`;
    - `purge_instagram_inbound_events() returns integer` (`done` com 7 dias, `dead` com 30).
  - Tabela `instagram_processed_messages`:
    - colunas `id, instagram_account_id, unit_id, mid text check (length between 1 and 512), status (processing/done), claim_id, claimed_until, outcome, error, meta jsonb not null default '{}', created_at, completed_at`;
    - `unique (instagram_account_id, mid)`;
    - FORCE RLS sem policy.
  - RPCs do ledger:
    - `claim_instagram_message(p_account_id uuid, p_mid text) returns uuid`: devolve `null` se já está `done` ou em voo dentro do lease, e um claim novo na retomada depois de 90s;
    - `complete_instagram_message(p_account_id uuid, p_mid text, p_claim_id uuid, p_outcome text, p_error text, p_meta jsonb) returns boolean`: cercado pelo claim;
    - `record_instagram_message_outcome(p_account_id uuid, p_mid text, p_outcome text, p_meta jsonb) returns void`: grava eco ou descarte já `done`, com `on conflict do nothing`;
    - `purge_instagram_processed_messages() returns integer` (30 dias).
  - `get_instagram_diagnostics(p_unit_id uuid) returns jsonb`: `authenticated`, só `platform_admin` (`42501` caso contrário). Devolve `{ last_event_at, queue: {received, processing, done_24h, dead}, oldest_pending_received_at, outcomes_24h: {<outcome>: n} }`, sem conteúdo.
  - Wrappers `trigger_instagram_inbound_sweep()` → `process-instagram-inbound?sweep=1` e `trigger_instagram_token_refresh()` → `process-instagram-token-refresh`. Os dois leem `internal_api_key` e `project_url` do Vault, dão `raise notice` e pulam se faltar algum, e são revogados de `public, anon, authenticated`. Padrão: `20260924120100_112…`.

- [x] **Step 1: Escreva o teste gêmeo `instagram-queue-migration-twin.test.ts`.** Ele lê a migration e falha se:
  - o lease do claim não for `INBOUND_LEASE_TTL_MS/1000`;
  - a purga `done`/`dead` não usar `PURGE_DONE_AFTER_DAYS`/`PURGE_DEAD_AFTER_DAYS`;
  - a purga do ledger não usar `INSTAGRAM_PROCESSED_RETENTION_DAYS`, que a Task 4.1 cria com valor 30. Até lá, use o literal `30` com `TODO(4.1)` no teste.
- [x] **Step 2: Escreva os casos do pré-voo.**
  - IG-3.1: o claim do mesmo evento por dois `claim_id` deixa só um vencedor. O finalize com claim errado devolve 0.
  - IG-3.2: `claim_instagram_message` duas vezes devolve `null` na segunda. Depois do lease vencido, devolve um claim novo e o `complete` com o claim antigo devolve `false`.
  - IG-3.3: gravar evento com `unit_id` diferente do da conta é recusado.
  - IG-3.4: `get_instagram_diagnostics` como owner recebe `42501`; como `platform_admin`, sai sem texto de mensagem.
  - IG-3.5: a purga apaga só o que passou da idade.
  - Controle positivo: remover o filtro de `claim_id` do finalize reprova IG-3.1.
- [x] **Step 3: Rode e confira a falha. Escreva a migration. Rode e confira `ok`.**
- [x] **Step 4: Rode `npx vitest run src/lib/instagram-queue-migration-twin.test.ts` e confira PASS.**
- [x] **Step 5: Commit** `feat(instagram): fila de inbound, ledger por mensagem e diagnóstico`.

### Task 1.4: `conversations` com canal e cliente opcional

**Files:**
- Create: `supabase/migrations/<ts>_conversations_instagram_channel.sql`, com `BEGIN`/`COMMIT` no arquivo
- Modify: `79-instagram-module.sql`; `supabase/tests/local-preflight/67d-conversation-message-acl-bootstrap.sql` e `08-…`, se o bootstrap declarar `customer_id NOT NULL`; `src/test/fixtures/whatsapp-automation-fixtures.ts:102` (schema da fixture: `channel`, `instagram_contact_id`)

**Interfaces:**
- Consumes: `instagram_contacts` (1.2).
- Produces:
  - Colunas `conversations.channel text not null default 'whatsapp' check (channel in ('whatsapp','instagram'))` e `conversations.instagram_contact_id uuid references instagram_contacts(id) on delete restrict`; `customer_id` passa a aceitar nulo.
  - `conversations_channel_identity_check`: `(channel='whatsapp' and customer_id is not null and instagram_contact_id is null) or (channel='instagram' and instagram_contact_id is not null)`. Entra `NOT VALID` e depois `VALIDATE CONSTRAINT`.
  - Índices: único parcial `conversations_instagram_contact_uidx (instagram_contact_id) where instagram_contact_id is not null`; `conversations_unit_channel_status_idx (unit_id, channel, status)`.
  - Guarda `conversations_channel_guard` (`BEFORE INSERT OR UPDATE OF channel, instagram_contact_id, customer_id, unit_id`): `channel` imutável; conversa IG com `unit_id` igual ao do contato; cliente da organização da unidade.
  - `get_or_create_whatsapp_conversation(...)`: mesma assinatura, `create or replace`, com `and channel = 'whatsapp'` na busca. Repete os revokes.
  - `app_private.reconcile_whatsapp_automation_acceptance_inner(...)`: `create or replace` a partir do corpo **mais recente** (`20261019183559…:777`), com `and channel = 'whatsapp'` no `exists`. Repete os revokes.
  - `get_or_create_instagram_conversation(p_contact_id uuid) returns uuid`: `service_role`. Faz `select … for update` no contato. Unidade, organização e `customer_id` vêm do contato. `contact_name = coalesce(name, '@'||username)`. Recusa contato anonimizado.
  - `link_instagram_contact_customer(p_contact_id uuid, p_customer_id uuid) returns void`: `service_role`. Exige cliente vivo (`deleted_at is null`) da organização do contato e contato não anonimizado (`42501` caso contrário). Grava `customer_id`/`customer_linked_at` no contato e `customer_id` na conversa do contato. Religar a outro cliente é permitido.

- [x] **Step 1: Escreva os casos.**
  - IG-4.1: inserir conversa `whatsapp` sem `customer_id` viola o CHECK. Conversa `instagram` sem contato também viola.
  - IG-4.2: um cliente com conversa WhatsApp X e conversa IG Y (ligada) chama `get_or_create_whatsapp_conversation` e recebe X. Sem X, cria uma conversa nova `whatsapp` e não devolve Y.
  - IG-4.3: o reconcile de aceitação ignora a conversa IG. Estenda o cenário do pré-voo 38 com uma conversa IG do mesmo cliente.
  - IG-4.4: conversa IG com contato de outra unidade é recusada. Mudar `channel` de uma conversa é recusado.
  - IG-4.5: chamar `get_or_create_instagram_conversation` duas vezes dá o mesmo id.
  - IG-4.6: `link_…` com cliente de outra organização recebe `42501`. Depois do link, `customer_id` está gravado no contato e na conversa.
  - IG-4.7 (A×B): o membro de A não lê conversa IG de B. As colunas novas não aceitam `update` de `authenticated` (o 67d já varre todas as colunas: rode-o).
  - Controles positivos: tirar o filtro de canal do `get_or_create_whatsapp_conversation` reprova IG-4.2; o mesmo no reconcile reprova IG-4.3.
- [x] **Step 2: Rode e confira a falha. Escreva a migration. Rode o 79, o 67d, o 38 e o 08 e confira `ok`.**
- [x] **Step 3: Rode `npx vitest run src/lib/agent-turn-parity.test.ts src/lib/whatsapp-conversation-parity-guard.test.ts` com a fixture nova e confira PASS sem regravar snapshot.**
- [x] **Step 4: Commit** `feat(conversas): canal e contato do Instagram, com as RPCs do WhatsApp presas ao canal`.

### Task 1.5: `reservations.source` e cron

**Files:**
- Create: `supabase/migrations/<ts>_reservations_source_instagram.sql`, `supabase/migrations/<ts>_instagram_cron.sql`
- Modify: `79-instagram-module.sql`, `src/lib/instagram-queue-migration-twin.test.ts`

**Interfaces:**
- Produces:
  - `reservations_source_check`, que passa a aceitar `('web','whatsapp','instagram')`, entrando `NOT VALID` e depois `VALIDATE`. O trigger `enqueue_confirmation_notification` **não muda** (D6), e um comentário na migration registra a decisão.
  - Três jobs, cada um com `cron.unschedule` defensivo antes:
    - `instagram-inbound-sweep` `*/1 * * * *`;
    - `instagram-token-refresh` `40 9 * * *`;
    - `instagram-inbound-purge` `17 4 * * *`, que chama as duas purgas em SQL.

- [x] **Step 1: Escreva os casos.** IG-5.1: insert com `source='instagram'` é aceito e cria a linha `confirmation` em `notification_outbox`. Insert com `'whatsapp'` não cria. Controle positivo: trocar o filtro do trigger para `not in ('whatsapp','instagram')` reprova IG-5.1 (é a prova de D6).
- [x] **Step 2: Estenda o teste gêmeo:** a expressão do `cron.schedule` do sweep corresponde a `INBOUND_SWEEP_INTERVAL_MS`.
- [x] **Step 3: Rode e confira a falha. Escreva as migrations. O arquivo de cron não roda no pré-voo, porque o harness não tem `pg_cron`; o gêmeo o lê como texto. Rode e confira PASS.**
- [x] **Step 4: Commit** `feat(reservas): origem instagram e cron do módulo`.

### Task 1.6: gates do Bloco 1

- [x] Rode o pré-voo completo `79a` + `79` e os vizinhos tocados (`08`, `38`, `67d`). Registre os ordinais e vereditos nas Evidências. (O 38 não rodou: o IG-4.3 cobre o reconcile no 79; ver Evidências.)
- [x] Rode `npm run typecheck` e `npx vitest run scripts/` e confira PASS.
- [x] Rode os gates com o Opus, cada migration nova como entrada:
  - `saas-shield-br:migration-validator` (uma vez por arquivo);
  - `saas-shield-br:rls-auditor`;
  - `saas-shield-br:tenant-isolation-auditor` (escopo banco);
  - `saas-shield-br:identity-access-auditor` (grant de módulo, policy de settings).
  - Bloqueante é corrigido no bloco; atenção vai para as Evidências com a decisão.
- [x] Atualize `.claude/rules/banco-de-dados.md`: as tabelas FORCE RLS sem policy novas e as duas RPCs WhatsApp presas a `channel`.
- [x] Commit `docs(banco): registra o módulo Instagram nas regras`.

---

## Bloco 2 — Integração com a Meta

Antes de começar: leia `integracoes.md`, `edge-functions.md`, `seguranca-multitenancy.md`, `docs/standards/INTEGRATIONS.md` e a seção "Global Constraints" acima. Confira a versão `v26.0` na doc vigente.

As EFs novas entram em `EdgeName`/`ENDPOINTS` de [edge-request-harness.ts](../../../src/test/fixtures/edge-request-harness.ts), e os testes de EF usam esse harness com `fetch` falso para `graph.instagram.com`, `api.instagram.com` e `www.instagram.com`. **Nenhum teste chama a Meta.**

**Contrato de autorização herdado do Bloco 1 (gates `identity-access` e `tenant-isolation`).** As RPCs `service_role` garantem a coerência de tenant. `store_instagram_account_connection` e `disconnect_instagram_account` também conferem o papel do ator. O resto fica nas EFs:
- **C1, connect/callback:** `getUser`; `p_actor = user.id`, nunca do body; `unit_id` só do `state` assinado (preso ao usuário, uso único, com expiração); `hasUnitAccess` + owner/gerente ou `platform_admin`; grant ativo; token nunca em log/DTO.
- **C2, disconnect:** unidade resolvida pela linha de `instagram_accounts`, papel conferido nessa unidade, `p_actor` da sessão.
- **C3, webhook:** HMAC antes de tudo; `entry.id` → `instagram_accounts.ig_user_id` com `status = 'connected'` (`reauth_required` é descartado, passo 7 da Task 2.3; a RPC `upsert_instagram_contact` aceita `reauth_required` só como defesa para evento já enfileirado); `unit_id` da conta; gate = grant ativo **e** `dm_enabled`, fail-closed em erro de leitura.
- **C4, worker e refresh:** conta e unidade só do claim/varredura, nunca do corpo.
- **C5, link de cliente:** o cliente é resolvido no servidor dentro da organização do contato, nunca por id vindo da DM ou da LLM.
- **C6, status e diagnóstico:** chamados com o JWT do usuário (com service role, `auth.uid()` é nulo e a RPC recusa).

### Task 2.1: cliente do Graph (Sonnet)

**Files:**
- Create: `supabase/functions/_shared/instagram-graph-core.ts`, `supabase/functions/_shared/instagram-graph.ts`, `src/lib/instagram-graph-core.test.ts`

**Interfaces:**
- Produces (core):
  - constantes: `INSTAGRAM_GRAPH_VERSION`, `INSTAGRAM_SCOPES = ["instagram_business_basic","instagram_business_manage_messages"]`, `INSTAGRAM_SUBSCRIBED_FIELDS = ["messages"]`;
  - `type GraphErrorClass = "reauth_required"|"window_closed"|"rate_limited"|"recipient_unavailable"|"transient"|"invalid_request"`;
  - `classifyGraphError(i: { httpStatus: number|null; code: number|null; subcode: number|null }): GraphErrorClass`;
  - `buildAuthorizeUrl(i: { appId: string; redirectUri: string; state: string }): string`;
  - `stripOAuthCodeSuffix(code: string): string`;
  - `redactSecrets(text: string, secrets: string[]): string`;
  - parsers `parseCodeExchange(json: unknown): { shortToken: string } | null` (aceita o array `data`), `parseLongLived(json: unknown): { token: string; expiresInSec: number } | null` e `parseMe(json: unknown): { igUserId: string; username: string|null; accountType: string|null } | null` (lê `user_id`, nunca `id`).
- Produces (adapter):
  - `createInstagramGraph(fetchImpl: typeof fetch)`, com os métodos `exchangeCode`, `toLongLived`, `refresh`, `me`, `subscribe`, `sendText` e `profile`;
  - cada método devolve `GraphResult<T> = { ok: true; value: T } | { ok: false; errorClass: GraphErrorClass; httpStatus: number|null; code: number|null }`;
  - `sendText(i: { igUserId: string; token: string; igsid: string; text: string }): Promise<GraphResult<{ messageId: string }>>`;
  - timeout de 10s por chamada; **sem retry** em POST; token sempre no header `Authorization: Bearer`, nunca na query de POST.

- [x] **Step 1: Testes.**
  - Tabela de `classifyGraphError` com todos os códigos das Global Constraints.
  - `buildAuthorizeUrl` traz os escopos separados por vírgula, `response_type=code` e o `state` codificado.
  - `parseMe` usa `user_id` e devolve `null` sem ele.
  - `stripOAuthCodeSuffix("abc#_")` devolve `"abc"`.
  - `redactSecrets` tira o token de uma URL e de uma mensagem de `TypeError`.
- [x] **Step 2: Rode `npx vitest run src/lib/instagram-graph-core.test.ts` e confira FAIL. Implemente. Rode e confira PASS.**
- [x] **Step 3: Teste do adapter com `fetch` falso:**
  - erro 500 cujo corpo ecoa o token não deixa o token em nenhum campo do resultado;
  - erro de rede com URL contendo `access_token=` é redigido.
  - Controle positivo: sem a redação, o teste reprova.
- [x] **Step 4: Rode `npx -y deno@2.1.4 check supabase/functions/_shared/instagram-graph.ts`. Commit** `feat(instagram): cliente do Graph com redação de token na origem`.

### Task 2.2: segredos e `state` do OAuth (Opus)

**Files:**
- Create: `_shared/instagram-config-core.ts`, `_shared/instagram-config.ts`, `_shared/instagram-oauth-state.ts`, `src/lib/instagram-config-core.test.ts`, `src/lib/instagram-oauth-state.test.ts`
- Modify: `supabase/functions/manage-platform-secrets/index.ts` (`VALID_KEYS`, `KEY_DESCRIPTIONS`), `src/pages/platform/Integracoes.tsx` (`SECRET_LABELS`, `SECRET_PLACEHOLDERS`, `KEY_PROVIDER`, `PROVIDER_LABELS` com `instagram: "Instagram"`) e o teste estático de `VALID_KEYS` (`src/lib/datafy-account-config-core.test.ts:342-390`, ou um irmão para o Instagram)

**Interfaces:**
- Produces:
  - `INSTAGRAM_SECRET_KEYS = { appSecret: "instagram_app_secret", verifyToken: "instagram_verify_token", metaAppSecret: "meta_app_secret" } as const`;
  - `createInstagramSecretReader(readRow: (key: string) => Promise<{ value: string } | null>)`, que devolve `read(key): Promise<{ ok: true; value: string } | { ok: false; reason: "missing" | "read_failed" }>`. **Sem `Deno.env`.** O cache segue o do leitor Datafy;
  - `signInstagramState(p: { unitId: string; userId: string; exp: number; nonce: string }, secret: string): Promise<string>`, no formato `base64url(json).base64url(hmac)`;
  - `verifyInstagramState(token: string, secret: string, nowMs: number): Promise<{ ok: true; payload } | { ok: false; reason: "malformed"|"bad_signature"|"expired" }>`;
  - `INSTAGRAM_STATE_TTL_MS = 600_000`.

- [x] **Step 1: Testes.**
  - Erro de leitura dá `read_failed` e nunca valor de env. Controle positivo: um leitor com fallback reprova.
  - `state` adulterado em 1 caractere dá `bad_signature`. Vencido dá `expired`. `userId` trocado no json com a assinatura antiga dá `bad_signature`.
  - O teste estático confirma que `VALID_KEYS` contém as três chaves novas.
- [x] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Rode o `deno check` de `manage-platform-secrets`.**
- [x] **Step 3: Commit** `feat(instagram): segredos sem fallback de env e state assinado do OAuth`.

### Task 2.3: `webhook-instagram` (Opus)

**Files:**
- Create: `_shared/instagram-webhook-core.ts`, `supabase/functions/webhook-instagram/index.ts`, `src/lib/instagram-webhook-core.test.ts`, `src/lib/instagram-webhook-request.test.ts`
- Modify: `supabase/config.toml` (`[functions.webhook-instagram] verify_jwt = false`), `edge-request-harness.ts`

**Interfaces:**
- Consumes: `createInstagramSecretReader` (2.2); tabelas 1.1–1.3.
- Produces:
  - `verifyInstagramSignature(raw: Uint8Array, header: string|null, candidates: Array<{ name: "instagram"|"meta"; secret: string }>): Promise<{ ok: true; matched: "instagram"|"meta" } | { ok: false; reason: "missing_header"|"malformed_header"|"no_secret"|"mismatch" }>`;
  - `decideVerifyChallenge(params: URLSearchParams, expected: string): { status: 200; body: string } | { status: 403 }`, com comparação em tempo constante;
  - `entryAccountIds(body: unknown): string[] | null` (`null` se `object !== "instagram"`);
  - `sha256Hex(raw: Uint8Array): Promise<string>`;
  - `INSTAGRAM_WEBHOOK_MAX_BYTES = 2_097_152`.
- Comportamento do `index.ts`:
  1. **GET:** lê `instagram_verify_token`. Falha de leitura dá 503.
  2. **POST, autenticação antes de tudo:** corpo acima do limite dá 413. Lê os bytes com `arrayBuffer()`. Assina antes do `JSON.parse`. Assinatura inválida dá 401 e log `evt:"instagram_webhook_unauthorized", reason`. Os segredos são lidos sem cache longo, e falha de leitura dá 503.
  3. **Resolução das contas:** para cada `entry.id` distinto, `instagram_accounts` com `status='connected'`. A unidade sai **do mesmo select**.
  4. **Gates sem cache:** grant ativo em `unit_module_grants` e `instagram_settings.dm_enabled`. Erro de leitura de gate dá 503 (polaridade **fecha**).
  5. **Gravação:** uma linha em `instagram_inbound_events` por conta elegível, com o corpo cru intacto (`encodeRawBodyHex`), `body_sha256` e `signature_secret`. `23505` é duplicata. Qualquer outro erro dá 503.
  6. **ACK 200**, e então `EdgeRuntime.waitUntil(fetch(process-instagram-inbound, { x-internal-key, body: { event_id } }))` para cada linha nova. O worker relê a linha; o corpo do pedido não carrega payload.
  7. **Descartes:** conta desconhecida, sem grant ou com Direct desligado dão 200 e uma contagem no log, sem gravar nada. Conta em `reauth_required` também descarta, porque sem token não há resposta; as telas da loja e da plataforma mostram o alerta de reconexão.

- [x] **Step 1: Testes do core.**
  - A assinatura confere sobre os bytes, inclusive com `\u0000` e acento.
  - Candidato `meta` casa quando `instagram` não casa, e devolve `matched:"meta"`. Sem candidatos dá `no_secret`.
  - Cabeçalho sem `sha256=` dá `malformed_header`.
  - Desafio com token errado dá 403.
- [x] **Step 2: Testes de Request no harness.**
  - `webhook grava uma linha por conta do lote`: o corpo traz duas contas, de A e B, e saem duas linhas, cada uma com o próprio `unit_id`.
  - Assinatura inválida dá 401, sem nenhuma leitura de conta.
  - Erro ao ler o grant dá 503.
  - Grant revogado dá 200, sem linha gravada.
  - Mesmo corpo duas vezes grava uma linha.
  - Erro do INSERT dá 503.
  - O GET de verificação responde o `hub.challenge`.
- [x] **Step 3: Rode e confira FAIL. Implemente. Rode e confira PASS. Controle positivo: resolver a unidade por `entry.id` sem o `select` de conta reprova o teste das duas contas.**
- [x] **Step 4: Rode `npx -y deno@2.1.4 check supabase/functions/webhook-instagram/index.ts`. Commit** `feat(instagram): webhook autentica sobre o corpo cru e grava na fila antes do ACK`.

### Task 2.4: `instagram-connect` (Opus)

**Files:**
- Create: `_shared/instagram-access-core.ts`, `supabase/functions/instagram-connect/index.ts`, `src/lib/instagram-access-core.test.ts`, `src/lib/instagram-connect-request.test.ts`
- Modify: `config.toml` (`[functions.instagram-connect] verify_jwt = true`), `edge-request-harness.ts`

**Interfaces:**
- Consumes: 2.1 e 2.2; RPCs 1.2.
- Produces:
  - `decideInstagramAccess(i: { action: "start"|"callback"|"status"|"disconnect"|"resubscribe"; isPlatformAdmin: boolean; role: "owner"|"gerente"|"operador"|null; grantActive: boolean }): "allow"|"deny_role"|"deny_grant"`:
    - operador e não membro sempre negados;
    - `start`, `callback` e `resubscribe` exigem grant ativo inclusive para `platform_admin`;
    - `status` e `disconnect`, não.
  - Contrato HTTP `POST { action, unit_id?, code?, state? }`:
    - `start { unit_id }` → `{ authorize_url }`, com `state` assinado de 10 min;
    - `callback { code, state }` → `{ unit_slug, username }`. A unidade vem **só** do `state`, e `state.userId` tem de ser o usuário da sessão, senão 403. Papel e grant são reconferidos no callback;
    - `status { unit_id }` → projeção de `get_instagram_account_status`;
    - `disconnect { unit_id }` → `disconnect_instagram_account` da conta ativa da unidade;
    - `resubscribe { unit_id }` → `subscribe` + `record_instagram_account_subscription`.
  - Sequência do callback:
    1. `stripOAuthCodeSuffix`;
    2. `exchangeCode`;
    3. `toLongLived`;
    4. `me`, com `account_type` em `Business`/`Media_Creator`, senão 422 "A conta precisa ser Profissional";
    5. `store_instagram_account_connection` (`instagram_account_in_use` dá 409 "Esta conta do Instagram já está conectada a outra unidade");
    6. `subscribe(INSTAGRAM_SUBSCRIBED_FIELDS)`;
    7. `record_instagram_account_subscription`.
  - Falha no passo 6 responde 200 com `subscribed:false`, e a tela oferece "Assinar de novo".
  - `redirect_uri` = `${APP_BASE_URL}/instagram/callback`. `APP_BASE_URL`, `INSTAGRAM_APP_ID` e `INSTAGRAM_OAUTH_STATE_SECRET` são lidos só no `index.ts`.
  - Erro do Graph ou do Postgres nunca volta cru: mensagem PT-BR e `errorClass` no log.

- [x] **Step 1: Testes do núcleo de acesso:** a tabela completa de ação × papel × grant × `platform_admin`.
- [x] **Step 2: Testes de Request.**
  - Operador recebe 403 em todas as ações.
  - `callback` com `state` de outro usuário dá 403, sem troca do código.
  - `state` vencido dá 403.
  - Grant revogado entre o `start` e o `callback` dá 403.
  - `me` sem `user_id` dá 502, sem gravar.
  - Conta já conectada a outra unidade dá 409.
  - Caminho feliz: grava o token pelo RPC, nunca o devolve, e a resposta não contém o token.
  - `disconnect` de membro de outra unidade dá 403.
- [x] **Step 3: Rode e confira FAIL. Implemente. Rode e confira PASS. Controle positivo: aceitar `unit_id` do body no `callback` reprova o teste do `state` alheio.**
- [x] **Step 4: Rode o `deno check`. Commit** `feat(instagram): conexão da conta pelo Instagram Login com state assinado`.

### Task 2.5: renovação de token (Sonnet, review Opus)

**Files:**
- Create: `_shared/instagram-token-refresh-core.ts`, `supabase/functions/process-instagram-token-refresh/index.ts`, `src/lib/instagram-token-refresh-core.test.ts`
- Modify: `config.toml` (`verify_jwt = false`)

**Interfaces:**
- Produces:
  - `decideTokenRefresh(i: { status: string; tokenRefreshedAt: string|null; connectedAt: string; tokenExpiresAt: string|null; nowMs: number }): "skip"|"refresh"|"expired"`;
  - `INSTAGRAM_REFRESH_MIN_AGE_MS = 30 * 86_400_000`.
- Comportamento do `index.ts`:
  - `requireInternalAuth`;
  - lê as contas `connected` com paginação `.range()`;
  - `expired` → `set_instagram_account_status('reauth_required','expired')` sem chamar o Graph;
  - `refresh` → `refresh`; sucesso grava; `reauth_required` muda o status; `transient` só loga e tenta no dia seguinte;
  - nunca loga o token.

- [x] **Step 1: Teste da decisão.**
  - 29 dias dá `skip`, 30 dias dá `refresh`.
  - Vencido dá `expired`.
  - `reauth_required` e `disconnected` dão `skip`.
  - Sem `tokenRefreshedAt`, usa `connectedAt`.
- [x] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Rode o `deno check`. Commit** `feat(instagram): renovação diária do token longo`.

### Task 2.6: gates do Bloco 2

- [x] Rode `npm run typecheck`, `npm run lint`, as suítes `src/lib/instagram-*` e o `deno check` das três EFs novas e de `manage-platform-secrets`.
- [x] Rode `node scripts/check-portabilidade.mjs`. Contagem acima da linha de base: **pare e pergunte** (D3).
- [x] Rode os gates com o Opus:
  - `saas-shield-br:integration-reliability-auditor` (webhook, fila, refresh);
  - `saas-shield-br:identity-access-auditor` (connect, `state`);
  - `saas-shield-br:secret-hunter` (diff do bloco);
  - revisão com a skill `saas-shield-br:edge-function-guard` sobre as três EFs.
- [x] Crie `.claude/rules/instagram.md`, com `paths:` para `supabase/functions/*instagram*/**`, `supabase/functions/_shared/instagram-*`, `supabase/migrations/*instagram*` e `src/**/instagram/**`, mais `src/pages/gestao/Instagram*` e `src/pages/InstagramCallback*`. Ela traz as invariantes S1, S5, S6, a regra de 1000 bytes, a fila antes do ACK e os gates fail-closed. Adicione a linha na tabela do AGENTS.md §2. Os jobs já entraram na tabela de `edge-functions.md` no 1.6; confira que os nomes das EFs batem com o que foi implementado.
- [x] Commit `docs(instagram): regra do módulo e workers no inventário de cron`.

---

## Bloco 3 — Núcleo do agente

Antes de começar:
- confira se a B3 da Entrega B está em `origin/main`; se não estiver, pergunte ao responsável se espera ou rebaseia depois (D7);
- leia `agente-ia.md`, `whatsapp.md` e `reservas.md`.

O snapshot de [agent-turn-parity.test.ts](../../../src/lib/agent-turn-parity.test.ts) só é regravado na Task 3.1, num commit próprio. Nas Tasks 3.2–3.4 ele passa **byte a byte**.

### Task 3.1: compare-and-set no auto-resolve e no lembrete (Opus)

**Files:**
- Modify: `supabase/functions/_shared/agent/turn.ts:425-479`, `src/lib/agent-turn-parity.test.ts`, `src/test/fixtures/whatsapp-automation-fixtures.ts` (gancho `beforeUpdate` de tabela, se não existir)

**Interfaces:**
- Produces:
  - **Auto-resolve:** `update(...).eq("id").eq("unit_id").eq("status", conv.status).select("id")`. Só quem atualizou uma linha envia o "Voltei a te atender".
    - Zero linhas: relê o `status`. Se for `ai_active`, segue para o turno sem mensagem de retomada. Senão, `finish("handoff_state_changed")`.
    - Erro do UPDATE: `finish("handoff_state_changed")` e log, sem envio.
  - **Lembrete:** reivindica a janela antes de enviar, com `update({ last_silenced_reply_at: agora }).eq("id").eq("unit_id")` + `.is(…, null)` ou `.eq(…, anterior)` + `.select("id")`.
    - Zero linhas: `finish("human_active_silent")`.
    - Vencedor: envia. Se o envio falhar, devolve o valor anterior com CAS sobre o próprio valor, em best-effort.

- [ ] **Step 1: Cenários de paridade novos, gravados ANTES da mudança.** Grave `handoff: auto-resolve após 12h`, `handoff: lembrete na janela` e `handoff: dentro da janela, silencioso`, e confira duas execuções determinísticas. Commit `test(ai-agent): prende a UX de handoff antes do compare-and-set`.
- [ ] **Step 2: Testes de corrida, que falham hoje** e são o controle positivo da correção.
  - `auto-resolve concorrente envia uma retomada`: o gancho troca `status` para `ai_active` entre a leitura do adapter e o UPDATE do turno, e o esperado são zero envios do turno perdedor.
  - `lembrete concorrente envia um aviso`: o gancho grava `last_silenced_reply_at` antes do UPDATE do turno, e o esperado são zero envios.
- [ ] **Step 3: Rode e confira os dois FAIL. Implemente. Rode e confira PASS.**
- [ ] **Step 4: Regrave com `-u` **só** os cenários de handoff.** O diff do arquivo de snapshot vai para as Evidências, e o revisor confere que só mudou a ordem e o predicado do UPDATE e a ordem do envio. Commit separado: `fix(ai-agent): auto-resolve e lembrete de handoff com compare-and-set antes do envio`.
- [ ] **Step 5: Rode `ai-budget-wiring-guard`, `whatsapp-conversation-parity-guard` e `handoff-clock-core` e confira PASS.**

### Task 3.2: formatação do Instagram (Sonnet)

**Files:**
- Create: `supabase/functions/_shared/instagram-format.ts`, `src/lib/instagram-format.test.ts`

**Interfaces:**
- Produces:
  - `INSTAGRAM_MAX_TEXT_BYTES = 1000`;
  - `sanitizeForInstagram(text: string): string`, que remove `**`/`__`/`#`/crases, transforma `- `/`* ` de lista em `• `, converte link markdown (texto entre colchetes seguido da URL entre parênteses) em `texto: url` e preserva emoji;
  - `splitInstagramText(text: string, maxBytes?: number): string[]`, que corta em parágrafo, depois frase, depois palavra, e, como último recurso, por code point. Cada parte tem ≤ `maxBytes` em UTF-8; nenhuma parte é vazia; `join("")` sem os separadores devolve o texto original;
  - `INSTAGRAM_FORMATTING_RULES` (texto exato):
    `FORMATAÇÃO DA RESPOSTA NO INSTAGRAM: texto simples, sem markdown (nada de *, _, # ou crases). Listas com "• ". Mensagens curtas, de até 900 caracteres. Links por extenso.`
  - `INSTAGRAM_CHANNEL_RULES` (texto exato):
    `REGRAS DO INSTAGRAM: 1) Antes de chamar create_reservation, peça o número de WhatsApp do cliente, com DDD, e registre com link_customer_phone; explique que a confirmação e os lembretes da reserva chegam pelo WhatsApp. 2) Não peça o número antes de o cliente querer reservar. 3) Para consultar, alterar ou cancelar, você só enxerga as reservas feitas por esta conversa do Instagram; para outras, oriente o cliente a falar pelo WhatsApp da loja.`
  - `buildInstagramIdentityLine(i: { username: string|null; name: string|null; linkedPhone: string|null }): string`. Exemplo: `O cliente fala pelo Instagram (@maria, Maria Souza); o WhatsApp ainda não foi informado.` Com telefone, troca a segunda frase por `o WhatsApp informado é (11) 98888-7777.` O telefone sai formatado e a linha não termina com ponto duplicado.

- [ ] **Step 1: Testes.**
  - `divide por bytes sem quebrar par substituto`: texto de 999 bytes terminando em emoji de 4 bytes dá duas partes válidas.
  - 1000 bytes exatos dão uma parte.
  - Acentos contam 2 bytes.
  - Markdown comum é sanitizado.
  - A identidade sai com e sem nome e com e sem telefone.
- [ ] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Commit** `feat(instagram): sanitização e divisão por bytes da resposta`.

### Task 3.3: prompt por canal e guarda do contexto (Opus)

**Files:**
- Modify: `_shared/agent/channel-context.ts`, `_shared/agent/system-prompt.ts`, `_shared/agent/turn.ts` (início de `run` e chamada do loader), `supabase/functions/webhook-whatsapp/index.ts:2861-2885` (contexto do WhatsApp), `src/lib/agent-core-channel.test.ts`

**Interfaces:**
- Produces:
  - `ChannelContext` ganha `channelLabel: string` (WhatsApp `"WhatsApp"`) e `channelRules: string` (WhatsApp `""`).
  - `AgentPromptParts` ganha `channelLabel` e `channelRules`. A regra 12 passa a dizer `pelo ${channelLabel}`. `channelRules` entra depois de `formattingRules`, como `\n\n${channelRules}`, **só se não for vazio**.
  - `LoadAgentPromptArgs.customer` vira `privateCustomer: AgentCustomer | null`. Com `null`, não há consulta de vouchers nem `prefsLines`, e `customerFirstName = ""`.
  - Guarda no início de `run`: `!ctx.unitId || !ctx.organizationId` dá log `evt:"agent_context_invalid"` e `finish("invalid_channel_context")`, e devolve sem LLM.

- [ ] **Step 1: Testes.**
  - A regra 12 com `channelLabel:"Instagram"` diz "pelo Instagram"; com `"WhatsApp"`, o texto é idêntico ao de hoje.
  - `channelRules` vazio não acrescenta bytes ao prompt.
  - `prompt do contato declarado não lê vouchers nem preferências`: `loadAgentSystemPrompt` com client falso que registra consultas e `privateCustomer:null` não consulta `vouchers` e não emite alergia, VIP nem aniversário.
  - `organizationId:""` registra `invalid_channel_context` e não chama o provedor.
- [ ] **Step 2: Rode e confira FAIL. Implemente. O WhatsApp passa `privateCustomer: customer`, `channelLabel:"WhatsApp"` e `channelRules:""`.**
- [ ] **Step 3: Rode `npx vitest run src/lib/agent-turn-parity.test.ts src/lib/agent-core-channel.test.ts` e confira PASS **sem regravar**.** Controle positivo: `channelRules` sempre emitido reprova a paridade.
- [ ] **Step 4: Commit** `feat(ai-agent): regra de canal no prompt e guarda do contexto do turno`.

### Task 3.4: cliente opcional, identidade declarada e `link_customer_phone` (Opus)

**Files:**
- Create: `supabase/functions/_shared/agent/tool-dispatch.ts`, `src/lib/agent-tool-dispatch.test.ts`
- Modify: `_shared/agent/channel-context.ts`, `_shared/agent/tools.ts`, `_shared/agent/turn.ts:1088-1155`, `_shared/agent-reservation-tools.ts`, `_shared/availability.ts:800` (tipo `source`), `webhook-whatsapp/index.ts` (contexto), `src/lib/agent-reservation-tools.test.ts`

**Interfaces:**
- Produces (`channel-context.ts`):
  ```ts
  export type AgentReservationSource = "whatsapp" | "instagram";
  export type LinkPhoneResult =
    | { ok: true; customer: AgentCustomer }
    | { ok: false; reason: "invalid_phone" | "unavailable" };
  /** Canal cuja identidade do cliente NÃO é provada pelo canal (telefone digitado). */
  export interface ClaimedIdentityPort {
    reservationIds(): Promise<string[]>;
    recordReservation(reservationId: string): Promise<void>;
    linkPhone(input: { phone: string; name: string }): Promise<LinkPhoneResult>;
  }
  // ChannelContext: customer: AgentCustomer | null; phone: string | null; claimedIdentity?: ClaimedIdentityPort;
  ```
- Produces (`tool-dispatch.ts`):
  - `agentToolsFor(ctx: Pick<ChannelContext, "claimedIdentity">)`: sem porta devolve exatamente `agentTools`; com porta, `agentTools` mais `link_customer_phone` no fim;
  - `interface ToolDispatchState { mutatingToolUsed: boolean; lastMutationOutcome: MutationOutcome | null; customer: AgentCustomer | null }`;
  - `createToolDispatcher(a: { supabase; requestId: string; ctx: ChannelContext; conv: AgentConversation; state: ToolDispatchState }): (name: string, input: unknown) => Promise<string>`. É o `switch` atual, com os mesmos logs, mais as regras abaixo.
- Regras do despacho:
  - `link_customer_phone { phone, name }`:
    - só existe com porta;
    - sucesso: `state.customer = r.customer` e resultado `{ success:true, message:"Número registrado." }`;
    - `invalid_phone`: `{ success:false, reason:"invalid_phone", message:"O número parece incompleto. Peça o WhatsApp com DDD." }`;
    - **não** liga `mutatingToolUsed`, porque é idempotente (mesmo telefone → mesmo cliente; link repetido sem efeito). Isso vai escrito em `agente-ia.md`.
  - Ferramentas de cliente (`create_reservation`, `get_reservation`, `update_reservation`, `cancel_reservation`, `list_customer_reservations`) com `state.customer === null` devolvem `NEED_PHONE_RESULT = { success:false, found:false, reason:"need_phone", message:"Antes de reservar ou consultar, peça o número de WhatsApp do cliente (com DDD) e registre com link_customer_phone." }`, sem I/O e sem ligar `mutatingToolUsed`.
  - Com porta, o escopo ganha `reservationIds: await port.reservationIds()`, lido uma vez por turno.
  - `create_reservation`:
    - recebe `customer: { id, phone }` do estado;
    - `resolveOrCreateCustomer` com `customer.phone`. `resolved.id ≠ customer.id` dá log `evt:"agent_customer_identity_mismatch"` e erro genérico;
    - devolve `reservationId` só internamente. O despacho o remove antes do `JSON.stringify` e, com porta, chama `port.recordReservation(reservationId)`. Falha nessa chamada só vai para log.
  - `ReservationToolScope = { unitId: string; customerId: string; reservationIds?: readonly string[] }`. Com `reservationIds`, toda consulta ganha `.in("id", ids)`. Lista vazia dá "não encontrada" sem consulta. `listCustomerReservations(supabase, customerId, unitId, reservationIds?)` segue a mesma regra.
  - `reserveSlot` aceita `source: "web"|"whatsapp"|"instagram"`.
  - Guarda no início de `run`, junto da 3.3: **sem porta e com `customer` nulo** dá `finish("invalid_channel_context")`. Só um canal de identidade declarada pode chegar sem cliente.

- [ ] **Step 1: Testes de `agent-tool-dispatch.test.ts`, com client falso que registra filtros e porta falsa.**
  - Sem porta, `agentToolsFor` é deep-equal a `agentTools`.
  - Com porta, a lista termina em `link_customer_phone`.
  - Cliente nulo: as cinco ferramentas devolvem `need_phone` sem nenhuma chamada ao client.
  - `link_customer_phone` válido seguido de `create_reservation` no mesmo turno reserva para o cliente ligado e chama `recordReservation(id)`. O JSON devolvido ao LLM não contém `reservationId`.
  - `identidade declarada só alcança reservas do ledger`: `get_reservation` com código de reserva do cliente que não está no ledger dá "não encontrada", e o filtro registrado contém `.in("id", [...])`. `list_customer_reservations` filtra pelos ids. `cancel_reservation` fora do ledger não escreve.
  - Identidade divergente (`resolveOrCreateCustomer` devolve outro id) dá erro, sem `reserveSlot`.
  - `link_customer_phone` não liga `mutatingToolUsed`; `create_reservation` liga.
- [ ] **Step 2: Rode e confira FAIL. Implemente.** O `turn.ts` passa a usar `agentToolsFor(ctx)` e `createToolDispatcher`, e o WhatsApp passa `customer` e `phone` como hoje, sem porta.
- [ ] **Step 3: Rode `npx vitest run src/lib/agent-turn-parity.test.ts src/lib/agent-reservation-tools.test.ts src/lib/agent-core-channel.test.ts src/lib/agent-tool-dispatch.test.ts src/lib/ai-budget-wiring-guard.test.ts` e confira PASS, com a paridade **byte a byte**.** Se uma guarda textual apontar para o `switch` antigo, reaponte-a para `tool-dispatch.ts` sem afrouxar. Controles positivos:
  - tirar `.in("id")` do cancel reprova o caso do ledger;
  - remover a guarda de cliente nulo reprova o `need_phone`.
- [ ] **Step 4: Rode `npx -y deno@2.1.4 check` em `webhook-whatsapp`, `create-reservation`, `update-reservation` e `create-manual-reservation`. Commit** `feat(ai-agent): cliente opcional, identidade declarada e link_customer_phone`.

### Task 3.5: gates do Bloco 3

- [ ] Rode `npm run typecheck`, `npm run lint` e as 15 suítes do agente (as da Fase 0 mais as novas). Rode `node scripts/ef-import-graph.mjs` para cada `_shared` alterado e registre a matriz.
- [ ] Rode os gates com o Opus:
  - `saas-shield-br:tenant-isolation-auditor` (escopo do ledger);
  - `saas-shield-br:identity-access-auditor` (identidade declarada);
  - `saas-audit-br:ai-automation-auditor` (prompt, ferramenta nova, `need_phone`);
  - `saas-shield-br:integration-reliability-auditor` (CAS).
- [ ] Atualize as regras:
  - `agente-ia.md`: cliente opcional, porta de identidade declarada, `link_customer_phone` idempotente fora da trava de retry, `channelRules`/`channelLabel` e CAS do handoff;
  - `reservas.md`: `source='instagram'` com confirmação pelo WhatsApp (D6).
- [ ] Commit `docs(ai-agent): núcleo com cliente opcional e identidade declarada`.

---

## Bloco 4 — Worker e envio

Antes de começar: leia `whatsapp.md` ("Inbound, idempotência e fila", "Conversas") e `agente-ia.md` (contrato do catch externo do adapter).

### Task 4.1: `process-instagram-inbound` (Opus)

**Files:**
- Create: `_shared/instagram-inbound-core.ts`, `_shared/media-reply-text.ts`, `supabase/functions/process-instagram-inbound/index.ts`, `src/lib/instagram-inbound-core.test.ts`, `src/lib/instagram-inbound-request.test.ts`
- Modify: `webhook-whatsapp/index.ts:476` (passa a importar `MEDIA_REPLY_TEXT` de `_shared/media-reply-text.ts`, com o mesmo valor), `config.toml` (`verify_jwt = false`), `edge-request-harness.ts`, `src/lib/instagram-queue-migration-twin.test.ts` (troca o literal `30` por `INSTAGRAM_PROCESSED_RETENTION_DAYS`)
- Create, se necessário: `_shared/org-billing-gate-core.ts`, se o predicado de `org_billing_blocked` do `webhook-whatsapp` (`index.ts:~2614-2630`) for inline. Nesse caso, extraia e use nos dois, com a paridade inalterada.

**Interfaces:**
- Consumes: tudo dos Blocos 1–3.
- Produces (core):
  ```ts
  export type InstagramItem =
    | { kind: "text"; mid: string; igsid: string; text: string; timestamp: number }
    | { kind: "media"; mid: string; igsid: string; timestamp: number }
    | { kind: "story_mention"; mid: string; igsid: string; timestamp: number }
    | { kind: "echo"; mid: string; igsid: string; timestamp: number }
    | { kind: "ignored"; mid: string | null; reason: "deleted" | "unsupported" | "non_message" | "self" | "malformed" };
  export function extractAccountItems(body: unknown, igUserId: string): InstagramItem[];
  export const INSTAGRAM_PROCESSED_RETENTION_DAYS = 30;
  ```
  - `extractAccountItems` só lê `entry[]` com `id === igUserId` e ordena por `timestamp`.
- **Herdado do Bloco 2 (obrigatório):**
  - `process-instagram-inbound` tem `verify_jwt = false` e `requireInternalAuth` como primeira instrução: o kick do webhook manda só `x-internal-key` e `{ event_id }`, sem `Authorization`.
  - O teste de Request do `webhook-instagram` passa a declarar o hop `webhook-instagram → process-instagram-inbound` e conferir o corpo `{ event_id }` e o header `x-internal-key` (hoje só o core confere).
  - O worker espelha `INBOUND_MAX_ATTEMPTS` de `whatsapp-inbound-queue-core.ts` e fecha como `dead` logo depois do claim quando `attempts` estourou (a fila não limita tentativas no banco).
  - Envio: resultado com `isGraphOutcomeUnknown(r, "POST")` (2xx sem corpo legível, HTTP nulo ou `transient`) é desfecho desconhecido: não reenviar e não gravar como falha definitiva.
  - O adapter do Graph não redige: log com texto de erro passa por `redactSecrets`.
  - Nenhuma RPC ou diagnóstico devolve `raw_body`.
  - Follow-up de banco (gate integration-reliability do Bloco 2): `record_instagram_token_refresh` e `set_instagram_account_status` ganham compare-and-set por `connected_at` esperado, para que uma reconexão durante a varredura do refresh não seja derrubada para `reauth_required`; o `process-instagram-token-refresh` conta o caso como `skipped_stale`. Entra na mesma leva de migrations da Task 4.5.
  - Classificação:
    - `is_echo` → `echo`, com `igsid` = destinatário;
    - `sender.id === igUserId` sem eco → `ignored_self` (o desfecho segue o CHECK `^[a-z0-9_]{1,64}$` da migration 120200);
    - texto com ou sem `reply_to` → `text`;
    - só anexo `story_mention` → `story_mention`;
    - outro anexo → `media`.
- Fluxo do `index.ts` por linha da fila:
  1. **Entrada e claim:** `requireInternalAuth`. `?sweep=1` lê só a tabela. `{ event_id }` relê a linha; o worker nunca recebe payload. Depois vem o `claim_instagram_inbound_event`.
  2. **Gates de novo, sem cache:** conta `connected`, grant ativo, `dm_enabled` e billing da organização. O descarte grava o evento como `done/discarded_<motivo>`. Erro de leitura de conta, grant ou Direct reagenda pelo `nextAttemptDelayMs`. O billing usa o mesmo predicado **e a mesma polaridade de falha** do `webhook-whatsapp`; escreva qual é no cabeçalho do worker.
     - A unidade carregada para o `ChannelContext` usa a mesma leitura `units` `SELECT *` e a mesma montagem de `AgentUnit` do `webhook-whatsapp`. Se a cópia passar de ~10 linhas, extraia para `_shared/agent/unit-context.ts` e use nos dois, com a paridade inalterada.
  3. **Itens:**
     - `echo`: `record_instagram_message_outcome(echo_own|echo_unknown)`. `echo_own` é o `mid` que aparece em `provider_message_ids` de alguma mensagem `assistant`/`human` da conversa do contato.
     - `story_mention`: `ignored_story_mention`.
     - `ignored`: o próprio motivo.
     - `text`/`media`: `claim_instagram_message`. Com `null`, pula.
  4. **Contato:** procura `(conta, igsid)`. Se faltar, chama `profile` em best-effort e `upsert_instagram_contact`.
  5. **Conversa:** `get_or_create_instagram_conversation` → carrega a conversa e, se o contato estiver ligado, o cliente.
  6. **`check_rate_limit('ig:'||igsid, 60, 10, unit_id)`:** antes, confira que `rate_limit_events.phone` não tem CHECK de formato. Se tiver, **pare e pergunte**.
  7. **`media`:** append do inbound e envio de `MEDIA_REPLY_TEXT`, salvo `human_active`/`awaiting_human`.
  8. **`text`:** monta o contexto e roda o turno (detalhes abaixo).
  9. **Fechamento do evento:** depois de todos os itens, finaliza o evento.
- Contexto do turno no passo 8:
  - `channel:"instagram"`, `channelLabel:"Instagram"`;
  - `customer` = cliente ligado ou `null`, e `phone = customer?.phone ?? null`;
  - `identityLine = buildInstagramIdentityLine`;
  - `formattingRules: INSTAGRAM_FORMATTING_RULES`, `channelRules: INSTAGRAM_CHANNEL_RULES`;
  - `sanitize: sanitizeForInstagram`;
  - `send`: divide com `splitInstagramText`, envia na ordem, para na primeira falha (`ok` só com todas), guarda os `messageId` para o append e, em `reauth_required`, chama `set_instagram_account_status`;
  - `reservationSource:"instagram"`, `channelId: account.id`;
  - `claimedIdentity`:
    - `reservationIds`: ledger por contato e `unit_id`;
    - `recordReservation`: RPC;
    - `linkPhone`: valida com [public-br-phone.ts](../../../supabase/functions/_shared/public-br-phone.ts), `resolveOrCreateCustomer` e `link_instagram_contact_customer`.
- Contrato do turno:
  - roda `agentTurn.run(ctx, inbound)` dentro de `try`;
  - o `catch` chama `settleTurnBudget("RELEASED")` e depois `releaseAiLock()`, **antes** de `complete_instagram_message` e de finalizar o evento (`agente-ia.md`);
  - `finish` = `complete_instagram_message` com outcome e meta, sem conteúdo;
  - `appendToConversation` = `append_conversation_message` com `provider_message_ids` nas mensagens que saíram.

- [ ] **Step 1: Testes do core.**
  - Corpo com duas contas devolve só as da conta pedida.
  - Fora de ordem sai ordenado.
  - Eco, `self`, `story_mention`, `media`, `deleted` e `unsupported` são classificados.
  - Corpo malformado dá `[]` sem lançar.
- [ ] **Step 2: Testes de Request no harness, com SDK Anthropic falso e `fetch` falso do Graph.**
  - `DM sem telefone: a IA pede o WhatsApp`: o prompt contém `INSTAGRAM_CHANNEL_RULES` e a identidade, e a lista de ferramentas termina em `link_customer_phone`.
  - `DM com telefone: link → reserva instagram`: `reserveSlot` recebe `source:"instagram"`, o ledger ganha a reserva e a conversa ganha `customer_id`.
  - `worker ignora entradas de outra conta no mesmo corpo`, com a outra conta em **outra organização**: nenhuma linha de contato, conversa ou ledger da unidade pedida nasce de item da outra conta (gate de tenant do Bloco 1).
  - `mesmo mid em dois corpos diferentes roda um turno`.
  - `revogação depois do ACK descarta sem LLM`: grant revogado e `dm_enabled=false`, nos dois casos com zero chamadas ao SDK.
  - Eco dá `echo_own` ou `echo_unknown`, sem append.
  - Resposta de 1500 bytes sai em duas mensagens, e uma falha na segunda dá `send_error`.
  - Erro 190 no envio marca `reauth_required`.
  - Turno que lança depois do lock libera, solta o lock e só então completa a mensagem.
  - Org bloqueada dá `org_billing_blocked`, sem LLM.
  - Contato ligado a cliente com vouchers e alergias: o prompt não os contém.
- [ ] **Step 3: Rode e confira FAIL. Implemente. Rode e confira PASS.** Controle positivo: inverter a ordem do catch (completar antes de soltar o lock) reprova o teste do turno que lança.
- [ ] **Step 4: Rode `npx vitest run src/lib/agent-turn-parity.test.ts` e confira PASS sem regravar**, o que prova que a mudança de `MEDIA_REPLY_TEXT` é inócua. Rode o `deno check` do worker e do `webhook-whatsapp`. Commit `feat(instagram): worker do Direct roda o agente com o contexto do Instagram`.

### Task 4.2: `send-manual-message` por canal (Opus)

**Files:**
- Modify: `supabase/functions/send-manual-message/index.ts`, `src/lib/whatsapp-manual-service-window-request.test.ts` (ou uma irmã `instagram-manual-message-request.test.ts`)

**Interfaces:**
- Produces:
  - o select da conversa inclui `channel, instagram_contact_id, instagram_contact:instagram_contacts(igsid, instagram_account_id)`;
  - `channel === "whatsapp"` mantém o fluxo atual, agora explícito;
  - `channel === "instagram"`:
    1. mesma autorização (`hasUnitAccess`) e mesma exigência de status;
    2. conta `connected` da unidade do contato, senão 409 `INSTAGRAM_NOT_CONNECTED`;
    3. janela de `evaluateManualServiceWindow`, fechada dá 409 `OUTSIDE_SERVICE_WINDOW`, reavaliada imediatamente antes de cada POST;
    4. `splitInstagramText` e envio na ordem, sem retry;
    5. `record_whatsapp_human_message` com o texto **das partes que saíram** e `provider_message_ids`, para que o eco desse envio conte como `echo_own` (D5);
    6. falha parcial dá 502 `{ code:"PARTIAL_SEND", sent: n, total: m }`;
    7. 190 marca `reauth_required` e dá 409 `INSTAGRAM_REAUTH_REQUIRED`.
  - Herdado do Bloco 2: parte com `isGraphOutcomeUnknown(r, "POST")` conta como "pode ter saído": o `PARTIAL_SEND` informa `sent` só com as partes confirmadas e a resposta diz que o desfecho da parte seguinte é desconhecido, sem reenviar.

- [ ] **Step 1: Testes.**
  - Conversa IG ligada a cliente com telefone **não** chama envio WhatsApp. Controle positivo: sem o ramo, o teste vê o POST do provider.
  - Janela fechada dá 409.
  - Janela fecha entre a leitura e o POST dá 409, sem POST.
  - `envio manual parcial grava só o que saiu`.
  - Membro de outra unidade dá 403.
  - O fluxo WhatsApp atual continua com os mesmos testes verdes.
- [ ] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Rode o `deno check`. Commit** `feat(conversas): envio manual pelo Instagram com janela de 24h`.

### Task 4.3: dead-letter do WhatsApp preso ao canal

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts:1135-1142`, `src/lib/whatsapp-inbound-reentry.test.ts:539-670`

- [ ] **Step 1: Atualize o teste textual:** a consulta do dead-letter contém `.eq("channel", "whatsapp")`. Acrescente o caso de comportamento: com uma conversa IG mais recente do mesmo cliente, o dead-letter promove a conversa WhatsApp.
- [ ] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS, com a paridade inalterada. Rode o `deno check`. Commit** `fix(whatsapp): dead-letter promove só a conversa do WhatsApp`.

### Task 4.5: rota gerenciada aceita `source='instagram'` (Opus) — D9

**Files:**
- Create: `supabase/migrations/<timestamp>_whatsapp_automation_source_instagram.sql`
- Modify: `supabase/functions/_shared/whatsapp-automation-resources.ts` (`captureExpected`, ramo `confirmation`/`reminder_d1`/`survey_d1`/`cancellation`)
- Modify: `src/lib/whatsapp-reservation-automation-routing.test.ts` e o teste de recursos da automação; caso novo no pré-voo `79`

- [ ] **Step 1: Testes.** `captureExpected` aceita `source='instagram'` e continua recusando origem desconhecida e `null`. No pré-voo, `app_private.whatsapp_automation_post_inner` aceita reserva `instagram` e recusa origem desconhecida. Controle positivo: voltar a lista para `('web','whatsapp')` reprova os dois.
- [ ] **Step 2: Migration.** Recrie `app_private.whatsapp_automation_post_inner` a partir do corpo **mais recente** (`20261019193132` ou posterior, se outra migration o recriou até lá), trocando só `not in('web','whatsapp')` por `not in('web','whatsapp','instagram')`. Confira com `diff` que a única linha alterada é essa e repita os `revoke` com a assinatura completa.
- [ ] **Step 3: Rode e confira FAIL. Implemente. Rode e confira PASS. Rode o `deno check` das consumidoras dadas por `node scripts/ef-import-graph.mjs supabase/functions/_shared/whatsapp-automation-resources.ts` (hoje `send-scheduled-whatsapp`) e acrescente-as à matriz de redeploy.**
- [ ] **Step 4: Commit** `feat(automacoes): rota gerenciada aceita reserva do Instagram`.

### Task 4.4: gates do Bloco 4

- [ ] Rode `npm run typecheck`, `npm run lint`, as suítes do bloco, a paridade e o `deno check` de `process-instagram-inbound`, `send-manual-message` e `webhook-whatsapp`.
- [ ] Rode `node scripts/check-portabilidade.mjs`. Acima da linha de base: **pare e pergunte**.
- [ ] Rode os gates com o Opus: `integration-reliability-auditor` (worker, ledger, envio), `tenant-isolation-auditor` (worker, envio manual) e `identity-access-auditor` (envio manual).
- [ ] Atualize `whatsapp.md`: `conversations.channel`, RPCs WhatsApp presas ao canal, `get_or_create_instagram_conversation` como único criador IG, envio manual por canal e ordem de exibição do nome. Atualize também `instagram.md`: worker, eco medido e `ignored_story_mention`.
- [ ] Commit `docs(conversas): conversa por canal nas regras`.

---

## Bloco 5 — Frontend

Antes de começar: leia `frontend.md`, as skills `saas-builder-br:tanstack-query-supabase` e `saas-builder-br:responsive-mobile-first`, e `docs/standards/ACCESS_CONTROL.md`. Toda chamada ao Supabase mora em `src/features/instagram/api.ts`. Hooks não chamam o Supabase direto.

### Task 5.1: API, tipos e origem `instagram` (Sonnet, review Opus)

**Files:**
- Create: `src/features/instagram/api.ts`, `src/features/instagram/types.ts`, `src/hooks/useInstagram.ts`, `src/features/instagram/api.test.ts`
- Modify: `src/types/reserva.ts` (`Conversation`: `customer_id: string | null`, `channel: "whatsapp" | "instagram"`, `instagram_contact_id: string | null`, `instagram_contact?: { username: string | null; name: string | null } | null`; união de `source` com `"instagram"`), `useFluxoClientes.ts:144-155`, `useDashboardMetrics.ts:14`, `exportCsv.ts:85`

**Interfaces:**
- Produces (`api.ts`):
  - `readUnitModules(unitId)`;
  - `setUnitModule(unitId, active: boolean)`;
  - `readInstagramAccount(unitId)`;
  - `readInstagramSettings(unitId)`;
  - `updateInstagramDm(unitId, enabled: boolean)`, que faz `.update().eq("unit_id").select()` e lança se vier zero linhas (AGENTS §8);
  - `connectStart(unitId)`, `connectCallback(code, state)`, `disconnectInstagram(unitId)`, `resubscribeInstagram(unitId)`;
  - `readInstagramDiagnostics(unitId)`;
  - erros de `FunctionsHttpError` extraídos de `context.json()`.
- Produces (hooks): `useInstagramModule(unitId)`, `useInstagramAccount(unitId)`, `useInstagramSettings(unitId)` e as mutations. Todas as chaves começam por `["instagram-<entidade>", unitId]`.
- Rótulo de origem: `instagram: "Instagram"`.

- [ ] **Step 1: Testes da API com client falso.**
  - Toda leitura filtra pela unidade.
  - Update com zero linhas lança.
  - Chaves com `unitId` na posição 1.
- [ ] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Rode `npm run typecheck`, que deve continuar com zero erros e pega os leitores de `customer_id`. Commit** `feat(instagram): api e hooks do módulo no frontend`.

### Task 5.2: aba "Instagram" na Plataforma (Sonnet)

**Files:**
- Create: `src/components/instagram/InstagramAdminCard.tsx`, `src/components/instagram/InstagramAdminCard.test.tsx`
- Modify: `src/pages/gestao/Automacao.tsx:222-273` (aba `instagram` só quando o usuário é `platform_admin`, no padrão do `DatafyAdminCard`)

- [ ] **Step 1: Testes.**
  - Liberar e revogar chamam `setUnitModule`.
  - O card mostra o status da conta (`@`, validade do token, "Reconectar necessário" em `reauth_required`).
  - O diagnóstico mostra contagens e o último evento, sem texto de mensagem.
  - O ramo de erro tem "Tentar de novo".
- [ ] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Commit** `feat(instagram): liberação e diagnóstico na plataforma`.

### Task 5.3: página da loja e callback (Sonnet, review Opus no callback)

**Files:**
- Create: `src/pages/gestao/Instagram.tsx`, `src/pages/InstagramCallback.tsx` e os testes
- Modify: `src/App.tsx` (`/g/:unitSlug/instagram` com `GestaoGuard`; `/instagram/callback` autenticada, fora do `GestaoGuard`), `src/components/layouts/GestaoLayout.tsx:77-140` (item "Instagram" só com grant ativo **e** `isGerente`)

**Interfaces:**
- Página: `if (!unit.isGerente) <Navigate …/reservas>`. Sem grant, mostra "Módulo não liberado para esta unidade".
- Aba **Conexão**:
  - conectar, que redireciona para `authorize_url`;
  - reconectar quando `reauth_required`;
  - desconectar, com confirmação no `ResponsiveDialog`;
  - `@` da conta, validade e "Assinar de novo" quando `subscribed:false`.
- Aba **Direct**:
  - interruptor `dm_enabled`;
  - aviso fixo: "Respostas enviadas pelo app do Instagram não pausam a IA. Para atender você mesmo, use Assumir em Conversas." (D5).
- Callback:
  - lê `code`/`state`;
  - **compara o `state` recebido com o guardado no `start`** (o `start` devolve `{ authorize_url, state }`; guarde o `state` em `sessionStorage` antes do redirecionamento), apaga o guardado antes de chamar a EF e recusa sem chamar a EF quando não há `state` guardado ou ele difere (R2-d: a EF não tem nonce store);
  - chama `callback` **uma vez só** (guarda contra StrictMode e reload; o código da Meta é de uso único e a segunda chamada daria 502);
  - **remove os dois da URL com `history.replaceState` antes de qualquer outra coisa**;
  - chama `connectCallback` e navega para `/g/<unit_slug>/instagram`;
  - em erro, mostra a mensagem do backend e um link de volta.

- [ ] **Step 1: Testes.**
  - Operador é redirecionado.
  - Sem grant, o item não aparece no menu.
  - O callback limpa a URL antes do `connectCallback`. Controle positivo: sem `replaceState`, o teste vê o `code` na URL durante a chamada.
  - Callback com `state` diferente do guardado, ou sem `state` guardado, não chama `instagram-connect`. Controle positivo: sem a comparação, a EF é chamada.
  - Em StrictMode (efeito duplo), `connectCallback` roda uma vez.
  - Operador não vê o cartão de status (a EF nega `status` a operador; a RPC aceitaria, mas a régua da tela é a da EF).
  - O interruptor desfaz o estado otimista quando a mutation falha.
- [ ] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Commit** `feat(instagram): página da loja com conexão e Direct`.

### Task 5.4: Conversas com canal (Sonnet)

**Files:**
- Create: `src/lib/conversation-channel.ts`, `src/lib/conversation-channel.test.ts`
- Modify: `src/hooks/useConversations.ts:14-15` (`LIST_COLUMNS` + `channel, instagram_contact_id, instagram_contact:instagram_contacts(username,name)`), `src/lib/utils.ts:143-156` (`getConversationDisplayName`), `src/pages/gestao/Conversas.tsx`, `src/hooks/useSendManualMessage.ts`, `src/pages/gestao/Conversas.service-window.test.tsx`

**Interfaces:**
- Produces:
  - `type ChannelFilter = "all" | "whatsapp" | "instagram"`;
  - `filterByChannel(list, filter)`;
  - `countByChannel(list): Record<ChannelFilter, number>`;
  - `readChannelFilter(): ChannelFilter` e `writeChannelFilter(f)`, com `localStorage` na chave `conversas-channel-filter` e `try/catch`; valor inválido vira `"all"`.
- `getConversationDisplayName`: `customer.name` (≠ telefone) → `contact_name` → `@username` → `formatPhone(phone)` → "Contato do Instagram" (IG) ou "Cliente sem nome" (WhatsApp).
- Conversas:
  - chips Ambos/WhatsApp/Instagram com contagem, combinados com os chips de status no `useMemo`;
  - chips visíveis quando o módulo está ativo ou existe alguma conversa IG;
  - ícone do canal no item;
  - título "Conversas";
  - copy da janela por canal ("janela de 24h do Instagram");
  - em conversa IG, `canSend` depende da conta conectada e da janela, não do canal WhatsApp;
  - erros `INSTAGRAM_NOT_CONNECTED`, `INSTAGRAM_REAUTH_REQUIRED` e `PARTIAL_SEND` com mensagens próprias.

- [ ] **Step 1: Testes.**
  - Filtro de canal com cada chip de status.
  - Contagens.
  - `localStorage` que lança não quebra a tela.
  - Nome exibido nas 6 ordens.
  - Conversa IG sem canal WhatsApp na unidade permite enviar.
  - Lista vazia filtrada mostra o vazio, não branco.
- [ ] **Step 2: Rode e confira FAIL. Implemente. Rode e confira PASS. Commit** `feat(conversas): filtro e exibição por canal`.

### Task 5.5: páginas de privacidade (Sonnet)

**Files:**
- Create: `src/pages/public/Privacidade.tsx`, `src/pages/public/PrivacidadeExclusao.tsx`
- Modify: `src/App.tsx` (rotas públicas)

- [ ] **Step 1: Peça ao responsável os dois textos.** Sem texto, a task fica pendente e **não vai com placeholder**. O Bloco 6 não publica o app Meta sem as duas URLs no ar.
- [ ] **Step 2: Implemente com o texto fornecido, no tema público, e com um teste de render. Commit** `feat(portal): política de privacidade e exclusão de dados`.

### Task 5.6: gates do Bloco 5

- [ ] Rode `npm run typecheck`, `npm run lint`, `npm run build` e as suítes de `src/pages`, `src/components/instagram` e `src/lib/conversation-channel`.
- [ ] Rode `node scripts/check-portabilidade.mjs`. Acima da linha de base: **pare e pergunte**.
- [ ] Rode `tenant-isolation-auditor` (Opus) sobre `api.ts`, hooks e Conversas: chaves e filtros por unidade.
- [ ] Rode a revisão de copy com a skill `pt-br-utils:pt-br-translator` nas telas novas.
- [ ] Atualize `frontend.md`: as rotas `/instagram/callback` e `/privacidade*`, e a chave `localStorage`. Commit.

---

## Bloco 6 — Release e piloto

### Task 6.1: branch inteira

- [ ] Faça rebase sobre `origin/main`. Rode `npm run typecheck`, `npm run lint`, `npm run build` e `npm run test`. As falhas aceitas são só as preexistentes que falham igual num checkout limpo de `origin/main`: `whatsapp-template-surfaces`, `template-catalog-v2`, `waitlist-voucher-routing`, `receipts-request`, `reservation-automation-routing`, `migration-twin` e `TemplateCatalogAdminCard`, mais `OfficialConnectionCard` por falta de `.env.local`. Registre as contagens.
- [ ] Rode o `deno check` de todas as EFs da matriz, `node scripts/check-padrao.mjs` e `node scripts/check-portabilidade.mjs`.
- [ ] Faça o pré-voo completo: `79a`, `79`, `08`, `38` e `67d`.
- [ ] Faça a review da branch inteira com a skill `superpowers:requesting-code-review` no Opus. Rode `saas-shield-br:pre-deploy` e `saas-shield-br:secret-scan`.
- [ ] Faça `git status`, `git diff --cached` integral, a varredura de segredos das linhas staged (AGENTS §5) e `git add` explícito.

### Task 6.2: PR e banco (cada passo com autorização)

- [ ] Push e PR, com a descrição contendo:
  - as decisões D1–D9 (D9 = Task 4.5) e os desvios S1–S7;
  - a matriz de redeploy;
  - as mudanças deliberadas de comportamento do WhatsApp: CAS no handoff, filtro de canal nas RPCs e no dead-letter, guarda `invalid_channel_context`;
  - o diff do snapshot (3.1).
- [ ] Confira o `acl-estatico` na aba Checks.
- [ ] Antes do `db push`, rode `saas-shield-br:schema-diff` contra o remoto e duas leituras só de consulta (Bloco 1): `select rolname, rolbypassrls from pg_roles where rolname in ('postgres','service_role')` (o dono das funções DEFINER precisa de BYPASSRLS sobre as tabelas FORCE RLS) e `select has_schema_privilege('authenticated','auth','USAGE')` (as policies chamam `auth.uid()`).
- [ ] `npx -y supabase@2.121.0 db push --project-ref gbabxcrntkwgblgqsiit` (autorização própria). Confira `schema_migrations` e o `cron.job` dos três jobs.

### Task 6.3: segredos, EFs e frontend (ordem obrigatória: banco → segredos → EF → frontend)

- [ ] O responsável grava em `/platform/integracoes` `instagram_app_secret` e `instagram_verify_token` (gerado localmente, ≥32 caracteres, nunca commitado). `meta_app_secret` fica para depois, só se o piloto mostrar assinatura que não casa. **Não criar env de mesmo nome (S5).**
- [ ] `npx -y supabase@2.121.0 secrets set INSTAGRAM_APP_ID=… INSTAGRAM_OAUTH_STATE_SECRET=… --project-ref gbabxcrntkwgblgqsiit` (autorização própria).
- [ ] Deploy da matriz (autorização própria), conferindo `verify_jwt` de cada uma depois:
  1. novas: `webhook-instagram`, `instagram-connect`, `process-instagram-inbound`, `process-instagram-token-refresh`;
  2. alteradas: `webhook-whatsapp`, `create-reservation`, `update-reservation`, `create-manual-reservation`, `send-manual-message`, `manage-platform-secrets`.
  - Reconfirme com `node scripts/ef-import-graph.mjs --all` no momento do deploy.
- [ ] Confira o WhatsApp depois do deploy: turnos `success`, nenhum `invalid_channel_context`, nenhum `tool_error` novo (rollback: versões anteriores a partir do merge-base).
- [ ] Merge do PR (autorização própria) → Vercel `READY`.

### Task 6.4: operação Meta (responsável) e piloto Moralles

Checklist do responsável. Antes de cada passo que conecte conta, **confirmar comigo o `@` da Moralles pelo nome**.

- [ ] Criar o app Meta do tipo Business, com o caso de uso "Manage messaging and content on Instagram" → "API setup with Instagram login". Anotar o **Instagram app ID** e o **Instagram app secret**, que são diferentes dos do app Meta.
- [ ] Em "Business login settings":
  - Redirect URL: `https://reservas.moralles.com.br/instagram/callback`, exata e sem barra final (a Meta pode acrescentar uma; confira);
  - Data deletion request URL: `https://reservas.moralles.com.br/privacidade/exclusao-de-dados`;
  - Deauthorize callback: deixar vazio se o painel permitir, porque a Fase 1 não o consome e o 190 marca `reauth_required`. Se o painel exigir, **avisar antes de publicar**.
- [ ] Em "App settings": política de privacidade `https://reservas.moralles.com.br/privacidade`, ícone e categoria.
- [ ] Webhooks: Callback `https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-instagram`, Verify token igual ao `instagram_verify_token` → "Verify and save" (depende da Task 6.3) → assinar o campo `messages`.
- [ ] Papéis: dar papel no app à pessoa que administra a conta IG da Moralles, e confirmar que a conta é Profissional (Business ou Creator).
- [ ] No app do Instagram da Moralles: Configurações → Mensagens e respostas a stories → Controles de mensagens → Ferramentas conectadas → **Permitir acesso às mensagens**. Esse caminho tem só evidência secundária: confirmar na tela.
- [ ] Publicar o app (Live). A doc diz que webhooks exigem app publicado.
- [ ] Gravar `INSTAGRAM_APP_ID` e `instagram_app_secret` (Task 6.3), se ainda não estiverem.
- [ ] Faixa paralela, fora da saída da Fase 1: Business Verification, App Review e Advanced Access para lojas além da piloto.

Piloto, depois que o responsável disser "pode liberar":
- [ ] O `platform_admin` concede o módulo à Moralles na aba Instagram. O gerente conecta a conta, confere o `@` e liga o Direct.
- [ ] Rodar o E2E de saída, registrando cada passo nas Evidências:
  1. DM de teste;
  2. a IA pede o WhatsApp;
  3. o cliente informa o número;
  4. sai a reserva com `source='instagram'`;
  5. a confirmação chega pelo WhatsApp (D6);
  6. a conversa aparece em Conversas com o filtro Instagram;
  7. Assumir;
  8. resposta manual dentro da janela;
  9. Devolver;
  10. a IA responde.
- [ ] Medições:
  - qual segredo assinou (`signature_secret`);
  - ecos `echo_own` × `echo_unknown`, enviando uma mensagem pelo app e outra pela API;
  - latência do ACK;
  - `get_instagram_diagnostics` sem `dead`.
- [ ] **Rollback:** revogar o grant corta a ingestão na hora, e desligar o Direct também. As EFs voltam às versões anteriores. As migrations são aditivas e não precisam voltar.
- [ ] Atualizar a memória do módulo, a seção Evidências e as regras com o que o piloto mediu.

---

## Pré-voo SQL (resumo)

| Caso | Prova | Task |
|---|---|---|
| IG-1.1 / IG-1.2 | só `platform_admin` concede; um grant ativo por unidade e módulo | 1.1 |
| IG-1.3 / IG-1.4 | A×B em módulos e settings; **operador sem escrita** em `instagram_settings` | 1.1 |
| IG-1.5 | ACL das funções e da tabela de grant | 1.1 |
| IG-2.1 – IG-2.6 | A×B de conta e contato; conta única por unidade e por `ig_user_id`; token só por `service_role`; coerência de organização; ledger por unidade e cliente; anonimização | 1.2 |
| IG-3.1 – IG-3.5 | claim e finalize cercados; ledger por `mid`; coerência da fila; diagnóstico só `platform_admin`; purga | 1.3 |
| IG-4.1 – IG-4.7 | CHECK de canal; RPCs WhatsApp presas ao canal (com o 38); coerência IG; criação idempotente; link entre organizações; A×B de conversa IG | 1.4 |
| IG-5.1 | `source='instagram'` aceito e confirmação enfileirada (D6) | 1.5 |
| IG-5.2 / IG-5.3 | um único CHECK de `source`, validado; drift aborta a migration | 1.5 |
| IG-6.1 – IG-6.4 | conexão e desconexão autorizadas no SQL; contatos só por RPC/trigger DEFINER e anonimização irreversível; conversa IG sem `wa_chat_lid` | 1.6 (gates) |

## Matriz de redeploy prevista

Recalcular com `node scripts/ef-import-graph.mjs --all` no Bloco 6.

| Origem da mudança | EFs |
|---|---|
| `_shared/agent/{turn,system-prompt,tools,tool-dispatch}.ts`, `agent-reservation-tools.ts`, `instagram-format.ts`, `instagram-inbound-core.ts`, `media-reply-text.ts` | `webhook-whatsapp`, `process-instagram-inbound` |
| `_shared/availability.ts` (tipo de `source`) | `webhook-whatsapp`, `create-reservation`, `update-reservation`, `create-manual-reservation`, `process-instagram-inbound` |
| `_shared/instagram-graph*.ts` | `instagram-connect`, `process-instagram-inbound`, `process-instagram-token-refresh`, `send-manual-message` |
| `_shared/instagram-config*.ts`, `instagram-webhook-core.ts` | `webhook-instagram`, `instagram-connect` |
| `_shared/instagram-access-core.ts`, `instagram-oauth-state.ts` | `instagram-connect` |
| `_shared/instagram-token-refresh-core.ts` | `process-instagram-token-refresh` |
| `index.ts` alterado | `webhook-whatsapp`, `send-manual-message`, `manage-platform-secrets` |
| `org-billing-gate-core.ts` (se extraído) | `webhook-whatsapp`, `process-instagram-inbound` |

Linha de base de 2026-10-20:
- `agent/turn.ts`, `agent/system-prompt.ts`, `agent/tools.ts`, `agent-reservation-tools.ts` → só `webhook-whatsapp`;
- `availability.ts` → 4 EFs;
- `whatsapp-inbound-queue-core.ts` → 4 EFs (inalterado nesta fase);
- `whatsapp-manual-service-window-core.ts` → `send-manual-message`.

## Gates `saas-shield-br` por bloco

| Bloco | Gates |
|---|---|
| 1 | `migration-validator` (por arquivo), `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`; pré-voo 79 + 08/38/67d |
| 2 | `integration-reliability-auditor`, `identity-access-auditor`, `secret-hunter`, `edge-function-guard` |
| 3 | `tenant-isolation-auditor`, `identity-access-auditor`, `saas-audit-br:ai-automation-auditor`, `integration-reliability-auditor` |
| 4 | `integration-reliability-auditor`, `tenant-isolation-auditor`, `identity-access-auditor` |
| 5 | `tenant-isolation-auditor` (frontend) |
| 6 | review da branch, `pre-deploy`, `secret-scan`, `schema-diff`, `acl-estatico` no PR |

## Fora desta fase (registrado)

- Contato do Instagram **sem** cliente ligado não tem caminho de exclusão LGPD pela tela. Hoje só se resolve por SQL; vira item da Fase 2.
- A anonimização de cliente não apaga `conversations.messages` (WhatsApp e Instagram). É anterior a este módulo.
- Hard delete de cliente apaga a conversa do Instagram ligada a ele (`conversations.customer_id … on delete cascade`, anterior ao módulo), e o contato sobrevive sem cliente (`set null`). Coerente com LGPD; a decisão de produto fica para a Fase 2.
- A linha da fila guarda o POST inteiro da Meta, que pode trazer `entry[]` de outras contas (até de outra organização), por 7 dias (`done`) ou 30 (`dead`), fora da anonimização. O corpo fica intacto por desenho (dedupe por `body_sha256` e reprocessamento, como a fila do WhatsApp); o worker filtra por `entry.id` (Task 4.1). Guardar só o recorte da conta é a alternativa, se o piloto mostrar POSTs com várias contas. Risco aceito no Bloco 1.
- Callback de desautorização da Meta.
- Tag `HUMAN_AGENT`.
- Correlação de eco para silenciar a IA: decisão da Fase 2, com a medição de D5.
- `subscribed_fields` além de `messages` (`message_echoes`, `messaging_referral`): os nomes divergem entre páginas da doc e só entram com teste no piloto.

## Evidências

### Bloco 1

Executado em 2026-10-20/21 na branch `feat/instagram-fase-1`, local, sem push, sem `db push`, sem deploy e sem chamada à Meta. Commits `977aa66..22a6df6` depois do rebase sobre `origin/main` (`4f211e5`, PR #55), mais o commit de docs final. Execução por tarefa (implementador Opus, review de spec Sonnet, review de qualidade e segurança Opus), com uma rodada de correção em cada Task de 1.2 a 1.5 e três nos gates. A terceira deixou os controles do 79 indiferentes a CRLF, porque a cópia de trabalho com `core.autocrlf=true` grava os corpos das funções com CR.

**Migrations (timestamps acima da última de `origin/main`; nasceram como `20261020120000…120500`, foram renomeadas para `20261021120000…120500` no rebase sobre o PR #55 (MARKETING `20261020183000`/`184000`) e para `20261021200000…200500` no rebase sobre o PR #56, cuja migration é `20261021190000_whatsapp_v2_service_self_service`):** `20261021200000_instagram_module_grants`, `…200100_instagram_accounts_contacts`, `…200200_instagram_inbound_queue`, `…200300_conversations_instagram_channel` (`begin` + `lock_timeout 5s`, NOT VALID + VALIDATE), `…200400_reservations_source_instagram` (idem, mais a guarda de drift P0001 `reservations_source_check_drift`) e `…200500_instagram_cron`. Os corpos de `get_or_create_whatsapp_conversation` (de `20260905143453`) e `app_private.reconcile_whatsapp_automation_acceptance_inner` (de `20261019183559`, o mais recente) foram recriados verbatim, mais uma linha cada (`and channel = 'whatsapp'` / `and conversation.channel = 'whatsapp'`), conferido por `diff` e pelo gate.

**Pré-voo** (PostgreSQL 18.6 descartável em loopback, receita do README §79: `00 → 01 → 09a → 106 → 79a`, migrations cruas sem `psql -1`):
- RED antes de cada task (exit 3 na guarda do topo); GREEN final **77/77**, de novo 77/77 depois de reaplicar as cinco migrations (idempotência) e sem linha residual. A 120500 não roda no harness (sem `pg_cron`); o gêmeo a lê como texto.
- Ordinais (IG = caso, C-IG = controle positivo, que sabota, reprova, restaura e compara o catálogo):
  - 1.1: IG-1.1–1.6 = 7901–7906; C-IG-1.1–1.6 = 7908–7913.
  - 1.2: IG-2.1–2.10 = 7920–7929; C-IG-2.1–2.10 = 7930–7939.
  - 1.3: IG-3.1–3.8 = 7940–7947; C-IG-3.1–3.8 = 7950–7957.
  - 1.4: IG-4.1–4.8 = 7960–7967; C-IG-4.1–4.8 = 7970–7976 e 7978. O IG-4.3 roda no 79 com um stub mínimo fiel do entorno; o 38 não foi rodado, porque exige o stack Docker `moralles-templates-20261003`.
  - 1.5: IG-5.1–5.3 = 7980–7982; C-IG-5.1–5.2 = 7990–7991. Os controles do IG-5.3 (cópia sem a guarda) e do `lock_timeout` (sessão segurando o lock) são manuais e estão documentados no README §79.
  - Gates: IG-6.1–6.4 = 7914–7917; C-IG-6.1–6.4 = 7992–7995.
- Vizinhos: 08 verde (12 arquivos); 67d `GREEN67d` em 3 aplicações; 76 (MARKETING) verde depois do rebase.
- Depois do rebase e do rename (`523548f`, `22a6df6`): 79 com 77/77 nas duas formas, com as migrations em CRLF e em LF, aplicadas e reaplicadas.

**Outros comandos (verdes):**
- `npm run typecheck`: exit 0.
- `npx vitest run scripts/`: 118/118.
- `instagram-queue-migration-twin`: 18/18. É o gêmeo de lease 90s, purga 7d/30d e ledger 30d, mais a expressão do sweep amarrada a `INBOUND_SWEEP_INTERVAL_MS`.
- `whatsapp-conversation-parity-guard`: 13/13.
- `agent-turn-parity`: 10/10 sem regravar o snapshot. Teve um timeout de 5s sob carga, verde ao rodar sozinho.
- `function-acl-allowlist` e `migration-static-guard`: verdes.
- `check-padrao`: exit 0.
- `check-portabilidade`: 487 = linha de base.
- Suíte completa depois do rebase: 196 de 198 arquivos verdes. Só falha `OfficialConnectionCard`, que já falhava antes por falta de `.env.local`.

**Review final da branch (Opus):** pronta com pequenos ajustes. O 79 em CRLF foi corrigido em `22a6df6`. C3 foi alinhado à Task 2.3. A Task 6.2 ganhou D9 e as consultas de `rolbypassrls` e `USAGE` em `auth`. As notas de rollback da 120300 ganharam `lock_timeout`. Os itens menores adiados das Tasks 1.1–1.6 foram aceitos, cada um com motivo, no ledger da execução.

**Gates (todos Opus, PASS_WITH_WARNINGS, 0 bloqueante):** `migration-validator` ×6, `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`. Corrigido no bloco (`b34c7e8`, `d928eef`, `22a6df6`):
- `store_instagram_account_connection` exige grant ativo e ator owner/gerente da unidade ou `platform_admin`.
- `disconnect_instagram_account` prende o ator à unidade da linha travada; conta inexistente também cai no 42501.
- Nos dois casos acima, toda recusa é o mesmo `42501 instagram_account_forbidden`.
- `service_role` só lê `instagram_contacts` (a escrita é por RPC ou trigger DEFINER) e a anonimização do contato é irreversível.
- Conversa IG nunca carrega `wa_chat_lid`.
- Dois comentários corrigidos.

**Atenções com decisão:**
- **FK RESTRICT conta → contato → conversa:** sem mudança. Medido: o `delete from units` com conta, contato, fila e ledger passa. Com conversa IG, quem trava é a FK `conversations_unit_id_fk`, que é anterior ao módulo e trava igual com conversa WhatsApp. O segredo do Vault sobrevive ao hard delete da unidade. Um fluxo futuro de hard delete de unidade chama `disconnect_instagram_account` antes, porque o token fica válido na Meta por até 60 dias.
- **Auditoria de `dm_enabled`:** descartada. `audit_trigger_func` exige `NEW.id` e `instagram_settings` tem PK `unit_id`. O carimbo `updated_by`/`updated_at` guarda o último ator. Reavaliar quando as Fases 2 e 3 ampliarem a tabela.
- **Ponteiro do Vault divergente** (`instagram_account_secret_mismatch`) bloqueia conectar e desconectar aquela conta. Só acontece por adulteração manual; a recuperação é SQL do dono (`update public.instagram_accounts set token_secret_id = null where id = …`), porque `service_role` só lê a tabela.
- **Corrida entre `store` e revogação concorrente do grant:** aceita, porque o gate do worker reconfere o grant.
- **Policy de UPDATE de `instagram_settings` com `exists` inline:** mantida. `public.unit_role` foi revogada de `authenticated` (085:191) e o comentário registra a dependência da RLS de `unit_members`.
- **`auth.uid()` sem `(select …)` nas policies:** aceito, porque é uma linha por unidade.
- **FKs simples cobertas por trigger:** aceitas. A FK composta fica para fase futura.
- **Purgas sem índice de apoio:** aceitas no volume do piloto.
- **Uniões `"web" | "whatsapp"` no escritor e nos leitores de `source`:** ficam para o Bloco 3 (`availability.ts`) e o Bloco 5.
- **Membro grava `source` arbitrário em `reservations`:** anterior ao módulo. Vai para o plano de risco de grants.
- **Cron no mesmo `db push` antes das EFs:** os 404 são inofensivos sem grant. Na 6.3, conferir `?sweep=1` com 200 e o 401 sem a chave.
- **Purga num único statement:** documentada no cabeçalho.
- **POST cru com `entry[]` de outras contas e retenção do corpo:** registrado em "Fora desta fase". A Task 4.1 tem o teste de corpo misto com duas organizações.
- **Hard delete de cliente apaga a conversa IG:** registrado em "Fora desta fase".
- **Contrato C1–C6 para as EFs:** está no topo do Bloco 2.
- **D9 (decisão do responsável):** a rota gerenciada de automação recusa `source='instagram'`. Vira a Task 4.5, antes do grant do piloto.

**Ajustes de plano:**
- `ignored/self` → `ignored_self`, porque o desfecho obedece ao CHECK `^[a-z0-9_]{1,64}$`.
- O link markdown da linha do `sanitizeForInstagram` foi reescrito, porque o `check-padrao` o lia como link quebrado.
- Os jobs de cron entraram em `edge-functions.md` já no 1.6.

### Bloco 2
Executado em 2026-10-29 na branch `feat/instagram-fase-1`, local, sem push, sem `db push`, sem deploy, sem `secrets set` e sem chamada à Meta (todos os testes usam `fetch` falso). Começou com `git fetch` e rebase sobre `origin/main` `a7624e7` (PR #56, migration `20261021190000_whatsapp_v2_service_self_service`); por autorização do responsável, as migrations do Bloco 1 foram renomeadas para `20261021200000…200500` (`5fa1cdb`) e a projeção de ACL somada à do serviço v2 (9/46/55). Pré-voo 79 depois do rename: RED exit 3, GREEN 77/77 duas vezes (PostgreSQL 18.6 descartável na porta 55442: a 55432 passou a ser de um container Docker de outro projeto).

Execução por tarefa: implementador (Sonnet em 2.1 e 2.5, Opus em 2.2–2.4), review de spec (Sonnet) e review de qualidade e segurança (Opus), teste falhando primeiro e controle positivo em cada task.

**Commits:** `53a6c6e` + `832865d` (2.1, uma rodada de correção: `parseMe` recusa `user_id` numérico inseguro), `e51f098` + `a4ca9d2` (2.2; a leitura de `platform_secrets` saiu de `_shared` para o `index.ts` de cada EF, D3), `d4b7cd1` + `ea619ac` (2.3, uma rodada: corpo lido em stream com teto de 2 MiB), `d5af1e0` (2.4), `d68ce7b` (2.5), `e7fded7` (correções dos gates), mais o commit de docs.

**Desvios do texto do plano (rulings):**
- R2-a: `raw_body` é o hex dos bytes recebidos (`rawBodyByteaHex`), não `encodeRawBodyHex(text)`, que trocaria UTF-8 inválido e quebraria a revalidação do HMAC.
- R2-b: o kick para `process-instagram-inbound` é best-effort (a EF só nasce na 4.1); a varredura de 1 min é a rede.
- R2-c: o leitor de `platform_secrets` cacheia só sucesso por 5 min, nunca falha, nunca env.
- R2-d: sem nonce store; uso único = código da Meta + `state` preso a usuário/unidade/exp + comparação no frontend (5.3, critério escrito na task). O `start` devolve `{ authorize_url, state }`.
- R2-e: `toLongLived` e `refresh` levam credencial na query porque a Meta exige; o adapter nunca devolve texto remoto.
- `_shared/instagram-config.ts` não faz `.from`: uma constante para escapar do regex do `check-portabilidade` foi recusada; a consulta literal fica no `index.ts` (D3).
- O corpo do webhook é lido com `readBodyWithCap` (o plano dizia `arrayBuffer()`, que lê sem limite num endpoint sem autenticação).
- `classifyGraphError` ganhou 429/17/32 → `rate_limited` e 1/2 → `transient`.
- A `instagram-connect` lê o papel direto de `unit_members` + `platform_admins` (mesma consulta de `hasUnitAccess`, que não devolve o papel), com 503 em erro de leitura.
- Operador recebe 403 em `status` (régua da EF); a RPC aceita qualquer membro, sem token. A tela da 5.3 esconde o cartão.

**Gates locais (HEAD `e7fded7`):** `npm run typecheck` exit 0; lint sem erro (17 warnings, todos em arquivos anteriores ao bloco); `src/lib/instagram-*` + Datafy + Integracoes 15 arquivos 410/410; `scripts/` 118/118; arquivos de Request do harness verdes; `deno check` de `webhook-instagram`, `instagram-connect`, `process-instagram-token-refresh` e `manage-platform-secrets` exit 0; `check-padrao` exit 0; `check-portabilidade` 487 = linha de base; `secret-scan --range 5fa1cdb..d68ce7b` 0 achados. Suíte completa: 211 de 212 arquivos verdes (4594 testes); só falha `OfficialConnectionCard`, que já falhava por falta de `.env.local`.

**Gates (Opus), todos PASS_WITH_WARNINGS, 0 bloqueante:** `integration-reliability-auditor`, `identity-access-auditor`, `secret-hunter`, `edge-function-guard` (as três EFs e `manage-platform-secrets`); review final do bloco: pronto. Corrigido em `e7fded7`: predicado `isGraphOutcomeUnknown`; refresh com as contas devidas mais antigas primeiro e orçamento de 100 s; `expires_in` com teto de 90 dias; corpo da connect com teto de 16 KiB; `instagram_account_secret_mismatch` → 503; `start` devolve `state`; testes de `platform_admin` no callback e no disconnect; `readBodyWithCap` recusa chunk que não é `Uint8Array`.

**Atenções com decisão:**
- Refresh grava a partir de um retrato da varredura: uma reconexão no meio pode ser derrubada para `reauth_required`. Precisa de compare-and-set por `connected_at` nas RPCs (SQL): vai com as migrations da Task 4.5 (escrito na 4.1).
- O refresh continua para conta `connected` de unidade com grant revogado: a revogação desliga a ingestão, não a credencial.
- POST forjado custa uma leitura de `platform_secrets` quando `meta_app_secret` não existe; sem timeout de banco no webhook (a Meta reentrega e a fila deduplica).
- `P0001` → 409 "já conectada" depende de o store não levantar outro `P0001`; um SQLSTATE próprio fica para a próxima migration da conta.
- Sem rate limit nem `requestId` nas três EFs; sem trava de concorrência no refresh (a renovação é idempotente).
- Código 10 sem permissão cai em `window_closed` e o `exchangeCode` não devolve os escopos concedidos: medir no piloto.
- `manage-platform-secrets` loga `error.message` e engole erro de leitura de admin (anterior ao bloco): plano de risco.
- Segredos novos documentados em [RUNBOOK-ROTACAO-CREDENCIAIS.md](../../RUNBOOK-ROTACAO-CREDENCIAIS.md) §5. Deploy: `manage-platform-secrets` passa a importar `_shared/instagram-config-core.ts` e vai junto; `INSTAGRAM_OAUTH_STATE_SECRET` com ≥32 caracteres; `${APP_BASE_URL}/instagram/callback` registrado no app da Meta.

**Herdado pelos próximos blocos** (escrito nas Tasks 4.1, 4.2 e 5.3 e em `.claude/rules/instagram.md`): `verify_jwt = false` + `requireInternalAuth` no worker; teste do hop do kick; `INBOUND_MAX_ATTEMPTS` no worker; `isGraphOutcomeUnknown` no envio; `redactSecrets` em log novo; comparação do `state` e chamada única do callback na tela.

**Documentação:** `.claude/rules/instagram.md` (nova) e a linha na tabela do AGENTS.md §2. Os jobs de cron já estavam em `edge-functions.md` e os nomes conferem com as EFs (`process-instagram-token-refresh`; `process-instagram-inbound` nasce na 4.1).

### Bloco 3
_(preencher)_

### Bloco 4
_(preencher)_

### Bloco 5
_(preencher)_

### Bloco 6
_(preencher)_
