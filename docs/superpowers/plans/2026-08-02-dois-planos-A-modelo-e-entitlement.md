# Plano A — Modelo aditivo, entitlement e gate de dois planos

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Versão:** 2 — revisada após reprovação da versão 1 (11 pontos obrigatórios).

**Goal:** Fazer o resolvedor de entitlements e o gate de WhatsApp entenderem um plano de sistema que inclui automação, sem migrar nenhuma assinatura existente, sem bloquear nenhum contrato legado e sem publicar nada ao cliente.

**Architecture:** Três colunas aditivas em `billing_plans` e um valor novo num CHECK. Toda decisão nova vive em núcleo puro (zero I/O, testado por vitest); as Edge Functions são adapters. O gate de WhatsApp e o worker de enforcement passam a chamar **o mesmo** núcleo de resolução de assinaturas, e um guardrail estático prova que continuam chamando.

**Tech Stack:** Postgres/Supabase (migrations idempotentes), Deno (Edge Functions), TypeScript, vitest.

**Spec:** [2026-08-02-modelo-comercial-dois-planos-design.md](../specs/2026-08-02-modelo-comercial-dois-planos-design.md) v1.0 congelada.

---

## Decomposição — plano 1 de 4

| Plano | Escopo | Depende de | O que fica liberado ao fim |
|---|---|---|---|
| **A (este)** | colunas aditivas, entitlement, resolvedor financeiro, gate+enforcement, `PLAN_COMPONENT`, limite de conexões | — | **nada comercialmente**; capacidade de resolver os dois modelos |
| **B** | guardrails, seeds, remoção da contratação separada de instância, catálogo/UI | A | **Plano 1 publicável**; Plano 2 **preparado, não vendável** |
| **C** | upgrade, downgrade, cancelamento total | A, B, **Fase 6c** | fluxos comerciais |
| **D** | Fase 7: preços versionados, ledger, reserva, `beforeCall`, hard stop | A | **destrava o Plano 2** |

### Gate comercial — `PLAN_AUTOMACAO_CHECKOUT = NO-GO`

**O Plano Automação não pode aceitar contratação nem ser ativado até o Plano D estar entregue e provado contra banco real.** O teto de R$ 100 é parte do modelo econômico de R$ 799,90: sem ele **não existe pior caso de custo**, e a margem de 43% da §13 da spec deixa de ter piso.

O Plano B é "publicável" **apenas no sentido de catálogo e UI preparados** — não no sentido de permitir venda do Plano 2 sem proteção financeira.

Condições para levantar o NO-GO (todas, não algumas):

| # | Condição | Onde |
|---|---|---|
| 1 | preço versionado por modelo e vigência | Plano D |
| 2 | ledger de uso persistido | Plano D |
| 3 | reserva atômica por turno | Plano D |
| 4 | `beforeCall` discriminado, nos cinco provedores | Plano D |
| 5 | hard stop de R$ 100 aplicado antes do consumo | Plano D |
| 6 | fail-closed para modelo sem preço | Plano D |
| 7 | tratamento de usage desconhecido | Plano D |
| 8 | **concorrência de orçamento provada contra banco real** | Plano D + banco |
| 9 | **concorrência do limite de conexões provada contra banco real** | este plano, Task 13 |

---

## Global Constraints

**Segurança e produção**
- Repositório vinculado à produção. **Nenhum comando Supabase remoto**: `db push`, `functions deploy`, `secrets set` estão fora deste plano.
- Sem Docker. Nada que exija banco local pode ser declarado verde.
- **Ren Sushi é vitalício, grátis, e não pode quebrar.** Override LIFETIME em `system`, `whatsapp`, `ai`.
- Migration não embute segredo nem a URL do projeto Supabase.
- Migrations idempotentes por design.

**Convenções**
- Migration: `YYYYMMDDHHMMSS_NNN_nome.sql`. Números livres: **094**, **095**.
- `npm run typecheck` é **`tsc -b --noEmit`** — nunca sem `-b`. Baseline: zero erros.
- Núcleo puro em `supabase/functions/_shared/`, teste em `src/lib/*.test.ts` (cross-boundary, padrão estabelecido).
- **`strict: false`**: estreitar união discriminada exige `x.kind === "..."` ou early-return.
- Edge Function não devolve `error.message` cru.

**Invariantes que este plano não pode violar**
- `included_features` é **autorização**; `billing_plans.features` é **copy**. Jamais confundidas.
- **Plano legado** (`included_features` vazio) mantém o comportamento histórico.
- **Plano novo** (`included_features` não vazio) usa a **declaração explícita** — sem herança implícita.
- Os dois planos novos são `SYSTEM_SUBSCRIPTION`.
- **Gate e enforcement mudam no mesmo commit.**
- Concorrência, constraints, locks e grants **não são declaráveis por teste unitário**.

---

## Matriz de entitlement — contrato deste plano

| | system | whatsapp | ai |
|---|---|---|---|
| **Plano 1** (`{system}`) | ✅ | ❌ | ❌ |
| **Plano 2** (`{system,whatsapp,ai}`) | ✅ | ✅ | ✅ |
| **Trial** (sem assinatura) | ✅ | ❌ | ❌ |
| **Legado sistema** (`{}`) | ✅ | ❌ | herança histórica |
| **Legado sistema + WhatsApp** (`{}`) | ✅ | ✅ | herança histórica |
| **Override LIFETIME** | ✅ | ✅ | ✅ |

**Duas mudanças deliberadas de comportamento**, que não são "byte a byte":

1. **Plano novo substitui a herança implícita pela declaração explícita.** Hoje `ai` herda `system` quando não há carteira. Um plano que declara `{system}` **não pode** receber IA por herança — a declaração governa.
2. **Trial deixa de conceder IA.** Hoje `trialing` concede `system`, e `ai` herda. Passa a negar explicitamente.

Ambas são seguras agora: `entitlements_enforced` está OFF e não existe carteira, então nenhum caminho de produção consome `ai.allowed` hoje. **Ambas precisam de teste próprio**, não de um teste genérico de compatibilidade.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `supabase/migrations/…_094_billing_plans_two_plan_model.sql` | 3 colunas + CHECKs + comments | criar |
| `supabase/migrations/…_095_revenue_source_plan_component.sql` | 5º valor no CHECK | criar |
| `_shared/entitlements-core.ts` | declaração explícita + IA sem herança | modificar |
| `_shared/entitlements.ts` | carrega `included_features` | modificar |
| `_shared/whatsapp-subscription-resolver-core.ts` | **novo** — fonte financeira, casos A/B/C/D | criar |
| `_shared/whatsapp-service-gate.ts` | adota o resolvedor; propaga ambiguidade | modificar |
| `_shared/whatsapp-service-state-core.ts` | recebe `subscriptionAmbiguous` | modificar |
| `process-whatsapp-enforcement/index.ts` | mesmo resolvedor | modificar |
| `_shared/whatsapp-instance-revenue-core.ts` | `PLAN_COMPONENT` + input inválido | modificar |
| `_shared/whatsapp-instance-worker-core.ts` | passa o componente | modificar |
| `_shared/whatsapp-connection-allowance-core.ts` | **novo** — allowance por origem e operação | criar |
| `manage-whatsapp-instances/index.ts` | allowance em `register_instance` | modificar |
| `manage-channels/index.ts` | allowance no provisionamento | modificar |
| `src/lib/entitlements-core.test.ts` | testes 1, 3, 4, 5, 6, 8 | modificar |
| `src/lib/whatsapp-subscription-resolver-core.test.ts` | testes 23–26 + precedência + ordem | criar |
| `src/lib/whatsapp-gate-coupling-guard.test.ts` | **guardrail estático** — teste 27 | criar |
| `src/lib/whatsapp-instance-revenue-core.test.ts` | `PLAN_COMPONENT` | modificar |
| `src/lib/whatsapp-connection-allowance-core.test.ts` | teste 30 + legados + backfill | criar |

---

## Task 1: Migration 094 — colunas aditivas endurecidas

**Files:**
- Create: `supabase/migrations/20260802180000_094_billing_plans_two_plan_model.sql`

**Interfaces:**
- Produces: `billing_plans.included_features text[]`, `included_whatsapp_connections integer`, `whatsapp_component_cents integer`.

- [ ] **Step 1: Escrever a migration**

