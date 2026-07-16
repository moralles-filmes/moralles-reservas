# FASE 1 — Fundação: Resumo de Execução

> Concluída em 2026-07-16. Migrations aplicadas em produção via `supabase db push`. Nenhum comportamento em produção mudou (tudo atrás de flags OFF / módulos ainda sem consumidores).

## Entregue

**Migrations (aplicadas + validadas):**
- `20260716130000_061_platform_flags.sql` — tabela `platform_flags` (FORCE RLS) + seed das 10 flags, todas OFF.
- `20260716130100_062_entitlement_overrides.sql` — `organization_entitlement_overrides` (FORCE RLS + policy platform_admin `TO authenticated` + trigger de auditoria) + seed LIFETIME (system/whatsapp/ai) para **Moralles** e **Ren Sushi** (decisão do admin; fecha o risco R2).
- `20260716130200_063_billing_provider_columns.sql` — colunas multi-provider aditivas em `billing_plans` (category/provider/billing_type/amount_credited_cents/recommended/requires_plan_id/provider_metadata), `billing_customers` (asaas_customer_id), `billing_subscriptions` (provider/provider_subscription_id), `billing_invoices` (provider/provider_payment_id/purpose/external_reference/payload), `billing_events` (provider/provider_event_id UNIQUE composto/processing_status/error_message/retry_count; `stripe_event_id` perdeu NOT NULL). Backfills `provider='stripe'` conferidos.

**Módulos `_shared` (nenhuma EF importa ainda — zero redeploy):**
- `platform-flags.ts` — resolver de flags, cache 5min, fail-closed (ausente = OFF).
- `billing-provider.ts` — interface `BillingProviderPort` + `StripeBillingProvider` (adapter fino sobre `stripe-billing.ts`); `getBillingProvider("asaas")` lança erro até a Fase 2.
- `entitlements-core.ts` — resolução PURA de entitlements (sem Deno/supabase-js), testável no vitest.
- `entitlements.ts` — `resolveOrgEntitlements(supabase, orgId)` carrega dados e delega ao core. Read-only; nenhum guard consome até a Fase 4.

**Frontend:** tipos aditivos em `src/types/billing.ts` (PlanCategory, BillingProviderName, EntitlementFeature/GrantType, `OrganizationEntitlementOverride`, campos opcionais em `BillingPlan`). Nenhuma UI alterada.

**Testes:** `src/lib/entitlements-core.test.ts` — 18 testes cobrindo a prioridade 1-5 e os cenários 25/26/27 (+ parcial 19) da spec. Fix de teste pré-existente desatualizado em `useReservas.test.ts` (`organization_id` no sentinela do customer).

**Docs:** decisões do admin registradas no plano; guia [02-ZAPI-PARCEIRO.md](02-ZAPI-PARCEIRO.md).

## Verificação (checklist de fim de fase)

| Item | Resultado |
|---|---|
| `npm run lint` | 0 erros (22 warnings pré-existentes, nenhum novo) |
| `npm run typecheck` | 0 erros |
| `npm run test` | **56/56** |
| `npm run build` | OK |
| `supabase db push` | 3 migrations aplicadas, dry-run limpo (sem drift) |
| Validação pós-migration | 10 flags OFF · 6 overrides LIFETIME (Moralles, Ren Sushi) · backfills ok · FORCE RLS ok |

## Riscos desta fase

- **Nenhum comportamento mudou** — flags OFF, módulos sem consumidores. Risco residual: alguém importar `_shared/platform-flags.ts`/`entitlements.ts` numa EF sem redeploy consciente (mitigado: aviso no header de cada módulo).
- O painel atual de planos ainda não conhece as colunas novas — planos criados por ele até a Fase 3 nascem com defaults (`category=SYSTEM_SUBSCRIPTION`, `provider=stripe`), o que é correto para o mundo atual.

## Rollback

- Flags: já OFF (nada a desligar).
- Módulos: sem consumidores — deletar arquivos basta (ou ignorar).
- Migrations: aditivas; NÃO reverter colunas (dados novos são inertes). Se necessário desfazer o seed de overrides: `update organization_entitlement_overrides set revoked_at = now() where grant_type='LIFETIME' and reason like '%cliente fundador%';`
- Teste corrigido (`useReservas.test.ts`): manter — refletia código atual.

## Próxima fase

**FASE 2 — Asaas Sandbox**: `_shared/asaas-config.ts` + `_shared/asaas.ts` (cliente HTTP), `AsaasBillingProvider`, EF `asaas-webhook` (verify_jwt=false + token no header + persistência idempotente em `billing_events`), worker `process-asaas-reconcile`, extensão de `VALID_KEYS` em `manage-platform-secrets` (`asaas_api_key`, `asaas_webhook_token`). Pré-requisito do admin: criar conta Sandbox no Asaas e gerar a API key de sandbox.
