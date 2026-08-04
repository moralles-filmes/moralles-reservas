# Plano B — Catálogo comercial de dois planos e retirada das superfícies antigas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar o Plano Reservas como único produto de assinatura contratável, semear o Plano Automação preparado e estruturalmente não-ativável, e retirar do runtime cliente-facing toda oferta dos produtos antigos — tudo no mesmo lote indivisível.

**Architecture:** Duas migrations (guarda estrutural primeiro, troca atômica de catálogo depois), a vitrine passando a respeitar `active`, o adapter de `manage-whatsapp-implementations` projetando os planos novos, o card do lojista trocando o botão de contratar instância por um bloco informativo sem CTA, o painel admin exibindo os campos contratuais como leitura, e um guardrail por caminho que reprova se uma superfície comercial nova entrar sem classificação.

**Tech Stack:** Postgres/Supabase (migrations idempotentes), Deno (Edge Functions), TypeScript, React, vitest.

**Spec:** [2026-08-02-modelo-comercial-dois-planos-design.md](../specs/2026-08-02-modelo-comercial-dois-planos-design.md) v1.0 congelada — §A6, §A6.1, §A6.2, §2.2, §24.
**Predecessor:** [Plano A](2026-08-02-dois-planos-A-modelo-e-entitlement.md) — colunas 094/095, entitlement, resolvedor, allowance. Concluído, não aplicado.

---

## Global Constraints

**Produção e segurança**
- Repositório vinculado à produção, **sem Docker**. Nenhum comando Supabase remoto: `db push`, `functions deploy`, `secrets set` estão **fora** deste plano. Nenhuma flag, nenhum cron, nenhum merge.
- **Ren Sushi é vitalício, grátis, e não pode quebrar.** Override LIFETIME em `system`, `whatsapp`, `ai`. Nenhuma tarefa deste plano pode alterar o que ele vê ou paga.
- Migration não embute segredo nem a URL do projeto Supabase. Idempotente por design.
- Edge Function nunca devolve `error.message` cru do Postgres.

**Coordenação entre frentes (6c, B, D em paralelo)**
- **Faixa de migration reservada: 097–098.** Nenhum outro número.
- **NÃO editar `CLAUDE.md`.** Tudo que entraria no checklist de redeploy vai para `docs/billing-asaas/PLANO-B-PENDENCIAS.md`, seção "CLAUDE.md a consolidar".
- **Arquivos proibidos nesta frente:** `entitlements-core.ts`, `ai-providers.ts`, `manage-whatsapp-instances`, `manage-channels`, `WhatsappInstances.tsx`. Se uma task parecer exigir um deles, **PARE e avise** — não improvise.
- Branch: `dois-planos/plano-b` (já criada a partir de `billing-asaas/fase-6b`). **Nunca commitar em `billing-asaas/fase-6b`.**

**Arquivos fora da lista declarada que este plano precisa tocar** — declarados aqui de propósito, nenhum deles é de outra frente:
| Arquivo | Por que é inevitável |
|---|---|
| `supabase/functions/_shared/whatsapp-implementation-core.ts` | é o núcleo puro **de** `manage-whatsapp-implementations`; o resumo de custos vive nele, não no `index.ts` |
| `src/types/billing.ts` | o contrato do payload da EF e as colunas novas de `BillingPlan` são tipados aqui |
| `src/lib/whatsapp-implementation-core.test.ts` | teste do núcleo acima |
| `src/lib/billing-plan-display.test.ts` | teste do helper de vitrine |

**Convenções**
- Migration: `YYYYMMDDHHMMSS_NNN_nome.sql`. Números **097** e **098**.
- `npm run typecheck` é **`tsc -b --noEmit`** — nunca sem `-b`. Baseline: zero erros.
- Núcleo puro em `supabase/functions/_shared/`, teste em `src/lib/*.test.ts` (cross-boundary, padrão estabelecido).
- **`strict: false`**: estreitar união discriminada exige `x.kind === "..."` ou early-return.
- CSS via `cn()`; nunca template literal Tailwind. Grid de par de inputs usa `grid-cols-1 sm:grid-cols-2`.

**Os dois gates que este plano não pode violar**

1. **`PLAN_AUTOMACAO_CHECKOUT = NO-GO`.** O Plano B libera a venda do **Plano 1 apenas**. O Plano 2 fica **visível, preparado, não contratável e não ativável** até o Plano D entregar e provar o teto de R$ 100 contra banco real. Sem teto não existe pior caso de custo e a margem de 43% (§13) perde o piso. Este plano torna o gate **estrutural** (CHECK no banco, Task 1), não uma configuração.
2. **`active = false` não remove produto antigo do runtime.** Os slugs antigos estão hardcoded em código cliente-facing. Inativar não basta — os call sites saem no **mesmo lote** do seed (Tasks 5 e 6, junto da migration da Task 2).

**Decisões do usuário travadas antes deste plano**
- **Oferta do Plano 2:** bloco **informativo**, sem checkout, sem botão "Contratar", sem botão morto, sem link que simule contratação, **sem CTA de WhatsApp/e-mail**. Mostra nome, preço, funcionalidades e a informação de que a contratação é feita pela plataforma.
- **Campos contratuais no painel admin:** **read-only**. Não ampliar o escopo para `manage-billing`. Pendência formal `ADMIN_PLAN_CONTRACT_FIELDS_AUDITED_WRITE` registrada na Task 8.

---

## O lote comercial indivisível (§24) — onde cada item é entregue

| # | Item do lote | Task |
|---|---|---|
| 1 | semear `plano-reservas` | 2 |
| 2 | semear `plano-automacao` | 2 |
| 3 | retirar produtos antigos da nova vitrine | 2 (banco) + 3 (frontend) |
| 4 | adaptar `manage-whatsapp-implementations` (projeção de preços da §A6) | 5 |
| 5 | remover `contratarInstancia` da experiência nova | 6 |
| 6 | apresentar upgrade para o Plano Automação no lugar | 6 |
| 7 | manter `implementacao-whatsapp` como cobrança única | 2, 4, 5, 6 (preservado em todas) |
| 8 | preservar produtos antigos para histórico | 2 (nenhum DELETE, nenhum significado alterado) |
| — | guardrail de superfícies comerciais (§A6.2) | 4 |

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `supabase/migrations/20260803120200_097_billing_plan_ai_sale_guard.sql` | CHECK: plano que declara `ai` não pode ficar `active` | criar |
| `supabase/migrations/20260803120300_098_two_plan_commercial_catalog.sql` | seed dos dois + retirada dos antigos + validação pós-condição, uma transação | criar |
| `src/lib/billing-plan-display.ts` | vitrine respeita `active`; helpers puros dos campos contratuais | modificar |
| `src/lib/billing-plan-display.test.ts` | testes 9, 10 e 11 da spec no que toca à vitrine | modificar |
| `src/components/PricingTable.tsx` | comentário do filtro acompanha a regra nova | modificar |
| `src/lib/commercial-surface-guard.test.ts` | **guardrail §A6.2** — manifesto por caminho + varredura | criar |
| `supabase/functions/_shared/whatsapp-implementation-core.ts` | `summarizeMonthlyCosts` no modelo de dois planos | modificar |
| `src/lib/whatsapp-implementation-core.test.ts` | testes do núcleo acima | modificar |
| `supabase/functions/manage-whatsapp-implementations/index.ts` | projeta os planos novos; mensalidade legada vem da assinatura, não do catálogo | modificar |
| `src/types/billing.ts` | `BillingPlan` ganha as 3 colunas; `costs` ganha o preço do Plano Automação | modificar |
| `src/components/gestao/AutomacaoWhatsappCard.tsx` | remove `contratarInstancia`; bloco informativo do Plano Automação | modificar |
| `src/pages/platform/BillingPlans.tsx` | campos contratuais read-only + aviso de não-ativável | modificar |
| `docs/billing-asaas/PLANO-B-PENDENCIAS.md` | pendências, gates, CLAUDE.md a consolidar | criar |

---

## Task 1: Migration 097 — o NO-GO vira estrutura, não configuração

**Files:**
- Create: `supabase/migrations/20260803120200_097_billing_plan_ai_sale_guard.sql`

**Interfaces:**
- Produces: constraint `billing_plans_ai_plan_not_sellable_chk` — a Task 2 semeia `plano-automacao` sob ela, e a Task 7 explica o motivo do bloqueio ao admin.

> **Por que esta migration existe.** `active = false` no seed já faz `create-billing-checkout` recusar (`subscription.ts:50`, `"Plano inativo."`). Mas `active` é um **estado editável**: um clique em `/platform/planos` ligaria a venda de um produto sem proteção financeira. O CHECK torna o NO-GO estrutural — nenhum painel, nenhuma Edge Function e nenhum `UPDATE` manual conseguem ativar.

- [ ] **Step 1: Confirmar que a coluna da qual o CHECK depende existe no histórico**

Run: `grep -n "included_features" supabase/migrations/20260802180000_094_billing_plans_two_plan_model.sql`
Expected: a coluna é criada com `not null default '{}'`. O CHECK abaixo depende disso e `db push` aplica 094 antes de 097 (ordem lexical dos timestamps).

- [ ] **Step 2: Escrever a migration**

```sql
-- 097 — PLAN_AUTOMACAO_CHECKOUT = NO-GO, no nivel do banco.
--
-- O teto de R$ 100 por ciclo (Plano D) e parte do modelo economico do Plano
-- Automacao: sem ele NAO EXISTE pior caso de custo, e a margem de 43% da §13
-- da spec perde o piso. Enquanto o teto nao estiver provado contra banco real,
-- nenhum plano que declare franquia de IA pode ser vendido.
--
-- `active = false` no seed ja basta para o checkout recusar
-- (create-billing-checkout/subscription.ts:50 devolve "Plano inativo."), mas
-- `active` e um ESTADO EDITAVEL: um clique em /platform/planos ligaria a venda
-- de um produto sem protecao financeira, e o painel nao tem como saber que
-- aquele switch especifico custa dinheiro. Este CHECK e o que transforma a
-- decisao comercial em invariante: nenhum painel, nenhuma Edge Function e
-- nenhum UPDATE manual conseguem ativar.
--
-- DEPENDE de 094 (coluna included_features, not null default '{}').
--
-- ROLLBACK / ENTREGA DO PLANO D:
--   alter table billing_plans
--     drop constraint if exists billing_plans_ai_plan_not_sellable_chk;
-- Dropar este constraint e a ULTIMA acao do Plano D, depois de o teto estar
-- provado contra banco real — nunca antes, e nunca "so pra testar".

do $$
begin
  -- conrelid junto do conname: nome de constraint e unico por TABELA, nao por
  -- banco. Checar so o nome faria um homonimo em outra tabela pular a criacao.
  -- Mesmo cuidado da 094.
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_ai_plan_not_sellable_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_ai_plan_not_sellable_chk
      -- coalesce defensivo: a 094 declara NOT NULL, mas se a coluna algum dia
      -- virar nullable, `'ai' = any(null)` avalia UNKNOWN e o CHECK ACEITA
      -- UNKNOWN — o plano passaria. Mesma classe do array_position(...,null)
      -- da 094.
      check (not (active and 'ai' = any(coalesce(included_features, '{}'::text[]))));
  end if;
end $$;

comment on constraint billing_plans_ai_plan_not_sellable_chk on billing_plans is
  'PLAN_AUTOMACAO_CHECKOUT = NO-GO. Plano que declara franquia de IA em '
  'included_features nao pode ficar ativo enquanto o teto financeiro por ciclo '
  '(Plano D) nao existir e nao estiver provado contra banco real. Dropar este '
  'constraint e a ultima acao do Plano D.';
```