```sql
-- 094 — Modelo comercial de dois planos: declaracao de features pelo plano.
--
-- ADITIVA. Plano com `included_features` vazio continua resolvendo por
-- FEATURE_CATEGORIES.
--
-- ATENCAO: `included_features` e AUTORIZACAO e NAO tem relacao com a coluna
-- `features` (jsonb), que e copy de marketing renderizada no PricingCard e
-- editada como textarea. Confundir as duas faria um administrador conceder
-- acesso ao editar uma frase comercial.

alter table billing_plans
  add column if not exists included_features text[] not null default '{}',
  add column if not exists included_whatsapp_connections integer not null default 0,
  add column if not exists whatsapp_component_cents integer;

do $$
begin
  -- conrelid junto do conname: nome de constraint e unico por TABELA, nao por
  -- banco. Checar so o nome faria um homonimo em outra tabela pular a criacao.
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_included_features_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_included_features_chk
      check (
        -- Vocabulario FECHADO nos valores de EntitlementFeature.
        included_features <@ array['system','whatsapp','ai']::text[]
        -- E sem NULL DENTRO do array: `array['system',null] <@ array[...]`
        -- avalia UNKNOWN, e CHECK aceita UNKNOWN. Sem esta linha, um elemento
        -- nulo atravessaria o vocabulario fechado em silencio.
        and array_position(included_features, null) is null
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_included_connections_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_included_connections_chk
      check (included_whatsapp_connections >= 0);
  end if;

  -- O componente atribuido nunca excede o que o cliente paga.
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_whatsapp_component_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_whatsapp_component_chk
      check (whatsapp_component_cents is null
             or (whatsapp_component_cents >= 0
                 and whatsapp_component_cents <= amount_cents));
  end if;
end $$;

comment on column billing_plans.included_features is
  'AUTORIZACAO. Features concedidas pelo plano (system|whatsapp|ai). NAO CONFUNDIR '
  'com billing_plans.features, que e copy de marketing sem efeito sobre acesso. '
  'Array vazio = plano legado, resolve por FEATURE_CATEGORIES. Array NAO vazio = '
  'declaracao explicita, que SUBSTITUI qualquer heranca implicita. '
  'Duplicatas nao sao proibidas pelo CHECK: a normalizacao e responsabilidade do '
  'seed e do fluxo administrativo de edicao (manage-billing), nao do banco.';

comment on column billing_plans.included_whatsapp_connections is
  'Conexoes de WhatsApp incluidas. Plano 1 = 0, Plano 2 = 1. Default 0 nas linhas '
  'PRE-EXISTENTES nao significa "sem conexao": contrato legado usa a politica '
  'historica, nao esta coluna. Ver whatsapp-connection-allowance-core.ts.';

comment on column billing_plans.whatsapp_component_cents is
  'Parcela contratual da mensalidade atribuivel ao PACOTE DE AUTOMACAO (WhatsApp '
  '+ IA + operacao relacionada). NAO e receita exclusiva da instancia Z-API. '
  'Congelada no ciclo na abertura (revenue_source=PLAN_COMPONENT).';

-- ROLLBACK (manual):
--   update billing_plans set included_features = '{}';
--   -- o resolvedor volta ao caminho de categoria, sem migration reversa.
```

- [ ] **Step 2: Verificar por leitura (não há banco local)**

Confirmar: todo `add column` com `if not exists`; todo `add constraint` guardado por `pg_constraint` **com `conrelid`**; nenhum `drop`; nenhum segredo; nenhuma URL.

Run: `npm run test -- scripts/migration-static-guard.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260802180000_094_billing_plans_two_plan_model.sql
git commit -m "feat(dois-planos): colunas aditivas de features, conexoes e componente"
```

---

## Task 2: Migration 095 — `PLAN_COMPONENT` no CHECK de `revenue_source`

**Files:**
- Create: `supabase/migrations/20260802180100_095_revenue_source_plan_component.sql`

- [ ] **Step 1: Confirmar o nome real do constraint**

Run: `grep -n "revenue_source" supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql`
Expected: CHECK **inline** na coluna → Postgres gera `whatsapp_instance_cycles_revenue_source_check`. Se houver `constraint <nome>` explícito, **usar esse nome**.

- [ ] **Step 2: Escrever a migration**

```sql
-- 095 — Quinto valor de revenue_source: PLAN_COMPONENT.
--
-- Unica operacao deste modelo que toca constraint ja aplicada. SUPERSET:
-- nenhuma linha existente viola o CHECK novo e nenhuma linha e reescrita.
-- Ciclos ja fechados mantem o revenue_source que tem — e isso e o que
-- "congelado historicamente" significa.

alter table whatsapp_instance_cycles
  drop constraint if exists whatsapp_instance_cycles_revenue_source_check;

alter table whatsapp_instance_cycles
  add constraint whatsapp_instance_cycles_revenue_source_check
  check (revenue_source is null or revenue_source in (
    'SUBSCRIPTION_SOLE_INSTANCE',
    'AMBIGUOUS_MULTI_INSTANCE',
    'LIFETIME_OVERRIDE',
    'NO_ENTITLEMENT',
    'PLAN_COMPONENT'
  ));

comment on column whatsapp_instance_cycles.revenue_source is
  'Origem da receita atribuida ao ciclo. PLAN_COMPONENT = componente contratual '
  'de AUTOMACAO declarado pelo plano de sistema (WhatsApp + IA + operacao). '
  'Nao e rateio e nao e receita pura da instancia: a margem consolidada precisa '
  'descontar tambem o custo de IA (Plano D).';

-- ROLLBACK: reversivel pelo par drop/add ENQUANTO nenhum ciclo tiver gravado
-- PLAN_COMPONENT. Depois disso, reverter exige decidir o que fazer com linhas
-- que sao historico financeiro.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260802180100_095_revenue_source_plan_component.sql
git commit -m "feat(dois-planos): PLAN_COMPONENT como origem de receita do ciclo"
```

---

## Task 3: `entitlements-core.ts` — declaração explícita e IA sem herança

**Files:**
- Modify: `supabase/functions/_shared/entitlements-core.ts`
- Test: `src/lib/entitlements-core.test.ts`

**Interfaces:**
- Produces: `EntitlementSubscriptionInput.includedFeatures?: string[]` — consumido pela Task 4.

> **Ponto de reprovação da v1.** O teste anterior dizia "ai herda system no mundo pré-carteira" para o Plano 1. Isso contradiz a decisão comercial: Plano 1 e trial **não recebem IA**.

- [ ] **Step 1: Escrever os testes que falham**

```ts
const base = { billingStatus: "active", trialEndsAt: null, overrides: [] };
const sub = (o: object) => ({ status: "active", current_period_end: null, ...o });

const planoReservas   = sub({ category: "SYSTEM_SUBSCRIPTION", includedFeatures: ["system"] });
const planoAutomacao  = sub({ category: "SYSTEM_SUBSCRIPTION", includedFeatures: ["system","whatsapp","ai"] });
const legadoSistema   = sub({ category: "SYSTEM_SUBSCRIPTION" });           // sem includedFeatures
const legadoWhatsapp  = sub({ category: "WHATSAPP_SUBSCRIPTION" });

it("teste 3 — Plano 1 concede system", () => {
  const e = resolveEntitlements({ ...base, subscriptions: [planoReservas] });
  expect(e.system.allowed).toBe(true);
  expect(e.system.source).toBe("subscription");
});

it("teste 4a — Plano 1 NAO concede whatsapp", () => {
  const e = resolveEntitlements({ ...base, subscriptions: [planoReservas] });
  expect(e.whatsapp.allowed).toBe(false);
});

it("teste 4b — Plano 1 NAO concede ai POR HERANCA", () => {
  // Regressao da v1 deste plano: a heranca pre-carteira dava ai=true aqui.
  const e = resolveEntitlements({ ...base, subscriptions: [planoReservas] });
  expect(e.ai.allowed).toBe(false);
  expect(e.ai.status).toBe("not_included");
});

it("teste 5 — Plano 2 concede system, whatsapp e ai", () => {
  const e = resolveEntitlements({ ...base, subscriptions: [planoAutomacao] });
  expect(e.system.allowed).toBe(true);
  expect(e.whatsapp.allowed).toBe(true);
  expect(e.ai.allowed).toBe(true);
});

it("teste 6a — legado SO sistema mantem o comportamento historico de ai", () => {
  // Heranca pre-carteira PRESERVADA para plano legado — e so para ele.
  const e = resolveEntitlements({ ...base, subscriptions: [legadoSistema] });
  expect(e.system.allowed).toBe(true);
  expect(e.whatsapp.allowed).toBe(false);
  expect(e.ai.allowed).toBe(true);
  expect(e.ai.source).toBe("subscription");
});

it("teste 6b — legado sistema + WhatsApp concede as duas por categoria", () => {
  const e = resolveEntitlements({ ...base, subscriptions: [legadoSistema, legadoWhatsapp] });
  expect(e.system.allowed).toBe(true);
  expect(e.whatsapp.allowed).toBe(true);
});

it("teste 8 — trial concede system e NAO concede whatsapp nem ai", () => {
  const e = resolveEntitlements({
    billingStatus: "trialing",
    trialEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
    overrides: [],
    subscriptions: [],
  });
  expect(e.system.allowed).toBe(true);
  expect(e.whatsapp.allowed).toBe(false);
  expect(e.ai.allowed).toBe(false);
});

it("teste 1 — copy de marketing nao concede acesso", () => {
  // `features` (copy) nao e input do nucleo. Nenhum campo de copy pode
  // aparecer aqui — este teste trava a fronteira.
  const e = resolveEntitlements({ ...base, subscriptions: [planoReservas] });
  expect(e.whatsapp.allowed).toBe(false);
  expect(e.ai.allowed).toBe(false);
});

it("teste 7 — Ren Sushi: override LIFETIME vence a assinatura", () => {
  const lifetime = (feature: string) => ({
    feature, enabled: true, grant_type: "LIFETIME" as const,
    starts_at: "2020-01-01T00:00:00Z", ends_at: null, revoked_at: null,
  });
  const e = resolveEntitlements({
    billingStatus: "active", trialEndsAt: null,
    overrides: [lifetime("system"), lifetime("whatsapp"), lifetime("ai")],
    subscriptions: [],
  });
  expect(e.system.source).toBe("override");
  expect(e.whatsapp.source).toBe("override");
  expect(e.ai.source).toBe("override");
});

it("declaracao explicita vence heranca mesmo com carteira ausente", () => {
  const e = resolveEntitlements({ ...base, subscriptions: [planoReservas] });
  expect(e.ai.source).not.toBe("wallet");
  expect(e.ai.allowed).toBe(false);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run test -- src/lib/entitlements-core.test.ts`
Expected: FAIL nos testes 4b, 5, 8 e no último.

- [ ] **Step 3: Implementar**

Interface:

