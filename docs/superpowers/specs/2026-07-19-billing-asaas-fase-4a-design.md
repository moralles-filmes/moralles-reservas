# Fase 4a — Assinatura do sistema via Asaas: o dinheiro entra e o acesso liga

> Branch `billing-asaas/fase-4`, base `b6fe85e` (main pós-Fase 3).
> Contexto: [docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md) §FASE 4.
> Fonte de verdade da API: [03-ASAAS-API-VERIFICADO.md](../../billing-asaas/03-ASAAS-API-VERIFICADO.md).

## Por que a Fase 4 foi fatiada

O plano original bundla seis entregas numa fase só. Elas se separam por um critério objetivo — **exercitabilidade**:

- **4a** é exercitável em sandbox hoje: uma org de teste paga R$ 449 por PIX e sai com `billing_status='active'`.
- **4b** só é exercitável *depois* que existir uma assinatura Asaas viva pra ficar inadimplente.

Construir 4b antes seria ramo inexercitável — o mesmo erro que a Fase 2 evitou ao adiar os 4 itens do reconcile ([FASE-2-RESUMO](../../billing-asaas/FASE-2-RESUMO.md) §"O que a Fase 2 pedia e NÃO foi entregue").

**Esta spec cobre apenas a 4a.** A 4b ganha spec própria quando a 4a estiver validada em sandbox.

## Estado de partida (verificado por varredura em 2026-07-19)

A camada multi-provider está **100% construída e 0% conectada**:

| Peça | Estado |
|---|---|
| `BillingProviderPort` + `AsaasBillingProvider` (8 métodos) | Completo, **zero importadores** |
| Flag `billing_provider_default` (`'"stripe"'` jsonb) | Seedada, **lida por zero linhas** |
| `getFlagString` | Existe, **zero consumidores** |
| `asaasValueToCents` | Testado, **zero consumidores de produção** |
| `resolveOrgEntitlements` | Completo e testado (18 casos), **zero call sites** |
| `create-billing-checkout` | Stripe hardcoded; rejeita plano sem `stripe_price_id_card` |
| `asaas-webhook` | Persiste e classifica; **`organization_id` sempre `null`**, zero lógica de negócio |
| `process-asaas-reconcile` | Reclassifica eventos presos; os 4 itens da Fase 4 ausentes |
| `billing_notifications` | Produtor sem consumidor (linhas `pending` acumulam) |
| `tax_id` / `billing_email` | Colunas existem; **não coletados no onboarding** |

Consequência: a 4a é majoritariamente **plugar a porta que a Fase 2 construiu**, não construir peça nova.

## Decisões tomadas (aprovadas 2026-07-19)

1. **Fatiar 4a / 4b** — cada metade fecha com o checklist padrão e tem rollback próprio.
2. **Esconder a oferta de quem tem override LIFETIME** — Ren Sushi é vitalício grátis e não pode ver um botão de R$ 449.
3. **CPF/CNPJ e `billing_email` obrigatórios no onboarding** — Asaas exige `cpfCnpj`; sem isso todo checkout falha antes da primeira chamada de API.
4. **Sonda de sandbox antes do código de produção** — as 5 pendências do §13 do doc 03 viram fatos antes de virarem premissas.
5. **Lógica de negócio em módulo compartilhado com núcleo puro** (não duplicada, não por HTTP entre EFs).
6. **Checkout roteado dentro de `create-billing-checkout`** (não EF nova) — preserva o contrato do frontend.

## Arquitetura

### Passo 0 — Sonda do sandbox

`scripts/asaas-probe.ts` (Deno, descartável, chave lida de env e **nunca** commitada). Responde as 5 pendências do [doc 03 §13](../../billing-asaas/03-ASAAS-API-VERIFICADO.md):

1. `imageBase64` é mesmo obrigatório em `items[]` do checkout?
2. Payload de `PAYMENT_*` traz o objeto completo ou só `{object, id}`?
3. Shape exato do payload de `SUBSCRIPTION_*`.
4. `PUT {status:"INACTIVE"}` para cobranças futuras e preserva as emitidas?
5. `items[].value` aceita decimal (`19.90`)?

**Saída da sonda atualiza o doc 03 antes de qualquer código de produção.** Nenhuma resposta é assumida.

### Passo 1 — CPF/CNPJ e `billing_email` no onboarding