- [ ] **Step 3: Verificar por leitura (não há banco local)**

Confirmar, lendo o arquivo: guarda por `pg_constraint` **com `conrelid`**; nenhum `drop` de coluna; nenhum `update` em linha existente; nenhum segredo; nenhuma URL de projeto.

Run: `npm run test -- scripts/migration-static-guard.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260803120200_097_billing_plan_ai_sale_guard.sql
git commit -m "feat(dois-planos): plano com franquia de IA nao pode ser ativado ate o Plano D"
```

---

## Task 2: Migration 098 — troca atômica do catálogo

**Files:**
- Create: `supabase/migrations/20260803120300_098_two_plan_commercial_catalog.sql`

**Interfaces:**
- Consumes: colunas da 094, CHECK da 097.
- Produces: os slugs `plano-reservas` (ativo) e `plano-automacao` (inativo) — consumidos pelas Tasks 5, 6 e pelo guardrail da Task 4.

> **Por que INSERT e UPDATE moram na MESMA transação.** Invariante do §24: *"os novos planos não podem ser publicados enquanto qualquer superfície cliente-facing ainda oferecer contratação de `instancia-whatsapp` separadamente"* — o cliente veria dois modelos comerciais ao mesmo tempo, com preços que se contradizem. Semear numa migration e retirar noutra abre exatamente essa janela se a segunda falhar.

> **Histórico preservado (§A6.1).** Nenhum plano antigo é apagado, nenhum significado é alterado, nenhuma fatura ou assinatura é tocada. `active = false` retira da **vitrine**; a linha continua existindo e continua sendo o que sempre foi para quem a referencia.

- [ ] **Step 1: Confirmar o formato do seed anterior antes de escrever o novo**

Run: `grep -n "insert into billing_plans" -A 12 supabase/migrations/20260718120000_065_billing_plans_seed.sql | head -30`
Expected: colunas nomeadas explicitamente, `"interval"` sempre entre aspas (palavra reservada), `on conflict (slug) do nothing`. Seguir o mesmo formato.

- [ ] **Step 2: Escrever a migration**

```sql
-- 098 — Catalogo comercial de dois planos: seed dos novos e retirada dos
-- antigos da vitrine, no MESMO lote.
--
-- Invariante do §24 da spec: "os novos planos nao podem ser publicados enquanto
-- qualquer superficie cliente-facing ainda oferecer contratacao de
-- instancia-whatsapp separadamente" — o cliente veria dois modelos comerciais
-- ao mesmo tempo, com precos que se contradizem. Por isso INSERT e UPDATE
-- moram na MESMA transacao, e a validacao do PART 5 aborta se o resultado
-- deixar os dois modelos ativos.
--
-- HISTORICO PRESERVADO (§A6.1): nenhum plano antigo e apagado, nenhum
-- significado e alterado, nenhuma fatura/assinatura/implementacao e tocada.
-- `active = false` retira da VITRINE; a linha continua existindo e continua
-- significando exatamente o que significava. Uma fatura de 2026 que aponta
-- para instancia-whatsapp segue valendo.
--
-- DEPENDE de 094 (colunas contratuais) e 097 (CHECK de venda de plano com IA).
--
-- ROLLBACK (manual, sem migration reversa):
--   update billing_plans set active = true  where slug in ('sistema-reservas','instancia-whatsapp');
--   update billing_plans set active = false where slug = 'plano-reservas';
-- Os planos novos nunca sao apagados — faturas emitidas neles ficariam orfas.

begin;

-- =====================================================================
-- PART 1 — Plano 1: Reservas. R$ 449,90/mes. CONTRATAVEL.
-- =====================================================================
-- Substitui `sistema-reservas` NA VITRINE. O slug antigo permanece para
-- historico (§A6.1) e nao e migrado: nao existe assinatura paga hoje.
--
-- included_features = {system}: declaracao EXPLICITA. Pelo contrato do Plano A,
-- plano com array nao vazio NAO herda IA de system — e' por isso que o Plano 1
-- nega `ai` sem precisar de nenhuma regra extra.
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, active, recommended, sort_order, features,
  included_features, included_whatsapp_connections, whatsapp_component_cents
) values (
  'plano-reservas',
  'Plano Reservas',
  'Plataforma completa de reservas, fila de espera e gestão de mesas.',
  44990, 'month', 'SYSTEM_SUBSCRIPTION', 'asaas',
  'recurring', true, false, 10,
  -- `features` e COPY DE MARKETING e nao concede nada. A autorizacao esta em
  -- included_features, logo abaixo, e as duas nunca se confundem.
  '["Reservas online ilimitadas", "Fila de espera e passantes", "Painel operacional e relatórios", "Portal público com cardápio", "Suporte por e-mail"]'::jsonb,
  array['system']::text[], 0, null
) on conflict (slug) do nothing;

-- =====================================================================
-- PART 2 — Plano 2: Automacao. R$ 799,90/mes. NASCE INATIVO.
-- =====================================================================
-- PLAN_AUTOMACAO_CHECKOUT = NO-GO: preparado e visivel no painel admin, NAO
-- contratavel e NAO ativavel ate o Plano D provar o teto de R$ 100 contra banco
-- real. O CHECK da 097 (billing_plans_ai_plan_not_sellable_chk) garante que
-- `active = true` aqui e IMPOSSIVEL, nao apenas desaconselhado — este INSERT
-- falharia se tentasse.
--
-- whatsapp_component_cents = 35000: R$ 799,90 - R$ 449,90 = R$ 350,00, o preco
-- incremental contratual da capacidade de automacao (§12). NAO e receita pura da
-- instancia Z-API: a margem consolidada precisa descontar tambem o custo de IA.
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, active, recommended, sort_order, features,
  included_features, included_whatsapp_connections, whatsapp_component_cents
) values (
  'plano-automacao',
  'Plano Automação',
  'Tudo do Plano Reservas mais automação de WhatsApp com agente de IA, confirmações e lembretes.',
  79990, 'month', 'SYSTEM_SUBSCRIPTION', 'asaas',
  'recurring', false, false, 20,
  '["Tudo do Plano Reservas", "1 conexão de WhatsApp", "Agente de IA 24 horas", "Confirmações e lembretes automáticos", "Chat operacional de WhatsApp"]'::jsonb,
  array['system','whatsapp','ai']::text[], 1, 35000
) on conflict (slug) do nothing;

-- =====================================================================
-- PART 3 — Auto-correcao dos campos CONTRATUAIS
-- =====================================================================
-- `on conflict do nothing` acima deixaria valores divergentes de uma execucao
-- parcial anterior intactos — e estes campos decidem AUTORIZACAO e RECEITA, nao
-- aparencia. Forcar aqui e o que torna a migration re-executavel sem deixar o
-- catalogo mentindo sobre o que cada plano concede.
--
-- `is distinct from` mantem o UPDATE em no-op no caso normal (nao suja
-- updated_at a cada re-execucao) e trata NULL corretamente, o que `<>` nao faz.
--
-- `active` NAO entra em nenhum dos dois UPDATEs: quem decide publicacao e o
-- PART 4 (para os antigos) e o INSERT (para os novos). Reafirmar active aqui
-- sobrescreveria uma despublicacao deliberada feita no painel.
update billing_plans
   set amount_cents = 44990,
       category = 'SYSTEM_SUBSCRIPTION',
       included_features = array['system']::text[],
       included_whatsapp_connections = 0,
       whatsapp_component_cents = null,
       updated_at = now()
 where slug = 'plano-reservas'
   and (amount_cents is distinct from 44990
        or category is distinct from 'SYSTEM_SUBSCRIPTION'
        or included_features is distinct from array['system']::text[]
        or included_whatsapp_connections is distinct from 0
        or whatsapp_component_cents is distinct from null);

update billing_plans
   set amount_cents = 79990,
       category = 'SYSTEM_SUBSCRIPTION',
       included_features = array['system','whatsapp','ai']::text[],
       included_whatsapp_connections = 1,
       whatsapp_component_cents = 35000,
       updated_at = now()
 where slug = 'plano-automacao'
   and (amount_cents is distinct from 79990
        or category is distinct from 'SYSTEM_SUBSCRIPTION'
        or included_features is distinct from array['system','whatsapp','ai']::text[]
        or included_whatsapp_connections is distinct from 1
        or whatsapp_component_cents is distinct from 35000);

-- =====================================================================
-- PART 4 — Retirada dos produtos antigos DA VITRINE
-- =====================================================================
-- NAO e delecao. NAO altera significado. NAO toca assinatura, fatura nem
-- implementacao existente. So retira da oferta.
--
-- implementacao-whatsapp NAO entra: continua ATIVO como cobranca unica, e' o
-- produto canonico mantido pelo modelo novo (§A6.1).
-- trial-padrao NAO entra: continua ativo, aplicado automaticamente na criacao
-- da org.
update billing_plans
   set active = false,
       updated_at = now()
 where slug in ('sistema-reservas', 'instancia-whatsapp')
   and active = true;

-- Pacotes de IA por CATEGORIA, nao pelos cinco slugs: um `credito-ia-300`
-- criado no painel amanha seria retirado por esta mesma linha, enquanto uma
-- lista de slugs o deixaria ativo em silencio.
update billing_plans
   set active = false,
       updated_at = now()
 where category = 'AI_CREDIT_PACKAGE'
   and active = true;

-- =====================================================================
-- PART 5 — Validacao da pos-condicao (aborta a transacao inteira)
-- =====================================================================
-- Precedente: a 066 ja falha explicitamente quando o catalogo nao fica no
-- estado esperado. Aqui o motivo e mais forte: publicar os planos novos com um
-- produto antigo ainda ativo produz DOIS MODELOS COMERCIAIS SIMULTANEOS na
-- tela do cliente — exatamente o que o §24 proibe.
do $$
declare
  v_offenders text;
begin
  select string_agg(slug, ', ' order by slug)
    into v_offenders
    from billing_plans
   where active = true
     and slug <> 'plano-reservas'
     -- Categorias que competem com o modelo de dois planos. Nao inclui
     -- WHATSAPP_IMPLEMENTATION (cobranca unica mantida) nem TRIAL.
     and category in ('SYSTEM_SUBSCRIPTION', 'WHATSAPP_SUBSCRIPTION', 'AI_CREDIT_PACKAGE');

  if v_offenders is not null then
    raise exception
      'Catalogo comercial inconsistente: plano(s) ativo(s) fora do modelo de dois planos: %',
      v_offenders
      using hint =
        'Entre assinatura de sistema, instancia de WhatsApp e pacote de IA, so plano-reservas '
        'pode ficar ativo. Desative os listados (active = false) e reaplique. '
        'implementacao-whatsapp e trial-padrao continuam ativos de proposito.';
  end if;

  -- O erro OPOSTO, igualmente grave e muito mais silencioso: se plano-reservas
  -- nao ficou ativo, a vitrine de assinatura fica VAZIA e ninguem consegue
  -- contratar nada — sem nenhum erro aparecer.
  if not exists (
    select 1 from billing_plans where slug = 'plano-reservas' and active = true
  ) then
    raise exception
      'plano-reservas nao ficou ativo: a vitrine de assinatura ficaria vazia.'
      using hint = 'Verifique se o INSERT do PART 1 foi no-op por conflito com uma linha inativa.';
  end if;
end $$;

commit;

-- =====================================================================
-- Validacao pos-migration (rodar manualmente apos `supabase db push`)
-- =====================================================================
-- Esperado: plano-reservas ativo; plano-automacao inativo com componente 35000;
-- sistema-reservas, instancia-whatsapp e os credito-ia inativos;
-- implementacao-whatsapp e trial-padrao ativos.
--
--   select slug, amount_cents, category, active, included_features,
--          included_whatsapp_connections, whatsapp_component_cents
--     from billing_plans
--    order by active desc, sort_order;
--
-- E a prova de que o CHECK da 097 esta valendo (deve FALHAR com 23514):
--   update billing_plans set active = true where slug = 'plano-automacao';
```

