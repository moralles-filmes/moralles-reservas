# FASE 5A — Comercial: implantação do WhatsApp (R$ 750) + assinatura da instância (R$ 149) — Resumo de Execução

> Branch `billing-asaas/fase-5a`, base `d03ce88` (spec). Tasks 1–16 (código) fecham em `ad8d89f`; depois dele, `8b72cd2` (fix independente do gate `secret-hunter`, `.gitignore`) e a documentação da Task 17 (`d897686` + rodada de correção 1 sobre ele).
> Spec: [../superpowers/specs/2026-07-25-billing-asaas-fase-5a-design.md](../superpowers/specs/2026-07-25-billing-asaas-fase-5a-design.md).
> Plano: [../superpowers/plans/2026-07-25-billing-asaas-fase-5a.md](../superpowers/plans/2026-07-25-billing-asaas-fase-5a.md).
> Fase anterior: [FASE-4B-RESUMO.md](FASE-4B-RESUMO.md) (validada em sandbox, tag `billing-asaas/fase-4b`).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing
>
> **Código completo (17 tasks) e verificado localmente. NADA foi aplicado em produção nesta task de fechamento** — migration 076 não rodou `db push`, nenhuma Edge Function foi deployada, o roteiro de sandbox (20 cenários) está escrito mas não executado, e não houve merge/tag. Decisão explícita do dono: a virada do Asaas (e desta fase) fica em sandbox até a última fase do projeto.
>
> | | |
> |---|---|
> | Pipeline de código (Tasks 1–16) | ✅ completo, cada task revisada; várias exigiram 1–2 ciclos de fix |
> | `npm test` | ✅ **256/256** (baseline da 4b era 229; +27 nesta fase: núcleo puro da implantação de WhatsApp) |
> | `npm run typecheck` (`tsc -b`) | ✅ 0 erros |
> | `npm run lint` | ✅ 0 erros, 22 warnings (pré-existentes, baseline inalterada) |
> | Migration `076` (ativa os 2 planos de WhatsApp) | ✅ **criada** nesta task — **NÃO aplicada** (`db push` fica para o dono) |
> | Deploy das 12 Edge Functions afetadas | ❌ **não feito** — lista e ordem no runbook abaixo |
> | Gates `saas-shield-br` | 🟡 **parcial** — ver seção própria; RLS/migration-validator ficam para depois que a 076 existir no repo (já existe) |
> | Roteiro de sandbox (B1–B20) | 📝 **escrito**, não executado — [FASE-5A-ROTEIRO-SANDBOX.md](FASE-5A-ROTEIRO-SANDBOX.md) |
> | Merge em `main` + tag `billing-asaas/fase-5a` | ❌ **não feito** — só depois do sandbox validado |

---

## Escopo entregue

*"Vender implantação (R$750, cobrança única) e instância (R$149/mês) de WhatsApp, sem suspender ninguém."*

1. **Núcleo puro** (`whatsapp-implementation-core.ts`) — matriz origem×pagamento, máquina de estados operacionais, projeção segura pro cliente, cálculo do resumo consolidado de custos. Zero imports, testado por vitest.
2. **Tabela `whatsapp_implementations`** (migration 071) — uma linha por venda/entrega, `payment_status` e `operational_status` em eixos separados, ausência de linha = `NOT_REQUESTED`, uma implantação aberta por org (índice único parcial).
3. **Ciclo de vida de `billing_checkout_sessions`** (migration 072) — dedupe sob concorrência com `status` (`creating→pending→used/expired/canceled/failed`) e sessão ativa única por `(org, plano, purpose)`.
4. **Correlação de múltiplas assinaturas por categoria** (migration 073) — RPC `resolve_or_activate_subscription`, serializada por `pg_advisory_xact_lock(org, categoria)`, substitui o `maybeSingle()` que quebrava com sistema + instância coexistindo.
5. **Sweep de category-awareness** (obrigatório, feito na Task 8) — todo writer de `organizations.billing_status` passa a exigir categoria `SYSTEM_SUBSCRIPTION` via `_shared/billing-category.ts`.
6. **Trava de categoria em `billing_plans`** (migration 074) — trigger recusa mudar `category` de plano com assinatura viva.
7. **Duas flags novas** (migration 075) — `whatsapp_subscription_checkout`, `whatsapp_service_enforcement` (a terceira, `whatsapp_implementation_flow`, já existia).
8. **Checkout avulso (`DETACHED`)** de R$750 (`purpose=implementation`) — primeiro call site real de um caminho escrito na Fase 2 e nunca exercitado.
9. **Checkout recorrente** de R$149 (`purpose=subscription`, categoria `WHATSAPP_SUBSCRIPTION`) — gates repetidos no servidor mesmo com botão escondido.
10. **EF `manage-whatsapp-implementations`** (nova, 7+ actions admin + `get_service_status` pro cliente).
11. **Override mínimo de `whatsapp`** — `_shared/entitlement-overrides.ts`, writer único de `organization_entitlement_overrides`.
12. **Card + resumo consolidado** na tela de cobrança do cliente (`AutomacaoWhatsappCard`).
13. **Painel admin** `/platform/billing/implementacoes` + bloco no detalhe da organização.
14. **Migration 076** (esta task) — ativa os dois planos no catálogo. Última migration da fase.