- `CreateOrgDialog` ([Empresas.tsx](../../../src/pages/platform/Empresas.tsx)) + `createOrganizationSchema` ganham os dois campos, obrigatórios.
- `manage-organizations` valida server-side e passa a criar a linha de `billing_customers` (com `tax_id`, `name`, `email`) junto com a org, dentro da cadeia de rollback que já existe.
- `billing_email` vai pra `organizations.billing_email` (coluna existente, hoje nula em toda org).
- **Backfill manual das orgs existentes** (Moralles, Ren Sushi, Seu Japa Teste) — documentado no resumo da fase, não em migration: o dado é externo e não existe no banco pra ser derivado. Moralles e Ren Sushi são vitalícias e nunca vão passar por checkout, então o backfill delas é higiene, não pré-requisito.

**Validação de dígito verificador** duplicada em `_shared/tax-id.ts` ⇄ `src/lib/tax-id.ts`, seguindo o precedente do `phone.ts` já documentado no CLAUDE.md. Ambos testados; o invariante de sincronização entra no CLAUDE.md.

### Passo 2 — `_shared/asaas-billing-events.ts`

O módulo que webhook e reconcile compartilham. Existe porque [process-asaas-reconcile/index.ts:131-148](../../../supabase/functions/process-asaas-reconcile/index.ts) avisa: quando `processing_status='processed'` ganhar significado de negócio, o reconcile precisa rodar **a mesma** lógica — senão marca como resolvido um evento que nunca ativou assinatura.

**Núcleo puro (testável no vitest, padrão `asaas-core.ts`):**

- `buildExternalReference({orgId, planId, purpose})` → `org:<uuid>|plan:<uuid>|purpose:subscription`
- `parseExternalReference(ref)` → `{orgId, planId, purpose} | null`. Rejeita shape inválido sem lançar.
- `decideEventEffect({eventType, paymentStatus, invoiceStatus, subscriptionStatus})` → efeito declarativo:
  `activate_subscription` · `mark_invoice_paid` · `mark_invoice_overdue` · `record_refund` · `noop` · `unknown`

O gate **`PAYMENT_CONFIRMED` OU `PAYMENT_RECEIVED`, o que chegar primeiro** mora aqui, e por ser função pura a idempotência do cartão (que emite os dois) vira teste em vez de esperança. Evidência do porquê não escutar só `CONFIRMED`: [doc 03 §5](../../billing-asaas/03-ASAAS-API-VERIFICADO.md) — teste ao vivo em 18/07 provou que PIX/boleto pula o `CONFIRMED`.

**Borda de I/O:**

- `applyAsaasEvent(supabase, eventRow)` → `{ status: 'processed'|'failed'|'ignored', organizationId, error? }`
  - Resolve a org: `externalReference` primeiro; fallback por `billing_invoices.provider_payment_id`, depois por `billing_customers.asaas_customer_id`.
  - **Reconfere o valor via `getPayment`** — nunca confia no payload (regra §19 da spec). Converte com `asaasValueToCents`.
  - Transições de estado idempotentes por UPDATE condicional (`.eq(...)` no status anterior), não por leitura-e-decisão.

> ⚠️ `getPayment` devolve payload **cru do Asaas — reais decimais, não centavos**. Comparar com `amount_cents` sem converter é bug de 100x. Assimetria documentada no header de [billing-provider.ts](../../../supabase/functions/_shared/billing-provider.ts).

### Passo 3 — Checkout roteado

`create-billing-checkout` lê `getFlagString("billing_provider_default", "stripe")` **server-side**. Antes de bifurcar, extrai pra helpers internos a resolução de papel, de org e das URLs de retorno — senão os dois caminhos divergem em silêncio.

Caminho Asaas:
1. Resolve ou cria `billing_customers.asaas_customer_id` via `AsaasBillingProvider.createCustomer`. Sem `tax_id` → erro 400 em PT-BR, claro e acionável.
2. `createCheckout` com `externalReference` do passo 2 e valores **sempre do banco**, nunca do request.
3. Devolve o mesmo contrato `{success, url, session_id}` — `session_id` é o UUID do checkout Asaas.

O caminho Stripe não é tocado.

> **Assimetria da URL de retorno.** A Stripe interpola `{CHECKOUT_SESSION_ID}` na `successUrl`, e é daí que sai o `?sid=` que o frontend recebe hoje. O Asaas **não tem template de interpolação** — as URLs de callback vão no corpo da criação, antes de o id existir. Logo, no caminho Asaas a `successUrl` é `.../cobranca?session=success`, **sem `sid`**. O frontend precisa tolerar `sid` ausente; ele nunca foi usado para nada além de ser removido da URL depois. Não é regressão, mas é contrato que muda por provider e precisa estar escrito.

