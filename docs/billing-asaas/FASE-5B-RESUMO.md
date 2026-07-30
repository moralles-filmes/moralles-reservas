# FASE 5B — Enforcement por serviço de WhatsApp — Resumo de Execução

> Branch `billing-asaas/fase-5b`, base `46b8a6b` (plano + spec, sem código). 44 commits de código/documentação (`c63c9b8`..`5ff1852`) + esta task de fechamento (`d81469a` + o commit deste documento).
> Spec: [../superpowers/specs/2026-07-27-billing-asaas-fase-5b-design.md](../superpowers/specs/2026-07-27-billing-asaas-fase-5b-design.md).
> Plano: [../superpowers/plans/2026-07-27-billing-asaas-fase-5b.md](../superpowers/plans/2026-07-27-billing-asaas-fase-5b.md).
> Fase anterior: [FASE-5A-RESUMO.md](FASE-5A-RESUMO.md) (vendeu implantação R$750 + assinatura R$149 da instância, sem poder suspender ninguém — esta fase existe pra fechar exatamente essa lacuna).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing/WhatsApp
>
> **Código completo (21 tasks) e verificado localmente. NADA foi aplicado em produção.** Nenhuma das 7 migrations novas (077–080, 082–083 — ver nota sobre a numeração abaixo) rodou `db push`, nenhuma Edge Function foi deployada, o roteiro de sandbox (44 blocos verificáveis) está escrito mas não executado, e não houve merge/tag. Mesma decisão da 5a: a virada do Asaas fica em sandbox até a última fase do projeto.
>
> | | |
> |---|---|
> | Pipeline de código (Tasks 1–20 + fechamento) | ✅ completo, cada task revisada; a maioria exigiu 1–2 ciclos de fix |
> | `npm test` | ✅ **423/423** (baseline no início da fase era 265; +158 nesta fase: 5 núcleos puros novos) |
> | `npm run typecheck` (`tsc -b`) | ✅ 0 erros |
> | `npm run lint` | ✅ 0 erros, 22 warnings (pré-existentes, baseline inalterada) |
> | Migrations 077, 078, 079, 080, 082, 083 (082/083 são os crons dos 2 workers novos) | ✅ **criadas** — **NÃO aplicadas** (`db push` fica para o dono) |
> | Deploy das Edge Functions afetadas | ❌ **não feito** — lista completa no checklist de redeploy do [CLAUDE.md](../../CLAUDE.md) |
> | Gates `saas-shield-br` (`rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`, `migration-validator`, `secret-hunter`, `integration-reliability-auditor`) | ❌ **não rodados nesta task de fechamento** — obrigatórios antes de merge por tocar banco/webhook/RLS/multi-tenant ([CLAUDE.md](../../CLAUDE.md) § Fluxo obrigatório), ficam para o dono |
> | Roteiro de sandbox (44 blocos, C1–C31 com sub-itens) | 📝 **escrito**, não executado — [FASE-5B-ROTEIRO-SANDBOX.md](FASE-5B-ROTEIRO-SANDBOX.md) |
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
- **Estacionamento de jobs** — o outbox de confirmação volta a `pending` sem incrementar `attempts` durante a suspensão (não gasta o teto de 5 tentativas); os outros 5 workers de notificação pulam a unidade sem gravar `notifications_sent`. Job vencido durante a suspensão não é enviado depois de restaurada (checagem "reserva no passado" antes de despachar).
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

### 2. `process-voucher-triggers` trata suspensão como "o evento nunca aconteceu" para aniversário — decisão de produto ainda do dono

Os dois workers de voucher (`processBirthday`, `processFrequency` em `supabase/functions/process-voucher-triggers/index.ts:230-234` e `:336-340`) pulam a REGRA inteira (`continue`, sem criar voucher nenhum) quando `resolveWhatsAppGateByUnit(...).enforced.sending` é `true` para a unidade. A assimetria importa:

- **Regra de FREQUÊNCIA é só adiada.** A janela de elegibilidade é recalculada a partir de "agora" a cada execução — se a unidade for suspensa hoje e desbloqueada amanhã, o cliente ganha o voucher amanhã, sem perda.
- **Regra de ANIVERSÁRIO é perdida pra sempre.** O gatilho é `mmdd(customer.birthday) === mmdd(hoje)`, sem retentativa nenhuma — se a unidade estiver suspensa no dia exato do aniversário do cliente, a data passa e o voucher DAQUELE ANO nunca é criado (29/02 tem a mesma exposição, além da regra civil de ano não-bissexto já documentada no CLAUDE.md).

Este é o **único ponto de toda a fase** onde suspensão vira "o evento nunca aconteceu" em vez de "a mensagem foi adiada" — em todo o resto (outbox de confirmação, lembretes, pesquisas de satisfação), o efeito da suspensão é atraso, não perda. **Alternativa recomendada pela revisão, ainda não decidida pelo dono:** criar o voucher SEMPRE (preserva o entitlement, resgatável no balcão mesmo sem anúncio via WhatsApp) e gatear só o ENVIO da mensagem por `enforced.sending`. Isto é uma decisão de produto explícita a tomar antes de ligar `whatsapp_service_enforcement` em produção — hoje ninguém decidiu, e o comportamento atual (perda silenciosa) é o que roda se nada mudar.

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

## Gates de segurança (`saas-shield-br`)

**Três rodados no fechamento desta fase, os três PASS com zero bloqueantes:**

- **`tenant-isolation-auditor`** — PASS_WITH_WARNINGS. Confirmou que o cache de módulo do gate é indexado por organização/unidade e que os 15 consumidores chamam `clearWhatsAppGateCache()` antes de qualquer `resolveWhatsAppGateBy*`; resultados com `readFailed` nunca são cacheados; toda action de `manage-channels` escopa por `id` **e** `unit_id`. Um P2: `resolveBillingRecipient` não confere o erro da query de `units`, então falha transitória é indistinguível de "org sem unidades" e o aviso é suprimido em silêncio — não é vazamento, o escopo por organização está correto.
- **`migration-validator`** — PASS_WITH_WARNINGS. Diffou a RPC `resolve_or_activate_subscription` linha a linha contra a 073: assinatura, `security definer`, `search_path` e os `revoke`/`grant` byte-idênticos, com os dois blocos novos estritamente aditivos e shape de retorno inalterado. Wrappers de cron 082/083 sem drift em relação à 064; `verify_jwt=false` presente para as duas EFs novas. Dois P2/P3: as colunas novas de grandfathering legíveis por `anon` (ver abaixo) e o backfill da 079 refletir o estado no momento do `db push`, não no da autoria.
- **`secret-hunter`** — PASS. `rotate_secret` nunca loga o secret gerado; o roteiro de sandbox é 100% placeholder. O P2 sobre o `.env` local foi fechado por verificação direta: `git ls-files .env` e `git log --all -- .env` vazios — nunca rastreado, nunca commitado.

**Achado dos gates que exige decisão do dono, ainda aberto:** a policy pré-existente `public_read_organizations` é `for select to anon using (is_public = true)` **sem lista de colunas**, e RLS filtra linha, não coluna. As seis colunas novas de grandfathering — incluindo `whatsapp_grandfather_revoked_by`, um UUID de `auth.users` — ficam legíveis por qualquer visitante com a anon key pública do bundle, para toda organização com `is_public=true` (o default). A categoria é pré-existente (a mesma policy já expõe `billing_status` e `trial_ends_at`), mas esta fase a alarga, e a policy contradiz o invariante do próprio `CLAUDE.md` ("anon lê só por RPCs `SECURITY DEFINER`; policy `TO anon` direto em tabela de negócio é regressão"). Não corrigido aqui porque mexer nessa policy afeta o portal público inteiro — merece task e revisão próprias, logo após o merge.