**Fora de escopo (5b):** suspensão por serviço, gate central de envio, gate do agente, estacionamento/revalidação de jobs, banner de suspensão, restauração pós-pagamento, status real da instância na Z-API, carteira de IA, UI genérica de overrides, fluxo explícito de reimplantação.

## Arquitetura

```
Cliente → create-billing-checkout (purpose: subscription | implementation | payment_method_update)
            ├─ context.ts    → org, plano do banco, cliente Asaas, gates de flag
            ├─ subscription.ts → sistema (SYSTEM_SUBSCRIPTION) e instância (WHATSAPP_SUBSCRIPTION)
            └─ implementation.ts → _shared/implementation-checkout.ts (DETACHED, R$750)
                                    (mesma lógica reusada por manage-whatsapp-implementations/create_asaas_charge)

Asaas → asaas-webhook → applyAsaasEvent (_shared/asaas-billing-events-apply.ts)
          ├─ purpose=subscription → resolve_or_activate_subscription(org, plano) [RPC, migration 073]
          │     └─ só escreve organizations.billing_status se categoria = SYSTEM_SUBSCRIPTION
          └─ purpose=implementation → UPDATE condicional em whatsapp_implementations
                → CONFIRMED + paid_at + billing_invoice_id → billing_notifications (implementation_paid)

Admin → manage-whatsapp-implementations → whatsapp_implementations (CRUD administrativo)
                                          → _shared/entitlement-overrides.ts (grant/revoke de whatsapp)

_shared/billing-category.ts → process-billing-overdue, -reminders, -unblock, -reconcile,
                               process-trial-expiry, manage-billing
  ("essa fatura/assinatura é do SISTEMA?" — sweep de category-awareness)
```

## Arquivos

**Migrations criadas:** `071_whatsapp_implementations.sql`, `072_billing_checkout_sessions_lifecycle.sql`, `073_billing_subscription_category.sql`, `074_billing_plans_category_guard.sql`, `075_platform_flags_whatsapp.sql`, `076_activate_whatsapp_plans.sql`.

**`_shared/` criados:** `whatsapp-implementation-core.ts` (núcleo puro), `billing-category.ts`, `checkout-sessions.ts`, `implementation-checkout.ts`, `entitlement-overrides.ts`.
**`_shared/` modificados:** `asaas-billing-events-apply.ts` (RPC por categoria + confirmação de implantação + `resolvePlatformAdminRecipients`), `entitlements.ts` (`readFailed`), `billing-notify.ts` (`resolvePlatformAdminRecipients`, template `implementation_paid`), `billing-provider.ts`.

**Edge Functions criadas:** `manage-whatsapp-implementations`.
**Edge Functions restruturadas/modificadas:** `create-billing-checkout` (dividida em `index.ts`+`context.ts`+`subscription.ts`+`implementation.ts`+`eligibility.ts`), `manage-billing`, `process-billing-overdue`, `process-billing-reminders`, `process-billing-unblock`, `process-billing-reconcile`, `process-trial-expiry`, `process-billing-notifications` (template novo), `stripe-webhook` (dedupe `23505` no insert legado de `billing_subscriptions`).

**Frontend criado:** `src/components/gestao/AutomacaoWhatsappCard.tsx`, `src/hooks/useWhatsappImplementation.ts`, `src/pages/platform/WhatsappImplementations.tsx`, `src/lib/whatsapp-implementation-core.test.ts`.
**Frontend modificado:** `src/App.tsx` (rota `/platform/billing/implementacoes`), `src/hooks/useBilling.ts`, `src/pages/gestao/Cobranca.tsx`, `src/pages/platform/Billing.tsx`, `src/pages/platform/BillingDetail.tsx`, `src/types/billing.ts`.

**Config:** `supabase/config.toml` (`verify_jwt=true` para `manage-whatsapp-implementations`).

**Documentação (esta task):** `CLAUDE.md` (invariantes + checklist de redeploy), `docs/billing-asaas/FASE-5A-RESUMO.md`, `docs/billing-asaas/FASE-5A-ROTEIRO-SANDBOX.md`.

Só o código das Tasks 1–16: 39 arquivos, +6159/−684 linhas (`git diff --shortstat d03ce88..ad8d89f`). Os totais da branch inteira, incluindo Task 17 e review final, estão na seção de commits abaixo.

## Commits (38 na branch, fora spec e plano)

**Tasks 1–16 (32 commits):** `85459b0` núcleo puro · `9693b0f` migration 071 · `b8cf28e`+`6a80075` migration 072 (+doc) · `1baa538`+`7310677` migration 073 (+fix reconciliação) · `e105444`+`1b67646` migrations 074-075 (+fix security definer) · `40b0272` RPC por categoria no aplicador · `ed56e29` webhook confirma implantação · `c50011d` isola falha do aviso · `2c04fb0`+`7ecaca4` sweep de billing_status · `3d53f0a`+`573b556` honestidade de `isSystemInvoice` (achado mais importante da fase) · `059da1c`+`606ac4a` checkout roteado por purpose · `a86f88a`+`1ff7d74` checkout DETACHED (+fix reuso de sessão) · `6ee4a35`+`f761f02` gates da instância · `59e66a9`+`94dc78a` helper de override · `0180b94`+`37950c5` EF `manage-whatsapp-implementations` · `db7a1f3`+`cd839fc` override de WhatsApp + `get_service_status` · `0fb6a0b`+`772202b`+`242dcff` tela do cliente · `1649358`+`6099f8d`+`ad8d89f` painel admin (+2 rodadas de fix, a 2ª por regressão de parse de valor).