- [ ] **Step 3: Verificar por leitura**

Confirmar: nenhum `delete`; nenhuma alteração em `billing_subscriptions`, `billing_invoices` ou `whatsapp_implementations`; `"interval"` entre aspas nos dois INSERTs; `on conflict (slug) do nothing` nos dois; nenhum segredo; nenhuma URL.

Run: `npm run test -- scripts/migration-static-guard.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260803120300_098_two_plan_commercial_catalog.sql
git commit -m "feat(dois-planos): catalogo de dois planos e retirada dos produtos antigos da vitrine"
```

---

## Task 3: A vitrine passa a respeitar `active`

**Files:**
- Modify: `src/types/billing.ts` (`BillingPlan` ganha as 3 colunas da 094)
- Modify: `src/lib/billing-plan-display.ts`
- Modify: `src/lib/billing-plan-display.test.ts`
- Modify: `src/components/PricingTable.tsx` (comentário)

**Interfaces:**
- Produces: `BillingPlan.included_features` / `.included_whatsapp_connections` / `.whatsapp_component_cents`; `isSelectableSystemPlan` com filtro de `active`; `planIncludedFeatures(plan): string[]`; `planBlockedFromSale(plan): boolean` — todos consumidos pela Task 7.

> **Por que isto não é redundante com o `active = false` da Task 2.** `manage-billing` action `list_plans` devolve `select("*")` **sem filtro de `active`** para `platform_admin` (`manage-billing/index.ts:300-302`); só o caller não-admin recebe `.eq("active", true)`. E `isSelectableSystemPlan` hoje filtra apenas `is_trial` e categoria. Consequência concreta: um platform_admin abrindo `/g/<slug>/cobranca` de um cliente veria `sistema-reservas`, `plano-automacao` e qualquer outro plano inativo ofertados como contratáveis na `PricingTable` — três produtos mortos com botão. Retirar da vitrine é isto, não só a coluna no banco.

- [ ] **Step 1: Tipar as colunas contratuais em `src/types/billing.ts`**

Os helpers desta task leem essas colunas, então o tipo vem antes deles. Dentro de `interface BillingPlan`, ao lado dos campos da migration 063:

```ts
  // Migration 094 (modelo comercial de dois planos) — CAMPOS CONTRATUAIS.
  // Opcionais porque `manage-billing` só os devolve para platform_admin:
  // `PLAN_PUBLIC_COLUMNS` (payload do lojista) não os inclui de propósito.
  /**
   * AUTORIZAÇÃO — as features que o plano concede (`system`|`whatsapp`|`ai`).
   *
   * **Não confundir com `features` acima**, que é copy de marketing renderizada
   * no `PricingCard` e editada como textarea. Um administrador escrevendo a
   * palavra "whatsapp" numa frase comercial não concede acesso a nada.
   *
   * Array vazio = plano legado, resolve por categoria.
   */
  included_features?: string[] | null;
  /** Conexões de WhatsApp incluídas. Plano 1 = 0, Plano 2 = 1. */
  included_whatsapp_connections?: number | null;
  /**
   * Parcela contratual da mensalidade atribuível ao pacote de automação
   * (WhatsApp + IA + operação). Congelada no ciclo na abertura
   * (`revenue_source = PLAN_COMPONENT`). Não é receita exclusiva da instância.
   */
  whatsapp_component_cents?: number | null;
```

- [ ] **Step 2: Escrever os testes que falham**

Em `src/lib/billing-plan-display.test.ts`, acrescentar:

```ts
describe("isSelectableSystemPlan — vitrine respeita active", () => {
  const sistema = (o: Partial<BillingPlan> = {}) =>
    ({ category: "SYSTEM_SUBSCRIPTION", is_trial: false, active: true, ...o }) as BillingPlan;

  it("plano de sistema ativo e ofertavel", () => {
    expect(isSelectableSystemPlan(sistema())).toBe(true);
  });

  it("teste 10 — plano de sistema INATIVO nao e ofertavel", () => {
    // O list_plans de platform_admin devolve select("*") SEM filtro de active:
    // sem esta regra, o admin na tela do cliente veria sistema-reservas e
    // plano-automacao com botao de contratar.
    expect(isSelectableSystemPlan(sistema({ active: false }))).toBe(false);
  });

  it("plano-automacao (inativo pelo NO-GO) nao aparece na vitrine", () => {
    expect(
      isSelectableSystemPlan(sistema({ slug: "plano-automacao", active: false })),
    ).toBe(false);
  });

  it("trial continua fora, ativo ou nao", () => {
    expect(isSelectableSystemPlan(sistema({ is_trial: true }))).toBe(false);
    expect(isSelectableSystemPlan(sistema({ is_trial: true, active: false }))).toBe(false);
  });

  it("categoria nao sistemica continua fora mesmo ativa", () => {
    for (const category of [
      "WHATSAPP_IMPLEMENTATION",
      "WHATSAPP_SUBSCRIPTION",
      "AI_CREDIT_PACKAGE",
      "CUSTOM",
    ] as const) {
      expect(isSelectableSystemPlan(sistema({ category }))).toBe(false);
    }
  });

  it("campo active ausente e tratado como NAO ofertavel (fail-closed)", () => {
    // Payload de EF antiga sem `active`. Esconder um plano que talvez esteja
    // ativo custa uma venda adiada; oferecer um plano que talvez esteja inativo
    // custa um checkout que responde 400 na cara do cliente.
    const semActive = { category: "SYSTEM_SUBSCRIPTION", is_trial: false } as unknown as BillingPlan;
    expect(isSelectableSystemPlan(semActive)).toBe(false);
  });
});

describe("campos contratuais — helpers puros", () => {
  it("planIncludedFeatures normaliza ausente, null e vazio para []", () => {
    expect(planIncludedFeatures({} as BillingPlan)).toEqual([]);
    expect(planIncludedFeatures({ included_features: null } as BillingPlan)).toEqual([]);
    expect(planIncludedFeatures({ included_features: [] } as BillingPlan)).toEqual([]);
  });

  it("planIncludedFeatures devolve a declaracao quando existe", () => {
    expect(
      planIncludedFeatures({ included_features: ["system", "whatsapp", "ai"] } as BillingPlan),
    ).toEqual(["system", "whatsapp", "ai"]);
  });

  it("planBlockedFromSale — declara ai => bloqueado ate o Plano D", () => {
    expect(
      planBlockedFromSale({ included_features: ["system", "whatsapp", "ai"] } as BillingPlan),
    ).toBe(true);
  });

  it("planBlockedFromSale — Plano 1 e planos legados NAO sao bloqueados", () => {
    expect(planBlockedFromSale({ included_features: ["system"] } as BillingPlan)).toBe(false);
    expect(planBlockedFromSale({ included_features: [] } as BillingPlan)).toBe(false);
    expect(planBlockedFromSale({} as BillingPlan)).toBe(false);
  });

  it("planBlockedFromSale espelha o CHECK da 097 — whatsapp sozinho NAO bloqueia", () => {
    // O CHECK do banco olha SO 'ai'. Divergir aqui faria a UI avisar sobre um
    // bloqueio que o banco nao aplica (ou o contrario, pior ainda).
    expect(
      planBlockedFromSale({ included_features: ["system", "whatsapp"] } as BillingPlan),
    ).toBe(false);
  });
});
```

O arquivo já importa de `@/lib/billing-plan-display`; acrescentar `planIncludedFeatures` e `planBlockedFromSale` ao import existente e `BillingPlan` ao import de tipos, se ainda não estiverem lá.

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npm run test -- src/lib/billing-plan-display.test.ts`
Expected: FAIL — `planIncludedFeatures` e `planBlockedFromSale` não existem, e os casos de `active` passam indevidamente hoje.

- [ ] **Step 4: Implementar em `src/lib/billing-plan-display.ts`**

Substituir `isSelectableSystemPlan` por:

```ts
/**
 * Planos ofertáveis na pricing table do cliente.
 *
 * Filtra TRÊS coisas:
 * - `active !== true` — plano despublicado. **Não é redundante com o filtro do
 *   servidor:** `manage-billing` action `list_plans` devolve `select("*")` SEM
 *   filtro de `active` para `platform_admin` (só o caller não-admin recebe
 *   `.eq("active", true)`). Sem esta linha, um admin abrindo `/g/<slug>/cobranca`
 *   de um cliente veria `sistema-reservas` e `plano-automacao` com botão de
 *   contratar — dois produtos que o checkout recusa com "Plano inativo.".
 *   Fail-CLOSED de propósito: campo ausente esconde o plano. Esconder um plano
 *   talvez ativo adia uma venda; oferecer um plano talvez inativo entrega um
 *   400 ao cliente depois do clique.
 * - `is_trial` — trial é aplicado automaticamente pelo `manage-organizations`,
 *   o cliente nunca escolhe.
 * - categoria ≠ SYSTEM_SUBSCRIPTION — implantação de WhatsApp, instância e
 *   pacote de IA não são assinatura do sistema. Cada um tem fluxo próprio;
 *   listá-los como "plano" daria um botão que nenhum checkout processa.
 */
export function isSelectableSystemPlan(
  plan: Pick<BillingPlan, "category" | "is_trial" | "active">,
): boolean {
  return plan.active === true && !plan.is_trial && planCategory(plan) === "SYSTEM_SUBSCRIPTION";
}

/**
 * `billing_plans.included_features` normalizado (migration 094).
 *
 * AUTORIZAÇÃO — o que o plano concede. **Nunca confundir com `plan.features`**,
 * que é copy de marketing renderizada no `PricingCard` e editada como textarea:
 * um administrador escrevendo a palavra "whatsapp" numa frase comercial não
 * pode conceder acesso a nada.
 *
 * Ausente ou `null` vira `[]` = plano legado, que resolve por categoria.
 */
