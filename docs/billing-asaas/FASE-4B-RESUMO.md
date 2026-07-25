# FASE 4B (enxuta) — Inadimplência: acesso desliga + notificações — Resumo de Execução

> Branch `billing-asaas/fase-4b`, base `d8081aa` (main pós-4a).
> Spec: [../superpowers/specs/2026-07-19-billing-asaas-fase-4b-design.md](../superpowers/specs/2026-07-19-billing-asaas-fase-4b-design.md).
> Plano: [../superpowers/plans/2026-07-19-billing-asaas-fase-4b.md](../superpowers/plans/2026-07-19-billing-asaas-fase-4b.md).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing
>
> **Código completo, revisado, aplicado e VALIDADO em sandbox (7 tasks + deploy + validação ao vivo B1–B5, em 2026-07-25).** A flag `billing_notifications_dispatch` está de volta **OFF** (fila acumula, nada é enviado) até a decisão de go-live. **Go-live de PRODUÇÃO segue DEFERIDO para a última fase do projeto.**
>
> | | |
> |---|---|
> | Pipeline de código (Tasks 1–7) | ✅ completo, cada task revisada; 4 exigiram 1 ciclo de fix |
> | `npm test` | ✅ **229/229** (era 221 na 4a; +8 no núcleo puro) |
> | `npm run typecheck` (`tsc -b`) | ✅ 0 erros |
> | Migrations `068` (ciclo/restored_at) e `069` (cron dispatcher) | ✅ **aplicadas via `db push`, sem drift** (`version = filename`; cron `*/5` agendado) |
> | Deploy das 6 Edge Functions | ✅ **deployadas** (overdue, reminders, notifications, asaas-webhook, asaas-reconcile, manage-billing) |
> | Validação sandbox B1–B5 | ✅ **passou** — grace D+1, blocked+suspended D+6, recipient org-scoped, override vitalício intacto, dispatcher enviou 2 e-mails reais |
> | Regularização B6 (PAYMENT_RECEIVED → active + restored_at) | ⏳ **não testada ao vivo** — exige pagamento real no checkout sandbox Asaas; código deployado e revisado |
> | Flag `billing_notifications_dispatch` | 🔒 de volta OFF pós-validação — ligar só na decisão de go-live |

---

## Escopo entregue (4b enxuta)

*"O dinheiro NÃO entra → o acesso desliga e o cliente é avisado."*

1. **Detecção de atraso** — `process-billing-overdue`: `grace_period` (D+1…D+5) → `blocked` (D+6). `GRACE_PERIOD_DAYS=5`, `BLOCK_AFTER_DAYS=6`.
2. **Lembretes** — `process-billing-reminders`: cadência D0/D+1/D+3/D+5.
3. **Dispatcher de e-mail real** — `process-billing-notifications` (novo): consome a fila `billing_notifications` `pending` → Resend; gated por `billing_notifications_dispatch`.
4. **Regularização** — `applyAsaasEvent`: pagamento de org atrasada → `active` + `restored_at` + aviso `regularized`.
5. **Respeito ao override vitalício** — overdue e reminders pulam orgs com `organization_entitlement_overrides` (`feature='system'`) ativo.
6. **FIX do vazamento cross-tenant** — `resolveBillingRecipient` escopa o fallback de owner por org (units→unit_members). O código antigo pegava o owner mais antigo da plataforma.

**Fora de escopo (4c / fases seguintes):** enforcement de entitlements por-feature, completar o reconcile (consulta de `PENDING`/alerta admin/reprocesso manual), correlação de renovação por `provider_subscription_id`, e-mails de trial, UI in-app de avisos.

## Arquitetura

Três produtores enfileiram `billing_notifications` (`status='pending'`); um consumidor envia. Dedupe **DB-enforced** por UNIQUE parcial `(organization_id, event_type, invoice_id) WHERE invoice_id IS NOT NULL` → todo insert é `.insert()` tratando `23505` como no-op (padrão voucher). Lógica pura (datas BRT, máquina de estados, seleção de destinatário) num módulo `_shared/billing-delinquency-core.ts` de zero imports, testado por vitest a partir de `src/`.

```
process-billing-reminders  ─┐  (payment_pending/overdue_d1/d3/d5, por offset de due_date)
process-billing-overdue    ─┤─→ billing_notifications (pending) ──→ process-billing-notifications ──→ Resend
applyAsaasEvent (restore)  ─┘  (regularized na volta pra active)        (flag billing_notifications_dispatch)
```

## Arquivos

**Criados:** `_shared/billing-delinquency-core.ts` (+ `src/lib/billing-delinquency-core.test.ts`), `_shared/billing-notify.ts`, `process-billing-notifications/index.ts`, migrations `068`/`069`.
**Modificados:** `process-billing-overdue`, `process-billing-reminders`, `_shared/asaas-billing-events-apply.ts`, `config.toml`, `CLAUDE.md`.

## Commits (Tasks 1–7)

`4843e45` núcleo puro · `2836f67` migration 068 · `43e8352`+`72ea1bf` helper billing-notify (+fix starts_at) · `53cb7cf`+`96fa65b` overdue (+fix update-error) · `f25c6c2` reminders (fix vazamento) · `0f201b4`+`5f495d3` dispatcher (+fix select/update errors) · `6c10727`+`d27c895` regularização (+fix prevOrg error).