**Fora do escopo comercial:** `8b72cd2` `.gitignore` passa a cobrir `.env*` conforme a regra do `CLAUDE.md` (achado do `secret-hunter`; as três linhas antigas deixariam passar um `.env.sandbox`, plausível nesta migração).

**Task 17, review final e gate de integração (6 commits):** `d897686`+`17eaedf`+`464f5f7` migration 076, invariantes do `CLAUDE.md`, checklist de redeploy, runbook e roteiro de sandbox · `53f25de` correções N1/N2/N3/N4/N6 do review final da branch · `008cbdb` os 2 P1 e 2 P2 do gate de confiabilidade de integração.

Verificação final: `npm run typecheck` 0 erros · `npm test` **265/265** (256 da baseline + 9 novos em `src/lib/billing-amount.test.ts`) · `npm run lint` 0 erros, 22 avisos pré-existentes · `npm run build` limpo. O código Deno das Edge Functions **não é alcançado** por nenhum deles (Deno não instalado, `tsc -b` e vitest param na fronteira de `supabase/functions/`) — ali a verificação é revisão estática mais checagem de sintaxe por esbuild, e é por isso que cada task passou por revisor independente.

## Decisões (aprovadas na spec 2026-07-25)

1. Sem carrinho — um produto, uma sessão, uma cobrança.
2. `grant_type` mantém os 4 rótulos técnicos no banco/API/núcleo; só a UI traduz.
3. R$149 nunca escreve `organizations.billing_status` — coluna é exclusiva do sistema.
4. Assinatura resolvida por categoria do plano via RPC, não por "a assinatura da org".
5. Ambiguidade (2+ assinaturas vivas da mesma categoria) é falha alta, nunca escolha silenciosa.
6. UNIQUE parcial (mesmo plano) + advisory lock (mesma categoria, planos diferentes) — complementares.
7. `payment_status` / `operational_status` sempre separados.
8. `create-billing-checkout` dividida em roteador+contexto+handler por `purpose`.
9. EF nova `manage-whatsapp-implementations` — `manage-billing` já tinha 1347 linhas.
10. `resolvePlatformAdminRecipients()` separado do resolver org-scoped (fix de vazamento da 4b).
11. Ausência de linha em `whatsapp_implementations` = `NOT_REQUESTED`, não linha vazia.

## Riscos residuais / follow-ups

1. **Checkout `DETACHED` nunca exercitado ao vivo até esta task** — escrito na Fase 2, primeiro call site é o checkout de implantação desta fase. O cenário B1 do roteiro de sandbox é quem prova se o Asaas aceita a combinação de `billingTypes`; **não executado ainda** — resultado real fica para quem rodar o roteiro.
2. **Renovação do mês 2+ sem `checkoutSession`** (herdado da 4a) agora vale para duas assinaturas por org (sistema + instância). Correlação por `provider_subscription_id` continua pendente e é **bloqueante antes do primeiro ciclo real** de qualquer uma das duas.
3. **Sessões `creating` órfãs** (isolate morto entre a reserva e a resposta do Asaas) só são varridas na próxima tentativa do MESMO produto. Varredura periódica é follow-up da 5b.
4. **Aviso `implementation_paid` vai para um único admin** (o mais antigo) — o índice de dedupe é parcial em `invoice_id` e o `to` do Resend é único; múltiplos admins não são todos avisados.
5. **`regularized` com `invoice_id=null` na renovação** — follow-up #2 da 4b, ainda aberto (não tocado nesta fase).
6. **Queries sem `.range()`** em overdue/reminders — débito herdado, irrelevante na base atual (1 cliente vitalício + a própria plataforma).
7. **Estorno após entrega não reverte o trabalho** (`payment_status=REFUNDED` com `operational_status=COMPLETED` continua CONCLUÍDA) — política comercial de reembolso parcial não está desenhada; a matriz do banco permite o estado, a decisão de negócio fica em aberto.
8. **Dívida legada do `stripe-webhook`** (não corrigida nesta fase, ver seção própria abaixo) — 4 escritas de `organizations.billing_status` sem checar categoria, inalcançáveis apenas enquanto nenhum plano tiver `provider='stripe'` com Price ID preenchido pelo painel.
9. **Pagamento antigo reprocessado pode liberar org com dívida nova.** Um evento preso é reprocessado por até 5 dias; se a organização for bloqueada nesse intervalo por uma fatura de sistema **posterior**, o `activate_subscription` escreve `billing_status='active'` com base no pagamento velho. **Não é novidade desta fase** — vale hoje para qualquer `activate_subscription` preso, e o `process-billing-unblock` tem a mesma propriedade —, mas a re-checagem do P1-B amplia a superfície. Fechar exige perguntar "há outra fatura de sistema em aberto?" antes de liberar, o que muda o comportamento do caminho legado também. **Decisão explícita necessária antes do primeiro ciclo real de cobrança.**

## Dívida legada do `stripe-webhook` (achado e verificado nesta task)