export function planIncludedFeatures(
  plan: Pick<BillingPlan, "included_features">,
): string[] {
  const raw = plan.included_features;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Plano que declara franquia de IA não pode ser vendido nem ativado enquanto o
 * teto financeiro por ciclo (Plano D) não existir — `PLAN_AUTOMACAO_CHECKOUT =
 * NO-GO`.
 *
 * Espelha exatamente o CHECK `billing_plans_ai_plan_not_sellable_chk`
 * (migration 097), que olha **só** `'ai'`. Divergir daqui faria o painel avisar
 * sobre um bloqueio que o banco não aplica — ou, pior, deixar de avisar sobre
 * um que ele aplica, e o admin descobriria pelo 23514.
 */
export function planBlockedFromSale(
  plan: Pick<BillingPlan, "included_features">,
): boolean {
  return planIncludedFeatures(plan).includes("ai");
}
```

Acrescentar `"active"` e `"included_features"` ao `PlanLike`/imports conforme o typecheck exigir.

- [ ] **Step 5: Atualizar o comentário do `PricingTable`**

Em `src/components/PricingTable.tsx`, substituir o comentário do filtro por:

```tsx
  // Só assinatura do sistema ATIVA entra aqui. O `active` é load-bearing: o
  // `list_plans` de platform_admin devolve o catálogo inteiro, inclusive os
  // produtos retirados da vitrine (`sistema-reservas`) e o Plano Automação, que
  // nasce inativo pelo NO-GO comercial. Ver isSelectableSystemPlan.
  const visible = plans.filter(isSelectableSystemPlan);
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `npm run test -- src/lib/billing-plan-display.test.ts`
Expected: PASS, incluindo os testes que já existiam.

Run: `npm run typecheck`
Expected: zero erros.

- [ ] **Step 7: Commit**

```bash
git add src/types/billing.ts src/lib/billing-plan-display.ts \
        src/lib/billing-plan-display.test.ts src/components/PricingTable.tsx
git commit -m "feat(dois-planos): vitrine so oferta plano ativo e expoe campos contratuais"
```

---

## Task 4: Guardrail de superfícies comerciais (§A6.2)

**Files:**
- Create: `src/lib/commercial-surface-guard.test.ts`

**Interfaces:**
- Consumes: os arquivos das Tasks 3, 5, 6 e 7 (varredura por caminho).

> **O que este guardrail precisa fazer, e o que ele precisa NÃO fazer.** Verifica **apenas caminhos declarados** de contratação e apresentação comercial; detecta dependência dos slugs antigos **nas superfícies novas**; **permite referências históricas legítimas**; **exclui migrations, testes e comentários por construção**, não por exceção pontual; e **falha se uma superfície comercial nova for acrescentada ao escopo sem ser classificada**. O último item é o que impede o guardrail de apodrecer: sem ele, uma tela de contratação criada em 2027 simplesmente não seria varrida, e o teste continuaria verde afirmando algo que deixou de conferir.
>
> `asaas-core.test.ts:398` usa os slugs antigos como fixtures nomeados e `billing-amount.ts:5` os cita em comentário. **Os dois são legítimos e permanecem** — um `grep` global os transformaria em falso positivo.

- [ ] **Step 1: Escrever o guardrail**

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";

/**
 * GUARDRAIL DE SUPERFÍCIES COMERCIAIS — §A6.2 da spec de dois planos.
 *
 * Prova que as superfícies de CONTRATAÇÃO E APRESENTAÇÃO COMERCIAL não
 * dependem mais de `sistema-reservas`, `instancia-whatsapp` nem `credito-ia-*`.
 *
 * TRÊS EXCLUSÕES POR CONSTRUÇÃO, nunca por exceção pontual:
 *   1. migrations   — `supabase/migrations/` nunca entra em SCOPE;
 *   2. testes       — `walk()` pula `*.test.ts` e `*.test.tsx`;
 *   3. comentários  — `codeLines()` descarta linhas de comentário antes de
 *                     procurar slug.
 * É o que mantém `asaas-core.test.ts` (fixtures nomeados) e `billing-amount.ts`
 * (citação em comentário) legítimos e verdes, sem allowlist de arquivo.
 *
 * ANTI-APODRECIMENTO: todo arquivo encontrado dentro de SCOPE precisa estar
 * classificado em SURFACES. Uma tela de contratação nova em 2027 cai no escopo,
 * não é classificada, e o teste falha pedindo a classificação — em vez de
 * simplesmente não ser varrida.
 */

const ROOT = process.cwd();

/**
 * Onde vive apresentação e contratação comercial. Arquivo OU diretório.
 * Acrescentar um caminho aqui é acrescentar cobertura; remover é abrir buraco,
 * e o revisor precisa ver isso no diff.
 */
const SCOPE: readonly string[] = [
  "src/components/PricingCard.tsx",
  "src/components/PricingTable.tsx",
  "src/components/gestao",
  "src/components/billing",
  "src/pages/gestao/Cobranca.tsx",
  "src/pages/platform/BillingPlans.tsx",
  "supabase/functions/create-billing-checkout",
  "supabase/functions/manage-whatsapp-implementations",
  "supabase/functions/_shared/implementation-checkout.ts",
  "supabase/functions/_shared/checkout-sessions.ts",
];

type Classification =
  /** Oferta/apresentação comercial NOVA. Não pode citar slug retirado. */
  | "OFFER"
  /** Lê produto antigo para HISTÓRICO/compatibilidade. Pode citar. */
  | "HISTORICAL"
  /** Está no escopo por vizinhança, não participa de oferta. */
  | "NOT_COMMERCIAL";

interface SurfaceEntry {
  kind: Classification;
  /** Obrigatório: por que esta classificação, em uma frase. */
  reason: string;
}

const SURFACES: Record<string, SurfaceEntry> = {
  "src/components/PricingCard.tsx": {
    kind: "OFFER",
    reason: "Card de plano da vitrine do lojista — a oferta em si.",
  },
  "src/components/PricingTable.tsx": {
    kind: "OFFER",
    reason: "Grid da vitrine; decide o que é ofertável via isSelectableSystemPlan.",
  },
  "src/components/gestao/AutomacaoWhatsappCard.tsx": {
    kind: "OFFER",
    reason:
      "Card de automação do lojista: preços, implantação e o bloco informativo do Plano Automação.",
  },
  "src/components/billing/WhatsappServiceBanner.tsx": {
    kind: "NOT_COMMERCIAL",
    reason:
      "Banner de estado do serviço (suspensão/carência). Não apresenta produto nem preço.",
  },
  "src/pages/gestao/Cobranca.tsx": {
    kind: "OFFER",
    reason: "Tela de cobrança do lojista — hospeda a vitrine e o card de automação.",
  },
  "src/pages/platform/BillingPlans.tsx": {
    kind: "OFFER",
    reason:
      "Painel de catálogo do platform_admin; edita e exibe os planos ofertados.",
  },
  "supabase/functions/create-billing-checkout/index.ts": {
    kind: "OFFER",
    reason: "Porta de contratação: resolve purpose e plano.",
  },
  "supabase/functions/create-billing-checkout/context.ts": {
    kind: "OFFER",
    reason: "Carrega o plano do checkout a partir do id.",
  },
  "supabase/functions/create-billing-checkout/subscription.ts": {
    kind: "OFFER",
    reason: "Checkout de assinatura; recusa plano inativo.",
  },
  "supabase/functions/create-billing-checkout/implementation.ts": {
    kind: "OFFER",
    reason: "Checkout da cobrança única de implantação.",
  },
  "supabase/functions/manage-whatsapp-implementations/index.ts": {
    kind: "OFFER",
    reason:
      "Afirma preços ao lojista em get_service_status — os quatro call sites da §A6 saem daqui.",
  },
  "supabase/functions/_shared/implementation-checkout.ts": {
    kind: "OFFER",
    reason:
      "Resolve o produto de implantação. `implementacao-whatsapp` é permitido: é o produto canônico mantido.",
  },
  "supabase/functions/_shared/checkout-sessions.ts": {
    kind: "NOT_COMMERCIAL",
    reason:
      "Persistência de checkoutSession para correlação de webhook; não conhece produto.",
  },
};

/**
 * Slugs RETIRADOS da oferta (§A6.1). `implementacao-whatsapp` NÃO entra:
 * continua sendo o produto canônico da cobrança única e é citado de propósito
 * pelas superfícies de oferta.
 */
const RETIRED_SLUGS: readonly string[] = ["sistema-reservas", "instancia-whatsapp"];
const RETIRED_SLUG_PREFIXES: readonly string[] = ["credito-ia-"];

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", "__snapshots__"]);

const isTestFile = (name: string) => /\.test\.(ts|tsx)$/.test(name);
const isSourceFile = (name: string) => /\.(ts|tsx)$/.test(name);

function walk(absolute: string, out: string[]): void {
  const stat = statSync(absolute);
  if (stat.isFile()) {
    const name = absolute.split(sep).pop() ?? "";
    if (isSourceFile(name) && !isTestFile(name)) out.push(absolute);
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(join(absolute, entry.name), out);
    } else if (isSourceFile(entry.name) && !isTestFile(entry.name)) {
      out.push(join(absolute, entry.name));
    }
  }
}

function discover(): string[] {
  const found: string[] = [];
  for (const target of SCOPE) {
    const absolute = resolve(ROOT, target);
    if (!existsSync(absolute)) continue; // a asserção de manifesto podre cobre isto
    walk(absolute, found);
  }
  return [...new Set(found.map((p) => relative(ROOT, p).split(sep).join("/")))].sort();
}

/**
 * Linhas de CÓDIGO — comentários fora.
 *
 * Baseado em linha, de propósito: um parser de TS aqui seria mais frágil do que
 * o defeito que ele evitaria. LIMITE CONHECIDO: um slug num comentário no FIM
 * de uma linha de código (`const x = 1; // instancia-whatsapp`) não é
 * descartado — e é o comportamento seguro, porque a linha É código.
 */
function codeLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return !(
      t.startsWith("//") ||
      t.startsWith("*") ||
      t.startsWith("/*") ||
      t.startsWith("--")
    );
  });
}

/** Retorna as ocorrências de slug retirado em linhas de código. */
export function retiredSlugHits(source: string): string[] {
  const hits: string[] = [];
  for (const line of codeLines(source)) {
    for (const slug of RETIRED_SLUGS) {
      if (line.includes(slug)) hits.push(slug);
    }
    for (const prefix of RETIRED_SLUG_PREFIXES) {
      if (line.includes(prefix)) hits.push(`${prefix}*`);
    }
  }
  return [...new Set(hits)];
}

const read = (relativePath: string) => readFileSync(resolve(ROOT, relativePath), "utf8");