### Passo 4 — Webhook aplica o efeito

Depois do INSERT (que continua sendo a primeira coisa que acontece), o webhook chama `applyAsaasEvent` e faz o backfill de `organization_id` na linha de `billing_events`.

**A régua de HTTP não muda** ([asaas-webhook/index.ts:14-35](../../../supabase/functions/asaas-webhook/index.ts)):
- `200` = a linha está durável **ou** foi descartada de propósito. **Falha de negócio é 200** com `processing_status='failed'` — a linha já está salva e o reconcile pega.
- Não-`200` só para falha de **persistência** (503).

Quebrar isso mata a fila do Asaas em 15 eventos consecutivos, com eventos apagados permanentemente em 14 dias e um único e-mail de aviso ([doc 03 §2](../../billing-asaas/03-ASAAS-API-VERIFICADO.md)).

### Passo 5 — Reconcile completo (4 itens herdados da Fase 2)

Usando o **mesmo** `applyAsaasEvent`:

1. Consulta payments `PENDING` antigos na API (`billing_invoices` com `provider='asaas'`) e corrige divergências. É isto que recupera evento perdido quando a fila do Asaas é interrompida.
2. Correção de divergências.
3. Alerta ao admin em divergência → `billing_notifications` (`channel='app'`).
4. Action admin de reprocessamento manual em `manage-billing`, idempotente.

> **Ressalva honesta:** o alerta do item 3 grava em `billing_notifications`, cujo dispatcher só existe na 4b. Até lá é registro consultável no painel de admin, **não** e-mail. Declarado para não parecer entrega maior do que é.

### Passo 6 — Esconder a oferta de quem tem cortesia

Action client-friendly nova em `manage-billing` devolvendo `resolveOrgEntitlements` — o **primeiro call site** do módulo da Fase 1. `PricingTable`/`Cobranca` renderizam "Acesso vitalício cortesia" quando a fonte do entitlement de `system` é `override`.

**Leitura apenas.** Enforcement é 4b, atrás da flag `entitlements_enforced`. A action segue o padrão de `list_plans`: sem `organization_id` do caller pra checar, quem protege é a forma da resposta — devolve só `{allowed, source, status, expiresAt}` por feature, nunca o motivo/`reason` do override nem quem concedeu.

### Passo 7 — Ligar o plano

Migration (não SQL manual) com `update billing_plans set active = true where slug = 'sistema-reservas'`, pra ficar reproduzível em qualquer ambiente.

### Passo 8 — Consertar o retorno do checkout

Em [Cobranca.tsx](../../../src/pages/gestao/Cobranca.tsx):
- `?session=cancel` passa a ser tratado (hoje é ignorado em silêncio).
- O toast "Pagamento processado. Bem-vindo!" deixa de ser incondicional após ~6s. Com PIX a confirmação pode chegar depois da janela de polling — o usuário veria "Bem-vindo!" com a assinatura inexistente. Passa a exibir estado honesto de "confirmando pagamento" quando a assinatura ainda não materializou.

## Fora de escopo da 4a (declarado, não esquecido)

| Item | Por quê | Vai pra |
|---|---|---|
| `manage-billing.change_plan` ciente de Asaas | Exige `stripe_subscription_id`/`stripe_price_id_card`; inalcançável até existir assinatura Asaas viva | 4b |
| Vazamento cross-tenant em `process-billing-reminders:77-84` | Dormente (sem dispatcher); vira ativo quando a 4b ligar o envio | **4b, bloqueante do dispatcher** |
| Entitlements enforced nos 3 guards | Precisa da flag e de cenário de inadimplência real | 4b |
| Grace 5d / suspensão D+6 / datas em BRT | Idem | 4b |
| `valid_until` de `billing_access_overrides` ignorado | Pré-existente, no caminho que a 4b reescreve | 4b |
| `suspended` ausente de `process-billing-unblock` | Pré-existente, idem | 4b |
| Divergência de `canceled` (frontend bloqueia, EFs não) | Dissolve sozinha quando os 3 guards passarem por `resolveOrgEntitlements` | 4b |
| `organizations.plan` órfã | Limpeza sem relação com o fluxo do dinheiro | Nenhuma fase; backlog |

## Tratamento de erro — invariantes que não podem quebrar

