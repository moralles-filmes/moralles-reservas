# FASE 4A — Assinatura do sistema via Asaas (R$ 449): Resumo de Execução

> Branch `billing-asaas/fase-4`, base `b6fe85e` (main pós-Fase 3).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing
>
> **Código completo e revisado. NADA aplicado em produção ainda — o deploy é a Task 13, sob seu controle.**
>
> A Fase 4a foi fatiada por exercitabilidade: **4a = "o dinheiro entra e o acesso liga"** (contratar → pagar → assinatura ativa → org com acesso). O caminho oposto — **4b = "o dinheiro NÃO entra e o acesso desliga"** (inadimplência, bloqueio, notificações de cobrança) — exige uma assinatura viva ficar em atraso primeiro, então fica para depois.
>
> | | |
> |---|---|
> | Pipeline de código (Tasks 1–12) | ✅ completo, cada task revisada (spec + qualidade) |
> | Revisão final da branch inteira | ✅ PRONTO PARA MERGE, zero segredo, zero blocker |
> | Sonda de sandbox (`scripts/asaas-probe.ts`) | ✅ rodou 2026-07-19; respostas em [03 §13](03-ASAAS-API-VERIFICADO.md) |
> | Migration `066` (ativa `sistema-reservas`) | 📄 **arquivo commitado, `db push` NÃO rodado** |
> | Deploy das Edge Functions | ❌ **pendente — Task 13** |
> | Flag `asaas_enabled` | 🔒 OFF (seed 061) — **ligar ANTES de ativar o plano** |
> | `npm test` | ✅ **221/221** |

---

## ⛔ SEQUÊNCIA DE DEPLOY (Task 13) — a ordem importa, cada passo protege o seguinte

A ativação do plano torna o botão de R$ 449 **comprável**. Fazê-la fora de ordem perde pagamento em silêncio. Siga nesta ordem:

1. **Fechar a sonda primeiro** (pendências 2/3/5 do §13, mais 2a/2b/2c). Rode:
   ```powershell
   $env:ASAAS_ENV = 'sandbox'
   $env:ASAAS_API_KEY = '<Ctrl+V da chave sandbox INTEIRA>'
   npx deno@2.1.4 run --allow-net --allow-env --allow-write scripts/asaas-probe.ts
   ```
   O resultado é gravado em `asaas-probe-output.json`. Depois, no painel sandbox: ache a cobrança "Sonda payment", confirme o pagamento (anote o rótulo do botão), e copie o payload inteiro dos eventos em **Integrações → Logs de Webhooks**. Isso fecha o §13 e confirma **2c** (o Asaas amarra ou ignora o `customer` no request) e **2a/2b** (shape do objeto `subscription` do checkout). Se 2c mostrar que o `customer` é ignorado, é um ajuste em `billing-provider.ts` antes de seguir.
2. **`supabase db push`** — aplica só a `066` (é a única migration pendente; confirme com `supabase db push --dry-run` que não há drift). Isso ativa o plano no banco, mas ele só fica funcional quando os passos 3–4 estiverem no ar.
3. **Deploy das Edge Functions.** São exatamente **5** — o conjunto autoritativo derivado do que mudou nesta branch (arquivos alterados diretamente + quem importa os `_shared` alterados: `asaas-billing-events.ts`, `asaas-billing-events-apply.ts`, `asaas.ts`, `billing-provider.ts`, `tax-id.ts`):
   ```
   supabase functions deploy create-billing-checkout
   supabase functions deploy asaas-webhook
   supabase functions deploy process-asaas-reconcile
   supabase functions deploy manage-billing
   supabase functions deploy manage-organizations
   ```
   > `manage-platform-secrets` **NÃO** entra: importa só `asaas-config.ts`/`asaas-core.ts`, que não mudaram nesta branch. (Se você redeployá-la por precaução, é inofensivo — só desnecessário.)