describe("§A6.2 — guardrail de superfícies comerciais", () => {
  const discovered = discover();

  it("descobriu superfícies (o escopo não pode estar vazio)", () => {
    expect(discovered.length).toBeGreaterThan(0);
  });

  it("toda superfície encontrada no escopo está CLASSIFICADA", () => {
    const unclassified = discovered.filter((p) => !SURFACES[p]);
    expect(
      unclassified,
      "Superfície comercial nova sem classificação. Acrescente cada caminho a " +
        "SURFACES em src/lib/commercial-surface-guard.test.ts com kind " +
        "(OFFER | HISTORICAL | NOT_COMMERCIAL) e reason. Não remova do SCOPE " +
        "para silenciar — é exatamente o buraco que este teste existe pra impedir.",
    ).toEqual([]);
  });

  it("nenhuma entrada do manifesto aponta para arquivo inexistente", () => {
    const stale = Object.keys(SURFACES).filter((p) => !existsSync(resolve(ROOT, p)));
    expect(stale, "Manifesto podre: caminho classificado que não existe mais.").toEqual([]);
  });

  it("toda entrada do manifesto traz um motivo", () => {
    const semMotivo = Object.entries(SURFACES)
      .filter(([, entry]) => !entry.reason.trim())
      .map(([path]) => path);
    expect(semMotivo).toEqual([]);
  });

  describe("superfícies OFFER não dependem de slug retirado", () => {
    const offers = Object.entries(SURFACES)
      .filter(([, entry]) => entry.kind === "OFFER")
      .map(([path]) => path)
      .filter((path) => existsSync(resolve(ROOT, path)));

    it("existe pelo menos uma superfície OFFER", () => {
      expect(offers.length).toBeGreaterThan(0);
    });

    for (const path of offers) {
      it(`${path} não cita sistema-reservas, instancia-whatsapp nem credito-ia-*`, () => {
        expect(retiredSlugHits(read(path))).toEqual([]);
      });
    }
  });

  it("os quatro call sites da §A6 estão cobertos como OFFER", () => {
    // Se um destes sair do manifesto, a §A6 deixou de ser verificada.
    for (const path of [
      "supabase/functions/manage-whatsapp-implementations/index.ts",
      "src/components/gestao/AutomacaoWhatsappCard.tsx",
      "src/components/PricingTable.tsx",
      "src/pages/platform/BillingPlans.tsx",
    ]) {
      expect(SURFACES[path]?.kind, path).toBe("OFFER");
    }
  });
});

describe("§A6.2 — controles do detector (o teste não pode ser vacuoso)", () => {
  it("CONTROLE NEGATIVO: slug retirado em linha de CÓDIGO é detectado", () => {
    expect(retiredSlugHits(`const p = plans.find(x => x.slug === "instancia-whatsapp");`))
      .toEqual(["instancia-whatsapp"]);
    expect(retiredSlugHits(`.in("slug", ["sistema-reservas"])`)).toEqual(["sistema-reservas"]);
    expect(retiredSlugHits(`if (slug.startsWith("credito-ia-")) return null;`))
      .toEqual(["credito-ia-*"]);
  });

  it("CONTROLE POSITIVO: comentário citando slug retirado é ignorado", () => {
    // billing-amount.ts:5 faz exatamente isto e é legítimo.
    expect(retiredSlugHits(`// preço do catálogo, inclusive instancia-whatsapp`)).toEqual([]);
    expect(retiredSlugHits(` * sistema-reservas nasce inativo no seed 065`)).toEqual([]);
    expect(retiredSlugHits(`-- update billing_plans ... 'instancia-whatsapp'`)).toEqual([]);
  });

  it("CONTROLE POSITIVO: implementacao-whatsapp é permitido em superfície OFFER", () => {
    // Produto canônico da cobrança única, mantido pelo modelo novo (§A6.1).
    expect(retiredSlugHits(`export const IMPLEMENTATION_PLAN_SLUG = "implementacao-whatsapp";`))
      .toEqual([]);
  });

  it("CONTROLE POSITIVO: os slugs novos são permitidos", () => {
    expect(retiredSlugHits(`.in("slug", ["plano-reservas", "plano-automacao"])`)).toEqual([]);
  });

  it("migrations e testes ficam fora por construção, não por exceção", () => {
    const scopeText = SCOPE.join("\n");
    expect(scopeText).not.toMatch(/supabase\/migrations/);
    // A varredura nunca coleta arquivo de teste.
    for (const path of discover()) {
      expect(path).not.toMatch(/\.test\.tsx?$/);
    }
  });
});
```

- [ ] **Step 2: Rodar e observar o estado ANTES das Tasks 5 e 6**

Run: `npm run test -- src/lib/commercial-surface-guard.test.ts`
Expected: **FAIL** em dois casos de OFFER — `manage-whatsapp-implementations/index.ts` (cita os três slugs nas linhas 626 e 738-740) e `AutomacaoWhatsappCard.tsx` (cita `instancia-whatsapp` na linha 89). É o guardrail funcionando: ele está reprovando exatamente a dívida que as Tasks 5 e 6 pagam.

Se algum arquivo aparecer como não classificado, **acrescentar ao `SURFACES` com motivo** — nunca removê-lo do `SCOPE`.

- [ ] **Step 3: Commit (com o guardrail vermelho, deliberadamente)**

O commit do guardrail vem antes da correção, para que o diff mostre o que ele pegou. As Tasks 5 e 6 o deixam verde.

```bash
git add src/lib/commercial-surface-guard.test.ts
git commit -m "test(dois-planos): guardrail por caminho das superficies comerciais (§A6.2)"
```

> **Nota para o executor:** este é o **único** commit deste plano que pode ficar com a suíte vermelha, e só porque o guardrail documenta a dívida que as duas tasks seguintes quitam. **Não seguir para a Task 7 com ele vermelho.**

---

## Task 5: `manage-whatsapp-implementations` projeta os planos novos

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-implementation-core.ts` (`MonthlyCostInput`, `MonthlyCostSummary`, `summarizeMonthlyCosts`)
- Modify: `supabase/functions/manage-whatsapp-implementations/index.ts` (bloco `get_service_status`, ~linhas 606-755)
- Modify: `src/types/billing.ts` (`WhatsappServiceStatus.costs`)
- Test: `src/lib/whatsapp-implementation-core.test.ts`

**Interfaces:**
- Consumes: os slugs `plano-reservas` e `plano-automacao` (Task 2).
- Produces: `costs.automationPlanMonthlyCents: number | null` no payload — consumido pela Task 6.

> **O que o runtime ainda afirma ao lojista hoje (§A6):** sistema por R$ 449; instância separada por R$ 149/mês. Isso contradiz o modelo de dois planos, e `active = false` **não** o corrige: a query da linha 626 omite o filtro de propósito, com o motivo escrito no próprio código.

> **A mensalidade legada não pode voltar a ser um lookup por slug.** Uma organização com `WHATSAPP_SUBSCRIPTION` viva ainda paga o valor dela, e esconder isso seria mentir sobre dinheiro. Mas o valor certo é o da **assinatura daquela organização**, não o do catálogo: o preço de catálogo pode ter mudado depois da contratação. Buscá-lo pelo join `billing_plans!inner(amount_cents)` que a query já faz é ao mesmo tempo **mais correto** e o que deixa esta EF sem nenhuma dependência dos slugs retirados.

- [ ] **Step 1: Escrever os testes que falham**

Em `src/lib/whatsapp-implementation-core.test.ts`, acrescentar:

```ts
describe("summarizeMonthlyCosts — modelo de dois planos", () => {
  const base = {
    systemMonthlyCents: 44990,        // plano-reservas
    automationMonthlyCents: 79990,    // plano-automacao (TOTAL, nao incremento)
    implementationOneTimeCents: 75000,
    legacyInstanceMonthlyCents: null,
    hasActiveInstanceSubscription: false,
    whatsappSponsored: false,
    implementationSettled: false,
    systemSponsored: false,
  };

  it("projetado com automacao e o PLANO INTEIRO, nao sistema + instancia", () => {
    // R$ 799,90 — nao R$ 449,90 + R$ 149,00. O Plano 2 SUBSTITUI o Plano 1.
    const s = summarizeMonthlyCosts(base);
    expect(s.currentMonthlyCents).toBe(44990);
    expect(s.projectedMonthlyCents).toBe(79990);
  });

  it("eco do preco do plano de automacao vem no resumo", () => {
    // A UI usa este campo pra decidir se renderiza o bloco informativo.
    expect(summarizeMonthlyCosts(base).automationPlanMonthlyCents).toBe(79990);
  });

  it("plano de automacao ausente do catalogo => null, nunca zero", () => {
    // Zero significaria "de graca". Ausente significa "nao sei" — e a UI nao
    // renderiza o bloco.
    const s = summarizeMonthlyCosts({ ...base, automationMonthlyCents: null });
    expect(s.automationPlanMonthlyCents).toBeNull();
    expect(s.projectedMonthlyCents).toBe(44990);
  });

  it("assinatura de instancia LEGADA usa o valor da PROPRIA assinatura", () => {
    // R$ 149 de um contrato antigo, vindo do join da assinatura — nunca de
    // lookup por slug no catalogo.
    const s = summarizeMonthlyCosts({
      ...base,
      hasActiveInstanceSubscription: true,
      legacyInstanceMonthlyCents: 14900,
    });
    expect(s.currentMonthlyCents).toBe(44990 + 14900);
  });

  it("assinatura legada sem valor conhecido nao inventa numero", () => {
    const s = summarizeMonthlyCosts({
      ...base,
      hasActiveInstanceSubscription: true,
      legacyInstanceMonthlyCents: null,
    });
    expect(s.currentMonthlyCents).toBe(44990);
  });

  it("Ren Sushi: cortesia de whatsapp zera a projecao de automacao", () => {
    const s = summarizeMonthlyCosts({
      ...base,
      whatsappSponsored: true,
      systemSponsored: true,
      hasActiveInstanceSubscription: true,
      legacyInstanceMonthlyCents: 14900,
    });
    expect(s.currentMonthlyCents).toBe(0);
    expect(s.projectedMonthlyCents).toBe(0);
  });

  it("cortesia de whatsapp sem cortesia de sistema: projetado e so o sistema", () => {
    const s = summarizeMonthlyCosts({ ...base, whatsappSponsored: true });
    expect(s.projectedMonthlyCents).toBe(44990);
  });

  it("implantacao liquidada zera a cobranca unica", () => {
    expect(summarizeMonthlyCosts({ ...base, implementationSettled: true }).oneTimeDueCents)
      .toBe(0);
  });

  it("catalogo indisponivel: todos os precos null nao viram cobranca fantasma", () => {
    const s = summarizeMonthlyCosts({
      ...base,
      systemMonthlyCents: null,
      automationMonthlyCents: null,
      implementationOneTimeCents: null,
    });
    expect(s.currentMonthlyCents).toBe(0);
    expect(s.projectedMonthlyCents).toBe(0);
    expect(s.oneTimeDueCents).toBe(0);
    // `prices_unavailable` no payload é quem faz a UI renderizar "—".
  });
});
```

Ajustar os testes **já existentes** de `summarizeMonthlyCosts` que passam `instanceMonthlyCents`: o campo passa a se chamar `legacyInstanceMonthlyCents` e ganha o par `automationMonthlyCents`. Renomear no teste, **sem** afrouxar nenhuma asserção.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run test -- src/lib/whatsapp-implementation-core.test.ts`
Expected: FAIL — `automationMonthlyCents` e `automationPlanMonthlyCents` não existem.

- [ ] **Step 3: Implementar o núcleo**

Em `supabase/functions/_shared/whatsapp-implementation-core.ts`, substituir o bloco de custos:

```ts
export interface MonthlyCostInput {
  /** Preço de vitrine do `plano-reservas` (assinatura do sistema). */
  systemMonthlyCents: number | null;
  /**
   * Preço de vitrine do `plano-automacao`, **total** (R$ 799,90) — não o
   * incremento de R$ 350,00. No modelo de dois planos o Plano 2 SUBSTITUI o
   * Plano 1; somar sistema + automação cobraria o sistema duas vezes.
   * `null` = plano ausente do catálogo ou leitura falhou.
   */
  automationMonthlyCents: number | null;
  implementationOneTimeCents: number | null;
  /**
   * Mensalidade da assinatura de WhatsApp LEGADA **desta organização**, vinda
   * do join da própria assinatura — nunca de lookup por slug no catálogo. O
   * contrato legado é dela, e o preço de catálogo pode ter mudado depois da
   * contratação. É também o que mantém esta EF sem dependência dos slugs
   * retirados (§A6.2).
   */
  legacyInstanceMonthlyCents: number | null;
  /** Existe assinatura legada de WhatsApp em status cobrável. */
  hasActiveInstanceSubscription: boolean;
  /** Override de whatsapp ativo — a plataforma banca o custo. */
  whatsappSponsored: boolean;
  /** payment_status ∈ SETTLED_PAYMENT_STATUSES. */
  implementationSettled: boolean;
  /** Override de system ativo (cortesia vitalícia). */
  systemSponsored: boolean;
}

