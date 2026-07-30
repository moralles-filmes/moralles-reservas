# Roteiro de sandbox — Fase 5b

> **Status: ESCRITO, NÃO EXECUTADO.** Roteiro executável dos 31 cenários numerados da §11 da spec ([2026-07-27-billing-asaas-fase-5b-design.md](../superpowers/specs/2026-07-27-billing-asaas-fase-5b-design.md), 24 tem 7 subitens `a`–`g` e 6 subitens `h`–`m` — total 44 blocos verificáveis), mais o passo a passo da ordem de ativação de flags da §9. Quem rodar preenche a coluna "Real" da tabela de resumo e a seção "Resultado observado" de cada cenário, e traz o veredito consolidado para [FASE-5B-RESUMO.md](FASE-5B-RESUMO.md) antes de merge/tag.
>
> Pré-requisito: o roteiro da [Fase 5a](FASE-5A-ROTEIRO-SANDBOX.md) concluído (checkout de implantação, checkout de instância, overrides), migrations 077, 078, 079, 080, 082, 083 aplicadas (`supabase db push`), e as EFs afetadas redeployadas — lista no checklist de redeploy do `CLAUDE.md`. **A ordem é obrigatória: migrations antes do deploy do `manage-channels`** — o gate de novo provisionamento (Task 16) falha fechado, e coluna ainda inexistente (078/079) vira 403 `PROVISIONING_UNVERIFIABLE` pra toda unidade sem canal, inclusive para `platform_admin`. Use `ASAAS_ENV=sandbox`. **As duas flags novas da 5b (`billing_invoice_ingestion`, `whatsapp_service_enforcement`) começam OFF** — a seção 0.2 abaixo é o procedimento pra ligá-las na ordem segura, e a maioria dos cenários deste roteiro roda com as duas LIGADAS (senão o elo financeiro não cria fatura nenhuma pra observar).

## 0.1 Preparação (fazer uma vez, antes do C1)

1. **Organização de teste** — igual à 5a: NÃO usar Ren Sushi (override `LIFETIME`) nem Moralles. Reuse a mesma org da 5a se ainda tiver implantação `COMPLETED` e assinatura `WHATSAPP_SUBSCRIPTION` ativa (cenários deste roteiro partem daí); senão repita B1→B10 da 5a primeiro.
   ```sql
   select id, name, billing_status, whatsapp_legacy_grandfathered, whatsapp_grandfather_revoked_at
     from organizations where slug = '<slug-org-teste>';
   select bs.id, bs.status, bp.category from billing_subscriptions bs
     join billing_plans bp on bp.id = bs.billing_plan_id
    where bs.organization_id = '<org-id>' and bs.status <> 'canceled';
   ```
2. **Uma SEGUNDA org de teste "legada"** — sem assinatura de WhatsApp nenhuma, `billing_status` normal. Depois da migration 079, ela deve estar com `whatsapp_legacy_grandfathered=true` (backfill automático, ver query de relatório no rodapé da 079) SE já tinha uso de WhatsApp antes da fase; senão fica `NOT_ENTITLED`. Confirme qual dos dois casos ela é antes de usar nos cenários 19–22, 24e, 24j.
3. **Um jeito de invocar workers manualmente**, sem esperar o cron:
   ```bash
   curl -X POST https://<project-ref>.supabase.co/functions/v1/<nome-do-worker> \
     -H "x-internal-key: $INTERNAL_API_KEY"
   ```
   Vale para `process-asaas-invoice-reconcile`, `process-whatsapp-enforcement`, `process-billing-overdue`, `process-billing-reminders`, `process-notification-outbox`, `process-trial-expiry`. `INTERNAL_API_KEY` sai do Vault/`supabase secrets list` — nunca commitar o valor.
4. **Flags no início do roteiro** (anote os valores — a limpeza final devolve ao estado original):
   ```sql
   select key, value from platform_flags
    where key in ('asaas_enabled', 'whatsapp_implementation_flow', 'whatsapp_subscription_checkout',
                   'billing_invoice_ingestion', 'billing_invoice_ingestion_since',
                   'whatsapp_service_enforcement', 'billing_notifications_dispatch');
   ```

## 0.2 Ordem de ativação das flags (§9 da spec) — executar ANTES dos cenários que exigem ingestão real

A spec é explícita: as duas flags da 5b são **separadas de propósito** (uma controla entrada de dados, a outra a consequência) e têm ordem obrigatória. Passos 1–2 abaixo já devem estar feitos pelo runbook de deploy; os passos 3–6 são o que este roteiro valida.

1. **Deploy de banco e código, as duas flags OFF.** Confirme com a query da seção 0.1.4 acima que `billing_invoice_ingestion=false` e `whatsapp_service_enforcement=false`.
2. **Validar no sandbox (cenários C1–C10, C25–C26, C29–C30 deste roteiro) com as duas flags AINDA OFF.** Nesta janela, `asaas-webhook`/`process-asaas-reconcile` continuam rodando (ingestão de fatura é o que está OFF, não o webhook inteiro) — os cenários de renovação/correlação passam pela escada, mas SEM criar fatura de verdade (ver C1–C3 abaixo, que documentam o comportamento OFF explicitamente).
3. **Ligar `billing_invoice_ingestion`, gravando `billing_invoice_ingestion_since` no mesmo ato:**
   ```sql
   update platform_flags set value = to_jsonb(now()::date::text), updated_at = now()
    where key = 'billing_invoice_ingestion_since';
   update platform_flags set value = 'true'::jsonb, updated_at = now()
    where key = 'billing_invoice_ingestion';
   ```
   `billing_invoice_ingestion_since` é **obrigatória** quando a flag liga — `parseBillingIngestionSince` aborta o worker com erro fatal se estiver vazia/ausente/mal-formada (verificado em [asaas-invoice-reconcile-core.ts](../../supabase/functions/_shared/asaas-invoice-reconcile-core.ts), coberto por `describe("parseBillingIngestionSince")` em [asaas-invoice-reconcile-core.test.ts](../../src/lib/asaas-invoice-reconcile-core.test.ts)) — grave a data ANTES de ligar a flag, nunca depois.
   Enforcement **continua OFF** neste passo.
