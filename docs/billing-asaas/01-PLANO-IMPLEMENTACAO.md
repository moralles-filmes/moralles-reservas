# Plano de Implementação — Billing Asaas, Cobrança Modular, Z-API e Créditos de IA

> Baseado na auditoria [00-FASE-0-AUDITORIA.md](00-FASE-0-AUDITORIA.md) (2026-07-16).
> Regra mestra: **nada de destrutivo** — migrations aditivas, Stripe preservada como legado read-only, feature flags default OFF, rollback documentado por fase.

## Checklist padrão de fim de fase (aplica-se a TODAS)

1. `npm run lint` · 2. `npm run typecheck` (`tsc -b`) · 3. `npm run test` · 4. `npm run build` · 5. `supabase db push` aplicado + query de validação pós-migration · 6. Entradas `verify_jwt` no `config.toml` para toda EF nova **no mesmo PR** · 7. Redeploy de EFs afetadas por mudanças em `_shared/` (atualizar checklist do CLAUDE.md se helper novo) · 8. Atualizar docs desta pasta · 9. Resumo da fase (arquivos alterados, riscos, rollback, próxima fase) · 10. Tag git `billing-asaas/fase-N`. **Não avançar com erro.**

> ⚠️ **A tag e a branch têm o mesmo nome — e isso já causou merge errado duas vezes.** `git merge billing-asaas/fase-N` resolve pela **TAG** (que aponta pro commit de fechamento) e ignora silenciosamente qualquer commit feito na branch depois disso. O aviso `refname ... is ambiguous` passa despercebido e o merge "dá certo" faltando código. **Sempre use o ref completo em merge e push:** `git merge refs/heads/billing-asaas/fase-N` · `git push origin refs/heads/...:refs/heads/...`. Depois de mergear, confirme com `git log --oneline main..refs/heads/billing-asaas/fase-N` (tem que sair vazio).

## Feature flags (criadas na Fase 1, todas default OFF)

| Flag | Controla | Ligada na fase |
|---|---|---|
| `asaas_enabled` | Cliente Asaas + webhook aceitando eventos | 2 (sandbox) |
| `billing_provider_default` (`stripe`/`asaas`) | Provedor para NOVAS contratações | 4 |
| `entitlements_enforced` | Guards passam a usar resolveOrgEntitlements | 4 |
| `billing_notifications_dispatch` | Dispatcher de avisos envia de verdade | 4 |
| `whatsapp_implementation_flow` | Fluxo R$750/R$149 visível ao cliente | 5 |
| `zapi_auto_provisioning` | Provisionamento automático de instância | 6 |
| `zapi_auto_disconnect` / `zapi_auto_cancel` | Ações de inadimplência na Z-API | 6 |
| `ai_wallet_enforced` | Gate de saldo bloqueia chamadas LLM | 7 |
| `asaas_card_tokenization_enabled` | Recarga automática de IA | 8 |

Infra: tabela `platform_flags` (key UNIQUE, value jsonb, description, updated_at; FORCE RLS sem policies) + `_shared/platform-flags.ts` (cache 5min, espelho de `stripe-config.ts`) + action em EF de plataforma para o painel. Frontend lê via EF (nunca direto).

---

## FASE 1 — Fundação (entitlements, flags, tipos, migrations base)