`supabase/functions/stripe-webhook/index.ts` tem **4 escritas diretas** em `organizations.billing_status` que **não passam pelo sweep de category-awareness** desta fase (linhas 149, 171, 337, 376 — eventos `customer.subscription.created/updated/deleted` e o desbloqueio/bloqueio do fluxo de invoice legado). O sweep da Task 8 tocou deliberadamente só os 7 arquivos listados na spec §7 (`asaas-billing-events-apply.ts` e os 6 workers/EF que já liam "qualquer fatura/assinatura"); `stripe-webhook` ficou de fora por decisão registrada no ledger da Task 8 ("dívida conhecida, documentar na Task 17").

Verificação feita agora: **nenhuma migration popula `stripe_price_id_card`/`_boleto`/`_pix`** — as colunas existem desde `20260528000000_billing_module.sql` (só a definição de schema) e a seed `20260718120000_065_billing_plans_seed.sql` apenas comenta que cada fase ligaria a sua, o que nunca aconteceu. Sem `price_id`, a única action que cria assinatura Stripe nova (`manage-billing` `create_subscription`, admin-only, fora da whitelist `CLIENT_FRIENDLY_ACTIONS`) recusa com 400 pra pagamento em cartão (`"Plano sem price_id de cartão configurado."`); pra outras formas de pagamento ela cria a linha em `billing_subscriptions` com `stripe_subscription_id: null`, que nunca dispara evento Stripe nenhum.

**Correção sobre a primeira versão deste documento: "inalcançável" não é absoluto.** `manage-billing/index.ts:90-94` inclui `stripe_price_id_card`/`_boleto`/`_pix` em `PLAN_WRITABLE_COLUMNS`, e `src/pages/platform/BillingPlans.tsx` tem um bloco de formulário ("Configuração do provedor (legado Stripe)", visível quando `provider === 'stripe'`) que grava as três colunas pelo painel — nenhuma migration precisa popular nada, o admin escreve direto pela UI. **Conclusão correta: o caminho fica inalcançável só enquanto nenhum plano do catálogo tiver `provider='stripe'` com Price ID preenchido** — cenário que um rollback do Asaas tornaria real, não teórico. Invariante no `CLAUDE.md` ajustada para essa condição.

## Gates de segurança (`saas-shield-br`)

Rodados fora desta task, pelo controlador (dono do projeto), conforme decisão explícita de não delegar os gates a esta execução:

| Gate | Escopo | Veredito | Bloqueantes |
|---|---|---|---|
| `tenant-isolation-auditor` | repositório (foco `manage-whatsapp-implementations` e `get_service_status`) | **PASS** | 0 |
| `identity-access-auditor` | `manage-whatsapp-implementations`, `create-billing-checkout`, `entitlement-overrides.ts` | **PASS_WITH_WARNINGS** | 0 (1 P3) |
| `secret-hunter` | diff completo da branch + histórico | **FAIL** (2 P0) | 0 no repo — ver abaixo |
| `rls-auditor` | migrations 071–076 | **PASS_WITH_WARNINGS** | 0 (1 P2) |
| `migration-validator` | as 6 migrations | **PASS_WITH_WARNINGS** | 0 (2 P2) |
| `integration-reliability-auditor` | `asaas-billing-events-apply.ts`, `checkout-sessions.ts`, `implementation-checkout.ts`, `create-billing-checkout`, `asaas-webhook`, `process-asaas-reconcile` | **FAIL** (2 P1) → **corrigido** | 0 após `008cbdb` |

Detalhe do que cada aviso significa:

- **`identity-access` P3:** `isPlatformAdmin`/`canReadOrg` estão duplicados em 4 Edge Functions (`manage-billing`, `manage-payment-methods`, `create-billing-checkout`, `manage-whatsapp-implementations`). Hoje idênticos; o risco é divergirem quando um papel novo aparecer. **Decisão: PR de manutenção próprio** — extrair helper e redeployar 4 EFs no fim de uma fase é exatamente o escopo que a Global Constraint 1 proíbe.
- **`secret-hunter` FAIL, mas nada vazou pelo repositório.** Verificação feita à mão: os dois `.claude/settings*.json` **nunca foram rastreados** (`.gitignore` tem `.claude/*` com exceção só pro `tenancy-profile.yml`), `git log --all -S` devolve **0 commits** para todos os 5 valores, `.env` nunca foi versionado, `dist/` não é rastreado e o bundle carrega apenas a anon key (pública por design). O que existe são **5 credenciais reais em texto puro na configuração local do Claude Code** (token do webhook Asaas, secret do webhook Z-API, 2 chaves Resend), quase certamente vindas de comandos `curl` completos adicionados à allowlist de permissões. A regra dura do `CLAUDE.md` ("rotacione antes de qualquer push") se aplica a secret **commitado** — não foi o caso. Rotação e limpeza da allowlist ficam como decisão do dono.
- **`rls-auditor` P2:** a eficácia do guard da migration 074 depende de o dono da função ter `BYPASSRLS` — fato de **ambiente**, não garantia de schema. Por isso a validação nº 4 do runbook roda pelo caminho `authenticated` com a anon key, e o **sucesso** do UPDATE é o alarme.
- **`migration-validator` P2 (a):** a 072 abre uma janela em que o `create-billing-checkout` **antigo** deixa linhas presas em `status='creating'`, e uma segunda tentativa do mesmo `(organization_id, plan_id, purpose)` dentro da janela falha com `23505` **depois** de já ter criado cobrança real no Asaas. Confirma, por caminho independente, a ordem EF-antes-de-migration do runbook. **P2 (b):** a validação da 074 precisa ser executada (item acima).

