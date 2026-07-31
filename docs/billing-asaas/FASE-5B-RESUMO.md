# FASE 5B — Enforcement por serviço de WhatsApp — Resumo de Execução

> Branch `billing-asaas/fase-5b`, base `46b8a6b` (plano + spec, sem código). 53 commits sobre `main`: implementação (`c63c9b8`..`5ff1852`), fechamento (`d81469a`, `4a9a753`), fix da revisão whole-branch (`fca0379`, `b9a5947`), registro de riscos (`fd5619e`) e fix dos gates de segurança (`433f5fa`).
> Spec: [../superpowers/specs/2026-07-27-billing-asaas-fase-5b-design.md](../superpowers/specs/2026-07-27-billing-asaas-fase-5b-design.md).
> Plano: [../superpowers/plans/2026-07-27-billing-asaas-fase-5b.md](../superpowers/plans/2026-07-27-billing-asaas-fase-5b.md).
> Fase anterior: [FASE-5A-RESUMO.md](FASE-5A-RESUMO.md) (vendeu implantação R$750 + assinatura R$149 da instância, sem poder suspender ninguém — esta fase existe pra fechar exatamente essa lacuna).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing/WhatsApp
>
> **Migrations aplicadas e Edge Functions deployadas em 2026-07-30. As duas flags da fase seguem OFF, então o comportamento novo está dormente.** O roteiro de sandbox (44 blocos) continua **não executado** — bloqueado por falta de fixture e pela decisão de ligar as flags, que é do dono. Sem sandbox, **não há merge nem tag**. A virada do Asaas segue em sandbox até a última fase do projeto (`ASAAS_ENV=sandbox`, confirmado).
>
> ### Rollout operacional de 2026-07-30
>
> Ordem efetiva de migrations: **076 → 085 (hotfix de ACL, 18:36 UTC) → 077–084 (20:01 UTC, `db push --include-all`)**. O `--include-all` foi necessário porque a 085 tem timestamp posterior às 077–084; o ensaio em clone do schema real validou essa ordem antes.
>
> Reauditoria de ACL depois da 084: `anon` em 11 funções, `authenticated` em 21, SECURITY DEFINER expostas em 10, não-trigger com grant a PUBLIC em 0 — **idênticos ao pós-085**, ou seja, nenhuma migration da 5b reabriu superfície. Guardrail verde contra produção. As funções novas da 082/083 nasceram fechadas; a 079 preservou o ACL de `resolve_or_activate_subscription`; a 084 ficou no-op idempotente.
>
> 26 Edge Functions redeployadas (as 19 com código próprio alterado + 7 que entram só por `_shared`), `manage-channels` por último conforme o Risco 8. Os 2 workers novos têm `verify_jwt=false` no `config.toml` e crons ativos como `postgres`.
>
> ### Por que o sandbox não rodou
>
> 1. **Não existe fixture.** O §0.1.1 do roteiro exige uma org com implantação `COMPLETED` e assinatura `WHATSAPP_SUBSCRIPTION` ativa, e proíbe usar `ren-sushi` (override vitalício) e `moralles` (a própria plataforma). O banco tem **zero implantações abertas e zero assinaturas vivas** em qualquer org. A terceira org (`seu-japa`) não tem nada. Construir a fixture exige rodar antes o B1→B10 da **5a**.
> 2. **Não há org legada disponível.** Os cenários C19–C22, C24e e C24j precisam de uma org com `whatsapp_legacy_grandfathered=true`; a única é `ren-sushi`, que o roteiro proíbe usar.
> 3. **O roteiro exige ligar as duas flags** (§0.2, passos 3 e 6) — decisão do dono, deferida para a virada final.
>
> | | |
> |---|---|
> | Pipeline de código (24 tasks + fechamento) | ✅ completo, cada task revisada; a maioria exigiu 1–2 ciclos de fix |
> | Revisão whole-branch (modelo mais capaz, 63 arquivos) | ✅ **changes requested → corrigido → re-revisão APROVADA** |
> | `npm test` | ✅ **423/423** (baseline no início da fase era 265; +158 nesta fase: 5 núcleos puros novos) |
> | `npm run typecheck` (`tsc -b`) | ✅ 0 erros |
> | `npm run lint` | ✅ 0 erros, 22 warnings (pré-existentes, baseline inalterada) |
> | Migrations 077, 078, 079, 080, 082, 083, 084 (082/083 são os crons dos 2 workers novos; 084 é o fix de segurança dos gates) | ✅ **aplicadas em produção** 2026-07-30 20:01 UTC, com `--include-all`, depois da 085 |
> | Deploy das Edge Functions afetadas | ✅ **26 deployadas** 2026-07-30, `manage-channels` por último (Risco 8 respeitado) |
> | Gates `saas-shield-br` (os 6) | ✅ **rodados** — 5 PASS; `rls-auditor` FAIL com 1 bloqueante P1, **corrigido na migration 084**. Detalhe e achados abertos na seção "Gates de segurança" |
> | Roteiro de sandbox (44 blocos, C1–C31 com sub-itens) | 📝 **escrito, NÃO executado** — bloqueado por falta de fixture (exige o B1→B10 da 5a) e pela ativação das flags, decisão do dono |
> | Merge em `main` + tag `billing-asaas/fase-5b` | ❌ **não feito** — só depois do sandbox validado e dos gates rodados |
>
> **As duas flags que esta fase liga terminam OFF:** `billing_invoice_ingestion` (nasce nesta fase, migration 080) e `whatsapp_service_enforcement` (existia OFF desde a 5a, migration 075 — esta fase é quem finalmente a consome). Ligá-las é decisão separada do dono, na ordem da §9 da spec (transcrita em passo a passo executável na §0.2 do roteiro de sandbox).

---

## Escopo entregue

*"Cobrar a mensalidade da instância de WhatsApp de verdade, e suspender só ela quando não paga — sem nunca confundir com o acesso ao sistema."*

A fase se divide em três blocos internos (a mesma divisão da spec, §5–§7):

### 5b.1 — Elo financeiro

Até aqui, cobrança da instância de WhatsApp era teórica: o worker de inadimplência do sistema rodava sobre uma tabela de faturas vazia para essa categoria, porque nada criava fatura Asaas de verdade a partir de um evento de pagamento recorrente. Este bloco fecha isso:

- **`PAYMENT_CREATED` passa a criar a fatura em aberto** (antes era só informativo) — é o evento que faz a renovação entrar na régua de inadimplência pela primeira vez nesta migração.
- **Correlação por `provider_subscription_id`** (núcleo puro `billing-correlation-core.ts`, testado) — a renovação do mês 2+ nasce sem `checkoutSession` nem `externalReference` (só a assinatura tem o pagamento anterior como referência), e a escada de correlação da 4a/5a não tinha esse degrau. Divergência de organização entre degraus da escada **derruba o evento** em vez de escrever no tenant errado.
- **Worker `process-asaas-invoice-reconcile`** (novo, cron diário `0 8 * * *`, gated por `billing_invoice_ingestion`) — reconcilia cobranças do Asaas com `billing_invoices` por assinatura: cria fatura faltante (distinguindo `RECONCILE` de `BACKFILL`), liquida `open` que já foi paga lá, retém por divergência de valor, ou retém/pula por não-cobrabilidade (estorno/chargeback nunca fabrica dívida — decisão do dono).
- **`enforcement_hold`** (migration 077) — o freio que impede a primeira varredura de suspender por dívida antiga nunca cobrada. Fatura retida não conta como atraso em `process-billing-overdue`/`process-billing-reminders` (Task 12).

### 5b.2 — Enforcement por serviço

O núcleo da fase: um gate central que decide, para a organização, se o envio de WhatsApp deve funcionar — sem nunca confundir "sistema bloqueado" com "instância inadimplente".

- **Sete estados do serviço** (núcleo puro `whatsapp-service-state-core.ts`, testado) — `ACTIVE`, `GRACE_PERIOD`, `OVERRIDE_ACTIVE`, `LEGACY_GRANDFATHERED`, `NOT_ENTITLED`, `SUSPENDED_UNPAID`, `ADMIN_BLOCKED`. Gate pai lê `organizations.billing_status` (nunca `entitlements.system.allowed`), depois decide o estado do WhatsApp por override → estado financeiro → grandfathering.
- **Duas perguntas separadas, com polaridade fail-open/fail-closed oposta de propósito:** `sendingBlocked` (envio de mensagem já existente — fail-OPEN, um soluço técnico nunca suspende quem paga) e `newProvisioningBlocked` (contratar canal/instância nova — fail-CLOSED, nunca autoriza custo recorrente novo sem confirmação). A flag `whatsapp_service_enforcement` gateia SÓ a primeira.
- **Gate central de envio** (`whatsapp-service-gate.ts`) — ponto único para as 4 EFs de envio direto (`send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`), o agente de IA (`webhook-whatsapp`), o provisionamento de canal novo (`manage-channels`) e os 6 workers de notificação automática.
- **Silêncio, não mensagem de erro, quando o serviço está suspenso** — tanto no fluxo de texto do agente quanto na resposta automática a mídia (áudio/imagem/sticker), e a mensagem recebida do cliente é persistida mesmo quando o gate silencia (não some da conversa quando o serviço volta).
- **Estacionamento de jobs** — o outbox de confirmação volta a `pending` sem incrementar `attempts` durante a suspensão (não gasta o teto de 5 tentativas); os outros 5 workers de notificação pulam a unidade sem gravar `notifications_sent` — com uma exceção decidida pelo dono no fechamento da fase: a regra de **aniversário** do `process-voucher-triggers` cria o voucher mesmo suspensa e suprime só o envio, porque a data não volta (ver Risco 2). Job vencido durante a suspensão não é enviado depois de restaurada (checagem "reserva no passado" antes de despachar).
- **Grandfathering de uso legado** (migration 079) — organização que já usava WhatsApp antes desta fase recebe `LEGACY_GRANDFATHERED` (mantém uso, bloqueia provisionamento novo) via backfill com evidência objetiva (canal `connected`). Revogado, de forma TERMINAL, na primeira assinatura paga da categoria — cancelar depois não restaura.
- **Worker `process-whatsapp-enforcement`** (novo, cron diário `0 11 * * *`, depois do overdue de sistema às 10:00) — suspende/restaura `billing_subscriptions` da categoria `WHATSAPP_SUBSCRIPTION`, usando a MESMA query de fatura em aberto mais antiga que o gate de envio (campo-a-campo idêntica, de propósito). Ambiguidade (2+ assinaturas vivas) nunca escolhe sozinho — avisa o admin.
- **Avisos próprios da mensalidade da instância** — 7 event types novos em `billing_notifications` (D0/D+1/D+3/D+5/suspensão/restauração/ambiguidade), texto que nunca confunde "sua automação será suspensa" com "seu acesso ao sistema".

### 5b.3 — Regularização e superfície ao cliente

- **Pagamento cruzado não regulariza o outro serviço** — pagar a instância não desbloqueia o sistema, pagar o sistema não restaura a instância suspensa (garantido pelo `billing-category.ts` da 5a, agora exercitado com faturas de verdade).
- **`get_service_status`** (em `manage-whatsapp-implementations`) agora AFIRMA `serviceState`/`graceEndsAt`/`suspendedAt` — devolve 503 em vez de 200 mentiroso quando a leitura falha.
- **Banner de suspensão** em Gestão → Conversas e Gestão → Cobrança (`WhatsappServiceBanner.tsx`) — o QUAL banner aparece é `serviceState` (independente da flag); o TEMPO VERBAL dentro dele é `sendingBlocked` (gateado pela flag) — com a flag OFF, a organização nunca lê "já foi suspensa" para algo que continua enviando de verdade.
- **Painel administrativo de faturas retidas** (4 estados) e ação de liberação de hold (`manage-billing` action `release_invoice_enforcement_hold`) — registra administrador, data e motivo.

**Fora de escopo (fica para depois):** status real da instância na Z-API (Fase 6), fluxo de reimplantação, carteira de IA, UI genérica de overrides além do que já existia.

## Arquitetura

```
Asaas → asaas-webhook → applyAsaasEvent (_shared/asaas-billing-events-apply.ts)
          PAYMENT_CREATED (flag billing_invoice_ingestion) → cria billing_invoices 'open'
          PAYMENT_CONFIRMED/RECEIVED, purpose=subscription →
            resolve_or_activate_subscription (RPC, migration 079) → restaura suspended_at
            se a linha reutilizada estava suspensa (efeito colateral que torna
            whatsapp_restored raramente observável pelo worker diário — ver Riscos)

process-asaas-invoice-reconcile (cron 08:00 UTC, flag billing_invoice_ingestion)
  → decideReconcileAction (asaas-invoice-reconcile-core.ts) por cobrança:
    CREATE_INVOICE (RECONCILE/BACKFILL+hold) | SETTLE_INVOICE | HOLD_VALUE_MISMATCH |
    HOLD_NON_COLLECTIBLE | SKIP_* | NO_ACTION

Envio de WhatsApp (send-*, webhook-whatsapp, manage-channels, 6 workers de notificação)
  → resolveWhatsAppGateByOrg/ByUnit (_shared/whatsapp-service-gate.ts)
      → decideWhatsAppGate + resolveEnforcement + resolveProvisioningEligibility
        (_shared/whatsapp-service-state-core.ts, núcleo puro)
      → { enforced: {sending}, provisioning: {allowed, blockReason}, readFailed, ... }

process-whatsapp-enforcement (cron 11:00 UTC, flag whatsapp_service_enforcement)
  → mesma query de fatura em aberto mais antiga do gate acima
  → suspende/restaura billing_subscriptions (categoria WHATSAPP_SUBSCRIPTION)
  → billing_notifications (avisos próprios da mensalidade da instância)
```