**Entregas**
- Migration `platform_flags` + seed das flags OFF.
- Migration `organization_entitlement_overrides` (`organization_id`, `feature` CHECK `system|whatsapp|ai`, `enabled`, `grant_type` CHECK `LIFETIME|TEMPORARY|PROMOTIONAL|MANUAL_OVERRIDE`, `starts_at`, `ends_at`, `reason` NOT NULL, `granted_by`, `revoked_at`, `revoked_by`; índices org/feature/ativos; RLS platform_admin; trigger audit).
- Migration aditiva nas tabelas billing: `billing_plans` += `category` (CHECK das 6 categorias, default `SYSTEM_SUBSCRIPTION`), `provider`, `billing_type` (`recurring|one_time`, default recurring), `amount_credited_cents`, `recommended`, `requires_plan_id`, `provider_metadata jsonb`; `billing_customers` += `provider`, `asaas_customer_id` (UNIQUE parcial); `billing_subscriptions` += `provider`, `provider_subscription_id` (UNIQUE parcial); `billing_invoices` += `provider`, `provider_payment_id` (UNIQUE parcial), `purpose` (`subscription|implementation|ai_topup|other`), `external_reference`, `payload jsonb`; `billing_events` += `provider` (default `stripe`), `provider_event_id` (backfill de `stripe_event_id`), UNIQUE `(provider, provider_event_id)`, `processing_status` (`received|processed|failed|ignored`), `error_message`, `retry_count`. Backfill `provider='stripe'` em linhas existentes.
- `_shared/billing-provider.ts`: interface `BillingProvider` (createCustomer, createCheckout, createOneTimeCharge, createSubscription, updateSubscription, cancelSubscription, getPayment, getSubscription, refundPayment, processWebhook, reconcilePayment) + `StripeBillingProvider` fino delegando ao `stripe-billing.ts` existente (**sem alterar comportamento**).
- `_shared/entitlements.ts`: `resolveOrgEntitlements(orgId)` → `{ system, whatsapp, ai }` com prioridade documentada: 1. bloqueio admin explícito → 2. override vitalício/admin → 3. assinatura paga → 4. trial → 5. sem acesso. Nesta fase é **read-only** (nenhum guard consome ainda).
- Tipos TS em `src/types/billing.ts` (categorias, provider, entitlements) sem mudar UI.

**Testes**: unit (vitest) para prioridade de entitlements (cenários 25/26/27 da spec); validação pós-migration (CHECKs, backfills, RLS FORCE).
**Rollback**: migrations aditivas sem consumidores; reverter EFs não é necessário (nada deployado muda comportamento).

---

## FASE 2 — Cliente Asaas + webhook (Sandbox)

**Entregas**
- `platform_secrets`: estender `VALID_KEYS` com `asaas_api_key`, `asaas_webhook_token` (+ descrições); `_shared/asaas-config.ts` (resolve DB→env `ASAAS_API_KEY`, cache 5min, `ASAAS_ENV`/`ASAAS_BASE_URL` via env: sandbox `https://api-sandbox.asaas.com/v3`, prod `https://api.asaas.com/v3` — **confirmar na doc oficial atual antes de codar**).
- `_shared/asaas.ts`: cliente HTTP central — timeout, tratamento 429, logs sanitizados (`jsonLog` sem payload sensível), request-id de correlação, tipagem das respostas. Funções: customers (create/update/get), checkout, payments (create/get/refund/pixQrCode), subscriptions (create/get/update/delete).
  - ⚠️ **NÃO reusa `_shared/retry.ts`** (o plano original dizia "reusar" — decisão revista na implementação). O `fetchWithRetry` repete erro de rede **incondicionalmente**, sem consultar o `retryOn` ([retry.ts](../../supabase/functions/_shared/retry.ts) — o `catch` volta pro loop direto). Como o Asaas **não tem `Idempotency-Key`** (§11), repetir um `POST /payments` que deu timeout **duplica cobrança real**. Política adotada: **GET** repete em 5xx/429/rede; **POST/PUT/DELETE só repetem em 429** (rejeitado, nada processado). Decisão é função pura testada (`shouldRetryMutation`/`shouldRetryGet`) — quebrar o invariante quebra teste.
  - `/v3/paymentLinks` não implementado: `/v3/checkouts` é o produto certo (sessão por pedido + callback); `paymentLinks` é link reutilizável (§9).
