# Plano D — Parte 3 (Tasks 7 a 9: entitlement, templates, autorizador)

> Continuação de `2026-08-03-plano-d-franquia-ia.md`. **As Global Constraints daquele arquivo valem integralmente aqui.**

---

## Task 7: Ramo de franquia no entitlement

**Files:**
- Modify: `supabase/functions/_shared/entitlements-core.ts` (só o bloco de resolução da IA, linhas ~194-225)
- Modify: `supabase/functions/_shared/entitlements.ts` (parâmetro novo, opcional)
- Test: `src/lib/entitlements-core.test.ts` (estender)

**Interfaces:**
- Consumes: nada de tarefas anteriores (o núcleo é independente).
- Produces: `EntitlementSource` ganha `"franchise"`; `EntitlementInputs` ganha `aiFranchise?: AiFranchiseInput`; `FeatureEntitlement` ganha `budgetRemainingCents?: number`; `resolveOrgEntitlements(supabase, orgId, aiWalletBalanceCents?, aiFranchise?)`.

**⚠️ ARQUIVO MAIS DELICADO DO PLANO A.** A ordem dos ramos de resolução da IA é **load-bearing** e está comentada no código. O ramo de franquia entra **ENTRE** override e carteira, **sem mover os outros**. Concretamente: os ramos 1 (override/admin_block), 3 (`hasExplicitPlan` → `not_included`), 4 (`trial_no_ai`), 5 (herança pré-carteira) e 6 (carteira) **não mudam de posição nem de condição**. O que muda é **só** o ramo 2 (`aiDirect.source === "subscription"`), que hoje devolve a entitlement de assinatura crua e passa a devolver a variante de franquia.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar a `src/lib/entitlements-core.test.ts`:

```ts
describe("Plano D — franquia de IA", () => {
  const plano2 = {
    status: "active",
    category: "SYSTEM_SUBSCRIPTION",
    current_period_end: "2026-09-04T00:00:00Z",
    includedFeatures: ["system", "whatsapp", "ai"],
  };
  const plano1 = {
    status: "active",
    category: "SYSTEM_SUBSCRIPTION",
    current_period_end: "2026-09-04T00:00:00Z",
    includedFeatures: ["system"],
  };

  it("Plano 2 sem orçamento carregado: concede IA por franquia, sem afirmar saldo", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("franchise");
    expect(e.ai.status).toBe("within_budget");
    expect(e.ai.budgetRemainingCents).toBeUndefined();
  });

  it("Plano 2 com orçamento aberto: concede e informa o restante", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "OPEN", remainingCents: 3500 },
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("franchise");
    expect(e.ai.status).toBe("within_budget");
    expect(e.ai.budgetRemainingCents).toBe(3500);
  });

  it("Plano 2 com franquia esgotada: NEGA a IA sem tocar system nem whatsapp", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.source).toBe("franchise");
    expect(e.ai.status).toBe("budget_exhausted");
    expect(e.ai.budgetRemainingCents).toBe(0);
    // O hard stop NÃO desliga o canal nem bloqueia o sistema (§18.3).
    expect(e.system.allowed).toBe(true);
    expect(e.whatsapp.allowed).toBe(true);
  });

  it("franquia esgotada com restante positivo ainda é esgotada — o estado manda", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 12 },
    });
    expect(e.ai.allowed).toBe(false);
  });

  it("balanceCents NÃO é reusado — franquia não é crédito do cliente", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "OPEN", remainingCents: 3500 },
    });
    expect(e.ai.balanceCents).toBeUndefined();
  });

  it("Plano 1 continua negando IA por não declarar — franquia não muda isso", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano1],
      aiFranchise: { state: "OPEN", remainingCents: 10000 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.status).toBe("not_included");
    expect(e.ai.source).not.toBe("franchise");
  });

  it("REN SUSHI: override LIFETIME vence a franquia esgotada — prioridade 2 intacta", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [
        { feature: "ai", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
      ],
      subscriptions: [plano2],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("override");
    expect(e.ai.status).toBe("LIFETIME");
  });

  it("REN SUSHI sem assinatura nenhuma continua fora de todo caminho do Plano D", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [
        { feature: "system", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
        { feature: "whatsapp", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
        { feature: "ai", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
      ],
      subscriptions: [],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("override");
  });

  it("bloqueio administrativo de ai vence a franquia disponível", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [
        { feature: "ai", enabled: false, grant_type: "MANUAL_OVERRIDE", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
      ],
      subscriptions: [plano2],
      aiFranchise: { state: "OPEN", remainingCents: 10000 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.source).toBe("admin_block");
  });

  it("plano LEGADO (included_features vazio) não entra na franquia, mesmo com orçamento", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [{ status: "active", category: "SYSTEM_SUBSCRIPTION", current_period_end: null }],
      aiWalletBalanceCents: undefined,
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    // Herança pré-carteira, byte a byte como antes.
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe(e.system.source);
  });

  it("carteira legada continua no ramo de carteira quando o plano não declara ai", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [{ status: "active", category: "SYSTEM_SUBSCRIPTION", current_period_end: null }],
      aiWalletBalanceCents: 500,
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.source).toBe("wallet");
    expect(e.ai.balanceCents).toBe(500);
  });

  it("trial continua sem IA — o ramo de franquia não o reintroduz", () => {
    const e = resolveEntitlements({
      billingStatus: "trialing",
      trialEndsAt: "2099-01-01T00:00:00Z",
      overrides: [],
      subscriptions: [],
      aiFranchise: { state: "OPEN", remainingCents: 10000 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.status).toBe("trial_no_ai");
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/entitlements-core.test.ts`
Expected: FAIL — os casos novos falham (`source` é `"subscription"`, `aiFranchise` não existe). **Os casos ANTIGOS devem continuar passando**; se algum antigo quebrar antes de qualquer edição, pare e reporte.

- [ ] **Step 3: Editar `entitlements-core.ts` — o tipo**