```ts
export interface EntitlementSubscriptionInput {
  status: string;
  category: string;
  current_period_end: string | null;
  /**
   * billing_plans.included_features — features declaradas pelo PLANO.
   * Ausente ou vazio => plano LEGADO: resolve so por categoria e a IA mantem
   * a heranca historica.
   * Nao vazio => plano NOVO: a declaracao GOVERNA e substitui a heranca.
   *
   * NAO confundir com billing_plans.features (copy de marketing).
   */
  includedFeatures?: string[];
}
```

Passo 3 de `resolveFeature`:

```ts
  const categories = FEATURE_CATEGORIES[feature];
  const sub = inputs.subscriptions.find(
    (s) =>
      ALLOWED_SUB_STATUSES.has(s.status) &&
      (categories.includes(s.category) || (s.includedFeatures ?? []).includes(feature)),
  );
```

Resolução da IA em `resolveEntitlements` — o degrau novo entra **entre** override e carteira:

```ts
  const system = resolveFeature("system", inputs, nowMs);
  const whatsapp = resolveFeature("whatsapp", inputs, nowMs);

  // Existe alguma assinatura VIVA com declaracao explicita? Se sim, o mundo
  // desta organizacao e o de dois planos, e a declaracao governa a IA — sem
  // heranca implicita de `system`.
  const hasExplicitPlan = inputs.subscriptions.some(
    (s) => ALLOWED_SUB_STATUSES.has(s.status) && (s.includedFeatures ?? []).length > 0,
  );

  const aiDirect = resolveFeature("ai", inputs, nowMs);
  let ai: FeatureEntitlement;

  if (aiDirect.source === "admin_block" || aiDirect.source === "override") {
    ai = aiDirect;                                  // 1. override sempre primeiro
  } else if (aiDirect.source === "subscription") {
    ai = aiDirect;                                  // 2. declarada pelo plano
  } else if (hasExplicitPlan) {
    // 3. Plano novo que NAO declara ai: negacao EXPLICITA. Sem este ramo, a
    //    heranca abaixo daria IA ao Plano 1.
    ai = { allowed: false, source: "none", status: "not_included", expiresAt: null };
  } else if (system.source === "trial") {
    // 4. Trial nunca concede IA (decisao comercial: custo variavel sem receita).
    ai = { allowed: false, source: "none", status: "trial_no_ai", expiresAt: null };
  } else if (inputs.aiWalletBalanceCents === undefined) {
    ai = { ...system };                             // 5. legado pre-carteira
  } else {
    /* ...ramo de carteira, inalterado... */
  }
```

**Ordem dos ramos é load-bearing.** Mover 3 para depois de 5 reintroduz a herança; mover 4 para depois de 5 devolve IA ao trial.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm run test -- src/lib/entitlements-core.test.ts`
Expected: PASS, **incluindo os testes que já existiam** — se algum antigo quebrar, ele documenta comportamento legado e a quebra precisa ser justificada por escrito antes de ajustá-lo.

Run: `npm run typecheck`
Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/entitlements-core.ts src/lib/entitlements-core.test.ts
git commit -m "feat(dois-planos): declaracao explicita do plano governa a IA, sem heranca"
```

---

## Task 4: `entitlements.ts` — carregar `included_features`

**Files:**
- Modify: `supabase/functions/_shared/entitlements.ts`

- [ ] **Step 1: Alterar o select e a normalização**

```ts
interface SubscriptionRow {
  status: string;
  current_period_end: string | null;
  billing_plans:
    | { category: string | null; included_features: string[] | null }
    | { category: string | null; included_features: string[] | null }[]
    | null;
}
```

```ts
      .select("status, current_period_end, billing_plans(category, included_features)")
```

```ts
      return {
        status: row.status,
        category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
        current_period_end: row.current_period_end,
        // Coluna ausente (EF deployada antes da migration) vira [] = legado.
        // O fail-closed real desse caminho e `readFailed`, ja tratado acima.
        includedFeatures: plan?.included_features ?? [],
      };
```

- [ ] **Step 2: Registrar a ordem de aplicação no cabeçalho**

```
 * ORDEM: a migration 094 (included_features) precisa estar aplicada ANTES do
 * deploy desta versao. Coluna inexistente vira 400 do PostgREST -> readFailed.
```

- [ ] **Step 3: Verificar e commitar**

Run: `npm run typecheck`
Expected: zero erros.

```bash
git add supabase/functions/_shared/entitlements.ts
git commit -m "feat(dois-planos): adapter carrega included_features do plano"
```

---

## Task 5: Núcleo puro — fonte financeira do WhatsApp

**Files:**
- Create: `supabase/functions/_shared/whatsapp-subscription-resolver-core.ts`
- Test: `src/lib/whatsapp-subscription-resolver-core.test.ts`

**Interfaces:**
- Produces: `resolveWhatsAppSubscription(input): WhatsAppSubscriptionResolution` — consumido pela Task 6 **nas duas pontas**.

> **Dois pontos de reprovação da v1:** `PLAN_INCLUDED` aceitava qualquer categoria com o array preenchido; e a precedência só olhava `active`.

- [ ] **Step 1: Escrever os testes que falham**

