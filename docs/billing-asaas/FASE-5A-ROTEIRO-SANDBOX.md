# Roteiro de sandbox — Fase 5a (Roteiro B, como na 4b)

> **Status: ESCRITO, NÃO EXECUTADO.** Este documento é o roteiro executável dos 20 cenários da Task 17. Quem rodar preenche a coluna "Real" da tabela de resumo (topo) e a seção "Resultado observado" de cada cenário, e traz o veredito de volta para [FASE-5A-RESUMO.md](FASE-5A-RESUMO.md) antes de merge/tag.
>
> Pré-requisito: passos 1–7 do [Runbook de ativação](FASE-5A-RESUMO.md#runbook-de-ativação-ordem-obrigatória--nada-disto-foi-executado) já feitos (deploy das 12 EFs, migration 076 aplicada, `asaas_enabled` + `whatsapp_implementation_flow` ligadas). Use `ASAAS_ENV=sandbox`.

## 0. Preparação (fazer uma vez, antes do B1)

1. **Organização de teste** — NÃO usar Ren Sushi (override `LIFETIME` vitalício) nem Moralles (a própria plataforma). Crie ou reuse uma org sandbox com `billing_status` normal (ex.: `trialing` ou `active`) e sem override ativo em `organization_entitlement_overrides`.
   ```sql
   select id, name, billing_status from organizations where slug = '<slug-da-org-teste>';
   select feature, grant_type, revoked_at from organization_entitlement_overrides
    where organization_id = '<org-id>';  -- esperado: nenhuma linha ativa (revoked_at is null)
   ```
2. **Flags no início do roteiro:**
   ```sql
   select key, value from platform_flags
    where key in ('asaas_enabled', 'whatsapp_implementation_flow', 'whatsapp_subscription_checkout', 'billing_notifications_dispatch');
   ```
   Anote o estado de `whatsapp_subscription_checkout` e `billing_notifications_dispatch` ANTES de mexer — são as flags que voltam ao estado original na limpeza (passo 3 do bloco de limpeza no fim).
3. **Ligar `whatsapp_implementation_flow`** (se ainda não estiver) — necessário para B1–B8. `whatsapp_subscription_checkout` só liga imediatamente antes do B9 (ver aviso na seção B9–B11).
4. Tenha à mão: um cartão de teste sandbox Asaas aprovado (doc `04-RUNBOOK-SANDBOX.md`), acesso ao SQL Editor do Supabase, e um segundo usuário de teste com papel `owner`/`gerente` na org (não platform_admin) para os cenários B17/B18.

---

## Resumo dos 20 cenários (preencher "Real" ao executar)

| # | Cenário | Esperado | Real |
|---|---|---|---|
| B1 | Contratar implantação pelo cliente | Checkout `DETACHED`, cartão+PIX, linha `ASAAS`/`PENDING`, sessão `pending` | ☐ |
| B2 | Voltar sem pagar | Tela não afirma pagamento; `AWAITING_PAYMENT` | ☐ |
| B3 | Duplo clique em "Contratar" | Mesma URL ou 409; uma cobrança no Asaas | ☐ |
| B4 | Pagar (cartão de teste) | `CONFIRMED` + `paid_at` + `billing_invoice_id`; sessão `used`; notificação `implementation_paid` | ☐ |
| B5 | Reenviar o mesmo evento | Nada muda; log `implementation_confirm_noop`; zero notificação nova | ☐ |
| B6 | Concluir com pagamento `PENDING` | 409 "só é possível concluir..." | ☐ |
| B7 | Segunda implantação, mesma org | 409 "já tem uma implantação registrada" | ☐ |
| B8 | Pagamento externo `WAIVED` via SQL direto | Recusado 23514 | ☐ |
| B9 | Contratar instância antes de `COMPLETED` | 409 `implementation_incomplete` | ☐ |
| B10 | Concluir + contratar instância | 2 assinaturas vivas, sem `PGRST116`; `billing_status` inalterado | ☐ |
| B11 | Fatura da instância vencida D+6 | `billing_status` não muda; log `billing_overdue_skip_non_system` | ☐ |
| B12 | Cancelamento imediato da instância | Assinatura `canceled`; org continua `active` | ☐ |
| B13 | Trial + assinatura de instância | `process-trial-expiry` bloqueia normalmente | ☐ |
| B14 | Conceder override de WhatsApp | `whatsapp` vira `override`; CTA some; "não aplicável" | ☐ |
| B15 | Segundo override de WhatsApp | 409 "revogue a atual..." | ☐ |
| B16 | Revogar o override | CTA volta; `revoked_at`/`revoked_by` preenchidos | ☐ |
| B17 | `get_service_status` como owner | 200, projeção segura, zero campo interno | ☐ |
| B18 | `set_operational_status` como owner | 403 "Acesso restrito." | ☐ |
| B19 | Trocar `category` de plano com assinatura | 409 traduzido, não 500 | ☐ |
| B20 | Trocar cartão: `purpose` novo vs `mode` legado | Os dois funcionam; o legado loga `checkout_legacy_mode_param` | ☐ |

---

## B1 — Contratar implantação pelo cliente

**Passos:**
1. Logado como owner/gerente da org de teste, abra `/g/<slug>/cobranca`.
2. No card "Automação WhatsApp", clique em "Contratar implementação".

**Observar:**
```sql
select id, checkout_url, status, expires_at, purpose from billing_checkout_sessions
 where organization_id = '<org-id>' and purpose = 'implementation' order by created_at desc limit 1;
select id, origin, payment_status, operational_status, provider_checkout_id
  from whatsapp_implementations where organization_id = '<org-id>';
```
Na página de checkout do Asaas (sandbox), confira as opções de pagamento oferecidas.

**Esperado:** checkout hospedado do Asaas com **cartão E PIX** disponíveis (`billingTypes` inclui os dois — é o `chargeTypes:["DETACHED"]` nunca exercitado desde a Fase 2). Linha em `whatsapp_implementations` com `origin='ASAAS'`, `payment_status='PENDING'`. Sessão `status='pending'` com `checkout_url` preenchida.

**Risco documentado:** se o Asaas recusar a combinação `DETACHED` com as duas formas de pagamento, este é o achado mais importante do roteiro (risco #1 do FASE-5A-RESUMO.md) — pare e registre o erro exato devolvido pelo Asaas antes de prosseguir para os demais cenários que dependem de B1.

**Resultado observado:** _(preencher)_

---

## B2 — Voltar pela `successUrl` sem pagar

**Passos:**
1. Na página de checkout do Asaas aberta no B1, feche a aba ou clique em voltar SEM completar o pagamento (não use o cartão de teste ainda).
2. Volte para `/g/<slug>/cobranca` manualmente (a `successUrl` do checkout não é chamada se você não pagou).

**Observar:** o texto exibido no card de Automação WhatsApp para o estado da implantação.

**Esperado:** a tela **não** afirma "pagamento confirmado" nem nada equivalente — mostra o estado `AWAITING_PAYMENT`/"aguardando confirmação, sem promessa de prazo" (linha do backend continua `PENDING`). Confirme no banco que `payment_status` continua `PENDING`.

**Resultado observado:** _(preencher)_

---

## B3 — Clicar "Contratar" duas vezes (concorrência)

**Passos:**
1. Com a implantação ainda `PENDING` (não pague), clique em "Contratar implementação" de novo — abra duas requisições próximas (ex.: duplo clique rápido, ou duas abas chamando `create-billing-checkout` quase ao mesmo tempo).

**Observar:**
```sql
select id, provider_checkout_id, status, created_at from billing_checkout_sessions
 where organization_id = '<org-id>' and purpose = 'implementation' order by created_at desc;
```
No painel Asaas (sandbox) → Cobranças, conte quantos checkouts foram criados para esta org/produto.

**Esperado:** o segundo clique devolve a **mesma** `checkout_url` da sessão `pending` já reservada, OU um 409 "checkout em criação" se a primeira reserva ainda estiver em `status='creating'` no instante exato do segundo clique. Em nenhum caso duas linhas `pending` distintas nem duas cobranças reais no Asaas — o índice `UNIQUE (organization_id, billing_plan_id, purpose) WHERE status IN ('creating','pending')` da migration 072 garante isso.

**Resultado observado:** _(preencher)_

---

## B4 — Pagar com cartão de teste

**Passos:**
1. Reabra a `checkout_url` pendente (ou gere uma nova se a anterior expirou) e complete o pagamento com um cartão de teste aprovado do sandbox Asaas.
2. Aguarde o webhook do Asaas chegar (`PAYMENT_CONFIRMED` ou `PAYMENT_RECEIVED` — PIX pula direto para `RECEIVED`).

**Observar:**
```sql
select payment_status, operational_status, paid_at, billing_invoice_id from whatsapp_implementations
 where organization_id = '<org-id>';
select status from billing_checkout_sessions where organization_id = '<org-id>' and purpose = 'implementation'
 order by created_at desc limit 1;
select event_type, organization_id, status from billing_notifications
 where organization_id = '<org-id>' and event_type = 'implementation_paid' order by created_at desc;
```

**Esperado:** `payment_status='CONFIRMED'`, `paid_at` preenchido, `billing_invoice_id` apontando para uma `billing_invoices` real (`purpose='implementation'`). Sessão de checkout `status='used'`. Uma linha nova em `billing_notifications` com `event_type='implementation_paid'` (destinatário: **um único** platform admin, o mais antigo — risco residual #4 registrado no resumo da fase). Se `billing_notifications_dispatch` estiver ligada temporariamente, confira o e-mail chegando; senão a linha fica `pending` na fila (comportamento esperado).

**Resultado observado:** _(preencher)_

---

## B5 — Reenviar o mesmo evento pelo painel Asaas

**Passos:**
1. No painel Asaas (sandbox) → Webhooks → histórico de entregas, localize o evento `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` do B4 e clique em "Reenviar" (ou dispare manualmente o mesmo payload via `curl` contra `asaas-webhook` com o `asaas-access-token` correto).

**Observar:**
```sql
select payment_status, paid_at, updated_at from whatsapp_implementations where organization_id = '<org-id>';
select event_type from billing_notifications where organization_id = '<org-id>' and event_type = 'implementation_paid';
```
Nos logs da EF `asaas-webhook` (Supabase Dashboard → Edge Functions → Logs), procure `evt: "implementation_confirm_noop"`.

**Esperado:** **nenhuma** coluna muda (o `UPDATE ... WHERE payment_status <> 'CONFIRMED'` da migration não afeta linha nenhuma na 2ª vez). Log `implementation_confirm_noop` aparece. Continua havendo **exatamente 1** linha `implementation_paid` em `billing_notifications` (não duas) — o dedupe é parcial por `invoice_id`, e o 2º evento tenta inserir a mesma `invoice_id`.

**Resultado observado:** _(preencher)_

---

## B6 — Concluir com pagamento `PENDING` (org diferente)

**Passos:**
1. Numa **segunda** org de teste (para não interferir na primeira, que já está `CONFIRMED`), crie uma implantação nova (repita B1) e **não pague**.
2. Como platform_admin, em `/platform/billing/implementacoes`, tente mudar `operational_status` para `COMPLETED` (ação `set_operational_status`) enquanto `payment_status` ainda é `PENDING`.

**Observar:** resposta HTTP da EF `manage-whatsapp-implementations`.

**Esperado:** **409** com a mensagem exata: *"Só é possível concluir a implantação depois que o pagamento estiver confirmado (ou registrado como cortesia)."*

**Resultado observado:** _(preencher)_

---

## B7 — Criar segunda implantação para a mesma org

**Passos:**
1. Na org do B1/B4 (que já tem implantação `CONFIRMED`, `operational_status` ainda não `CANCELED`), tente criar outra implantação — pelo botão do cliente (se a EF impedir antes) ou pela action `create`/`create_asaas_charge` do admin.

**Observar:** resposta HTTP.

**Esperado:** **409** — mensagem *"Esta empresa já tem uma implantação registrada."* (variante exata depende do caminho: `implementation-checkout.ts` para o caminho de checkout, ou *"Esta empresa já tem uma implantação registrada. Cancele a atual antes de criar outra."* para a criação manual do admin). Confirma o índice único parcial `whatsapp_impl_one_open_per_org_idx` — `23505` traduzido para 409 amigável nos dois pontos de entrada.

**Resultado observado:** _(preencher)_

---

## B8 — Registrar pagamento externo `WAIVED` (backstop de banco)

A EF **não permite** enviar essa combinação pela API normal (`register_external_payment` força `payment_status='CONFIRMED'` sempre que `origin='EXTERNAL_PAYMENT'` — é regra fixa no código, não vem do corpo da requisição). Este cenário testa o **backstop no banco**, não a EF — confirma que mesmo um bypass da EF (SQL direto, ou uma EF futura com bug) seria barrado.

**Passos:** no SQL Editor, autenticado com um papel que tenha `INSERT` em `whatsapp_implementations` (ex.: via `service_role` do painel, ou repita a query de validação já documentada no rodapé da migration 071):
```sql
insert into whatsapp_implementations (organization_id, origin, payment_status, notes)
select id, 'EXTERNAL_PAYMENT', 'WAIVED', 'teste-roteiro-B8' from organizations where slug = '<slug-org-teste-3>';
```
(Use uma **terceira** org de teste sem implantação aberta, para não colidir com o índice de "uma aberta por org" e confundir o resultado.)

**Esperado:** erro **`23514`** (violação de CHECK) — a constraint `whatsapp_impl_origin_payment_chk` recusa `EXTERNAL_PAYMENT` com `WAIVED` (a matriz só admite `CONFIRMED|REFUNDED|CANCELED` para essa origem).

**Limpeza:** `delete from whatsapp_implementations where notes = 'teste-roteiro-B8';` (não deve ter inserido nada, mas confirme).

**Resultado observado:** _(preencher)_

---

## B9–B11 — cenários com `whatsapp_subscription_checkout` ligada

> ⚠️ **Ligue `whatsapp_subscription_checkout` só agora**, imediatamente antes do B9, e **desligue de volta ao final do B11** (ou ao final do roteiro inteiro, se preferir rodar B9–B20 em sequência). Ela fica **OFF em produção** — decisão de produto registrada na Nota de encerramento do brief da Task 17: vender a mensalidade sem poder suspender (o gate central de envio é da Fase 5b) é assumir custo de Z-API sem contrapartida.
> ```sql
> update platform_flags set value='true'::jsonb, updated_at=now() where key='whatsapp_subscription_checkout';
> ```

### B9 — Contratar instância antes de `COMPLETED`

**Passos:**
1. Na org do B7 (implantação existe mas não está `COMPLETED` — ainda `PENDING`/`NOT_STARTED`/`IN_PROGRESS`), tente contratar a instância (R$149/mês) — botão "Contratar instância" ou chamada direta a `create-billing-checkout { purpose: "subscription", plan_id: <id-instancia-whatsapp> }`.

**Esperado:** **409** com `error` contendo a mensagem de `implementation_incomplete`: *"A mensalidade da instância só pode ser contratada depois que a implantação for concluída."*

**Resultado observado:** _(preencher)_

### B10 — Concluir a implantação e contratar a instância

**Passos:**
1. Na org do B4 (implantação `CONFIRMED`), como platform_admin, mude `operational_status` até `COMPLETED` (transições válidas — pode exigir passar por `SCHEDULED`/`IN_PROGRESS` dependendo da máquina de estados; confira `canTransitionOperational`).
2. Com `operational_status='COMPLETED'`, contrate a instância pelo card do cliente (ou pela mesma chamada do B9).
3. Pague com cartão de teste.

**Observar:**
```sql
select id, billing_plan_id, status, (select category from billing_plans p where p.id = billing_plan_id) as category
  from billing_subscriptions where organization_id = '<org-id>' and status <> 'canceled';
select billing_status from organizations where id = '<org-id>';
```

**Esperado:** **duas** linhas em `billing_subscriptions` não-canceladas (uma `SYSTEM_SUBSCRIPTION` se a org já tinha sistema, outra `WHATSAPP_SUBSCRIPTION`) — **sem** erro `PGRST116` em nenhum ponto do fluxo (RPC `resolve_or_activate_subscription` resolve por categoria). `organizations.billing_status` **inalterado** pela ativação da instância (só a assinatura de sistema escreve essa coluna).

**Resultado observado:** _(preencher)_

### B11 — Fatura da instância vencida D+6

**Passos:**
1. Na org do B10 (com assinatura `WHATSAPP_SUBSCRIPTION` ativa), force uma fatura vencida há 6+ dias para essa assinatura (ajuste `due_date` de uma `billing_invoices` de teste vinculada, ou aguarde/simule via evento `PAYMENT_OVERDUE`).
2. Rode `process-billing-overdue` manualmente (invoke da EF) ou aguarde o cron `0 10 * * *`.

**Observar:** logs da EF `process-billing-overdue` (procure `evt: "billing_overdue_skip_non_system"` ou equivalente) e:
```sql
select billing_status, blocked_at, blocked_reason from organizations where id = '<org-id>';
```

**Esperado:** `organizations.billing_status` **não muda** (a fatura de WhatsApp não é `SYSTEM_SUBSCRIPTION`, `isSystemInvoice`/`isSystemSubscription` devolvem `false`, o worker pula a escalada). Log confirma que a fatura foi identificada e ignorada por categoria, não silenciosamente.

**Resultado observado:** _(preencher)_

> Depois do B11, desligue `whatsapp_subscription_checkout` de volta a `false` se não for seguir direto para B12–B20 na mesma janela (ela é revisitada na limpeza final de qualquer forma).

---

## B12 — Cancelamento imediato da instância

**Passos:**
1. Na org do B10, cancele a assinatura `WHATSAPP_SUBSCRIPTION` (ação de cancelamento imediato — via `manage-billing`, não `cancel_subscription_by_owner` que é `at_period_end`; use a action admin de cancelamento imediato se existir, ou o cancelamento padrão marcando `status='canceled'` diretamente pela API testada).

**Observar:**
```sql
select status from billing_subscriptions where organization_id = '<org-id>' and billing_plan_id = (select id from billing_plans where slug='instancia-whatsapp');
select billing_status from organizations where id = '<org-id>';
```

**Esperado:** a assinatura de instância vira `canceled`. `organizations.billing_status` **continua** `active` (ou o que era antes) — o sweep de category-awareness da Task 8 garante que só o cancelamento de `SYSTEM_SUBSCRIPTION` marca a org como `canceled`.

**Resultado observado:** _(preencher)_

---

## B13 — Org em trial com assinatura de instância

**Passos:**
1. Use uma **quarta** org de teste, ainda em `billing_status='trialing'`, com `trial_ends_at` já vencido (ou force manualmente para testar o worker sem esperar).
2. Dê a essa org uma implantação `COMPLETED` e uma assinatura `WHATSAPP_SUBSCRIPTION` ativa (repita B1→B10 rapidamente ou insira direto via SQL para agilizar, respeitando a matriz de constraints).
3. Rode `process-trial-expiry` (invoke manual ou aguarde `0 3 * * *`).

**Observar:**
```sql
select billing_status, blocked_at from organizations where id = '<org-id>';
```

**Esperado:** o worker **bloqueia normalmente** (`billing_status` vira `blocked` ou equivalente) — a assinatura de WhatsApp **não** conta como "assinatura ativa" para efeito de pular o bloqueio do trial (`process-trial-expiry` exige `SYSTEM_SUBSCRIPTION`).

**Resultado observado:** _(preencher)_

---

## B14 — Conceder override de WhatsApp

**Passos:**
1. Use uma **quinta** org de teste sem override nenhum ativo.
2. Como platform_admin, em `/platform/billing/<org-id>` (ou na tela de implantações), conceda o override de `whatsapp` (`grant_whatsapp_override`) — confirme o aviso de custo Z-API exigido pela UI.

**Observar:** resposta da tela `/g/<slug>/cobranca` dessa org (logado como o cliente) e:
```sql
select feature, grant_type, ends_at, revoked_at from organization_entitlement_overrides
 where organization_id = '<org-id>' and feature = 'whatsapp' order by created_at desc limit 1;
```

**Esperado:** `entitlements.whatsapp.source === "override"`, `allowed=true`. Na tela do cliente: o botão "Contratar instância" **some**, e o resumo mostra "não aplicável" (ou texto equivalente de cortesia) em vez de um valor cobrável para a instância.

**Resultado observado:** _(preencher)_

---

## B15 — Conceder um segundo override de WhatsApp

**Passos:**
1. Na mesma org do B14 (override `whatsapp` já ativo), tente conceder outro override de `whatsapp`.

**Esperado:** **409** — *"Já existe uma concessão ativa para esta funcionalidade. Revogue a atual antes de criar outra."*

**Resultado observado:** _(preencher)_

---

## B16 — Revogar o override

**Passos:**
1. Na org do B14, revogue o override de `whatsapp` (`revoke_whatsapp_override`).

**Observar:**
```sql
select revoked_at, revoked_by from organization_entitlement_overrides
 where organization_id = '<org-id>' and feature = 'whatsapp' order by created_at desc limit 1;
```
Recarregue `/g/<slug>/cobranca` como o cliente.

**Esperado:** `revoked_at` e `revoked_by` preenchidos na linha. Botão "Contratar instância" **volta** a aparecer (assumindo implantação `COMPLETED` e nenhuma assinatura de instância ativa nessa org).

**Resultado observado:** _(preencher)_

---

## B17 — Chamar `get_service_status` como owner não-admin

**Passos:**
1. Logado como o segundo usuário de teste (papel `owner` ou `gerente`, **não** `platform_admin`) na org, chame `manage-whatsapp-implementations` com `{ action: "get_service_status", organization_id: "<org-id>" }`.

**Observar:** status HTTP e corpo completo da resposta.

**Esperado:** **200**. Corpo contém só a projeção seguro-por-construção: `implementation` (status financeiro/operacional, valores, datas), `subscription` (existência/status/vencimento), `override` (ativo, tipo, validade), flags relevantes. **Nenhum** dos campos internos (`notes`, `reason`, `external_payment_reference`, `owner_admin_id`, `created_by`) aparece no JSON.

**Resultado observado:** _(preencher)_

---

## B18 — Chamar `set_operational_status` como owner não-admin

**Passos:**
1. Com o mesmo usuário do B17 (owner/gerente, não platform_admin), chame `{ action: "set_operational_status", id: "<impl-id>", operational_status: "IN_PROGRESS" }`.

**Esperado:** **403** — *"Acesso restrito."* (`set_operational_status` não está em `CLIENT_FRIENDLY_ACTIONS`, que contém só `get_service_status`).

**Resultado observado:** _(preencher)_

---

## B19 — Trocar `category` de um plano com assinatura

**Passos:**
1. Escolha um plano com assinatura viva (ex.: `sistema-reservas`, que tem assinatura(s) das orgs de teste ativas nesta fase, ou `instancia-whatsapp` depois do B10/B12).
2. Como platform_admin, tente mudar a `category` desse plano via `manage-billing` (UPDATE em `billing_plans`).

**Esperado:** **409**, não 500 — *"Não é possível mudar a categoria de um plano que já tem assinatura ativa. Desative o plano e crie um novo."* (trigger `billing_plans_category_guard` da migration 074, discriminada por mensagem `plan_category_locked`, traduzida pelo `manage-billing`).

**Resultado observado:** _(preencher)_

---

## B20 — Trocar cartão: `purpose` novo vs `mode` legado

**Passos:**
1. **Cliente com frontend atualizado:** em `/g/<slug>/cobranca`, clique em "Trocar cartão" (deve mandar `{ purpose: "payment_method_update" }` para `create-billing-checkout`).
2. **Simular cliente antigo:** chame `create-billing-checkout` diretamente com o payload legado `{ organization_id, mode: "setup" }` (sem `purpose`), simulando um bundle de frontend não atualizado ainda em cache no navegador de algum cliente.

**Observar:** resposta HTTP dos dois; logs da EF para o segundo caso (procure `evt: "checkout_legacy_mode_param"`).

**Esperado:** **os dois funcionam** (checkout `mode=setup`/`payment_method_update` gerado normalmente). O caminho 2 (legado) loga `checkout_legacy_mode_param` com o valor de `mode` recebido — sinal de telemetria para saber quando é seguro remover o compat (previsto para a Fase 5b).

**Resultado observado:** _(preencher)_

---

## Limpeza ao final

1. **Cancelar as assinaturas sandbox** criadas neste roteiro no painel Asaas (sandbox) — evita ruído em relatórios futuros de sandbox.
2. **Apagar as linhas de teste:**
   ```sql
   delete from whatsapp_implementations where notes like 'teste-roteiro-%' or organization_id in (<org-ids-de-teste>);
   delete from organization_entitlement_overrides where organization_id in (<org-ids-de-teste>);
   delete from billing_subscriptions where organization_id in (<org-ids-de-teste>);
   delete from billing_checkout_sessions where organization_id in (<org-ids-de-teste>);
   ```
   (Ajuste para preservar qualquer coisa que precise virar evidência anexada ao resultado do roteiro antes de apagar.)
3. **Devolver `whatsapp_subscription_checkout` para OFF:**
   ```sql
   update platform_flags set value='false'::jsonb, updated_at=now() where key='whatsapp_subscription_checkout';
   ```
4. **Devolver `billing_notifications_dispatch` para OFF** se foi ligada temporariamente para observar o e-mail do B4.
5. **Conferir `asaas_enabled`** está no mesmo estado em que estava antes do roteiro (provavelmente ligado, se a fase já estava em validação contínua — não desligar sem necessidade, quebra outros fluxos de sandbox em andamento).
6. Preencher a tabela de resumo no topo deste documento e reportar o veredito consolidado em [FASE-5A-RESUMO.md](FASE-5A-RESUMO.md) § Resultado do sandbox.