Em `supabase/functions/_shared/entitlements-core.ts`, na união `EntitlementSource` (linha ~33), acrescentar `"franchise"`:

```ts
export type EntitlementSource =
  | "admin_block"
  | "override"
  | "subscription"
  /** Franquia de IA inclusa no plano (Plano D). NÃO é crédito do cliente. */
  | "franchise"
  | "trial"
  | "wallet"
  | "legacy"
  | "none";
```

Depois de `EntitlementSubscriptionInput` (linha ~68), acrescentar:

```ts
/**
 * Estado do orçamento de franquia do ciclo corrente (Plano D, spec §17.3).
 *
 * OPCIONAL de propósito: o caller que só quer saber "esta organização tem IA?"
 * (catálogo, painel administrativo) não paga uma leitura de orçamento, e o
 * resultado continua `allowed: true`. Só quem vai efetivamente gastar carrega
 * o estado.
 */
export interface AiFranchiseInput {
  state: "OPEN" | "EXHAUSTED" | "CLOSED";
  /** limit − settled − comprometido. NUNCA vai ao frontend do lojista (§18.4). */
  remainingCents: number;
}
```

Em `EntitlementInputs` (linha ~70-81), acrescentar o campo:

```ts
  /** Ver doc do módulo: undefined = pré-carteira (ai herda system). */
  aiWalletBalanceCents?: number | null;
  /** Plano D: orçamento do ciclo. Ausente = não consultado, não "esgotado". */
  aiFranchise?: AiFranchiseInput;
```

Em `FeatureEntitlement` (linha ~83-91), acrescentar:

```ts
  /** Só ai com carteira implantada. */
  balanceCents?: number;
  /**
   * Só ai por franquia. Campo PRÓPRIO — `balanceCents` significa "crédito do
   * cliente", e franquia não é crédito do cliente. NUNCA vai ao frontend do
   * lojista: caminho de resposta separado, não filtragem pós-montagem (§18.4).
   */
  budgetRemainingCents?: number;
```

- [ ] **Step 4: Editar `entitlements-core.ts` — só o ramo 2**

Substituir **exatamente** o bloco de linhas ~204-206 (`} else if (aiDirect.source === "subscription") { ... }`) por:

```ts
  } else if (aiDirect.source === "subscription") {
    // 2. Declarada pelo plano (included_features) → FRANQUIA financiada pela
    //    plataforma. O cliente não compra nada e o teto é interno.
    //
    //    `aiFranchise` AUSENTE não é "esgotada": é "não consultada". Negar aqui
    //    faria todo caller que só lista entitlements (catálogo, painel) reportar
    //    IA bloqueada para quem tem franquia cheia.
    const franchise = inputs.aiFranchise;
    const exhausted = franchise ? franchise.state === "EXHAUSTED" : false;
    ai = {
      allowed: !exhausted,
      source: "franchise",
      status: exhausted ? "budget_exhausted" : "within_budget",
      expiresAt: aiDirect.expiresAt,
      // `balanceCents` NÃO é reusado: significa crédito do cliente.
      ...(franchise ? { budgetRemainingCents: franchise.remainingCents } : {}),
    };
```

Atualizar o comentário-bloco acima (linhas ~194-199) para refletir o degrau novo, **sem mexer na ordem**:

```ts
  // IA: override próprio primeiro; depois declaração do plano (FRANQUIA);
  // depois carteira (ou herança pré-carteira).
  //
  // A ORDEM DOS RAMOS É LOAD-BEARING: mover o ramo 3 (negação explícita) para
  // depois do ramo 5 (herança) reintroduz a herança e dá IA ao Plano 1; mover o
  // ramo 4 para depois do 5 devolve IA ao trial; mover o ramo 2 (franquia) para
  // depois do 3 faria o Plano 2 cair em `not_included`.
```

Atualizar o cabeçalho do módulo (linhas ~18-28), acrescentando ao bloco "IA (pré vs pós carteira)":

```
 *   - Plano que declara `ai` resolve por FRANQUIA (`source: "franchise"`), com
 *     `status: within_budget | budget_exhausted`. Franquia é teto financeiro
 *     interno da plataforma — nunca crédito comprado pelo cliente, e por isso
 *     `budgetRemainingCents` é campo próprio, não `balanceCents`.
```

- [ ] **Step 5: Editar `entitlements.ts` — passar o estado adiante**

Em `supabase/functions/_shared/entitlements.ts`, alterar a assinatura e a chamada:

```ts
import {
  resolveEntitlements,
  type AiFranchiseInput,
  type EntitlementOverrideInput,
  type EntitlementSubscriptionInput,
  type OrgEntitlements,
} from "./entitlements-core.ts";

export type { OrgEntitlements, AiFranchiseInput };

/**
 * @param aiWalletBalanceCents carteira LEGADA. Omitir para organizações no
 *   modelo de dois planos.
 * @param aiFranchise Plano D: estado do orçamento do ciclo. Omitir quando o
 *   caller só precisa saber SE há IA (catálogo, painel) — ausente significa
 *   "não consultado", nunca "esgotado". O caller que vai gastar (webhook) lê o
 *   orçamento via ai-budget-gate.ts e injeta aqui, mantendo o núcleo puro.
 */
export async function resolveOrgEntitlements(
  supabase: SupabaseClient,
  organizationId: string,
  aiWalletBalanceCents?: number | null,
  aiFranchise?: AiFranchiseInput,
): Promise<OrgEntitlementsResult> {
```

E no `return`, acrescentar o campo ao objeto passado a `resolveEntitlements`:

```ts
      aiWalletBalanceCents,
      aiFranchise,
```