```ts
const fact = (o: Partial<WhatsAppSubscriptionFact>): WhatsAppSubscriptionFact => ({
  id: "s1", status: "active", category: "SYSTEM_SUBSCRIPTION",
  includedFeatures: [], canceledAt: null, suspendedAt: null, ...o,
});
const inc = (o: Partial<WhatsAppSubscriptionFact> = {}) =>
  fact({ id: "sys", includedFeatures: ["system","whatsapp","ai"], ...o });
const leg = (o: Partial<WhatsAppSubscriptionFact> = {}) =>
  fact({ id: "wa", category: "WHATSAPP_SUBSCRIPTION", ...o });

it("teste 23 — Plano 2 usa a assinatura de SISTEMA como fonte", () => {
  const r = resolveWhatsAppSubscription({ subscriptions: [inc()] });
  expect(r.kind).toBe("RESOLVED");
  if (r.kind !== "RESOLVED") return;
  expect(r.source).toBe("PLAN_INCLUDED");
  expect(r.provisioningAmbiguous).toBe(false);
});

it("teste 24 — legado usa WHATSAPP_SUBSCRIPTION", () => {
  const r = resolveWhatsAppSubscription({
    subscriptions: [fact({ id: "sys", includedFeatures: ["system"] }), leg()],
  });
  expect(r.kind).toBe("RESOLVED");
  if (r.kind !== "RESOLVED") return;
  expect(r.source).toBe("LEGACY_CATEGORY");
  expect(r.subscriptionId).toBe("wa");
});

it("categoria NAO sistemica com includedFeatures=[whatsapp] NAO vira PLAN_INCLUDED", () => {
  for (const cat of ["CUSTOM","TRIAL","AI_CREDIT_PACKAGE","WHATSAPP_IMPLEMENTATION"]) {
    const r = resolveWhatsAppSubscription({
      subscriptions: [fact({ id: cat, category: cat, includedFeatures: ["whatsapp"] })],
    });
    expect(r.kind).toBe("NONE");
  }
});

describe("teste 25 — transicao: precedencia explicita de status", () => {
  const casos: Array<[string, string, string, string]> = [
    // [status do Plano 2, status do legado, id escolhido, descricao]
    ["active",   "past_due", "sys", "P2 active vence legado past_due"],
    ["past_due", "active",   "wa",  "legado active vence P2 past_due"],
    ["trialing", "past_due", "sys", "P2 trialing vence legado past_due"],
    ["past_due", "trialing", "wa",  "legado trialing vence P2 past_due"],
    ["active",   "active",   "sys", "empate active: preferencia pelo modelo novo"],
    ["past_due", "past_due", "sys", "empate past_due: preferencia pelo modelo novo"],
  ];
  for (const [sIncluded, sLegacy, expectedId, desc] of casos) {
    it(desc, () => {
      const r = resolveWhatsAppSubscription({
        subscriptions: [inc({ status: sIncluded }), leg({ status: sLegacy })],
      });
      expect(r.kind).toBe("RESOLVED");
      if (r.kind !== "RESOLVED") return;
      expect(r.subscriptionId).toBe(expectedId);
      // A escolha da fonte NAO remove nenhum dos tres marcadores:
      expect(r.source).toBe("TRANSITION");
      expect(r.adminPendency).toBe("LEGACY_WHATSAPP_SUBSCRIPTION_OPEN");
      expect(r.provisioningAmbiguous).toBe(true);
    });
  }
});

it("teste 26 — duplicidade legada nao escolhe a mais recente", () => {
  const r = resolveWhatsAppSubscription({
    subscriptions: [leg({ id: "wa2" }), leg({ id: "wa1" })],
  });
  expect(r.kind).toBe("AMBIGUOUS");
  if (r.kind !== "AMBIGUOUS") return;
  expect(r.reasonCode).toBe("DUPLICATE_SAME_CATEGORY");
  expect(r.candidateIds).toEqual(["wa1", "wa2"]);   // ORDEM CANONICA, sem .sort() no teste
});

it("duplicidade PLAN_INCLUDED tambem e ambigua", () => {
  const r = resolveWhatsAppSubscription({
    subscriptions: [inc({ id: "b" }), inc({ id: "a" })],
  });
  expect(r.kind).toBe("AMBIGUOUS");
  if (r.kind !== "AMBIGUOUS") return;
  expect(r.candidateIds).toEqual(["a", "b"]);
});

it("nenhuma fonte: NONE, nunca excecao", () => {
  expect(resolveWhatsAppSubscription({ subscriptions: [] }).kind).toBe("NONE");
  expect(resolveWhatsAppSubscription({
    subscriptions: [fact({ includedFeatures: ["system"] })],
  }).kind).toBe("NONE");
});

it("cancelada nao e candidata; past_due e", () => {
  expect(resolveWhatsAppSubscription({ subscriptions: [leg({ status: "canceled" })] }).kind).toBe("NONE");
  expect(resolveWhatsAppSubscription({ subscriptions: [leg({ status: "past_due" })] }).kind).toBe("RESOLVED");
});

describe("insensibilidade a ordem das linhas", () => {
  const cenarios: Array<[string, WhatsAppSubscriptionFact[]]> = [
    ["transicao",             [inc(), leg()]],
    ["duplicidade legada",    [leg({ id: "wa1" }), leg({ id: "wa2" })]],
    ["duplicidade included",  [inc({ id: "a" }), inc({ id: "b" })]],
    ["fonte unica",           [inc()]],
    ["nenhuma fonte",         [fact({ includedFeatures: ["system"] })]],
  ];
  for (const [nome, linhas] of cenarios) {
    it(`${nome}: mesmo resultado com a ordem invertida`, () => {
      const a = resolveWhatsAppSubscription({ subscriptions: linhas });
      const b = resolveWhatsAppSubscription({ subscriptions: [...linhas].reverse() });
      expect(a).toEqual(b);
    });
  }
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run test -- src/lib/whatsapp-subscription-resolver-core.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
/**
 * Nucleo PURO: qual assinatura financia o WhatsApp de uma organizacao.
 * ZERO IMPORTS.
 *
 * Substitui a query com `.maybeSingle()` que existia em DOIS lugares
 * (whatsapp-service-gate.ts e process-whatsapp-enforcement/index.ts) e que
 * precisava ser mantida campo-a-campo identica por disciplina humana. A
 * garantia passa a ser estrutural: os dois chamam esta funcao, e um guardrail
 * estatico prova que continuam chamando.
 *
 * `.maybeSingle()` LANCA com mais de uma linha — e a transicao entre o modelo
 * antigo e o de dois planos produz exatamente duas linhas elegiveis.
 *
 * NAO decide se o servico esta ativo (isso e do gate de sete estados). Decide
 * QUAL assinatura e a fonte financeira, e se ha ambiguidade.
 */

const FUNDING_STATUSES = new Set(["active", "trialing", "past_due"]);
const WHATSAPP_CATEGORY = "WHATSAPP_SUBSCRIPTION";
const SYSTEM_CATEGORY = "SYSTEM_SUBSCRIPTION";

/**
 * Precedencia de continuidade. Menor vence. Independente da ordem das linhas,
 * de created_at e da posicao no array — o PostgREST nao garante ordem sem
 * ORDER BY, e gate e worker podem receber as mesmas linhas em ordens
 * diferentes.
 */
const STATUS_RANK: Record<string, number> = { active: 0, trialing: 1, past_due: 2 };

export interface WhatsAppSubscriptionFact {
  id: string;
  status: string;
  category: string;
  includedFeatures: string[];
  canceledAt: string | null;
  suspendedAt: string | null;
}

export interface WhatsAppSubscriptionInput {
  subscriptions: WhatsAppSubscriptionFact[];
}

export type WhatsAppSubscriptionSource = "PLAN_INCLUDED" | "LEGACY_CATEGORY" | "TRANSITION";

export type WhatsAppSubscriptionResolution =
  | {
      kind: "RESOLVED";
      source: WhatsAppSubscriptionSource;
      subscriptionId: string;
      status: string;
      canceledAt: string | null;
      suspendedAt: string | null;
      /** Fail-closed so para PROVISIONAMENTO NOVO; envio existente segue. */
      provisioningAmbiguous: boolean;
      adminPendency: "LEGACY_WHATSAPP_SUBSCRIPTION_OPEN" | null;
      /** Ordem canonica (id crescente) — insensivel a ordem de entrada. */
      candidateIds: string[];
    }
  | { kind: "NONE" }
  | { kind: "AMBIGUOUS"; reasonCode: "DUPLICATE_SAME_CATEGORY"; candidateIds: string[] };

const canonical = (ids: string[]): string[] => [...ids].sort();

export function resolveWhatsAppSubscription(
  input: WhatsAppSubscriptionInput,
): WhatsAppSubscriptionResolution {
  const funding = input.subscriptions.filter((s) => FUNDING_STATUSES.has(s.status));

  const legacy = funding.filter((s) => s.category === WHATSAPP_CATEGORY);

  // ESTRITO: so SYSTEM_SUBSCRIPTION vira PLAN_INCLUDED. Um array preenchido
  // por engano num plano CUSTOM/TRIAL/AI_CREDIT_PACKAGE/WHATSAPP_IMPLEMENTATION
  // nao pode virar fonte financeira do WhatsApp.
  const included = funding.filter(
    (s) => s.category === SYSTEM_CATEGORY && s.includedFeatures.includes("whatsapp"),
  );

  // D — duplicidade inesperada DENTRO da mesma categoria: erro/revisao.
  if (legacy.length > 1) {
    return { kind: "AMBIGUOUS", reasonCode: "DUPLICATE_SAME_CATEGORY",
             candidateIds: canonical(legacy.map((s) => s.id)) };
  }
  if (included.length > 1) {
    return { kind: "AMBIGUOUS", reasonCode: "DUPLICATE_SAME_CATEGORY",
             candidateIds: canonical(included.map((s) => s.id)) };
  }

  const legacyOne = legacy[0] ?? null;
  const includedOne = included[0] ?? null;

  if (!legacyOne && !includedOne) return { kind: "NONE" };

  // C — transicao. Continuidade do servico pela MELHOR posicao de status;
  // empate resolve pelo modelo NOVO, deterministicamente.
  if (legacyOne && includedOne) {
    const rankInc = STATUS_RANK[includedOne.status] ?? Number.MAX_SAFE_INTEGER;
    const rankLeg = STATUS_RANK[legacyOne.status] ?? Number.MAX_SAFE_INTEGER;
    const chosen = rankLeg < rankInc ? legacyOne : includedOne;
    return {
      kind: "RESOLVED",
      source: "TRANSITION",
      subscriptionId: chosen.id,
      status: chosen.status,
      canceledAt: chosen.canceledAt,
      suspendedAt: chosen.suspendedAt,
      provisioningAmbiguous: true,
      adminPendency: "LEGACY_WHATSAPP_SUBSCRIPTION_OPEN",
      candidateIds: canonical([legacyOne.id, includedOne.id]),
    };
  }

  const one = legacyOne ?? includedOne!;
  return {
    kind: "RESOLVED",
    source: legacyOne ? "LEGACY_CATEGORY" : "PLAN_INCLUDED",
    subscriptionId: one.id,
    status: one.status,
    canceledAt: one.canceledAt,
    suspendedAt: one.suspendedAt,
    provisioningAmbiguous: false,
    adminPendency: null,
    candidateIds: [one.id],
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm run test -- src/lib/whatsapp-subscription-resolver-core.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp-subscription-resolver-core.ts \
        src/lib/whatsapp-subscription-resolver-core.test.ts
git commit -m "feat(dois-planos): resolvedor estrito da fonte financeira do WhatsApp"
```

---

## Task 6: Gate de estado recebe `subscriptionAmbiguous`

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-service-state-core.ts`
- Test: `src/lib/whatsapp-service-state-core.test.ts`

**Interfaces:**
- Consumes: nada (núcleo puro).
- Produces: campo novo em `WhatsAppGateInput` / entrada de `resolveProvisioningEligibility` — consumido pela Task 7.

> **Ponto de reprovação da v1:** o adapter mapeava ambiguidade para `dataReadFailed`. **Falha de leitura e ambiguidade comercial são estados diferentes** e não podem colapsar.

- [ ] **Step 1: Escrever os testes que falham**

```ts
it("transicao valida NAO bloqueia envio existente", () => {
  const d = decideWhatsAppGate({ ...ativo, subscriptionAmbiguous: true });
  expect(SENDING_BLOCKED_BY_STATE[d.state]).toBe(false);
});

it("transicao valida BLOQUEIA provisionamento novo", () => {
  const d = decideWhatsAppGate({ ...ativo, subscriptionAmbiguous: true });
  const p = resolveProvisioningEligibility({ decision: d, dataReadFailed: false,
                                             subscriptionAmbiguous: true });
  expect(p.allowed).toBe(false);
  expect(p.reasonCode).toBe("SUBSCRIPTION_AMBIGUOUS");
});

it("duplicidade inesperada tambem bloqueia provisionamento", () => {
  const p = resolveProvisioningEligibility({ decision: ativoDecision, dataReadFailed: false,
                                             subscriptionAmbiguous: true });
  expect(p.allowed).toBe(false);
});

it("falha de leitura mantem a polaridade que ja existia", () => {
  const p = resolveProvisioningEligibility({ decision: ativoDecision, dataReadFailed: true,
                                             subscriptionAmbiguous: false });
  expect(p.allowed).toBe(false);
  expect(p.reasonCode).not.toBe("SUBSCRIPTION_AMBIGUOUS");   // motivo PROPRIO
});