## Arquivos

**Migrations criadas:** `077_billing_invoice_enforcement_hold.sql`, `078_billing_subscription_service_timestamps.sql`, `079_whatsapp_legacy_grandfathering.sql`, `080_platform_flags_billing_5b.sql`, `082_cron_asaas_invoice_reconcile.sql`, `083_cron_whatsapp_enforcement.sql`.

**Numeração pula de 080 para 082 — não é lacuna.** A spec (§8) previa uma migration `081` com a RPC `get_platform_admin_emails()` para o destinatário dos avisos administrativos; na implementação, o destinatário reusa `resolvePlatformAdminRecipients()` (helper TS em `_shared/billing-notify.ts`, já existente desde a 5a) em vez de uma RPC SQL nova — `081` nunca foi criada.

**`_shared/` criados:** `whatsapp-service-state-core.ts` e `whatsapp-service-gate.ts` (núcleo puro + I/O do gate de serviço), `billing-correlation-core.ts` (escada de correlação), `billing-financial-state-core.ts` (normalização financeira provider-agnóstica), `asaas-invoice-reconcile-core.ts` (decisão de reconciliação por cobrança).

**`_shared/` modificados:** `asaas-billing-events-apply.ts` (PAYMENT_CREATED cria fatura, correlação por assinatura, hold), `asaas-billing-events.ts`, `asaas-core.ts`, `asaas.ts` (paginação de cobranças de assinatura), `entitlement-overrides.ts`, `platform-flags.ts`, `whatsapp-send.ts`.