Achado de severidade alta em qualquer gate é bloqueante para o merge, por definição do fluxo do projeto (`CLAUDE.md` § Fluxo obrigatório para agentes).

### Os dois P1 do gate de integração (corrigidos em `008cbdb`)

Este gate rodou por último e é o único que achou bloqueante de código. Vale registrar **por que as revisões por diff não podiam tê-los achado**: nenhum dos dois está no código que a fase escreveu — os dois estão na interação desse código com o **caminho de reprocessamento**, que só aparece percorrendo webhook → `billing_events` → `process-asaas-reconcile` → aplicador de ponta a ponta.

**P1-A — a reidratação por `checkoutSession` estava gateada por `!organizationId`.** No checkout hospedado o pagamento chega **sem** `externalReference` (verificado ao vivo, doc 03 §13.7), então o bloco que consulta `billing_checkout_sessions` é a **única** fonte de `purpose` e `planId` desse fluxo. Só que o webhook carimba `billing_events.organization_id` **mesmo quando o evento termina em `failed`**, e o `process-asaas-reconcile` devolve esse valor já preenchido ao aplicador — o que pula os dois portões `!organizationId`, deixa `purpose` em `"other"` e `planId` em `null`, e faz o evento sair como `processed` sem confirmar implantação nem ativar assinatura.

A consequência de terceira ordem é o que torna isso P1: a fatura pode ser registrada **sem vínculo de plano**, e aí `isSystemInvoice` cai no caminho 3 (compatibilidade com fatura legada, devolve `true`) — um pagamento de implantação de R$750 passa a satisfazer o gate do `process-billing-unblock` e **desbloqueia uma organização com a mensalidade do sistema em atraso**. É exatamente o invariante que esta fase existe para proteger, derrotado pela porta dos fundos.

**P1-B — falha depois de a fatura virar `paid` envenenava o evento.** `decideEventEffect` decide por `eventType` + `invoiceStatus`; com a fatura já paga devolve `noop`, e o aplicador retorna `processed` **antes** de checar assinatura ou implantação. Uma primeira passagem que grava a fatura e falha na ativação (`select_plan_category`, `ambiguous_subscription_category` ou a própria RPC — **os três acrescentados por esta fase**) vira `failed`; o reconcile reencontra `paid` → `processed`. Cliente pagou, assinatura nunca criada, evento fora da fila, sem auto-cura e sem alerta. O arquivo já reconhecia essa classe no comentário do branch de falha do `getPayment` e a fechava **só ali**.

**A forma da correção do P1-B importa mais que o efeito.** A correção óbvia — deixar de retornar cedo no `noop` — faria o par `PAYMENT_CONFIRMED` + `PAYMENT_RECEIVED` do cartão pagar um `getPayment` extra **em todo pagamento**, dentro da resposta do webhook: regressão direta contra `ASAAS_IO_BUDGET_MS`, num caminho cuja latência derruba a fila de eventos de todos os clientes. Adotado em vez disso: opção `recheckDurableEffect` no aplicador, default `false`, ligada **só** pelo `process-asaas-reconcile` (cron, sem orçamento de tempo, recuperar evento preso é literalmente sua função) e pelo reprocessamento manual de admin. O webhook mantém o atalho. É o mesmo idioma que o arquivo já usa para `asaasIoBudgetMs` — a distinção é do **caller**, não da decisão pura, e `decideEventEffect` não foi tocado. O `noop` por `invoiceStatus === 'void'` continua retornando cedo em todos os casos: aquilo é anomalia que pede conferência humana, não duplicata benigna.

Junto foram corrigidos dois P2 da mesma rodada: o aviso a platform_admins fazia até 10 chamadas sequenciais ao Auth Admin **dentro da resposta do webhook** usando só a primeira (agora para no primeiro destinatário válido), e o erro do UPDATE de confirmação da implantação era tratado como o erro do aviso, deixando a linha presa em `PENDING` para sempre sem action administrativa que corrigisse (agora degrada para `failed`, o que **só é seguro junto com o P1-B**).

**Redeploy parcial é perigoso nesta correção:** webhook novo com reconcile velho faz o P2 do UPDATE virar regressão — o evento vira `failed` e se auto-resolve como `processed` sem retentar. As seis EFs afetadas (`asaas-webhook`, `process-asaas-reconcile`, `manage-billing`, `process-billing-overdue`, `process-billing-reminders`, `process-trial-expiry`) sobem juntas.

### P3 adiados por decisão explícita

