# FASE 3 — Painel de Planos adaptado + seeds: Resumo de Execução

> Branch `billing-asaas/fase-3`, base `dc464d8` (main pós-Fase 2).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing
>
> | | |
> |---|---|
> | Código (painel, EF, seeds) | ✅ escrito, verificado, **não mergeado** |
> | Migration `065` (seeds dos 9 planos) | ❌ **NÃO aplicada** — depende de `supabase db push` |
> | Deploy de `manage-billing` | ❌ **NÃO feito** |
> | Trial 14d → 5d | ⏳ só vale **depois** do `db push` |
> | Dependência de chave Asaas / sandbox | nenhuma |
>
> **A Fase 3 não muda nada em produção enquanto a migration não for aplicada e a EF não for deployada.** Os dois passos estão em "Como aplicar", no fim.

---

## Entregue

**Migration `20260718120000_065_billing_plans_seed.sql`** — seed idempotente (`on conflict (slug) do nothing`) dos 9 produtos: `sistema-reservas` (R$ 449/mês), `implementacao-whatsapp` (R$ 750 única), `instancia-whatsapp` (R$ 149/mês, `requires_plan_id` → implantação), `credito-ia-50/70/100/150/200` (R$ 70 com `recommended=true`), `trial-padrao` (5 dias).

**Edge Function `manage-billing`**
- `list_plans` entrou em `CLIENT_FRIENDLY_ACTIONS` e passou a moldar a resposta por papel: admin recebe tudo + `active_subscriptions`; owner/gerente recebe só `active=true` e as colunas de vitrine.
- `create_plan` e `update_plan` passaram a usar a whitelist `PLAN_WRITABLE_COLUMNS`.
- `validatePlanEnums` (400 com mensagem PT-BR) e `planWriteError` (traduz 23505 / 23514 / 23503).

**Frontend**
- `BillingPlans.tsx`: colunas Categoria, Provedor e Empresas; badge RECOMENDADO; modal com Categoria, Provedor, Tipo de cobrança, Valor creditado (só IA), Recomendado, Pré-requisito e Metadados JSON; seção Stripe virou `<details>` colapsável, visível só em `provider='stripe'`.
- `src/lib/billing-plan-display.ts` (novo) — derivações puras, 13 testes.
- `PricingCard` passou a destacar por `recommended`; `PricingTable` passou a filtrar por `isSelectableSystemPlan`.
- `Empresas.tsx`: campo e coluna legados `organizations.plan` removidos da UI.

## Verificação

| Item | Resultado |
|---|---|
| `npm run lint` | 0 erros (22 warnings pré-existentes, **nenhum novo**) |
| `npm run typecheck` | 0 erros |
| `npm run test` | **173/173** (13 novos) |
| `npm run build` | OK |
| `npx deno@2.1.4 check manage-billing` | limpo |
| `supabase db push` | ❌ **não rodado** |
| Deploy de `manage-billing` | ❌ **não feito** |
| Seeds rodados 2x / org de teste com trial 5d | ❌ **não rodados** — dependem do `db push` |

> Os testes que o plano pedia para a Fase 3 ("rodar seeds 2x", "criar org de teste e verificar `trialing` + `trial_ends_at = +5d`") **exigem banco** e ficam para quem aplicar. As queries estão no rodapé da própria migration.

---

## Decisões que desviaram do plano (e por quê)

**1. Todos os planos comerciais nascem `active=false`. O plano dizia `sistema-reservas` "ativo".**
Corrigir o 403 do `list_plans` faz o `PricingTable` do cliente popular pela primeira vez para owner/gerente. Com `sistema-reservas` ativo, `provider='asaas'` e sem `stripe_price_id`, o cliente veria um botão de R$ 449 que chama `create-billing-checkout` → Stripe → falha, porque o roteamento por `billing_provider_default` só chega na Fase 4. Cada fase liga o seu com uma linha:
```sql
update billing_plans set active = true where slug = 'sistema-reservas';   -- Fase 4
```

**2. `recommended` virou o destaque canônico; `popular` é legado read-only.**
A migration 063 criou `recommended`, mas quem pintava o badge era `popular` — duas colunas para o mesmo papel, e o seed do plano marcaria a que ninguém lê. A UI não escreve mais em `popular`; a coluna fica no banco.