**Edge Functions criadas:** `process-asaas-invoice-reconcile`, `process-whatsapp-enforcement`.
**Edge Functions modificadas:** `manage-billing`, `manage-channels`, `manage-whatsapp-implementations`, `process-billing-notifications`, `process-billing-overdue`, `process-billing-reminders`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-whatsapp`, `webhook-whatsapp`.

**Frontend criado:** `src/components/billing/WhatsappServiceBanner.tsx`, mais os 4 arquivos de teste vitest dos núcleos puros novos (`whatsapp-service-state-core.test.ts`, `billing-correlation-core.test.ts`, `billing-financial-state-core.test.ts`, `asaas-invoice-reconcile-core.test.ts`).
**Frontend modificado:** `src/hooks/useBilling.ts`, `useUndeliveredNotifications.ts`, `useWaitlist.ts`, `useWhatsAppChannels.ts`, `useWhatsappImplementation.ts`, `src/pages/gestao/Automacao.tsx`, `Cobranca.tsx`, `Conversas.tsx`, `src/pages/platform/Billing.tsx`, `WhatsappImplementations.tsx`, `src/types/billing.ts` (agora `import type` cross-boundary de `whatsapp-service-state-core.ts`, não cópia).

**Config:** `supabase/config.toml` (`verify_jwt=false` para os 2 workers novos).

**Documentação:** `CLAUDE.md` (invariantes + checklist de redeploy, atualizado incrementalmente task a task e nesta task de fechamento), este documento, [FASE-5B-ROTEIRO-SANDBOX.md](FASE-5B-ROTEIRO-SANDBOX.md), 2 correções na spec de design (§7 localização real do banner, §10.2 gatilhos reais de `admin_correlation_ambiguity`).

Total da branch: 56 arquivos de código (`supabase/` + `src/`), +7385/−120 linhas, 44 commits (`git diff --shortstat 46b8a6b..HEAD`).

## Commits (por bloco)

**5b.1 — Elo financeiro (Tasks 1–12, ~24 commits):** `c63c9b8`+`46e0519` colunas de hold (+fix FK) · `71042e4` timestamps de suspensão/restauração · `7515694` grandfathering · `d599683`+`4ec2a37`+`7f25b2a` flags novas (+2 fixes) · `88efc96`+`0015e0a` núcleo da escada de correlação · `57237e2`+`e2b71b7` núcleo de estado financeiro · `37f452e`+`a44f812` núcleo dos sete estados · `275f2c2`+`0bf42c8` degrau de assinatura na correlação (+aviso admin) · `ef6f1bd`+`22e42fd` `PAYMENT_CREATED` cria fatura (+valor ausente bloqueia) · `1bb908b`+`284147a` paginação de cobranças · `074a581`+`b723995` worker de reconciliação (+data de corte obrigatória, estorno não fabrica dívida) · `12ddd80` inadimplência ignora fatura retida.

**5b.2 — Enforcement por serviço (Tasks 13–20, ~18 commits):** `7343a31`+`33cad80` helper de I/O do gate (+flag ilegível/provisionamento fail-closed) · `049358e` gate central de envio · `225cf75` gate do agente · `f2572bf` 3 decisões do dono (mídia, inbound perdido, provisionamento) · `0641202` resposta a mídia respeita bloqueio · `b207e54`+`c168142` mensagem recebida não some (+fix honestidade do flag) · `76005b7` bloqueia canal novo sem direito · `f53114a`+`626f832`+`df0292b` rotação de secret de webhook (não é o gate — achado paralelo da Task 16) · `b75165f`+`30950af`+`be96c31` worker de suspensão/restauração (+2 rodadas de fix) · `9da02b4`+`73cb91f` avisos próprios da mensalidade · `9c38012`+`d558a4e` estaciona jobs (+fix não mentir sobre suspensão) · `aa4900b`+`5ff1852` superfície do serviço, liberação de retenção, revogação do grandfathering (+fix tempo verbal do banner).

**Fechamento (Task 21, 2 rodadas):** `d81469a` invariantes residuais no CLAUDE.md + roteiro de sandbox + 2 correções na spec · este commit, fixando o achado do fix round 1 (resumo da fase ausente).

## Decisões do dono (registradas na spec/plano durante a execução)

1. **Estorno/chargeback nunca fabrica dívida.** Sem fatura interna, não cria; com fatura interna, `enforcement_hold=true` + `MANUAL_REVIEW`, nunca reabre cobrança nem trata como inadimplência.
2. **`billing_invoice_ingestion_since` é obrigatória** quando a ingestão liga. Ausente/inválida = erro fatal de configuração, aborta antes de qualquer efeito.
3. **Divergência de organização entre degraus da correlação derruba o evento** — escrever no tenant errado é pior que atrasar um pagamento. Carimbo histórico nunca impede uma correção segura, mas ambiguidade nunca desempata por ele.
4. **Envio existente é fail-OPEN; provisionamento novo é fail-CLOSED.** Assimetria deliberada, e a Task 16 quase inverteu isso (usar `enforced.newProvisioning`, que não existe) — decisão do dono confirmou `newProvisioningBlocked` como campo próprio, nunca gateado pela flag de enforcement.
5. **Mídia recebida durante a suspensão: silêncio, nunca resposta automática** (Task 15b, decisão do dono após achado do review) — reusa o mesmo gate central, não duplica os sete estados.
6. **Mensagem recebida durante a suspensão não pode desaparecer em definitivo** (Task 15c, decisão do dono, bloqueante pro go-live do enforcement) — ramo "persistir e silenciar" sem reordenar o pipeline normal.
7. **Provisionamento de canal novo usa `newProvisioningBlocked` (estado real), nunca `enforced.newProvisioning`** — a flag `whatsapp_service_enforcement` governa só consequência sobre uso existente, nunca autoriza contratar/provisionar.
8. **Valor financeiro desconhecido bloqueia a aplicação do evento, nunca vira R$ 0,00** (Task 9) — zero explícito é válido; ausência é erro retryable.

## Riscos residuais / follow-ups

### 1. FK de autoria sem `ON DELETE SET NULL` — débito herdado da Fase 1

`organization_entitlement_overrides.revoked_by uuid references auth.users(id)` (migration `062_entitlement_overrides.sql:39`) foi criada **sem cláusula `ON DELETE`**, o que o Postgres resolve para `NO ACTION`. **Comportamento atual:** excluir um `auth.users` que já revogou algum override falha com violação de integridade referencial — a exclusão do usuário é bloqueada pela linha de auditoria, mesmo que ele não tenha mais nenhum vínculo operacional com o sistema. Decisão do dono (fix round 1 da Task 1 desta fase): toda FK de autoria/auditoria apontando para `auth.users(id)` deve aceitar NULL, usar `ON DELETE SET NULL`, nunca `CASCADE`, e nunca impedir a exclusão de um usuário. A migration 062 **já está aplicada em produção e não pode ser editada** — a correção exige uma migration nova e independente que descubra o nome real da constraint, dropa só a FK antiga e recria com `ON DELETE SET NULL`, sem alterar dados. **A FK equivalente criada NESTA fase já nasceu correta** (`whatsapp_grandfather_revoked_by`, migration `079_whatsapp_legacy_grandfathering.sql:23`, `on delete set null` desde o início) — a 062 é a única pendência. Onde a UI mostra quem liberou uma retenção ou concedeu um override, ator `NULL` já renderiza "Usuário removido"/"Administrador não disponível", nunca erro ou UUID cru — isso já está pronto, só falta a migration do banco.

### 2. `process-voucher-triggers` — RESOLVIDO: aniversário sempre cria o voucher, frequência continua adiando

**Decisão do dono, tomada.** Antes desta correção, os dois workers de voucher (`processBirthday`, `processFrequency`) pulavam a REGRA inteira (`continue`, sem criar voucher nenhum) quando `resolveWhatsAppGateByUnit(...).enforced.sending` era `true` para a unidade. A assimetria entre as duas regras é o que motivou a decisão:

- **Regra de FREQUÊNCIA continua só adiada, sem mudança de comportamento.** A janela de elegibilidade é recalculada a partir de "agora" a cada execução — se a unidade for suspensa hoje e desbloqueada amanhã, o cliente ganha o voucher amanhã, sem perda. Criar o voucher sem enviar resolveria um problema que esta regra não tem, então o `continue` (`supabase/functions/process-voucher-triggers/index.ts:363-368`) foi mantido como estava.
- **Regra de ANIVERSÁRIO agora SEMPRE cria o voucher.** O gatilho é `mmdd(customer.birthday) === mmdd(hoje)`, sem retentativa nenhuma — a data não volta, então pular a regra inteira era perda permanente do voucher daquele ano (29/02 tinha a mesma exposição). A partir desta correção, o gate ainda é resolvido uma vez por unidade antes do laço de clientes, mas em vez de `continue` o resultado vira `suppressSend` (`IssueArgs`), propagado até `issueAndSend`: o `INSERT` em `vouchers` acontece sempre, e só o envio da mensagem de WhatsApp é suprimido — espelhando o branch pré-existente de `!ctx.whatsapp_enabled` (mesma posição no fluxo, mesmo formato de retorno `{ ok: true, reason }`, sem gravar `notifications_sent`). Telemetria separada por propósito: `skipped_suspended` segue medindo só a frequência (regra pulada); `send_suppressed`, métrica nova, mede vouchers de aniversário criados com envio suprimido.

Isto era o **único ponto de toda a fase** onde suspensão virava "o evento nunca aconteceu" em vez de "a mensagem foi adiada". Com a correção, aniversário passa a se comportar como o resto do sistema (outbox de confirmação, lembretes, pesquisas de satisfação): a suspensão atrasa ou suprime a notificação, nunca apaga o direito do cliente. Este risco está fechado — ver Risco 9 para o remanescente da mesma família (os cinco workers de notificação sem entidade a criar).

### 3. `whatsapp_restored` é praticamente inalcançável no caminho comum

A RPC `resolve_or_activate_subscription` (redefinida nesta fase, `migration 079:161-171`), chamada por `_shared/asaas-billing-events-apply.ts:1223-1233` dentro do processamento síncrono do webhook de pagamento do Asaas, contém:

```sql
update billing_subscriptions
   set restored_at = now(), suspended_at = null, updated_at = now()
 where id = v_sub_id and suspended_at is not null;
