# Plano D — Franquia de IA inclusa (Fase 7 redefinida) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistir, versionar e proteger financeiramente o custo de IA já instrumentado, aplicando um teto de R$ 100 por organização e por ciclo — franquia financiada pela plataforma, nunca crédito comprado pelo cliente.

**Architecture:** Toda decisão vive em núcleo puro (`supabase/functions/_shared/ai-*-core.ts`, testado por vitest em `src/lib/`); todo I/O vive em adapters (`ai-budget-gate.ts`, `webhook-whatsapp/index.ts`) e em cinco RPCs `SECURITY DEFINER` que serializam leitura e escrita do orçamento sob lock de linha. O contrato de `runAgentLoop` ganha autorização financeira **por chamada HTTP** (`beforeCall`), com resultado discriminado — nunca boolean —, e o custo real é apropriado dentro da reserva do turno **antes** da autorização seguinte.

**Tech Stack:** Deno (Edge Functions), PostgreSQL/Supabase (migrations idempotentes, FORCE RLS, `btree_gist`), TypeScript sob `strict: false`, vitest para os núcleos puros.

## Global Constraints

Valores e regras copiados da spec `docs/superpowers/specs/2026-08-02-modelo-comercial-dois-planos-design.md` (v1.0 CONGELADA). **Os requisitos de toda tarefa incluem implicitamente esta seção.**

- **Teto: R$ 100,00 (`10000` cents) por organização e por ciclo.** `limit_cents` congelado na abertura do ciclo, nunca relido do plano.
- **SEM limite de conversas, mensagens ou interações.** Qualquer código que conte conversas para autorizar ou negar está errado (§18.1).
- **`beforeCall` devolve união discriminada, nunca boolean:** `ALLOW | DENY_BUDGET | DENY_PRICE_UNKNOWN | DENY_USAGE_UNRESOLVED | ERROR` (§17.7.1). **`ERROR` não é hard stop comercial.**
- **Modelo sem preço vigente falha fechado** — zero chamada ao provider, nunca custo zero (§17.1).
- **Usage ausente falha fechado** — `USAGE_REVIEW_REQUIRED`, cobertura conservadora mantida, reserva **fora** da varredura de expiração (§17.2.1, §17.2.2).
- **Fallback do Gemini é chamada financeira própria** — autorização própria, preço do modelo real, `call_id` próprio; se a 1ª chamada não devolveu usage, o fallback recebe `DENY_USAGE_UNRESOLVED` (§17.7.6).
- **Negação depois de ferramenta mutante preserva o efeito**, não repete a ferramenta, e responde com **texto determinístico** que entra no `HARDCODED_AGENT_NOISE` no mesmo PR (§17.7.4).
- **Fórmula do teto:** `available = limit_cents − settled_cents − Σ(reserved_cents − consumed_cents das reservas HELD)`. **Nunca colapsar `settled` e reservas num campo só** (§17.5).
- **`cycle_start` INCLUSIVO, `cycle_end` EXCLUSIVO** — o primeiro dia NÃO coberto (§17.3).
- **Marcos:** 70% / 80% / 90% / 100% do `limit_cents` → `admin_ai_budget_70` · `admin_ai_budget_80` · `admin_ai_budget_90` · `admin_ai_budget_stop`. Cada um **no máximo uma vez por ciclo**, cadência no ledger, não na fila (§18.2).
- **Hard stop:** `conversations.status='awaiting_human'`, `handoff_reason='ai_budget_exhausted'`; canal continua recebendo; nada de "falha técnica"; nada de degradar para modelo inferior (§18.3).
- **Nunca informar ao cliente final** custo em reais, tokens, preço de modelo, margem ou o limite de R$ 100 (§18.3).
- **`budgetRemainingCents` nunca vai ao frontend do lojista** — caminho de resposta separado, não filtragem pós-montagem (§18.4).
- **Flag `ai_wallet_enforced` (já semeada, OFF) é o gate da franquia.** OFF = medição e ledger funcionam, hard stop **não** aplica, nenhuma negação comercial acontece (§21).
- **Ren Sushi e Moralles têm override LIFETIME em `ai`** — prioridade 2 do resolvedor, **não passam por nada deste plano** (§19).
- **Chave de IA é per-unit (BYOK) e NUNCA pode ser logada.** Nenhum `sanitizedCode` carrega SQL, payload bruto ou `error.message` do Postgres.
- **Faixa de migration reservada: 099–103.** Nenhum outro número.
- **NÃO editar `CLAUDE.md`.** Todo item de checklist de redeploy vai para `docs/billing-asaas/PLANO-D-PENDENCIAS.md`, seção "CLAUDE.md a consolidar".
- **Arquivos fora desta frente (PARE e avise):** `manage-whatsapp-instances`, `manage-channels`, `WhatsappInstances.tsx`, `manage-whatsapp-implementations`, componentes de pricing.
- **Nada em produção:** nenhum `supabase` CLI, nenhuma migration aplicada, nenhum deploy, nenhuma flag ligada, nenhum cron, nenhum merge.
- **Sob `strict: false` do `tsconfig.app.json`, estreitar união discriminada exige `x.kind === "..."` ou early-return.** `if (!x.ok) { x.campo }` NÃO estreita.
- **Gates por tarefa:** `npm run test` verde, `npm run typecheck` (`tsc -b --noEmit`) zero erros, `npx eslint supabase/functions --max-warnings=0` zero.

---

## File Structure

**Núcleos puros novos** (`supabase/functions/_shared/`, zero imports externos, testados em `src/lib/`):

| Arquivo | Responsabilidade única |
|---|---|
| `ai-price-core.ts` | Vigência de preço, `CostResult` discriminado, conversão USD→BRL cents, classificação de usage |
| `ai-budget-core.ts` | Fórmula do disponível, janela do ciclo, estimativa conservadora, `BeforeCallDecision`, mapeamentos de telemetria |
| `ai-budget-milestones-core.ts` | Os quatro marcos e o `event_type` de cada um (fonte canônica) |
| `ai-budget-copy.ts` | Textos determinísticos ao cliente + a lista que entra no `HARDCODED_AGENT_NOISE` |
| `ai-call-authorizer-core.ts` | O protocolo ordenado de §17.7.3, provider-agnóstico, com dependências injetadas |

**Adapter de I/O novo** (`supabase/functions/_shared/`, importa supabase-js — não testável por vitest):

| Arquivo | Responsabilidade única |
|---|---|
| `ai-budget-gate.ts` | Chama as RPCs e monta os hooks; **zero decisão própria** |

**Modificados:**

| Arquivo | Mudança |
|---|---|
| `supabase/functions/_shared/ai-providers.ts` | `budget` hooks em `AgentLoopOptions`; `onUsage` com meta e outcome; retorno discriminado; fallback do Gemini reestruturado |
| `supabase/functions/_shared/entitlements-core.ts` | **Só** o ramo de franquia da IA (entre override e carteira) |
| `supabase/functions/_shared/entitlements.ts` | Passa `aiFranchise` adiante (parâmetro opcional) |
| `supabase/functions/webhook-whatsapp/index.ts` | Abertura/reserva/liquidação, hard stop, auto-resolve, noise set |
| `supabase/functions/process-billing-notifications/index.ts` | Quatro entradas em `TEMPLATE_BY_EVENT` + carregamento dos dados do ciclo |
| `scripts/function-acl-allowlist.json` | **Nenhuma entrada nova** — as RPCs deste plano são `service_role` only (ver Task 6) |

**Migrations (099–103):**