4. **Ligar `asaas_enabled=true`** (painel `/platform/automacao` ou a tabela `platform_flags`). **Isto é obrigatório e simétrico:** o `asaas-webhook` fail-closa quando a flag está OFF (descarta o evento sem persistir), e agora o `create-billing-checkout` também recusa abrir checkout Asaas com a flag OFF (retorna 503). Sem ligar a flag, toda contratação Asaas dá 503 — seguro, mas quebrado.
5. **Cadastrar o webhook no painel Asaas** apontando pro `asaas-webhook`, com o "webhook de status da mensagem" e os eventos de pagamento ligados.
6. **Merge da branch `billing-asaas/fase-4` em `main`** — dispara o deploy Vercel do **frontend**, que carrega 4 mudanças desta fase: coleta de CPF/CNPJ + e-mail de cobrança no onboarding (`Empresas.tsx`/`organization.ts`), oferta de R$ 449 escondida de quem tem cortesia LIFETIME (`Cobranca.tsx`), e entitlements no cliente (`useBilling.ts`). Sem esse merge, o backend aceita o plano mas o onboarding não coleta o `tax_id` que o `billing-provider.ts` exige → a 1ª org nova travaria no checkout. Como o único cliente hoje é vitalício e você mesmo cria as orgs, não há corrida — mas o merge deve entrar **junto/antes** da ativação real do plano, não depois.
7. **Validar ao vivo em sandbox** os cenários abaixo antes de considerar a fase fechada.

### Cenários de validação ao vivo (Task 13)

| # | Cenário | Esperado |
|---|---|---|
| 1 | Contratar `sistema-reservas`, pagar no cartão | `PAYMENT_CONFIRMED` → assinatura `active`, org com acesso |
| 2 | **Herança do `externalReference` no checkout RECURRENT** (§13.5.1 só validou `POST /subscriptions`) | a cobrança da assinatura carrega o `externalReference` → ativação funciona |
| 3 | `getPayment` inalcançável durante um `PAYMENT_RECEIVED` (Asaas fora do ar) | evento termina `failed`, NÃO `processed`; reconcile retenta |
| 4 | Pagar `credito-ia` (`purpose=ai_topup`) numa org bloqueada | dinheiro registrado, acesso **não** liberado |
| 5 | Org sem linha em `billing_customers` recebe pagamento | `failed`, não `processed` |
| 6 | Evento ativador sem `payment.id` no payload | `failed`, não `processed` |

Os cenários 3/5/6 cobrem os caminhos de erro do aplicador que não têm teste unitário (sem runner Deno no repo).

---

## Arquitetura entregue

**Núcleo puro/impuro** — `_shared/asaas-billing-events.ts` é PURO (zero imports, importável por vitest a partir de `src/`); a metade de I/O é `_shared/asaas-billing-events-apply.ts`. Precedente: `asaas-core.ts`/`asaas.ts`. O motivo do split: o webhook (`asaas-webhook`) e o worker (`process-asaas-reconcile`) compartilham o MESMO `applyAsaasEvent` — é o que impede os dois de divergirem no significado de "pagamento confirmado".

**`applyAsaasEvent(supabase, row, opts?)`** é o coração. Decide o efeito via `decideEventEffect` (função pura, só lê `event_type` + `invoiceStatus`), reconsulta o valor real via `getPayment` (o payload do webhook pode ser só `{object, id}`), e aplica: marca invoice paga, cria/ativa assinatura, desbloqueia a org. Chamado com orçamento de tempo (`asaasIoBudgetMs=5s`) pelo webhook, que tem teto de 10s; e SEM orçamento pelo reconcile, que é cron.

**Checkout roteado** — `create-billing-checkout` bifurca por `plan.provider`: Asaas abre checkout no Asaas; Stripe segue o caminho legado intocado.

**Entitlements ao cliente** — `manage-billing` action `get_org_entitlements` expõe o estado ao owner/gerente; a oferta de R$ 449 é escondida de quem tem override LIFETIME.