it("os tres estados nao se confundem", () => {
  const normal    = resolveProvisioningEligibility({ decision: ativoDecision, dataReadFailed: false, subscriptionAmbiguous: false });
  const ambiguo   = resolveProvisioningEligibility({ decision: ativoDecision, dataReadFailed: false, subscriptionAmbiguous: true });
  const semLeitura= resolveProvisioningEligibility({ decision: ativoDecision, dataReadFailed: true,  subscriptionAmbiguous: false });
  expect(normal.allowed).toBe(true);
  expect(ambiguo.allowed).toBe(false);
  expect(semLeitura.allowed).toBe(false);
  expect(ambiguo.reasonCode).not.toBe(semLeitura.reasonCode);
});
```

- [ ] **Step 2: Confirmar o comportamento atual de envio antes de mudar**

Run: `grep -n "SENDING_BLOCKED_BY_STATE" -A 12 supabase/functions/_shared/whatsapp-service-state-core.ts`
Expected: o record exaustivo dos sete estados. **Anotar o valor de cada um** — a mudança desta task **não pode** alterar nenhum deles. `subscriptionAmbiguous` afeta **somente** a elegibilidade de provisionamento.

- [ ] **Step 3: Implementar**

- `WhatsAppGateInput` ganha `subscriptionAmbiguous?: boolean` (opcional → default `false`, mantendo os callers atuais válidos).
- `SENDING_BLOCKED_BY_STATE` **não muda**.
- `resolveProvisioningEligibility` ganha `subscriptionAmbiguous` no input e nega com `reasonCode: "SUBSCRIPTION_AMBIGUOUS"`, **distinto** do motivo de `dataReadFailed`.

As duas polaridades opostas da spec são preservadas: **envio fail-OPEN** a soluço técnico e a ambiguidade comercial; **provisionamento fail-CLOSED** a ambos, por motivos separados.

- [ ] **Step 4: Rodar e commitar**

Run: `npm run test -- src/lib/whatsapp-service-state-core.test.ts`
Expected: PASS, com todos os testes anteriores dos sete estados intactos.

```bash
git add supabase/functions/_shared/whatsapp-service-state-core.ts \
        src/lib/whatsapp-service-state-core.test.ts
git commit -m "feat(dois-planos): ambiguidade de assinatura e estado proprio, nao falha de leitura"
```

---

## Task 7: Gate e enforcement adotam o resolvedor — UM COMMIT SÓ

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-service-gate.ts` (~linhas 125-154)
- Modify: `supabase/functions/process-whatsapp-enforcement/index.ts` (~linha 194)

**Interfaces:**
- Consumes: `resolveWhatsAppSubscription` (Task 5), `subscriptionAmbiguous` (Task 6), `included_features` (Tasks 1, 4).

> **1º acoplamento de rollout.** As duas queries eram idênticas por disciplina humana. **Este commit muda as duas ou não muda nenhuma.**

- [ ] **Step 1: Substituir a query no gate**

```ts
    // TODAS as candidatas, sem .maybeSingle(): a transicao produz duas linhas
    // elegiveis e .maybeSingle() LANCA nesse caso. A decisao e do nucleo puro.
    supabase
      .from("billing_subscriptions")
      .select("id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features)")
      .eq("organization_id", organizationId)
      .neq("status", "canceled"),
```

- [ ] **Step 2: Normalizar e resolver, propagando a ambiguidade**

```ts
  const rows = (subRes.data ?? []) as SubscriptionGateRow[];
  const resolution = resolveWhatsAppSubscription({
    subscriptions: rows.map((r) => {
      const plan = Array.isArray(r.billing_plans) ? r.billing_plans[0] : r.billing_plans;
      return {
        id: r.id,
        status: r.status,
        category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
        includedFeatures: plan?.included_features ?? [],
        canceledAt: r.canceled_at,
        suspendedAt: r.suspended_at,
      };
    }),
  });

  // Ambiguidade COMERCIAL — deliberadamente separada de `dataReadFailed`.
  // Colapsar as duas faria uma transicao legitima parecer banco fora do ar.
  const subscriptionAmbiguous =
    resolution.kind === "AMBIGUOUS" ||
    (resolution.kind === "RESOLVED" && resolution.provisioningAmbiguous);

  if (resolution.kind === "AMBIGUOUS") {
    jsonLog("warn", {
      evt: "whatsapp_gate_ambiguous_subscription",
      org: organizationId,
      reason: resolution.reasonCode,
      candidates: resolution.candidateIds.length,
    });
  } else if (resolution.kind === "RESOLVED" && resolution.adminPendency) {
    jsonLog("info", {
      evt: "whatsapp_gate_transition_pending",
      org: organizationId,
      pendency: resolution.adminPendency,
      chosen: resolution.subscriptionId,
    });
  }

  const sub = resolution.kind === "RESOLVED"
    ? { id: resolution.subscriptionId, status: resolution.status,
        canceled_at: resolution.canceledAt, suspended_at: resolution.suspendedAt }
    : null;
```

E os dois consumidores recebem o campo:

```ts
  const decision = decideWhatsAppGate({ /* ...campos atuais... */, subscriptionAmbiguous });
  const provisioning = resolveProvisioningEligibility({ decision, dataReadFailed, subscriptionAmbiguous });
```

`ServiceGateResult` expõe `subscriptionAmbiguous` e `adminPendency` — o painel da plataforma precisa vê-los, e um campo que não sai do adapter é decorativo.

- [ ] **Step 3: Aplicar exatamente o mesmo no worker**

Em `process-whatsapp-enforcement/index.ts`: mesma query, mesma normalização, mesma chamada, mesma propagação.

Run: `grep -n "maybeSingle" supabase/functions/process-whatsapp-enforcement/index.ts`
Expected: nenhuma ocorrência na resolução de assinatura.

- [ ] **Step 4: Verificar**

Run: `npm run typecheck && npx eslint supabase/functions --max-warnings=0`
Expected: zero erros, zero warnings. É a única cobertura automatizada dos `index.ts` — vitest não os alcança.

- [ ] **Step 5: Commit único**

```bash
git add supabase/functions/_shared/whatsapp-service-gate.ts \
        supabase/functions/process-whatsapp-enforcement/index.ts
git commit -m "fix(dois-planos): gate e enforcement compartilham o resolvedor de assinatura"
```

---

## Task 8: Guardrail estático do acoplamento (teste 27)

**Files:**
- Create: `src/lib/whatsapp-gate-coupling-guard.test.ts`

> **Ponto de reprovação da v1.** Chamar o resolvedor duas vezes dentro do teste prova determinismo — **não** prova que os dois consumidores o importam, nem que a query antiga não voltou.

- [ ] **Step 1: Escrever o guardrail**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONSUMIDORES = [
  "supabase/functions/_shared/whatsapp-service-gate.ts",
  "supabase/functions/process-whatsapp-enforcement/index.ts",
] as const;