- **Evento que estoura `MAX_RETRY_COUNT` (5) desaparece sem superfície nenhuma** — não há painel (`grep billing_events` em `src/` retorna zero) nem `billing_notifications` enfileirada. O cenário previsto é a renovação do mês 2+, que nasce sem `checkoutSession` e sem `externalReference`, não correlaciona, e some depois de cinco tentativas. **Pré-requisito operacional do primeiro ciclo real**, no mesmo cluster do N3 e da correlação por `provider_subscription_id` da 4b — é o mesmo buraco visto de três ângulos.
- Aviso de divergência do estágio 2 do reconcile sem `invoice_id` não deduplica (o índice é parcial) → uma linha nova por execução diária. Uma linha de código, mas o estágio 2 é inerte hoje.
- `finalizeCheckoutSession` que falha deixa a sessão em `creating` por até 30 min → 409 até a varredura. Não há dinheiro sem registro (a URL nunca é devolvida); contrato já aceito na Task 10.
- A cadeia de correlação tem **elo único de fato**: `externalReference` não é propagado e `customer` não é enviado ao checkout, então os dois primeiros fallbacks são inertes no fluxo hospedado e tudo depende de `billing_checkout_sessions`. Risco assumido e documentado — não defesa em profundidade.
- Ramo Stripe legado devolve `error.message` cru ao cliente (pré-existente, mesmo caminho legado da dívida registrada abaixo).

**Lacuna que o próprio gate declarou:** o comportamento do Asaas na cobrança `DETACHED` (propaga ou não o `externalReference`?) foi **assumido** a partir do doc 03 §13.7, que verificou o `RECURRENT`. Se o `DETACHED` propagar, o P1-A perderia o vetor da implantação mas manteria o da assinatura. **Quem responde é o cenário B1 do roteiro de sandbox** — mais uma razão para rodá-lo antes do go-live.

## Review final da branch inteira

Rodado sobre `d03ce88..464f5f7` depois das 17 tasks, com o inventário de escritas em `organizations.billing_status` feito no **repositório inteiro**, não só no diff.

**O invariante central da fase resiste.** Sete escritas com gatilho financeiro, todas gateadas por categoria; as demais são autoridade administrativa (override manual, expiração de trial), fora do invariante por desenho. A evidência mais forte é negativa: `grep -rn "billing_status"` nos **seis artefatos novos da fase** retorna zero — o código novo não sabe que a coluna existe. Na camada de banco, a 074 é *trigger* (não policy), então vale para `authenticated` e `service_role` igualmente.

**Caminho do dinheiro — 11 etapas auditadas, nenhum ponto em que entra dinheiro sem registro.** `openImplementationCheckout` tem exatamente dois `return ok:true` e ambos são precedidos por guard de insert bem-sucedido; o ramo de reuso **repara** a linha faltante em vez de devolver URL cega; o plano é resolvido por **slug**, não pelo `plan_id` do request; `asaas_enabled` é checada **antes** de criar `cus_` (criar e abortar deixaria órfão no provedor).

### Quatro achados corrigidos (commit `53f25de`)

| # | Onde | Defeito | Correção |
|---|---|---|---|
| **N1** | `src/pages/platform/BillingPlans.tsx` | `parseAmountBRL` tinha o **mesmo** defeito de separador que a Task 16 corrigiu no painel de implantação — mas neste campo, que define **o preço que o cliente paga**: `149.90` viraria R$ 14.990,00/mês, sem aviso, e fluiria para o Asaas. A fase ativa dois planos editáveis por esse formulário. | Regra de parse extraída para [`src/lib/billing-amount.ts`](../../src/lib/billing-amount.ts) com 9 testes vitest, reusada nos dois arquivos, mais **eco do valor interpretado** abaixo do campo. |
| **N2** | `manage-billing` `create_manual_invoice` | Pegava a assinatura da org **sem filtro de categoria**. Agora que uma org pode ter duas, a fatura manual de sistema podia nascer vinculada à instância de R$149 → `isSystemInvoice` daria `false` → **a fatura sumiria dos lembretes e da escalada**. Cobrança manual que nunca cobra. | Filtro `billing_plans.category = SYSTEM_SUBSCRIPTION` + checagem de `.error`, byte a byte igual ao padrão que já existia em `unblock_organization_manual` no mesmo arquivo. |
| **N4** | `process-trial-expiry` | A fase estreitou o skip para categoria de sistema, mas este worker **não chamava** `hasActiveSystemOverride`, que os dois irmãos (`process-billing-overdue`, `process-billing-reminders`) usam. Org `trialing` vencida **com cortesia vitalícia** seria bloqueada às 03:00 UTC — e o único cliente real é justamente vitalício grátis. | Skip acrescentado na mesma posição relativa dos irmãos. |
| **N6** | `AutomacaoWhatsappCard.tsx` | "próximo vencimento" qualificado por `has_instance` em vez do status real da assinatura. | Rótulo e cor derivados de `subscription.status`, com gradação `past_due` → aviso / `unpaid` → destrutivo. |

**N3 é de texto, não de código, e é o mais importante para a próxima fase:** o invariante do `CLAUDE.md` prometia mais do que o código entrega. O caminho 3 de `isSystemInvoice` devolve `true` quando a fatura não carrega **nenhum** vínculo de plano (compatibilidade com fatura legada) — e a **renovação Asaas do mês 2+ nasce exatamente assim**, sem `checkoutSession` e sem `externalReference`. Uma renovação de R$149 da instância satisfaria o gate do `process-billing-unblock` e desbloquearia uma org com a mensalidade do **sistema** em atraso. Inalcançável na 5a (flag OFF, sem ciclo de renovação real), mas **fechar isso é pré-requisito do primeiro ciclo real de cobrança recorrente** — não da 5b em geral. A ressalva está escrita no `CLAUDE.md`.

### Correções de leitura que o review final desfez (minhas, registradas por honestidade)