## Verificação

| Item | Resultado |
|---|---|
| `npm run typecheck` (`tsc -b --noEmit`) | 0 erros |
| `npm test` | **221/221** (era 173 na Fase 3; +48 nesta fase) |
| `npm run lint` | 0 erros (22 warnings de baseline, nenhum novo) |
| `npm run build` | OK |
| `npx deno@2.1.4 check` nos arquivos Deno | limpo |
| Sonda de sandbox ao vivo | ✅ 2026-07-19 — §13 (parcial: 1, 4 fechados; 2/3/5 pendem do passo manual) |
| `supabase db push` da `066` | ❌ Task 13 |
| Deploy das EFs | ❌ Task 13 |

## Achados da sonda que mudaram o plano ([03 §13](03-ASAAS-API-VERIFICADO.md))

1. **`imageBase64` não é obrigatório** no checkout (o OpenAPI mente). `billing-provider.ts` ficou como estava.
2. **`value` é decimal em reais** (`19.90` → `19.9`). Confirma o par `centsToAsaasValue`/`asaasValueToCents`. `netValue` é líquido de taxa — valor de fatura sai de `value`, nunca de `netValue`.
3. **Checkout `RECURRENT` só aceita `CREDIT_CARD`** (§13.3). Descoberta que virou decisão de produto: **a assinatura do sistema é cobrada só no cartão, com renovação automática.** PIX/boleto recorrente exigiria `POST /subscriptions` + `invoiceUrl`, sem cartão em arquivo. Também expôs um bug já em produção desde a Fase 2 (`billing-provider.ts` mandava `["CREDIT_CARD","PIX"]` nos dois modos → todo checkout de assinatura daria 400), consertado na Task 7.
4. **`PUT status:INACTIVE` não cancela cobrança já emitida** (§13.2) — segue `PENDING`. Cancelar assinatura sem tratar a cobrança pendente deixa o cliente recebendo lembrete de algo que cancelou.
5. **`nextDueDate` na resposta já avançou um ciclo** (§13.4); **`payment.subscription` é omitido em cobrança avulsa, não vem `null`** (§13.6). Ambos respeitados no aplicador e no reconcile.

## Decisões que desviaram do plano (e por quê)

**1. Migration `066` commitada como arquivo, `db push` adiado.** O brief mandava `db push` no ato. Ativar um plano comprável antes das EFs de checkout no ar deixaria uma org nova diante de um botão quebrado. A aplicação é o último passo do deploy (Task 13), sob seu controle.

**2. Task 6 dividida em dois arquivos.** O import do supabase-js por URL quebra o vitest; o brief previa o fallback. Núcleo puro ficou com zero imports (verificado).

**3. Reconcile (Task 9) delega ao aplicador em vez de SQL inline.** O SQL inline do brief reintroduziria o buraco que a Task 8 fechou: `organizations.billing_status='active'` mesmo quando o `UPDATE billing_subscriptions` casa zero linhas → org com acesso e sem assinatura. Delegar ao `applyAsaasEvent` unifica webhook e worker.

**4. Webhook (Task 8) usa orçamento de tempo com falha rápida, não `EdgeRuntime.waitUntil`.** `getPayment` síncrono podia gastar 45s+ (3 tentativas × 15s + espera de rate-limit) e estourar o teto de 10s do webhook; sob degradação do Asaas isso vira timeout correlacionado → 15 falhas seguidas → **fila de eventos do provedor interrompida**, com apagamento em 14 dias. O orçamento (5s) degrada para `failed` (reconcile retenta) em vez de travar a fila de todos.

**5. Checkout gateia `asaas_enabled` (revisão final).** Simetria com o webhook, que fail-closa na mesma flag. Sem isso, ativar o plano com a flag OFF perderia pagamento em silêncio.

## Invariantes fixados (não quebrar)