- [ ] **Step 6: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/entitlements-core.test.ts`
Expected: PASS — inclusive **todos** os casos pré-existentes do Plano A.

- [ ] **Step 7: Rodar a suíte inteira e commitar**

```bash
npm run test
npm run typecheck
npx eslint supabase/functions/_shared/entitlements-core.ts supabase/functions/_shared/entitlements.ts --max-warnings=0
git add supabase/functions/_shared/entitlements-core.ts supabase/functions/_shared/entitlements.ts src/lib/entitlements-core.test.ts
git commit -m "feat(plano-d): ramo de franquia de IA entre override e carteira, sem mover os demais"
```

---

## Task 8: Templates dos quatro marcos no dispatcher

**Files:**
- Modify: `supabase/functions/process-billing-notifications/index.ts`
- Test: `src/lib/ai-budget-dispatcher.test.ts` (novo)

**Interfaces:**
- Consumes: `CANONICAL_AI_BUDGET_EVENT_TYPES` de `ai-budget-milestones-core.ts` (Task 3).
- Produces: quatro entradas em `TEMPLATE_BY_EVENT`; `TemplateData` ganha o bloco opcional `aiBudget`.

**Contexto obrigatório para o implementador:**

- **SEXTA ocorrência do acoplamento por string.** As duas Edge Functions não compartilham nenhum `_shared/` para esse acoplamento — é só o `event_type`. Sem a entrada aqui, a linha enfileirada morre em `failed/unknown_event_type` exatamente quando importa.
- **`process-billing-notifications` é deployado ANTES de qualquer produtor** (§21). É por isso que esta tarefa vem antes das tarefas 11-12.
- Estes avisos são **internos** (platform_admin) e **não têm fatura**: `d.amountBrl` chega zerado e `paymentUrl` é `null` — não referenciar nenhum dos dois, como já fazem `whatsapp_suspended` e os seis `admin_zapi_*`.
- **Nada aqui vai ao lojista.** O conteúdo é o de §18.2: organização, ciclo, custo liquidado, custo reservado, modelo(s), data de renovação, ação esperada.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/ai-budget-dispatcher.test.ts`:

```ts
/**
 * Guardrail do ACOPLAMENTO POR STRING entre o produtor dos marcos da franquia
 * (Plano D) e o dispatcher `process-billing-notifications`.
 *
 * SEXTA ocorrência do padrão. Cobre as DUAS direções, no molde de
 * whatsapp-instance-alerts-dispatcher.test.ts:
 *   1. evento canônico sem template no dispatcher;
 *   2. produtor emitindo string fora da lista canônica.
 *
 * A fonte canônica é EVENT_TYPE_BY_MILESTONE_PERCENT — a lista NÃO é redigitada.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENT_TYPE_BY_MILESTONE_PERCENT,
  CANONICAL_AI_BUDGET_EVENT_TYPES,
} from "../../supabase/functions/_shared/ai-budget-milestones-core";

const FUNCTIONS = join(__dirname, "..", "..", "supabase", "functions");
const DISPATCHER = join(FUNCTIONS, "process-billing-notifications", "index.ts");
const CORE = join(FUNCTIONS, "_shared", "ai-budget-milestones-core.ts");
const GATE = join(FUNCTIONS, "_shared", "ai-budget-gate.ts");
const WEBHOOK = join(FUNCTIONS, "webhook-whatsapp", "index.ts");

const dispatcherSource = readFileSync(DISPATCHER, "utf8");
const coreSource = readFileSync(CORE, "utf8");

describe("acoplamento dos marcos com process-billing-notifications", () => {
  it("todo event_type canônico tem entrada em TEMPLATE_BY_EVENT", () => {
    const missing = CANONICAL_AI_BUDGET_EVENT_TYPES.filter((e) => !dispatcherSource.includes(`${e}: (d)`));
    expect(
      missing,
      `Sem entrada em TEMPLATE_BY_EVENT: ${missing.join(", ")}. A linha enfileirada morreria em failed/unknown_event_type.`,
    ).toEqual([]);
  });

  it("nenhum produtor emite event_type fora da lista canônica", () => {
    const found = new Set<string>();
    for (const path of [CORE, GATE, WEBHOOK]) {
      let src = "";
      try {
        src = readFileSync(path, "utf8");
      } catch {
        // Arquivo ainda não existe (tarefas 11/12). O teste volta a cobri-lo
        // assim que existir — e é por isso que ele não pode ser silenciado.
        continue;
      }
      for (const m of src.matchAll(/admin_ai_budget_[a-z0-9_]+/g)) found.add(m[0]);
    }
    const foreign = [...found].filter((e) => CANONICAL_AI_BUDGET_EVENT_TYPES.indexOf(e) === -1);
    expect(foreign, `event_type fora da lista canônica: ${foreign.join(", ")}`).toEqual([]);
  });

  it("os quatro marcos mapeiam para os quatro event_type", () => {
    expect(Object.keys(EVENT_TYPE_BY_MILESTONE_PERCENT)).toHaveLength(4);
    expect(CANONICAL_AI_BUDGET_EVENT_TYPES).toHaveLength(4);
  });

  it("os templates carregam o conteúdo obrigatório do alerta interno", () => {
    // §18.2: organização, ciclo, custo liquidado, custo reservado, modelo,
    // data da renovação, ação esperada.
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const i = dispatcherSource.indexOf(`${evt}: (d)`);
      const block = dispatcherSource.slice(i, i + 2000);
      expect(block, `${evt} sem orgName`).toContain("d.orgName");
      expect(block, `${evt} sem dados do ciclo`).toContain("d.aiBudget");
    }
  });

  it("os templates são INTERNOS — marcados como tal e sem link de pagamento", () => {
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const i = dispatcherSource.indexOf(`${evt}: (d)`);
      const block = dispatcherSource.slice(i, i + 2000);
      expect(block).toContain("[interno]");
      // Sem fatura por trás: amountBrl chega zerado e paymentUrl é null.
      expect(block).not.toContain("d.amountBrl");
      expect(block).not.toContain("payLine(");
    }
  });

  it("o marco de hard stop diz que o canal continua recebendo", () => {
    const i = dispatcherSource.indexOf("admin_ai_budget_stop: (d)");
    const block = dispatcherSource.slice(i, i + 2000);
    // §18.3: não desligar o canal, não bloquear o sistema.
    expect(block).toMatch(/continua|segue/i);
  });

  it("nenhum template de marco expõe chave, credencial ou payload de provedor", () => {
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const i = dispatcherSource.indexOf(`${evt}: (d)`);
      const block = dispatcherSource.slice(i, i + 2000);
      expect(block).not.toMatch(/apiKey|api_key|credentials|Bearer/i);
    }
  });

  it("o núcleo dos marcos não conhece o dispatcher — o acoplamento é só a string", () => {
    expect(coreSource).not.toContain("process-billing-notifications");
    expect(coreSource).not.toContain("TEMPLATE_BY_EVENT");
  });

  it("controle positivo: o detector encontra um event_type que sabidamente existe", () => {
    expect(dispatcherSource.includes("admin_zapi_divergence: (d)")).toBe(true);
    expect(dispatcherSource.includes("evento_que_nao_existe: (d)")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-dispatcher.test.ts`