4. **Observar por pelo menos um ciclo do worker** (`process-asaas-invoice-reconcile`, `0 8 * * *`, ou invoque manualmente):
   - faturas criadas (`billing_invoices` novas com `ingestion_source` preenchido);
   - assinaturas correlacionadas (`billing_subscription_id` populado);
   - ambiguidades e duplicidades (`admin_correlation_ambiguity`/`admin_correlation_org_restamped` em `billing_notifications`);
   - pagamentos desconhecidos (log `asaas_reconcile_unresolved` ou equivalente);
   - telemetria de dry-run do enforcement (`evt: "whatsapp_enforcement_dryrun"` nos logs de `send-whatsapp`/`webhook-whatsapp`/`process-notification-outbox` etc. — é o sinal que sustenta o go/no-go do passo 6).
5. **Corrigir inconsistências e liberar holds legítimos** — usar o painel de faturas retidas (Cobrança → seção admin) ou `manage-billing` action `release_invoice_hold`. Este roteiro cobre a liberação em C14.
6. **Ligar `whatsapp_service_enforcement`:**
   ```sql
   update platform_flags set value = 'true'::jsonb, updated_at = now()
    where key = 'whatsapp_service_enforcement';
   ```
   A partir daqui, `enforced.sending` passa a valer de verdade — os cenários C15–C24m e C27–C28 assumem esta flag LIGADA, salvo quando o próprio cenário testa o comportamento com ela OFF (C23, C24a–c, C24l).

**Resultado observado (passo 0.2):** _(preencher — data/hora de cada ativação, quem executou, e o veredito da observação do passo 4)_

---

## 0.3 Relatório global de impacto do enforcement — levantado em 2026-07-30

> Pré-requisito da §6 da autorização de virada, feito **antes** de qualquer flag ligar.
> Leitura pura, nenhuma escrita. Ambiente confirmado: `ASAAS_ENV=sandbox`.

| org | sistema | grandf. | override WA | override sys | assin. WA | vencidas | hold | canais conectados | jobs pendentes |
|---|---|---|---|---|---|---|---|---|---|
| `moralles` | active | não | **1** | 1 | 0 | 0 | 0 | 0 | 0 |
| `ren-sushi` | active | **sim** | **1** | 1 | 0 | 0 | 0 | **1** | 0 |
| `seu-japa` | active | não | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Estado calculado e motivo determinante:**

- `moralles` → `OVERRIDE_ACTIVE` (override de `whatsapp` ativo). Plataforma, sem canal.
- `ren-sushi` → `OVERRIDE_ACTIVE` (override vence grandfathering na ordem do gate). **É a única org com canal conectado.** Não bloquearia envio nem provisionamento.
- `seu-japa` → `NOT_ENTITLED` (sem override, sem assinatura, sem grandfathering). Não bloqueia envio nesta fase (C20) e não tem canal — impacto nulo.

**Condições da §6, todas satisfeitas:** zero faturas vencidas, zero `enforcement_hold`, zero ambiguidade de assinatura, zero fatura com valor ausente, zero jobs pendentes, nenhuma org real em `SUSPENDED_UNPAID`/`ADMIN_BLOCKED` inesperado, `ren-sushi` preservada pela regra legada, nenhum override concedido para maquiar o relatório.

**Conclusão:** ligar `whatsapp_service_enforcement` hoje seria inofensivo — **e é exatamente esse o problema**: não há nada para o enforcement enforçar. A virada só produz evidência depois que a fixture paga existir. Ver §0.4.

## 0.4 Bloqueio de execução — o B1→B10 exige navegador

O roteiro B1→B10 da 5a **não é executável por API**. O fluxo abre um **checkout hospedado
`DETACHED` no Asaas** (cartão + PIX) e o pagamento acontece **naquela página**:

- **B4** — "Pagar com cartão de teste" na página do Asaas sandbox;
- **B5** — "Reenviar o mesmo evento **pelo painel Asaas**";
- **B1/B2/B3** — cliques em `/g/<slug>/cobranca` e observação da tela.

Para checkout `DETACHED`, o objeto `payment` **só nasce quando o pagador preenche o formulário**.
Não há endpoint de simulação que crie o pagamento sem essa etapa — `receiveInCash` do sandbox
exige um `payment` que ainda não existe.

**Consequência:** sem a fixture paga não há implantação `COMPLETED`, nem assinatura
`WHATSAPP_SUBSCRIPTION` ativa, nem correlação Asaas — e sem isso os ~30 blocos que dependem
delas (C1–C18, C21–C22, C24a–g, C25–C31) não têm sobre o que rodar, e a observação da ingestão
(§5 da virada) não teria fatura nenhuma para ingerir.

**Não construí a fixture legada sozinha:** os cenários dela (C19–C22, C24e, C24j) exigem
`whatsapp_service_enforcement` ON, e ligar a flag sem a fixture paga validaria o vazio. Criar
metade da fixture deixaria uma org órfã em produção sem mecanismo de arquivamento (§9).

## Resumo dos cenários (preencher "Real" ao executar)

