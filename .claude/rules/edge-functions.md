---
paths:
  - "supabase/functions/**"
  - "supabase/config.toml"
---

# Edge Functions, workers e deploy

## Segredos e ambiente

Frontend (`.env`): só `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. EFs: `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_API_KEY` (auth workers), `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (opcional).

- **`INTERNAL_API_KEY` precisa estar no Supabase Vault TAMBÉM** (`vault.create_secret(..., 'internal_api_key')`) pra `pg_cron` funcionar. Rotacionar nos DOIS lugares, **Edge Functions primeiro e Vault depois** — `requireInternalAuth` compara com UMA variável só ([_shared/security.ts](supabase/functions/_shared/security.ts)), então há janela de 401 inevitável e essa ordem a encurta pra ~1 min. Rotacionar pela metade silencia TODOS os workers sem erro visível (`pg_net` é fire-and-forget). Procedimento e verificação por `net._http_response` em [docs/RUNBOOK-ROTACAO-CREDENCIAIS.md](docs/RUNBOOK-ROTACAO-CREDENCIAIS.md) §4.
- **Stripe e chaves de IA NÃO ficam em env vars.** Stripe em `platform_secrets` (DB, painel `/platform/integracoes`); chaves de IA per-unit em `ai_provider_credentials` (BYOK, `/platform/unidades/<slug>`). Sem fallback global pra IA.
- **`platform_secrets` cai pro `Deno.env` em QUALQUER erro de leitura — o `try/catch` não distingue "sem linha" de "banco indisponível", então uma cópia velha em env é credencial VIVA durante qualquer soluço.** Rotacionar só no painel deixa o valor antigo aceito pela porta dos fundos; sincronizar `supabase secrets set` no mesmo ato (ou remover a env). Vale pra `asaas_api_key`, `asaas_webhook_token`, `stripe_secret_key`, `stripe_webhook_secret`. Runbook em [docs/RUNBOOK-ROTACAO-CREDENCIAIS.md](docs/RUNBOOK-ROTACAO-CREDENCIAIS.md). [_shared/asaas-config.ts](supabase/functions/_shared/asaas-config.ts).

## Tipos Deno no `tsc -b`

**`authz.ts` importa somente o tipo `SupabaseClient` da URL exata do SDK Deno.** O `tsc -b` resolve esse tipo através de [src/types/supabase-edge-type-bridge.d.ts](src/types/supabase-edge-type-bridge.d.ts), que o exporta do SDK npm instalado para os testes frontend; a declaração não exporta valores nem muda runtime. Essa ponte não comprova compatibilidade Deno: o gate usa `deno check` com o SDK remoto real, independentemente dela. Não amplie a declaração para wildcard, valores ou casts de caller.

## Contrato HTTP

- **EFs exclusivas de `platform_admin` (validam no JWT, `verify_jwt=true`):** `manage-ai-providers`, `manage-billing` (salvo `CLIENT_FRIENDLY_ACTIONS`), `manage-organizations`, `manage-stripe-accounts`, `manage-platform-secrets`, `whatsapp-health`, `manage-whatsapp-implementations` (exceção org-scoped: `get_service_status`). `manage-channels` libera só lifecycle client-safe a owner/gerente da própria unidade.
- **Edge Functions nunca devolvem `error.message` cru do Postgres em 500.** Mensagem curta PT-BR pro cliente; detalhe em `console.error`/`jsonLog`. Exceção: mensagens do Supabase Auth são UX-críticas, devolver intactas.
- **CORS em `manage-*`** via [_shared/cors.ts](supabase/functions/_shared/cors.ts) (whitelist localhost, *.vercel.app, reservas.moralles.com.br).

## Workers (pg_cron)

Padrão: `pg_cron` → wrapper `SECURITY DEFINER` lê `internal_api_key` do Vault → `pg_net.http_post` chama EF com `x-internal-key`.