**Os outros três gates (`rls-auditor`, `identity-access-auditor`, `integration-reliability-auditor`) não foram rodados** e continuam obrigatórios antes do merge por definição do fluxo do projeto (`CLAUDE.md` § Fluxo obrigatório para agentes).

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
- Risco 2 — decisão de produto sobre o voucher de aniversário (perder o ano vs. criar sempre e gatear só o envio). Hoje ninguém decidiu, e o comportamento que roda por omissão é a perda permanente. Recomendação da revisão: criar sempre, gatear só o envio.
- Risco 6 — reaper (ou janela de staleness) para `notification_outbox` preso em `processing`. O estacionamento de jobs é o que torna esse caminho alcançável, e o estacionamento só acontece sob suspensão aplicada.
- Risco 4 — decidir se o fluxo de TEXTO passa a usar `systemBlocksDependentServices` como o de mídia já usa. Ligar a flag muda o comportamento de organização `canceled` no caminho de texto de um jeito ou de outro; deve ser decisão, não efeito colateral. Junto disso: hoje `enforced.sending` carrega `systemBlocked` dentro de si, então a flag de enforcement também gateia consequência de bloqueio de SISTEMA em caminhos que nada têm a ver com o add-on de WhatsApp — e o resultado é registrado sob o outcome `whatsapp_service_suspended`, um rótulo de cobrança de WhatsApp para uma causa de acesso ao sistema. Só o gate de mídia (`decideInboundAutoReply`) mantém as duas dimensões separadas, como o núcleo documenta que deveriam ser.

**Sem etapa vinculada** (follow-ups sem gate): riscos 1 (FK da 062) e 3 (`whatsapp_restored` raro).

## Resultado do sandbox

**Não executado.** O roteiro completo (44 blocos verificáveis: C1–C31, com sub-itens C24a–C24g e C24h–C24m) está escrito e pronto pra execução em [FASE-5B-ROTEIRO-SANDBOX.md](FASE-5B-ROTEIRO-SANDBOX.md), com passo a passo verificável, SQL de observação e resultado esperado objetivo para cada cenário — inclusive o SQL pronto pra forçar cada estado financeiro (`PAID`/`IN_GRACE`/`OVERDUE_BEYOND_GRACE`/`CANCELED`/`NO_SUBSCRIPTION`) sem depender de esperar ciclos reais do Asaas. Quem rodar o roteiro preenche a coluna de resultado real naquele documento e traz o veredito de volta para este resumo antes de merge/tag.

## Rollback

- **Desligar as duas flags** (`billing_invoice_ingestion`, `whatsapp_service_enforcement`) — envio volta a funcionar sem gate nenhum, e a ingestão automática de fatura para. Nada é perdido: as migrations são aditivas.
- **`update platform_flags set value='false'::jsonb where key='whatsapp_service_enforcement';`** sozinho já reverte só a consequência de suspensão, mantendo a ingestão financeira rodando em observação — é o modo intermediário pensado pela própria ordem de ativação da §9.
- **Migrations ficam** — `enforcement_hold`, os timestamps de suspensão/restauração e o grandfathering não têm efeito nenhum com as flags OFF; não há necessidade de reverter schema.
- **Grandfathering revogado é irreversível por design** (decisão do dono) — não existe rollback de `whatsapp_grandfather_revoked_at` além de ação administrativa explícita nova.
- Rollback específico de cada migration está no rodapé do próprio arquivo `.sql`.

## Próxima fase

**FASE 6 — Integração Z-API (ciclo de vida da instância)**, per [01-PLANO-IMPLEMENTACAO.md](01-PLANO-IMPLEMENTACAO.md). Pré-requisito de negócio: confirmar acesso ao programa de parceiro/integrador Z-API antes de implementar de memória. Esta fase (5b) é o que torna a Fase 6 segura de construir sobre: suspender uma instância de verdade na Z-API sem primeiro ter suspendido o SERVIÇO internamente (o que esta fase entrega) desconectaria clientes que ainda deveriam ter acesso.