| # | Cenário | Esperado | Real |
|---|---|---|---|
| C1 | Renovação do sistema correlacionada por `provider_subscription_id` | Fatura mês 2+ vinculada à assinatura certa, sem `checkoutSession` | ☐ |
| C2 | Renovação do WhatsApp correlacionada por `provider_subscription_id` | Idem, categoria `WHATSAPP_SUBSCRIPTION` | ☐ |
| C3 | Renovação sem sessão de checkout processada normalmente | Sem erro, fatura criada, sem exigir `checkoutSession` | ☐ |
| C4 | Webhook e reconcile no mesmo pagamento | Uma única fatura, não duas | ☐ |
| C5 | Evento Asaas duplicado (reentrega) | Nenhum efeito duplicado (fatura/tolerância/aviso/suspensão/restauração) | ☐ |
| C6 | Evento fora de ordem | Estado final correto independente da ordem de chegada | ☐ |
| C7 | Duas assinaturas não-canceladas da mesma categoria | Falha alta, log, ZERO escrita | ☐ |
| C8 | Divergência de organização entre degraus | Evento derrubado, ZERO escrita | ☐ |
| C9 | Cobrança do WhatsApp nunca altera `billing_status` | Coluna intocada | ☐ |
| C10 | Cobrança do sistema altera `billing_status` corretamente | Bloqueia/desbloqueia conforme o caso | ☐ |
| C11 | Fatura `BACKFILL` vencida recebe hold | `enforcement_hold=true` | ☐ |
| C12 | Fatura normal achada pelo reconcile após o vencimento | SEM hold só por isso | ☐ |
| C13 | Fatura paga/void/estornada nunca entra em hold por atraso | Sem hold | ☐ |
| C14 | Liberação de hold | Admin, data e motivo registrados | ☐ |
| C15 | Sistema suspenso bloqueia WhatsApp mesmo com override ativo | Envio bloqueado apesar do override | ☐ |
| C16 | Override ativo só prevalece sobre inadimplência do WhatsApp | Não sobrepõe bloqueio de sistema | ☐ |
| C17 | D+5 tolerância / D+6 suspende | Fronteira exata | ☐ |
| C18 | `GRACE_PERIOD`: envio ok, provisionamento novo bloqueado | Duas respostas certas | ☐ |
| C19 | `LEGACY_GRANDFATHERED`: uso ok, provisionamento novo bloqueado | Idem | ☐ |
| C20 | `NOT_ENTITLED`: não bloqueia envio nesta fase, bloqueia provisionamento | Idem | ☐ |
| C21 | Org legada ativa assinatura paga → perde grandfathering | `whatsapp_grandfather_revoked_at` preenchido, `reason='FIRST_PAID_SUBSCRIPTION'` | ☐ |
| C22 | Cancelar a assinatura depois NÃO restaura o grandfathering | Revogação permanece | ☐ |
| C23 | Flag de enforcement OFF: calcula `SUSPENDED_UNPAID`, não bloqueia envio | `state` real, `enforced.sending=false` | ☐ |
| C24 | Sistema vencido bloqueia a org inteira; WhatsApp vencido bloqueia só WhatsApp | Efeitos isolados por categoria | ☐ |
| C24a | Flag OFF + `ACTIVE` → provisionamento liberado | `allowed=true` | ☐ |
| C24b | Flag OFF + `SUSPENDED_UNPAID` → provisionamento bloqueado | `blockReason=SERVICE_STATE` | ☐ |
| C24c | Falha na leitura da flag não interfere no provisionamento | Mesmo resultado com flag ilegível | ☐ |
| C24d | Falha na leitura de estado/entitlement → bloqueia provisionamento | `blockReason=STATE_READ_FAILED`, com flag em qualquer valor | ☐ |
| C24e | `LEGACY_GRANDFATHERED`: uso ok, instância nova bloqueada | Idem C19 | ☐ |
| C24f | `OVERRIDE_ACTIVE` permite provisionamento | `allowed=true` | ☐ |
| C24g | Sistema suspenso bloqueia provisionamento mesmo com `OVERRIDE_ACTIVE` de WhatsApp | Gate pai vence | ☐ |
| C24h | `SUSPENDED_UNPAID` + enforcement ON → não responde mídia | Silêncio, zero custo | ☐ |
| C24i | `ADMIN_BLOCKED` + enforcement ON → não responde mídia | Silêncio | ☐ |
| C24j | Sistema suspenso → não responde mídia mesmo com override, independente da flag | Silêncio sempre | ☐ |
| C24k | `ACTIVE`/`OVERRIDE_ACTIVE` → respondem mídia normalmente | `MEDIA_REPLY_TEXT` enviado | ☐ |
| C24l | Enforcement dry-run + `SUSPENDED_UNPAID` → RESPONDE, decisão hipotética registrada | Responde + `agent_dryrun`/telemetria | ☐ |
| C24m | Nos casos bloqueados, zero chamada ao provedor (revisão de código) | Confirmado por leitura, não testável isolado | ☐ |
| C25 | Pagamento do sistema não regulariza WhatsApp e vice-versa | Isolamento total | ☐ |
| C26 | Regularização restaura só o serviço correspondente | Idem | ☐ |
| C27 | Jobs estacionados não gastam tentativas | `attempts` intocado após estacionar | ☐ |
| C28 | Jobs vencidos não são enviados após a restauração | `stillValid` recusa | ☐ |
| C29 | Falha de notificação não impede atualização financeira | Fatura/assinatura atualizam mesmo com aviso falhando | ☐ |
| C30 | Falha do Asaas na reconciliação não corrompe estado interno | Sem escrita parcial | ☐ |
| C31 | Nenhuma compra mensal de WhatsApp liberada antes do enforcement ativo | `whatsapp_subscription_checkout` só ON após C1–C30 concluídos | ☐ |

---

## Elo financeiro (C1–C14)

### C1 — Renovação do sistema correlacionada por `provider_subscription_id`

**Cobertura primária:** `describe("resolveCorrelation")` em [billing-correlation-core.test.ts](../../src/lib/billing-correlation-core.test.ts) já prova a escada em isolamento; este cenário valida a FIAÇÃO ponta a ponta.

