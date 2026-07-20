# FASE 4B (enxuta) — Inadimplência: acesso desliga + notificações — Resumo de Execução

> Branch `billing-asaas/fase-4b`, base `d8081aa` (main pós-4a).
> Spec: [../superpowers/specs/2026-07-19-billing-asaas-fase-4b-design.md](../superpowers/specs/2026-07-19-billing-asaas-fase-4b-design.md).
> Plano: [../superpowers/plans/2026-07-19-billing-asaas-fase-4b.md](../superpowers/plans/2026-07-19-billing-asaas-fase-4b.md).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing
>
> **Código completo e revisado (7 tasks, cada uma com review spec+qualidade). NADA aplicado ainda — `db push` e deploy são do usuário (abaixo).** A flag `billing_notifications_dispatch` fica **OFF** até a validação em sandbox passar.
>
> | | |
> |---|---|
> | Pipeline de código (Tasks 1–7) | ✅ completo, cada task revisada; 4 exigiram 1 ciclo de fix |
> | `npm test` | ✅ **229/229** (era 221 na 4a; +8 no núcleo puro) |
> | `npm run typecheck` (`tsc -b`) | ✅ 0 erros |
> | `deno check` nos arquivos Deno novos/alterados | ✅ limpo |
> | Migrations `068` (ciclo/restored_at) e `069` (cron dispatcher) | 📄 **arquivos commitados, `db push` NÃO rodado** |
> | Deploy das Edge Functions | ❌ **pendente — usuário** |
> | Flag `billing_notifications_dispatch` | 🔒 OFF (seed Fase 1) — ligar só após validar |

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

## Deploy + validação em sandbox (PENDENTE — usuário)

> Go-live de PRODUÇÃO segue **DEFERIDO para a última fase** (decisão 2026-07-19, ver [FASE-4A-RESUMO.md](FASE-4A-RESUMO.md)). Isto aqui é validação em **sandbox** — Resend NÃO é sandbox, use uma caixa de teste real.

1. **`supabase db push`** — aplica `068` e `069` (`--dry-run` antes; confirmar sem drift).
2. **Deploy das Edge Functions** (6 — os 3 workers + os consumidores do `_shared/asaas-billing-events-apply.ts` alterado):
   ```
   supabase functions deploy process-billing-overdue
   supabase functions deploy process-billing-reminders
   supabase functions deploy process-billing-notifications
   supabase functions deploy asaas-webhook
   supabase functions deploy process-asaas-reconcile
   supabase functions deploy manage-billing
   ```
3. **Validar ao vivo** com a org "Seu Japa Teste" (`past_due`, sem overrides), `billing_email` = caixa de teste real:
   - `due_date = today-1` → org `grace_period`; `overdue_d1` enfileirado.
   - `due_date = today-6` → org `blocked` + `suspended` enfileirado.
   - Ligar `billing_notifications_dispatch=true` → dispatcher envia (conferir a caixa) e marca `sent`.
   - Simular `PAYMENT_RECEIVED` → org `active` + `restored_at` + `regularized`.
   - **Vazamento:** org sem `billing_email` → destinatário é o owner **daquela** org, nunca de outra.
   - **Override:** Ren Sushi (LIFETIME system) com invoice forçada vencida → NÃO bloqueia, NÃO avisa.
   - Desligar `billing_notifications_dispatch` de volta se ainda não for pra deixar ligado.
4. Tag `billing-asaas/fase-4b` só após a validação passar (usar ref completo no merge: `refs/heads/billing-asaas/fase-4b`).

## Rollback

`billing_notifications_dispatch` OFF (nada é enviado; fila só acumula) + reverter os workers pelo commit anterior (constantes de timeline voltam a 3/4). Migrations são aditivas — ficam.

## Próxima fase

**FASE 5 — Implementação WhatsApp (R$ 750) + mensalidade da instância (R$ 149)** + suspensão **por serviço** (exige enforcement de entitlements por-feature, deixado como follow-up da 4b).
