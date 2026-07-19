# FASE 3 — Painel de Planos adaptado + seeds: Resumo de Execução

> Branch `billing-asaas/fase-3`, base `dc464d8` (main pós-Fase 2).
>
> ## 📍 ESTADO ATUAL — leia antes de tocar em billing
>
> **A Fase 3 está aplicada em produção (2026-07-19) e validada por query.**
>
> | | |
> |---|---|
> | Migration `065` (seeds dos 9 planos) | ✅ aplicada, `schema_migrations` = `20260718120000`, sem drift |
> | Deploy de `manage-billing` | ✅ deployada, smoke test do gate de auth OK (401 sem sessão) |
> | Trial de **5 dias** | 🟢 **ATIVO** — `trial-padrao`, único plano `is_trial AND active` |
> | Catálogo comercial (8 produtos) | 🔒 todos `active=false` — cada fase liga o seu |
> | Planos de teste legados | ✅ desativados (ver abaixo) |
> | Dependência de chave Asaas / sandbox | nenhuma |
>
> **Único plano ativo hoje é `trial-padrao`**, que a `PricingTable` filtra — ou seja, a pricing table do cliente está intencionalmente vazia até a Fase 4 ligar o `sistema-reservas`:
> ```sql
> update billing_plans set active = true where slug = 'sistema-reservas';
> ```

---

## ⚠️ Duas descobertas na aplicação que o plano não previa

**1. Não existia trial nenhum em produção — a mudança foi "sem trial → 5 dias", não "14d → 5d".**
O CLAUDE.md documentava trial de 14 dias, mas a query pré-push mostrou os 3 planos legados todos com `is_trial=false`. `manage-organizations` procura `is_trial=true AND active=true`, não achava nada, e **org nova nascia `billing_status='active'` sem relógio de trial**. A partir da 065, org nova nasce `trialing` com 5 dias e o worker `process-trial-expiry` bloqueia no vencimento. Impacto real maior do que "encurtar o trial" sugere — mas é exatamente o que a decisão 3 do plano pede. Orgs existentes não foram tocadas (`trial_ends_at` é gravado na criação).

**2. Havia um plano de teste cobrável que o fix do 403 tornaria visível ao cliente.**
`plano-mensal-teste` estava `active=true`, **R$ 99,99 com Stripe price ID de cartão real**, 0 assinaturas. Enquanto o `list_plans` dava 403 ninguém via; ao deployar a EF, um owner/gerente abriria `/g/<slug>/cobranca`, veria a oferta com botão funcional e conseguiria disparar um checkout Stripe de verdade. `trial-30-dias` (R$ 0, `is_trial=false` — dado inconsistente) apareceria junto.

Ambos foram **desativados antes do deploy da EF** (`active=false`, mesma operação do botão "Desativar" do painel). Seguro: 0 assinaturas nos dois, nenhuma FK afetada, reversível num clique. Reverter:
```sql
update billing_plans set active = true where slug in ('plano-mensal-teste', 'trial-30-dias');
```

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
| `supabase db push` | ✅ aplicada 2026-07-19, `schema_migrations` = `20260718120000` (sem drift) |
| Queries de validação pós-migration | ✅ **12 planos · 1 trial ativo com `trial_days=5` · 0 pacote de IA sem crédito · 0 destaque não backfillado · `instancia-whatsapp` → `implementacao-whatsapp`** |
| Deploy de `manage-billing` | ✅ 2026-07-19 |
| Smoke test da EF | ✅ 401 sem auth e 401 com anon sem sessão — gate correto |
| Criar org de teste e conferir trial de 5d | ❌ **não feito** — ver ressalva |

> **Ressalva honesta sobre o cenário 1.** O plano pedia "criar org de teste e verificar `trialing` + `trial_ends_at = +5d`". Não foi executado: criar org gera `organizations` + `units` + usuário no Auth **de produção**, e a única coisa que `manage-organizations` lê para aplicar o trial é `trial_days` do plano `is_trial AND active` — confirmado por query como `5`, com o código desse caminho intocado nesta fase. O teste de ponta a ponta continua valendo a pena no próximo cadastro real de empresa; a verificação por query cobre a mudança, não o fluxo.
>
> "Rodar os seeds 2x" também não é executável: uma migration aplicada não re-roda. A idempotência foi auditada estaticamente (todo INSERT com `on conflict (slug) do nothing`, os 3 UPDATEs guardados por condição que se auto-anula).

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

1. **Org nova agora expira em 5 dias.** Antes não expirava (não havia trial). O primeiro cadastro real de empresa é quem vai exercitar `process-trial-expiry` de verdade pela primeira vez — vale acompanhar.
2. **A coluna "Empresas usando" nunca viu dado diferente de zero:** não há assinatura não-cancelada em nenhum plano hoje. O caminho de agregação (incluindo o loop `.range()`) está exercitado só no ramo vazio.
3. **Pré-requisito é só dado.** `requires_plan_id` está gravado, mas nada valida a dependência ainda — o gate server-side é entrega da Fase 5.

## O que mudou em produção

**Para o cliente (Ren Sushi, vitalício):** na prática nada. A pricing table de `/g/:slug/cobranca` estava vazia por causa do 403 e **continua vazia** — agora por um motivo honesto: o único plano ativo é o trial, que ela filtra. O ganho é que ela deixou de estar quebrada em silêncio.

**Para `platform_admin`:** o painel de Planos passou a listar 12 produtos com Categoria, Provedor e contagem de empresas; o modal ganhou os campos da 063; e o campo legado `organizations.plan` sumiu da tela de Empresas.

**Para org nova:** passa a nascer `trialing` com 5 dias. Antes nascia `active` sem trial nenhum.

**Nenhum `_shared/` foi tocado**, então nenhuma outra EF precisou de redeploy.

## Rollback

```sql
-- 1. Catálogo seedado (seguro: todos active=false, zero assinaturas)
delete from billing_plans where slug in (
  'sistema-reservas', 'implementacao-whatsapp', 'instancia-whatsapp',
  'credito-ia-50', 'credito-ia-70', 'credito-ia-100', 'credito-ia-150',
  'credito-ia-200', 'trial-padrao');

-- 2. Planos de teste desativados nesta fase
update billing_plans set active = true where slug in ('plano-mensal-teste', 'trial-30-dias');
```

O PART 1 da migration (desativar trial vigente) **não teve efeito** — não havia trial ativo —, então não há o que restaurar ali. Deletar `trial-padrao` devolve o comportamento antigo (org nova sem trial).

Frontend e EF: `git revert` do commit e redeploy de `manage-billing`.

## Próxima fase

**FASE 4 — Assinatura do sistema via Asaas (R$ 449) + inadimplência 5 dias + notificações reais.** É ela que liga `sistema-reservas` (`active=true`), constrói o checkout Asaas roteado por `billing_provider_default`, e implementa o gate `PAYMENT_CONFIRMED` **OU** `PAYMENT_RECEIVED` (PIX/boleto não emite `CONFIRMED` — provado ao vivo, [03 §5](03-ASAAS-API-VERIFICADO.md)). Herda também os 4 itens do reconcile adiados da Fase 2.