**Passos:**
1. Com a org de teste tendo assinatura `SYSTEM_SUBSCRIPTION` ativa (criada via checkout na 4b/5a — já correlacionada por `checkoutSession` no 1º ciclo), gere uma 2ª cobrança pra essa assinatura sem passar por checkout novo: no painel Asaas sandbox, abra a assinatura e veja se há opção de gerar cobrança avulsa vinculada (`subscription: <id>`), ou aguarde o próprio ciclo da assinatura gerar a próxima cobrança automaticamente.
2. Confirme o pagamento (cartão de teste aprovado ou "CONFIRMAR PAGAMENTO").

**Observar:**
```sql
select id, billing_subscription_id, external_reference, status, due_date from billing_invoices
 where organization_id = '<org-id>' order by created_at desc limit 3;
```
Nos logs de `asaas-webhook`/`process-asaas-reconcile`, procure `evt` da correlação (nível de log da escada — `winning_source`).

**Esperado:** nova fatura com `billing_subscription_id` apontando pra assinatura certa, `external_reference` NULL (a renovação não carrega — ver invariante do CLAUDE.md), correlação resolvida pelo degrau `provider_subscription_id`, não por `checkoutSession` nem `customer`.

**Resultado observado:** _(preencher)_

---

### C2 — Renovação do WhatsApp correlacionada por `provider_subscription_id`

**Passos/Observar:** idêntico ao C1, na assinatura `WHATSAPP_SUBSCRIPTION` da org de teste.

**Esperado:** mesma correlação, `billing_plans.category='WHATSAPP_SUBSCRIPTION'` na fatura resultante — e **confirme que `organizations.billing_status` não muda** (ver C9).

**Resultado observado:** _(preencher)_

---

### C3 — Renovação sem sessão de checkout processada normalmente

**Passos:** reusa o evento do C1 ou C2.

**Observar:** logs do aplicador — nenhum `failWith`/erro por ausência de `billing_checkout_sessions` correspondente.

**Esperado:** processamento normal, sem exigir uma sessão de checkout que nunca existiu para esse pagamento.

**Resultado observado:** _(preencher)_

---

### C4 — Webhook e reconcile processando o mesmo pagamento

**Passos:**
1. Deixe o `PAYMENT_CONFIRMED` do C1/C2 ser processado pelo webhook normalmente.
2. Invoque `process-asaas-invoice-reconcile` manualmente logo em seguida (mesmo payment_id na janela do reconcile).

**Observar:**
```sql
select count(*) from billing_invoices where provider_payment_id = '<payment-id-do-asaas>';
```

**Esperado:** **1** linha, não 2 — `decideReconcileAction` trata o pagamento já conhecido como liquidação, não como fatura nova.

**Resultado observado:** _(preencher)_

---

### C5 — Evento duplicado (reentrega do Asaas)

**Passos:** no painel Asaas (sandbox) → Webhooks → histórico, reenvie o mesmo evento `PAYMENT_CONFIRMED` do C1.

**Observar:**
```sql
select count(*), max(updated_at) from billing_invoices where provider_payment_id = '<payment-id>';
select count(*) from billing_notifications where organization_id = '<org-id>' and event_type like 'whatsapp_%' or event_type like 'system_%';
```

**Esperado:** idempotência total — mesma fatura, `billing_events` UNIQUE `(provider, provider_event_id)` barra o reprocessamento, sem 2º aviso, sem suspender/restaurar de novo.

**Resultado observado:** _(preencher)_

---

### C6 — Evento fora de ordem

**Passos:** se o Asaas permitir escolher `Tipo de envio: NON_SEQUENTIALLY` (§3 do runbook), dispare `PAYMENT_OVERDUE` antes de `PAYMENT_CONFIRMED` para o mesmo payment (ou simule reenviando na ordem invertida pelo histórico).

**Observar:** estado final da fatura/assinatura depois dos dois eventos.

**Esperado:** o estado final converge para o correto (pago) independente da ordem de chegada — a aplicação lê o estado atual do provedor, não confia cegamente na sequência de eventos.

**Resultado observado:** _(preencher)_

---

### C7 — Duas assinaturas não-canceladas da mesma categoria

**Cobertura primária:** guard de ambiguidade em `resolveWhatsAppGateByOrg`/worker (`.maybeSingle()` levantando `PGRST116` seria o sintoma sem o guard).

**Passos:**
```sql
-- Numa org de teste isolada, force duas assinaturas WHATSAPP_SUBSCRIPTION vivas.
-- billing_customer_id é NOT NULL — reusa o billing_customers já existente da org.
insert into billing_subscriptions (organization_id, billing_customer_id, billing_plan_id, status, provider, provider_subscription_id)
select '<org-id>', bc.id, (select id from billing_plans where category='WHATSAPP_SUBSCRIPTION' limit 1), 'active', 'asaas', 'sub_teste_dup'
  from billing_customers bc where bc.organization_id = '<org-id>';
```
(A org já deve ter uma primeira assinatura `WHATSAPP_SUBSCRIPTION` ativa — este INSERT cria a segunda, de propósito, pra reproduzir a ambiguidade.)

**Observar:** logs de `process-whatsapp-enforcement` (`ADMIN_AMBIGUITY_EVENT_TYPE`/`admin_correlation_ambiguity`) e:
```sql
select organizations.billing_status from organizations where id = '<org-id>';
select event_type from billing_notifications where organization_id = '<org-id>' and event_type = 'admin_correlation_ambiguity' order by created_at desc limit 1;
```

**Esperado:** falha registrada em log de alta severidade + aviso `admin_correlation_ambiguity` ao platform admin (dedupe 24h), **zero escrita** em `billing_status`/`suspended_at` — a org fica intocada até um humano resolver a duplicata.

