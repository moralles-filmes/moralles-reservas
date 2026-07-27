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

Total do código das Tasks 1–16: 39 arquivos, +6159/-684 linhas (`git diff --stat d03ce88..ad8d89f`). Em cima disso: `8b72cd2` (1 arquivo, `.gitignore`, fix de `secret-hunter` não relacionado ao escopo comercial da fase) e a documentação desta Task 17 (`CLAUDE.md` + 3 arquivos novos em `docs/billing-asaas/`, commit `d897686` e a rodada de correção 1 sobre ele).

## Commits (Tasks 1–16, 32 commits)

`85459b0` núcleo puro · `9693b0f` migration 071 · `b8cf28e`+`6a80075` migration 072 (+doc) · `1baa538`+`7310677` migration 073 (+fix reconciliação) · `e105444`+`1b67646` migrations 074-075 (+fix security definer) · `40b0272` RPC por categoria no aplicador · `ed56e29` webhook confirma implantação · `c50011d` isola falha do aviso · `2c04fb0`+`7ecaca4` sweep de billing_status · `3d53f0a`+`573b556` honestidade de `isSystemInvoice` (achado mais importante da fase) · `059da1c`+`606ac4a` checkout roteado por purpose · `a86f88a`+`1ff7d74` checkout DETACHED (+fix reuso de sessão) · `6ee4a35`+`f761f02` gates da instância · `59e66a9`+`94dc78a` helper de override · `0180b94`+`37950c5` EF `manage-whatsapp-implementations` · `db7a1f3`+`cd839fc` override de WhatsApp + `get_service_status` · `0fb6a0b`+`772202b`+`242dcff` tela do cliente · `1649358`+`6099f8d`+`ad8d89f` painel admin (+2 rodadas de fix, a 2ª por regressão de parse de valor).

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

## Dívida legada do `stripe-webhook` (achado e verificado nesta task)

`supabase/functions/stripe-webhook/index.ts` tem **4 escritas diretas** em `organizations.billing_status` que **não passam pelo sweep de category-awareness** desta fase (linhas 149, 171, 337, 376 — eventos `customer.subscription.created/updated/deleted` e o desbloqueio/bloqueio do fluxo de invoice legado). O sweep da Task 8 tocou deliberadamente só os 7 arquivos listados na spec §7 (`asaas-billing-events-apply.ts` e os 6 workers/EF que já liam "qualquer fatura/assinatura"); `stripe-webhook` ficou de fora por decisão registrada no ledger da Task 8 ("dívida conhecida, documentar na Task 17").

Verificação feita agora: **nenhuma migration popula `stripe_price_id_card`/`_boleto`/`_pix`** — as colunas existem desde `20260528000000_billing_module.sql` (só a definição de schema) e a seed `20260718120000_065_billing_plans_seed.sql` apenas comenta que cada fase ligaria a sua, o que nunca aconteceu. Sem `price_id`, a única action que cria assinatura Stripe nova (`manage-billing` `create_subscription`, admin-only, fora da whitelist `CLIENT_FRIENDLY_ACTIONS`) recusa com 400 pra pagamento em cartão (`"Plano sem price_id de cartão configurado."`); pra outras formas de pagamento ela cria a linha em `billing_subscriptions` com `stripe_subscription_id: null`, que nunca dispara evento Stripe nenhum.

**Correção sobre a primeira versão deste documento: "inalcançável" não é absoluto.** `manage-billing/index.ts:90-94` inclui `stripe_price_id_card`/`_boleto`/`_pix` em `PLAN_WRITABLE_COLUMNS`, e `src/pages/platform/BillingPlans.tsx` tem um bloco de formulário ("Configuração do provedor (legado Stripe)", visível quando `provider === 'stripe'`) que grava as três colunas pelo painel — nenhuma migration precisa popular nada, o admin escreve direto pela UI. **Conclusão correta: o caminho fica inalcançável só enquanto nenhum plano do catálogo tiver `provider='stripe'` com Price ID preenchido** — cenário que um rollback do Asaas tornaria real, não teórico. Invariante no `CLAUDE.md` ajustada para essa condição.

## Gates de segurança (`saas-shield-br`)

Rodados fora desta task, pelo controlador (dono do projeto), conforme decisão explícita de não delegar os gates a esta execução:

| Gate | Escopo | Status |
|---|---|---|
| `tenant-isolation-auditor` | repositório (foco `manage-whatsapp-implementations` e `get_service_status`) | ✅ **PASS, zero achados** (registrado no ledger da fase) |
| `identity-access-auditor` | `manage-whatsapp-implementations`, `create-billing-checkout`, `entitlement-overrides.ts` | ✅ **passou com 1 observação de manutenção** (não bloqueante) |
| `secret-hunter` | diff completo da branch | 🟡 **em andamento** no momento do fechamento desta task |
| `rls-auditor` | migrations 071–076 | ⏳ **pendente** — corre depois que a 076 existir no repo (agora existe) |
| `migration-validator` | as 6 migrations | ⏳ **pendente** — mesma dependência acima |
| `integration-reliability-auditor` | `asaas-billing-events-apply.ts`, `checkout-sessions.ts`, `implementation-checkout.ts` | ⏳ **status não reportado a esta task** — confirmar com o controlador antes do merge |

Achado de severidade alta em qualquer gate pendente é bloqueante para o merge, por definição do fluxo do projeto (`CLAUDE.md` § Fluxo obrigatório para agentes).

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