| Job | Schedule UTC | Função |
|---|---|---|
| `process-notification-outbox` | `*/1 * * * *` | Outbox confirmação (lote 20, backoff 1m→4h, max 5) |
| `process-voucher-triggers` | `0 12 * * *` | Expira vouchers + emite aniversário/frequência |
| `process-reservation-reminders` | `0 13 * * *` | Lembrete D-0 |
| `process-satisfaction-surveys` | `0 17 * * *` | Pesquisa D+1 |
| `cleanup-orphan-assets` | `0 4 * * 0` | Blobs órfãos `unit-assets` (grace 60min) |
| `expire-pending-payments` | `*/2 * * * *` | Cancela `pending_payment` expirado |
| `process-billing-overdue` | `0 10 * * *` | Escala invoices vencidas (grace 5d → bloqueio D+6) |
| `process-billing-reminders` | `0 13 * * *` | Lembretes D0/D+1/D+3/D+5 (enfileira `billing_notifications`) |
| `process-billing-notifications` | `*/5 * * * *` | Dispatcher de avisos de billing (Resend, flag `billing_notifications_dispatch`) |
| `process-billing-reconcile` | `0 6 * * *` | Reconcilia subs/invoices com Stripe |
| `process-billing-unblock` | `*/5 * * * *` | Defesa dupla pra webhook `invoice.paid` |
| `process-trial-expiry` | `0 3 * * *` | Bloqueia trial vencido (skip se sub ativa ou override) |
| `process-asaas-reconcile` | `0 7 * * *` | Reprocessa `billing_events` Asaas presos em `received`/`failed` (reclassifica known/unknown) |
| `process-asaas-invoice-reconcile` | `0 8 * * *` | Reconcilia cobranças do Asaas com `billing_invoices` por assinatura (cria fatura faltante, liquida `open` paga lá, retém divergência de valor) |
| `process-whatsapp-enforcement` | `0 11 * * *` | Suspende/restaura a assinatura `WHATSAPP_SUBSCRIPTION` por inadimplência da instância (flag `whatsapp_service_enforcement`; OFF = dry-run) |
| `process-whatsapp-instance-cycles` | `10 12 * * *` | Rola ciclo do fornecedor, alerta D-7/D-1, confirmação de encerramento e divergências (nunca chama a Z-API) |
| `process-whatsapp-channel-health` | `*/5 * * * *` | Observa a conexão real dos canais ativos e carimba `whatsapp_channels.status`/`last_health_check_at` (só observa; não envia nem bloqueia) |
| `whatsapp-template-workers` | `*/5 * * * *` | `trigger_whatsapp_template_workers` → `process-whatsapp-templates`; provisiona/sincroniza catálogo autorizado |
| `whatsapp-automation-worker` | `* * * * *` | `trigger_whatsapp_automation_worker` → `process-whatsapp-automations`; consome ledger, rechecks/reparo/expiração |

- **`verify_jwt=false` obrigatório em `supabase/config.toml`** pra todo worker pg_cron (`process-*`, `expire-*`, `cleanup-*`). CLI ≥2.95 mudou default pra `true` — sem entrada explícita, gateway responde 401 antes do `requireInternalAuth` e cron silencia (pg_net é fire-and-forget). Worker novo = entrada nova antes do deploy.
- **`verify_jwt=true` explícito nas EFs de super-admin (`manage-*`, `whatsapp-health`), com exceção deliberada de `manage-whatsapp-templates`.** Esta usa `verify_jwt=false`, valida `getUser` e repassa JWT original às RPCs autenticadas que derivam ator/tenant; mudar para service role neutraliza essa autoridade SQL. [config.toml](supabase/config.toml), [manage-whatsapp-templates/index.ts](supabase/functions/manage-whatsapp-templates/index.ts).
- **Idempotência** via UNIQUE `(reservation_id, kind)` em `notifications_sent`. Workers lêem `reservation_message_templates` (`customized=true`) ou defaults hardcoded — **`defaultBody` em `useReservationTemplates.ts` precisa ficar sincronizado com `DEFAULT_*_BODY` dos workers** (worker é autoritativo).
- **`unitCache` zerado no início de cada invocação** — settings novos da UI refletem na próxima execução mesmo em EF quente.
- **Toda trigger function, independente do nome, precisa de `revoke all ... from public, anon, authenticated`.** `CREATE FUNCTION` concede `EXECUTE` a `PUBLIC` por padrão e o schema `public` é exposto ao PostgREST com a anon key; não confie no prefixo `trigger_*`. [20260817212500_harden_advisor_function_warnings.sql](supabase/migrations/20260817212500_harden_advisor_function_warnings.sql).