**Limpeza:** apague a assinatura de teste inserida acima.

**Resultado observado:** _(preencher)_

---

### C8 — Divergência de organização entre degraus

**Cobertura primária:** `describe("resolveCorrelation")` (caso `kind: "conflict"`) em [billing-correlation-core.test.ts](../../src/lib/billing-correlation-core.test.ts).

**Passos:** difícil de produzir organicamente no sandbox (exige um pagamento cujo `customer` do Asaas aponte pra uma org e cujo `externalReference`/`checkoutSession` aponte pra outra) — se não for viável reproduzir ao vivo, aceite a cobertura do vitest como suficiente e registre isso na tabela de resumo em vez de forçar um cenário artificial.

**Esperado (se reproduzido):** evento derrubado com `failWith`, log de alta severidade + `admin_correlation_ambiguity`, **zero escrita** em qualquer tabela de negócio.

**Resultado observado:** _(preencher — ou "não reproduzido, cobertura só por vitest")_

---

### C9 — Cobrança do WhatsApp nunca altera `organizations.billing_status`

**Passos:** reusa o pagamento do C2.

**Observar:**
```sql
select billing_status, updated_at from organizations where id = '<org-id>';
```
(capture ANTES e DEPOIS do pagamento confirmado)

**Esperado:** coluna e `updated_at` **intocados** pela cobrança de WhatsApp — só `SYSTEM_SUBSCRIPTION` escreve ali ([billing-category.ts](../../supabase/functions/_shared/billing-category.ts)).

**Resultado observado:** _(preencher)_

---

### C10 — Cobrança do sistema altera `billing_status` corretamente

**Passos:** reusa o pagamento do C1 (sistema).

**Observar:** mesma query do C9.

**Esperado:** `billing_status` transita corretamente (ex.: `past_due`→`active` se estava vencido, ou permanece `active` se já estava em dia).

**Resultado observado:** _(preencher)_

---

### C11 — Fatura `BACKFILL` vencida recebe hold

**Cobertura primária:** `describe("decideReconcileAction")` em [asaas-invoice-reconcile-core.test.ts](../../src/lib/asaas-invoice-reconcile-core.test.ts).

**Passos:** use uma cobrança do Asaas anterior a `billing_invoice_ingestion_since` (criada antes do go-live da ingestão) que ainda não tem `billing_invoices` correspondente e já está vencida. Rode `process-asaas-invoice-reconcile`.

**Observar:**
```sql
select ingestion_source, enforcement_hold, enforcement_hold_reason from billing_invoices
 where provider_payment_id = '<payment-id-antigo>';
```

**Esperado:** `ingestion_source='BACKFILL'`, `enforcement_hold=true`, `enforcement_hold_reason='MANUAL_REVIEW'` — não entra na régua de cobrança sem revisão humana.

**Resultado observado:** _(preencher)_

---

### C12 — Fatura normal achada pelo reconcile após o vencimento

**Passos:** deixe uma fatura RECONCILE (dentro da janela normal de ingestão, não backfill) vencer sem o webhook confirmar a tempo; rode o reconcile depois do vencimento.

**Observar:** mesma query do C11.

**Esperado:** `enforcement_hold=false` — vencer depois de criada não é motivo de hold; hold é só para o caso `BACKFILL`.

**Resultado observado:** _(preencher)_

---

### C13 — Fatura paga/void/estornada nunca entra em hold por atraso

**Passos:** repita C11/C12 com uma cobrança já paga, ou cancelada, ou estornada/chargeback (`classifyPaymentCollectibility` → `SETTLED`/`CANCELED`/`NON_COLLECTIBLE_*`).

**Esperado:** nenhuma delas resulta em `enforcement_hold=true` por atraso — só `NON_COLLECTIBLE_*` (estorno/chargeback) gera hold, mas por motivo `enforcement_hold_reason` diferente (não "atraso"), e `UNKNOWN` nunca vira `open` em silêncio.

**Resultado observado:** _(preencher)_

---

### C14 — Liberação de hold registra administrador, data e motivo

**Passos:**
1. Pegue uma fatura em hold (do C11).
2. Como platform_admin, no painel Cobrança (seção admin de faturas retidas), libere o hold — chama `manage-billing` action `release_invoice_enforcement_hold` com `{ invoice_id, reason }`.

**Observar:**
```sql
select enforcement_hold, enforcement_released_at, enforcement_released_by from billing_invoices where id = '<invoice-id>';
```

**Esperado:** `enforcement_hold=false`, `enforcement_released_at` e `enforcement_released_by` (uuid do admin) preenchidos — nunca liberação anônima.

**Resultado observado:** _(preencher)_

---

## Estados e gates (C15–C24)

**Cobertura primária de todo este bloco:** `describe("decideWhatsAppGate — ...")` em [whatsapp-service-state-core.test.ts](../../src/lib/whatsapp-service-state-core.test.ts). Os cenários abaixo validam a FIAÇÃO (gate real lendo banco real), não a lógica pura.

### Como forçar cada estado financeiro via SQL (usar nos cenários abaixo)

```sql
-- PAID (sem fatura aberta): não deixe nenhuma billing_invoices status='open' pra essa assinatura.
-- IN_GRACE (D+2, dentro dos 5 dias de tolerância):
update billing_invoices set status='open', due_date = (current_date - interval '2 days')::date, enforcement_hold=false
 where billing_subscription_id = '<sub-id>' and id = '<invoice-id>';
-- OVERDUE_BEYOND_GRACE (D+6):
update billing_invoices set status='open', due_date = (current_date - interval '6 days')::date, enforcement_hold=false
 where billing_subscription_id = '<sub-id>' and id = '<invoice-id>';
-- CANCELED: update billing_subscriptions set status='canceled', canceled_at=now() where id='<sub-id>';
-- NO_SUBSCRIPTION: nenhuma linha billing_subscriptions WHATSAPP_SUBSCRIPTION não-cancelada pra essa org.
```