**3. `list_plans` liberado para owner/gerente (bug pré-existente, fora do escopo original).**
`Cobranca.tsx` (área do cliente) chama `useBillingPlans()`, mas `list_plans` não estava na whitelist — todo owner/gerente não-admin levava 403 e via a pricing table vazia. Nunca apareceu porque o operador da plataforma acessa como `platform_admin`. A action não tem `organization_id` para checar contra o caller (é catálogo global), então quem protege é a forma da resposta.

**4. `PricingTable` passou a filtrar por categoria, não só por `is_trial`.**
Sem isso, o item 3 faria o cliente ver "Implantação WhatsApp R$ 750" e 5 pacotes de IA como planos contratáveis. Nenhum checkout os processa até as Fases 5 e 7.

## Bugs pré-existentes corrigidos no caminho

1. **`create_plan` descartava campos em silêncio.** O destructuring explícito derrubava `description`, `trial_days`, `popular` e `is_trial` — a UI mandava, o banco nunca via. Efeito prático: criar um plano de trial pelo painel não funcionava; só editar depois. Sem a correção, `category` e `provider` cairiam no mesmo buraco.
2. **O toast de "já existe trial ativo" era código morto.** O frontend procurava `23505` na string do erro, mas a EF substituía tudo por "Falha ao salvar plano.". A tradução agora é server-side.
3. **`update_plan` fazia spread cru do body** — qualquer chave do payload virava coluna. Agora é whitelist.

## Achados das auditorias (todos corrigidos antes do commit)

Três agentes revisaram: validador de migration, `edge-function-guard` na EF e revisão de regressão no frontend. Veredito: migration **aprovada sem bloqueantes**, EF **aprovada para deploy**. O que os três acharam e foi corrigido:

1. **[migration] Trial podia virar no-op silencioso.** Se o trial vigente já se chamasse `trial-padrao`, o `on conflict do nothing` não inseria e o `slug <> 'trial-padrao'` do PART 1 o protegia da desativação — resultado: migration "passa" e os 14 dias ficam. Fechado com um UPDATE explícito de `trial_days`.
2. **[migration] Faltava bloco de rollback.** Adicionado, com o aviso de anotar `id`/`slug` do trial vigente **antes** do push.
3. **[frontend] `recommended` não era backfillado de `popular`.** Plano hoje destacado perderia badge e borda na pricing table no instante do deploy, sem erro e sem o admin conseguir ver o `popular=true` que ficou (o switch saiu da UI). Backfill adicionado no PART 1.5 da 065.
4. **[frontend] Trocar o Provedor para Asaas apagava os Stripe Price IDs.** Editar um plano Stripe **com assinantes vivos** e mexer no select zerava os `price_...` de forma irreversível pela UI, e `create-billing-checkout` deixaria de criar assinatura nele. Agora os Price IDs são **preservados** — ficam gravados e simplesmente não são lidos enquanto `provider != stripe`.
5. **[EF] Contagem de "Empresas" sem `.range()`.** Violava invariante explícito do CLAUDE.md: PostgREST trunca em 1000 sem erro, e a coluna passaria a subcontar em silêncio. Agora é loop paginado.
6. **[EF] `requires_plan_id` podia apontar pro próprio plano.** Passa no CHECK e na FK; só explodiria como ciclo no gate de checkout da Fase 5. A UI já excluía o próprio plano do select — agora a EF fecha o caminho via curl.
7. **[frontend] `<summary>` mostrava marcador duplo no Safari/iOS** (`list-none` não cobre `::-webkit-details-marker`), e a seção Stripe abria colapsada mesmo em plano legado com `price_...` preenchido. Ambos corrigidos.

Confirmado pelas auditorias como **correto, não bug**: `popular` sair do form não zera a coluna (a whitelist só grava chave presente no body); `handleReactivate` segue funcionando; nenhum plano de produção some da `PricingTable` (a 063 backfillou `category` com `NOT NULL DEFAULT`); e `Cobranca.tsx` não lê nenhum campo que a EF passou a omitir para não-admin.

Ficou registrado e **não** foi corrigido (fora do escopo, pré-existente): a policy `authenticated_read_active_plans` permite `select *` direto em `billing_plans` para qualquer autenticado, então o endurecimento de colunas da EF é defesa em profundidade, não a única barreira. Se `provider_metadata` passar a guardar algo sensível, o vazamento seria pela tabela — não pela EF. Decidir antes de popular essa coluna.