| Arquivo | Conteúdo |
|---|---|
| `20260803090000_099_ai_model_prices.sql` | `ai_model_prices` + seed dos preços vigentes |
| `20260803090100_100_ai_cycle_budgets.sql` | `ai_cycle_budgets` + `btree_gist` + EXCLUDE de não sobreposição |
| `20260803090200_101_ai_usage_and_reservations.sql` | `ai_cost_reservations` + `ai_usage_events` |
| `20260803090300_102_ai_budget_rpcs.sql` | Cinco RPCs `SECURITY DEFINER` + grants |
| `20260803090400_103_ai_budget_milestones.sql` | `ai_budget_milestones` (ledger dos marcos) |

**Testes novos** (`src/lib/`): `ai-price-core.test.ts`, `ai-budget-core.test.ts`, `ai-budget-milestones-core.test.ts`, `ai-call-authorizer-core.test.ts`, `ai-budget-migrations-guard.test.ts`, `ai-budget-dispatcher.test.ts`, `ai-budget-wiring-guard.test.ts`. Estendido: `entitlements-core.test.ts`.

**Docs:** `docs/billing-asaas/PLANO-D-PENDENCIAS.md` (novo).

---

## Ordem das tarefas e dependências

1. Núcleo de preço → 2. Núcleo de orçamento → 3. Marcos + copy → 4. Migrations de schema (099–101) → 5. RPCs (102) → 6. Ledger de marcos (103) → 7. Entitlement (ramo de franquia) → 8. Templates do dispatcher → 9. Autorizador (núcleo) → 10. `ai-providers.ts` → 11. `ai-budget-gate.ts` → 12. `webhook-whatsapp` → 13. Pendências e gates finais.

O dispatcher (8) vem **antes** dos produtores (11–12) — mesma disciplina de "`process-billing-notifications` primeiro" da §21.

---

## Task 1: Núcleo de preço versionado (`ai-price-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/ai-price-core.ts`
- Test: `src/lib/ai-price-core.test.ts`

**Interfaces:**
- Consumes: nada (primeira tarefa; zero imports).
- Produces: `AiUsageTokens`, `AiModelPrice`, `CostResult`, `UsageClassification`, `selectEffectivePrice(rows, provider, model, atIso)`, `priceUsage(price, usage, provider, model)`, `classifyUsage(raw)`, `usdToBrlCents(usd, rate)`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/ai-price-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  selectEffectivePrice,
  priceUsage,
  classifyUsage,
  usdToBrlCents,
  type AiModelPrice,
  type AiUsageTokens,
} from "../../supabase/functions/_shared/ai-price-core";

const price = (over: Partial<AiModelPrice> = {}): AiModelPrice => ({
  id: "p1",
  provider: "gemini",
  model: "gemini-2.5-flash",
  inputUsdPerMtok: 0.15,
  outputUsdPerMtok: 0.6,
  cacheReadUsdPerMtok: 0.0375,
  cacheWriteUsdPerMtok: 0,
  reasoningUsdPerMtok: null,
  usdToBrl: 5.5,
  effectiveFrom: "2026-01-01T00:00:00Z",
  effectiveTo: null,
  ...over,
});

const usage = (over: Partial<AiUsageTokens> = {}): AiUsageTokens => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
  ...over,
});

describe("selectEffectivePrice", () => {
  it("devolve null quando não há linha para provider/model", () => {
    expect(selectEffectivePrice([price()], "gemini", "gemini-2.5-pro", "2026-08-03T12:00:00Z")).toBeNull();
    expect(selectEffectivePrice([price()], "openai", "gemini-2.5-flash", "2026-08-03T12:00:00Z")).toBeNull();
  });

  it("respeita effective_from inclusivo e effective_to exclusivo", () => {
    const rows = [price({ id: "old", effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: "2026-06-01T00:00:00Z" })];
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-01-01T00:00:00Z")?.id).toBe("old");
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-05-31T23:59:59Z")?.id).toBe("old");
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-06-01T00:00:00Z")).toBeNull();
  });

  it("entre vigências sobrepostas escolhe a de effective_from mais recente", () => {
    const rows = [
      price({ id: "a", effectiveFrom: "2026-01-01T00:00:00Z" }),
      price({ id: "b", effectiveFrom: "2026-07-01T00:00:00Z" }),
    ];
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-08-03T12:00:00Z")?.id).toBe("b");
  });
});

describe("priceUsage", () => {
  it("modelo sem preço vigente devolve PRICE_UNKNOWN — nunca zero", () => {
    const r = priceUsage(null, usage({ input_tokens: 1_000_000 }), "grok", "grok-9");
    expect(r.kind).toBe("PRICE_UNKNOWN");
    if (r.kind === "PRICE_UNKNOWN") {
      expect(r.provider).toBe("grok");
      expect(r.model).toBe("grok-9");
    }
    // Garantia explícita: nenhuma variante com custo zero foi devolvida.
    expect(JSON.stringify(r)).not.toContain('"usd":0');
  });

  it("soma as cinco faixas de token", () => {
    const r = priceUsage(
      price({ reasoningUsdPerMtok: 2 }),
      usage({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
        cache_creation_tokens: 1_000_000,
        reasoning_tokens: 1_000_000,
      }),
      "gemini",
      "gemini-2.5-flash",
    );
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    // 0.15 + 0.6 + 0.0375 + 0 + 2
    expect(r.usd).toBeCloseTo(2.7875, 6);
  });

  it("reasoning sem preço próprio é cobrado como output — conservador, nunca grátis", () => {
    const r = priceUsage(price({ reasoningUsdPerMtok: null }), usage({ reasoning_tokens: 1_000_000 }), "gemini", "gemini-2.5-flash");
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    expect(r.usd).toBeCloseTo(0.6, 6);
  });

  it("converte para BRL cents ARREDONDANDO PRA CIMA e carrega a taxa usada", () => {
    const r = priceUsage(price({ usdToBrl: 5.5 }), usage({ input_tokens: 1 }), "gemini", "gemini-2.5-flash");
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    expect(r.brlCents).toBe(1); // 0.00000015 USD → arredonda pra cima, nunca 0
    expect(r.usdToBrl).toBe(5.5);
    expect(r.priceId).toBe("p1");
  });

  it("uso zero real custa zero — o piso de 1 cent só vale para consumo > 0", () => {
    const r = priceUsage(price(), usage(), "gemini", "gemini-2.5-flash");
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    expect(r.brlCents).toBe(0);
  });
});

describe("usdToBrlCents", () => {
  it("nunca devolve fração e nunca arredonda para baixo", () => {
    expect(usdToBrlCents(0.001, 5)).toBe(1);
    expect(usdToBrlCents(1, 5.5)).toBe(550);
    expect(usdToBrlCents(0, 5.5)).toBe(0);
  });
});