Expected: FAIL — `Sem entrada em TEMPLATE_BY_EVENT: admin_ai_budget_70, ...`.

- [ ] **Step 3: Estender `TemplateData` e o carregamento no dispatcher**

Em `supabase/functions/process-billing-notifications/index.ts`, alterar o tipo (linha ~18):

```ts
/**
 * Bloco EXCLUSIVO dos marcos da franquia de IA (Plano D, §18.2). Ausente em
 * todos os outros event_type — os avisos de billing não têm ciclo de IA.
 *
 * Preenchido por `loadAiBudgetContext` apenas quando o event_type começa com
 * `admin_ai_budget_`, para não pagar três queries por e-mail de mensalidade.
 */
type AiBudgetTemplateData = {
  cycleStart: string;
  /** EXCLUSIVO: é a data em que a franquia RENOVA. */
  cycleEnd: string;
  settledBrl: string;
  reservedBrl: string;
  limitBrl: string;
  /** Modelos efetivamente usados no ciclo. Vazio = nenhum evento ainda. */
  models: string;
};

type TemplateData = {
  orgName: string;
  amountBrl: string;
  paymentUrl: string | null;
  /** Só nos quatro admin_ai_budget_*. */
  aiBudget?: AiBudgetTemplateData;
};
```

Acrescentar o carregador logo depois de `payLine` (linha ~35):

```ts
/**
 * Contexto do ciclo de franquia para os quatro `admin_ai_budget_*`.
 *
 * Best-effort: qualquer falha devolve `undefined` e o template cai no texto
 * mínimo. Um aviso incompleto ao admin é melhor que um aviso que não sai —
 * mesma postura de `resolvePlatformAdminRecipients`.
 *
 * Lê o ciclo mais recente da organização; o marco é sempre do ciclo corrente,
 * porque a linha é enfileirada no instante do cruzamento.
 */
async function loadAiBudgetContext(organizationId: string): Promise<AiBudgetTemplateData | undefined> {
  const { data: cycle, error } = await supabase
    .from("ai_cycle_budgets")
    .select("id, cycle_start, cycle_end, limit_cents, settled_cents")
    .eq("organization_id", organizationId)
    .order("cycle_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !cycle) return undefined;

  const [{ data: held }, { data: events }] = await Promise.all([
    supabase
      .from("ai_cost_reservations")
      .select("reserved_cents, consumed_cents")
      .eq("cycle_id", cycle.id)
      .eq("status", "HELD"),
    supabase
      .from("ai_usage_events")
      .select("model")
      .eq("cycle_id", cycle.id)
      .limit(200),
  ]);

  const reserved = (held ?? []).reduce(
    (sum: number, r: { reserved_cents: number; consumed_cents: number }) =>
      sum + Math.max(r.reserved_cents - r.consumed_cents, 0),
    0,
  );
  const models = [...new Set((events ?? []).map((e: { model: string }) => e.model))].sort();

  return {
    cycleStart: cycle.cycle_start,
    cycleEnd: cycle.cycle_end,
    settledBrl: formatBrl(cycle.settled_cents),
    reservedBrl: formatBrl(reserved),
    limitBrl: formatBrl(cycle.limit_cents),
    models: models.length > 0 ? models.join(", ") : "nenhum consumo registrado",
  };
}
```

- [ ] **Step 4: Acrescentar os quatro templates**

No fim de `TEMPLATE_BY_EVENT`, depois de `admin_zapi_economic_imbalance`:

```ts
  // ─────────────────────────────────────────────────────────────────────
  // Marcos da franquia de IA (Plano D, §18.2) — QUATRO entradas para os
  // quatro event_type de EVENT_TYPE_BY_MILESTONE_PERCENT em
  // _shared/ai-budget-milestones-core.ts, que é a FONTE CANÔNICA.
  //
  // AVISOS INTERNOS, ao platform_admin. Nada aqui vai ao lojista, e nada aqui
  // pode aparecer numa superfície do cliente: custo interno, limite e modelo
  // são exatamente o que §18.3 proíbe expor.
  //
  // Sem fatura por trás: `d.amountBrl` chega zerado e `paymentUrl` é null —
  // por isso nenhum dos dois é referenciado, mesma razão de `whatsapp_suspended`
  // e dos seis `admin_zapi_*`.
  //
  // `d.aiBudget` pode faltar (falha de leitura): todo template degrada para o
  // texto mínimo em vez de renderizar "undefined" para o admin.
  // ─────────────────────────────────────────────────────────────────────
  admin_ai_budget_70: (d) => ({
    subject: `[interno] Franquia de IA em 70% — ${d.orgName}`,
    text: aiBudgetText(d, "70%", "Nenhuma ação é necessária agora. Acompanhe a evolução no ciclo."),
    html: aiBudgetHtml(d, "Franquia de IA em 70%", "Nenhuma ação é necessária agora. Acompanhe a evolução no ciclo."),
  }),
  admin_ai_budget_80: (d) => ({
    subject: `[interno] Franquia de IA em 80% — ${d.orgName}`,
    text: aiBudgetText(d, "80%", "Avalie o volume de atendimento e o modelo configurado para esta organização."),
    html: aiBudgetHtml(d, "Franquia de IA em 80%", "Avalie o volume de atendimento e o modelo configurado para esta organização."),
  }),
  admin_ai_budget_90: (d) => ({
    subject: `[interno] Franquia de IA em 90% — ${d.orgName}`,
    text: aiBudgetText(
      d,
      "90%",
      "A franquia deve se esgotar antes da renovação. Decida agora se o teto desta organização será revisto.",
    ),
    html: aiBudgetHtml(
      d,
      "Franquia de IA em 90%",
      "A franquia deve se esgotar antes da renovação. Decida agora se o teto desta organização será revisto.",
    ),
  }),
  admin_ai_budget_stop: (d) => ({
    subject: `[interno] Franquia de IA esgotada — ${d.orgName}`,
    text: aiBudgetText(
      d,
      "100%",
      "O atendimento automático desta organização passou para a equipe. O WhatsApp continua recebendo mensagens e o sistema segue funcionando normalmente — nada foi desligado. A franquia volta sozinha na renovação.",
    ),
    html: aiBudgetHtml(
      d,
      "Franquia de IA esgotada",
      "O atendimento automático desta organização passou para a equipe. O WhatsApp <strong>continua</strong> recebendo mensagens e o sistema segue funcionando normalmente — nada foi desligado. A franquia volta sozinha na renovação.",
    ),
  }),
```