## Invariantes fixados (não quebrar)

- **`amount_cents` é CENTAVOS em todo o catálogo.** A conversão para os reais decimais do Asaas acontece só na fronteira do `AsaasBillingProvider` ([03 §9.1](03-ASAAS-API-VERIFICADO.md)). Seed em reais cobraria 100x.
- **Duração do trial não é constante de código** — sai de `billing_plans.trial_days` do único plano `is_trial AND active` ([manage-organizations/index.ts:178](../../supabase/functions/manage-organizations/index.ts)).
- **`trial_ends_at` é calculado na criação da org e nunca recalculado.** Orgs já em trial não são afetadas pela troca 14d → 5d.
- **Plano `one_time` carrega `interval='month'`** por a coluna ser NOT NULL com CHECK `month|year`. Ler `plan.interval` direto na UI mente; usar `planIntervalLabel()`.
- **Todo campo da migration 063 é opcional no tipo `BillingPlan`** (EF antiga deployada pode não devolvê-lo). Normalizar sempre pelos helpers de `billing-plan-display.ts`, nunca ler cru.

## Riscos residuais

1. **Nada disso executou contra banco.** Migration 065 nunca rodou; a contagem `active_subscriptions` e o `list_plans` moldado por papel nunca viram dados reais.
2. **O `db push` troca a política de trial de 14 para 5 dias no instante em que roda.** Só afeta orgs criadas depois.
3. **Ordem de deploy importa:** aplicar a migration **antes** de deployar `manage-billing` é o mais seguro, mas a EF nova tolera os dois estados (os campos da 063 já existem desde a Fase 1). O que **não** pode é deployar o frontend sem a EF — o painel mostraria "—" na coluna Empresas para sempre.
4. **Pré-requisito é só dado.** `requires_plan_id` está gravado, mas nada valida a dependência ainda — o gate server-side é entrega da Fase 5.

## Mudou alguma coisa em produção?

**Enquanto a migration não for aplicada e a EF não for deployada: nada.**

Depois de aplicar, para `platform_admin`: o painel de Planos ganha colunas e campos novos e passa a listar 9 produtos. Para **cliente owner/gerente**: a pricing table de `/g/:slug/cobranca`, que hoje está vazia por causa do 403, passa a funcionar — e mostra apenas planos `SYSTEM_SUBSCRIPTION` ativos, que neste momento são só os planos Stripe legados que já existiam. Nenhum produto novo aparece, porque todos nascem inativos.

## Rollback

- Frontend e EF: `git revert` do range, ou não mergear.
- Migration: bloco de rollback comentado no rodapé de [065](../../supabase/migrations/20260718120000_065_billing_plans_seed.sql). **Anote `id` e `slug` do trial vigente ANTES do push** — o PART 1 desativa esse plano e `billing_plans` não tem trigger de auditoria, então não há como descobrir depois qual linha foi.

## Como aplicar

```bash
# 1. ANTES de tudo — anote o trial vigente (o rollback depende disto)
#    select id, slug, trial_days from billing_plans where is_trial and active;

# 2. Migration
supabase db push

# 3. Validação pós-migration: as 3 queries no rodapé da 065
#    Esperado: 9 linhas, 1 sola ativa (trial-padrao, trial_days=5)

# 4. Edge Function
supabase functions deploy manage-billing

# 5. Teste do cenário 1: criar org de teste pelo painel e conferir
#    billing_status='trialing' e trial_ends_at = hoje + 5 dias
```

Nenhum `_shared/` foi tocado, então **nenhuma outra EF precisa de redeploy**.

## Próxima fase

**FASE 4 — Assinatura do sistema via Asaas (R$ 449) + inadimplência 5 dias + notificações reais.** É ela que liga `sistema-reservas` (`active=true`), constrói o checkout Asaas roteado por `billing_provider_default`, e implementa o gate `PAYMENT_CONFIRMED` **OU** `PAYMENT_RECEIVED` (PIX/boleto não emite `CONFIRMED` — provado ao vivo, [03 §5](03-ASAAS-API-VERIFICADO.md)). Herda também os 4 itens do reconcile adiados da Fase 2.