- `AsaasBillingProvider` implementando a interface da Fase 1.
- EF **`asaas-webhook`** (`verify_jwt=false` no config.toml): valida header `asaas-access-token` contra `asaas_webhook_token` (comparação tempo-constante, padrão `security.ts`); persiste em `billing_events` (`provider='asaas'`, UNIQUE anti-replay) **antes** de processar; responde 2xx rápido; processa evento; eventos desconhecidos → `processing_status='ignored'` (nunca 500). Eventos mínimos: `CHECKOUT_PAID/CANCELED/EXPIRED`, `PAYMENT_CREATED/CONFIRMED/RECEIVED/OVERDUE/DELETED/REFUNDED/CHARGEBACK_*`, `SUBSCRIPTION_*` (validar nomes na doc oficial no momento da implementação).
- Worker `process-asaas-reconcile` (novo cron diário `0 7 * * *`, padrão Vault/`x-internal-key`): reprocessa `billing_events` presos (`processing_status IN ('received','failed')`, `retry_count < N`) reclassificando pelo mesmo classificador puro do webhook. ✅ **feito na Fase 2.**
  - ⚠️ **Adiado pra Fase 4 (ver lá):** consulta de payments `PENDING` antigos na API, correção de divergências, alerta ao admin, action admin de reprocessamento manual. Nenhum deles tem sobre o que agir na Fase 2 — nada cria cobrança Asaas ainda (`billing_invoices` não tem linha `provider='asaas'` por construção, pois nenhuma EF consome o `AsaasBillingProvider`). Construir agora seria ramo inexercitável.
- Gate geral: `asaas_enabled` gateia as duas **Edge Functions** (`asaas-webhook`, `process-asaas-reconcile`).
  - ⚠️ **`asaas.ts` e `AsaasBillingProvider` NÃO leem flag** — são bibliotecas sem consumidor. Inerte hoje, mas **nada força o gate quando a Fase 4 ligar `create-billing-checkout` neles**: quem chamar precisa checar a flag no próprio caller.
  - ⚠️ **Falha ao LER a flag ≠ flag OFF.** `checkFlagEnabled` devolve `{enabled, readFailed}`; tratar `readFailed` como OFF descartava evento em silêncio (era finding Critical). O `isFlagEnabled` continua fail-closed pra flag genuinamente ausente.

**Testes**: sandbox — criar customer, cobrança Pix avulsa, assinatura cartão; reenviar webhook duplicado (cenário 7); callback de sucesso sem webhook **não** ativa nada (cenário 8). Unit tests do parse/validação de webhook.
**Rollback**: desligar `asaas_enabled`; `cron.unschedule('asaas-reconcile')`.

---

## FASE 3 — Painel de Planos adaptado + seeds

**Entregas**
- `BillingPlans.tsx`: coluna "Stripe price" → **"Provedor"** + **"Categoria"**; badge "Recomendado"; modal ganha Categoria, Provedor, Valor creditado (só IA), Recomendado, Pré-requisito (`requires_plan_id`), Metadados externos; seção "Stripe Price IDs" vira colapsável "Configuração do provedor (legado Stripe)" visível só quando `provider='stripe'`.
- Coluna "Empresas usando" (count de subscriptions ativas por plano — nova action `list_plans` enriquecida).
- Aposentar na UI o campo legado `organizations.plan` (Empresas.tsx) — badge some do modal de edição (coluna fica no banco).
- **Seeds idempotentes** (migration com `on conflict (slug) do nothing`):
  1. `sistema-reservas` — Sistema de Reservas, R$ 449,00, mensal, `SYSTEM_SUBSCRIPTION`, provider asaas, ativo.
  2. `implementacao-whatsapp` — R$ 750,00, `one_time`, `WHATSAPP_IMPLEMENTATION`.
  3. `instancia-whatsapp` — R$ 149,00, mensal, `WHATSAPP_SUBSCRIPTION`, `requires_plan_id` → implementação.
  4-8. `credito-ia-50/70/100/150/200` — `AI_CREDIT_PACKAGE`, `amount_credited_cents = amount_cents`, R$ 70 com `recommended=true`.
  9. `trial-padrao` — R$ 0, `trial_days=5`, `is_trial=true`, `category='TRIAL'` (respeita UNIQUE parcial de 1 trial ativo; desativar plano trial anterior se existir).
- Trial de 5 dias passa a valer para org nova automaticamente (mecanismo existente de `manage-organizations` já lê o plano trial — sem mudança de código).

**Testes**: rodar seeds 2x (sem duplicar); criar org de teste e verificar `trialing` + `trial_ends_at = +5d` (cenário 1); UI renderiza categorias; typecheck/lint.
**Rollback**: `update billing_plans set active=false` nos seeds; revert do frontend por git.

---