E os dois helpers, logo acima de `TEMPLATE_BY_EVENT`:

```ts
/**
 * Corpo comum dos quatro marcos: §18.2 exige organização, ciclo, custo
 * liquidado, custo reservado, modelo, data da renovação e ação esperada. A
 * única coisa que varia entre os quatro é o marco e a ação.
 */
function aiBudgetText(d: TemplateData, marco: string, acao: string): string {
  const b = d.aiBudget;
  if (!b) {
    return `A franquia de automação com IA de ${d.orgName} atingiu ${marco} do teto do ciclo. ${acao} Detalhes em Plataforma → Automação.`;
  }
  return [
    `A franquia de automação com IA de ${d.orgName} atingiu ${marco} do teto do ciclo.`,
    `Ciclo: ${b.cycleStart} até ${b.cycleEnd} (renova em ${b.cycleEnd}).`,
    `Custo liquidado: ${b.settledBrl} de ${b.limitBrl}. Reservado e ainda não liquidado: ${b.reservedBrl}.`,
    `Modelos usados no ciclo: ${b.models}.`,
    acao,
  ].join(" ");
}

function aiBudgetHtml(d: TemplateData, title: string, acao: string): string {
  const b = d.aiBudget;
  const linhas = [`Organização: <strong>${d.orgName}</strong>.`];
  if (b) {
    linhas.push(`Ciclo: <strong>${b.cycleStart}</strong> até <strong>${b.cycleEnd}</strong> — renova em <strong>${b.cycleEnd}</strong>.`);
    linhas.push(`Custo liquidado: <strong>${b.settledBrl}</strong> de <strong>${b.limitBrl}</strong>.`);
    linhas.push(`Reservado e ainda não liquidado: <strong>${b.reservedBrl}</strong>.`);
    linhas.push(`Modelos usados no ciclo: ${b.models}.`);
  }
  linhas.push(acao);
  return wrapHtml(title, linhas);
}
```

- [ ] **Step 5: Ligar o carregador ao laço de envio**

No laço que monta `TemplateData` (logo depois do bloco `if (row.invoice_id) { ... }`, linha ~444), acrescentar:

```ts
      // Só os marcos da franquia carregam contexto de ciclo — três queries a
      // mais por e-mail de mensalidade seria desperdício puro.
      const aiBudget = row.event_type.startsWith("admin_ai_budget_")
        ? await loadAiBudgetContext(row.organization_id)
        : undefined;
```

E incluir `aiBudget` no objeto passado a `tmpl(...)`.

- [ ] **Step 6: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/ai-budget-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 7: Rodar a suíte e commitar**

```bash
npm run test
npm run typecheck
npx eslint supabase/functions/process-billing-notifications --max-warnings=0
git add supabase/functions/process-billing-notifications/index.ts src/lib/ai-budget-dispatcher.test.ts
git commit -m "feat(plano-d): templates internos dos quatro marcos da franquia no dispatcher"
```

---

## Task 9: Núcleo autorizador por chamada (`ai-call-authorizer-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/ai-call-authorizer-core.ts`
- Test: `src/lib/ai-call-authorizer-core.test.ts`

**Interfaces:**
- Consumes: `BeforeCallDecision`, `BeforeCallContext` de `ai-budget-core.ts`; `AiUsageTokens` de `ai-price-core.ts`.
- Produces: `AgentCallMeta`, `AgentCallOutcome`, `ProviderInvokeResult`, `AuthorizerDeps`, `AuthorizedCall`, `authorizeAndInvoke(base, deps)`.

**Por que este núcleo existe:** `ai-providers.ts` importa `https://esm.sh/@anthropic-ai/sdk` e vitest **não consegue importá-lo**. Regra de decisão escrita lá só é verificável por leitura — e leitura já deixou passar um `ReferenceError` de autorização e um conflito FK × CHECK por duas auditorias na 6b. **O protocolo ordenado de §17.7.3 vive aqui**, com as dependências injetadas, e os cinco runners viram adaptadores finos.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/ai-call-authorizer-core.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  authorizeAndInvoke,
  type AuthorizerDeps,
  type AuthorizedCallBase,
} from "../../supabase/functions/_shared/ai-call-authorizer-core";
import type { BeforeCallDecision } from "../../supabase/functions/_shared/ai-budget-core";