- **`wrapHtml`/`orgName` sem escape: não há vetor.** `organizations` não tem policy de UPDATE para membro — só `platform_admin`. `organizations.name` não é entrada não-confiável.
- **Teto de 50 linhas em `blockedOrgIds`: risco superestimado.** O `disabled` no `SelectItem` é **dica de UI**, não a trava; quem bloqueia é o índice único, e a EF devolve 409 com mensagem decente. A degradação é "um clique a mais", não corrupção.
- **`regularized` sem `try/catch`: autocura.** Está dentro do try externo; vira `failed`, e o reconcile reencontra `invoice.status='paid'` → `noop` → `processed`. O custo é uma linha de log assustadora.
- **Fatura do 1º pagamento com `billing_subscription_id: null`:** `isSystemInvoice` classifica certo pelo caminho 2 (`external_reference` reidratado da sessão). Prejuízo é de relatório, não de gate.

### Minors adiados pelo review final

`N5` `has_system_subscription` inclui `unpaid`/`paused`, então org com assinatura de sistema pausada perde o aviso de "valor de tabela" · `N7` `costs` é o único bloco camelCase num payload snake_case · `N8` `prices_unavailable` é obrigatório enquanto `system_allowed` é opcional · `N9` action `get` sem consumidor · `N10` duas fontes de preço com filtros de `active` diferentes (a ordem do runbook já previne o sintoma).

## Runbook de ativação (ordem obrigatória — NADA disto foi executado)

Fora dessa ordem, coisas quebram. Nenhum passo abaixo foi rodado nesta task — go-live de produção segue **deferido para a última fase do projeto**.

### 1. Deploy das Edge Functions ANTES do merge em `main`

O frontend sobe sozinho pela Vercel no merge; as Edge Functions são deploy manual. Duas quebras concretas na janela entre o merge e o deploy manual:

- **`create-billing-checkout`** — o frontend novo manda `purpose` e não manda mais `mode`; a EF antiga (pré-fase) não conhece `purpose`, então "Trocar cartão" quebra para todo cliente com assinatura ativa.
- **`manage-whatsapp-implementations`** — sem ela deployada, todo owner/gerente vê card de erro em `/g/:slug/cobranca` (o card de Automação WhatsApp chama `get_service_status`).

Lista final de EFs a deployar — **12**, derivada do checklist de redeploy do `CLAUDE.md` (seção Deploy → Edge Functions) cruzado com `git diff --stat d03ce88..ad8d89f` para achar EFs com mudança DIRETA de código (não só via `_shared/`):

```
supabase functions deploy create-billing-checkout
supabase functions deploy manage-whatsapp-implementations
supabase functions deploy asaas-webhook
supabase functions deploy process-asaas-reconcile
supabase functions deploy manage-billing
supabase functions deploy process-billing-overdue
supabase functions deploy process-billing-reminders
supabase functions deploy process-billing-unblock
supabase functions deploy process-billing-reconcile
supabase functions deploy process-trial-expiry
supabase functions deploy process-billing-notifications
supabase functions deploy stripe-webhook
```

A lista do brief da Task 17 tinha 11 — **faltava `stripe-webhook`**, que teve mudança de código direta nesta fase (dedupe de `23505` no insert legado de `billing_subscriptions`, commit dentro da Task 8). Sem redeploy, o Stripe reentregaria o mesmo `checkout.session.completed` em loop 5xx até o isolate antigo expirar. Acrescentada à lista.

### 2. Antes do `db push` — consulta de pré-voo (assinatura duplicada por organização)

```sql
select organization_id, billing_plan_id, count(*)
  from billing_subscriptions
 where status <> 'canceled'
 group by 1, 2
having count(*) > 1;
```

Esperado: **zero linhas**. A `UNIQUE (organization_id, billing_plan_id) WHERE status <> 'canceled'` da migration 073 falha o `db push` inteiro se alguma linha bater — melhor achar antes (e o rollback do `db push` é atômico, mas custa um ciclo). Origem: achado P3 do ledger da Task 4 (FINDING-002), parqueado explicitamente para esta task.

Segunda consulta de pré-voo, pela mesma origem:

```sql
select organization_id, billing_plan_id, provider, status
  from billing_subscriptions
 where provider <> 'asaas'
   and status <> 'canceled';
```

Esperado: **zero linhas** (o único plano com provedor diferente é o `trial-padrao`, `provider='manual'`, atribuído fora do checkout). Se aparecer linha viva de provedor não-Asaas, vale conferir o ramo de reconciliação da RPC `resolve_or_activate_subscription` antes de aplicar: por decisão da Task 4, **`provider` e `provider_subscription_id` só mudam juntos** — se o pagamento não trouxer um id novo, o `provider` fica intocado, porque uma linha Stripe coerente consigo mesma é melhor que uma linha mista (provedor Asaas segurando id da Stripe).

### 3. `supabase db push`

Nunca colar SQL no Studio: o Studio grava em `schema_migrations` com timestamp diferente do nome do arquivo e trava o próximo `db push` por drift (`supabase migration repair --status reverted <ver>` para recuperar).

### 4. Validar o guard da migration 074 pelo caminho `authenticated`

