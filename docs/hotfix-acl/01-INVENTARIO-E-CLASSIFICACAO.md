# Hotfix ACL — Inventário e classificação das funções de `public`

> Levantado em 2026-07-30 contra o projeto `gbabxcrntkwgblgqsiit` (produção), por consulta
> **read-only** a `pg_proc`, `pg_default_acl`, `pg_policies`, `pg_trigger` e `cron.job`.
> **Nenhuma função foi invocada.** Achado que originou este trabalho:
> [ACHADO-SEGURANCA-EXECUTE-ANON.md](../ACHADO-SEGURANCA-EXECUTE-ANON.md).

**74 funções** em `public` (`prokind='f'`). **54 executáveis por `anon`** — 41 `SECURITY DEFINER`
e 13 `SECURITY INVOKER`. Owner de todas: `postgres`.

A classificação abaixo **não** deriva do grant atual. Deriva de: caller real encontrado no
repositório, guarda interna na própria função, e dependência estrutural (RLS/trigger).

---

## 1. Duas descobertas que restringem o que o hotfix pode revogar

Ambas foram confirmadas por consulta, e ambas transformariam o hotfix em incidente se
ignoradas. São a razão de este documento existir antes da migration.

### 1.1 Funções-helper chamadas de dentro de policies RLS

Uma policy é avaliada **no contexto de privilégio de quem consulta**. Se o papel não pode
executar a função que a policy chama, a query **não** é negada silenciosamente — ela **estoura
com `permission denied for function`**.

| Função | Policies que a chamam | Papéis dessas policies |
|---|---|---|
| `is_unit_member(uuid,uuid)` | 18 | `authenticated` |
| `is_unit_member(uuid,uuid)` | **24** | **`public`** (inclui `anon`) |
| `is_platform_admin(uuid)` | 26 | `authenticated` |
| `is_org_member(uuid,uuid)` | 3 | `authenticated` |

As 24 policies com `roles = {public}` estão em `reservation_message_templates`,
`voucher_rules`, `vouchers`, `waitlist`, `waitlist_message_templates`, `walk_ins` — são as
policies de membro escritas sem cláusula `TO` explícita, que o Postgres resolve para `public`.

**Consequência:** revogar `EXECUTE` de `is_unit_member` para `anon` arrisca quebrar a escrita
anônima em `waitlist` (entrada pública na fila). Revogar de `authenticated` quebraria
praticamente toda a aplicação autenticada.

**Decisão:** as três funções-helper **não** são tocadas por este hotfix. Ver §4 (follow-up).

### 1.2 Funções de trigger `SECURITY INVOKER` em tabelas graváveis por `anon`

`anon` escreve em `customers`, `reservations` e `waitlist`. Os triggers dessas tabelas:

| Tabela | Trigger | Função | Modo |
|---|---|---|---|
| customers | `customers_canonical_phone_trg` | `customers_force_canonical_phone` | **INVOKER — roda como `anon`** |
| customers | `trg_customers_sync_email` | `customers_sync_email` | **INVOKER** |
| customers | `customers_audit` | `audit_trigger_func` | DEFINER |
| reservations | `reservations_updated_at` | `update_updated_at` | **INVOKER** |
| reservations | `enqueue_confirmation_after_insert` | `enqueue_confirmation_notification` | DEFINER |
| reservations | `trg_enforce_operador_no_cancel` | `enforce_operador_no_cancel` | DEFINER |
| reservations | `reservations_audit` | `audit_trigger_func` | DEFINER |
| waitlist | `waitlist_priority_from_category` | `set_waitlist_priority_from_category` | **INVOKER** |
| waitlist | `waitlist_set_seated_at` | `set_waitlist_seated_at` | **INVOKER** |
| waitlist | `waitlist_updated_at` | `update_updated_at` | **INVOKER** |
| waitlist | `waitlist_validate_status_transition` | `validate_waitlist_status_transition` | **INVOKER** |
| waitlist | `waitlist_dispatch_entered` | `dispatch_waitlist_entered` | DEFINER |

Duas regras diferentes se aplicam aqui, e confundi-las é fácil:

- **A função do trigger em si**: o Postgres checa `EXECUTE` em `CREATE TRIGGER`, **não** a cada
  disparo. Revogar dela não quebra o trigger. Além disso, PostgREST **não expõe** função que
  retorna `trigger`. Logo: revogar é inócuo dos dois lados — nem ganha segurança, nem quebra.
- **Função chamada DENTRO do corpo de um trigger INVOKER**: essa é checada em runtime, no papel
  que disparou o trigger. `customers_force_canonical_phone` chama `normalize_br_phone(text)`;
  como o trigger roda como `anon` num INSERT anônimo, **`anon` precisa manter `EXECUTE` em
  `normalize_br_phone`**.