const base = (over: Partial<AuthorizedCallBase> = {}): AuthorizedCallBase => ({
  organizationId: "org",
  cycleId: "cyc",
  turnId: "turn",
  requestId: "req",
  reservationId: "res",
  provider: "gemini",
  model: "gemini-2.5-flash",
  iteration: 1,
  maxIterations: 12,
  consumedCents: 0,
  reservedCents: 400,
  nextCallEstimateCents: 100,
  ...over,
});

function deps(over: Partial<AuthorizerDeps> = {}): AuthorizerDeps {
  let n = 0;
  return {
    priceFor: vi.fn(async () => ({ kind: "PRICED" as const, priceId: "price-1" })),
    beforeCall: vi.fn(async (): Promise<BeforeCallDecision> => ({
      kind: "ALLOW",
      reservationId: "res",
      remainingReservedCents: 300,
    })),
    invoke: vi.fn(async () => ({
      kind: "OK" as const,
      value: { text: "oi" },
      rawUsage: { input_tokens: 100, output_tokens: 50 },
    })),
    reportCall: vi.fn(async () => {}),
    newCallId: () => `call-${++n}`,
    ...over,
  };
}

describe("protocolo ordenado por chamada (§17.7.3)", () => {
  it("a ordem é preço → autorização → chamada → apropriação", async () => {
    const order: string[] = [];
    const d = deps({
      priceFor: vi.fn(async () => {
        order.push("price");
        return { kind: "PRICED" as const, priceId: "price-1" };
      }),
      beforeCall: vi.fn(async () => {
        order.push("before");
        return { kind: "ALLOW" as const, reservationId: "res", remainingReservedCents: 300 };
      }),
      invoke: vi.fn(async () => {
        order.push("invoke");
        return { kind: "OK" as const, value: {}, rawUsage: { input_tokens: 1, output_tokens: 1 } };
      }),
      reportCall: vi.fn(async () => {
        order.push("report");
      }),
    });
    await authorizeAndInvoke(base(), d);
    expect(order).toEqual(["price", "before", "invoke", "report"]);
  });

  it("a apropriação é AGUARDADA antes de a função retornar — a 2ª chamada não decide com o saldo da 1ª", async () => {
    let reported = false;
    const d = deps({
      reportCall: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        reported = true;
      }),
    });
    await authorizeAndInvoke(base(), d);
    expect(reported).toBe(true);
  });

  it("modelo sem preço vigente: ZERO chamada ao provider", async () => {
    const d = deps({
      priceFor: vi.fn(async () => ({ kind: "PRICE_UNKNOWN" as const, provider: "grok", model: "grok-9" })),
    });
    const r = await authorizeAndInvoke(base({ provider: "grok", model: "grok-9" }), d);
    expect(r.kind).toBe("DENIED");
    if (r.kind !== "DENIED") return;
    expect(r.decision.kind).toBe("DENY_PRICE_UNKNOWN");
    expect(d.invoke).not.toHaveBeenCalled();
    expect(d.beforeCall).not.toHaveBeenCalled();
    expect(d.reportCall).not.toHaveBeenCalled();
  });

  it("beforeCall negado: ZERO chamada externa, qualquer que seja a variante", async () => {
    for (const decision of [
      { kind: "DENY_BUDGET", reasonCode: "x" },
      { kind: "DENY_USAGE_UNRESOLVED", reasonCode: "x" },
      { kind: "ERROR", retryable: true, sanitizedCode: "x" },
    ] as BeforeCallDecision[]) {
      const d = deps({ beforeCall: vi.fn(async () => decision) });
      const r = await authorizeAndInvoke(base(), d);
      expect(r.kind).toBe("DENIED");
      expect(d.invoke).not.toHaveBeenCalled();
    }
  });

  it("a decisão negada é PROPAGADA intacta — ERROR não vira DENY_BUDGET", async () => {
    const d = deps({
      beforeCall: vi.fn(async () => ({ kind: "ERROR" as const, retryable: false, sanitizedCode: "db_down" })),
    });
    const r = await authorizeAndInvoke(base(), d);
    expect(r.kind).toBe("DENIED");
    if (r.kind !== "DENIED" || r.decision.kind !== "ERROR") throw new Error("variante errada");
    expect(r.decision.retryable).toBe(false);
    expect(r.decision.sanitizedCode).toBe("db_down");
  });

  it("cada chamada tem call_id PRÓPRIO", async () => {
    const d = deps();
    const a = await authorizeAndInvoke(base(), d);
    const b = await authorizeAndInvoke(base({ iteration: 2 }), d);
    expect(a.meta.callId).not.toBe(b.meta.callId);
  });

  it("o meta carrega provider e model REAIS da chamada", async () => {
    const d = deps();
    const r = await authorizeAndInvoke(base({ provider: "gemini", model: "gemini-2.5-pro" }), d);
    expect(r.meta.provider).toBe("gemini");
    expect(r.meta.model).toBe("gemini-2.5-pro");
    // O preço consultado é o do modelo REAL — Pro custa múltiplas vezes Flash.
    expect(d.priceFor).toHaveBeenCalledWith("gemini", "gemini-2.5-pro");
  });

  it("usage ausente vira NO_USAGE — nunca consumo zero", async () => {
    const d = deps({
      invoke: vi.fn(async () => ({ kind: "OK" as const, value: {}, rawUsage: null })),
    });
    await authorizeAndInvoke(base(), d);
    const [, outcome] = (d.reportCall as any).mock.calls[0];
    expect(outcome.kind).toBe("NO_USAGE");
  });

  it("usage vazio (objeto sem tokens) também é NO_USAGE", async () => {
    const d = deps({
      invoke: vi.fn(async () => ({ kind: "OK" as const, value: {}, rawUsage: { cache_read_tokens: 9 } })),
    });
    await authorizeAndInvoke(base(), d);
    const [, outcome] = (d.reportCall as any).mock.calls[0];
    expect(outcome.kind).toBe("NO_USAGE");
  });

  it("falha do provider vira PROVIDER_FAILED e ainda assim é reportada", async () => {
    const d = deps({
      invoke: vi.fn(async () => ({ kind: "FAILED" as const, error: new Error("503") })),
    });
    const r = await authorizeAndInvoke(base(), d);
    expect(r.kind).toBe("EXECUTED");
    const [, outcome] = (d.reportCall as any).mock.calls[0];
    expect(outcome.kind).toBe("PROVIDER_FAILED");
  });

  it("reportCall recebe o priceId da vigência consultada, não um preço inventado", async () => {
    const d = deps();
    await authorizeAndInvoke(base(), d);
    const [, , priceId] = (d.reportCall as any).mock.calls[0];
    expect(priceId).toBe("price-1");
  });

  it("reportCall é chamado UMA vez por chamada autorizada", async () => {
    const d = deps();
    await authorizeAndInvoke(base(), d);
    expect(d.reportCall).toHaveBeenCalledTimes(1);
  });

  it("erro dentro de reportCall não é engolido — apropriação silenciosamente perdida é o pior caso", async () => {
    const d = deps({
      reportCall: vi.fn(async () => {
        throw new Error("db");
      }),
    });
    await expect(authorizeAndInvoke(base(), d)).rejects.toThrow();
  });
});