### C15 — Sistema suspenso bloqueia WhatsApp mesmo com override ativo

**Passos:** force `organizations.billing_status='suspended'` (ou `blocked`/`canceled`) na org de teste, com um override `whatsapp` ativo já concedido (B14 da 5a).

**Observar:** tente enviar uma mensagem manual (`send-manual-message`) ou aguarde o outbox processar.

**Esperado:** envio bloqueado (`enforced.sending=true` via `systemBlocked`) — o gate pai vence o override, que só cobre inadimplência do WhatsApp, não bloqueio de sistema.

**Resultado observado:** _(preencher)_

---

### C16 — Override ativo só prevalece sobre inadimplência do WhatsApp

**Passos:** com `billing_status='active'` (sistema OK) e a assinatura WhatsApp em `OVERDUE_BEYOND_GRACE`, conceda o override `whatsapp`.

**Esperado:** `state=OVERRIDE_ACTIVE`, `sendingBlocked=false` — envio funciona.

**Resultado observado:** _(preencher)_

---

### C17 — D+5 tolerância / D+6 suspende

**Passos:** force a fatura pra D+5 exato, confirme `state=GRACE_PERIOD`; mude pra D+6, confirme `state=SUSPENDED_UNPAID`.

**Observar:** chame `get_service_status` (`manage-whatsapp-implementations`) nos dois momentos.

**Esperado:** fronteira exata na virada de D+5 para D+6 (`BLOCK_AFTER_DAYS=6`).

**Resultado observado:** _(preencher)_

---

### C18 — `GRACE_PERIOD`: envio ok, provisionamento novo bloqueado

**Passos:** com a assinatura em D+2 (`IN_GRACE`), tente enviar uma mensagem E tente criar um canal WhatsApp novo (`manage-channels` action `create`).

**Esperado:** envio funciona; criação de canal recusada com `provisioning.blockReason=SERVICE_STATE`.

**Resultado observado:** _(preencher)_

---

### C19 — `LEGACY_GRANDFATHERED`: uso ok, provisionamento novo bloqueado

**Passos:** use a 2ª org de teste (0.1.2), confirmada como `whatsapp_legacy_grandfathered=true` e `whatsapp_grandfather_revoked_at IS NULL`, sem assinatura WhatsApp nenhuma (`NO_SUBSCRIPTION` mapeia pra `LEGACY_GRANDFATHERED` quando o flag está ativo). Envie mensagem; tente criar canal novo.

**Esperado:** envio funciona (uso existente preservado); criação de canal recusada.

**Resultado observado:** _(preencher)_

---

### C20 — `NOT_ENTITLED`: não bloqueia envio nesta fase, bloqueia provisionamento

**Passos:** use uma org sem grandfathering e sem assinatura (`NO_SUBSCRIPTION` + `isLegacyGrandfathered=false`). Envie mensagem; tente criar canal novo.

**Esperado:** `sendingBlocked=false` (decisão de produto explícita desta fase — `NOT_ENTITLED` não é motivo de bloqueio de envio ainda); `newProvisioningBlocked=true`.

**Resultado observado:** _(preencher)_

---

### C21 — Org legada que ativa assinatura paga perde o grandfathering

**Passos:** na org do C19 (`LEGACY_GRANDFATHERED` ativo), contrate e pague a assinatura `WHATSAPP_SUBSCRIPTION` (fluxo B9→B10 da 5a).

**Observar:**
```sql
select whatsapp_grandfather_revoked_at, whatsapp_grandfather_revoked_reason from organizations where id = '<org-id>';
```

**Esperado:** `whatsapp_grandfather_revoked_at` preenchido, `whatsapp_grandfather_revoked_reason='FIRST_PAID_SUBSCRIPTION'` — a RPC `resolve_or_activate_subscription` grava a revogação no mesmo ato da ativação.

**Resultado observado:** _(preencher)_

---

### C22 — Cancelar a assinatura depois NÃO restaura o grandfathering

**Passos:** na org do C21, cancele a assinatura WhatsApp recém-paga (`manage-billing` `cancel_subscription`).

**Observar:** mesma query do C21, mais o `state` resultante (`get_service_status`).

**Esperado:** `whatsapp_grandfather_revoked_at` continua preenchido (revogação é terminal); a org cai em `NOT_ENTITLED`, não volta a `LEGACY_GRANDFATHERED`.

**Resultado observado:** _(preencher)_

---

### C23 — Flag de enforcement OFF: calcula `SUSPENDED_UNPAID`, não bloqueia envio

**Passos:** com `whatsapp_service_enforcement=false` (desligue temporariamente se já ligou na 0.2), force uma assinatura WhatsApp em D+6.

**Observar:** `get_service_status` → `serviceState` vs envio real de uma mensagem de teste.

**Esperado:** `serviceState='SUSPENDED_UNPAID'` (estado real, calculado independente da flag), mas a mensagem É enviada (`enforced.sending=false`, dry-run) — e o banner no `/g/<slug>/cobranca`/`/g/<slug>/conversas` usa o tempo verbal do FUTURO (ver invariante do CLAUDE.md sobre `sendingBlocked` vs `serviceState`), nunca "já foi suspensa".

**Resultado observado:** _(preencher)_

---

### C24 — Sistema vencido bloqueia a org inteira; WhatsApp vencido bloqueia só WhatsApp

**Passos:** em duas orgs de teste separadas — uma com o SISTEMA vencido (D+6, `billing_status='blocked'`), outra só com a assinatura de WHATSAPP vencida (sistema `active`) — tente: reservar pela `/r/<slug>` (deve falhar só na 1ª), enviar mensagem WhatsApp (deve falhar nas duas, mas por motivos diferentes: `org_billing_blocked` vs `whatsapp_service_suspended`).