## FASE 4 — Assinatura do sistema via Asaas (R$ 449) + inadimplência 5 dias + notificações reais

**Entregas**
- `create-billing-checkout` (ou nova EF `create-asaas-checkout`) roteando por `billing_provider_default`: valores **sempre do banco** (nunca do request); `externalReference = org:<uuid>|plan:<uuid>|purpose:subscription`; retorno preserva contrato `?session=success` do frontend.
- `asaas-webhook` ativa assinatura: pagamento confirmado → subscription `active` + `organizations.billing_status='active'` + restored_at; **nunca** pela successUrl.
  - ⚠️ **O gate é `PAYMENT_CONFIRMED` OU `PAYMENT_RECEIVED` — o que chegar primeiro**, com idempotência por assinatura/invoice (o cartão manda os dois; ativar duas vezes é bug). **Não** escutar só `CONFIRMED`: teste ao vivo em 18/07/2026 provou que PIX/boleto pula o `CONFIRMED` e vai direto pro `RECEIVED`, então gate só-CONFIRMED deixaria todo cliente de PIX/boleto pagando sem receber acesso — e funcionando no cartão, o que esconde o bug. Evidência e ressalvas em [03 §5](03-ASAAS-API-VERIFICADO.md).
- **Entitlements enforced** (flag): `BillingGuard` e guards server-side (`create-reservation`, `webhook-whatsapp`) passam a consumir `resolveOrgEntitlements`; suspensão de sistema mantém acesso a `/g/:slug/cobranca` (whitelist já existe).
- **`process-asaas-reconcile` — completar a metade adiada da Fase 2** (herdado; sem isto a Fase 2 fica 4 itens curta):
  1. Consultar payments `PENDING` antigos na API (`billing_invoices` com `provider='asaas'`) e corrigir divergências. **Isto é o que recupera evento perdido quando a fila do Asaas é interrompida** (15 falhas consecutivas → eventos apagados em 14 dias, §2 da doc verificada). Enquanto não existir, evento que nunca chegou não é detectado por ninguém.
  2. Alerta ao admin em divergência.
  3. Action admin de reprocessamento manual (idempotente).
  - ⚠️ **`getPayment`/`getSubscription` devolvem o payload CRU do Asaas — dinheiro em REAIS, não centavos** (assimetria documentada no header de `billing-provider.ts`; a Stripe devolve centavos na mesma interface). Comparar com `amount_cents` sem converter é bug de 100x. Usar `asaasValueToCents` (já existe e está testado, sem call site até aqui).
- Workers adaptados: `process-billing-overdue` → `GRACE_PERIOD_DAYS=5`, suspensão **D+6**, por serviço (`grace_period_started_at/ends_at`, `overdue_at`, `suspended_at`, `restored_at` — colunas novas aditivas em `billing_subscriptions` ou tabela `billing_delinquency`); `process-billing-reminders` → cadência D+1/D+3/D+5 com dedupe UNIQUE `(organization_id, event_type, billing_cycle)`.
- **Dispatcher de notificações** (novo worker `process-billing-notifications`, flag `billing_notifications_dispatch`): consome `billing_notifications.status='pending'` → Resend (`_shared/email.ts`) + registro in-app; `manage-organizations` passa a gravar `billing_email` na criação (input novo no form de Empresas); nunca usar canal WhatsApp da própria org inadimplente.
- Templates: trial iniciado/terminando/encerrado, pagamento pendente, D+1, D+3, D+5, suspenso, regularizado.
- Regularização: `invoice.paid`/`PAYMENT_RECEIVED` → restaurar por serviço + notificar (cenários 5, 15).

**Testes**: cenários 1-8, 13-15, 17 da spec (sandbox + unit tests de cálculo de datas em BRT — usar util estilo `getTodayBrtParts`).
**Rollback**: desligar `entitlements_enforced` + `billing_notifications_dispatch` + `billing_provider_default='stripe'`; workers voltam às constantes antigas por deploy do commit anterior.

---

## FASE 5 — Implementação WhatsApp (R$ 750) + mensalidade da instância (R$ 149)