1. **Webhook: 200 = durável ou descartado de propósito; não-200 = "não guardei, reenvia".** Falha de negócio é 200.
2. **Valores sempre do banco**, nunca do request nem do payload do webhook. Quando o valor importa, reconferir via `getPayment`.
3. **Conversão monetária só na fronteira do provider.** `centsToAsaasValue` saindo, `asaasValueToCents` voltando.
4. **Ativação idempotente**: cartão emite `CONFIRMED` e `RECEIVED`; ativar duas vezes é bug. Garantido por UPDATE condicional, não por leitura-e-decisão.
5. **`externalReference` é dado nosso, não do Asaas** — parse defensivo, `null` em qualquer shape inesperado, com fallback por `provider_payment_id` e `asaas_customer_id`.
6. **POST não é retry-safe** (Asaas não tem `Idempotency-Key`). A política já implementada em `asaas-core.ts` — GET repete em 5xx/429/rede, mutação só em 429 — não pode ser afrouxada.

## Testes

**Unitários (vitest, sobre o núcleo puro):**
- `parseExternalReference` / `buildExternalReference` — round-trip, shapes hostis, UUID inválido, `purpose` desconhecido.
- `decideEventEffect` — gate `CONFIRMED` OU `RECEIVED`; idempotência do cartão (segundo evento vira `noop`); `PAYMENT_OVERDUE`; refund; evento desconhecido.
- `tax-id` — CPF e CNPJ válidos/inválidos, dígito verificador, máscara, sequências repetidas.
- Sincronização `_shared/tax-id.ts` ⇄ `src/lib/tax-id.ts` — mesmo corpus de casos nos dois.

**Sandbox ao vivo (cenários da spec):**
- Cenário 1 — org de teste nasce `trialing` com 5 dias.
- Cenário 4/5 — checkout PIX pago ativa a assinatura e devolve `billing_status='active'`.
- Cenário 7 — reenvio do mesmo webhook não ativa duas vezes (dedupe `23505`).
- **Cenário 8 — callback de sucesso sem webhook NÃO ativa nada.** Nunca foi exercitado contra nada; é o teste que prova que a ativação vem do webhook e não da `successUrl`.
- Cartão: `CONFIRMED` seguido de `RECEIVED` ativa uma vez só.

**Lacuna de teste declarada:** os handlers (`asaas-webhook/index.ts`, `process-asaas-reconcile/index.ts`) continuam sem cobertura automatizada — não há runner Deno no repo e todos os testes vivem em vitest sob `src/`. A árvore 503-vs-200 segue verificada só por leitura e pelo sandbox. Mitigação: toda decisão que dá pra extrair vai pro núcleo puro; o handler fica com I/O e despacho.

## Rollback

| Passo | Como desfazer |
|---|---|
| Plano ativo | `update billing_plans set active = false where slug = 'sistema-reservas';` |
| Roteamento de checkout | `update platform_flags set value = '"stripe"'::jsonb where key = 'billing_provider_default';` (esperar ~5min de cache) |
| Webhook aplicando efeito | Desligar `asaas_enabled` — volta a descartar evento com 200 |
| Onboarding com CNPJ | `git revert` do commit; colunas ficam (aditivas) |
| Frontend | `git revert` |

Nenhuma migration da 4a é destrutiva. `billing_events` já persistidos permanecem — o reconcile os reprocessa quando o código voltar.

## Checklist de fim de fase

Padrão do plano mestre: `npm run lint` · `npm run typecheck` (`tsc -b`) · `npm run test` · `npm run build` · `npx deno@2.1.4 check` nas EFs tocadas · `supabase db push` + query de validação · entradas `verify_jwt` no `config.toml` para EF nova **no mesmo PR** · redeploy das EFs afetadas por `_shared/` · atualizar docs · resumo da fase · tag `billing-asaas/fase-4a`.

**Redeploy obrigatório** (`_shared/` novo ou alterado):
- `asaas-billing-events.ts` (novo) → `asaas-webhook`, `process-asaas-reconcile`
- `tax-id.ts` (novo) → `manage-organizations`
- `billing-provider.ts` (se alterado) → `create-billing-checkout`, `asaas-webhook`, `process-asaas-reconcile`

Checklist do CLAUDE.md atualizado no mesmo PR.

> ⚠️ **Tag e branch têm o mesmo nome.** Use sempre o ref completo em merge e push: `git merge refs/heads/billing-asaas/fase-4`. Depois, confirmar com `git log --oneline main..refs/heads/billing-asaas/fase-4` (tem que sair vazio).