**Decisão:** funções que retornam `trigger` ficam fora do escopo (ganho zero, risco não-zero de
eu ter errado a análise). `normalize_br_phone` permanece acessível.

---

## 2. Classificação

### `SERVICE_ROLE_ONLY` — revogar de PUBLIC/anon/authenticated, conceder a `service_role`

Callers confirmados são Edge Functions, que usam a service role key.

| Função (assinatura completa) | Caller real | Estado hoje |
|---|---|---|
| `append_conversation_message(p_conversation_id uuid, p_message jsonb)` | `webhook-whatsapp:452`, `send-manual-message:135`, `_shared/conversation-log.ts:82` | **anon=SIM** ← crítico |
| `mark_outbox_done(p_id uuid)` | `process-notification-outbox:116` | **anon=SIM** |
| `mark_outbox_failed(p_id uuid, p_error text)` | `process-notification-outbox:126` | **anon=SIM** |
| `list_orphan_unit_assets(grace_minutes integer)` | `cleanup-orphan-assets:91` | **anon=SIM** |

`append_conversation_message` é o item crítico: comentário no banco diz `service_role only`,
migration `20260517120000` fez `revoke ... from public` + `grant ... to service_role` — e o
`anon` sobreviveu porque veio do default privilege, não do `PUBLIC`. **A função não tem guarda
interna nenhuma**: valida o formato do JSONB e faz o `UPDATE`.

### `OWNER_CRON_TRIGGER_ONLY` — revogar de todos; **não** conceder a ninguém

Executadas por `postgres` (dono) via `pg_cron` ou por SQL administrativo. O dono mantém
`EXECUTE` implícito; conceder a `service_role` seria superfície sem caller.

| Função | Executor real |
|---|---|
| 14 × `trigger_*()` — lista completa na migration | `cron.job`, todas com `username='postgres'` |
| `cleanup_processed_messages()` | nenhum caller no repo, nenhum `cron.job` — SQL administrativo |
| `cleanup_webhook_executions()` | idem |

As duas `cleanup_*` fazem `delete from` sem guarda alguma e são chamáveis hoje **sem argumento
e sem conhecimento nenhum**.

### `AUTHENTICATED_TENANT` — revogar de PUBLIC/anon, manter `authenticated`

| Função | Caller | Guarda interna |
|---|---|---|
| `get_undelivered_notifications(p_unit_id uuid, p_since timestamptz)` | `src/hooks/useUndeliveredNotifications.ts:39` | **Sim** — `is_unit_member OR is_platform_admin`, senão `raise forbidden` |
| `search_reservations(p_unit_id uuid, p_term text, p_date date, p_status text)` | `src/hooks/useReservas.ts:83` | INVOKER — RLS da tabela aplica |
| `get_reservation_by_code(p_code text, p_unit_id uuid)` | `src/hooks/useReservas.ts:101` | — |
| `get_reservation_by_code(p_code text)` | overload sem caller localizado | — |

`get_undelivered_notifications` é a evidência positiva do achado: o ACL está errado e **mesmo
assim não vaza**, porque `auth.uid()` é `NULL` para `anon` e a guarda derruba. O invariante do
projeto ("todo guard precisa do par `is_unit_member`/`is_platform_admin`") fez o trabalho dele.
A guarda **permanece** — o ACL correto é defesa em profundidade, não substituto.

### `PUBLIC_ANON` — allowlist; permanecem acessíveis, com grant explícito

Superfície pública prevista pelo `CLAUDE.md` ("anon lê só por RPCs `SECURITY DEFINER`").

| Função | Uso |
|---|---|
| `get_unit_public(p_slug text)` | portal `/r/:slug` |
| `get_unit_public_full(p_slug text)` | portal |
| `get_widget_public(p_slug text)` | widget `/w/:slug` |
| `get_menu_public(p_slug text)` | cardápio público |
| `get_public_tracking(p_token uuid)` | `/acompanhar/:token` |
| `get_public_business_hours(p_unit_id uuid)` | portal |
| `get_public_hall_schedules(p_hall_id uuid, p_date date)` | portal |
| `list_public_units()` | listagem pública |
| `enter_waitlist(p_unit_id uuid, p_customer_name text, p_customer_phone text, p_party_size integer, p_notes text, p_priority_category text, p_requested_for_time time without time zone)` | entrada pública na fila |
| `normalize_br_phone(raw text)` | **dependência de trigger INVOKER** (§1.2), não é RPC de portal |

### `RLS_HELPER` — **fora do escopo deste hotfix** (§1.1)

`is_unit_member(uuid,uuid)`, `is_platform_admin(uuid)`, `is_org_member(uuid,uuid)`.