**Entregas**
- Migration `whatsapp_implementations` (org, payment ref, status CHECK `NOT_REQUESTED|PAYMENT_PENDING|PAYMENT_CONFIRMED|SCHEDULED|IN_PROGRESS|WAITING_CUSTOMER|COMPLETED|CANCELED`, responsável, datas, observações; RLS platform_admin + leitura owner/gerente via EF; audit trigger).
- Migration `billing_orders` + `billing_order_items` (carrinho interno; 1 order → N cobranças Asaas).
- EF de checkout da implementação (cobrança única Pix/cartão, `purpose='implementation'`); webhook marca `PAYMENT_CONFIRMED` → **notifica admin** → admin conduz status manualmente no painel novo "Implementações" (dentro de `/platform/billing/*`).
- Checkout da instância (R$ 149 recorrente) **só liberado** quando implementação `COMPLETED` + entitlement system ativo (validação server-side; front só esconde).
- Painel cliente (`Cobranca.tsx`): cards Sistema / Automação WhatsApp (preços visíveis ANTES de pagar, ações bloqueadas com a mensagem exata da spec §14.1) / resumo consolidado (R$ 449 + R$ 149 = R$ 598 + IA variável).
- Ciclos independentes: inadimplência da instância suspende só WhatsApp (entitlement `whatsapp`), sistema segue (cenário 16); inadimplência do sistema suspende dependentes (cenário 17).

**Testes**: cenários 9, 10, 11, 12, 16, 17.
**Rollback**: desligar `whatsapp_implementation_flow` (cards somem, checkouts negados server-side); migrations ficam (aditivas).

---

## FASE 6 — Integração Z-API (ciclo de vida da instância)

**Pré-requisito de negócio**: confirmar acesso ao programa de parceiro/integrador Z-API, token, endpoints e ambiente de teste **na documentação oficial atual** — não implementar de memória. Sem parceria confirmada, a fase vira fluxo manual assistido (admin provisiona, sistema rastreia estados).

**Entregas**
- Migration `whatsapp_instances` (org/unit, `channel_id` FK opcional → `whatsapp_channels`, FSM CHECK com os 16 estados da spec §8.1, tokens **criptografados** (pgcrypto app-side), `paid_until`, `suspended_at`, `disconnect_requested_at/confirmed_at`, `cancellation_requested_at/effective_at`, `provider_billing_end_at`, `provider_response jsonb`, `last_synced_at`; FORCE RLS).
- `_shared/zapi-partner.ts`: createInstance, subscribeInstance, unsubscribeInstance, disconnectInstance, getInstanceStatus, getQrCode, listInstances, syncInstance, validateCredentials — partner token via `platform_secrets`.
- Provisionamento pós-pagamento (webhook da mensalidade paga → `PROVISIONING` → grava credenciais → cria/associa `whatsapp_channels` → `WAITING_QR_CODE`); UI de QR code com polling no painel do cliente.
- Inadimplência D+6 da instância: suspender automações internamente (pausar sem perder jobs), desconectar (flag `zapi_auto_disconnect`), solicitar cancelamento (flag `zapi_auto_cancel`), registrar todos os timestamps, avisar admin+cliente. **Nunca deletar a instância do banco.**
- Reativação segura (validar status real no provedor antes; sem parceria de "des-cancelamento" confirmada → tarefa administrativa).
- Worker `process-zapi-sync` (cron): sincroniza status real, alerta divergências.

**Testes**: cenários 28, 29; simulação de FSM em unit tests; sandbox/instância autorizada apenas.
**Rollback**: flags `zapi_*` OFF (fluxo volta a manual); worker unschedule.

---

## FASE 7 — Carteira de IA (ledger + medição + bloqueio)

**Pré-requisito**: decisão §10.3 da auditoria (chave da plataforma vs BYOK) confirmada pelo administrador.