**Esperado:** efeitos isolados por categoria — nenhuma cobrança de instância derruba o sistema, nenhuma cobrança de sistema é confundida com WhatsApp.

**Resultado observado:** _(preencher)_

---

## Elegibilidade de novo provisionamento — independente da flag de enforcement (C24a–C24g)

**Cobertura primária:** `describe("resolveProvisioningEligibility")` em [whatsapp-service-state-core.test.ts](../../src/lib/whatsapp-service-state-core.test.ts). Estes 7 cenários validam que `manage-channels` (action `create`) e `manage-whatsapp-implementations` de fato chamam essa função — não reimplementam a checagem.

| Cenário | Setup | Esperado |
|---|---|---|
| C24a | flag OFF + `ACTIVE` | `allowed=true` — nunca recusar por "flag desligada" |
| C24b | flag OFF + `SUSPENDED_UNPAID` | `allowed=false`, `blockReason=SERVICE_STATE` |
| C24c | flag ilegível (force erro de leitura de `platform_flags`, ex. renomeie temporariamente a key e restaure) + `ACTIVE`/`SUSPENDED_UNPAID` | mesmo resultado dos dois casos acima — a falha da flag não muda nada aqui |
| C24d | falha na leitura de `organizations`/overrides/assinatura/fatura (ex. RLS temporário ou org inexistente) | `allowed=false`, `blockReason=STATE_READ_FAILED`, com a flag em qualquer valor |
| C24e | `LEGACY_GRANDFATHERED` | `allowed=false` (igual C19) |
| C24f | `OVERRIDE_ACTIVE` | `allowed=true` |
| C24g | sistema suspenso + `OVERRIDE_ACTIVE` de WhatsApp | `allowed=false` — o gate pai vence mesmo com override |

**Passos gerais:** para cada linha, ajuste o estado da org (SQL da seção "Como forçar cada estado" acima + overrides), tente `manage-channels` action `create` num canal novo, confira a resposta HTTP (200 vs 403/409 com `provisioning.blockReason` no corpo).

**Resultado observado (por linha):** _(preencher na tabela de resumo)_

---

## Resposta automática a áudio, imagem e sticker (C24h–C24m)

**Cobertura primária:** `describe("decideInboundAutoReply")` em [whatsapp-service-state-core.test.ts](../../src/lib/whatsapp-service-state-core.test.ts).

### C24h — `SUSPENDED_UNPAID` + enforcement ON → não responde mídia

**Passos:** com a flag ON e a assinatura em D+6, envie um áudio pro número WhatsApp da unidade de teste.

**Observar:** logs de `webhook-whatsapp` (`outcome: media_response` NÃO deve aparecer; espere `whatsapp_service_suspended` ou `inbound_persisted` sem resposta) e confirme no painel Z-API/WAHA que nenhuma mensagem foi enviada de volta.

**Esperado:** silêncio total — zero chamada ao provedor, zero custo.

**Resultado observado:** _(preencher)_

---

### C24i — `ADMIN_BLOCKED` + enforcement ON → não responde mídia

**Passos:** conceda um bloqueio administrativo (`organization_entitlement_overrides` com `feature='whatsapp'`, `enabled=false`) na org; envie um áudio.

**Esperado:** silêncio, mesmo padrão do C24h.

**Resultado observado:** _(preencher)_

---

### C24j — Sistema suspenso → não responde mídia mesmo com override, independente da flag

**Passos:** org com `billing_status='blocked'` E override `whatsapp` ativo; teste com a flag `whatsapp_service_enforcement` ON e depois OFF. Envie áudio nos dois casos.

**Esperado:** silêncio nos DOIS casos — `systemBlocked` nunca é gateado pela flag (mesmo tratamento que `org_billing_blocked` já dava ao fluxo de texto).

**Resultado observado:** _(preencher)_

---

### C24k — `ACTIVE`/`OVERRIDE_ACTIVE` → respondem mídia normalmente

**Passos:** org saudável, envie um áudio.

**Esperado:** recebe `MEDIA_REPLY_TEXT` hardcoded (nunca silêncio pra org em dia).

**Resultado observado:** _(preencher)_

---

### C24l — Enforcement em dry-run com `SUSPENDED_UNPAID` → RESPONDE, decisão hipotética registrada

**Passos:** flag `whatsapp_service_enforcement=false`, assinatura em D+6, envie um áudio.

**Observar:** resposta recebida no WhatsApp de teste + log `evt: "whatsapp_enforcement_dryrun"` ou equivalente com `would_block_sending=true`/`meta.media`.

**Esperado:** responde normalmente (dry-run não bloqueia nada), mas a telemetria registra que TERIA bloqueado com a flag ON — é o dado que sustenta o go/no-go do passo 6 da seção 0.2.

**Resultado observado:** _(preencher)_

---

### C24m — Nos casos bloqueados, decisão de silêncio sem chamada ao provedor

**Não é testável isoladamente em runtime** — é garantia de código (a decisão pura `decideInboundAutoReply` roda ANTES de qualquer `sendOutbound`, verificado por revisão do diff, não por teste automatizado, porque `supabase/functions/` não roda em CI). **Verificação:** releia `webhook-whatsapp/index.ts` no ramo de mídia e confirme que o branch `SILENT_*` retorna antes de qualquer chamada a `sendOutbound`/`whatsapp-providers.ts`.

**Resultado observado:** _(preencher — "confirmado por leitura de código, revisor: <nome>, commit: <sha>")_

---

## Regularização e jobs (C25–C31)

### C25 — Pagamento do sistema não regulariza WhatsApp; pagamento do WhatsApp não regulariza o sistema