### `UNKNOWN_REVIEW_REQUIRED` — revogar de anon/authenticated até revisão

| Função | Por que é desconhecida |
|---|---|
| `unit_role(p_user_id uuid, p_unit_id uuid)` | **nenhum** caller no repo, **nenhuma** policy a referencia. Possivelmente morta. |
| `next_waitlist_code(p_unit_id uuid)` | migration 036 concedeu a `anon, authenticated` deliberadamente, mas não há caller no repo. `enter_waitlist` é `SECURITY DEFINER` — se a chamar internamente, roda como o dono e não precisa do grant. |

Aplicando a regra do default-deny: revogar. Ambas entram no roteiro de validação como itens de
observação — se algo quebrar, o grant volta pontualmente e a função é reclassificada.

### Já corretas — nenhuma ação

`anon=false` hoje, com o grant certo. Confirmam que o padrão
`revoke ... from public, anon, authenticated` funciona neste banco:

`append_message`, `anonymize_customer`, `audit_trigger_func`, `check_rate_limit`,
`expire_vouchers`, `find_auth_user_by_email`, `get_customer_stats` (2 overloads),
`get_customer_stats_bulk`, `get_reservations_for_reminder`, `get_reservations_for_survey`,
`get_upcoming_reservations` (2 overloads), `get_waitlist_for_feedback`,
`release_conversation_ai_claim`, `release_giftback_lock`, `resolve_or_activate_subscription`,
`try_claim_conversation_for_ai`, `try_giftback_lock`.

---

## 3. Causa raiz, e a correção preventiva

`pg_default_acl` para `FUNCTION` no schema `public`:

| Role criadora | ACL default aplicado a toda função nova |
|---|---|
| `postgres` | `{postgres=X, anon=X, authenticated=X, service_role=X}` |
| `supabase_admin` | `{postgres=X, anon=X, authenticated=X, service_role=X}` |

**Toda função nova em `public` nasce executável por `anon`.** Default privilege é **por role
criadora**, não configuração global — por isso as duas entradas acima, e por isso corrigir só
uma deixaria o buraco aberto pela outra.

As migrations do projeto rodam como `postgres`. `supabase_admin` é da plataforma.

**Correção preventiva proposta:** `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated` — **apenas para `postgres`**, a role
auditada e sob nosso controle. Não tocar em `supabase_admin` (é da plataforma; alterá-la é
mudança não auditada que a Supabase pode reverter em manutenção).

Isso **não** impede grant explícito: RPC pública nova continua funcionando com
`grant execute ... to anon` na própria migration. Só deixa de nascer aberta.

**Risco residual assumido:** se a plataforma restaurar os defaults, ou se uma função for criada
por `supabase_admin`, o buraco reabre em silêncio. É por isso que o guardrail automatizado
(§ `scripts/audit-function-acl.mjs`) existe — ele é a rede, não o `ALTER DEFAULT PRIVILEGES`.

---

## 4. Follow-ups deliberadamente fora deste hotfix

1. **Helpers de RLS como oráculo de enumeração.** `is_platform_admin(p_user_id uuid)` e irmãs
   recebem o `user_id` por parâmetro em vez de lerem `auth.uid()`. Quem tiver um UUID de usuário
   descobre se ele é super-admin. A correção **não** é revogar `EXECUTE` (quebraria as policies,
   §1.1). O redesenho deve: obter a identidade internamente via `auth.uid()`, reduzir os
   parâmetros arbitrários que permitem a consulta de enumeração, e **não quebrar as policies
   existentes** — o que provavelmente exige migrar as 24 policies `{public}` para `TO
   authenticated` no mesmo movimento. Mudança de policy, risco próprio, spec própria.
2. **Guarda interna em `append_conversation_message` — prioridade alta.** O `revoke` da 085
   resolve a exposição ativa e é suficiente para o hotfix. Uma função de escrita cross-tenant
   sem checagem nenhuma continua frágil demais para depender de uma única linha de `grant`.
   **Registrado como follow-up explícito — não como comportamento considerado seguro.**

   Restrição de desenho, decidida pelo dono e não-óbvia: **a guarda não pode depender só de
   `auth.uid()`.** Os três callers legítimos são Edge Functions usando a service role key, onde
   `auth.uid()` é `NULL` — uma guarda ingênua nesse molde bloquearia exatamente quem deve passar
   e não bloquearia mais ninguém. Ela precisa validar explicitamente o **tenant/contexto
   autorizado da operação** (a conversa pertence à unidade/organização em nome de quem a
   chamada está sendo feita), não a mera presença de um usuário autenticado.
3. **`unit_role` possivelmente morta.** Confirmar e remover, ou documentar o consumidor.