**Entregas**
- Migrations: `ai_wallets` (1/org, UNIQUE `organization_id`, `balance_cents` cache, `low_balance_threshold_cents`, status); `ai_wallet_transactions` (ledger imutável: type CHECK com os 11 tipos da spec §6, `amount_cents`, `balance_before/after`, `idempotency_key` UNIQUE, refs payment/usage; **sem UPDATE/DELETE** — revogar via policy/trigger); `ai_usage_events` (org, unit, provider, modelo real usado, 4+2 campos de token incl. thinking, custo provider USD, taxa de conversão, custo BRL, request_id, status, erro, sem TTL); `ai_model_prices` (versionada: provider, model, preços por Mtok input/output/cached/thinking, currency, `effective_from/until`, active — consumo antigo nunca recalculado).
- `ai-providers.ts`: capturar `reasoning_tokens` (OpenAI) e `thoughtsTokenCount` (Gemini); expor **modelo realmente usado** (fallback flash→pro) via callback/retorno estruturado.
- `webhook-whatsapp`: gate de saldo espelhando o gate de billing (`:1204-1216`) — sem saldo → outcome `insufficient_ai_credits` + mensagem amigável da spec §6.2 + skip do LLM (sistema segue funcionando — cenário 19); pós-execução → INSERT `ai_usage_events` + débito atômico via RPC `SECURITY DEFINER` com lock de linha (`FOR UPDATE`) e `idempotency_key = request_id` (cenário 21: chamadas concorrentes não gastam o mesmo saldo). Reserva/estimativa antes + consolidação depois (RESERVATION/RESERVATION_RELEASE).
- Recarga manual: checkout Asaas dos pacotes (`purpose='ai_topup'`); webhook credita via ledger TOPUP com `idempotency_key = provider_payment_id` (cenários 6, 20, 24 — refund/chargeback debitam via REFUND/CHARGEBACK).
- Painel cliente (visão simples + detalhes técnicos expansível) e painel admin IA (§13.4 da spec: crédito/débito manual com motivo → audit_log, ledger, bloquear/liberar); alertas 30%/10%/zerado com dedupe.
- Redeploy: `ai-providers.ts` muda → redeploy `webhook-whatsapp` + `manage-ai-providers` (checklist CLAUDE.md).

**Testes**: cenários 18-21, 24, 26, 27.
**Rollback**: `ai_wallet_enforced` OFF (medição continua, bloqueio/débito param); ledger preservado.

---

## FASE 8 — Recarga automática de IA

**Entregas**: `ai_auto_recharge_settings` (spec §7); verificação real da tokenização/autorização reutilizável do Asaas na conta de produção **antes** de expor UI; flag `asaas_card_tokenization_enabled` OFF esconde/desabilita a opção com mensagem clara; lock de recarga (1 pendente por vez, estado "Recarga em processamento"), cooldown pós-falha, aviso + fallback manual (cenários 22, 23); alternativa "Pacote mensal de IA" (assinatura recorrente) se tokenização não for viável. Distinção explícita recarga-por-saldo × renovação mensal.
**Rollback**: flag OFF.

---

## FASE 9 — Cortesias e acessos vitalícios

**Entregas**: UI admin de `organization_entitlement_overrides` (conceder por feature, tipos LIFETIME/TEMPORARY/PROMOTIONAL/MANUAL_OVERRIDE, motivo obrigatório, audit); alerta de custo ao conceder WhatsApp grátis ("Esta empresa poderá gerar custo mensal de Z-API para a plataforma" + confirmação) e IA grátis (crédito inicial / limite mensal patrocinado / recarga manual admin / ilimitado só com confirmação explícita); worker de expiração de overrides `TEMPORARY` (fecha gap R9); webhooks financeiros **nunca** sobrescrevem overrides (guard nos handlers); **conceder LIFETIME às orgs reais atuais (Moralles, Ren Sushi) ANTES de ligar enforcement completo** (fecha R2); migrar semanticamente `billing_access_overrides` (grant_access→override system MANUAL_OVERRIDE) mantendo a tabela antiga read-only.
**Testes**: cenários 25, 26, 27.
**Rollback**: overrides são dados; desativar via `revoked_at`.

---

## FASE 10 — Migração/cutover da Stripe