**Passos:** com AS DUAS assinaturas vencidas (sistema D+6 blocked, WhatsApp D+6 suspended) na mesma org, pague só a do sistema. Confirme `get_service_status` do WhatsApp continua suspenso; depois pague o WhatsApp e confirme o sistema (se ainda vencido) continua bloqueado.

**Esperado:** isolamento total nos dois sentidos — mesma garantia do `billing-category.ts` da 5a, agora exercitada com faturas de verdade.

**Resultado observado:** _(preencher)_

---

### C26 — Regularização restaura apenas o serviço correspondente

**Passos:** reusa o C25 — depois de pagar o WhatsApp, confirme `billing_subscriptions.restored_at` preenchido SÓ na assinatura WhatsApp, `suspended_at` limpo só nela.

**Esperado:** coluna por coluna, só o serviço pago muda.

**Resultado observado:** _(preencher)_

---

### C27 — Jobs estacionados não gastam tentativas

**Cobertura primária:** comentário/lógica em [process-notification-outbox/index.ts](../../supabase/functions/process-notification-outbox/index.ts) (linhas 77–84, 169–188) — sem teste automatizado (Deno fora do CI).

**Passos:**
1. Suspenda o WhatsApp da org (D+6, flag ON).
2. Crie uma reserva nova que dispare confirmação via outbox (`notification_outbox` pendente).
3. Rode `process-notification-outbox` 2-3 vezes seguidas (invoke manual).

**Observar:**
```sql
select status, attempts, next_attempt_at, last_error from notification_outbox where reservation_id = '<res-id>';
```

**Esperado:** `status` permanece `pending` (estacionado, "parked"), `attempts=0` nas 2-3 rodadas — o teto de 5 tentativas não é consumido pela suspensão.

**Resultado observado:** _(preencher)_

---

### C28 — Jobs vencidos não são enviados depois da restauração

**Passos:** com o job estacionado do C27, avance a data/hora da reserva pro passado (ou espere o horário passar) ANTES de restaurar o pagamento. Restaure o pagamento (regularize a assinatura). Rode `process-notification-outbox`.

**Observar:**
```sql
select status, last_error from notification_outbox where reservation_id = '<res-id>';
select id from notifications_sent where reservation_id = '<res-id>';
```

**Esperado:** `last_error='reservation_in_the_past'` (ou equivalente), a linha NÃO gera `notifications_sent` — `stillValid` recusa enviar confirmação de reserva que já passou.

**Resultado observado:** _(preencher)_

---

### C29 — Falha de notificação não impede a atualização financeira

**Passos:** force uma falha no envio (ex.: `billing_notifications_dispatch` OFF, ou desconecte o canal WhatsApp da unidade) e processe um pagamento que deveria disparar aviso.

**Observar:**
```sql
select status from billing_invoices where id = '<invoice-id>';
select status from billing_notifications where organization_id = '<org-id>' order by created_at desc limit 1;
```

**Esperado:** a fatura/assinatura atualiza normalmente (`status='paid'`) mesmo com o aviso falhando ou ficando `pending`/`failed` na fila — a atualização financeira nunca depende do sucesso da notificação.

**Resultado observado:** _(preencher)_

---

### C30 — Falha do Asaas na reconciliação não corrompe estado interno

**Passos:** rode `process-asaas-invoice-reconcile` com a `asaas_api_key` temporariamente inválida (ou aponte pra um `ASAAS_ENV` errado) pra forçar erro de leitura do provedor.

**Observar:** logs (`asaas_payment_list_budget_exhausted` ou erro de autenticação) e:
```sql
select count(*) from billing_invoices where updated_at > now() - interval '5 minutes';
```

**Esperado:** worker aborta/pula sem escrever nada parcial — nenhuma fatura fica em estado inconsistente por causa de uma falha de rede/auth no meio da paginação.

**Limpeza:** restaure a `asaas_api_key` válida depois do teste.

**Resultado observado:** _(preencher)_

---

### C31 — Nenhuma compra mensal de WhatsApp é liberada antes do enforcement estar ativo

**Não é um teste de estado — é um GATE DE PROCESSO.** Confirme, olhando o histórico de mudança de `platform_flags` (`updated_at`) ou o ledger da fase, que `whatsapp_subscription_checkout` só foi para `true` em produção DEPOIS que os cenários C1–C30 deste roteiro (e o passo 0.2 inteiro) estavam concluídos e verificados — exatamente como a §9 da spec exige no "Gate de go-live".

**Resultado observado:** _(preencher — data em que `whatsapp_subscription_checkout` foi ligada, e confirmação de que veio depois deste roteiro)_

---

## Limpeza ao final

1. **Cancelar assinaturas/cobranças sandbox** criadas neste roteiro no painel Asaas.
2. **Apagar linhas de teste** (`billing_subscriptions`, `billing_invoices` sintéticas do C7/C11, overrides, `notification_outbox`) usando os mesmos padrões de `delete ... where organization_id in (<org-ids-de-teste>)` do roteiro da 5a.
3. **Restaurar `whatsapp_grandfather_revoked_at`/`_reason`** nas orgs de teste onde o C21 gravou a revogação, se a org for reaproveitada depois (revogação real não deveria ser desfeita em org de produção — só em org de teste).
4. **Devolver as flags ao estado do início** (seção 0.1.4), exceto se a decisão explícita do dono for manter `billing_invoice_ingestion`/`whatsapp_service_enforcement` ligadas após o roteiro passar — nesse caso, registrar a decisão em [FASE-5B-RESUMO.md](FASE-5B-RESUMO.md), não aqui.
5. Preencher a tabela de resumo no topo e reportar o veredito consolidado em [FASE-5B-RESUMO.md](FASE-5B-RESUMO.md) § Resultado do sandbox.