- **Webhook Asaas aceita SÓ HTTP 200.** 200 = persistimos durável OU descartamos deliberado; 503 = falha de PERSISTÊNCIA só; falha de lógica de negócio continua 200 (reconcile reprocessa). 15 falhas consecutivas interrompem a fila; eventos apagados em 14 dias.
- **Sem `Idempotency-Key` no Asaas** — nenhuma mutação com retry próprio. Idempotência é UNIQUE `(provider, provider_event_id)` em `billing_events`.
- **`applyAsaasEvent` é a fonte única de "efeito de pagamento".** Webhook e reconcile chamam o mesmo — não duplicar a lógica em nenhum dos dois.
- **`asaas_enabled` gateia AS DUAS pontas** (checkout e webhook). Ligar as duas juntas ou nenhuma.
- **Ativação = `PAYMENT_CONFIRMED` OU `PAYMENT_RECEIVED`**, o que vier primeiro (PIX/boleto pulam CONFIRMED).
- **`externalReference` (`org:<uuid>|plan:<uuid>|purpose:<p>`) é a correlação primária.** Sem ele, `purpose` cai em `other` e a org não é reativada. Produzido em `create-billing-checkout`, consumido no aplicador — mexer no formato exige redeploy dos DOIS (ver checklist).

## Backfill pendente (higiene, não bloqueia)

As orgs `Moralles`, `Ren Sushi` e `Seu Japa Teste` ficaram sem `tax_id`/`billing_email` (existiam antes da Task 3 tornar os campos obrigatórios no onboarding). Preencher em `/platform/billing/<org>`. Moralles e Ren Sushi são vitalícias e nunca passam por checkout — nelas é higiene, não pré-requisito.

## Minors levados à revisão final → todos follow-up (nenhum bloqueia deploy)

`rest === 11` morto nas 2 cópias de `tax-id`; `billing_customer_created` retornado e não consumido; `buildExternalReference` não valida os próprios inputs; "Acesso vitalício cortesia" + "Válido até" (nunca renderiza na base atual); "Tente novamente" genérico em recusas permanentes do checkout; `setTimeout` sem `clearTimeout`; `source: string` em vez de `EntitlementSource`; comentário "3 UUIDs"; **`record_refund` sem `paymentId` retorna `processed` sem anular — marcado para a 4b** (estorno só dirige acesso na 4b).

## Gate de go-live (registrado na Fase 11 do plano; NÃO bloqueia a 4a)

Enquanto o único cliente é vitalício grátis, o pior caso não atinge ninguém. Antes da 1ª assinatura PAGANTE: subir a cadência do `process-asaas-reconcile` de diário para horário/`*/15` **e** deduplicar `billing_notifications` no estágio 2 — feitos juntos.

## Riscos residuais

1. **`subscription:{cycle}` e `customer` no request do checkout são inferidos.** A sonda provou que `customer` existe na *resposta*; que o Asaas o aceite no *request* é a sonda 2c, aguardando re-execução. Se ignorar em silêncio, o cliente vira órfão e o fallback de correlação do webhook nasce morto — por isso o cenário 2 da Task 13.
2. **Aplicador de I/O sem teste unitário** (sem runner Deno). Coberto pelos cenários 3/5/6 ao vivo.
3. **`billing_events.organization_id` não tem consumidor de leitura** hoje — a decisão de não carimbá-lo em eventos `noop` informativos é segura, mas se alguém passar a ler a coluna, revisar.

## Próxima fase

**FASE 4B — Inadimplência: o dinheiro NÃO entra e o acesso desliga.** Precisa de uma assinatura viva ficar em atraso. Herda um pré-requisito bloqueante: o vazamento cross-tenant em `process-billing-reminders/index.ts:77-84` (query de fallback do owner sem filtro de org — pega o owner mais antigo da plataforma inteira; dormente porque não há dispatcher ainda). Corrigir antes de construir o dispatcher da 4b.