export interface MonthlyCostSummary {
  currentMonthlyCents: number;
  /**
   * Total mensal SE a organização passar a ter automação. No modelo de dois
   * planos é o preço do Plano Automação inteiro, porque ele substitui o Plano
   * Reservas — não `sistema + instância`, que era a conta do modelo antigo.
   */
  projectedMonthlyCents: number;
  oneTimeDueCents: number;
  /** O custo de IA é consumo, não assinatura — a tela mostra "variável". */
  aiVariable: true;
  /**
   * Eco do preço do Plano Automação no catálogo. `null` = plano ausente ou
   * catálogo não carregou. A UI usa este campo para decidir se renderiza o
   * bloco informativo do Plano Automação — renderizar com "—" ofereceria um
   * produto sem preço.
   */
  automationPlanMonthlyCents: number | null;
}

/** Os quatro números do resumo consolidado da tela de cobrança. */
export function summarizeMonthlyCosts(i: MonthlyCostInput): MonthlyCostSummary {
  const systemPart = i.systemSponsored ? 0 : (i.systemMonthlyCents ?? 0);

  // Contrato legado: só entra quando existe assinatura cobrável E não há
  // cortesia. Valor desconhecido soma zero — não inventa número sobre dinheiro.
  const legacyInstanceNow =
    i.hasActiveInstanceSubscription && !i.whatsappSponsored
      ? (i.legacyInstanceMonthlyCents ?? 0)
      : 0;

  // Com cortesia de WhatsApp não há automação a cobrar: sobra o sistema.
  const projected = i.whatsappSponsored
    ? systemPart
    : (i.automationMonthlyCents ?? systemPart);

  return {
    currentMonthlyCents: systemPart + legacyInstanceNow,
    projectedMonthlyCents: projected,
    oneTimeDueCents: i.implementationSettled ? 0 : (i.implementationOneTimeCents ?? 0),
    aiVariable: true,
    automationPlanMonthlyCents: i.automationMonthlyCents,
  };
}
```

- [ ] **Step 4: Confirmar que nenhum outro consumidor do núcleo quebra**

Run: `grep -rn "summarizeMonthlyCosts\|MonthlyCostInput" src/ supabase/ --include=*.ts --include=*.tsx`
Expected: apenas `whatsapp-implementation-core.ts`, seu teste, `manage-whatsapp-implementations/index.ts` e `AutomacaoWhatsappCard.tsx` (via o tipo do payload). `src/pages/platform/WhatsappImplementations.tsx` importa o núcleo por **outras** funções — se aparecer aqui, tratar na mesma task; se não aparecer, seguir.

- [ ] **Step 5: Implementar o adapter**

Em `supabase/functions/manage-whatsapp-implementations/index.ts`, dentro de `get_service_status`:

**5a.** A query de assinaturas passa a trazer o valor do plano:

```ts
        supabase
          .from("billing_subscriptions")
          // `amount_cents` do plano da PRÓPRIA assinatura: é ele que diz quanto
          // esta organização paga hoje pela instância legada. Buscar esse valor
          // no catálogo por slug seria errado (o preço de tabela pode ter mudado
          // depois da contratação) e reintroduziria a dependência de
          // `instancia-whatsapp` que a §A6.2 proíbe nesta superfície.
          .select("status, current_period_end, billing_plans!inner(category, amount_cents)")
          .eq("organization_id", organizationId)
          .neq("status", "canceled")
          .order("created_at", { ascending: false }),
```

**5b.** A projeção do catálogo passa a ser a dos planos novos:

```ts
        supabase
          // Sem filtro de `active` DE PROPÓSITO: `plano-automacao` nasce inativo
          // pelo NO-GO comercial (PLAN_AUTOMACAO_CHECKOUT) e mesmo assim precisa
          // ser projetado — é o preço que o bloco informativo apresenta ao
          // lojista. Filtrar por `active` esconderia exatamente o plano que o
          // bloco existe para mostrar. Quem gateia a CONTRATAÇÃO é o CHECK da
          // migration 097 mais o `active` lido em create-billing-checkout, não
          // esta projeção.
          .from("billing_plans")
          .select("slug, amount_cents")
          .in("slug", ["plano-reservas", "plano-automacao", "implementacao-whatsapp"]),
```

**5c.** Extrair o valor da assinatura legada, ao lado do `categoryOf` existente:

```ts
      const planOf = (s: typeof subs[number]) =>
        Array.isArray(s.billing_plans) ? s.billing_plans[0] : s.billing_plans;
      const categoryOf = (s: typeof subs[number]) => planOf(s)?.category;
      // Mensalidade real do contrato legado desta organização (ver 5a).
      const legacyInstanceMonthlyCents = instanceSub ? (planOf(instanceSub)?.amount_cents ?? null) : null;
```

O tipo local de `subs` ganha `amount_cents`:

```ts
      const subs = (subsRes.data ?? []) as Array<{
        status: string;
        current_period_end: string | null;
        billing_plans:
          | { category: string; amount_cents: number | null }
          | { category: string; amount_cents: number | null }[];
      }>;
```

**5d.** A chamada do núcleo:

```ts
        costs: summarizeMonthlyCosts({
          systemMonthlyCents: priceOf("plano-reservas"),
          automationMonthlyCents: priceOf("plano-automacao"),
          implementationOneTimeCents: priceOf("implementacao-whatsapp"),
          legacyInstanceMonthlyCents,
          // `instanceSubBillable`, não `!!instanceSub` — ver M1 no bloco acima.
          hasActiveInstanceSubscription: instanceSubBillable,
          whatsappSponsored,
          implementationSettled: implRow
            ? SETTLED_PAYMENT_STATUSES.has(implRow.payment_status)
            : false,
          systemSponsored,
        }),
```

**5e.** O comentário de `prices_unavailable` cita "os 3 preços" — continua correto (são três slugs). Não mexer.

- [ ] **Step 6: Atualizar o tipo do payload**

Em `src/types/billing.ts`, dentro de `WhatsappServiceStatus`:

```ts
  costs: {
    currentMonthlyCents: number;
    projectedMonthlyCents: number;
    oneTimeDueCents: number;
    aiVariable: true;
    /**
     * Preço do Plano Automação no catálogo, em centavos. `null` = plano ausente
     * do catálogo; `undefined` = Edge Function anterior a este deploy (o
     * frontend sobe pela Vercel automaticamente e a EF é implantada à mão —
     * mesma convenção de `serviceState`). A UI trata os dois casos igual: **não
     * renderiza o bloco informativo do Plano Automação**, nunca renderiza "—"
     * no lugar de um preço de produto.
     */
    automationPlanMonthlyCents?: number | null;
  };
```

- [ ] **Step 7: Verificar**

Run: `npm run test -- src/lib/whatsapp-implementation-core.test.ts`
Expected: PASS.

Run: `npm run typecheck && npx eslint supabase/functions --max-warnings=0`
Expected: zero erros, zero warnings. É a única cobertura automatizada do `index.ts` — vitest não o alcança.

Run: `npm run test -- src/lib/commercial-surface-guard.test.ts`
Expected: `manage-whatsapp-implementations/index.ts` agora PASSA; `AutomacaoWhatsappCard.tsx` ainda FALHA (Task 6).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/_shared/whatsapp-implementation-core.ts \
        supabase/functions/manage-whatsapp-implementations/index.ts \
        src/lib/whatsapp-implementation-core.test.ts \
        src/types/billing.ts
git commit -m "feat(dois-planos): EF projeta os planos novos e le a mensalidade legada da assinatura"
```

---

## Task 6: O card do lojista perde a contratação de instância e ganha o bloco informativo

**Files:**
- Modify: `src/components/gestao/AutomacaoWhatsappCard.tsx`

**Interfaces:**
- Consumes: `costs.automationPlanMonthlyCents` (Task 5).

> **Decisão do usuário, literal.** Bloco **informativo**: nome do plano, preço de R$ 799,90/mês, funcionalidades incluídas e a informação de que a contratação é realizada pela plataforma. **Sem** checkout, **sem** botão "Contratar", **sem** botão morto, **sem** link que simule contratação, **sem** CTA de WhatsApp/e-mail que possa ser lido como fluxo oficial de aquisição já liberado.

- [ ] **Step 1: Remover a contratação de instância**

Apagar, nesta ordem:
1. o import `useCreateBillingCheckout` (manter `useBillingPlans`);
2. `const subCheckout = useCreateBillingCheckout();`
3. `const instancePlan = (plans ?? []).find((p) => p.slug === "instancia-whatsapp");`
4. a função `contratarInstancia()` inteira;
5. o bloco JSX do botão "Contratar instância" (as condições `data.implementation.state === "COMPLETED" && ... && data.flags.subscription_checkout`).

Confirmar que `useBillingPlans` continua sendo usado por `implPlan` (`implementacao-whatsapp` permanece o produto canônico da cobrança única).

- [ ] **Step 2: Trocar a grade de preços**

Substituir a grade de três tiles (Implantação / Instância / Créditos de IA) por:

```tsx
        {/* Preços SEMPRE visíveis, antes de qualquer clique — vitrine do
            catálogo, não necessariamente o que esta conta deve. A instância
            separada e os pacotes de crédito de IA saíram: no modelo de dois
            planos a automação e a IA vêm dentro do Plano Automação, e a
            implantação segue como cobrança única. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Implantação</p>
            <p className="font-semibold">
              {implPlan ? formatCentsBRL(implPlan.amount_cents) : "—"}{" "}
              <span className="font-normal text-muted-foreground">uma vez</span>
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Agente de IA</p>
            <p className="font-semibold">
              Incluso{" "}
              <span className="font-normal text-muted-foreground">no Plano Automação</span>
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          A implantação é uma cobrança única e <strong>não</strong> está inclusa na
          mensalidade do Plano Automação.
        </p>
```

- [ ] **Step 3: Acrescentar o bloco informativo do Plano Automação**

Antes do `<Separator />` que precede o `ResumoCustos`:

```tsx
        <PlanoAutomacaoInfo
          monthlyCents={data.costs.automationPlanMonthlyCents}
          /* Quem já tem a automação — por cortesia da plataforma ou por
             contrato legado de instância — não precisa de uma oferta de
             upgrade para o que já usa. */
          hide={data.override.active || data.subscription.has_instance}
        />
```