## Deploy

Deploy individual: `supabase functions deploy <nome>`. **Edge Functions não compartilham bundle em runtime** — alterar arquivo em `_shared/` exige redeploy de TODAS as functions que importam, senão continuam com versão antiga em memória.

**Migration que adiciona coluna lida por um gate fail-closed precisa ser aplicada (`supabase db push`) ANTES do deploy da Edge Function que a lê.** Coluna ainda inexistente vira 400 do PostgREST → leitura falha → `manage-channels` responde 403 `PROVISIONING_UNVERIFIABLE` pra toda unidade sem canal, inclusive `platform_admin`. [manage-channels/index.ts](supabase/functions/manage-channels/index.ts).

**A mesma ordem vale para migration que LIBERA um valor numa allowlist de CHECK, não só quem adiciona coluna: o banco primeiro, a EF depois.** A metadata de provider (rótulo, capabilities) vem do registry em código — deployar a EF antes do `db push` faz a opção nova aparecer normalmente na UI, sem nenhum sinal de que o banco ainda recusa. O caminho só falha depois, no INSERT, com erro genérico — e se houver chamada externa real antes da escrita (ex.: descoberta `/me` da Datafy em `manage-channels:create`), ela já foi gasta quando o CHECK antigo rejeita. Exemplo: liberar `"datafy"` em `manage-channels`/`manage-organizations` antes da [migration 110](supabase/migrations/20260922170000_110_datafy_provider.sql) ser aplicada.

## Quem redeployar quando `_shared/` muda

**Use o grafo, nunca lista digitada: `node scripts/ef-import-graph.mjs supabase/functions/_shared/<arquivo>.ts`** (ou `--all` para a matriz inteira). Ele segue imports por valor transitivos a partir de cada `index.ts`, inclusive arquivos locais da EF; `import type`/`export type` são apagados e não ampliam o deploy. Listas manuais divergiam do código em silêncio e deploy parcial deixa EF com `_shared/` velho em memória. Teste com controle positivo em `scripts/ef-import-graph.test.ts`.

O que o grafo NÃO enxerga, e continua obrigatório:

- **Ordem banco → EF.** Coluna, RPC, tabela ou valor de CHECK que a EF passa a usar chega por `supabase db push` antes do deploy (ver acima). Vale para toda migration citada nas regras de assunto.
- **Frontend que importa `supabase/functions/_shared/` direto** (cross-boundary deliberado: dois núcleos divergentes é pior que import fora do padrão) — `whatsapp-implementation-core.ts`, `whatsapp-instance-revenue-core.ts`, `whatsapp-inbound-queue-core.ts`, `whatsapp-org-provider-core.ts`, núcleo de onboarding Datafy, `ai-model-catalog.ts` (catálogo de modelos de IA, lido pela aba IA da unidade), `agent/global-prompt-core.ts` (validação, render e limites do prompt global e dos textos da loja, usados por `/platform/agente-ia` e `/g/:unitSlug/atendimento-ia`). Mudança neles também exige deploy do frontend (push em `main`).
- **Gêmeos declarados que não se importam:** SQL não importa TypeScript, então constantes duplicadas em migration (purga/cron da fila de inbound, CHECKs de touchpoint, vocabulário de notas de instância) e a cópia `src/lib/tax-id.ts` ⇄ `_shared/tax-id.ts` são amarradas por teste gêmeo; mudar um lado exige o outro. Detalhe nas regras de assunto.
- **Acoplamento por string `event_type`** entre produtor e `process-billing-notifications` (`TEMPLATE_BY_EVENT`): nenhum arquivo compartilhado liga os dois, e dispatcher velho marca a linha `failed/unknown_event_type`. Produtor e dispatcher deployam juntos; ver `.claude/rules/billing.md`.
- **Decisão mora em núcleo puro em `_shared/`, nunca no `index.ts` de EF:** o vitest não importa EF (`serve()` no carregamento + imports `deno.land`), e regra escrita lá só se confere por leitura. O `index.ts` é adapter de I/O.