```

Isto roda para **qualquer categoria** de assinatura (sistema OU WhatsApp) sempre que a RPC reutiliza uma linha existente — ou seja, alguns segundos depois de QUALQUER pagamento confirmado pelo Asaas, a assinatura já sai de `suspended_at IS NOT NULL` antes mesmo do worker diário `process-whatsapp-enforcement` (cron `0 11 * * *`) rodar. O worker é quem enfileira o aviso `whatsapp_restored` (`process-whatsapp-enforcement/index.ts:370-375`), mas ele só encontra uma assinatura ainda em `status='unpaid'` com `suspended_at` preenchido na exceção — quando o webhook não chegou a tempo, ou quando a reconciliação liquida o pagamento depois. O próprio worker já documenta essa relação no cabeçalho (`process-whatsapp-enforcement/index.ts:6-10`: "no caminho do pagamento via Asaas, já restaura suspended_at/restored_at sozinha — este worker é a defesa dupla"), mas não quantifica a raridade. **Causa raiz fora do escopo desta fase**, em `_shared/asaas-billing-events-apply.ts` — mexer nisso mudaria comportamento do caminho comum de ativação de assinatura, não é decisão pra tomar dentro de uma task de documentação.

### 4. Inconsistência viva: organização `canceled` continua respondendo por TEXTO, mas não por mídia

O bloqueio de sistema no fluxo de texto do agente (`webhook-whatsapp/index.ts:1593`) testa só `billing_status === "blocked" || billing_status === "suspended"` — não inclui `"canceled"`. O gate mais novo da resposta automática a mídia (`webhook-whatsapp/index.ts:1412-1414`, via `decideInboundAutoReply({ systemBlocked: waGate.systemBlocked, ... })`) usa `systemBlocksDependentServices`, que TRATA `canceled` como bloqueio (junto com `blocked`/`suspended` — `whatsapp-service-state-core.ts:72-82`). Resultado: uma organização `canceled` continua rodando o agente de IA completo (gastando token) para mensagens de texto, mas fica em silêncio para áudio/imagem/sticker da mesma conversa. Isto **não é novo desta fase** — o gate de texto é pré-existente — mas a Task 15b tornou a divergência mais visível ao construir o caminho novo (mídia) sobre a fonte de verdade correta. Já estava registrado como pendência ao final da Task 15b; alinhar o texto ao mesmo helper central (`systemBlocksDependentServices`) é mudança de comportamento e fica para quando o dono decidir.

### 5. `shouldSettleOpenInvoice` pode auto-liquidar uma fatura retida por divergência de valor, contornando a revisão humana

`decideReconcileAction` (`_shared/asaas-invoice-reconcile-core.ts:402-404`) chama `shouldSettleOpenInvoice(localInvoice.status, settled)` — que verifica só `status === "open"` e `settled`, **sem olhar `localInvoice.enforcementHold`**. Uma fatura que está retida (`enforcement_hold=true`) por `VALUE_MISMATCH` mas continua `status='open'` no banco pode ser marcada `SETTLE_INVOICE` (paga) automaticamente se o Asaas liquidar o pagamento depois — sem que o admin nunca tenha revisado a divergência que gerou o hold. O hold de divergência de valor existe justamente para forçar essa revisão; hoje ele não a garante contra este caminho.

### 6. Não há reaper para `notification_outbox` preso em `processing`

Introduzido pelo próprio estacionamento de jobs desta fase (Task 19): se o `UPDATE` que volta um job estacionado para `pending` falhar, a linha fica `processing` para sempre — não existe worker nem janela de staleness (diferente de `processed_messages`, que tem 90s) que a resgate. O código já loga o suficiente para um reset manual (`process-notification-outbox/index.ts:180-188`), mas a recuperação é manual, via SQL, quando alguém notar o log.

### 7. Fatura de renovação sem vínculo de assinatura ainda pode bloquear a organização inteira — **bloqueante da ingestão automática**

Este é o risco que a própria fase existe para matar, e ele continua aberto no caso menos comum. O `CLAUDE.md` já registra a regra ("a garantia depende de a fatura carregar vínculo de plano"); o que faltava era nomear o caminho concreto que ainda produz uma fatura sem vínculo.

A escada de correlação tem um degrau que resolve a **organização sem resolver a assinatura**: o degrau 5, `billing_customer`, devolve `subscriptionId: null` explicitamente (`_shared/asaas-billing-events-apply.ts:716-723`). E o degrau da assinatura do provedor, quando o `provider_subscription_id` do payload não bate com nenhuma linha local, apenas loga `asaas_unknown_provider_subscription` e segue (`:645-651`). Uma renovação de mês 2+ não carrega `checkoutSession` nem `externalReference` — nasce da assinatura. Então basta que o `provider_subscription_id` local esteja ausente ou defasado (linha criada por admin, troca de plano que gerou assinatura nova no Asaas, primeiro `PAYMENT_CONFIRMED` sem `subscription` no payload) para que a correlação caia no degrau 5, e `upsert_open_invoice` grave a fatura com `billing_subscription_id = null`, `purpose = 'other'`, `external_reference = null`.

Com os três nulos, `isSystemInvoice` cai no caminho 3 e devolve **`true` por compatibilidade com fatura legada** (`_shared/billing-category.ts:164`). A partir daí: `process-billing-overdue` escreve `organizations.billing_status='blocked'` em D+6 — **o sistema inteiro morre por uma mensalidade de R$149 da automação de WhatsApp** —, e `process-billing-reminders` manda ao cliente a cópia de sistema ("seu acesso será suspenso") por uma dívida que não é do sistema.

O comentário em `:645-650` diz "o reconcile pode resolver depois". **Não resolve:** `process-asaas-invoice-reconcile` itera apenas assinaturas com `provider_subscription_id` não-nulo (`index.ts:219-222`), que é exatamente a condição ausente; e mesmo quando encontra a fatura, `decideReconcileAction` devolve `NO_ACTION` (`_shared/asaas-invoice-reconcile-core.ts:406-421`). Nada faz o backfill do vínculo.

**Hoje é inalcançável em produção** — as duas flags estão OFF, não há cliente pagante da automação, e as duas organizações vivas curto-circuitam em `OVERRIDE_ACTIVE` (vitalício). Torna-se crítico no dia em que existir o primeiro cliente pagante do add-on. **Gate: fechar antes de ligar `billing_invoice_ingestion`** — é essa flag, não a de enforcement, que abre o caminho, porque é ela que autoriza a criação automática de fatura. A correção provável é fazer o degrau 5 nunca produzir fatura tratável como de sistema (ou fazer o caminho 3 do `isSystemInvoice` deixar de devolver `true` por default quando a fatura nasceu do Asaas depois do go-live), não mexer na escada de correlação.

### 8. Deploy do `manage-channels` antes do `supabase db push` bloqueia todo provisionamento novo — **gate de ordem de deploy**

O gate de novo provisionamento (Task 16) **falha fechado** por decisão do dono: qualquer falha de leitura vira `STATE_READ_FAILED` e o `create` responde 403 (`manage-channels/index.ts:128-134`, `_shared/whatsapp-service-state-core.ts:303`). As leituras do gate tocam colunas criadas nas migrations 077, 078 e 079. Se a Edge Function subir antes das migrations, o PostgREST responde 400 em coluna desconhecida e **toda unidade sem canal recebe 403**, inclusive para `platform_admin`.

Isto inverte uma conclusão registrada na Task 13, que era correta enquanto existia só o gate de ENVIO (que falha aberto, por decisão oposta e deliberada). Desde a Task 16 não vale mais. A regra está escrita no `CLAUDE.md` (§ Deploy → Edge Functions) e no pré-requisito do roteiro de sandbox; este item existe para que o registro de riscos não a esconda.

Nota independente: mesmo com as migrations aplicadas e as duas flags OFF, **o gate de provisionamento já está valendo no merge** — é a única consequência da fase que não depende de flag, por desenho (elegibilidade protege custo novo recorrente e sempre se aplica). Qualquer organização sem assinatura ativa de WhatsApp, sem override e fora do grandfathering passa a receber 403 ao adicionar o primeiro canal. É o comportamento pretendido, mas não é coberto pela leitura de que "com as duas flags OFF nada muda".

### 9. Cinco workers DESCARTAM o job sob suspensão do WhatsApp, em vez de estacioná-lo — único remanescente da família do Risco 2

`process-notification-outbox` estaciona: volta o job a `status='pending'`, empurra `next_attempt_at` +1h e grava `last_error: "whatsapp_service_suspended"`, sem incrementar `attempts` (`process-notification-outbox/index.ts:170-196`). Os outros cinco consumidores de `resolveWhatsAppGateByUnit` fazem só `continue`/`return` quando `enforced.sending` é `true`, sem gravar nada em `notifications_sent` e sem reagendar: `process-reservation-reminders/index.ts:172-176`, `process-satisfaction-surveys/index.ts:152-156`, `process-voucher-triggers/index.ts:363-368` (só a regra de FREQUÊNCIA — a de ANIVERSÁRIO foi corrigida junto do Risco 2, ver abaixo), `process-waitlist-entered/index.ts:115-121` (retorna `skipped: "whatsapp_suspended"`) e `process-waitlist-feedback/index.ts:130-134`. Consequência concreta: uma reserva confirmada para hoje numa organização suspensa perde o lembrete D-0 daquele dia **mesmo que o cliente pague às 11h**, porque o cron já rodou às 10h BRT e o de amanhã filtra por "hoje" (`r.date` local, sem varredura retroativa). Mesmo raciocínio para a pesquisa de satisfação D+1 e para o aviso de entrada na fila, que dispara uma única vez sem varredura de recuperação.

O irmão deste risco — o Risco 2, voucher de aniversário — foi decidido e corrigido: aniversário agora cria o voucher sempre e gateia só o envio, no mesmo padrão do `process-notification-outbox`. Este risco continua aberto porque os cinco workers aqui não têm uma entidade própria pra criar sem enviar — a mensagem *é* o artefato (lembrete, pesquisa, aviso de fila) — e adiá-los exigiria uma fila que não existe hoje. Não é um espelhamento direto do que resolveu o Risco 2; é mudança estrutural com spec própria. Gate: decidir antes de ligar `whatsapp_service_enforcement` — referenciado na lista de gates nomeados abaixo.

### 10. `operador` enxerga as colunas de grandfathering de WhatsApp

A policy pré-existente `org_member_read_organizations` (`013_multi_tenant.sql:336-338`) é `for select to authenticated using (is_org_member(auth.uid(), id))`, **sem distinção de papel** — então qualquer membro da organização, inclusive `operador` (que não tem billing no menu), lê pelo REST as seis colunas novas de grandfathering da migration 079 (`whatsapp_legacy_grandfathered`, `whatsapp_grandfathered_at`, `whatsapp_grandfathered_source`, `whatsapp_grandfather_revoked_at`, `whatsapp_grandfather_revoked_reason`, `whatsapp_grandfather_revoked_by` — `079_whatsapp_legacy_grandfathering.sql:17-23`), incluindo o UUID de `auth.users` de quem revogou o benefício. Não cruza tenant e não é regressão da 079 — a mesma superfície já existia para `billing_status`/`trial_ends_at`. É opacidade organizacional (papel sem acesso a billing lendo dado que devia ser só de owner/gerente), não vazamento cross-tenant. Sem gate de flag: é follow-up.

**A metade `anon` deste risco foi FECHADA em 2026-07-31 pela migration 086** — e antes disso foi *medida*, não suposta: `GET /rest/v1/organizations?select=name,billing_email` com a anon key do bundle devolvia 200 com o e-mail de cobrança real de uma organização cliente. A correção não foi a RPC com projeção que este parágrafo previa, e sim **privilégio por coluna**: as policies `TO anon` continuam (três policies de INSERT anon fazem subquery em `organizations`/`units` e dropar derrubaria a reserva pública), mas o grant de tabela virou grant de coluna. `anon` passou de 19 → 2 colunas em `organizations` e de 24 → 22 em `units`. Efeito colateral desejado: coluna nova nasce invisível pra `anon`.

**A metade `operador` continua aberta e NÃO se resolve pelo mesmo caminho** — `operador` e `owner` são ambos `authenticated`, e privilégio de coluna não distingue papel. Essa metade exige mesmo a RPC com projeção, ou uma policy separada por papel.

## Gates de segurança (`saas-shield-br`)

**Os seis rodaram. Cinco PASS; o `rls-auditor` deu FAIL com um bloqueante P1, corrigido na migration 084.**

- **`rls-auditor`** — **FAIL**, 1 bloqueante P1 + 1 atenção P3. O P1: **nenhuma das 16 funções `trigger_*` de cron do repo tinha `revoke`/`grant`**. Em PostgreSQL, `CREATE FUNCTION` concede `EXECUTE` a `PUBLIC` por padrão; `anon` tem `USAGE` no schema `public`, que é o exposto ao PostgREST — então qualquer pessoa com a `VITE_SUPABASE_ANON_KEY` (pública no bundle, por design) podia chamar `POST /rest/v1/rpc/trigger_whatsapp_enforcement` e disparar os workers fora de hora. O `x-internal-key` não protege: é a própria função `SECURITY DEFINER` que o lê do Vault e o fornece. Impacto: corrida com o cron legítimo sobre `billing_subscriptions.status`/`suspended_at`, e amplificação de custo/rate-limit contra a API do Asaas. **Não é regressão desta fase** — o repo aplica o padrão corretamente em todas as outras funções (`get_widget_public`, `enter_waitlist`, `get_public_tracking`, `try_claim_conversation_for_ai`, `resolve_or_activate_subscription`, …), e a família `trigger_*` é a única omissão, repetida desde a migration 029; a 5b apenas acrescentava mais duas. A **migration 084** fecha as 16 de uma vez, por laço sobre `pg_proc` (idempotente, e no-op onde o privilégio já não existisse). O P3 virou o Risco 10.
- **`integration-reliability-auditor`** — PASS_WITH_WARNINGS, 0 bloqueantes. Aprovou o que mais importa nesta fase: idempotência do webhook em todo caminho de escrita (persist-then-apply, `23505` como dedupe silencioso), orçamento de I/O presente só no `asaas-webhook` e omitido nos crons de propósito, zero uso de `EdgeRuntime.waitUntil`, `PAYMENT_CREATED` fora de ordem como no-op explícito (não regride fatura já paga), conflito de organização entre degraus da correlação derrubando o evento em vez de escolher um lado, claim atômico do outbox por `UPDATE ... RETURNING`, e os 16 consumidores do gate limpando o cache no início da própria invocação. Confirmou a assimetria fail-open (envio) / fail-closed (provisionamento) ponta a ponta. As duas atenções P2 viraram o Risco 9 e o teto de leitura corrigido na 084.

**Os três primeiros, rodados antes, todos PASS com zero bloqueantes:**

- **`tenant-isolation-auditor`** — PASS_WITH_WARNINGS. Confirmou que o cache de módulo do gate é indexado por organização/unidade e que os 15 consumidores chamam `clearWhatsAppGateCache()` antes de qualquer `resolveWhatsAppGateBy*`; resultados com `readFailed` nunca são cacheados; toda action de `manage-channels` escopa por `id` **e** `unit_id`. Um P2: `resolveBillingRecipient` não confere o erro da query de `units`, então falha transitória é indistinguível de "org sem unidades" e o aviso é suprimido em silêncio — não é vazamento, o escopo por organização está correto.
- **`migration-validator`** — PASS_WITH_WARNINGS. Diffou a RPC `resolve_or_activate_subscription` linha a linha contra a 073: assinatura, `security definer`, `search_path` e os `revoke`/`grant` byte-idênticos, com os dois blocos novos estritamente aditivos e shape de retorno inalterado. Wrappers de cron 082/083 sem drift em relação à 064; `verify_jwt=false` presente para as duas EFs novas. Dois P2/P3: as colunas novas de grandfathering legíveis por `anon` (ver abaixo) e o backfill da 079 refletir o estado no momento do `db push`, não no da autoria.
- **`secret-hunter`** — PASS. `rotate_secret` nunca loga o secret gerado; o roteiro de sandbox é 100% placeholder. O P2 sobre o `.env` local foi fechado por verificação direta: `git ls-files .env` e `git log --all -- .env` vazios — nunca rastreado, nunca commitado.

**Achado dos gates que exige decisão do dono, ainda aberto:** a policy pré-existente `public_read_organizations` é `for select to anon using (is_public = true)` **sem lista de colunas**, e RLS filtra linha, não coluna. As seis colunas novas de grandfathering — incluindo `whatsapp_grandfather_revoked_by`, um UUID de `auth.users` — ficam legíveis por qualquer visitante com a anon key pública do bundle, para toda organização com `is_public=true` (o default). A categoria é pré-existente (a mesma policy já expõe `billing_status` e `trial_ends_at`), mas esta fase a alarga, e a policy contradiz o invariante do próprio `CLAUDE.md` ("anon lê só por RPCs `SECURITY DEFINER`; policy `TO anon` direto em tabela de negócio é regressão"). Não corrigido aqui porque mexer nessa policy afeta o portal público inteiro — merece task e revisão próprias, logo após o merge.

- **`identity-access-auditor`** — PASS, 0 bloqueantes e 0 atenções. Confirmou que o gate de novo provisionamento **não é contornável por `platform_admin`** (não existe ramo de bypass — a decisão do dono está implementada como escrita), que `get_service_status` é a única action client-friendly de `manage-whatsapp-implementations` e que o guard roda antes do dispatch, que `rotate_secret` escopa por `unit_id` além do `id` do canal, e que `_shared/entitlement-overrides.ts` é o **único** writer de `organization_entitlement_overrides` em toda a base — nem `asaas-webhook`, nem `process-asaas-reconcile`, nem `manage-billing` tocam a tabela.

**Verificação que só o dono pode fazer** (exige acesso SQL autenticado): a premissa do P1 do `rls-auditor` foi estabelecida por leitura estática das migrations, não contra o banco ao vivo. A query de confirmação está no rodapé da migration 084 — se ela devolver zero linhas ANTES da 084, o privilégio já estava revogado por outro caminho e a migration é um no-op de defesa em profundidade.

## Runbook de ativação

Não duplicado aqui — as duas fontes canônicas já existem e cobrem o runbook completo:

- **Ordem de deploy de Edge Functions**: checklist de redeploy do [CLAUDE.md](../../CLAUDE.md) § Deploy → Edge Functions (mantido atualizado task a task ao longo da fase).
- **Ordem de ativação das duas flags** (deploy → validar com as duas OFF → `billing_invoice_ingestion` primeiro, com `billing_invoice_ingestion_since` gravada antes → observar um ciclo completo do worker → liberar holds legítimos → `whatsapp_service_enforcement`): passo a passo executável, com SQL de verificação em cada etapa, na [§0.2 do roteiro de sandbox](FASE-5B-ROTEIRO-SANDBOX.md#02-ordem-de-ativação-das-flags-9-da-spec--executar-antes-dos-cenários-que-exigem-ingestão-real).

### Gates nomeados — o que fechar antes de cada etapa

Os riscos abaixo não bloqueiam o merge (as duas flags sobem OFF e as duas organizações vivas curto-circuitam em `OVERRIDE_ACTIVE`), mas cada um bloqueia uma etapa específica da ativação. Esta lista existe para que nenhum deles seja descoberto depois de a flag já estar ligada.

**Antes do deploy (qualquer flag):**
- Risco 8 — aplicar as migrations 077, 078, 079, 080, 082 e 083 **antes** de deployar `manage-channels`. Ordem obrigatória, não convenção.

**Antes de ligar `billing_invoice_ingestion`:**
- Risco 7 — fatura de renovação sem vínculo de assinatura lida como fatura de sistema. É esta flag que autoriza a criação automática de fatura, então é aqui que o caminho abre. **O mais grave da lista.**
- Risco 5 — `shouldSettleOpenInvoice` auto-liquidando fatura retida por divergência de valor. Sem ingestão automática não há retenção a contornar; com ela, há.
- **`paid_at = now()` no reconcile** (`process-asaas-invoice-reconcile/index.ts:367,407`) — no primeiro backfill, toda fatura histórica fica registrada como paga no dia do backfill. `AsaasPaymentSummary` não carrega a data do pagamento, então corrigir exige um `getPayment` por linha (custo real). Decidir antes do backfill, não depois: qualquer relatório de receita por mês construído sobre esses dados nasce distorcido.
- **Estorno após pagamento é invisível** — uma fatura já `paid` localmente que vire estornada no Asaas cai em `NO_ACTION` (`_shared/asaas-invoice-reconcile-core.ts:377-380`, o branch de categoria congelada exige `status === "open"`). A regra do dono ("estorno nunca fabrica dívida") é respeitada, mas não há log nem alerta que distinga isso de "nada a fazer". No mínimo, um log próprio.

**Antes de ligar `whatsapp_service_enforcement`:**
- ~~Risco 2~~ — RESOLVIDO. Voucher de aniversário agora cria sempre e gateia só o envio; não é mais gate de ativação.
- Risco 9 — cinco workers de notificação que descartam o job (não estacionam) sob suspensão: lembrete D-0, pesquisa D+1 e aviso de entrada na fila somem se a organização estiver suspensa na hora do cron, mesmo que pague minutos depois. Continua aberto — precisa de fila própria, não é um espelhamento do fix do Risco 2.
- Risco 6 — reaper (ou janela de staleness) para `notification_outbox` preso em `processing`. O estacionamento de jobs é o que torna esse caminho alcançável, e o estacionamento só acontece sob suspensão aplicada.
- Risco 4 — decidir se o fluxo de TEXTO passa a usar `systemBlocksDependentServices` como o de mídia já usa. Ligar a flag muda o comportamento de organização `canceled` no caminho de texto de um jeito ou de outro; deve ser decisão, não efeito colateral. Junto disso: hoje `enforced.sending` carrega `systemBlocked` dentro de si, então a flag de enforcement também gateia consequência de bloqueio de SISTEMA em caminhos que nada têm a ver com o add-on de WhatsApp — e o resultado é registrado sob o outcome `whatsapp_service_suspended`, um rótulo de cobrança de WhatsApp para uma causa de acesso ao sistema. Só o gate de mídia (`decideInboundAutoReply`) mantém as duas dimensões separadas, como o núcleo documenta que deveriam ser.
- **Banner de carência perde o aviso de suspensão quando a flag liga.** O ramo `GRACE_PERIOD` de `WhatsappServiceBanner.tsx` escolhe o texto por `sendingBlocked`, que no payload é `enforced.sending` — já gateado pela flag. Mas carência, por definição, **não bloqueia envio** (`SENDING_BLOCKED_BY_STATE.GRACE_PERIOD = false`), então `enforced.sending` só fica verdadeiro ali quando o SISTEMA está bloqueado. Consequência: com a flag ON e sem bloqueio de sistema, o banner continua dizendo "Regularize até `<data>`" em vez de avisar que a suspensão **vai** acontecer. Não é mentira (o prazo é real e a urgência está lá) — é perda de informação exatamente quando a informação passa a valer. O sinal semanticamente certo para uma PREVISÃO é "o enforcement está ligado?", não "o envio está bloqueado agora?", e esse campo não é exposto por `get_service_status` hoje. Revisar junto com a virada da flag.

**Sem etapa vinculada** (follow-ups sem gate): riscos 1 (FK da 062) e 3 (`whatsapp_restored` raro).

## Resultado do sandbox

**Não executado.** O roteiro completo (44 blocos verificáveis: C1–C31, com sub-itens C24a–C24g e C24h–C24m) está escrito e pronto pra execução em [FASE-5B-ROTEIRO-SANDBOX.md](FASE-5B-ROTEIRO-SANDBOX.md), com passo a passo verificável, SQL de observação e resultado esperado objetivo para cada cenário — inclusive o SQL pronto pra forçar cada estado financeiro (`PAID`/`IN_GRACE`/`OVERDUE_BEYOND_GRACE`/`CANCELED`/`NO_SUBSCRIPTION`) sem depender de esperar ciclos reais do Asaas. Quem rodar o roteiro preenche a coluna de resultado real naquele documento e traz o veredito de volta para este resumo antes de merge/tag.

## Rollback

- **Desligar as duas flags** (`billing_invoice_ingestion`, `whatsapp_service_enforcement`) — envio volta a funcionar sem gate nenhum, e a ingestão automática de fatura para. Nada é perdido: as migrations são aditivas.
- **`update platform_flags set value='false'::jsonb where key='whatsapp_service_enforcement';`** sozinho já reverte só a consequência de suspensão, mantendo a ingestão financeira rodando em observação — é o modo intermediário pensado pela própria ordem de ativação da §9.
- **Migrations ficam** — `enforcement_hold`, os timestamps de suspensão/restauração e o grandfathering não têm efeito nenhum com as flags OFF; não há necessidade de reverter schema.
- **Grandfathering revogado é irreversível por design** (decisão do dono) — não existe rollback de `whatsapp_grandfather_revoked_at` além de ação administrativa explícita nova.
- Rollback específico de cada migration está no rodapé do próprio arquivo `.sql`.

## Correções pós-fase (2026-07-31)

Três achados encontrados **depois** do fechamento do código da 5b, todos corrigidos, auditados e deployados. Não alteram o escopo da fase; alteram o que é seguro ligar.

1. **[Bug 08](08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md) — cancelar assinatura Asaas não cancelava no Asaas.** As duas actions de `manage-billing` chamavam `cancelStripeSubscription` direto sob `if (sub.stripe_subscription_id)`; numa assinatura Asaas essa coluna é `null`, então o provedor nunca era chamado, o banco gravava `canceled` e a cobrança seguia saindo. Corrigido por núcleo puro de roteamento ([billing-cancel-core.ts](../../supabase/functions/_shared/billing-cancel-core.ts), 12 testes) + adapter devolvendo o efeito REAL. Dormente até aqui porque nunca houve assinatura Asaas de cliente pagante.
2. **Tela de cobrança do lojista levava 403.** `get_organization_billing` era admin-only: owner/gerente real nunca via o card de plano nem o botão de cancelar. Liberada com as duas proteções (guard de org + resposta moldada por papel).
3. **Vazamento a `anon` fechado pela migration 086** — ver Risco 10 acima.

Ao longo da correção, os gates acharam e fecharam mais quatro consequências: cancelamento pelo lojista não encerrava o acesso (cascata faltando), um `gerente` de uma única unidade podia derrubar a organização inteira (agora exige `owner`), `create_subscription` produzia assinatura incancelável, e falha de leitura da assinatura virava "você não tem plano" na tela.

## Próxima fase

**FASE 6 — Integração Z-API (ciclo de vida da instância)**, per [01-PLANO-IMPLEMENTACAO.md](01-PLANO-IMPLEMENTACAO.md). Pré-requisito de negócio: confirmar acesso ao programa de parceiro/integrador Z-API antes de implementar de memória. Esta fase (5b) é o que torna a Fase 6 segura de construir sobre: suspender uma instância de verdade na Z-API sem primeiro ter suspendido o SERVIÇO internamente (o que esta fase entrega) desconectaria clientes que ainda deveriam ter acesso.