A trigger que recusa mudar `category` de plano com assinatura viva foi reescrita como `SECURITY DEFINER` (Task 5) porque a policy `platform_admin_all_billing_plans` já permite `UPDATE` direto via RLS `authenticated`. **Testar autenticado como `platform_admin` usando a chave anon — nunca com `service_role`**, que bypassa RLS e dá falso positivo mesmo se o guard estiver quebrado. Se o dono da função não tiver `BYPASSRLS`, o guard fica inerte e ninguém percebe até um admin trocar a categoria de um plano com assinatura viva. **Bloqueante antes de vender qualquer plano** — condição residual registrada no ledger da Task 5.

### 5. Conferir o override de `system` do Ren Sushi (não só o de `whatsapp`)

```sql
select feature, grant_type, ends_at
  from organization_entitlement_overrides
 where organization_id = '<ren-sushi-org-id>'
   and revoked_at is null;
```

Esperado: linha `feature='system'` E linha `feature='whatsapp'`, ambas `LIFETIME`. Se só a de `whatsapp` existir, a tela de cobrança do Ren Sushi passa a mostrar preço de tabela pro sistema assim que as flags ligarem (mesma classe do C1 corrigido na Task 15, mas pro lado do sistema).

### 6. Confirmar que os planos ficaram ativos (efeito da migration 076, aplicada no passo 3)

**Não é uma ação nova** — `supabase db push` aplica TODAS as migrations pendentes de uma vez, então a 076 já rodou junto com 071–075 no passo 3. Rodar de novo o `update` aqui (ou pior, colar no Studio) seria redundante e tentaria alguém a burlar a disciplina de migration do projeto. Este passo é só a confirmação, na ordem em que ela faz sentido — depois do guard da 074 validado (passo 4) e do override do Ren Sushi conferido (passo 5):

```sql
select slug, active, category,
       (select slug from billing_plans r where r.id = p.requires_plan_id) as requires
  from billing_plans p
 where slug in ('implementacao-whatsapp', 'instancia-whatsapp');
```

Esperado: **2 linhas, `active=t`** (query de validação já documentada no rodapé da própria migration 076). `active=false` não é só cosmético (some da vitrine) — o servidor **recusa o checkout** enquanto o plano estiver inativo: `implementation-checkout.ts:148` devolve 400 `"Produto indisponível no momento."`, `create-billing-checkout/subscription.ts:50` devolve 400 `"Plano inativo."`. Mas `active=true` sozinho **não expõe nada a cliente real**: `whatsapp_implementation_flow` é checada de novo no servidor (`create-billing-checkout/implementation.ts:23`, não só na UI) e `asaas_enabled` gateia o checkout inteiro — as duas ainda estão OFF neste ponto do runbook. Quem de fato abre a venda é o passo 7. Este passo só evita seguir adiante com uma suposição errada sobre o estado do catálogo.

### 7. Ligar as flags NESSA ORDEM: `asaas_enabled` → `whatsapp_implementation_flow` → `whatsapp_subscription_checkout`

Com as flags ligadas e os planos ainda **inativos** (ordem invertida dos passos 6/7), o super-admin recebe o catálogo inteiro em `list_plans` e vê preço real + botão habilitado, mas a tentativa de contratar leva 400 (plano inativo); o cliente comum vê botão desabilitado sem explicação nenhuma do motivo. Achado registrado no ledger da Task 15.

`whatsapp_subscription_checkout` fica **OFF em produção** ao final da 5a por decisão de produto (ver Nota de encerramento do brief): vender a mensalidade sem poder suspender por falta de pagamento (gate central de envio é da 5b) é assumir custo de Z-API sem contrapartida. Ela só liga durante a janela de teste dos cenários B9–B11 do roteiro de sandbox, e volta a OFF no fim.

---

## Resultado do sandbox

**Não executado nesta task**, por decisão explícita do controlador. O roteiro completo (20 cenários, B1–B20) está escrito e pronto pra execução em [FASE-5A-ROTEIRO-SANDBOX.md](FASE-5A-ROTEIRO-SANDBOX.md), com passo a passo verificável e resultado esperado objetivo para cada cenário. Quem rodar o roteiro deve preencher a coluna de resultado real naquele documento e trazer o veredito de volta para este resumo antes de merge/tag.

## Rollback

- **Parar vendas novas sem perder eventos:** `update billing_plans set active=false where slug in ('implementacao-whatsapp','instancia-whatsapp');` — o botão some, mas o webhook segue ligado e não perde pagamento em trânsito.
- **Desligar só a instância:** `update platform_flags set value='false' where key='whatsapp_subscription_checkout';` — mantém a implantação vendável.
- **Desligar tudo de WhatsApp:** as duas flags (`whatsapp_implementation_flow` e `whatsapp_subscription_checkout`) para `false` — cards somem e os dois checkouts são recusados no servidor mesmo se alguém burlar a UI.
- **Migrations são aditivas — ficam.** O sweep de category-awareness (Task 8) **não é revertido**: corrige comportamento errado que já existia antes desta fase, independente da venda de WhatsApp.
- Rollback específico de cada migration está no rodapé do próprio arquivo `.sql`.

## Próxima fase

**FASE 5B — Enforcement por serviço**: worker de inadimplência específico da instância de WhatsApp, gate central de envio, gate do agente, estacionamento e revalidação de jobs, banner de suspensão, restauração pós-pagamento. Pré-requisito antes de ligar `whatsapp_subscription_checkout` em produção — cobrar sem poder suspender é custo sem contrapartida.