describe("classifyUsage", () => {
  it("ausência total de usage é MISSING — não é consumo zero", () => {
    expect(classifyUsage(null).kind).toBe("MISSING");
    expect(classifyUsage(undefined).kind).toBe("MISSING");
    expect(classifyUsage({}).kind).toBe("MISSING");
  });

  it("input e output ambos ausentes é MISSING mesmo com objeto presente", () => {
    expect(classifyUsage({ cache_read_tokens: 10 }).kind).toBe("MISSING");
  });

  it("normaliza campos faltantes para zero quando há sinal de consumo", () => {
    const c = classifyUsage({ input_tokens: 100 });
    expect(c.kind).toBe("USABLE");
    if (c.kind !== "USABLE") return;
    expect(c.usage).toEqual({
      input_tokens: 100,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      reasoning_tokens: 0,
    });
  });

  it("valores negativos ou não numéricos são tratados como zero", () => {
    const c = classifyUsage({ input_tokens: 5, output_tokens: -3, reasoning_tokens: "x" });
    expect(c.kind).toBe("USABLE");
    if (c.kind !== "USABLE") return;
    expect(c.usage.output_tokens).toBe(0);
    expect(c.usage.reasoning_tokens).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-price-core.test.ts`
Expected: FAIL — `Failed to resolve import ".../ai-price-core"`.

- [ ] **Step 3: Implementar o núcleo**

Criar `supabase/functions/_shared/ai-price-core.ts`:

```ts
/**
 * Núcleo PURO do preço versionado de IA (Plano D, spec §17.1).
 *
 * ZERO IMPORTS — importável tanto pelas Edge Functions quanto pelo vitest.
 *
 * A LACUNA QUE ESTE ARQUIVO FECHA: `estimateCostUsd` em ai-providers.ts devolve
 * `0` para modelo fora da tabela de preços. Modelo desconhecido NÃO é gratuito;
 * no caminho protegido por orçamento esse zero significa consumo ilimitado sem
 * nunca tocar o teto. Aqui a ignorância tem tipo próprio (`PRICE_UNKNOWN`) e o
 * chamador é obrigado a tratá-la.
 *
 * `usd_to_brl` vive NA LINHA DE PREÇO, não em variável global: a taxa vigente
 * faz parte da vigência, e um câmbio "atual" aplicado a consumo antigo produz
 * custo histórico que muda sozinho. NÃO recalcular eventos históricos.
 */

export interface AiUsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
}

export interface AiModelPrice {
  id: string;
  provider: string;
  model: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
  cacheWriteUsdPerMtok: number;
  /** null = provedor não cobra faixa separada; o token de raciocínio é cobrado como OUTPUT. */
  reasoningUsdPerMtok: number | null;
  usdToBrl: number;
  effectiveFrom: string;
  /** EXCLUSIVO: primeiro instante NÃO coberto. */
  effectiveTo: string | null;
}

/**
 * União discriminada — D5. Sob `strict: false`, estreitar exige
 * `r.kind === "PRICED"` ou early-return; `if (!r.priced) { r.usd }` NÃO estreita.
 */
export type CostResult =
  | { kind: "PRICED"; usd: number; brlCents: number; priceId: string; usdToBrl: number }
  | { kind: "PRICE_UNKNOWN"; provider: string; model: string };

export type UsageClassification =
  | { kind: "USABLE"; usage: AiUsageTokens }
  | { kind: "MISSING" };

const ZERO_USAGE: AiUsageTokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
};

function toMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function nonNegative(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Vigência: `effective_from` INCLUSIVO, `effective_to` EXCLUSIVO — mesma
 * convenção de `provider_access_until` (6b) e de `cycle_end` (§17.3). O nome
 * admitiria duas leituras e a diferença de um instante é a que erra a virada.
 *
 * Entre vigências sobrepostas (erro de cadastro), vence a de `effective_from`
 * mais recente: cadastro novo sobrescreve, e nunca devolvemos linha arbitrária
 * — o problema aqui é o mesmo de `ilike + limit(1)` já registrado no CLAUDE.md.
 */
export function selectEffectivePrice(
  rows: AiModelPrice[],
  provider: string,
  model: string,
  atIso: string,
): AiModelPrice | null {
  const at = toMs(atIso);
  if (!Number.isFinite(at)) return null;

  const candidates = rows.filter((r) => {
    if (r.provider !== provider || r.model !== model) return false;
    const from = toMs(r.effectiveFrom);
    if (!Number.isFinite(from) || from > at) return false;
    if (r.effectiveTo) {
      const to = toMs(r.effectiveTo);
      if (!Number.isFinite(to) || to <= at) return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => toMs(b.effectiveFrom) - toMs(a.effectiveFrom));
  return candidates[0];
}

/**
 * Converte USD em centavos de BRL SEMPRE PARA CIMA.
 *
 * Arredondar para baixo é subcontabilizar: doze chamadas de fração de centavo
 * viram zero e o teto nunca é tocado. `Math.ceil` erra no máximo 1 centavo por
 * chamada, e erra na direção segura.
 */
export function usdToBrlCents(usd: number, usdToBrl: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(usdToBrl) || usd <= 0 || usdToBrl <= 0) return 0;
  return Math.ceil(usd * usdToBrl * 100);
}

export function priceUsage(
  price: AiModelPrice | null,
  usage: AiUsageTokens,
  provider: string,
  model: string,
): CostResult {
  if (!price) return { kind: "PRICE_UNKNOWN", provider, model };

  // Token de raciocínio sem faixa própria é cobrado como OUTPUT. Tratar como
  // grátis seria a mesma falha do modelo desconhecido, um nível abaixo.
  const reasoningRate = price.reasoningUsdPerMtok ?? price.outputUsdPerMtok;

  const usd =
    (usage.input_tokens * price.inputUsdPerMtok) / 1_000_000 +
    (usage.output_tokens * price.outputUsdPerMtok) / 1_000_000 +
    (usage.cache_read_tokens * price.cacheReadUsdPerMtok) / 1_000_000 +
    (usage.cache_creation_tokens * price.cacheWriteUsdPerMtok) / 1_000_000 +
    (usage.reasoning_tokens * reasoningRate) / 1_000_000;

  return {
    kind: "PRICED",
    usd: Number(usd.toFixed(6)),
    brlCents: usdToBrlCents(usd, price.usdToBrl),
    priceId: price.id,
    usdToBrl: price.usdToBrl,
  };
}

/**
 * "O provider devolveu usage suficiente?" — a segunda ignorância do fail-closed.
 *
 * MISSING quando não há NENHUM sinal de consumo de entrada ou saída. Um objeto
 * presente com só `cache_read_tokens` não prova que a chamada foi contabilizada:
 * toda resposta real consome input. Cair para "usage zerado" aqui é exatamente
 * o buraco de `callGeminiWithFallback` com resposta vazia (§17.7.6).
 */
export function classifyUsage(raw: unknown): UsageClassification {
  if (!raw || typeof raw !== "object") return { kind: "MISSING" };
  const r = raw as Record<string, unknown>;
  const input = nonNegative(r.input_tokens);
  const output = nonNegative(r.output_tokens);
  if (input === 0 && output === 0) return { kind: "MISSING" };
  return {
    kind: "USABLE",
    usage: {
      ...ZERO_USAGE,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: nonNegative(r.cache_read_tokens),
      cache_creation_tokens: nonNegative(r.cache_creation_tokens),
      reasoning_tokens: nonNegative(r.reasoning_tokens),
    },
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/ai-price-core.test.ts`
Expected: PASS — todos os casos.

- [ ] **Step 5: Rodar os gates e commitar**

```bash
npm run typecheck
npx eslint supabase/functions/_shared/ai-price-core.ts --max-warnings=0
git add supabase/functions/_shared/ai-price-core.ts src/lib/ai-price-core.test.ts
git commit -m "feat(plano-d): nucleo puro de preco versionado de IA com CostResult discriminado"
```

---

## Task 2: Núcleo de orçamento (`ai-budget-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/ai-budget-core.ts`
- Test: `src/lib/ai-budget-core.test.ts`

**Interfaces:**
- Consumes: `AiUsageTokens` de `ai-price-core.ts`; `clampDayToMonth` de `whatsapp-instance-cycle-core.ts`.
- Produces: `AI_BUDGET_DEFAULT_LIMIT_CENTS`, `AI_TURN_INITIAL_CALLS`, `AI_RESERVATION_TTL_SECONDS`, `computeAvailableCents(...)`, `resolveCycleWindow(...)`, `estimateCallTokens(iteration)`, `estimateTurnCents(...)`, `BeforeCallDecision`, `BeforeCallContext`, `planNextCall(ctx, opts)`, `mapReserveDecision(row)`, `telemetryEventFor(d)`, `isCommercialHardStop(d)`, `shouldAutoResolveHandoff(args)`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/ai-budget-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AI_BUDGET_DEFAULT_LIMIT_CENTS,
  AI_TURN_INITIAL_CALLS,
  computeAvailableCents,
  resolveCycleWindow,
  estimateCallTokens,
  planNextCall,
  mapReserveDecision,
  telemetryEventFor,
  isCommercialHardStop,
  shouldAutoResolveHandoff,
  type BeforeCallContext,
} from "../../supabase/functions/_shared/ai-budget-core";

const ctx = (over: Partial<BeforeCallContext> = {}): BeforeCallContext => ({
  organizationId: "org",
  cycleId: "cyc",
  turnId: "turn",
  requestId: "req",
  provider: "gemini",
  model: "gemini-2.5-flash",
  iteration: 1,
  maxIterations: 12,
  reservationId: "res",
  consumedCents: 0,
  reservedCents: 400,
  nextCallEstimateCents: 100,
  ...over,
});

describe("teto e disponível", () => {
  it("o limite padrão é R$ 100,00", () => {
    expect(AI_BUDGET_DEFAULT_LIMIT_CENTS).toBe(10000);
  });

  it("disponível = limite − liquidado − restante COMPROMETIDO das reservas", () => {
    expect(
      computeAvailableCents({ limitCents: 10000, settledCents: 3000, activeReservedRemainingCents: 500 }),
    ).toBe(6500);
  });

  it("settled e reserva NÃO colapsam num campo só", () => {
    // Mesma soma, papéis diferentes: o disponível é igual, mas as duas grandezas
    // entram separadas — é o que permite responder "quanto custou de verdade".
    const a = computeAvailableCents({ limitCents: 10000, settledCents: 8000, activeReservedRemainingCents: 0 });
    const b = computeAvailableCents({ limitCents: 10000, settledCents: 0, activeReservedRemainingCents: 8000 });
    expect(a).toBe(2000);
    expect(b).toBe(2000);
  });

  it("nunca devolve negativo", () => {
    expect(
      computeAvailableCents({ limitCents: 10000, settledCents: 11000, activeReservedRemainingCents: 500 }),
    ).toBe(0);
  });
});

describe("janela do ciclo", () => {
  it("cycle_end é EXCLUSIVO — o primeiro dia NÃO coberto", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-03",
      anchorDay: 4,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-04T10:00:00Z",
    });
    expect(w.cycleStart).toBe("2026-07-04");
    expect(w.cycleEnd).toBe("2026-08-04");
    expect(w.anchorDay).toBe(4);
  });

  it("hoje igual ao dia-âncora abre o ciclo NOVO, não o anterior", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-04",
      anchorDay: 4,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-04T10:00:00Z",
    });
    expect(w.cycleStart).toBe("2026-08-04");
    expect(w.cycleEnd).toBe("2026-09-04");
  });

  it("âncora 31 não degrada depois de fevereiro — é persistida, nunca re-derivada", () => {
    const feb = resolveCycleWindow({
      todayIso: "2026-02-15",
      anchorDay: 31,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-31T10:00:00Z",
    });
    expect(feb.cycleStart).toBe("2026-01-31");
    expect(feb.cycleEnd).toBe("2026-02-28");
    expect(feb.anchorDay).toBe(31);

    const mar = resolveCycleWindow({
      todayIso: "2026-03-15",
      anchorDay: 31,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-31T10:00:00Z",
    });
    // 15/03 ainda está DENTRO do ciclo que abriu no marco clampado de fevereiro.
    expect(mar.cycleStart).toBe("2026-02-28");
    // O que prova que a âncora sobreviveu a fevereiro é o FIM voltar a 31: se
    // ela tivesse degradado para 28, este ciclo terminaria em 2026-03-28 e
    // nunca mais voltaria ao dia 31.
    expect(mar.cycleEnd).toBe("2026-03-31");
    expect(mar.anchorDay).toBe(31);
  });

  it("sem âncora persistida, deriva do fim do período da assinatura", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-03",
      anchorDay: null,
      subscriptionPeriodStartIso: "2026-07-10T00:00:00Z",
      subscriptionPeriodEndIso: "2026-08-10T00:00:00Z",
      orgCreatedAtIso: "2025-01-04T10:00:00Z",
    });
    expect(w.anchorDay).toBe(10);
    expect(w.cycleStart).toBe("2026-07-10");
    expect(w.cycleEnd).toBe("2026-08-10");
  });

  it("sem assinatura nem âncora, cai na data de criação da organização", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-03",
      anchorDay: null,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-20T10:00:00Z",
    });
    expect(w.anchorDay).toBe(20);
    expect(w.cycleStart).toBe("2026-07-20");
    expect(w.cycleEnd).toBe("2026-08-20");
  });

  it("cycle_start é sempre menor que cycle_end", () => {
    for (const day of [1, 15, 28, 29, 30, 31]) {
      const w = resolveCycleWindow({
        todayIso: "2026-02-10",
        anchorDay: day,
        subscriptionPeriodStartIso: null,
        subscriptionPeriodEndIso: null,
        orgCreatedAtIso: "2025-01-01T00:00:00Z",
      });
      expect(w.cycleStart < w.cycleEnd).toBe(true);
    }
  });
});

describe("estimativa conservadora", () => {
  it("cresce com a iteração — a 11ª carrega mais contexto que a 1ª", () => {
    const first = estimateCallTokens(1);
    const eleventh = estimateCallTokens(11);
    expect(eleventh.input_tokens).toBeGreaterThan(first.input_tokens);
  });

  it("nunca assume cache hit — cache_read estimado é zero", () => {
    expect(estimateCallTokens(5).cache_read_tokens).toBe(0);
  });

  it("a reserva inicial cobre mais de uma chamada", () => {
    expect(AI_TURN_INITIAL_CALLS).toBeGreaterThanOrEqual(2);
  });
});

describe("planNextCall", () => {
  it("libera quando o restante da reserva cobre a estimativa", () => {
    const p = planNextCall(ctx({ reservedCents: 400, consumedCents: 100, nextCallEstimateCents: 100 }), {
      usageUnresolved: false,
    });
    expect(p.kind).toBe("ALLOW");
  });

  it("pede extensão quando o restante NÃO cobre — o turno longo não é punido se o ciclo tem saldo", () => {
    const p = planNextCall(ctx({ reservedCents: 400, consumedCents: 380, nextCallEstimateCents: 100 }), {
      usageUnresolved: false,
    });
    expect(p.kind).toBe("EXTEND");
    if (p.kind !== "EXTEND") return;
    // 100 de estimativa − 20 de restante = 80. Valor exato: uma extensão que
    // não fecha o déficit autoriza uma chamada sem cobertura real.
    expect(p.additionalCents).toBe(80);
  });

  it("usage pendente nega ANTES de qualquer consideração de saldo", () => {
    const p = planNextCall(ctx({ reservedCents: 100000, consumedCents: 0 }), { usageUnresolved: true });
    expect(p.kind).toBe("DENY_USAGE_UNRESOLVED");
  });

  it("consumo acima do reservado (overage) vira pedido de extensão, não crédito silencioso", () => {
    const p = planNextCall(ctx({ reservedCents: 400, consumedCents: 500, nextCallEstimateCents: 100 }), {
      usageUnresolved: false,
    });
    expect(p.kind).toBe("EXTEND");
    if (p.kind !== "EXTEND") return;
    // A extensão cobre o overage JÁ INCORRIDO (100) mais a próxima chamada
    // (100). Pedir só 100 deixaria o restante em zero e autorizaria uma chamada
    // sem cobertura — que é exatamente o que a estimativa existe para impedir.
    expect(p.additionalCents).toBe(200);
  });
});

describe("mapReserveDecision", () => {
  it("ALLOW carrega a reserva e o restante comprometido", () => {
    const d = mapReserveDecision({
      decision: "ALLOW",
      reservation_id: "r1",
      reserved_cents: 400,
      consumed_cents: 50,
    });
    expect(d.kind).toBe("ALLOW");
    if (d.kind !== "ALLOW") return;
    expect(d.reservationId).toBe("r1");
    expect(d.remainingReservedCents).toBe(350);
  });

  it("DENY_BUDGET é hard stop comercial", () => {
    const d = mapReserveDecision({ decision: "DENY_BUDGET", reason_code: "cycle_exhausted" });
    expect(d.kind).toBe("DENY_BUDGET");
    expect(isCommercialHardStop(d)).toBe(true);
  });

  it("ERROR de infraestrutura NÃO é confundido com teto atingido", () => {
    const d = mapReserveDecision({ decision: "SOMETHING_WEIRD" });
    expect(d.kind).toBe("ERROR");
    expect(isCommercialHardStop(d)).toBe(false);
    if (d.kind !== "ERROR") return;
    expect(d.retryable).toBe(true);
    // sanitizedCode é código curto, nunca mensagem do Postgres
    expect(d.sanitizedCode.length).toBeLessThanOrEqual(40);
    expect(d.sanitizedCode).not.toMatch(/select|insert|update|ERROR:/i);
  });

  it("nenhuma variante de negação técnica é hard stop comercial", () => {
    expect(isCommercialHardStop({ kind: "DENY_PRICE_UNKNOWN", provider: "x", model: "y" })).toBe(false);
    expect(isCommercialHardStop({ kind: "DENY_USAGE_UNRESOLVED", reasonCode: "pending" })).toBe(false);
  });

  it("cada variante tem evento de telemetria PRÓPRIO", () => {
    const events = [
      telemetryEventFor({ kind: "ALLOW", reservationId: "r", remainingReservedCents: 1 }),
      telemetryEventFor({ kind: "DENY_BUDGET", reasonCode: "x" }),
      telemetryEventFor({ kind: "DENY_PRICE_UNKNOWN", provider: "p", model: "m" }),
      telemetryEventFor({ kind: "DENY_USAGE_UNRESOLVED", reasonCode: "x" }),
      telemetryEventFor({ kind: "ERROR", retryable: true, sanitizedCode: "x" }),
    ];
    expect(new Set(events).size).toBe(5);
  });
});

describe("auto-resolve do handoff", () => {
  it("handoff por erro comum resolve normalmente depois da janela", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "agent_error:gemini:gemini-2.5-flash",
        ageMs: 13 * 3600_000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: false,
      }),
    ).toBe(true);
  });

  it("franquia esgotada NÃO devolve a conversa para uma IA que não pode responder", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "ai_budget_exhausted",
        ageMs: 400 * 3600_000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: true,
      }),
    ).toBe(false);
  });

  it("virada do ciclo devolve a conversa", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "ai_budget_exhausted",
        ageMs: 13 * 3600_000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: false,
      }),
    ).toBe(true);
  });

  it("sem idade suficiente não resolve, qualquer que seja a razão", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "ai_budget_exhausted",
        ageMs: 1000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: false,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-core.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar o núcleo**

Criar `supabase/functions/_shared/ai-budget-core.ts`:

```ts
/**
 * Núcleo PURO do orçamento de franquia de IA (Plano D, spec §17.3-17.7).
 *
 * Importa APENAS outro núcleo puro (`whatsapp-instance-cycle-core.ts`) — a
 * aritmética de âncora de calendário já foi resolvida e testada na 6b, e
 * reimplementá-la aqui criaria uma segunda verdade sobre a mesma pergunta
 * (§18.5: "Reusar a solução, não reinventar").
 *
 * NÃO EXISTE NENHUMA CONTAGEM DE CONVERSA, MENSAGEM OU INTERAÇÃO NESTE ARQUIVO.
 * O único teto é financeiro (§18.1) — e é intencional que a única unidade que
 * aparece aqui seja centavo.
 */

import { clampDayToMonth } from "./whatsapp-instance-cycle-core.ts";
import type { AiUsageTokens } from "./ai-price-core.ts";

/** R$ 100,00. Congelado no ciclo na abertura — nunca relido do plano. */
export const AI_BUDGET_DEFAULT_LIMIT_CENTS = 10000;

/**
 * Quantas chamadas a reserva inicial do turno cobre.
 *
 * Reservar as 12 iterações de `MAX_ITERATIONS` de uma vez bloquearia organizações
 * com saldo real por causa de um pior caso que quase nunca ocorre; reservar uma
 * só faria toda segunda chamada passar por extensão. Duas é o meio: cobre o
 * turno típico (pergunta + tool + resposta) e deixa a extensão para o turno longo.
 */
export const AI_TURN_INITIAL_CALLS = 2;

/**
 * TTL da reserva. Pior caso real: 12 iterações × 12s de timeout + retries, com
 * o hard limit de 60s da Edge Function como teto verdadeiro. 5 minutos está
 * confortavelmente acima e ainda devolve capacidade rápido depois de um crash.
 */
export const AI_RESERVATION_TTL_SECONDS = 300;

/**
 * Estimativa conservadora de tokens. Erra PARA CIMA de propósito: subestimar
 * autoriza uma chamada que não cabe.
 */
export const AI_ESTIMATE_BASE_INPUT_TOKENS = 6000;
export const AI_ESTIMATE_INPUT_GROWTH_PER_ITERATION = 1200;
export const AI_ESTIMATE_OUTPUT_TOKENS = 1024;

export interface BudgetSnapshot {
  limitCents: number;
  settledCents: number;
  /** Σ(reserved_cents − consumed_cents) das reservas HELD. */
  activeReservedRemainingCents: number;
}

/**
 * available = limite − LIQUIDADO − COMPROMETIDO.
 *
 * As três grandezas entram SEPARADAS (§17.5). Colapsar liquidado e reserva num
 * campo só torna impossível responder "quanto essa organização realmente custou
 * neste ciclo?" — que é a pergunta de que a margem da §13 depende.
 *
 * O comprometido é o RESTANTE (`reserved − consumed`), não o valor original: a
 * parte já consumida migra para `settled` na liquidação, e contá-la duas vezes
 * bloquearia organizações que ainda têm saldo.
 */
export function computeAvailableCents(s: BudgetSnapshot): number {
  const v = s.limitCents - s.settledCents - s.activeReservedRemainingCents;
  return v > 0 ? v : 0;
}

// ─── Janela do ciclo ────────────────────────────────────────────────────────

export interface CycleWindowInput {
  /** Data de HOJE em BRT (YYYY-MM-DD). O adapter converte; o núcleo não conhece fuso. */
  todayIso: string;
  /** Persistido no orçamento anterior. NUNCA re-derivado do vencimento atual. */
  anchorDay: number | null;
  subscriptionPeriodStartIso: string | null;
  subscriptionPeriodEndIso: string | null;
  orgCreatedAtIso: string;
}

export interface CycleWindow {
  /** INCLUSIVO. */
  cycleStart: string;
  /** EXCLUSIVO: primeiro dia NÃO coberto. */
  cycleEnd: string;
  anchorDay: number;
}

function dayOf(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCDate();
}

function ymd(year: number, month1: number, day: number): string {
  const dd = clampDayToMonth(year, month1, day);
  return `${year}-${String(month1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Resolve [cycleStart, cycleEnd) a partir do dia-âncora.
 *
 * A âncora é PERSISTIDA e nunca re-derivada do vencimento atual: sem isso,
 * âncora 31 degrada para 28 depois do primeiro fevereiro e nunca mais volta —
 * defeito já pago na 6b (`provider_cycle_anchor_day`).
 *
 * Origem da âncora, em ordem: orçamento anterior → fim do período da assinatura
 * de sistema → criação da organização. A terceira é fallback de organização sem
 * assinatura (cortesia, legado) e existe para que o ciclo nunca fique indefinido.
 */
export function resolveCycleWindow(input: CycleWindowInput): CycleWindow {
  const anchorDay =
    input.anchorDay ??
    dayOf(input.subscriptionPeriodEndIso) ??
    dayOf(input.subscriptionPeriodStartIso) ??
    dayOf(input.orgCreatedAtIso) ??
    1;

  const today = new Date(`${input.todayIso}T00:00:00Z`);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;

  // Marco deste mês, com clamp (30/02 vira 28/02).
  const thisMonthMark = ymd(y, m, anchorDay);

  let startY = y;
  let startM = m;
  if (input.todayIso < thisMonthMark) {
    // Ainda não chegamos à âncora deste mês: o ciclo corrente abriu no mês passado.
    startM = m - 1;
    if (startM === 0) {
      startM = 12;
      startY = y - 1;
    }
  }

  let endY = startY;
  let endM = startM + 1;
  if (endM === 13) {
    endM = 1;
    endY = startY + 1;
  }

  return {
    cycleStart: ymd(startY, startM, anchorDay),
    cycleEnd: ymd(endY, endM, anchorDay),
    anchorDay,
  };
}

// ─── Estimativa conservadora ────────────────────────────────────────────────

/**
 * `iteration` é 1-based. O contexto cresce a cada iteração (histórico acumulado,
 * tool results embutidos) — a 1ª e a 11ª têm perfis de custo diferentes, e é por
 * isso que `iteration`/`max_iterations` entram no contexto do `beforeCall`
 * (§17.7.2).
 *
 * `cache_read_tokens` estimado é ZERO de propósito: assumir cache hit barateia a
 * estimativa e a estimativa existe para ser cara.
 */
export function estimateCallTokens(iteration: number): AiUsageTokens {
  const it = iteration > 1 ? iteration : 1;
  return {
    input_tokens: AI_ESTIMATE_BASE_INPUT_TOKENS + (it - 1) * AI_ESTIMATE_INPUT_GROWTH_PER_ITERATION,
    output_tokens: AI_ESTIMATE_OUTPUT_TOKENS,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
  };
}

/** Estimativa da reserva inicial do turno: as primeiras `AI_TURN_INITIAL_CALLS` chamadas. */
export function estimateTurnCents(costOfCall: (usage: AiUsageTokens) => number): number {
  let total = 0;
  for (let i = 1; i <= AI_TURN_INITIAL_CALLS; i++) total += costOfCall(estimateCallTokens(i));
  return total;
}

// ─── Decisão por chamada ────────────────────────────────────────────────────

/**
 * D6: resultado DISCRIMINADO, nunca boolean.
 *
 * Um `Promise<boolean>` não diferencia teto atingido, preço desconhecido, usage
 * anterior pendente, erro de banco e falha de lock — e transformaria soluço de
 * infraestrutura em "franquia esgotada", com a copy errada ao cliente e o alerta
 * errado ao admin. `ERROR` e `DENY_BUDGET` levam ao mesmo destino operacional,
 * mas dizem coisas OPOSTAS, e só uma delas significa que a franquia acabou.
 */
export type BeforeCallDecision =
  | { kind: "ALLOW"; reservationId: string; remainingReservedCents: number }
  | { kind: "DENY_BUDGET"; reasonCode: string }
  | { kind: "DENY_PRICE_UNKNOWN"; provider: string; model: string }
  | { kind: "DENY_USAGE_UNRESOLVED"; reasonCode: string }
  | { kind: "ERROR"; retryable: boolean; sanitizedCode: string };

export interface BeforeCallContext {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  provider: string;
  model: string;
  /** 1-based. */
  iteration: number;
  maxIterations: number;
  reservationId: string;
  consumedCents: number;
  reservedCents: number;
  /** Estimativa máxima da PRÓXIMA chamada, já precificada. */
  nextCallEstimateCents: number;
}

export type NextCallPlan =
  | { kind: "ALLOW" }
  | { kind: "EXTEND"; additionalCents: number }
  | { kind: "DENY_USAGE_UNRESOLVED"; reasonCode: string };

/**
 * Parte PURA do `beforeCall`: dado o estado da reserva, o que precisa acontecer
 * antes da próxima chamada.
 *
 * `usageUnresolved` é checado PRIMEIRO e vence saldo: existe consumo anterior
 * cujo custo não pôde ser determinado, então não é possível afirmar que a
 * próxima chamada cabe — a mesma consequência do preço desconhecido, por uma
 * ignorância diferente (§17.2.1).
 */
export function planNextCall(
  ctx: BeforeCallContext,
  opts: { usageUnresolved: boolean },
): NextCallPlan {
  if (opts.usageUnresolved) {
    return { kind: "DENY_USAGE_UNRESOLVED", reasonCode: "prior_usage_unresolved" };
  }
  const remaining = ctx.reservedCents - ctx.consumedCents;
  if (remaining >= ctx.nextCallEstimateCents) return { kind: "ALLOW" };
  // SEM clamp de `remaining` a zero. Quando o turno já gastou mais do que
  // reservou (overage), `remaining` é NEGATIVO e a extensão precisa cobrir as
  // duas coisas: o déficit já incorrido E a próxima chamada. Clampar descarta a
  // magnitude do overage e devolve uma extensão que deixa o restante em zero —
  // autorizando uma chamada sem cobertura real, que é precisamente o que a
  // estimativa conservadora existe para impedir.
  const deficit = ctx.nextCallEstimateCents - remaining;
  return { kind: "EXTEND", additionalCents: deficit };
}

/** Linha devolvida pelas RPCs `reserve_ai_budget` / `extend_ai_reservation`. */
export interface ReserveDecisionRow {
  decision?: string | null;
  reason_code?: string | null;
  reservation_id?: string | null;
  reserved_cents?: number | null;
  consumed_cents?: number | null;
}

/**
 * Traduz a linha da RPC em decisão tipada.
 *
 * QUALQUER valor inesperado vira `ERROR` retriável — nunca `DENY_BUDGET`. Um
 * `decision` desconhecido é ignorância nossa sobre o banco, não afirmação de que
 * o cliente gastou a franquia.
 */
export function mapReserveDecision(row: ReserveDecisionRow | null | undefined): BeforeCallDecision {
  if (!row) return { kind: "ERROR", retryable: true, sanitizedCode: "reserve_no_row" };
  switch (row.decision) {
    case "ALLOW": {
      const reserved = row.reserved_cents ?? 0;
      const consumed = row.consumed_cents ?? 0;
      const remaining = reserved - consumed;
      return {
        kind: "ALLOW",
        reservationId: row.reservation_id ?? "",
        remainingReservedCents: remaining > 0 ? remaining : 0,
      };
    }
    case "DENY_BUDGET":
      return { kind: "DENY_BUDGET", reasonCode: row.reason_code ?? "cycle_exhausted" };
    case "DENY_USAGE_UNRESOLVED":
      return { kind: "DENY_USAGE_UNRESOLVED", reasonCode: row.reason_code ?? "prior_usage_unresolved" };
    default:
      return { kind: "ERROR", retryable: true, sanitizedCode: "reserve_unknown_decision" };
  }
}

/** Só o teto comercial. Falha técnica NUNCA responde `true` aqui. */
export function isCommercialHardStop(d: BeforeCallDecision): boolean {
  return d.kind === "DENY_BUDGET";
}

/** Um `evt` distinto por variante — a diferença que o boolean apagava. */
export function telemetryEventFor(d: BeforeCallDecision): string {
  switch (d.kind) {
    case "ALLOW":
      return "ai_budget_allow";
    case "DENY_BUDGET":
      return "ai_budget_deny_budget";
    case "DENY_PRICE_UNKNOWN":
      return "ai_budget_deny_price_unknown";
    case "DENY_USAGE_UNRESOLVED":
      return "ai_budget_deny_usage_unresolved";
    default:
      return "ai_budget_error";
  }
}

/** Razão de handoff exclusiva do teto — distingue de `agent_error` na telemetria e no painel. */
export const AI_BUDGET_HANDOFF_REASON = "ai_budget_exhausted";

/**
 * O auto-resolve de 12h devolveria a conversa para uma IA que não pode responder.
 * Com `ai_budget_exhausted`, só a virada do ciclo (orçamento não mais esgotado)
 * devolve — nunca o decurso do prazo.
 */
export function shouldAutoResolveHandoff(args: {
  handoffReason: string | null;
  ageMs: number;
  thresholdMs: number;
  budgetExhausted: boolean;
}): boolean {
  if (args.ageMs <= args.thresholdMs) return false;
  if (args.handoffReason === AI_BUDGET_HANDOFF_REASON && args.budgetExhausted) return false;
  return true;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/ai-budget-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Rodar os gates e commitar**

```bash
npm run typecheck
npx eslint supabase/functions/_shared/ai-budget-core.ts --max-warnings=0
git add supabase/functions/_shared/ai-budget-core.ts src/lib/ai-budget-core.test.ts
git commit -m "feat(plano-d): nucleo puro do orcamento de ciclo, estimativa e decisao por chamada"
```

---

## Task 3: Marcos e copy determinística

**Files:**
- Create: `supabase/functions/_shared/ai-budget-milestones-core.ts`
- Create: `supabase/functions/_shared/ai-budget-copy.ts`
- Test: `src/lib/ai-budget-milestones-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `AI_BUDGET_MILESTONE_PERCENTS`, `EVENT_TYPE_BY_MILESTONE_PERCENT`, `CANONICAL_AI_BUDGET_EVENT_TYPES`, `crossedMilestonePercents(settledCents, limitCents)`; e de `ai-budget-copy.ts`: `AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT`, `AI_BUDGET_STOP_AFTER_MUTATION_COMPLETED_TEXT`, `AI_BUDGET_STOP_AFTER_MUTATION_PENDING_TEXT`, `AI_BUDGET_STOP_AFTER_MUTATION_UNKNOWN_TEXT`, `AI_BUDGET_HARDCODED_TEXTS`, `resolveMutationStopText(outcome)`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/ai-budget-milestones-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AI_BUDGET_MILESTONE_PERCENTS,
  EVENT_TYPE_BY_MILESTONE_PERCENT,
  CANONICAL_AI_BUDGET_EVENT_TYPES,
  crossedMilestonePercents,
} from "../../supabase/functions/_shared/ai-budget-milestones-core";
import {
  AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
  AI_BUDGET_HARDCODED_TEXTS,
  resolveMutationStopText,
} from "../../supabase/functions/_shared/ai-budget-copy";

describe("marcos da franquia", () => {
  it("são exatamente quatro: 70, 80, 90 e 100 por cento", () => {
    expect([...AI_BUDGET_MILESTONE_PERCENTS]).toEqual([70, 80, 90, 100]);
  });

  it("com limite de R$ 100 os marcos caem em R$ 70/80/90/100", () => {
    expect(crossedMilestonePercents(6999, 10000)).toEqual([]);
    expect(crossedMilestonePercents(7000, 10000)).toEqual([70]);
    expect(crossedMilestonePercents(8000, 10000)).toEqual([70, 80]);
    expect(crossedMilestonePercents(9999, 10000)).toEqual([70, 80, 90]);
    expect(crossedMilestonePercents(10000, 10000)).toEqual([70, 80, 90, 100]);
    expect(crossedMilestonePercents(999999, 10000)).toEqual([70, 80, 90, 100]);
  });

  it("os marcos são proporcionais ao limite do ciclo, não valores absolutos", () => {
    // Um ciclo com limite diferente (plano CUSTOM futuro) mantém a mesma escada.
    expect(crossedMilestonePercents(140, 200)).toEqual([70]);
  });

  it("limite zero ou negativo não produz marco — nem divisão por zero", () => {
    expect(crossedMilestonePercents(0, 0)).toEqual([]);
    expect(crossedMilestonePercents(100, -1)).toEqual([]);
  });

  it("cada marco tem event_type próprio e a lista canônica é derivada, não redigitada", () => {
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[70]).toBe("admin_ai_budget_70");
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[80]).toBe("admin_ai_budget_80");
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[90]).toBe("admin_ai_budget_90");
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[100]).toBe("admin_ai_budget_stop");
    expect(CANONICAL_AI_BUDGET_EVENT_TYPES).toHaveLength(4);
    expect(new Set(CANONICAL_AI_BUDGET_EVENT_TYPES).size).toBe(4);
  });
});

describe("copy determinística do hard stop", () => {
  it("nunca expõe custo, tokens, modelo, margem ou o limite", () => {
    for (const text of AI_BUDGET_HARDCODED_TEXTS) {
      expect(text).not.toMatch(/R\$|centavo|token|margem|franquia|limite|100,00|IA|inteligência artificial/i);
    }
  });

  it("nunca afirma falha técnica", () => {
    for (const text of AI_BUDGET_HARDCODED_TEXTS) {
      expect(text).not.toMatch(/erro|falha|instabilidade|indisponível|problema técnico/i);
    }
  });

  it("o texto do hard stop encaminha para a equipe sem prometer prazo", () => {
    expect(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT).toMatch(/equipe/i);
    expect(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT.length).toBeLessThanOrEqual(4096);
  });

  it("as três situações de ferramenta mutante têm textos DIFERENTES", () => {
    const completed = resolveMutationStopText("COMPLETED");
    const pending = resolveMutationStopText("PENDING");
    const unknown = resolveMutationStopText("UNKNOWN");
    expect(new Set([completed, pending, unknown]).size).toBe(3);
  });

  it("só a situação concluída pode confirmar; pendente registra sem confirmar", () => {
    expect(resolveMutationStopText("COMPLETED")).toMatch(/confirmad/i);
    expect(resolveMutationStopText("PENDING")).not.toMatch(/confirmad/i);
    expect(resolveMutationStopText("PENDING")).toMatch(/registr/i);
  });

  it("a situação interrompida NÃO afirma nada sobre a ação", () => {
    const unknown = resolveMutationStopText("UNKNOWN");
    expect(unknown).not.toMatch(/confirmad|reservad|cancelad|alterad/i);
  });

  it("todos os textos estão na lista que entra no HARDCODED_AGENT_NOISE", () => {
    expect(AI_BUDGET_HARDCODED_TEXTS).toContain(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT);
    for (const o of ["COMPLETED", "PENDING", "UNKNOWN"] as const) {
      expect(AI_BUDGET_HARDCODED_TEXTS).toContain(resolveMutationStopText(o));
    }
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-milestones-core.test.ts`
Expected: FAIL — módulos não resolvem.

- [ ] **Step 3: Implementar os dois arquivos**

Criar `supabase/functions/_shared/ai-budget-milestones-core.ts`:

```ts
/**
 * Núcleo PURO dos marcos da franquia (spec §18.2). ZERO IMPORTS.
 *
 * FONTE CANÔNICA ÚNICA dos quatro `event_type`. Nenhum produtor pode emitir
 * string fora daqui — é a SEXTA ocorrência do acoplamento por string com
 * `TEMPLATE_BY_EVENT` de `process-billing-notifications`, e sem a entrada lá a
 * linha enfileirada morre em `failed/unknown_event_type` exatamente quando
 * importa. O teste bidirecional está em `src/lib/ai-budget-dispatcher.test.ts`.
 *
 * Os marcos são PERCENTUAIS do `limit_cents` do ciclo, não valores absolutos.
 * Com o limite de R$ 100 eles caem exatamente em R$ 70/80/90/100 da spec; com
 * um limite diferente (plano CUSTOM futuro) a escada acompanha, em vez de um
 * marco de R$ 70 virar "94% do teto" sem ninguém decidir isso.
 */

export const AI_BUDGET_MILESTONE_PERCENTS = [70, 80, 90, 100] as const;

export type AiBudgetMilestonePercent = (typeof AI_BUDGET_MILESTONE_PERCENTS)[number];

export const EVENT_TYPE_BY_MILESTONE_PERCENT: Record<number, string> = {
  70: "admin_ai_budget_70",
  80: "admin_ai_budget_80",
  90: "admin_ai_budget_90",
  100: "admin_ai_budget_stop",
};

/** Lista achatada, derivada — nunca redigitada. */
export const CANONICAL_AI_BUDGET_EVENT_TYPES: string[] = AI_BUDGET_MILESTONE_PERCENTS.map(
  (p) => EVENT_TYPE_BY_MILESTONE_PERCENT[p],
);

/**
 * Marcos já ultrapassados pelo custo LIQUIDADO do ciclo.
 *
 * Devolve TODOS os cruzados, não só o último: uma passada que salte de 60% para
 * 95% (turno caro) precisa registrar os três marcos, senão o ledger fica com
 * buracos e o admin nunca vê o aviso de 70%. A unicidade por ciclo é do ledger,
 * não desta função.
 */
export function crossedMilestonePercents(settledCents: number, limitCents: number): number[] {
  if (!Number.isFinite(settledCents) || !Number.isFinite(limitCents) || limitCents <= 0) return [];
  return AI_BUDGET_MILESTONE_PERCENTS.filter((p) => settledCents * 100 >= limitCents * p);
}
```

Criar `supabase/functions/_shared/ai-budget-copy.ts`:

```ts
/**
 * Textos DETERMINÍSTICOS enviados ao cliente final quando a IA é bloqueada
 * (spec §17.7.4, §18.3). ZERO IMPORTS.
 *
 * POR QUE NÃO GERAR COM IA: explicar que a IA foi bloqueada exigiria justamente
 * a chamada que foi negada. O texto é hardcoded, e entra no
 * `HARDCODED_AGENT_NOISE` do `webhook-whatsapp` no MESMO PR — precedente direto
 * de `MEDIA_REPLY_TEXT`. Sem isso, ele polui o histórico das invocações
 * seguintes e ensina o modelo que "atendimento interrompido" é o padrão.
 *
 * O DESTINATÁRIO É O CLIENTE DO RESTAURANTE, não o lojista. Nenhum texto aqui
 * pode citar custo em reais, tokens, preço de modelo, margem, o limite de
 * R$ 100 — nem a palavra "franquia", que é vocabulário do contrato entre a
 * plataforma e o lojista e não significa nada para quem quer reservar uma mesa.
 * A spec §18.3 apresenta um texto "conceitual" com esse vocabulário; ele descreve
 * o QUE comunicar (atendimento humano assume, nada quebrou), e a regra da própria
 * §18.3 — "nunca informar ao cliente ... o limite" — é o que fixa o vocabulário
 * final aqui. Desvio registrado em docs/billing-asaas/PLANO-D-PENDENCIAS.md.
 *
 * Também não pode afirmar falha técnica (§18.3): não houve falha nenhuma.
 */

/** Hard stop puro: nenhuma ferramenta mutante rodou neste turno. */
export const AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT =
  "Vou passar sua conversa para a equipe do restaurante. Sua mensagem já está registrada e alguém responde por aqui em instantes.";

/**
 * As TRÊS situações de §17.7.4. Usar a mesma frase para as três é o erro que
 * produz cliente aparecendo no restaurante sem mesa.
 */
export const AI_BUDGET_STOP_AFTER_MUTATION_COMPLETED_TEXT =
  "Pronto, sua solicitação foi confirmada. Vou passar a conversa para a equipe do restaurante, que segue com você por aqui.";

export const AI_BUDGET_STOP_AFTER_MUTATION_PENDING_TEXT =
  "Registrei sua solicitação — ela ainda depende de uma confirmação do restaurante. Passei a conversa para a equipe, que finaliza com você por aqui.";

export const AI_BUDGET_STOP_AFTER_MUTATION_UNKNOWN_TEXT =
  "Vou passar sua conversa para a equipe do restaurante agora. Eles verificam tudo com você por aqui antes de seguir.";

export type MutationOutcome = "COMPLETED" | "PENDING" | "UNKNOWN";

/**
 * Na dúvida, `UNKNOWN`. Afirmar conclusão de uma ação que ainda exige validação
 * é o único dos três erros que manda alguém para o restaurante sem mesa.
 */
export function resolveMutationStopText(outcome: MutationOutcome): string {
  if (outcome === "COMPLETED") return AI_BUDGET_STOP_AFTER_MUTATION_COMPLETED_TEXT;
  if (outcome === "PENDING") return AI_BUDGET_STOP_AFTER_MUTATION_PENDING_TEXT;
  return AI_BUDGET_STOP_AFTER_MUTATION_UNKNOWN_TEXT;
}

/**
 * TODOS os textos deste arquivo. `webhook-whatsapp` espalha esta lista dentro do
 * `HARDCODED_AGENT_NOISE` — importar a lista em vez de redigitar as frases é o
 * que impede que um texto novo apareça sem entrar no filtro.
 */
export const AI_BUDGET_HARDCODED_TEXTS: string[] = [
  AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
  AI_BUDGET_STOP_AFTER_MUTATION_COMPLETED_TEXT,
  AI_BUDGET_STOP_AFTER_MUTATION_PENDING_TEXT,
  AI_BUDGET_STOP_AFTER_MUTATION_UNKNOWN_TEXT,
];
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/ai-budget-milestones-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Rodar os gates e commitar**

```bash
npm run typecheck
npx eslint supabase/functions/_shared/ai-budget-milestones-core.ts supabase/functions/_shared/ai-budget-copy.ts --max-warnings=0
git add supabase/functions/_shared/ai-budget-milestones-core.ts supabase/functions/_shared/ai-budget-copy.ts src/lib/ai-budget-milestones-core.test.ts
git commit -m "feat(plano-d): marcos da franquia e copy deterministica do hard stop"
```

---

## Índice das partes

| Arquivo | Tarefas |
|---|---|
| `2026-08-03-plano-d-franquia-ia.md` (este) | Global Constraints, File Structure, Tasks **1-3** (núcleos puros) |
| `...-parte-2.md` | Tasks **4-6** — migrations 099-103 |
| `...-parte-3.md` | Tasks **7-9** — entitlement, templates do dispatcher, autorizador |
| `...-parte-4.md` | Tasks **10-11** — `ai-providers.ts` e o adapter de I/O |
| `...-parte-5.md` | Tasks **12-13** — `webhook-whatsapp`, pendências, gates finais, self-review |