## Decisões (aprovadas 2026-07-19)

1. Terminal = `blocked` (reuso de `blocked_at`/`blocked_reason`), não `suspended` novo — suspensão por-serviço é Fase 5.
2. Cadência `payment_pending(D0)`+`overdue_d1/d3/d5`+`suspended(D+6, state-change)`+`regularized(evento)`; sem D-3.
3. Dedupe via `invoice_id` + UNIQUE parcial, insert-on-conflict-nothing.
4. In-app = só o registro `billing_notifications`; UI cliente-facing deferida.
5. Day-math em BRT nos workers (núcleo puro testado).
6. Overdue/reminders pulam LIFETIME `organization_entitlement_overrides` (system).
7. Fix do blocker = fallback de owner escopado por org.

## Riscos residuais / follow-ups (4c+)

1. **Renovação mês 2+ sem `checkoutSession`** — correlação por `provider_subscription_id` (herdado da 4a; antes do 1º ciclo real ~30d).
2. **`regularized` com `invoiceId=null` no caminho de renovação** — o aplicador insere uma `billing_invoice` nova no branch `else` sem reatribuir a var `invoice`, então o aviso `regularized` de uma renovação vai sem `invoice_id` → o índice parcial não deduplica → sob double-delivery **concorrente** pode mandar 2 e-mails "voltou". Baixo impacto (template `regularized` não usa dado de invoice; entrega sequencial já protege o caso não-concorrente; enqueue best-effort). Corrigir reatribuindo `invoice` ao row inserido.
3. **Reconcile incompleto** (consulta de `PENDING`, alerta admin, reprocesso manual) — rede de segurança do webhook; vira bloqueante com o gate de go-live da Fase 11.
4. **Enforcement de entitlements por-feature** — necessário pra Fase 5 (suspensão por-serviço).
5. **Dispatcher sem lock de sobreposição** e **`orgName` interpolado em HTML sem escape** — Minors registrados (baixo risco: `*/5`/lote 20; e-mail só vai pro próprio contato da org).
6. **Queries sem `.range()`** em overdue/reminders (trunca >1000) — débito herdado; irrelevante na base atual (1 cliente vitalício).

## Deploy + validação em sandbox — ✅ FEITO (2026-07-25)

> Go-live de PRODUÇÃO segue **DEFERIDO para a última fase** (decisão 2026-07-19, ver [FASE-4A-RESUMO.md](FASE-4A-RESUMO.md)). O que foi feito aqui é validação em **sandbox** — Resend NÃO é sandbox, os e-mails foram reais (caixa de teste do operador).

1. ✅ **`supabase db push`** — `068` e `069` aplicadas (por outro agente); conferido **sem drift** (`version = filename` em `schema_migrations`), cron `billing-notifications` `*/5` agendado.
2. ✅ **Deploy das 6 Edge Functions** — `process-billing-overdue`, `process-billing-reminders`, `process-billing-notifications`, `asaas-webhook`, `process-asaas-reconcile`, `manage-billing`. **Era o buraco real:** as migrations tinham sido aplicadas, mas as EFs não — `process-billing-notifications` sequer existia (cron `*/5` batia em 404) e overdue/reminders estavam na versão de maio.
3. ✅ **Validação ao vivo** com "Seu Japa Teste" (`billing_email` real, org `3b68d8b5-4b31-4295-a1c8-615bf5fb9847`):
   - **B1** invoice `due_date = today-1` → org `grace_period` (day-math BRT correto). ✅
   - **B2** `reminders` → `overdue_d1` enfileirado, recipient = `billing_email` **da própria org** (org-scoped, sem vazamento cross-tenant). ✅
   - **B3** invoice `due_date = today-6` → org `blocked` + `blocked_at`/`blocked_reason` + `suspended` enfileirado. ✅
   - **B4** override vitalício (LIFETIME `system`) + invoice D+6 → org **permaneceu `active`**, não bloqueou nem avisou. ✅
   - **B5** `billing_notifications_dispatch=true` → dispatcher enviou os 2 avisos (`status='sent'` 15:50 BRT), Resend aceitou → **2 e-mails reais**. ✅
   - **B6** regularização (`PAYMENT_RECEIVED` → `active` + `restored_at` + `regularized`) — ⏳ **não testada ao vivo**; exige pagamento real no checkout sandbox Asaas (forjar o webhook exigiria token + payment id resolvível). Código deployado e revisado.
   - Limpeza feita e conferida: 0 invoices/notifications/overrides de teste restantes; Seu Japa de volta `active` (sem `blocked_at`); `billing_notifications_dispatch` de volta OFF; `asaas_enabled` intacto.
4. ✅ Tag anotada `billing-asaas/fase-4b` criada no commit de merge `d656b94` (validação passou).

## Rollback

`billing_notifications_dispatch` OFF (nada é enviado; fila só acumula) + reverter os workers pelo commit anterior (constantes de timeline voltam a 3/4). Migrations são aditivas — ficam.

## Próxima fase

**FASE 5 — Implementação WhatsApp (R$ 750) + mensalidade da instância (R$ 149)** + suspensão **por serviço** (exige enforcement de entitlements por-feature, deixado como follow-up da 4b).