Estado real: **1 org de teste** com assinatura cancelada e 1 invoice aberta; 2 orgs reais sem Stripe. Cutover:
1. `billing_provider_default='asaas'` (novas contratações já são Asaas desde a Fase 4).
2. Void da invoice aberta do "Seu Japa Teste" (ou quitação de teste); marcar org como teste/cancelada.
3. Conferir por 1 ciclo que `process-billing-reconcile` (Stripe) não encontra atividade.
4. Congelar Stripe como read-only: manter `stripe-webhook` deployado (caução compartilha o endpoint), desativar crons Stripe-billing (`billing-reconcile` antigo) — **sem apagar código, colunas ou tabelas**.
5. Documentar data de corte + histórico.
Se surgirem clientes Stripe reais antes desta fase: jornada de migração da spec §16 (checkout Asaas → confirmação → cancelar Stripe `cancel_at_period_end` — nunca dupla mensalidade no mesmo período; cartões Stripe **não** são migráveis).
**Testes**: cenário 30 (legados seguem funcionando durante transição).
**Rollback**: religar `billing_provider_default='stripe'` + crons.

---

## FASE 11 — Produção

Revisão de segurança (checklist §19 da spec: valores sempre do banco, validação externalReference/org/ambiente, rate limit no webhook, sanitização de logs, criptografia Z-API); troca Sandbox→Produção do Asaas (chaves via painel `/platform/automacao`, `ASAAS_ENV=production`); cadastro dos webhooks no painel Asaas (documentar); E2E dos fluxos principais; monitoramento (outcomes novos no painel Diagnóstico, alertas admin); ativação gradual por flag; observação pós-deploy; documentação final (runbook de incidentes, troubleshooting, como reprocessar evento/corrigir crédito duplicado/suspender/restaurar/cancelar instância/agir com Z-API fora do ar).

---

## Mapa dos 30 cenários de teste obrigatórios → fase

| Cenários | Fase |
|---|---|
| 1-8 (trial, suspensão, ativação, idempotência, webhook) | 3-4 |
| 9-12 (implementação/instância) | 5 |
| 13-17 (inadimplência/tolerância/por-serviço) | 4-5 |
| 18-21, 24 (carteira IA, concorrência, refund) | 7 |
| 22-23 (auto-recarga) | 8 |
| 25-27 (overrides/vitalício) | 1, 9 |
| 28-29 (Z-API cancelamento/falha) | 6 |
| 30 (legado Stripe durante migração) | 10 |

## Variáveis de ambiente / secrets novos

- `platform_secrets` (painel): `asaas_api_key`, `asaas_webhook_token`, `zapi_partner_token` (Fase 6).
- `supabase secrets`: `ASAAS_ENV`, `ASAAS_BASE_URL` (opcional, default por env), URLs de retorno (`ASAAS_SUCCESS_URL` etc. — ou derivadas da origem, como hoje).
- **Nunca** `VITE_*` para nada disso; nunca commitar valores (regras de segurança do CLAUDE.md).

## Decisões do administrador — RESOLVIDAS em 2026-07-16

1. **Modelo da chave de IA: PLATAFORMA por padrão, com BYOK selecionável por unit.** O admin troca o modo facilmente no painel. Implicação de design (Fase 7): coluna `key_source` (`platform`|`byok`) na config de IA da unit; chaves da plataforma vivem em `platform_secrets` (`platform_ai_key_<provider>`); `resolveApiKey` resolve por modo; **carteira só debita quando `key_source='platform'`** (BYOK = custo do cliente, sem débito); toggle no painel `/platform/automacao/<slug>` com aviso de custo ao mudar para `platform`.
2. **Parceria Z-API**: guia passo a passo em [02-ZAPI-PARCEIRO.md](02-ZAPI-PARCEIRO.md). Fase 6 só automatiza após o token de integrador definitivo existir; até lá, fluxo manual-assistido.
3. **Preços/seeds confirmados**: R$ 449 / R$ 750 / R$ 149 / pacotes IA 50-200 com R$ 70 recomendado; trial 5 dias.
4. **Moralles e Ren Sushi: acesso vitalício gratuito (LIFETIME em system+whatsapp+ai) e IA em modo BYOK.** Overrides concedidos na Fase 1 (tabela já existe a partir dela) — não esperam a Fase 9. Sem carteira/débito para elas.
5. Caução Stripe Connect: congelada (sem uso em produção, fora do escopo).