describe("fallback como chamada financeira própria (§17.7.6)", () => {
  it("a segunda chamada NÃO herda a autorização da primeira", async () => {
    const d = deps();
    await authorizeAndInvoke(base({ model: "gemini-2.5-flash" }), d);
    await authorizeAndInvoke(base({ model: "gemini-2.5-pro", iteration: 1 }), d);
    expect(d.beforeCall).toHaveBeenCalledTimes(2);
    expect(d.priceFor).toHaveBeenCalledTimes(2);
  });

  it("o fallback é precificado pelo modelo REAL", async () => {
    const d = deps();
    await authorizeAndInvoke(base({ model: "gemini-2.5-pro" }), d);
    expect(d.priceFor).toHaveBeenCalledWith("gemini", "gemini-2.5-pro");
    expect(d.priceFor).not.toHaveBeenCalledWith("gemini", "gemini-2.5-flash");
  });

  it("com usage da 1ª pendente, o fallback recebe DENY_USAGE_UNRESOLVED e não chama nada", async () => {
    const d = deps({
      beforeCall: vi.fn(async () => ({ kind: "DENY_USAGE_UNRESOLVED" as const, reasonCode: "prior_usage_unresolved" })),
    });
    const r = await authorizeAndInvoke(base({ model: "gemini-2.5-pro" }), d);
    expect(r.kind).toBe("DENIED");
    if (r.kind !== "DENIED") return;
    expect(r.decision.kind).toBe("DENY_USAGE_UNRESOLVED");
    expect(d.invoke).not.toHaveBeenCalled();
  });

  it("as duas chamadas do mesmo turno compartilham turn_id e diferem em call_id", async () => {
    const d = deps();
    const a = await authorizeAndInvoke(base({ model: "gemini-2.5-flash" }), d);
    const b = await authorizeAndInvoke(base({ model: "gemini-2.5-pro" }), d);
    expect(a.meta.turnId).toBe(b.meta.turnId);
    expect(a.meta.callId).not.toBe(b.meta.callId);
  });
});