const ler = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("teste 27 — gate e enforcement usam O MESMO resolvedor", () => {
  for (const arquivo of CONSUMIDORES) {
    describe(arquivo, () => {
      const src = ler(arquivo);

      it("importa resolveWhatsAppSubscription", () => {
        expect(src).toMatch(/whatsapp-subscription-resolver-core\.ts/);
        expect(src).toMatch(/resolveWhatsAppSubscription/);
      });

      it("CHAMA resolveWhatsAppSubscription, nao so importa", () => {
        expect(src).toMatch(/resolveWhatsAppSubscription\s*\(/);
      });

      it("nao resolve a assinatura financeira com maybeSingle", () => {
        // maybeSingle LANCA com duas linhas — e a transicao produz duas.
        const trechos = src.split(/\n/).filter((l) => /maybeSingle/.test(l));
        for (const l of trechos) {
          expect(l).not.toMatch(/billing_subscriptions/);
        }
        expect(src).not.toMatch(/billing_plans\.category[\s\S]{0,400}?maybeSingle/);
      });

      it("nao filtra exclusivamente por WHATSAPP_SUBSCRIPTION para decidir", () => {
        // O filtro estrito por categoria e do NUCLEO. Um .eq() aqui devolveria
        // zero linha para uma organizacao do Plano 2 — o bug que este plano mata.
        expect(src).not.toMatch(/\.eq\(\s*["'`]billing_plans\.category["'`]/);
      });

      it("nao reimplementa a precedencia de status localmente", () => {
        expect(src).not.toMatch(/STATUS_RANK/);
        expect(src).not.toMatch(/LEGACY_WHATSAPP_SUBSCRIPTION_OPEN\s*=/);
      });

      it("propaga subscriptionAmbiguous ao provisionamento", () => {
        expect(src).toMatch(/subscriptionAmbiguous/);
      });
    });
  }

  it("existe exatamente UMA implementacao da precedencia", () => {
    const nucleo = ler("supabase/functions/_shared/whatsapp-subscription-resolver-core.ts");
    expect(nucleo).toMatch(/STATUS_RANK/);
  });
});
```

O guardrail é textual **de propósito**: os `index.ts` importam `deno.land`/`esm.sh` e chamam `serve()` no carregamento, então vitest não consegue importá-los. Análise estática de texto é o que resta — e é mais do que existe hoje.

- [ ] **Step 2: Rodar**

Run: `npm run test -- src/lib/whatsapp-gate-coupling-guard.test.ts`
Expected: PASS. Se falhar, a Task 7 está incompleta em um dos dois lados — **corrigir antes de seguir**, nunca afrouxar o guardrail.

- [ ] **Step 3: Commit**

```bash
git add src/lib/whatsapp-gate-coupling-guard.test.ts
git commit -m "test(dois-planos): guardrail estatico prova o acoplamento gate/enforcement"
```

---

## Task 9: `PLAN_COMPONENT` no núcleo de receita

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-instance-revenue-core.ts`
- Test: `src/lib/whatsapp-instance-revenue-core.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

```ts
it("componente de plano com UMA instancia vira PLAN_COMPONENT", () => {
  const r = attributeRevenue({ activeInstanceCount: 1, subscriptionAmountCents: 79990,
                               hasLifetimeWhatsappOverride: false, planWhatsappComponentCents: 35000 });
  expect(r.revenueSource).toBe("PLAN_COMPONENT");
  expect(r.customerRevenueCents).toBe(35000);
});

it("componente com DUAS instancias e ambiguo, nunca dividido nem duplicado", () => {
  const r = attributeRevenue({ activeInstanceCount: 2, subscriptionAmountCents: 79990,
                               hasLifetimeWhatsappOverride: false, planWhatsappComponentCents: 35000 });
  expect(r.revenueSource).toBe("AMBIGUOUS_MULTI_INSTANCE");
  expect(r.customerRevenueCents).toBeNull();
});

it("ZERO instancias retorna INVALID_INPUT, nunca uma origem de receita", () => {
  const r = attributeRevenue({ activeInstanceCount: 0, subscriptionAmountCents: 79990,
                               hasLifetimeWhatsappOverride: false, planWhatsappComponentCents: 35000 });
  expect(r.kind).toBe("INVALID_INPUT");
  if (r.kind !== "INVALID_INPUT") return;
  expect(r.reasonCode).toBe("NO_ACTIVE_INSTANCE");
});

it("INVALID_INPUT nao possui revenueSource", () => {
  const r = attributeRevenue({ activeInstanceCount: 0, subscriptionAmountCents: 79990,
                               hasLifetimeWhatsappOverride: false, planWhatsappComponentCents: 35000 });
  expect((r as Record<string, unknown>).revenueSource).toBeUndefined();
  expect((r as Record<string, unknown>).customerRevenueCents).toBeUndefined();
});

it("INVALID_INPUT vence ate o override vitalicio — fatos inconsistentes nao viram receita zero", () => {
  const r = attributeRevenue({ activeInstanceCount: 0, subscriptionAmountCents: 79990,
                               hasLifetimeWhatsappOverride: true, planWhatsappComponentCents: 35000 });
  expect(r.kind).toBe("INVALID_INPUT");
});

it("ausencia REAL de entitlement continua sendo NO_ENTITLEMENT", () => {
  const r = attributeRevenue({ activeInstanceCount: 1, subscriptionAmountCents: null,
                               hasLifetimeWhatsappOverride: false });
  expect(r.kind).toBe("ATTRIBUTED");
  if (r.kind !== "ATTRIBUTED") return;
  expect(r.revenueSource).toBe("NO_ENTITLEMENT");
  expect(r.customerRevenueCents).toBeNull();
});

it("override vitalicio vence o componente (Ren Sushi)", () => {
  const r = attributeRevenue({ activeInstanceCount: 1, subscriptionAmountCents: 79990,
                               hasLifetimeWhatsappOverride: true, planWhatsappComponentCents: 35000 });
  expect(r.revenueSource).toBe("LIFETIME_OVERRIDE");
  expect(r.customerRevenueCents).toBe(0);
});

it("plano sem componente mantem o caminho legado", () => {
  const r = attributeRevenue({ activeInstanceCount: 1, subscriptionAmountCents: 14900,
                               hasLifetimeWhatsappOverride: false });
  expect(r.revenueSource).toBe("SUBSCRIPTION_SOLE_INSTANCE");
  expect(r.customerRevenueCents).toBe(14900);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run test -- src/lib/whatsapp-instance-revenue-core.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Cabeçalho do arquivo ganha:

```ts
// PLAN_COMPONENT e o componente contratual do PACOTE DE AUTOMACAO (WhatsApp +
// IA + operacao relacionada) — NAO e receita pura da instancia Z-API.
// Consequencias:
//   - a margem parcial desta fase e `componente - custo Z-API`;
//   - a margem CONSOLIDADA correta precisa descontar tambem o custo de IA,
//     integrado pelo Plano D;
//   - o mesmo componente NUNCA e somado de novo em outra margem;
//   - com N instancias, AMBIGUOUS_MULTI_INSTANCE — nunca R$350 por instancia.
```

Tipo e função:

```ts
export type RevenueSource =
  | "SUBSCRIPTION_SOLE_INSTANCE" | "AMBIGUOUS_MULTI_INSTANCE"
  | "LIFETIME_OVERRIDE" | "NO_ENTITLEMENT" | "PLAN_COMPONENT";

/**
 * UNIAO DISCRIMINADA. `INVALID_INPUT` NAO e uma origem de receita: e a
 * afirmacao de que os fatos recebidos sao internamente inconsistentes.
 *
 * NO_ENTITLEMENT significa "nao existe fonte valida de receita" — resultado
 * comercialmente VALIDO, persistivel no historico economico. Contagem zero
 * dentro de um calculo feito PARA O CICLO DE UMA INSTANCIA significa outra
 * coisa: erro de input ou de consulta. Colapsar os dois deixaria um caller
 * incompleto gravar inconsistencia como se fosse situacao comercial.
 */
export type RevenueAttribution =
  | { kind: "ATTRIBUTED"; customerRevenueCents: number | null; revenueSource: RevenueSource }
  | { kind: "INVALID_INPUT"; reasonCode: "NO_ACTIVE_INSTANCE" };

export type RevenueInput = {
  activeInstanceCount: number;
  subscriptionAmountCents: number | null;
  hasLifetimeWhatsappOverride: boolean;
  planWhatsappComponentCents?: number | null;
};

const attributed = (
  customerRevenueCents: number | null,
  revenueSource: RevenueSource,
): RevenueAttribution => ({ kind: "ATTRIBUTED", customerRevenueCents, revenueSource });

export function attributeRevenue(input: RevenueInput): RevenueAttribution {
  // attributeRevenue e chamada POR CICLO DE INSTANCIA: contagem < 1 e erro de
  // programacao, nao cenario de negocio. Vem ANTES ate do override vitalicio —
  // "receita zero verdadeira" tambem e uma afirmacao, e nao ha o que afirmar
  // sobre uma instancia que nao existe.
  if (!(input.activeInstanceCount >= 1)) {
    return { kind: "INVALID_INPUT", reasonCode: "NO_ACTIVE_INSTANCE" };
  }

  if (input.hasLifetimeWhatsappOverride) return attributed(0, "LIFETIME_OVERRIDE");

  const component = input.planWhatsappComponentCents;
  if (component !== null && component !== undefined) {
    if (input.activeInstanceCount > 1) return attributed(null, "AMBIGUOUS_MULTI_INSTANCE");
    return attributed(component, "PLAN_COMPONENT");
  }

  if (input.subscriptionAmountCents === null || input.subscriptionAmountCents === undefined) {
    return attributed(null, "NO_ENTITLEMENT");
  }
  if (input.activeInstanceCount > 1) return attributed(null, "AMBIGUOUS_MULTI_INSTANCE");
  return attributed(input.subscriptionAmountCents, "SUBSCRIPTION_SOLE_INSTANCE");
}
```

**Todos os call sites de `attributeRevenue` são atualizados neste mesmo trabalho** para tratar a união. Sob `strict: false`, usar `result.kind === "ATTRIBUTED"` ou early-return explícito — **nunca** estreitamento booleano implícito.

Run: `grep -rn "attributeRevenue" supabase/ src/ --include=*.ts --include=*.tsx`
Expected: a lista completa de callers. Todos tratados nesta task ou na Task 10.

- [ ] **Step 4: Rodar e commitar**

Run: `npm run test -- src/lib/whatsapp-instance-revenue-core.test.ts`
Expected: PASS, incluindo os testes antigos.

```bash
git add supabase/functions/_shared/whatsapp-instance-revenue-core.ts \
        src/lib/whatsapp-instance-revenue-core.test.ts
git commit -m "feat(dois-planos): componente contratual de automacao como origem de receita"
```

---

## Task 10: Worker de ciclos passa o componente

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-instance-worker-core.ts`
- Test: `src/lib/whatsapp-instance-worker-core.test.ts`

- [ ] **Step 1: Localizar o ponto de chamada**

Run: `grep -n "attributeRevenue\|subscriptionAmountCents" supabase/functions/_shared/whatsapp-instance-worker-core.ts`

- [ ] **Step 2: Repassar `planWhatsappComponentCents` e tratar a união**

A busca da assinatura usa **o resolvedor da Task 5** — não uma terceira query com regra própria.

O tratamento de `INVALID_INPUT` é obrigatório e explícito:

```ts
  const attribution = attributeRevenue({ /* ...fatos... */ });
  if (attribution.kind !== "ATTRIBUTED") {
    // Fatos inconsistentes: NAO gravar economia do ciclo com classificacao
    // falsa. Item marcado para revisao, nunca "receita desconhecida".
    jsonLog("warn", {
      evt: "wa_revenue_invalid_input",
      reason: attribution.reasonCode,
      instanceId,           // identificadores, nunca payload bruto
      organizationId,
    });
    // conta como sub-passo NAO executado, no padrao do wa_econ_imbalance_skipped
    return { ...summary, invalidInput: summary.invalidInput + 1 };
  }
  // A partir daqui, attribution.customerRevenueCents / .revenueSource sao seguros.
```

`attribution.kind !== "ATTRIBUTED"` com early-return — os dois modos de `strict` estreitam assim.

- [ ] **Step 2b: Teste — `INVALID_INPUT` não é persistido**

```ts
it("INVALID_INPUT nao grava economia do ciclo", () => {
  // worker-core injetavel: o fake de escrita nao pode receber nenhuma chamada
  // de atribuicao quando a contagem de instancias ativas e zero.
  expect(escritas).toHaveLength(0);
  expect(resumo.invalidInput).toBe(1);
});
```

- [ ] **Step 3: Rodar as suítes ligadas**

Run: `npm run test -- src/lib/whatsapp-instance-worker-core.test.ts src/lib/whatsapp-instance-alerts-dispatcher.test.ts`
Expected: PASS. Em particular, o `continue` do `LIFETIME_OVERRIDE` fica onde está — o cliente cortesia continua sem alerta econômico. Nenhum `event_type` novo entra nesta task.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/whatsapp-instance-worker-core.ts \
        src/lib/whatsapp-instance-worker-core.test.ts
git commit -m "feat(dois-planos): worker de ciclos atribui o componente de automacao"
```

---

## Task 11: Núcleo de allowance de conexões

**Files:**
- Create: `supabase/functions/_shared/whatsapp-connection-allowance-core.ts`
- Test: `src/lib/whatsapp-connection-allowance-core.test.ts`

> **Ponto de reprovação da v1.** `checkConnectionAllowance({includedConnections, activeInstanceCount})` bloquearia legados, o Ren Sushi e todo backfill, porque a 094 dá `default 0` a **todas** as linhas existentes.

- [ ] **Step 1: Escrever os testes que falham**

```ts
const P2 = { fundingSource: "PLAN_INCLUDED" as const, includedConnections: 1 };
const P1 = { fundingSource: "PLAN_INCLUDED" as const, includedConnections: 0 };

it("teste 30 — Plano 2 bloqueia a SEGUNDA conexao", () => {
  const r = checkConnectionAllowance({ ...P2, operation: "NEW_PROVISIONING",
    activeInstanceCount: 1, provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(false);
  expect(r.reasonCode).toBe("CONNECTION_LIMIT_REACHED");
});

it("Plano 2 permite a PRIMEIRA", () => {
  const r = checkConnectionAllowance({ ...P2, operation: "NEW_PROVISIONING",
    activeInstanceCount: 0, provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(true);
});

it("Plano 1 nao tem conexao nenhuma", () => {
  const r = checkConnectionAllowance({ ...P1, operation: "NEW_PROVISIONING",
    activeInstanceCount: 0, provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(false);
  expect(r.reasonCode).toBe("CONNECTION_LIMIT_REACHED");
});

it("CANCELLATION_REQUESTED continua contando — ainda custa", () => {
  // O caller conta lifecycle_state <> 'ENDED'. Este teste trava a semantica.
  const r = checkConnectionAllowance({ ...P2, operation: "NEW_PROVISIONING",
    activeInstanceCount: 1, provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(false);
});

it("LEGADO nao vira allowance zero so porque a coluna nova tem default 0", () => {
  const r = checkConnectionAllowance({ fundingSource: "LEGACY_CATEGORY", includedConnections: 0,
    operation: "NEW_PROVISIONING", activeInstanceCount: 1,
    provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(true);
  expect(r.policy).toBe("LEGACY_HISTORICAL");
});

it("Ren Sushi LIFETIME: backfill da instancia existente e preservado", () => {
  const r = checkConnectionAllowance({ fundingSource: "LIFETIME_OVERRIDE", includedConnections: null,
    operation: "BACKFILL_EXISTING", activeInstanceCount: 0,
    provisioningAmbiguous: false, providerInstanceRefKnown: true });
  expect(r.allowed).toBe(true);
});

it("Ren Sushi LIFETIME: provisionamento NOVO exige decisao administrativa", () => {
  const r = checkConnectionAllowance({ fundingSource: "LIFETIME_OVERRIDE", includedConnections: null,
    operation: "NEW_PROVISIONING", activeInstanceCount: 1,
    provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(false);
  expect(r.reasonCode).toBe("OVERRIDE_REQUIRES_ADMIN_DECISION");
});

it("BACKFILL legitimo de instancia que ja existe no provider passa", () => {
  const r = checkConnectionAllowance({ ...P2, operation: "BACKFILL_EXISTING",
    activeInstanceCount: 0, provisioningAmbiguous: false, providerInstanceRefKnown: true });
  expect(r.allowed).toBe(true);
});

it("BACKFILL DISFARCADO (sem referencia do provider) e rejeitado", () => {
  // Registrar "backfill" sem instancia real no provider e criar conexao nova
  // por outra porta.
  const r = checkConnectionAllowance({ ...P2, operation: "BACKFILL_EXISTING",
    activeInstanceCount: 1, provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(false);
  expect(r.reasonCode).toBe("BACKFILL_WITHOUT_PROVIDER_REF");
});

it("transicao ambigua bloqueia provisionamento NOVO", () => {
  const r = checkConnectionAllowance({ ...P2, operation: "NEW_PROVISIONING",
    activeInstanceCount: 0, provisioningAmbiguous: true, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(false);
  expect(r.reasonCode).toBe("SUBSCRIPTION_AMBIGUOUS");
});

it("transicao ambigua NAO impede registrar o que ja existe e ja custa", () => {
  const r = checkConnectionAllowance({ ...P2, operation: "BACKFILL_EXISTING",
    activeInstanceCount: 0, provisioningAmbiguous: true, providerInstanceRefKnown: true });
  expect(r.allowed).toBe(true);
});

it("sem fonte de financiamento, nada e autorizado", () => {
  const r = checkConnectionAllowance({ fundingSource: "NONE", includedConnections: null,
    operation: "BACKFILL_EXISTING", activeInstanceCount: 0,
    provisioningAmbiguous: false, providerInstanceRefKnown: true });
  expect(r.allowed).toBe(false);
  expect(r.reasonCode).toBe("NO_FUNDING_SOURCE");
});

it("limite desconhecido no plano novo e fail-closed", () => {
  const r = checkConnectionAllowance({ fundingSource: "PLAN_INCLUDED", includedConnections: null,
    operation: "NEW_PROVISIONING", activeInstanceCount: 0,
    provisioningAmbiguous: false, providerInstanceRefKnown: false });
  expect(r.allowed).toBe(false);
  expect(r.reasonCode).toBe("ALLOWANCE_UNKNOWN");
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run test -- src/lib/whatsapp-connection-allowance-core.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
/**
 * Nucleo PURO: esta organizacao pode registrar mais uma conexao de WhatsApp?
 * ZERO IMPORTS.
 *
 * "Instancia que ainda gera custo" = lifecycle_state <> 'ENDED'. Instancia em
 * CANCELLATION_REQUESTED CONTA: ela custa ate a confirmacao de encerramento.
 *
 * A COLUNA `included_whatsapp_connections` NAO E A UNICA FONTE DA DECISAO. A
 * migration 094 da `default 0` a TODAS as linhas existentes; aplicar esse zero
 * a contrato legado ou a override vitalicio bloquearia exatamente quem nunca
 * deveria ser bloqueado. A origem do financiamento decide qual politica vale.
 *
 * Fail-CLOSED por decisao: provisionamento libera custo externo novo. A
 * polaridade oposta (fail-open) e exclusiva do ENVIO existente.
 */

export type ConnectionFundingSource =
  | "PLAN_INCLUDED"     // plano novo declara whatsapp -> usa a coluna
  | "LEGACY_CATEGORY"   // WHATSAPP_SUBSCRIPTION -> politica historica
  | "TRANSITION"        // as duas coexistem
  | "LIFETIME_OVERRIDE" // cortesia vitalicia, sem assinatura
  | "NONE";

export type ConnectionOperation = "BACKFILL_EXISTING" | "NEW_PROVISIONING";

export interface ConnectionAllowanceInput {
  fundingSource: ConnectionFundingSource;
  /** billing_plans.included_whatsapp_connections; null = ausente/ilegivel */
  includedConnections: number | null;
  operation: ConnectionOperation;
  /** instancias com lifecycle_state <> 'ENDED' */
  activeInstanceCount: number;
  /** resolucao da assinatura em transicao ou duplicidade */
  provisioningAmbiguous: boolean;
  /** o provider_instance_ref informado corresponde a instancia REAL ja criada */
  providerInstanceRefKnown: boolean;
}

export type ConnectionAllowancePolicy =
  | "PLAN_DECLARED" | "LEGACY_HISTORICAL" | "OVERRIDE_OPERATIONAL" | "DENIED";

export type ConnectionAllowance =
  | { allowed: true; policy: ConnectionAllowancePolicy }
  | {
      allowed: false;
      policy: "DENIED";
      reasonCode:
        | "CONNECTION_LIMIT_REACHED"
        | "ALLOWANCE_UNKNOWN"
        | "SUBSCRIPTION_AMBIGUOUS"
        | "BACKFILL_WITHOUT_PROVIDER_REF"
        | "OVERRIDE_REQUIRES_ADMIN_DECISION"
        | "NO_FUNDING_SOURCE";
    };

const deny = (reasonCode: Extract<ConnectionAllowance, { allowed: false }>["reasonCode"]) =>
  ({ allowed: false as const, policy: "DENIED" as const, reasonCode });

export function checkConnectionAllowance(input: ConnectionAllowanceInput): ConnectionAllowance {
  // 1. Backfill precisa ser backfill DE VERDADE. Sem referencia da instancia
  //    real no provider, "backfill" e provisionamento novo por outra porta.
  if (input.operation === "BACKFILL_EXISTING" && !input.providerInstanceRefKnown) {
    return deny("BACKFILL_WITHOUT_PROVIDER_REF");
  }

  // 2. Sem fonte de financiamento nao ha o que autorizar.
  if (input.fundingSource === "NONE") return deny("NO_FUNDING_SOURCE");

  // 3. Ambiguidade bloqueia CUSTO NOVO — nao o registro do que ja existe e ja
  //    esta sendo cobrado. Registrar a realidade nunca piora a posicao.
  if (input.operation === "NEW_PROVISIONING" && input.provisioningAmbiguous) {
    return deny("SUBSCRIPTION_AMBIGUOUS");
  }

  // 4. Cortesia vitalicia: nao tem assinatura, entao nao tem coluna. Preserva
  //    a operacao existente e o backfill dela; custo NOVO exige decisao
  //    administrativa explicita, nunca autorizacao implicita por ausencia.
  if (input.fundingSource === "LIFETIME_OVERRIDE") {
    if (input.operation === "BACKFILL_EXISTING") {
      return { allowed: true, policy: "OVERRIDE_OPERATIONAL" };
    }
    return deny("OVERRIDE_REQUIRES_ADMIN_DECISION");
  }

  // 5. Contrato legado segue a politica historica. O `default 0` da 094 e
  //    artefato de migration, nao decisao comercial sobre quem ja era cliente.
  if (input.fundingSource === "LEGACY_CATEGORY" || input.fundingSource === "TRANSITION") {
    return { allowed: true, policy: "LEGACY_HISTORICAL" };
  }

  // 6. Plano novo: a coluna decide.
  if (input.includedConnections === null || input.includedConnections === undefined) {
    return deny("ALLOWANCE_UNKNOWN");
  }
  // Backfill tambem respeita o teto: registrar duas instancias reais num plano
  // de uma conexao e um problema comercial que precisa aparecer, nao ser aceito.
  if (input.activeInstanceCount >= input.includedConnections) {
    return deny("CONNECTION_LIMIT_REACHED");
  }
  return { allowed: true, policy: "PLAN_DECLARED" };
}
```

- [ ] **Step 4: Rodar e commitar**

Run: `npm run test -- src/lib/whatsapp-connection-allowance-core.test.ts`
Expected: PASS (13 testes).

```bash
git add supabase/functions/_shared/whatsapp-connection-allowance-core.ts \
        src/lib/whatsapp-connection-allowance-core.test.ts
git commit -m "feat(dois-planos): allowance de conexao por origem de financiamento e operacao"
```

---

## Task 12: Aplicar o allowance nos dois pontos

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts` (`register_instance`)
- Modify: `supabase/functions/manage-channels/index.ts` (provisionamento)

- [ ] **Step 1: `register_instance`**

Antes de qualquer insert:
1. contar instâncias da organização com `lifecycle_state <> 'ENDED'`;
2. resolver a fonte de financiamento com `resolveWhatsAppSubscription` (mais override vitalício, quando não houver assinatura);
3. ler `included_whatsapp_connections` do plano quando a fonte for `PLAN_INCLUDED`;
4. `operation: "BACKFILL_EXISTING"` — toda instância nasce na Z-API e depois é registrada (decisão da 6c);
5. `providerInstanceRefKnown` vem da validação de `provider_instance_ref` já existente (`validateProviderInstanceRef`);
6. negar com **409** e mensagem curta em PT-BR, com `reasonCode` no corpo.

`assertProvisioningAllowed` continua valendo: `NEW_PROVISION` segue bloqueado até a Fase 6a. As duas guardas coexistem — uma responde "o modelo comercial permite?", a outra "a plataforma sabe provisionar?".

- [ ] **Step 2: `manage-channels`**

Mesma verificação no caminho de provisionamento, compondo com `resolveProvisioningEligibility` já existente.

> **Verificar só um deixa a outra porta aberta.** O inventário é onde o custo entra; o canal é onde o envio se habilita.

- [ ] **Step 3: Verificar**

Run: `npm run typecheck && npx eslint supabase/functions --max-warnings=0`
Expected: zero erros, zero warnings.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts \
        supabase/functions/manage-channels/index.ts
git commit -m "feat(dois-planos): allowance de conexao aplicado no inventario e no canal"
```

---

## Task 13: Suíte completa, pendências e gates

**Files:**
- Create: `docs/billing-asaas/FASE-DOIS-PLANOS-PENDENCIAS.md`

- [ ] **Step 1: Rodar tudo**

Run: `npm run test`
Expected: PASS, sem quebrar nenhuma suíte anterior.

Run: `npm run typecheck`
Expected: zero erros (baseline).

Run: `npm run lint`
Expected: sem regressão.

- [ ] **Step 2: Escrever o registro de pendências**

```markdown
# Pendências do Plano A — não declaráveis por teste unitário

Ambiente sem Docker. Nenhuma migration aplicada, nenhuma EF deployada,
nenhuma flag alterada.

## Limite de conexões — STATICALLY_GUARDED / DATABASE_CONCURRENCY_PENDING

O núcleo `whatsapp-connection-allowance-core.ts` decide corretamente sobre
fatos corretos, e os dois pontos de entrada o chamam. **Isso é guarda
estática.** Duas chamadas concorrentes que leiam a mesma contagem de
instâncias ativas ainda podem criar duas conexões.

**Enquanto não houver prova contra banco real de que duas operações
concorrentes não criam duas instâncias:**

- não declarar o limite financeiramente seguro;
- não habilitar o Plano Automação para novas contratações;
- não permitir que o Plano B transforme o produto em oferta ativa;
- manter o checkout/ativação do Plano 2 bloqueado.

Invariante a satisfazer: **a autorização e a criação da instância precisam ser
serializadas contra o mesmo allowance.** Mecanismo em aberto — RPC
transacional, lock de linha, advisory lock ou constraint compatível.

**Não criar índice único que hardcode uma conexão por organização:** o modelo
de dados precisa suportar limites maiores (plano CUSTOM).

## Depende de banco real
- Migrations 094 e 095 nunca aplicadas; idempotência e o `drop/add` do CHECK
  verificados só por leitura.
- CHECK `included_features` (vocabulário fechado + `array_position` contra NULL
  no array) nunca exercitado contra INSERT real — **teste 2 da spec**.
- Duplicidade de valores dentro de `included_features` não é proibida pelo
  banco; a normalização é do seed e do fluxo administrativo (Plano B).

## Depende de deploy
- Gate e enforcement compartilham o resolvedor **no código**; que rodem com a
  mesma versão em memória depende do redeploy das 18 consumidoras de
  `whatsapp-service-gate.ts`.

## Mudanças deliberadas de comportamento (não são regressão)
- Plano com `included_features` não vazio **não** herda IA de `system`.
- Trial **não** concede IA.
Ambas seguras hoje: `entitlements_enforced` OFF e sem carteira.

## Fora do escopo deste plano
- Seeds e catálogo (Plano B). Fluxos comerciais (Plano C). IA (Plano D).

## Gate comercial
`PLAN_AUTOMACAO_CHECKOUT = NO-GO` até Plano D entregue e provado contra banco
real, incluindo a concorrência do orçamento e a deste documento.
```

- [ ] **Step 3: Commit**

```bash
git add docs/billing-asaas/FASE-DOIS-PLANOS-PENDENCIAS.md
git commit -m "docs(dois-planos): pendencias, gates e limites do Plano A"
```

---

## Ordem de aplicação (quando autorizada — fora deste plano)

1. `supabase db push` — 094 e 095, **antes** de qualquer deploy.
2. Deploy das EFs que leem `included_features` via `entitlements.ts`.
3. Deploy das **dezoito** consumidoras de `whatsapp-service-gate.ts` + `process-whatsapp-enforcement` + `manage-whatsapp-instances` + `manage-channels`.
4. Deploy de `process-whatsapp-instance-cycles`.
5. Conferir `acl-estatico` na aba Checks.

Flags permanecem OFF. Nenhum plano publicado.

---

## Auto-revisão

**Os 11 pontos de reprovação, e onde foram atendidos:**

| # | Ponto | Task |
|---|---|---|
| 1 | Plano 1 e trial sem IA; declaração explícita vence herança | 3 |
| 2 | `PLAN_INCLUDED` estrito a `SYSTEM_SUBSCRIPTION` | 5 |
| 3 | Precedência `active > trialing > past_due`, empate → modelo novo | 5 |
| 4 | `provisioningAmbiguous` propagado, separado de `dataReadFailed` | 6, 7 |
| 5 | Guardrail estático do acoplamento; `candidateIds` canônico no núcleo | 5, 8 |
| 6 | Allowance por origem de financiamento e operação | 11, 12 |
| 7 | `STATICALLY_GUARDED` / `DATABASE_CONCURRENCY_PENDING` como gate | 13 |
| 8 | `PLAN_AUTOMACAO_CHECKOUT = NO-GO` até Plano D | decomposição, 13 |
| 9 | `PLAN_COMPONENT` é automação, não receita pura; `count = 0` → **`INVALID_INPUT`** (união discriminada, nunca `NO_ENTITLEMENT`) | 2, 9, 10 |
| 10 | `conrelid` + `array_position(..., null)` | 1 |
| 11 | resumo devolvido | resposta |

**Testes nomeados da spec cobertos:** 1, 3, 4, 5, 6, 7, 8, 23, 24, 25, 26, 27, 30. O **teste 2** é CHECK de banco e está registrado como pendência — um unitário que "verifica" um CHECK que não roda seria falso verde.

**Consistência de tipos:** `includedFeatures?: string[]` (T3) → preenchido em T4. `WhatsAppSubscriptionFact.includedFeatures: string[]` (T5) → preenchido em T7 com `?? []`. `subscriptionAmbiguous` (T6) → produzido em T7, consumido em T11 via `provisioningAmbiguous`. `planWhatsappComponentCents` (T9) → preenchido em T10. `ConnectionFundingSource` (T11) → derivado de `WhatsAppSubscriptionSource` (T5) mais `LIFETIME_OVERRIDE`/`NONE` em T12.

**Sem placeholders:** todo passo de código traz o código; todo passo de execução traz comando e resultado esperado.