E o componente, ao lado de `ResumoCustos` no mesmo arquivo:

```tsx
/**
 * Apresentação do Plano Automação — **informativa, sem CTA de compra**.
 *
 * `PLAN_AUTOMACAO_CHECKOUT = NO-GO`: o Plano Automação fica visível, preparado,
 * **não contratável e não ativável** até o Plano D entregar e provar o teto de
 * R$ 100 por ciclo contra banco real. Sem o teto não existe pior caso de custo,
 * e a margem de 43% da §13 da spec perde o piso.
 *
 * Por isso este bloco **não tem** botão de contratar, botão desabilitado, link
 * de checkout nem CTA de WhatsApp/e-mail: qualquer um deles seria lido pelo
 * lojista como o fluxo oficial de aquisição já liberado — e ele não está.
 * Quando o Plano D destravar a venda, este bloco é substituído por uma oferta
 * de verdade; até lá, ele informa e só.
 *
 * `monthlyCents` ausente (`undefined`, EF anterior a este deploy) ou `null`
 * (plano fora do catálogo) esconde o bloco inteiro: apresentar um produto sem
 * preço é pior que não apresentá-lo.
 */
function PlanoAutomacaoInfo({
  monthlyCents,
  hide,
}: {
  monthlyCents: number | null | undefined;
  hide: boolean;
}) {
  if (hide || monthlyCents == null) return null;

  return (
    <div className="rounded-md border border-info/30 bg-info/5 p-4 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">Plano Automação</p>
        <p className="font-semibold">
          {formatCentsBRL(monthlyCents)}
          <span className="font-normal text-muted-foreground">/mês</span>
        </p>
      </div>
      <ul className="text-sm text-muted-foreground space-y-1">
        <li>Tudo do Plano Reservas</li>
        <li>1 conexão de WhatsApp</li>
        <li>Agente de IA 24 horas</li>
        <li>Confirmações e lembretes automáticos</li>
        <li>Chat operacional de WhatsApp</li>
      </ul>
      <p className="text-xs text-muted-foreground">
        A contratação do Plano Automação é feita pela plataforma.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Ajustar o rótulo do resumo de custos**

Em `ResumoCustos`, o rótulo "Total mensal com a automação" continua correto — mas o número agora é o Plano Automação inteiro, não `sistema + instância`. Trocar por:

```tsx
          <dt className="text-muted-foreground">Total mensal com o Plano Automação</dt>
```

E a linha "Créditos de IA / Variável" passa a:

```tsx
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Agente de IA</dt>
          <dd className="font-medium">Incluso no Plano Automação</dd>
        </div>
```

- [ ] **Step 5: Verificar**

Run: `npm run test -- src/lib/commercial-surface-guard.test.ts`
Expected: **PASS inteiro** — nenhuma superfície OFFER cita mais slug retirado.

Run: `npm run typecheck`
Expected: zero erros.

Run: `npx eslint src/components/gestao/AutomacaoWhatsappCard.tsx --max-warnings=0`
Expected: zero. Em particular, nenhum import órfão de `useCreateBillingCheckout`.

Run: `grep -n "instancePlan\|contratarInstancia\|subCheckout" src/components/gestao/AutomacaoWhatsappCard.tsx`
Expected: nenhuma ocorrência.

- [ ] **Step 6: Commit**

```bash
git add src/components/gestao/AutomacaoWhatsappCard.tsx
git commit -m "feat(dois-planos): card do lojista troca contratacao de instancia por Plano Automacao informativo"
```

---

## Task 7: Campos contratuais read-only no painel de planos

**Files:**
- Modify: `src/pages/platform/BillingPlans.tsx`

**Interfaces:**
- Consumes: `BillingPlan.included_features` / `.included_whatsapp_connections` / `.whatsapp_component_cents`, `planIncludedFeatures`, `planBlockedFromSale` — todos da Task 3.

> **Decisão do usuário, literal.** Os três campos ficam **somente leitura**; os valores são definidos pelas migrations/seeds aprovados; a tela mostra aviso claro de que são campos contratuais e não podem ser alterados por este painel; `billing_plans.features` (copy de marketing) **não** altera entitlement; e a validação de apresentação **não finge** substituir o CHECK de banco. Não ampliar o escopo para `manage-billing` — a pendência formal `ADMIN_PLAN_CONTRACT_FIELDS_AUDITED_WRITE` é registrada na Task 8.

- [ ] **Step 1: Confirmar que as colunas já estão tipadas**

Run: `grep -n "included_features\|whatsapp_component_cents\|included_whatsapp_connections" src/types/billing.ts`
Expected: os três campos presentes em `interface BillingPlan` (acrescentados na Task 3). Se faltarem, a Task 3 ficou incompleta — voltar e completá-la, não duplicar a declaração aqui.

- [ ] **Step 2: Marcar na tabela o plano que não pode ser vendido**

Em `src/pages/platform/BillingPlans.tsx`, na célula de nome (onde já vive o badge de `plan.recommended`), acrescentar:

```tsx
                      {planBlockedFromSale(plan) && (
                        <Badge variant="outline" className="border-warning/40 text-warning">
                          Não ativável
                        </Badge>
                      )}
```

Acrescentar `planBlockedFromSale` e `planIncludedFeatures` ao import de `@/lib/billing-plan-display` já existente.

- [ ] **Step 3: Bloco read-only no diálogo de edição**

Dentro do diálogo, depois do campo de categoria e **fora** do bloco do textarea de `features`:

```tsx
            {/* Campos CONTRATUAIS (migration 094) — somente leitura.
                São eles que decidem AUTORIZAÇÃO e RECEITA, não a copy de
                marketing logo abaixo. A escrita auditada é a pendência
                ADMIN_PLAN_CONTRACT_FIELDS_AUDITED_WRITE: enquanto ela não for
                entregue, o valor certo vem de migration controlada e este
                painel não tem como alterá-lo — `manage-billing` nem aceita
                essas colunas em PLAN_WRITABLE_COLUMNS. */}
            {editingPlan && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <p className="text-sm font-medium">Contrato do plano (somente leitura)</p>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Features concedidas</dt>
                    <dd className="font-medium">
                      {planIncludedFeatures(editingPlan).join(", ") || "— (plano legado)"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Conexões de WhatsApp</dt>
                    <dd className="font-medium">
                      {editingPlan.included_whatsapp_connections ?? 0}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Componente de automação</dt>
                    <dd className="font-medium">
                      {editingPlan.whatsapp_component_cents == null
                        ? "—"
                        : formatCentsBRL(editingPlan.whatsapp_component_cents)}
                    </dd>
                  </div>
                </dl>
                <p className="text-xs text-muted-foreground">
                  Campos contratuais: decidem o que o plano concede e quanta receita
                  é atribuída à automação. Não podem ser alterados por este painel —
                  a mudança é feita por migration controlada.
                </p>
                {planBlockedFromSale(editingPlan) && (
                  <p className="text-xs text-warning">
                    Este plano inclui franquia de IA e <strong>não pode ser ativado</strong>{" "}
                    enquanto o teto de custo por ciclo não estiver em produção. O banco
                    recusa a ativação; marcar "Ativo" aqui devolve erro.
                  </p>
                )}
              </div>
            )}
```

O nome exato da variável que guarda o plano em edição pode diferir (`editingPlan`, `selectedPlan`, ou o `form` mais o id). **Ler o componente antes** e usar a variável real que tem o `BillingPlan` completo; se o estado guardar só o formulário, usar `plans.find(p => p.id === editingPlanId)`. Não introduzir estado novo para isso.

- [ ] **Step 4: Verificar**

Run: `npm run typecheck`
Expected: zero erros.

Run: `npx eslint src/pages/platform/BillingPlans.tsx --max-warnings=0`
Expected: zero.

Run: `npm run test -- src/lib/commercial-surface-guard.test.ts`
Expected: PASS — `BillingPlans.tsx` é superfície `OFFER` e não pode citar slug retirado.

Run: `grep -n "included_features\|whatsapp_component_cents\|included_whatsapp_connections" src/pages/platform/BillingPlans.tsx`
Expected: só leituras. **Nenhuma** dessas chaves pode aparecer no payload de `create_plan`/`update_plan` — confirmar lendo `handleSubmit`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/platform/BillingPlans.tsx
git commit -m "feat(dois-planos): painel exibe campos contratuais do plano como leitura"
```

---

## Task 8: Suíte completa, pendências e gates

**Files:**
- Create: `docs/billing-asaas/PLANO-B-PENDENCIAS.md`

- [ ] **Step 1: Rodar tudo**

Run: `npm run test`
Expected: PASS, sem quebrar nenhuma suíte anterior. Baseline do Plano A: 767 testes, 32 arquivos — este plano acrescenta arquivos e testes, nunca reduz.

Run: `npm run typecheck`
Expected: zero erros.

Run: `npm run lint`
Expected: sem regressão sobre o baseline (0 erros, 22 warnings pré-existentes).

Run: `npx eslint supabase/functions --max-warnings=0`
Expected: zero.

- [ ] **Step 2: Escrever o registro de pendências**