describe("o autorizador não conta volume", () => {
  it("nenhuma dependência recebe contagem de conversa ou mensagem", async () => {
    const d = deps();
    const r = await authorizeAndInvoke(base(), d);
    expect(Object.keys(r.meta)).not.toContain("conversationCount");
    expect(Object.keys(r.meta)).not.toContain("messageCount");
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-call-authorizer-core.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar o núcleo**

Criar `supabase/functions/_shared/ai-call-authorizer-core.ts`:

```ts
/**
 * Núcleo PURO do protocolo de autorização financeira POR CHAMADA (spec §17.7.3).
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO DE ai-providers.ts: aquele importa
 * `https://esm.sh/@anthropic-ai/sdk` e vitest não o alcança. Regra de decisão
 * escrita lá só é verificável por LEITURA — e leitura já deixou passar um
 * `ReferenceError` de autorização e um conflito FK × CHECK por duas auditorias
 * na 6b. Aqui a ordem é testada de verdade, com dependências injetadas, e os
 * cinco runners viram adaptadores finos.
 *
 * O CONTRATO VALE PARA OS CINCO PROVEDORES — claude, openai, gemini, grok e
 * deepseek. Implementar o gancho só no Gemini (o mais exercitado, o único com
 * fallback) o tornaria "o único testado".
 *
 * A CHAMADA DE FALLBACK NÃO HERDA A AUTORIZAÇÃO DA PRIMEIRA: quem chama esta
 * função uma segunda vez com outro `model` obtém preço próprio, autorização
 * própria e `call_id` próprio. Cobrar Pro a preço de Flash é subcontabilização
 * direta.
 */

import { classifyUsage, type AiUsageTokens } from "./ai-price-core.ts";
import type { BeforeCallContext, BeforeCallDecision } from "./ai-budget-core.ts";

/** Identidade e contexto de UMA chamada HTTP ao provedor. */
export interface AgentCallMeta {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  reservationId: string;
  provider: string;
  /** Modelo REAL desta chamada — nunca o modelo inicial do turno. */
  model: string;
  callId: string;
  /** 1-based. */
  iteration: number;
  maxIterations: number;
}

/**
 * Desfecho financeiro de uma chamada que chegou ao provedor.
 *
 * As três variantes existem porque zero significa coisas diferentes: em
 * `PROVIDER_FAILED` sabe-se que nada foi consumido; em `NO_USAGE` a chamada
 * OCORREU e o custo é indeterminado — e tratar as duas igual é exatamente o
 * buraco que resposta vazia + fallback abriria.
 */
export type AgentCallOutcome =
  | { kind: "USAGE"; usage: AiUsageTokens }
  | { kind: "NO_USAGE" }
  | { kind: "PROVIDER_FAILED"; error: unknown };

export type ProviderInvokeResult =
  | { kind: "OK"; value: unknown; rawUsage: unknown }
  | { kind: "FAILED"; error: unknown };

export type PriceLookup =
  | { kind: "PRICED"; priceId: string }
  | { kind: "PRICE_UNKNOWN"; provider: string; model: string };

export interface AuthorizerDeps {
  /** Preço vigente do modelo REAL desta chamada. */
  priceFor(provider: string, model: string): Promise<PriceLookup>;
  beforeCall(ctx: BeforeCallContext): Promise<BeforeCallDecision>;
  /** Executa a chamada HTTP. Nunca é chamada quando a decisão é negativa. */
  invoke(meta: AgentCallMeta): Promise<ProviderInvokeResult>;
  /**
   * Aproprie custo e estado DENTRO da reserva. É AGUARDADA: o consumo de cada
   * chamada precisa estar apropriado antes da próxima autorização, senão a 2ª
   * decide com o saldo de antes da 1ª.
   */
  reportCall(meta: AgentCallMeta, outcome: AgentCallOutcome, priceId: string): Promise<void>;
  newCallId(): string;
}

/** Tudo o que o chamador sabe antes de gerar a identidade da chamada. */
export interface AuthorizedCallBase {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  reservationId: string;
  provider: string;
  model: string;
  iteration: number;
  maxIterations: number;
  consumedCents: number;
  reservedCents: number;
  nextCallEstimateCents: number;
}

export type AuthorizedCall =
  | { kind: "EXECUTED"; result: ProviderInvokeResult; outcome: AgentCallOutcome; meta: AgentCallMeta }
  | { kind: "DENIED"; decision: BeforeCallDecision; meta: AgentCallMeta };

/**
 * A ORDEM É O CONTRATO (§17.7.3):
 *   1. resolver provider e modelo (feito pelo chamador, chega em `base`);
 *   2. verificar preço vigente;
 *   3. chamar beforeCall;
 *   4. receber ALLOW com cobertura;
 *   5. executar a chamada;
 *   6. receber usage;
 *   7. calcular o custo real (no adapter, a partir do outcome);
 *   8. avançar consumed_cents de forma atômica e idempotente;
 *   9. atualizar o saldo restante da reserva;
 *  10. só então permitir a próxima iteração.
 *
 * O passo 2 vem ANTES do 3 de propósito: negar por preço desconhecido não deve
 * consumir uma tentativa de reserva nem produzir alerta de orçamento — são
 * causas, copys, telemetrias e possibilidades de retry diferentes.
 */
export async function authorizeAndInvoke(
  b: AuthorizedCallBase,
  deps: AuthorizerDeps,
): Promise<AuthorizedCall> {
  const meta: AgentCallMeta = {
    organizationId: b.organizationId,
    cycleId: b.cycleId,
    turnId: b.turnId,
    requestId: b.requestId,
    reservationId: b.reservationId,
    provider: b.provider,
    model: b.model,
    callId: deps.newCallId(),
    iteration: b.iteration,
    maxIterations: b.maxIterations,
  };

  // 2. Preço vigente do modelo REAL. Fail-closed: nenhuma chamada, nenhum
  //    custo zero, nenhum preço de "modelo semelhante", nenhum fallback
  //    silencioso. Custo operacional aceitável e preferível a furar o teto.
  const price = await deps.priceFor(b.provider, b.model);
  if (price.kind === "PRICE_UNKNOWN") {
    return {
      kind: "DENIED",
      decision: { kind: "DENY_PRICE_UNKNOWN", provider: price.provider, model: price.model },
      meta,
    };
  }

  // 3-4. Autorização financeira. A decisão negada é PROPAGADA INTACTA: o
  //      chamador precisa distinguir teto atingido de falha de infraestrutura,
  //      porque as duas dizem coisas opostas ao cliente e ao admin.
  const ctx: BeforeCallContext = {
    organizationId: b.organizationId,
    cycleId: b.cycleId,
    turnId: b.turnId,
    requestId: b.requestId,
    provider: b.provider,
    model: b.model,
    iteration: b.iteration,
    maxIterations: b.maxIterations,
    reservationId: b.reservationId,
    consumedCents: b.consumedCents,
    reservedCents: b.reservedCents,
    nextCallEstimateCents: b.nextCallEstimateCents,
  };
  const decision = await deps.beforeCall(ctx);
  if (decision.kind !== "ALLOW") {
    return { kind: "DENIED", decision, meta };
  }

  // 5. Só aqui existe I/O externo.
  const result = await deps.invoke(meta);

  // 6. Classificação do desfecho. `NO_USAGE` NÃO é consumo zero.
  let outcome: AgentCallOutcome;
  if (result.kind === "FAILED") {
    outcome = { kind: "PROVIDER_FAILED", error: result.error };
  } else {
    const c = classifyUsage(result.rawUsage);
    outcome = c.kind === "USABLE" ? { kind: "USAGE", usage: c.usage } : { kind: "NO_USAGE" };
  }

  // 8-9. AGUARDADO. Uma exceção aqui PROPAGA: apropriação silenciosamente
  //      perdida é o pior caso possível — o custo real aconteceu e o orçamento
  //      não soube. O chamador trata como erro do agente (auto-handoff), e a
  //      reserva continua HELD até liquidação ou expiração.
  await deps.reportCall(meta, outcome, price.priceId);

  return { kind: "EXECUTED", result, outcome, meta };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/ai-call-authorizer-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Rodar a suíte e commitar**

```bash
npm run test
npm run typecheck
npx eslint supabase/functions/_shared/ai-call-authorizer-core.ts --max-warnings=0
git add supabase/functions/_shared/ai-call-authorizer-core.ts src/lib/ai-call-authorizer-core.test.ts
git commit -m "feat(plano-d): nucleo do protocolo de autorizacao financeira por chamada"
```

---

*(As tarefas 10 a 13 seguem em `2026-08-03-plano-d-franquia-ia-parte-4.md`.)*