```markdown
# Pendências do Plano B — catálogo comercial de dois planos

Modelo comercial de dois planos, Plano B (catálogo, vitrine e superfícies
cliente-facing). Ambiente sem Docker. **Nenhuma migration aplicada, nenhuma
Edge Function deployada, nenhuma flag alterada, nenhum merge.** Tudo abaixo é o
que a suíte verde NÃO prova.

Predecessor: [FASE-DOIS-PLANOS-PENDENCIAS.md](FASE-DOIS-PLANOS-PENDENCIAS.md)
(Plano A) — as pendências de lá continuam abertas, em especial a concorrência
do limite de conexões.

---

## 1. Gate comercial — inalterado

**`PLAN_AUTOMACAO_CHECKOUT = NO-GO`.** O Plano B libera a venda do **Plano 1
apenas**. O Plano Automação fica visível, preparado, **não contratável e não
ativável** até o Plano D entregar e provar o teto de R$ 100 por ciclo contra
banco real.

O Plano B **endureceu** esse gate em vez de só respeitá-lo: a migration 097 cria
o CHECK `billing_plans_ai_plan_not_sellable_chk`, que impede
`active = true` em qualquer plano que declare `ai` em `included_features` —
painel, Edge Function e `UPDATE` manual, todos recusados pelo banco.

**Dropar esse constraint é a última ação do Plano D**, depois do teto provado.

## 2. ADMIN_PLAN_CONTRACT_FIELDS_AUDITED_WRITE

Escrita administrativa auditada de `included_features`,
`included_whatsapp_connections` e `whatsapp_component_cents`. **Não entregue no
Plano B por decisão explícita** — exigiria `manage-billing`, que é de outra
frente.

**Estado atual:** `BillingPlans.tsx` exibe os três campos como **somente
leitura**, com aviso de que são contratuais; a alteração é feita por migration
controlada; `manage-billing` não aceita essas colunas em
`PLAN_WRITABLE_COLUMNS`, então o painel não tem como gravá-las nem por engano.

**Antes de liberar edição, TODOS os itens abaixo:**

- inclusão explícita dos campos em `PLAN_WRITABLE_COLUMNS`;
- validação server-side;
- vocabulário fechado de `included_features`;
- `whatsapp_component_cents` entre zero e `amount_cents`;
- `included_whatsapp_connections` não negativo;
- autorização exclusiva de `platform_admin`;
- trilha de auditoria com before/after;
- identificação do administrador;
- timestamp;
- rejeição de alterações silenciosas;
- testes;
- revisão de segurança.

**Até essa entrega:** edição somente por migration controlada; interface
read-only; nenhuma alteração contratual pelo textarea de marketing; nenhuma
edição direta não auditada.

Isso **não** bloqueia a preparação do catálogo. Continua bloqueando: edição
administrativa desses campos, contratação do Plano 2 e ativação do Plano 2.

## 3. Depende de banco real

- **Migrations 097 e 098 nunca aplicadas.** Idempotência, o `do $$` de
  `pg_constraint`, o `on conflict (slug) do nothing`, os `is distinct from` da
  auto-correção e as duas `raise exception` da pós-condição foram verificados
  **só por leitura**.
- **O CHECK da 097 nunca foi exercitado contra um `UPDATE` real.** Que
  `update billing_plans set active = true where slug = 'plano-automacao'` falhe
  com 23514 é a afirmação central do gate comercial e **não está provada**. É o
  primeiro comando a rodar depois do `db push` (está no rodapé da 098).
- **A pós-condição do PART 5 da 098 nunca abortou nem passou de verdade.** Se
  algum plano estiver ativo em produção fora do previsto, o `db push` **falha** —
  por desenho, mas é uma falha que só aparece na aplicação.
- **O CHECK `included_features` da 094 (teste 2 da spec) continua não provado** —
  herdado do Plano A.

## 4. Depende de deploy

Ordem obrigatória quando autorizado (fora deste plano):

1. `supabase db push` — **094, 095 (Plano A), 097, 098**, nesta ordem. A 097
   depende da coluna da 094; a 098 depende das duas.
2. Deploy de `manage-whatsapp-implementations` — lê os slugs novos.
3. Frontend (Vercel, automático no merge).
4. Conferir `acl-estatico` na aba Checks.

**A janela entre 2 e 3 é assimétrica de propósito.** Frontend novo com EF antiga:
`costs.automationPlanMonthlyCents` chega `undefined` e o bloco informativo
simplesmente não renderiza — degradação silenciosa e segura, mesma convenção de
`serviceState`. Frontend antigo com EF nova: o card antigo procura
`instancia-whatsapp` em `useBillingPlans()`, não acha (inativo pela 098), e cai
no `"—"` e no botão desabilitado que ele já tratava. **Nenhuma das duas ordens
afirma preço errado** — mas a ordem acima é a que evita o card antigo.

**Aplicar a 098 sem deployar `manage-whatsapp-implementations` deixa a EF
projetando três slugs que acabaram de sair da vitrine**: `priceOf` devolve
`null` nos três, `summarizeMonthlyCosts` colapsa em zero e o lojista lê
"R$ 0,00" onde deveria ler R$ 449,90. `prices_unavailable` **não** cobre esse
caso (a leitura não falhou; ela devolveu linhas inativas). Deployar junto.

## 5. CLAUDE.md a consolidar

*(Consolidação é commit único no fim, fora deste chat — as três frentes editam o
mesmo arquivo.)*

**Checklist de redeploy — linha existente que muda de razão:**

- `whatsapp-implementation-core.ts` → `create-billing-checkout`,
  `manage-whatsapp-implementations`. A linha já existe. O que mudou: o contrato
  de `MonthlyCostInput`/`MonthlyCostSummary` foi **alterado de forma
  incompatível** (`instanceMonthlyCents` virou `legacyInstanceMonthlyCents`,
  entrou `automationMonthlyCents`, saiu do resumo o eco antigo). Redeploy
  parcial não quebra em runtime (cada EF carrega o `_shared/` do próprio
  bundle), mas o payload divergente é o que a seção 4 acima descreve.

**Invariantes novos, propostos para o corpo do CLAUDE.md:**

- **Plano que declara `ai` em `included_features` não pode ficar `active`** —
  CHECK `billing_plans_ai_plan_not_sellable_chk`. `PLAN_AUTOMACAO_CHECKOUT =
  NO-GO` é estrutural, não configuração; dropar o constraint é a última ação do
  Plano D. [migration 097](../../supabase/migrations/20260803120200_097_billing_plan_ai_sale_guard.sql).
- **`isSelectableSystemPlan` filtra `active` — e isso não é redundante com o
  servidor.** `manage-billing` action `list_plans` devolve `select("*")` sem
  filtro de `active` para `platform_admin`; sem o filtro no cliente, o admin vê
  produtos retirados da vitrine com botão de contratar na tela do lojista.
  [billing-plan-display.ts](../../src/lib/billing-plan-display.ts).
- **A mensalidade de contrato legado de WhatsApp vem do join da própria
  assinatura, nunca de lookup por slug no catálogo.** O preço de tabela pode ter
  mudado depois da contratação, e o lookup reintroduziria a dependência de
  `instancia-whatsapp` numa superfície de oferta (§A6.2).
  [manage-whatsapp-implementations](../../supabase/functions/manage-whatsapp-implementations/index.ts).
- **Superfície comercial nova entra no `SCOPE` do guardrail e é classificada.**
  `src/lib/commercial-surface-guard.test.ts` reprova arquivo não classificado
  dentro do escopo — é o que impede o guardrail de apodrecer. Migrations,
  testes e comentários ficam fora **por construção**.

## 6. Limites conhecidos do guardrail (§A6.2)

- **É textual e baseado em linha.** Um slug retirado num comentário no fim de
  uma linha de código (`const x = 1; // instancia-whatsapp`) não é descartado —
  comportamento deliberado, porque a linha é código.
- **Não segue indireção.** Um slug montado por concatenação
  (`"instancia-" + "whatsapp"`) passa. Análise estática de texto é o que resta:
  os `index.ts` das EFs importam `deno.land`/`esm.sh` e chamam `serve()` no
  carregamento, então vitest não consegue importá-los.
- **Cobre os caminhos declarados no `SCOPE`, não o repositório.** Uma superfície
  comercial criada fora dele não é varrida — por isso acrescentar caminho ao
  `SCOPE` faz parte de criar superfície nova, e a asserção de "manifesto podre"
  obriga o `SCOPE` a acompanhar remoções.

## 7. Residuais de produto, não de código

- **Assinatura viva num plano que saiu da vitrine perde o card "Plano atual".**
  `PricingTable` só renderiza planos ofertáveis; uma org assinante de
  `sistema-reservas` não veria o próprio plano na grade. **Inócuo hoje** — não
  existe cliente pagante; Ren Sushi é vitalício sem assinatura. Vira problema
  real no dia da primeira venda seguida de troca de catálogo, e é trabalho do
  **Plano C** (upgrade/downgrade), que já vai mexer nessa tela.
- **Nenhuma assinatura foi migrada de `sistema-reservas` para `plano-reservas`.**
  Deliberado: não há o que migrar, e migrar assinatura é fluxo do Plano C.
- **`flags.subscription_checkout` continua no payload da EF sem consumidor no
  frontend** depois da Task 6. Mantida no contrato de propósito — removê-la é
  mudança de payload que o Plano C/D deve decidir junto com o resto do fluxo.

## 8. Fora do escopo deste plano

Entitlement e resolvedor (**Plano A**, concluído). Upgrade, downgrade e
cancelamento (**Plano C**, depende da Fase 6c). Preços versionados, ledger,
reserva, `beforeCall` e hard stop de IA (**Plano D** — é ele que destrava o
Plano 2).
```

- [ ] **Step 3: Verificação final do lote**

Run: `git log --oneline billing-asaas/fase-6b..HEAD`
Expected: 8 commits, todos em `dois-planos/plano-b`. Nenhum em `billing-asaas/fase-6b`.

Run: `git diff --stat billing-asaas/fase-6b..HEAD -- CLAUDE.md`
Expected: **vazio**. `CLAUDE.md` não é editado por esta frente.

Run: `ls supabase/migrations | grep -E "_09[6-9]_"`
Expected: apenas `097` e `098` desta frente (096 é da frente 6c e pode ou não existir na branch).

- [ ] **Step 4: Commit**

```bash
git add docs/billing-asaas/PLANO-B-PENDENCIAS.md
git commit -m "docs(dois-planos): pendencias, gates e limites do Plano B"
```

---

## Ordem de aplicação (quando autorizada — fora deste plano)

1. `supabase db push` — **094, 095, 097, 098** nesta ordem, antes de qualquer deploy.
2. `supabase functions deploy manage-whatsapp-implementations`.
3. Merge para `main` → Vercel publica o frontend.
4. Rodar a validação pós-migration do rodapé da 098, **incluindo** a prova de que o CHECK da 097 recusa a ativação do Plano Automação.
5. Conferir `acl-estatico` na aba Checks.

Flags permanecem OFF. `PLAN_AUTOMACAO_CHECKOUT` permanece **NO-GO**.

---

## Auto-revisão

**Cobertura do lote comercial do §24:** os oito itens estão mapeados na tabela do topo, cada um com a task que o entrega. Os itens 1–3 e 8 na Task 2; o 3 também na Task 3 (a parte de frontend, que a coluna `active` sozinha não resolve); o 4 na Task 5; o 5 e o 6 na Task 6; o 7 preservado explicitamente em 2, 4, 5 e 6.

**Testes nomeados da spec cobertos:** **9** (slugs novos não colidem — o `on conflict (slug) do nothing` da 098 e a asserção de pós-condição), **10** (superfícies de contratação nova não ofertam `instancia-whatsapp` — Task 4, com controles positivo e negativo), **11** (produto legado continua consultável para histórico — o guardrail permite `HISTORICAL` e não toca em migration, teste ou comentário; a 098 não apaga nada).

**Testes que este plano NÃO pode declarar provados:** o **teste 2** (CHECK de `included_features`) e a prova de que o CHECK da 097 recusa a ativação dependem de banco real — registrados na seção 3 das pendências, não silenciosamente ausentes.

**Consistência de tipos:** as três colunas contratuais são tipadas na **Task 3, Step 1** — antes dos helpers que as leem (`planIncludedFeatures`/`planBlockedFromSale`, via `Pick<BillingPlan, "included_features">`) e antes da Task 7, que só as consome e confirma por `grep`. `automationMonthlyCents` (entrada do núcleo, Task 5) → `automationPlanMonthlyCents` (saída do núcleo e do payload, Task 5) → prop `monthlyCents` de `PlanoAutomacaoInfo` (Task 6). `legacyInstanceMonthlyCents` (Task 5) é preenchido pelo `planOf(instanceSub)?.amount_cents` do mesmo passo.

**Nomes distintos de propósito:** `automationMonthlyCents` (input, "preço do catálogo") e `automationPlanMonthlyCents` (output, "eco para a UI decidir se renderiza") — se um dia colapsarem num nome só, o eco vira campo mudo e a UI perde o sinal de ausência.

**Sem placeholders:** todo passo de código traz o código; todo passo de execução traz comando e resultado esperado. As duas exceções conscientes são a variável do plano em edição na Task 7 Step 3 (nome real a confirmar por leitura, com a instrução do que fazer nos dois casos possíveis) e o ajuste dos testes pré-existentes na Task 5 Step 1 (renomeação mecânica de campo, sem afrouxar asserção).
