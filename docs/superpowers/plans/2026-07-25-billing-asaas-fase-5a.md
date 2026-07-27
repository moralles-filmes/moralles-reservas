# Fase 5a (Comercial) — Implantação do WhatsApp (R$ 750) + assinatura da instância (R$ 149)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vender e rastrear dois produtos novos — a implantação avulsa de R$ 750 e a assinatura mensal da instância de R$ 149 — sem que nenhum deles possa bloquear, desbloquear ou cancelar a organização inteira.

**Architecture:** Uma tabela nova (`whatsapp_implementations`) com estado financeiro e operacional separados; correlação de pagamento pelo `billing_checkout_sessions` já existente, agora com ciclo de vida; resolução de assinatura por **categoria do plano** através de uma RPC com advisory lock, substituindo o `maybeSingle()` que quebra assim que a org tem duas assinaturas; e um sweep que faz todo writer de `organizations.billing_status` exigir categoria `SYSTEM_SUBSCRIPTION`. A `create-billing-checkout` é dividida em roteador + contexto + um handler por `purpose`, e o painel administrativo ganha uma Edge Function própria (`manage-whatsapp-implementations`), porque `manage-billing` já tem 1347 linhas.

**Tech Stack:** Postgres/Supabase (migrations SQL idempotentes, RLS FORCE, RPC `SECURITY DEFINER`), Edge Functions Deno, React + TanStack Query, vitest para os núcleos puros.

**Spec:** [2026-07-25-billing-asaas-fase-5a-design.md](../specs/2026-07-25-billing-asaas-fase-5a-design.md). O plano-mãe é [01-PLANO-IMPLEMENTACAO.md](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md); a API verificada ao vivo está em [03-ASAAS-API-VERIFICADO.md](../../billing-asaas/03-ASAAS-API-VERIFICADO.md).

---

## Global Constraints

Valem para **todas** as tasks. Não repetidas em cada uma.

1. **Nada nesta fase suspende, silencia ou bloqueia serviço.** Enforcement é a Fase 5b. Se uma task parecer precisar de um gate de execução, ela saiu do escopo.
2. **Só assinatura/fatura de categoria `SYSTEM_SUBSCRIPTION` pode escrever `organizations.billing_status`.** Invariante novo da fase; vale para worker, webhook, EF e RPC.
3. **Valores monetários sempre em centavos inteiros no nosso lado**, carregados de `billing_plans` **no servidor**. O navegador nunca envia preço, categoria, modalidade ou intervalo. A conversão para reais decimais acontece só na fronteira do `AsaasBillingProvider`.
4. **Nunca criar id falso do Asaas.** `billing_invoice_id`, `provider_checkout_id` e `provider_subscription_id` só recebem valor quando existe a operação real no Asaas.
5. **`grant_type` no banco continua `LIFETIME | TEMPORARY | PROMOTIONAL | MANUAL_OVERRIDE`.** Rótulos de UI (Acesso vitalício / Acesso temporário / Cortesia / Override administrativo) vivem num mapa único em `src/types/billing.ts`. Não ampliar o CHECK para criar sinônimos.
6. **Migrations são aditivas e idempotentes**, formato `YYYYMMDDHHMMSS_NNN_nome.sql`, aplicadas **só** por `supabase db push` (nunca colar no SQL Editor — grava `version ≠ filename` e trava o próximo push por drift).
7. **Edge Function nunca devolve `error.message` cru do Postgres.** Mensagem curta em PT-BR para o cliente; detalhe em `jsonLog`.
8. **`npm run typecheck` é `tsc -b --noEmit`.** Nunca `tsc --noEmit` sem `-b` (o root tem `files: []` + references e vira no-op silencioso).
9. **Deno não está instalado nesta máquina.** Arquivos em `supabase/functions/` **não** são verificados por `tsc`; a única checagem automática que os alcança é o vitest sobre os núcleos puros importados de `src/`. Por isso: todo pedaço de lógica testável vira núcleo puro, e o resto é verificado por revisão + roteiro de sandbox da Task 17.
10. **Antes de commitar:** `git status` + `git diff --cached`, `git add <caminho>` explícito (nunca `git add .`), varredura de secrets (`sk-`, `eyJ`, `service_role`, `Bearer `, URLs com credenciais).
11. **Commits em português**, prefixo convencional (`feat:`, `fix:`, `chore:`, `docs:`), sem acentos no assunto (o repositório já segue esse padrão).
12. **Branch:** `billing-asaas/fase-5a` (já criada a partir de `main`, commit inicial `f2e4397` com a spec).

### Desvios conscientes da spec (decididos ao escrever o plano)

| Ponto | Spec | Plano | Porquê |
|---|---|---|---|
| Nome da coluna de plano em `billing_checkout_sessions` | `billing_plan_id` | **`plan_id`** | É o nome real da coluna criada na migration 067. A spec errou o nome. |
| Módulo de categoria | não previsto | **`_shared/billing-category.ts`** novo | Cinco arquivos do sweep precisam da mesma pergunta ("essa fatura/assinatura é de sistema?"). Duplicar em cinco lugares é como o bug atual nasceu. |
| Destinatário do aviso `implementation_paid` | "para os platform admins" (plural) | `resolvePlatformAdminRecipients()` devolve a lista, mas **enfileira só para `recipients[0]`** | O UNIQUE `(organization_id, event_type, invoice_id)` deduplica linhas, e `sendEmail` aceita um único `to`. Enfileirar N linhas faria N-1 sumirem em silêncio. A lista completa vai para o log. |
| Sites do sweep | 7 linhas na tabela §7 | **8** | `manage-billing` action `create_subscription` também escreve `organizations.billing_status` e não estava mapeado. |

---

## File Structure

**Migrations (criadas):**

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260726100000_071_whatsapp_implementations.sql` | Tabela de implantação: estados separados, matriz origem×pagamento, uma aberta por org, RLS admin-only, auditoria |
| `supabase/migrations/20260726100100_072_billing_checkout_sessions_lifecycle.sql` | PK surrogate, `status`, `checkout_url`, `expires_at`, UNIQUE de sessão ativa |
| `supabase/migrations/20260726100200_073_billing_subscription_category.sql` | UNIQUE `(org, plano)` não-cancelada + RPC `resolve_or_activate_subscription` |
| `supabase/migrations/20260726100300_074_billing_plans_category_guard.sql` | Trigger que recusa troca de `category` com assinatura viva |
| `supabase/migrations/20260726100400_075_platform_flags_whatsapp.sql` | Flags `whatsapp_subscription_checkout` e `whatsapp_service_enforcement` |
| `supabase/migrations/20260726100500_076_activate_whatsapp_plans.sql` | Liga os dois planos no catálogo — última da fase |

**Backend compartilhado:**

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/_shared/whatsapp-implementation-core.ts` *(novo, puro)* | Matriz origem×pagamento, transições operacionais, elegibilidade da instância, projeção do cliente, resumo de custos |
| `supabase/functions/_shared/billing-category.ts` *(novo)* | "Essa fatura/assinatura é de sistema?" — única fonte do sweep |
| `supabase/functions/_shared/checkout-sessions.ts` *(novo)* | Reserva, promoção e expiração das sessões de checkout — usado pelas duas EFs que abrem cobrança |
| `supabase/functions/_shared/entitlement-overrides.ts` *(novo)* | `grantOverride` / `revokeOverride` — único writer de `organization_entitlement_overrides` |
| `supabase/functions/_shared/implementation-checkout.ts` *(novo)* | Abre o checkout DETACHED de R$ 750 e cria a linha de implantação — usado pelo cliente e pelo admin |
| `supabase/functions/_shared/billing-notify.ts` *(modificado)* | `+ resolvePlatformAdminRecipients()` |
| `supabase/functions/_shared/asaas-billing-events-apply.ts` *(modificado)* | Assinatura por categoria via RPC; `organizations` só no caminho de sistema; confirmação da implantação; sessão → `used` |
| `supabase/functions/_shared/billing-provider.ts` *(modificado)* | `+ minutesToExpire` em `CreateCheckoutParams` |

**Edge Functions:**

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/create-billing-checkout/index.ts` *(reescrito)* | Auth, parse, permissão, roteamento por `purpose` |
| `supabase/functions/create-billing-checkout/context.ts` *(novo)* | Org, plano, cliente Asaas, gates de flag, ciclo de vida da sessão |
| `supabase/functions/create-billing-checkout/subscription.ts` *(novo)* | `purpose=subscription` (sistema e instância) + `payment_method_update` |
| `supabase/functions/create-billing-checkout/eligibility.ts` *(novo)* | Elegibilidade por categoria — os cinco gates da instância de R$ 149 |
| `supabase/functions/create-billing-checkout/implementation.ts` *(novo)* | `purpose=implementation` |
| `supabase/functions/manage-whatsapp-implementations/index.ts` *(novo)* | Painel admin da implantação + overrides + projeção do cliente |
| `supabase/functions/process-billing-{overdue,reminders,unblock,reconcile}/index.ts`, `process-trial-expiry/index.ts`, `manage-billing/index.ts` *(modificados)* | Sweep de category-awareness |
| `supabase/functions/process-billing-notifications/index.ts` *(modificado)* | Template `implementation_paid` |
| `supabase/config.toml` *(modificado)* | `verify_jwt = true` para a EF nova |

**Frontend:**

| Arquivo | Responsabilidade |
|---|---|
| `src/types/billing.ts` *(modificado)* | Tipos da implantação + `ENTITLEMENT_GRANT_TYPE_LABEL` |
| `src/hooks/useWhatsappImplementation.ts` *(novo)* | Queries/mutations da EF nova |
| `src/hooks/useBilling.ts` *(modificado)* | `purpose` no lugar de `mode` |
| `src/components/gestao/AutomacaoWhatsappCard.tsx` *(novo)* | Card do cliente + resumo consolidado |
| `src/pages/gestao/Cobranca.tsx` *(modificado)* | Monta o card |
| `src/pages/platform/WhatsappImplementations.tsx` *(novo)* | Lista e detalhe administrativos |
| `src/pages/platform/BillingDetail.tsx` *(modificado)* | Bloco Implantação + bloco WhatsApp |
| `src/App.tsx` *(modificado)* | Rota `/platform/billing/implementacoes` |

**Testes:** `src/lib/whatsapp-implementation-core.test.ts` *(novo)*.

**Docs:** `docs/billing-asaas/FASE-5A-RESUMO.md` *(novo)*, `CLAUDE.md` *(modificado)*.

---

## Task 1: Núcleo puro da implantação

O único código desta fase que o CI consegue testar. Tudo que for regra de negócio decidível sem I/O mora aqui, e as Edge Functions das tasks seguintes chamam estas funções em vez de reimplementar a regra.

**Files:**
- Create: `supabase/functions/_shared/whatsapp-implementation-core.ts`
- Test: `src/lib/whatsapp-implementation-core.test.ts`

**Interfaces:**
- Consumes: nada. Módulo de **zero imports** (mesmo contrato de `entitlements-core.ts` e `billing-delinquency-core.ts`) — um único `import` de `https://esm.sh/...`, ainda que só de tipo, quebra a resolução do Vite para o vitest.
- Produces:
  - `type ImplementationOrigin = "ASAAS" | "EXTERNAL_PAYMENT" | "COURTESY" | "ADMIN_OVERRIDE"`
  - `type ImplementationPaymentStatus = "PENDING" | "CONFIRMED" | "WAIVED" | "REFUNDED" | "CHARGEBACK" | "CANCELED"`
  - `type ImplementationOperationalStatus = "NOT_STARTED" | "SCHEDULED" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "COMPLETED" | "CANCELED"`
  - `validateOriginPayment(origin, paymentStatus): boolean`
  - `canTransitionOperational(from, to, paymentStatus): { ok: boolean; reason: string | null }`
  - `canContractInstance(input: CanContractInstanceInput): { ok: boolean; reason: InstanceBlockReason | null }`
  - `buildClientImplementationView(row: ImplementationRowLike | null): ClientImplementationView`
  - `summarizeMonthlyCosts(input: MonthlyCostInput): MonthlyCostSummary`
  - `SETTLED_PAYMENT_STATUSES: ReadonlySet<ImplementationPaymentStatus>`

- [ ] **Step 1: Escrever o teste que falha**

Crie `src/lib/whatsapp-implementation-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  validateOriginPayment,
  canTransitionOperational,
  canContractInstance,
  buildClientImplementationView,
  summarizeMonthlyCosts,
  SETTLED_PAYMENT_STATUSES,
} from "../../supabase/functions/_shared/whatsapp-implementation-core";

describe("validateOriginPayment", () => {
  it("pagamento externo é CONFIRMED e nunca WAIVED", () => {
    expect(validateOriginPayment("EXTERNAL_PAYMENT", "CONFIRMED")).toBe(true);
    expect(validateOriginPayment("EXTERNAL_PAYMENT", "WAIVED")).toBe(false);
    expect(validateOriginPayment("EXTERNAL_PAYMENT", "PENDING")).toBe(false);
  });

  it("cortesia e override são WAIVED e nunca CONFIRMED", () => {
    expect(validateOriginPayment("COURTESY", "WAIVED")).toBe(true);
    expect(validateOriginPayment("ADMIN_OVERRIDE", "WAIVED")).toBe(true);
    expect(validateOriginPayment("COURTESY", "CONFIRMED")).toBe(false);
    expect(validateOriginPayment("ADMIN_OVERRIDE", "PENDING")).toBe(false);
  });

  it("Asaas aceita o ciclo completo, inclusive estorno e chargeback", () => {
    for (const s of ["PENDING", "CONFIRMED", "REFUNDED", "CHARGEBACK", "CANCELED"] as const) {
      expect(validateOriginPayment("ASAAS", s)).toBe(true);
    }
    expect(validateOriginPayment("ASAAS", "WAIVED")).toBe(false);
  });
});

describe("canTransitionOperational", () => {
  it("recusa COMPLETED enquanto o pagamento está PENDING", () => {
    const r = canTransitionOperational("IN_PROGRESS", "COMPLETED", "PENDING");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("payment_not_settled");
  });

  it("aceita COMPLETED com pagamento CONFIRMED ou WAIVED", () => {
    expect(canTransitionOperational("IN_PROGRESS", "COMPLETED", "CONFIRMED").ok).toBe(true);
    expect(canTransitionOperational("WAITING_CUSTOMER", "COMPLETED", "WAIVED").ok).toBe(true);
  });

  it("estorno DEPOIS da entrega não desfaz a entrega — COMPLETED é terminal", () => {
    // A transição para COMPLETED nunca parte de um pagamento estornado...
    expect(canTransitionOperational("IN_PROGRESS", "COMPLETED", "REFUNDED").ok).toBe(false);
    // ...mas uma vez COMPLETED, nada o move (o estorno só muda payment_status).
    expect(canTransitionOperational("COMPLETED", "IN_PROGRESS", "REFUNDED").ok).toBe(false);
    expect(canTransitionOperational("COMPLETED", "CANCELED", "CHARGEBACK").ok).toBe(false);
  });

  it("CANCELED é terminal e alcançável de qualquer estado vivo", () => {
    expect(canTransitionOperational("NOT_STARTED", "CANCELED", "PENDING").ok).toBe(true);
    expect(canTransitionOperational("WAITING_CUSTOMER", "CANCELED", "CONFIRMED").ok).toBe(true);
    expect(canTransitionOperational("CANCELED", "NOT_STARTED", "CONFIRMED").ok).toBe(false);
  });

  it("recusa salto para o mesmo estado e transições fora do grafo", () => {
    expect(canTransitionOperational("NOT_STARTED", "NOT_STARTED", "CONFIRMED").ok).toBe(false);
    expect(canTransitionOperational("NOT_STARTED", "COMPLETED", "CONFIRMED").ok).toBe(false);
  });
});

describe("canContractInstance", () => {
  const base = {
    flagEnabled: true,
    implementationOperationalStatus: "COMPLETED" as const,
    systemAllowed: true,
    hasActiveWhatsappSubscription: false,
    hasActiveWhatsappOverride: false,
  };

  it("libera quando tudo está no lugar", () => {
    expect(canContractInstance(base)).toEqual({ ok: true, reason: null });
  });

  it("bloqueia a mensalidade enquanto a implantação não terminou", () => {
    expect(canContractInstance({ ...base, implementationOperationalStatus: "IN_PROGRESS" }).reason)
      .toBe("implementation_incomplete");
    expect(canContractInstance({ ...base, implementationOperationalStatus: null }).reason)
      .toBe("implementation_incomplete");
  });

  it("implantação em cortesia não libera a mensalidade sozinha — quem libera é o COMPLETED", () => {
    // Cortesia entrega a implantação (WAIVED/COMPLETED); a instância segue sendo
    // uma contratação à parte, e continua bloqueada enquanto o operacional não fecha.
    expect(canContractInstance({ ...base, implementationOperationalStatus: "WAITING_CUSTOMER" }).ok).toBe(false);
  });

  it("nunca cobra quem já tem cortesia de WhatsApp", () => {
    expect(canContractInstance({ ...base, hasActiveWhatsappOverride: true }).reason).toBe("override_active");
  });

  it("não vende duas instâncias nem vende para sistema bloqueado", () => {
    expect(canContractInstance({ ...base, hasActiveWhatsappSubscription: true }).reason).toBe("already_subscribed");
    expect(canContractInstance({ ...base, systemAllowed: false }).reason).toBe("system_not_allowed");
  });

  it("flag desligada barra antes de qualquer outra checagem", () => {
    expect(canContractInstance({ ...base, flagEnabled: false, systemAllowed: false }).reason).toBe("flag_off");
  });
});

describe("buildClientImplementationView", () => {
  it("ausência de linha é NOT_REQUESTED, não erro", () => {
    const v = buildClientImplementationView(null);
    expect(v.state).toBe("NOT_REQUESTED");
    expect(v.payment_status).toBeNull();
    expect(v.operational_status).toBeNull();
  });

  it("nunca vaza campo interno", () => {
    const v = buildClientImplementationView({
      payment_status: "CONFIRMED",
      operational_status: "IN_PROGRESS",
      amount_cents: 75000,
      paid_at: "2026-07-26T12:00:00Z",
      scheduled_for: "2026-07-28",
      started_at: "2026-07-27T12:00:00Z",
      completed_at: null,
      notes: "cliente reclamou do prazo",
      reason: "cortesia combinada com o dono",
      external_payment_reference: "NF 1234",
      owner_admin_id: "11111111-1111-1111-1111-111111111111",
      created_by: "22222222-2222-2222-2222-222222222222",
    });
    const keys = Object.keys(v);
    for (const forbidden of ["notes", "reason", "external_payment_reference", "owner_admin_id", "created_by"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("mapeia pagamento pendente para AWAITING_PAYMENT sem prometer prazo", () => {
    const v = buildClientImplementationView({
      payment_status: "PENDING", operational_status: "NOT_STARTED",
      amount_cents: 75000, paid_at: null, scheduled_for: null,
      started_at: null, completed_at: null,
    });
    expect(v.state).toBe("AWAITING_PAYMENT");
    expect(v.next_step).not.toMatch(/\d+\s*(dia|hora|semana)/i);
  });

  it("estorno após a entrega continua COMPLETED para o cliente", () => {
    const v = buildClientImplementationView({
      payment_status: "REFUNDED", operational_status: "COMPLETED",
      amount_cents: 75000, paid_at: "2026-07-01T12:00:00Z", scheduled_for: null,
      started_at: "2026-07-02T12:00:00Z", completed_at: "2026-07-05T12:00:00Z",
    });
    expect(v.state).toBe("COMPLETED");
  });
});

describe("summarizeMonthlyCosts", () => {
  const plans = {
    systemMonthlyCents: 44900,
    instanceMonthlyCents: 14900,
    implementationOneTimeCents: 75000,
  };

  it("devolve os quatro números antes de qualquer contratação", () => {
    expect(summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: false,
      whatsappSponsored: false,
      implementationSettled: false,
      systemSponsored: false,
    })).toEqual({
      currentMonthlyCents: 44900,
      projectedMonthlyCents: 59800,
      oneTimeDueCents: 75000,
      aiVariable: true,
    });
  });

  it("com a instância contratada, o mensal atual passa a incluir os R$ 149", () => {
    const s = summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: true,
      whatsappSponsored: false,
      implementationSettled: true,
      systemSponsored: false,
    });
    expect(s.currentMonthlyCents).toBe(59800);
    expect(s.projectedMonthlyCents).toBe(59800);
    expect(s.oneTimeDueCents).toBe(0);
  });

  it("override de WhatsApp zera a parte do WhatsApp, não a do sistema", () => {
    const s = summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: false,
      whatsappSponsored: true,
      implementationSettled: true,
      systemSponsored: false,
    });
    expect(s.currentMonthlyCents).toBe(44900);
    expect(s.projectedMonthlyCents).toBe(44900);
  });

  it("cortesia de sistema zera o mensal inteiro (caso Ren Sushi)", () => {
    const s = summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: false,
      whatsappSponsored: true,
      implementationSettled: true,
      systemSponsored: true,
    });
    expect(s.currentMonthlyCents).toBe(0);
    expect(s.projectedMonthlyCents).toBe(0);
  });
});

describe("SETTLED_PAYMENT_STATUSES", () => {
  it("inclui estorno e chargeback — a entrega já aconteceu", () => {
    expect([...SETTLED_PAYMENT_STATUSES].sort())
      .toEqual(["CHARGEBACK", "CONFIRMED", "REFUNDED", "WAIVED"]);
  });
});

// Interação com o resolver de entitlements. Vive neste arquivo (e não no
// entitlements-core.test.ts) porque é a Fase 5a que introduz o override de
// WhatsApp de verdade — antes dela nenhum código concedia um.
describe("override de WhatsApp × entitlements", () => {
  const base = {
    billingStatus: "active",
    trialEndsAt: null,
    subscriptions: [],
  };

  it("override de WhatsApp NÃO libera IA", () => {
    const e = resolveEntitlements({
      ...base,
      billingStatus: "blocked",
      overrides: [{
        feature: "whatsapp", enabled: true, grant_type: "LIFETIME",
        starts_at: "2026-01-01T00:00:00Z", ends_at: null, revoked_at: null,
      }],
      // Carteira implantada: sem ela, `ai` herda `system` e o teste não provaria nada.
      aiWalletBalanceCents: 0,
    });
    expect(e.whatsapp.allowed).toBe(true);
    expect(e.ai.allowed).toBe(false);
    expect(e.system.allowed).toBe(false);
  });

  it("LIFETIME não expira; TEMPORARY deixa de valer depois de ends_at", () => {
    const lifetime = {
      feature: "whatsapp" as const, enabled: true, grant_type: "LIFETIME" as const,
      starts_at: "2026-01-01T00:00:00Z", ends_at: null, revoked_at: null,
    };
    const temporary = {
      feature: "whatsapp" as const, enabled: true, grant_type: "TEMPORARY" as const,
      starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-07-01T00:00:00Z", revoked_at: null,
    };
    expect(resolveEntitlements({
      ...base, overrides: [lifetime], now: "2030-01-01T00:00:00Z",
    }).whatsapp.allowed).toBe(true);
    expect(resolveEntitlements({
      ...base, overrides: [temporary], now: "2026-06-30T00:00:00Z",
    }).whatsapp.allowed).toBe(true);
    expect(resolveEntitlements({
      ...base, overrides: [temporary], now: "2026-07-02T00:00:00Z",
    }).whatsapp.allowed).toBe(false);
  });

  it("revogar volta a exigir assinatura paga", () => {
    const revoked = {
      feature: "whatsapp" as const, enabled: true, grant_type: "LIFETIME" as const,
      starts_at: "2026-01-01T00:00:00Z", ends_at: null,
      revoked_at: "2026-07-20T00:00:00Z",
    };
    expect(resolveEntitlements({ ...base, overrides: [revoked] }).whatsapp.allowed).toBe(false);
    expect(resolveEntitlements({
      ...base,
      overrides: [revoked],
      subscriptions: [{ status: "active", category: "WHATSAPP_SUBSCRIPTION", current_period_end: null }],
    }).whatsapp.allowed).toBe(true);
  });
});
```

O import do resolver, no topo do arquivo de teste:

```ts
import { resolveEntitlements } from "../../supabase/functions/_shared/entitlements-core";
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
npm run test -- whatsapp-implementation-core
```
Esperado: FAIL — `Failed to resolve import ".../whatsapp-implementation-core"`.

- [ ] **Step 3: Escrever o núcleo**

Crie `supabase/functions/_shared/whatsapp-implementation-core.ts`:

```ts
/**
 * Núcleo PURO da implantação do WhatsApp (Fase 5a).
 *
 * ZERO imports — importável tanto pelas Edge Functions quanto pelo vitest a
 * partir de src/ (mesmo contrato de entitlements-core.ts e
 * billing-delinquency-core.ts). Um import de https://esm.sh/..., mesmo só de
 * tipo, quebra a resolução do Vite e derruba a suíte inteira.
 *
 * As mesmas regras existem como CHECK constraint na migration 071. A duplicação
 * é deliberada: o banco é a garantia, este módulo é a mensagem de erro decente.
 */

export type ImplementationOrigin =
  | "ASAAS"
  | "EXTERNAL_PAYMENT"
  | "COURTESY"
  | "ADMIN_OVERRIDE";

export type ImplementationPaymentStatus =
  | "PENDING"
  | "CONFIRMED"
  | "WAIVED"
  | "REFUNDED"
  | "CHARGEBACK"
  | "CANCELED";

export type ImplementationOperationalStatus =
  | "NOT_STARTED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "WAITING_CUSTOMER"
  | "COMPLETED"
  | "CANCELED";

/**
 * Matriz origem × pagamento. Espelha whatsapp_impl_origin_payment_chk.
 *
 * Pagamento externo é CONFIRMED com valor e data reais (entra em relatório
 * financeiro); cortesia e override são WAIVED (não entram). Trocar um pelo
 * outro falsifica o faturamento nas duas direções.
 */
export const ORIGIN_PAYMENT_MATRIX: Readonly<
  Record<ImplementationOrigin, readonly ImplementationPaymentStatus[]>
> = {
  ASAAS: ["PENDING", "CONFIRMED", "REFUNDED", "CHARGEBACK", "CANCELED"],
  EXTERNAL_PAYMENT: ["CONFIRMED", "REFUNDED", "CANCELED"],
  COURTESY: ["WAIVED", "CANCELED"],
  ADMIN_OVERRIDE: ["WAIVED", "CANCELED"],
};

export function validateOriginPayment(
  origin: ImplementationOrigin,
  paymentStatus: ImplementationPaymentStatus,
): boolean {
  return (ORIGIN_PAYMENT_MATRIX[origin] ?? []).includes(paymentStatus);
}

/**
 * Pagamento "resolvido": a entrega pode ser dada como concluída, ou já foi.
 *
 * REFUNDED e CHARGEBACK estão aqui porque estorno DEPOIS da entrega não desfaz
 * o trabalho — a linha continua COMPLETED e o dinheiro é tratado como caso
 * comercial. A TRANSIÇÃO para COMPLETED é mais estrita (ver
 * canTransitionOperational): só CONFIRMED ou WAIVED autorizam concluir.
 */
export const SETTLED_PAYMENT_STATUSES: ReadonlySet<ImplementationPaymentStatus> =
  new Set(["CONFIRMED", "WAIVED", "REFUNDED", "CHARGEBACK"]);

/** Pagamento que autoriza CONCLUIR a implantação agora. */
const COMPLETABLE_PAYMENT_STATUSES: ReadonlySet<ImplementationPaymentStatus> =
  new Set(["CONFIRMED", "WAIVED"]);

/** Grafo de transições. COMPLETED e CANCELED são terminais. */
export const OPERATIONAL_TRANSITIONS: Readonly<
  Record<ImplementationOperationalStatus, readonly ImplementationOperationalStatus[]>
> = {
  NOT_STARTED: ["SCHEDULED", "IN_PROGRESS", "CANCELED"],
  SCHEDULED: ["IN_PROGRESS", "WAITING_CUSTOMER", "CANCELED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "COMPLETED", "CANCELED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "COMPLETED", "CANCELED"],
  COMPLETED: [],
  CANCELED: [],
};

export function canTransitionOperational(
  from: ImplementationOperationalStatus,
  to: ImplementationOperationalStatus,
  paymentStatus: ImplementationPaymentStatus,
): { ok: boolean; reason: string | null } {
  if (!(OPERATIONAL_TRANSITIONS[from] ?? []).includes(to)) {
    return { ok: false, reason: "invalid_transition" };
  }
  if (to === "COMPLETED" && !COMPLETABLE_PAYMENT_STATUSES.has(paymentStatus)) {
    return { ok: false, reason: "payment_not_settled" };
  }
  return { ok: true, reason: null };
}

export type InstanceBlockReason =
  | "flag_off"
  | "implementation_incomplete"
  | "system_not_allowed"
  | "already_subscribed"
  | "override_active";

export interface CanContractInstanceInput {
  flagEnabled: boolean;
  /** null = organização sem nenhuma implantação registrada. */
  implementationOperationalStatus: ImplementationOperationalStatus | null;
  systemAllowed: boolean;
  hasActiveWhatsappSubscription: boolean;
  hasActiveWhatsappOverride: boolean;
}

/**
 * Ordem das checagens importa: a razão devolvida vira mensagem para o operador,
 * e "a flag está desligada" é mais útil que "seu sistema está bloqueado" quando
 * as duas coisas são verdade.
 */
export function canContractInstance(
  i: CanContractInstanceInput,
): { ok: boolean; reason: InstanceBlockReason | null } {
  if (!i.flagEnabled) return { ok: false, reason: "flag_off" };
  if (i.implementationOperationalStatus !== "COMPLETED") {
    return { ok: false, reason: "implementation_incomplete" };
  }
  if (!i.systemAllowed) return { ok: false, reason: "system_not_allowed" };
  if (i.hasActiveWhatsappSubscription) return { ok: false, reason: "already_subscribed" };
  // Cobrar quem já tem cortesia é pior que negar a venda.
  if (i.hasActiveWhatsappOverride) return { ok: false, reason: "override_active" };
  return { ok: true, reason: null };
}

export type ClientImplementationState =
  | "NOT_REQUESTED"
  | "AWAITING_PAYMENT"
  | "PAID_NOT_STARTED"
  | "IN_PROGRESS"
  | "WAITING_CUSTOMER"
  | "COMPLETED"
  | "CANCELED";

/** Subconjunto da linha que a projeção lê. Campos internos podem vir junto —
 *  a projeção existe justamente para descartá-los. */
export interface ImplementationRowLike {
  payment_status: ImplementationPaymentStatus;
  operational_status: ImplementationOperationalStatus;
  amount_cents: number | null;
  paid_at: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  [key: string]: unknown;
}

export interface ClientImplementationView {
  state: ClientImplementationState;
  payment_status: ImplementationPaymentStatus | null;
  operational_status: ImplementationOperationalStatus | null;
  amount_cents: number | null;
  paid_at: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** Frase para o cliente. NUNCA promete prazo — a operação é manual. */
  next_step: string;
}

const NEXT_STEP: Record<ClientImplementationState, string> = {
  NOT_REQUESTED:
    "Contrate a implantação para ativar o atendimento automático no WhatsApp.",
  AWAITING_PAYMENT:
    "Estamos aguardando a confirmação do pagamento. Assim que ela chegar, avisamos por aqui.",
  PAID_NOT_STARTED:
    "Pagamento confirmado. Nossa equipe vai entrar em contato para combinar a configuração.",
  IN_PROGRESS: "A configuração do seu WhatsApp está em andamento.",
  WAITING_CUSTOMER: "Precisamos de uma informação sua para continuar a configuração.",
  COMPLETED: "Implantação concluída.",
  CANCELED: "Esta implantação foi cancelada. Fale com o suporte para retomar.",
};

/**
 * Projeção SEGURA para o cliente. Constrói um objeto novo campo a campo — nunca
 * spread da linha — porque a tabela carrega notas internas, motivo da cortesia,
 * referência de pagamento e responsáveis. Um `...row` aqui vazaria tudo isso no
 * primeiro campo novo que alguém adicionar.
 */
export function buildClientImplementationView(
  row: ImplementationRowLike | null,
): ClientImplementationView {
  if (!row) {
    return {
      state: "NOT_REQUESTED",
      payment_status: null,
      operational_status: null,
      amount_cents: null,
      paid_at: null,
      scheduled_for: null,
      started_at: null,
      completed_at: null,
      next_step: NEXT_STEP.NOT_REQUESTED,
    };
  }

  let state: ClientImplementationState;
  if (row.operational_status === "CANCELED" || row.payment_status === "CANCELED") {
    state = "CANCELED";
  } else if (row.operational_status === "COMPLETED") {
    state = "COMPLETED";
  } else if (row.payment_status === "PENDING") {
    state = "AWAITING_PAYMENT";
  } else if (row.operational_status === "IN_PROGRESS") {
    state = "IN_PROGRESS";
  } else if (row.operational_status === "WAITING_CUSTOMER") {
    state = "WAITING_CUSTOMER";
  } else {
    state = "PAID_NOT_STARTED";
  }

  return {
    state,
    payment_status: row.payment_status,
    operational_status: row.operational_status,
    amount_cents: row.amount_cents,
    paid_at: row.paid_at,
    scheduled_for: row.scheduled_for,
    started_at: row.started_at,
    completed_at: row.completed_at,
    next_step: NEXT_STEP[state],
  };
}

export interface MonthlyCostInput {
  systemMonthlyCents: number | null;
  instanceMonthlyCents: number | null;
  implementationOneTimeCents: number | null;
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
  projectedMonthlyCents: number;
  oneTimeDueCents: number;
  /** O custo de IA é consumo, não assinatura — a tela mostra "variável". */
  aiVariable: true;
}

/** Os quatro números do resumo consolidado da tela de cobrança. */
export function summarizeMonthlyCosts(i: MonthlyCostInput): MonthlyCostSummary {
  const systemPart = i.systemSponsored ? 0 : (i.systemMonthlyCents ?? 0);
  const instancePrice = i.instanceMonthlyCents ?? 0;
  const instanceNow = i.hasActiveInstanceSubscription && !i.whatsappSponsored
    ? instancePrice
    : 0;

  return {
    currentMonthlyCents: systemPart + instanceNow,
    projectedMonthlyCents: systemPart + (i.whatsappSponsored ? 0 : instancePrice),
    oneTimeDueCents: i.implementationSettled ? 0 : (i.implementationOneTimeCents ?? 0),
    aiVariable: true,
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
npm run test -- whatsapp-implementation-core
```
Esperado: PASS, todos os blocos. Depois rode a suíte inteira para provar que nada regrediu:

```bash
npm run test
```
Esperado: o total anterior (229) + os novos casos, zero falhas.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp-implementation-core.ts src/lib/whatsapp-implementation-core.test.ts
git commit -m "feat(billing): nucleo puro da implantacao WhatsApp (matriz, transicoes, projecao, custos)"
```

---

## Task 2: Migration 071 — tabela `whatsapp_implementations`

Estado financeiro e operacional separados, com as invariantes garantidas por CHECK (o servidor dá a mensagem boa; o banco é quem impede).

**Files:**
- Create: `supabase/migrations/20260726100000_071_whatsapp_implementations.sql`

**Interfaces:**
- Consumes: `organizations`, `billing_plans`, `billing_invoices`, `auth.users`, e as funções já existentes `is_platform_admin(uuid)`, `audit_trigger_func()`, `update_updated_at()`.
- Produces: tabela `whatsapp_implementations` e o índice `whatsapp_impl_one_open_per_org_idx`, consumidos pelas Tasks 7, 10, 13 e 14.

- [ ] **Step 1: Escrever a migration**

````sql
-- Implantação do WhatsApp (Fase 5a). Uma linha por venda/entrega da configuração
-- assistida de R$ 750 — vendida no checkout ou registrada à mão pelo admin.
--
-- DOIS eixos de estado, nunca um só:
--   payment_status      — o dinheiro (ou a ausência dele, quando é cortesia)
--   operational_status  — a execução do serviço
-- Colapsar os dois num campo faz "pago mas não entregue" e "entregue de graça"
-- caírem no mesmo balde, e é exatamente o que o operador precisa distinguir.
--
-- AUSÊNCIA DE LINHA = "não solicitado". Não existe linha vazia representando
-- "nada aconteceu": ela não teria origem, valor nem responsável, e tornaria
-- inútil o índice de "uma implantação aberta por organização".
--
-- RLS: ENABLE + FORCE, policy só de platform_admin. Membro da organização NÃO
-- lê esta tabela — ela carrega notas internas, motivo da cortesia, referência
-- do pagamento externo e responsáveis. O cliente vê a projeção segura devolvida
-- pela EF manage-whatsapp-implementations (action get_service_status).

begin;

create table if not exists whatsapp_implementations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,

  origin text not null
    check (origin in ('ASAAS', 'EXTERNAL_PAYMENT', 'COURTESY', 'ADMIN_OVERRIDE')),
  payment_status text not null
    check (payment_status in ('PENDING', 'CONFIRMED', 'WAIVED', 'REFUNDED', 'CHARGEBACK', 'CANCELED')),
  operational_status text not null default 'NOT_STARTED'
    check (operational_status in ('NOT_STARTED', 'SCHEDULED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'COMPLETED', 'CANCELED')),

  -- Cobrado (ASAAS) ou efetivamente recebido (EXTERNAL_PAYMENT). NULL em WAIVED:
  -- cortesia não tem valor recebido, e gravar 75000 ali inflaria o faturamento.
  amount_cents integer check (amount_cents is null or amount_cents >= 0),

  billing_plan_id uuid references billing_plans(id),
  billing_invoice_id uuid references billing_invoices(id),
  provider_checkout_id text,

  paid_at timestamptz,
  -- Livre de propósito: 'pix', 'card', 'transferencia', 'dinheiro'... O CHECK de
  -- billing_subscriptions.payment_method não serve aqui (pagamento externo tem
  -- formas que o provedor não conhece).
  payment_method text,
  external_payment_reference text,

  reason text,
  notes text,
  owner_admin_id uuid references auth.users(id),

  scheduled_for date,
  started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,

  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Matriz origem × pagamento. Pagamento externo é CONFIRMED com valor e data
  -- reais (entra no relatório financeiro); cortesia e override são WAIVED (não
  -- entram). Trocar um pelo outro falsifica o faturamento nas duas direções.
  constraint whatsapp_impl_origin_payment_chk check (
    (origin = 'ASAAS'
      and payment_status in ('PENDING', 'CONFIRMED', 'REFUNDED', 'CHARGEBACK', 'CANCELED'))
    or (origin = 'EXTERNAL_PAYMENT'
      and payment_status in ('CONFIRMED', 'REFUNDED', 'CANCELED'))
    or (origin in ('COURTESY', 'ADMIN_OVERRIDE')
      and payment_status in ('WAIVED', 'CANCELED'))
  ),

  -- Sem id falso do Asaas: operação manual NUNCA aponta para fatura ou checkout
  -- que não existe lá. Sem isto, um relatório de conciliação passa a mentir.
  constraint whatsapp_impl_no_fake_asaas_chk check (
    origin = 'ASAAS'
    or (billing_invoice_id is null and provider_checkout_id is null)
  ),

  -- Concluir exige pagamento resolvido. REFUNDED/CHARGEBACK entram porque
  -- estorno DEPOIS da entrega não desfaz o trabalho — a linha continua
  -- COMPLETED. Quem impede concluir COM estorno em curso é a Edge Function
  -- (canTransitionOperational só aceita CONFIRMED|WAIVED na transição).
  constraint whatsapp_impl_completed_needs_payment_chk check (
    operational_status <> 'COMPLETED'
    or payment_status in ('CONFIRMED', 'WAIVED', 'REFUNDED', 'CHARGEBACK')
  )
);

comment on table whatsapp_implementations is
  'Implantacao do WhatsApp (R$750). payment_status e operational_status sao eixos SEPARADOS. Ausencia de linha = NOT_REQUESTED. FORCE RLS, so platform_admin; cliente le a projecao segura via manage-whatsapp-implementations.';

-- Uma implantação ABERTA por organização. COMPLETED continua bloqueando: uma
-- segunda implantação para a mesma empresa é reimplantação, fluxo explícito de
-- fase futura, e não pode nascer de um clique acidental no botão de contratar.
-- Histórico nunca é apagado — só CANCELED sai do índice.
create unique index if not exists whatsapp_impl_one_open_per_org_idx
  on whatsapp_implementations (organization_id)
  where operational_status <> 'CANCELED';

-- O aplicador do webhook correlaciona a confirmação por este id.
create index if not exists whatsapp_impl_checkout_idx
  on whatsapp_implementations (provider_checkout_id)
  where provider_checkout_id is not null;

create index if not exists whatsapp_impl_operational_idx
  on whatsapp_implementations (operational_status);

alter table whatsapp_implementations enable row level security;
alter table whatsapp_implementations force row level security;

drop policy if exists platform_admin_all_whatsapp_implementations on whatsapp_implementations;
create policy platform_admin_all_whatsapp_implementations
  on whatsapp_implementations
  for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_implementations_updated_at on whatsapp_implementations;
create trigger whatsapp_implementations_updated_at
  before update on whatsapp_implementations
  for each row execute function update_updated_at();

-- Mesma trilha genérica de customers/reservations/unit_members e de
-- organization_entitlement_overrides. audit_trigger_func extrai
-- organization_id do row automaticamente.
drop trigger if exists whatsapp_implementations_audit on whatsapp_implementations;
create trigger whatsapp_implementations_audit
  after insert or update or delete on whatsapp_implementations
  for each row execute function public.audit_trigger_func();

commit;

-- =====================================================================
-- Validação pós-migration (rodar após `supabase db push`)
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity
--     from pg_class where relname = 'whatsapp_implementations';
--
-- 2. As três constraints de invariante existem (esperado: 3 linhas):
--   select conname from pg_constraint
--    where conrelid = 'whatsapp_implementations'::regclass
--      and conname like 'whatsapp_impl_%_chk';
--
-- 3. A matriz recusa o par proibido (esperado: erro 23514 nas duas):
--   insert into whatsapp_implementations (organization_id, origin, payment_status, notes)
--   select id, 'COURTESY', 'CONFIRMED', 'teste-071' from organizations limit 1;
--   insert into whatsapp_implementations (organization_id, origin, payment_status, notes)
--   select id, 'EXTERNAL_PAYMENT', 'WAIVED', 'teste-071' from organizations limit 1;
--
-- 4. Id falso do Asaas é recusado (esperado: erro 23514):
--   insert into whatsapp_implementations
--     (organization_id, origin, payment_status, provider_checkout_id, notes)
--   select id, 'COURTESY', 'WAIVED', 'chk_falso', 'teste-071' from organizations limit 1;
--
-- 5. Conclusão sem pagamento é recusada (esperado: erro 23514):
--   insert into whatsapp_implementations
--     (organization_id, origin, payment_status, operational_status, notes)
--   select id, 'ASAAS', 'PENDING', 'COMPLETED', 'teste-071' from organizations limit 1;
--
-- 6. Uma aberta por org: repita um insert válido duas vezes (1ª passa, 2ª dá
--    23505). LIMPE ao final:
--   delete from whatsapp_implementations where notes = 'teste-071';
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop table if exists whatsapp_implementations;
-- Seguro enquanto nenhuma linha real existir. Com linhas, prefira manter a
-- tabela e desligar a flag whatsapp_implementation_flow — apagar destrói
-- registro financeiro (pagamento externo confirmado mora aqui).
````

- [ ] **Step 2: Conferir a sequência e o nome do arquivo**

```bash
ls supabase/migrations | tail -3
```
Esperado: `20260725190000_070_conversation_wa_chat_lid.sql` seguida de `20260726100000_071_whatsapp_implementations.sql`, em ordem alfabética.

- [ ] **Step 3: Revisão estática de segurança**

Rodar `saas-shield-br:migration-validator` sobre o arquivo (RLS, isolamento multi-tenant, idempotência, reversibilidade). Achado de severidade alta é bloqueante.

Confira à mão o que o agente não tem como saber: a policy é **só** `is_platform_admin` — a ausência de uma policy `is_unit_member` é decisão de escopo (o cliente lê a projeção via EF), não esquecimento.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260726100000_071_whatsapp_implementations.sql
git commit -m "feat(billing): migration 071 - tabela whatsapp_implementations"
```

---

## Task 3: Migration 072 — ciclo de vida de `billing_checkout_sessions`

Hoje a tabela é um mapa `checkoutId → org` gravado **depois** de o Asaas responder. A Fase 5a precisa reservar a intenção **antes** da chamada, para deduplicar dois cliques, e precisa saber quando uma sessão morreu.

**Files:**
- Create: `supabase/migrations/20260726100100_072_billing_checkout_sessions_lifecycle.sql`
- Reference: `supabase/migrations/20260719130000_067_billing_checkout_sessions.sql`

**ATENÇÃO — a coluna do plano chama-se `plan_id`, não `billing_plan_id`.** A spec §5.2 escreveu o nome errado; o nome real vem da migration 067. Use `plan_id` no índice e em todas as queries das Tasks 9 e 10.

**Interfaces:**
- Consumes: `billing_checkout_sessions` (migration 067).
- Produces: colunas `id`, `status`, `checkout_url`, `expires_at`, `updated_at` e o índice `billing_checkout_sessions_active_idx`, consumidos pelas Tasks 9 e 10. `provider_checkout_id` passa a nullable com UNIQUE parcial — a leitura do aplicador (`.eq("provider_checkout_id", ...)`) continua idêntica.

- [ ] **Step 1: Escrever a migration**

````sql
-- Ciclo de vida das sessões de checkout (Fase 5a).
--
-- PROBLEMA: a 067 usa provider_checkout_id como PK e a linha só nasce DEPOIS de
-- o Asaas responder. Sem uma linha reservada ANTES da chamada, dois cliques no
-- mesmo botão abrem duas cobranças reais no Asaas (que não tem
-- Idempotency-Key), e não há como o segundo saber que o primeiro está em voo.
--
-- SOLUÇÃO: PK surrogate + status. O fluxo passa a ser
--   reserva ('creating') → chama o Asaas → 'pending' + url + expires_at
-- com 'failed' no erro. Um UNIQUE parcial sobre (organization_id, plan_id,
-- purpose) restrito aos status vivos é o que serializa os cliques.
--
-- expires_at é DERIVADO, não adivinhado: minutesToExpire (10–1440) é parâmetro
-- nosso na criação do checkout no Asaas.

begin;

-- 1. PK surrogate. provider_checkout_id vira coluna comum (nullable), porque na
--    reserva o id ainda não existe.
alter table billing_checkout_sessions
  add column if not exists id uuid not null default gen_random_uuid();

do $$
begin
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'billing_checkout_sessions'::regclass
       and c.contype = 'p'
       and array_length(c.conkey, 1) = 1
       and (select attname from pg_attribute
             where attrelid = c.conrelid and attnum = c.conkey[1]) = 'provider_checkout_id'
  ) then
    alter table billing_checkout_sessions drop constraint billing_checkout_sessions_pkey;
    alter table billing_checkout_sessions alter column provider_checkout_id drop not null;
    alter table billing_checkout_sessions add primary key (id);
  end if;
end $$;

-- O id do provedor continua único quando existe — é por ele que o aplicador do
-- webhook correlaciona o pagamento à organização.
create unique index if not exists billing_checkout_sessions_provider_id_idx
  on billing_checkout_sessions (provider_checkout_id)
  where provider_checkout_id is not null;

-- 2. Status + campos do ciclo. O backfill vive DENTRO do guard de criação da
--    coluna: um `update ... set status='used'` solto marcaria como usada, numa
--    segunda execução, uma sessão que está sendo criada naquele instante.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'billing_checkout_sessions'
       and column_name = 'status'
  ) then
    alter table billing_checkout_sessions
      add column status text not null default 'creating';
    -- Toda linha pré-existente veio do fluxo antigo: nasceu já com o checkout
    -- criado no Asaas, e as de sandbox já foram pagas. 'used' é o único valor
    -- que não as faz bloquear uma contratação nova pelo UNIQUE abaixo.
    update billing_checkout_sessions set status = 'used';
  end if;
end $$;

alter table billing_checkout_sessions
  add column if not exists checkout_url text,
  add column if not exists expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'billing_checkout_sessions_status_check'
  ) then
    alter table billing_checkout_sessions
      add constraint billing_checkout_sessions_status_check
      check (status in ('creating', 'pending', 'used', 'expired', 'canceled', 'failed'));
  end if;
end $$;

-- 3. Uma sessão VIVA por produto. Cobre o clique duplo e o "abri em duas abas".
--    Sessão morta (used/expired/canceled/failed) sai do índice e não atrapalha
--    a próxima tentativa.
create unique index if not exists billing_checkout_sessions_active_idx
  on billing_checkout_sessions (organization_id, plan_id, purpose)
  where status in ('creating', 'pending');

comment on column billing_checkout_sessions.status is
  'creating = reservada antes de chamar o provedor; pending = checkout aberto e pagavel; used = pagamento correlacionado; expired/canceled/failed = morta. UNIQUE parcial sobre (org, plan_id, purpose) nos dois primeiros serializa cliques.';
comment on column billing_checkout_sessions.expires_at is
  'Derivado do minutesToExpire enviado ao Asaas — nao e palpite. Linha vencida e varrida para expired na proxima tentativa do mesmo produto.';

drop trigger if exists billing_checkout_sessions_updated_at on billing_checkout_sessions;
create trigger billing_checkout_sessions_updated_at
  before update on billing_checkout_sessions
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. PK é o id novo (esperado: 'id'):
--   select a.attname from pg_constraint c
--     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
--    where c.conrelid = 'billing_checkout_sessions'::regclass and c.contype = 'p';
--
-- 2. Nenhuma sessão antiga ficou viva (esperado: 0):
--   select count(*) from billing_checkout_sessions where status in ('creating','pending');
--
-- 3. provider_checkout_id aceita null (esperado: YES):
--   select is_nullable from information_schema.columns
--    where table_name = 'billing_checkout_sessions' and column_name = 'provider_checkout_id';
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Aditiva. Para voltar ao comportamento antigo basta reverter as Edge Functions
-- (o writer novo é quem usa 'creating'); as colunas ficam. NÃO recriar a PK
-- antiga sem antes garantir provider_checkout_id not null em todas as linhas.
````

- [ ] **Step 2: Revisão estática de segurança**

`saas-shield-br:migration-validator`. Ponto de atenção para o revisor: o `drop constraint` da PK antiga está atrás de um guard que confirma que a PK atual é exatamente a coluna `provider_checkout_id` — numa base já migrada, o bloco inteiro é no-op.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260726100100_072_billing_checkout_sessions_lifecycle.sql
git commit -m "feat(billing): migration 072 - ciclo de vida das sessoes de checkout"
```

---

## Task 4: Migration 073 — assinatura por categoria (UNIQUE + RPC com lock)

O bloqueante da fase. Hoje `applyAsaasEvent` resolve "a assinatura da org" com `maybeSingle()` sobre qualquer assinatura não-cancelada: no instante em que uma organização tem sistema **e** instância, isso vira `PGRST116` e o pagamento falha.

Constraint e lock são **complementares**, não alternativas: a UNIQUE impede duas assinaturas do **mesmo plano**; o advisory lock impede duas assinaturas de **planos diferentes da mesma categoria** nascendo em paralelo — cenário que nenhuma UNIQUE expressa.

**Files:**
- Create: `supabase/migrations/20260726100200_073_billing_subscription_category.sql`

**Interfaces:**
- Consumes: `billing_subscriptions`, `billing_plans`, `billing_customers`.
- Produces: RPC `resolve_or_activate_subscription(p_org uuid, p_plan_id uuid, p_provider_subscription_id text, p_payment_method text) returns jsonb`, devolvendo `{"action": "created"|"reused", "subscription_id": <uuid>, "category": <text>}`. Levanta `ambiguous_subscription_category`, `plan_not_found` ou `missing_billing_customer`. Consumida pela Task 6.

- [ ] **Step 1: Escrever a migration**

````sql
-- Assinatura resolvida por CATEGORIA do plano (Fase 5a).
--
-- BLOQUEANTE que esta migration resolve: applyAsaasEvent resolve "a assinatura
-- da organização" com maybeSingle() sobre qualquer assinatura não-cancelada.
-- Assim que uma org tem sistema (R$449) + instância (R$149), maybeSingle()
-- devolve PGRST116 e o pagamento falha — o cliente paga e não recebe nada.
--
-- DUAS defesas complementares, não redundantes:
--  1. UNIQUE (organization_id, billing_plan_id) parcial — mata a corrida de
--     dois cliques no MESMO plano.
--  2. Advisory lock por (org, categoria) dentro da RPC — cobre planos
--     DIFERENTES da mesma categoria (ex.: dois planos de sistema), que nenhuma
--     UNIQUE consegue expressar.
--
-- Ambiguidade (>1 assinatura viva na categoria) é FALHA ALTA: a RPC levanta
-- exceção, o evento continua na fila e o reconcile reprocessa. Escolher "a mais
-- recente" em silêncio ativaria a assinatura errada.

begin;

create unique index if not exists billing_subscriptions_org_plan_active_idx
  on billing_subscriptions (organization_id, billing_plan_id)
  where status <> 'canceled';

create or replace function resolve_or_activate_subscription(
  p_org uuid,
  p_plan_id uuid,
  p_provider_subscription_id text,
  p_payment_method text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text;
  v_count int;
  v_sub_id uuid;
  v_customer_id uuid;
begin
  select category into v_category from billing_plans where id = p_plan_id;
  if v_category is null then
    raise exception 'plan_not_found' using errcode = 'P0002';
  end if;

  -- Serializa por (org, categoria) até o fim da transação. hashtextextended dá
  -- o bigint que o advisory lock exige. Transaction-scoped de propósito: o
  -- PgBouncer em transaction mode não preserva lock de sessão.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || v_category, 0));

  select count(*) into v_count
    from billing_subscriptions s
    join billing_plans p on p.id = s.billing_plan_id
   where s.organization_id = p_org
     and s.status <> 'canceled'
     and p.category = v_category;

  if v_count > 1 then
    raise exception 'ambiguous_subscription_category' using errcode = 'P0001';
  end if;

  if v_count = 1 then
    select s.id into v_sub_id
      from billing_subscriptions s
      join billing_plans p on p.id = s.billing_plan_id
     where s.organization_id = p_org
       and s.status <> 'canceled'
       and p.category = v_category
     limit 1;

    -- Condicional: numa assinatura já ativa isto não afeta linha nenhuma.
    update billing_subscriptions
       set status = 'active', updated_at = now()
     where id = v_sub_id and status <> 'active';

    -- Backfill SEPARADO, pelo mesmo motivo: o update acima é condicional, e num
    -- caminho em que ele não afeta linha o id de correlação nunca chegaria.
    -- O `is null` impede sobrescrever id existente.
    if p_provider_subscription_id is not null then
      update billing_subscriptions
         set provider_subscription_id = p_provider_subscription_id, updated_at = now()
       where id = v_sub_id and provider_subscription_id is null;
    end if;

    return jsonb_build_object(
      'action', 'reused', 'subscription_id', v_sub_id, 'category', v_category
    );
  end if;

  select id into v_customer_id
    from billing_customers where organization_id = p_org limit 1;
  if v_customer_id is null then
    raise exception 'missing_billing_customer' using errcode = 'P0002';
  end if;

  insert into billing_subscriptions (
    organization_id, billing_customer_id, billing_plan_id, provider,
    provider_subscription_id, status, payment_method
  ) values (
    p_org, v_customer_id, p_plan_id, 'asaas',
    p_provider_subscription_id, 'active', coalesce(p_payment_method, 'card')
  ) returning id into v_sub_id;

  return jsonb_build_object(
    'action', 'created', 'subscription_id', v_sub_id, 'category', v_category
  );
end;
$$;

comment on function resolve_or_activate_subscription(uuid, uuid, text, text) is
  'Ativa ou cria a assinatura da CATEGORIA do plano informado, sob advisory lock por (org, categoria). Mais de uma assinatura viva na categoria levanta ambiguous_subscription_category — o aplicador converte em failed e o reconcile retenta. So service_role.';

revoke all on function resolve_or_activate_subscription(uuid, uuid, text, text) from public;
grant execute on function resolve_or_activate_subscription(uuid, uuid, text, text) to service_role;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Nenhuma org já tem duas assinaturas vivas da mesma categoria — se tiver, a
--    RPC vai falhar para ela e é preciso resolver à mão ANTES de vender
--    (esperado: 0 linhas):
--   select s.organization_id, p.category, count(*)
--     from billing_subscriptions s join billing_plans p on p.id = s.billing_plan_id
--    where s.status <> 'canceled'
--    group by 1, 2 having count(*) > 1;
--
-- 2. Grants (esperado: só service_role):
--   select grantee, privilege_type from information_schema.routine_privileges
--    where routine_name = 'resolve_or_activate_subscription';
--
-- 3. Reuso é idempotente numa org com assinatura de sistema ativa (esperado:
--    action='reused' nas duas chamadas, mesmo subscription_id):
--   select resolve_or_activate_subscription(
--     '<org>'::uuid,
--     (select id from billing_plans where slug = 'sistema-reservas'),
--     null, 'card');
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop function if exists resolve_or_activate_subscription(uuid, uuid, text, text);
--   drop index if exists billing_subscriptions_org_plan_active_idx;
-- O aplicador precisa voltar junto (ele passa a chamar a RPC na Task 6).
````

- [ ] **Step 2: Revisão estática de segurança**

`saas-shield-br:migration-validator`. Ponto de atenção: função `SECURITY DEFINER` com `set search_path = public` e grant restrito a `service_role` — confirmar que nenhum `grant ... to authenticated` sobrou e que a RPC não recebe `auth.uid()` como parâmetro de confiança (ela é chamada só por worker/webhook em service_role).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260726100200_073_billing_subscription_category.sql
git commit -m "feat(billing): migration 073 - RPC resolve_or_activate_subscription por categoria"
```

---

## Task 5: Migrations 074 e 075 — trava de categoria e flags

Duas migrations pequenas com o mesmo papel: fechar portas antes de a venda existir. Vão juntas porque nenhuma tem deliverable próprio a revisar isoladamente.

**Files:**
- Create: `supabase/migrations/20260726100300_074_billing_plans_category_guard.sql`
- Create: `supabase/migrations/20260726100400_075_platform_flags_whatsapp.sql`

**Interfaces:**
- Consumes: `billing_plans`, `billing_subscriptions`, `platform_flags`.
- Produces: trigger `billing_plans_category_guard` (a Task 8 traduz o erro em 409) e as flags `whatsapp_subscription_checkout` / `whatsapp_service_enforcement`, lidas pelas Tasks 11 e 14 via `_shared/platform-flags.ts`.

- [ ] **Step 1: Escrever a 074**

````sql
-- Trava a categoria de um plano que já tem assinatura viva (Fase 5a).
--
-- A categoria decide QUEM a assinatura libera e SE ela pode escrever
-- organizations.billing_status. Trocar a categoria de um plano contratado
-- reclassifica retroativamente todas as assinaturas dele — uma assinatura de
-- instância viraria assinatura de sistema, e pagar R$149 passaria a desbloquear
-- a organização inteira. O painel valida antes; este trigger é a garantia.

begin;

create or replace function billing_plans_block_category_change()
returns trigger
language plpgsql
as $$
begin
  if new.category is distinct from old.category then
    if exists (
      select 1 from billing_subscriptions s
       where s.billing_plan_id = old.id
         and s.status <> 'canceled'
    ) then
      raise exception 'plan_category_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists billing_plans_category_guard on billing_plans;
create trigger billing_plans_category_guard
  before update on billing_plans
  for each row execute function billing_plans_block_category_change();

comment on function billing_plans_block_category_change() is
  'Recusa mudanca de billing_plans.category quando existe assinatura nao-cancelada do plano. Sem isto, reclassificar um plano contratado mudaria retroativamente o que as assinaturas dele liberam.';

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- Plano SEM assinatura aceita a troca (esperado: UPDATE 1 nas duas linhas):
--   update billing_plans set category = 'CUSTOM' where slug = 'credito-ia-50';
--   update billing_plans set category = 'AI_CREDIT_PACKAGE' where slug = 'credito-ia-50';
--
-- Plano COM assinatura recusa (esperado: erro plan_category_locked):
--   update billing_plans set category = 'CUSTOM'
--    where id in (select billing_plan_id from billing_subscriptions
--                  where status <> 'canceled' limit 1);
--
-- Rollback: drop trigger if exists billing_plans_category_guard on billing_plans;
````

- [ ] **Step 2: Escrever a 075**

````sql
-- Flags da Fase 5a. Todas OFF; ligar é decisão explícita de fase.
--
-- whatsapp_implementation_flow já foi seedada na 061 — não repetir aqui: o
-- `on conflict do nothing` a preservaria, mas a duplicação confunde quem lê.
--
-- SEPARADAS de propósito: a visibilidade dos preços (5a) pode ir ao ar antes do
-- checkout mensal, e o checkout mensal antes do enforcement. Uma flag só
-- obrigaria a ligar as três de uma vez — inclusive a suspensão, que nem existe
-- nesta fase.

begin;

insert into platform_flags (key, value, description) values
  ('whatsapp_subscription_checkout', 'false',
   'Libera o checkout da mensalidade da instancia (R$149). Fica OFF em producao ate a Fase 5b: sem enforcement, seria cobrar mensalidade sem poder suspender.'),
  ('whatsapp_service_enforcement', 'false',
   'Suspensao e gates do servico de WhatsApp por inadimplencia da instancia (Fase 5b).')
on conflict (key) do nothing;

commit;

-- Validação (esperado: 3 linhas, todas false):
--   select key, value from platform_flags
--    where key in ('whatsapp_implementation_flow',
--                  'whatsapp_subscription_checkout',
--                  'whatsapp_service_enforcement');
--
-- Rollback:
--   delete from platform_flags
--    where key in ('whatsapp_subscription_checkout', 'whatsapp_service_enforcement');
````

- [ ] **Step 3: Revisão estática de segurança nos dois arquivos**

`saas-shield-br:migration-validator`. Confirmar idempotência (`on conflict do nothing`, `drop trigger if exists`) e que o trigger **não** é `security definer` — ele roda no contexto de quem faz o UPDATE, e o `exists` sobre `billing_subscriptions` já é alcançável pelo service_role da EF que edita planos.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260726100300_074_billing_plans_category_guard.sql supabase/migrations/20260726100400_075_platform_flags_whatsapp.sql
git commit -m "feat(billing): migrations 074-075 - trava de categoria e flags do WhatsApp"
```

---

## Task 6: Aplicador — assinatura por categoria e `organizations` só no caminho de sistema

Troca o `maybeSingle()` que quebra com duas assinaturas pela RPC da Task 4, e fecha o invariante central da fase: pagar a instância nunca reativa a organização.

**Files:**
- Modify: `supabase/functions/_shared/asaas-billing-events-apply.ts` (passos 6 e 8, case `activate_subscription`)

**Interfaces:**
- Consumes: RPC `resolve_or_activate_subscription` (Task 4).
- Produces: nada de novo para outras tasks — o contrato de `applyAsaasEvent` (`ApplyResult`) fica idêntico. A Task 7 acrescenta código dentro do mesmo `case`.

**Contexto de leitura obrigatória antes de editar:** o passo 6 atual (linhas ~384-407) e o `case "activate_subscription"` (linhas ~425-710). O comentário longo do passo 5 sobre `getPayment` e o do passo 7 sobre a ordem de resolução da org **não mudam** — não os reescreva.

- [ ] **Step 1: Substituir o passo 6 pela resolução por categoria**

O bloco atual resolve "a assinatura da org". Substitua-o por dois blocos: carregar a categoria do plano do pagamento e, só então, procurar a assinatura **dessa categoria** — que é o que o `billing_subscription_id` da fatura precisa apontar.

```ts
    // 6. Categoria do plano do PAGAMENTO e a assinatura correspondente.
    //
    // O código antigo perguntava "qual é a assinatura desta organização?" com
    // maybeSingle(). A partir da Fase 5a uma org pode ter DUAS (sistema R$449 +
    // instância R$149) e aquela pergunta não tem resposta única — devolvia
    // PGRST116 e o pagamento falhava. A pergunta certa é "qual é a assinatura
    // desta organização NA CATEGORIA deste plano?".
    let planCategory: string | null = null;
    if (planId) {
      const { data: planRow, error: planErr } = await supabase
        .from("billing_plans")
        .select("category")
        .eq("id", planId)
        .maybeSingle();
      if (planErr) {
        return failWith(
          organizationId,
          effect.kind,
          "select_plan_category",
          planErr,
          "Falha ao consultar a categoria do plano — ver logs.",
        );
      }
      planCategory = (planRow?.category as string | undefined) ?? null;
    }

    // Só serve para carimbar billing_subscription_id na fatura. A ativação em si
    // é feita pela RPC mais abaixo, que é quem tem o lock.
    let subscription: { id: string; status: string } | null = null;
    if (organizationId && planCategory) {
      // `.select()` de lista (não maybeSingle): ambiguidade aqui precisa ser
      // detectada, não convertida em null. Duas assinaturas vivas na mesma
      // categoria é estado inválido, e escolher uma em silêncio carimbaria a
      // fatura na assinatura errada.
      const { data, error } = await supabase
        .from("billing_subscriptions")
        .select("id, status, billing_plans!inner(category)")
        .eq("organization_id", organizationId)
        .neq("status", "canceled")
        .eq("billing_plans.category", planCategory);
      if (error) {
        return failWith(
          organizationId,
          "unknown",
          "select_subscription_by_category",
          error,
          "Falha ao consultar a assinatura da organização — ver logs.",
        );
      }
      if ((data ?? []).length > 1) {
        return failWith(
          organizationId,
          effect.kind,
          "ambiguous_subscription_category",
          `org ${organizationId} tem ${data!.length} assinaturas vivas na categoria ${planCategory}`,
          "Organização com mais de uma assinatura ativa na mesma categoria — ver logs.",
        );
      }
      const row = (data ?? [])[0] as { id: string; status: string } | undefined;
      subscription = row ? { id: row.id, status: row.status } : null;
    }
```

- [ ] **Step 2: Trocar o bloco de ativação pela RPC**

Dentro do `case "activate_subscription"`, **depois** do gate `if (purpose !== "subscription") break;`, substitua todo o `if (subscription) { ... } else { ... }` (o UPDATE condicional, o backfill e o INSERT com resolução de `billing_customer`) por:

```ts
        // A criação/ativação é da RPC, não daqui: ela roda sob
        // pg_advisory_xact_lock por (org, categoria), que é o que impede duas
        // assinaturas de planos DIFERENTES da mesma categoria nascerem em
        // paralelo — corrida que nenhuma UNIQUE consegue expressar. A RPC
        // também faz o backfill do provider_subscription_id.
        if (!planId) {
          return failWith(
            organizationId,
            effect.kind,
            "missing_plan_id",
            `externalReference sem plano (raw=${externalReferenceRaw ?? "ausente"})`,
            "Pagamento de assinatura sem plano identificável — ver logs.",
          );
        }

        const { data: rpcData, error: rpcErr } = await supabase.rpc(
          "resolve_or_activate_subscription",
          {
            p_org: organizationId,
            p_plan_id: planId,
            p_provider_subscription_id: providerSubscriptionId,
            // Coluna NOT NULL. O fallback 'card' é regra de produto (o checkout
            // RECURRENT do Asaas só aceita cartão), não chute.
            p_payment_method: paymentMethod ?? "card",
          },
        );
        if (rpcErr) {
          // Inclui ambiguous_subscription_category, plan_not_found e
          // missing_billing_customer. Todos são falha ALTA: o evento continua na
          // fila e o reconcile reprocessa depois que um humano resolver.
          return failWith(
            organizationId,
            effect.kind,
            "resolve_or_activate_subscription",
            rpcErr,
            "Falha ao ativar a assinatura da organização — ver logs.",
          );
        }

        const activated = rpcData as
          | { action?: string; subscription_id?: string; category?: string }
          | null;

        jsonLog("info", {
          evt: "asaas_subscription_resolved",
          organization_id: organizationId,
          action: activated?.action ?? null,
          category: activated?.category ?? null,
        });

        // ── INVARIANTE DA FASE 5a ────────────────────────────────────────────
        // SÓ assinatura de categoria SYSTEM_SUBSCRIPTION escreve em
        // organizations.billing_status. Sem este gate, pagar os R$149 da
        // instância reativaria uma organização cujo SISTEMA está inadimplente —
        // e carimbaria restored_at + aviso "voltou" por uma dívida que continua
        // aberta.
        if (activated?.category !== "SYSTEM_SUBSCRIPTION") {
          jsonLog("info", {
            evt: "asaas_activation_scoped_to_service",
            organization_id: organizationId,
            category: activated?.category ?? null,
          });
          break;
        }
```

O bloco seguinte (leitura de `prevOrg`, `wasDelinquent`, `orgUpdate`, `restored_at` e o enqueue de `regularized`) **permanece intacto**, agora alcançável só pelo caminho de sistema.

- [ ] **Step 3: Conferir que nada mais lê a variável removida**

```bash
grep -n "subscription?.id\|subscription\." supabase/functions/_shared/asaas-billing-events-apply.ts
```
Esperado: as únicas ocorrências restantes são `subscription?.id ?? null` no INSERT de `billing_invoices` (passo 8, ramo `else`) e as do bloco novo do Step 1. Se aparecer alguma referência a `subscription.status` fora disso, o bloco antigo não foi removido por inteiro.

- [ ] **Step 4: Revisar o arquivo inteiro contra o contrato**

Sem Deno instalado não há checagem automática. Reler o arquivo por completo procurando:
1. toda escrita tem `error` destruturado e degrada para `failed` (invariante do módulo: `processed` significa "o efeito foi aplicado de verdade");
2. nenhum `error.message` cru vaza no `clientMessage`;
3. o gate `if (purpose !== "subscription") break;` continua **antes** da ativação e **depois** do registro da fatura (obrigação 1 do contrato de `decideEventEffect`: o dinheiro é registrado sempre).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/asaas-billing-events-apply.ts
git commit -m "fix(billing): resolve assinatura por categoria via RPC e limita billing_status ao sistema"
```

---

## Task 7: Aplicador — confirmação da implantação e aviso ao admin

Fecha o ciclo do R$ 750: o webhook confirma o pagamento, marca a sessão de checkout como usada e avisa a plataforma. Idempotente por UPDATE condicional — evento duplicado não repete nada.

**Files:**
- Modify: `supabase/functions/_shared/asaas-billing-events-apply.ts`
- Modify: `supabase/functions/_shared/billing-notify.ts`
- Modify: `supabase/functions/process-billing-notifications/index.ts`

**Interfaces:**
- Consumes: `whatsapp_implementations` (Task 2), `billing_checkout_sessions.status` (Task 3), `enqueueBillingNotification` (já existente).
- Produces: `resolvePlatformAdminRecipients(supabase): Promise<string[]>` em `_shared/billing-notify.ts`, e o `event_type` `implementation_paid` na fila.

**Por que os três arquivos na mesma task:** `billing_notifications.event_type` é texto livre, mas o dispatcher marca `status='failed'` com `unknown_event_type` para todo tipo sem template ([process-billing-notifications/index.ts:137-142](../../../supabase/functions/process-billing-notifications/index.ts#L137-L142)). Enfileirar sem o template deixaria o aviso morrer em silêncio na fila.

- [ ] **Step 1: Adicionar `resolvePlatformAdminRecipients` a `_shared/billing-notify.ts`**

```ts
/**
 * E-mails dos administradores da PLATAFORMA, ordenados por antiguidade.
 *
 * NÃO reusa resolveBillingRecipient, que é org-scoped de propósito (o fix do
 * vazamento cross-tenant da Fase 4b). Aqui o destinatário é a própria Moralles:
 * "o cliente X pagou a implantação" é aviso interno, não do cliente.
 *
 * Best-effort: devolve [] em qualquer falha e loga. NUNCA pode derrubar a
 * confirmação financeira que a chamou.
 */
export async function resolvePlatformAdminRecipients(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data: admins, error } = await supabase
    .from("platform_admins")
    .select("user_id")
    .order("created_at", { ascending: true });

  if (error) {
    jsonLog("error", { evt: "platform_admin_recipients_read_failed", err: error.message });
    return [];
  }

  const emails: string[] = [];
  const seen = new Set<string>();
  for (const row of admins ?? []) {
    const { data, error: userErr } = await supabase.auth.admin.getUserById(
      row.user_id as string,
    );
    if (userErr || !data?.user) continue;
    // Usuário banido não recebe aviso operacional.
    const bannedUntil = (data.user as { banned_until?: string | null }).banned_until;
    if (bannedUntil && new Date(bannedUntil).getTime() > Date.now()) continue;
    const email = data.user.email?.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }

  if (emails.length === 0) {
    jsonLog("warn", { evt: "platform_admin_recipients_empty", admins: (admins ?? []).length });
  }
  return emails;
}
```

- [ ] **Step 2: Adicionar o template `implementation_paid` ao dispatcher**

Em `process-billing-notifications/index.ts`, dentro de `TEMPLATE_BY_EVENT`, depois de `regularized`:

```ts
  // Aviso INTERNO (vai para o admin da plataforma, não para o cliente): a
  // implantação foi paga e entra na fila de execução. Sem esta entrada o
  // dispatcher marcaria a linha como failed/unknown_event_type e o aviso
  // sumiria.
  implementation_paid: (d) => ({
    subject: `Implantação de WhatsApp paga — ${d.orgName}`,
    text: `${d.orgName} pagou a implantação do WhatsApp (${d.amountBrl}). Agende a configuração no painel de implantações.`,
    html: wrapHtml("Implantação de WhatsApp paga", [
      `<strong>${d.orgName}</strong> pagou a implantação do WhatsApp.`,
      `Valor: <strong>${d.amountBrl}</strong>.`,
      `Agende a configuração no painel de implantações.`,
    ]),
  }),
```

- [ ] **Step 3: Confirmar a implantação no aplicador**

Em `asaas-billing-events-apply.ts`, adicione o import e a função auxiliar (fora de `applyAsaasEvent`):

```ts
import {
  resolveBillingRecipient,
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
} from "./billing-notify.ts";
```

```ts
/**
 * Confirma a implantação paga pelo checkout do Asaas.
 *
 * IDEMPOTENTE por UPDATE condicional em `payment_status = 'PENDING'`: o cartão
 * emite PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED (até ~30 dias), e o
 * reconcile pode reprocessar a mesma linha. Só a execução que de fato mudou a
 * linha enfileira o aviso — `.select("id")` é o que distingue "eu mudei" de
 * "já estava assim".
 *
 * `.eq('PENDING')` e não `.neq('CONFIRMED')`: a matriz origem×pagamento só
 * admite PENDING→CONFIRMED para origin='ASAAS', e um `.neq` também casaria
 * linhas CANCELED ou estornadas.
 *
 * Best-effort no aviso: falha ao resolver destinatário NUNCA derruba a
 * confirmação financeira (mesma filosofia do enqueue de `regularized`).
 */
async function confirmImplementationPayment(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    checkoutSessionId: string | null;
    invoiceId: string | null;
    paidValueCents: number | null;
    paymentMethod: string | null;
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    payment_status: "CONFIRMED",
    paid_at: nowIso,
  };
  if (args.invoiceId) patch.billing_invoice_id = args.invoiceId;
  if (args.paidValueCents !== null) patch.amount_cents = args.paidValueCents;
  if (args.paymentMethod) patch.payment_method = args.paymentMethod;

  let query = supabase
    .from("whatsapp_implementations")
    .update(patch)
    .eq("origin", "ASAAS")
    .eq("payment_status", "PENDING");

  // Correlação precisa quando temos o checkout; senão cai na organização, que é
  // suficiente porque só existe UMA implantação aberta por org (UNIQUE parcial).
  query = args.checkoutSessionId
    ? query.eq("provider_checkout_id", args.checkoutSessionId)
    : query.eq("organization_id", args.organizationId);

  const { data: updated, error } = await query.select("id");

  if (error) {
    jsonLog("error", {
      evt: "implementation_confirm_failed",
      organization_id: args.organizationId,
      error: String(error),
    });
    return;
  }
  if (!updated || updated.length === 0) {
    // Duplicata benigna (2º evento do cartão) ou pagamento de implantação sem
    // linha correspondente. Log em info: não é erro, mas precisa ser visível.
    jsonLog("info", {
      evt: "implementation_confirm_noop",
      organization_id: args.organizationId,
      checkout: args.checkoutSessionId,
    });
    return;
  }

  jsonLog("info", {
    evt: "implementation_confirmed",
    organization_id: args.organizationId,
    implementation_id: updated[0].id,
  });

  const recipients = await resolvePlatformAdminRecipients(supabase);
  if (recipients.length === 0) return;
  // UMA linha só: o UNIQUE (organization_id, event_type, invoice_id) deduplica,
  // e sendEmail aceita um único `to`. Enfileirar uma por admin faria N-1
  // desaparecerem em 23505 silencioso. A lista completa vai para o log, e quem
  // recebe é o admin mais antigo (ordem determinística).
  if (recipients.length > 1) {
    jsonLog("info", {
      evt: "implementation_notify_single_recipient",
      chosen: recipients[0],
      total_admins: recipients.length,
    });
  }
  await enqueueBillingNotification(supabase, {
    organizationId: args.organizationId,
    eventType: "implementation_paid",
    invoiceId: args.invoiceId,
    recipient: recipients[0],
  });
}
```

- [ ] **Step 4: Capturar o id da fatura e o checkout, e chamar a confirmação**

No `case "activate_subscription"`, o INSERT de `billing_invoices` hoje não devolve o id. A confirmação da implantação precisa dele para preencher `billing_invoice_id`. Duas mudanças:

1. Guarde o `checkoutSession` numa variável de escopo da função, junto de onde ele já é lido no passo 5:

```ts
    // Declarar junto de externalReferenceRaw / paidValueCents (passo 3):
    let checkoutSessionId: string | null = null;
```

e, no bloco do terceiro fallback do passo 5, **antes** do `if (!organizationId)`:

```ts
        const checkoutRef = res.data.checkoutSession;
        if (typeof checkoutRef === "string" && checkoutRef) {
          checkoutSessionId = checkoutRef;
        }
```

O `if (!organizationId) { const checkoutRef = res.data.checkoutSession; ... }` existente passa a usar `checkoutSessionId` no lugar da constante local.

2. Resolva o id da fatura nos dois ramos (existente e recém-inserida):

```ts
        // Id da fatura deste pagamento, resolvido nos DOIS ramos: o UPDATE não
        // devolve id, e o INSERT pode ter virado 23505 numa corrida com o
        // reconcile. Um SELECT pelo UNIQUE (provider, provider_payment_id)
        // responde nos dois casos.
        let settledInvoiceId: string | null = invoice?.id ?? null;
        if (!settledInvoiceId) {
          const { data: inv } = await supabase
            .from("billing_invoices")
            .select("id")
            .eq("provider", "asaas")
            .eq("provider_payment_id", paymentId)
            .maybeSingle();
          settledInvoiceId = (inv?.id as string | undefined) ?? null;
        }

        // Sessão de checkout consumida — vale para QUALQUER purpose. Sem isto a
        // linha fica 'pending' para sempre e o UNIQUE parcial de sessão ativa
        // barra a próxima contratação do mesmo produto.
        if (checkoutSessionId) {
          const { error: sessErr } = await supabase
            .from("billing_checkout_sessions")
            .update({ status: "used" })
            .eq("provider_checkout_id", checkoutSessionId)
            .neq("status", "used");
          if (sessErr) {
            // Cosmético para o acesso — loga e segue, como o backfill do
            // provider_subscription_id.
            jsonLog("warn", {
              evt: "checkout_session_mark_used_failed",
              checkout: checkoutSessionId,
              error: String(sessErr),
            });
          }
        }

        if (purpose === "implementation") {
          await confirmImplementationPayment(supabase, {
            organizationId,
            checkoutSessionId,
            invoiceId: settledInvoiceId,
            paidValueCents,
            paymentMethod,
          });
        }
```

Este bloco entra **imediatamente antes** do gate `if (purpose !== "subscription") break;`, para que a marcação da sessão valha também para o caminho de assinatura.

- [ ] **Step 5: Verificar a ordem final do `case`**

Releia o `case "activate_subscription"` inteiro e confirme esta sequência:

1. guard `!paymentId` → `failed`;
2. registro do dinheiro (UPDATE ou INSERT de `billing_invoices`) — sempre, qualquer `purpose`;
3. resolução de `settledInvoiceId`;
4. sessão de checkout → `used`;
5. `purpose === "implementation"` → `confirmImplementationPayment`;
6. `purpose !== "subscription"` → `break`;
7. `!planId` → `failed`;
8. RPC `resolve_or_activate_subscription`;
9. `category !== "SYSTEM_SUBSCRIPTION"` → `break`;
10. `organizations` + `restored_at` + `regularized`.

Qualquer inversão entre 2 e 6 quebra a idempotência do segundo evento do cartão.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/asaas-billing-events-apply.ts supabase/functions/_shared/billing-notify.ts supabase/functions/process-billing-notifications/index.ts
git commit -m "feat(billing): webhook confirma implantacao paga, consome sessao e avisa a plataforma"
```

---

## Task 8: Sweep de category-awareness — os oito writers de `organizations.billing_status`

Hoje cinco arquivos derivam o estado da organização de "qualquer" fatura ou assinatura. Com dois produtos vendidos, cada um deles vira um bug de produção: uma fatura de R$ 149 vencida bloquearia o sistema inteiro; pagar R$ 149 desbloquearia um sistema inadimplente; cancelar a instância marcaria a organização `canceled`; uma assinatura de WhatsApp ativa faria o trial nunca expirar.

Nada disso depende da venda existir para estar errado — é comportamento errado que já está no repositório. Por isso a correção é **da 5a**, não uma mitigação de go-live.

**Files:**
- Create: `supabase/functions/_shared/billing-category.ts`
- Modify: `supabase/functions/process-billing-overdue/index.ts`
- Modify: `supabase/functions/process-billing-reminders/index.ts`
- Modify: `supabase/functions/process-billing-unblock/index.ts`
- Modify: `supabase/functions/process-trial-expiry/index.ts`
- Modify: `supabase/functions/process-billing-reconcile/index.ts`
- Modify: `supabase/functions/manage-billing/index.ts` (actions `cancel_subscription` e `create_subscription`)

**Interfaces:**
- Consumes: `billing_invoices`, `billing_subscriptions`, `billing_plans`, e `parseExternalReference` de `_shared/asaas-billing-events.ts`.
- Produces:
  - `SYSTEM_CATEGORY = "SYSTEM_SUBSCRIPTION"`
  - `isSystemInvoice(supabase, invoice: InvoiceCategoryInput): Promise<boolean>`
  - `isSystemSubscription(supabase, subscriptionId: string): Promise<boolean>`
  - `planCategoryOf(supabase, planId: string): Promise<string | null>`

- [ ] **Step 1: Criar `_shared/billing-category.ts`**

```ts
/**
 * "Essa fatura/assinatura é do SISTEMA?" — fonte única do sweep da Fase 5a.
 *
 * INVARIANTE que este módulo protege: só assinatura/fatura de categoria
 * SYSTEM_SUBSCRIPTION pode escrever organizations.billing_status. A coluna
 * representa o acesso ao sistema; a instância de WhatsApp tem estado próprio.
 *
 * Existe como módulo (e não como cópia em cada worker) porque a pergunta é a
 * mesma em cinco arquivos, e foi justamente a ausência dessa pergunta,
 * repetida, que criou o bug.
 *
 * REDEPLOY: qualquer mudança aqui exige redeploy de process-billing-overdue,
 * process-billing-reminders, process-billing-unblock, process-trial-expiry,
 * process-billing-reconcile e manage-billing.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseExternalReference } from "./asaas-billing-events.ts";
import { jsonLog } from "./security.ts";

export const SYSTEM_CATEGORY = "SYSTEM_SUBSCRIPTION";

export async function planCategoryOf(
  supabase: SupabaseClient,
  planId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("billing_plans")
    .select("category")
    .eq("id", planId)
    .maybeSingle();
  if (error) {
    jsonLog("warn", { evt: "plan_category_read_failed", plan_id: planId, err: error.message });
    return null;
  }
  return (data?.category as string | undefined) ?? null;
}

export async function isSystemSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("billing_plans!inner(category)")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error || !data) {
    // Falha de leitura NÃO vira "é de sistema": errar para o lado de não mexer
    // em billing_status é o lado seguro (o pior caso é não bloquear alguém que
    // deveria ser bloqueado, e o worker roda de novo amanhã).
    jsonLog("warn", {
      evt: "subscription_category_read_failed",
      subscription_id: subscriptionId,
      err: error?.message ?? "not_found",
    });
    return false;
  }
  const plan = Array.isArray(data.billing_plans) ? data.billing_plans[0] : data.billing_plans;
  return (plan as { category?: string } | null)?.category === SYSTEM_CATEGORY;
}

export interface InvoiceCategoryInput {
  billing_subscription_id?: string | null;
  external_reference?: string | null;
  purpose?: string | null;
}

/**
 * Uma fatura é "de sistema" quando o plano por trás dela tem categoria
 * SYSTEM_SUBSCRIPTION. Três caminhos, nesta ordem:
 *
 *  1. billing_subscription_id → categoria do plano da assinatura (mais forte);
 *  2. external_reference → plan:<uuid> → categoria (o checkout hospedado grava
 *     esse texto; a primeira cobrança costuma nascer SEM billing_subscription_id);
 *  3. sem nenhum dos dois → TRUE, por compatibilidade.
 *
 * O default `true` é deliberado: toda fatura anterior à Fase 5a é de sistema, e
 * devolver false as tiraria da inadimplência em silêncio — trocaria um bug
 * (bloquear demais) por outro pior (nunca bloquear). Faturas de WhatsApp nascem
 * com purpose='subscription' e external_reference preenchido, então caem no
 * caminho 2.
 */
export async function isSystemInvoice(
  supabase: SupabaseClient,
  invoice: InvoiceCategoryInput,
): Promise<boolean> {
  // Implantação e recarga de IA nunca governam o acesso ao sistema.
  if (invoice.purpose === "implementation" || invoice.purpose === "ai_topup") {
    return false;
  }

  if (invoice.billing_subscription_id) {
    return await isSystemSubscription(supabase, invoice.billing_subscription_id);
  }

  const parsed = parseExternalReference(invoice.external_reference ?? null);
  if (parsed?.planId) {
    const category = await planCategoryOf(supabase, parsed.planId);
    // Categoria ilegível cai no default de compatibilidade, não em false.
    if (category !== null) return category === SYSTEM_CATEGORY;
  }

  return true;
}
```

- [ ] **Step 2: `process-billing-overdue` — só fatura de sistema escala**

Importe o módulo e filtre antes de agregar por org:

```ts
import { isSystemInvoice } from "../_shared/billing-category.ts";
```

Troque o SELECT e o laço de agregação:

```ts
    const { data: overdueInvoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, due_date, billing_subscription_id, external_reference, purpose")
      .eq("status", "open")
      .lt("due_date", today);

    // Menor (mais antiga) invoice vencida por org — CONSIDERANDO SÓ AS DE
    // SISTEMA. Uma fatura de R$149 da instância vencida não pode bloquear o
    // acesso ao sistema inteiro; a inadimplência da instância é da Fase 5b.
    const oldestByOrg = new Map<string, { id: string; due_date: string }>();
    for (const inv of overdueInvoices ?? []) {
      if (!inv.due_date) continue;
      if (!(await isSystemInvoice(supabase, inv))) {
        jsonLog("info", {
          reqId,
          evt: "billing_overdue_skip_non_system",
          orgId: inv.organization_id,
          invoiceId: inv.id,
        });
        continue;
      }
      const cur = oldestByOrg.get(inv.organization_id);
      if (!cur || inv.due_date < cur.due_date) {
        oldestByOrg.set(inv.organization_id, { id: inv.id, due_date: inv.due_date });
      }
    }
```

- [ ] **Step 3: `process-billing-reminders` — não avisar por fatura que não bloqueia**

Mesmo import. No SELECT, acrescente as colunas `billing_subscription_id, external_reference, purpose`; e logo depois do `if (!inv.due_date) continue;` e do `match` de offset:

```ts
      // Os templates de lembrete dizem "o acesso será suspenso". Mandar isso por
      // uma fatura de instância seria mentira: ela não suspende nada na 5a.
      if (!(await isSystemInvoice(supabase, inv))) continue;
```

- [ ] **Step 4: `process-billing-unblock` — desbloquear só com fatura de sistema paga**

O worker hoje aceita **qualquer** fatura paga nos últimos 7 dias. Troque o `maybeSingle()` por uma lista filtrada:

```ts
import { isSystemInvoice } from "../_shared/billing-category.ts";
```

```ts
      // Verificar se tem invoice de SISTEMA paga nos últimos 7 dias. Sem o
      // filtro, comprar R$149 de instância (ou R$50 de crédito de IA)
      // desbloquearia uma organização com a mensalidade do sistema em atraso.
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: paidInvoices } = await supabase
        .from("billing_invoices")
        .select("id, billing_subscription_id, external_reference, purpose")
        .eq("organization_id", org.id)
        .eq("status", "paid")
        .gte("paid_at", since);

      let systemPaid = false;
      for (const inv of paidInvoices ?? []) {
        if (await isSystemInvoice(supabase, inv)) {
          systemPaid = true;
          break;
        }
      }
      if (!systemPaid) continue;
```

O bloco de `block_access` e o UPDATE que segue ficam inalterados.

- [ ] **Step 5: `process-trial-expiry` — assinatura de WhatsApp não prorroga trial**

O filtro atual pula qualquer org com assinatura não-cancelada. Restrinja à categoria de sistema — aqui dá para fazer no próprio PostgREST, porque `billing_plan_id` é NOT NULL:

```ts
    // 2) Filtra orgs que JÁ têm subscription de SISTEMA (admin criou plano
    //    manual durante o trial). Uma assinatura de instância de WhatsApp NÃO
    //    conta: ela não dá acesso ao sistema, e considerá-la aqui faria o trial
    //    nunca expirar para quem contratou só a automação.
    const { data: activeSubs } = await supabase
      .from("billing_subscriptions")
      .select("organization_id, billing_plans!inner(category)")
      .in("organization_id", orgIds)
      .neq("status", "canceled")
      .eq("billing_plans.category", "SYSTEM_SUBSCRIPTION");
    const orgsWithActiveSub = new Set((activeSubs ?? []).map((s) => s.organization_id as string));
```

- [ ] **Step 6: `process-billing-reconcile` — dois pontos**

Import: `import { isSystemInvoice, isSystemSubscription } from "../_shared/billing-category.ts";`

No sync de status da assinatura, envolva o bloco que escreve `organizations`:

```ts
        // Sync org billing_status se mudou — SÓ quando a assinatura é de sistema.
        if (newStatus !== sub.status && (await isSystemSubscription(supabase, sub.id))) {
```

No sync de faturas, o desbloqueio por fatura paga:

```ts
        if (i.status === "paid" && (await isSystemInvoice(supabase, inv))) {
```

Para isso, o SELECT de faturas do worker precisa trazer `billing_subscription_id, external_reference, purpose` — adicione as colunas se não estiverem lá.

- [ ] **Step 7: `manage-billing` — cancelamento imediato e criação de assinatura**

Import: `import { isSystemSubscription, planCategoryOf } from "../_shared/billing-category.ts";`

Na action `cancel_subscription`, ramo `else` (cancelamento imediato):

```ts
        await supabase.from("billing_subscriptions").update({
          status: "canceled",
          canceled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", subscription_id);

        // Só o cancelamento da assinatura de SISTEMA cancela a organização.
        // Cancelar a instância de WhatsApp marcava a org inteira como
        // 'canceled' — o cliente perdia o sistema por desistir da automação.
        if (await isSystemSubscription(supabase, subscription_id)) {
          await supabase.from("organizations").update({
            billing_status: "canceled",
          }).eq("id", sub.organization_id);
        }
```

Na action `create_subscription`, o UPDATE de `organizations` (hoje incondicional):

```ts
      // Assinatura criada à mão pelo admin. Só a de sistema move o
      // billing_status da organização — criar a instância de WhatsApp para um
      // cliente em atraso não pode marcá-lo como 'active'.
      const createdCategory = await planCategoryOf(supabase, plan.id);
      if (createdCategory === "SYSTEM_SUBSCRIPTION") {
        const billingStatus = trial_days ? "trialing" : "active";
        await supabase.from("organizations").update({
          billing_status: billingStatus,
          trial_ends_at: trialEnd,
        }).eq("id", organization_id);
      }
```

Ainda em `manage-billing`, na action `update_plan`, traduza o erro do trigger da Task 5 (hoje viraria um 500 genérico):

```ts
      if (updErr) {
        if (updErr.message?.includes("plan_category_locked")) {
          return jsonResponse(req, {
            error: "Não é possível mudar a categoria de um plano que já tem assinatura ativa. Desative o plano e crie um novo.",
          }, 409);
        }
        jsonLog("error", { reqId, evt: "billing_update_plan_error", err: updErr.message });
        return jsonResponse(req, { error: "Falha ao atualizar plano." }, 500);
      }
```

(Ajuste os nomes das variáveis ao que já existe no handler — o ponto é o `409` antes do `500` genérico.)

- [ ] **Step 8: Verificar que nenhum writer ficou de fora**

```bash
grep -rn "billing_status" supabase/functions --include=*.ts | grep -v "select" | grep -v "//"
```
Confira cada escrita restante. As legítimas sem gate de categoria são: `applyAsaasEvent` (já gateada na Task 6), `block_organization_manual` / `unblock_organization_manual` / `create_override` em `manage-billing` (ação administrativa explícita sobre a organização, não derivada de assinatura) e `manage-organizations` (criação da org com trial). Qualquer outra precisa de justificativa escrita no PR.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/billing-category.ts supabase/functions/process-billing-overdue/index.ts supabase/functions/process-billing-reminders/index.ts supabase/functions/process-billing-unblock/index.ts supabase/functions/process-trial-expiry/index.ts supabase/functions/process-billing-reconcile/index.ts supabase/functions/manage-billing/index.ts
git commit -m "fix(billing): so assinatura/fatura de sistema escreve organizations.billing_status"
```

---

## Task 9: `create-billing-checkout` — roteador por `purpose` e ciclo de vida da sessão

A EF hoje tem 583 linhas com dois provedores, dois modos e o mapa de sessão inline. Esta task a divide em quatro arquivos, troca `mode` por `purpose` no contrato e implementa a dedupe de sessão. **O comportamento do caminho de assinatura de sistema não muda** — é a garantia de que a task pode ser revisada isoladamente.

**Files:**
- Create: `supabase/functions/_shared/checkout-sessions.ts`
- Create: `supabase/functions/create-billing-checkout/context.ts`
- Create: `supabase/functions/create-billing-checkout/subscription.ts`
- Create: `supabase/functions/create-billing-checkout/eligibility.ts` (stub; a Task 11 implementa)
- Create: `supabase/functions/create-billing-checkout/implementation.ts` (stub; a Task 10 implementa)
- Rewrite: `supabase/functions/create-billing-checkout/index.ts`
- Modify: `supabase/functions/_shared/billing-provider.ts` (`+ minutesToExpire`)

**Interfaces:**
- Consumes: `billing_checkout_sessions` com ciclo de vida (Task 3).
- Produces, de `context.ts`:
  - `type CheckoutPurpose = "subscription" | "implementation" | "payment_method_update"`
  - `interface CheckoutContext { reqId, organizationId, callerId, callerEmail, org, plan, successBase }`
  - `interface PlanRow { id, name, amount_cents, provider, billing_type, interval, category, active, stripe_price_id_card, trial_days }`
  - `loadPlan(planId): Promise<PlanRow | null>`
  - `requireAsaasEnabled(reqId, orgId, planId): Promise<{ ok: true } | { ok: false; status: number; error: string }>`
  - `resolveAsaasCustomer(ctx): Promise<{ ok: true; customerId: string } | { ok: false; status: number; error: string }>`
  - `reserveCheckoutSession(args): Promise<ReserveResult>`
  - `finalizeCheckoutSession(sessionId, args): Promise<boolean>`
  - `failCheckoutSession(sessionId): Promise<void>`
  - `CHECKOUT_EXPIRY_MINUTES = 30`

  A Task 10 consome todas elas.

- [ ] **Step 1: Adicionar `minutesToExpire` ao port**

Em `_shared/billing-provider.ts`, dentro de `CreateCheckoutParams`:

```ts
  /** 10–1440 (§9). É daqui que sai o `expires_at` gravado em
   * billing_checkout_sessions — sem enviá-lo, a expiração da sessão viraria
   * palpite nosso sobre o comportamento do Asaas. */
  minutesToExpire?: number;
```

E, em `asaasProvider.createCheckout`, depois de montar `checkoutParams`:

```ts
      if (params.minutesToExpire !== undefined) {
        checkoutParams.minutesToExpire = params.minutesToExpire;
      }
```

- [ ] **Step 2: Criar `context.ts`**

```ts
// Prelúdio comum dos handlers de checkout: organização, plano (do banco),
// cliente Asaas, gate de flag e o ciclo de vida da sessão.
//
// Existe como arquivo separado porque os três purposes precisam exatamente das
// mesmas cinco coisas antes de divergir, e porque o painel administrativo
// (manage-whatsapp-implementations) reusa a mesma reserva de sessão.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";

export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export const APP_BASE_URL =
  Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

/** Janela do checkout hospedado. Dentro do intervalo aceito pelo Asaas (10–1440)
 *  e curta o bastante para uma sessão abandonada não travar o botão por horas. */
export const CHECKOUT_EXPIRY_MINUTES = 30;

export type CheckoutPurpose = "subscription" | "implementation" | "payment_method_update";

export interface PlanRow {
  id: string;
  name: string;
  amount_cents: number | null;
  provider: string | null;
  billing_type: string | null;
  /** NOT NULL no banco (CHECK month|year). Tipado nullable por segurança de
   *  leitura e validado no provider — assumir mensal cobraria o valor anual
   *  todo mês. */
  interval: string | null;
  category: string | null;
  active: boolean;
  stripe_price_id_card: string | null;
  trial_days: number | null;
}

export interface OrgRow {
  slug: string | null;
  name: string | null;
  billing_email: string | null;
}

export interface CheckoutContext {
  reqId: string;
  organizationId: string;
  callerId: string;
  callerEmail: string | null;
  org: OrgRow | null;
  plan: PlanRow | null;
  successBase: string;
}

export interface HandlerFailure {
  ok: false;
  status: number;
  error: string;
}

export async function loadPlan(planId: string): Promise<PlanRow | null> {
  const { data } = await supabase
    .from("billing_plans")
    .select(
      "id, name, amount_cents, provider, billing_type, interval, category, active, stripe_price_id_card, trial_days",
    )
    .eq("id", planId)
    .maybeSingle();
  return (data as PlanRow | null) ?? null;
}

export async function resolveOrg(organizationId: string): Promise<OrgRow | null> {
  const { data } = await supabase
    .from("organizations")
    .select("slug, name, billing_email")
    .eq("id", organizationId)
    .maybeSingle();
  return (data as OrgRow | null) ?? null;
}

export async function resolveUnitSlug(organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("units")
    .select("slug")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.slug ?? null;
}

/**
 * Gate CRÍTICO de simetria com o webhook — texto integral do raciocínio no
 * comentário original da EF: o asaas-webhook fail-closa em `asaas_enabled` e
 * DESCARTA o evento com a flag OFF. Abrir um checkout aqui nesse estado geraria
 * cobrança REAL cuja confirmação seria jogada fora, sem nem billing_events para
 * o reconcile recuperar. Checado ANTES de qualquer I/O no Asaas: criar o
 * customer e então abortar deixaria um `cus_...` órfão (o Asaas não deduplica).
 * Leitura falha e OFF genuíno caem no MESMO fail-closed — só o nível do log os
 * distingue.
 */
export async function requireAsaasEnabled(
  reqId: string,
  organizationId: string,
  planId: string | null,
): Promise<{ ok: true } | HandlerFailure> {
  const flag = await checkFlagEnabled("asaas_enabled");
  if (flag.enabled) return { ok: true };
  jsonLog(flag.readFailed ? "error" : "warn", {
    reqId,
    evt: "checkout_asaas_disabled",
    orgId: organizationId,
    planId,
    readFailed: flag.readFailed,
  });
  return {
    ok: false,
    status: 503,
    error:
      "A cobrança pelo Asaas está temporariamente indisponível. Tente novamente em instantes ou fale com o suporte.",
  };
}

/**
 * Cliente Asaas da organização, criando se ainda não existe e persistindo o id.
 * Abortar quando o INSERT do id falha é deliberado: o cliente EXISTE lá, e a
 * próxima tentativa criaria um duplicado.
 */
export async function resolveAsaasCustomer(
  ctx: CheckoutContext,
  createCustomer: (args: {
    organizationId: string;
    name?: string;
    email?: string;
    taxId: string;
  }) => Promise<{ ok: boolean; data?: { customerId: string }; error?: string }>,
): Promise<{ ok: true; customerId: string } | HandlerFailure> {
  const { data: customerRow, error: customerErr } = await supabase
    .from("billing_customers")
    .select("id, asaas_customer_id, name, email, tax_id")
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();

  if (customerErr) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_billing_customer_read_error",
      orgId: ctx.organizationId,
      err: customerErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao carregar o cadastro de cobrança." };
  }
  if (!customerRow?.tax_id) {
    return {
      ok: false,
      status: 400,
      error:
        "CPF/CNPJ da empresa não está cadastrado. Preencha o cadastro fiscal antes de contratar.",
    };
  }
  if (customerRow.asaas_customer_id) {
    return { ok: true, customerId: customerRow.asaas_customer_id };
  }

  const created = await createCustomer({
    organizationId: ctx.organizationId,
    name: customerRow.name ?? ctx.org?.name ?? undefined,
    email: customerRow.email ?? ctx.org?.billing_email ?? ctx.callerEmail ?? undefined,
    taxId: customerRow.tax_id,
  });
  if (!created.ok || !created.data) {
    // Mensagem FIXA: created.error carrega texto de validação cru do Asaas, que
    // o dono do restaurante não deve ler. O detalhe fica no log.
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_asaas_customer_error",
      orgId: ctx.organizationId,
      err: created.error ?? null,
    });
    return {
      ok: false,
      status: 502,
      error: "Não foi possível cadastrar a empresa no provedor de pagamento. Tente novamente em instantes.",
    };
  }

  const { error: persistErr } = await supabase
    .from("billing_customers")
    .update({ asaas_customer_id: created.data.customerId })
    .eq("id", customerRow.id);
  if (persistErr) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_asaas_customer_persist_error",
      orgId: ctx.organizationId,
      err: persistErr.message,
    });
    return {
      ok: false,
      status: 500,
      error: "Falha ao salvar o cadastro no provedor. Tente novamente em instantes.",
    };
  }
  return { ok: true, customerId: created.data.customerId };
}

// O ciclo de vida da sessão mora em _shared/checkout-sessions.ts (Step 2b) —
// reexportado aqui para os handlers importarem de um lugar só.
export {
  CHECKOUT_EXPIRY_MINUTES,
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  type ReserveResult,
} from "../_shared/checkout-sessions.ts";
```

> `CHECKOUT_EXPIRY_MINUTES` aparece nas duas listas de export porque a constante é declarada em `_shared/checkout-sessions.ts`; remova a declaração local mostrada acima e mantenha só o reexport.

- [ ] **Step 2b: Criar `_shared/checkout-sessions.ts`**

Vive em `_shared/` desde já, e não dentro de `create-billing-checkout/`, porque o painel administrativo (`manage-whatsapp-implementations`, action `create_asaas_charge`, Task 13) abre a mesma cobrança e precisa da mesma dedupe. Duplicar criaria duas verdades sobre quando uma sessão está viva.

O `supabase` é o **primeiro parâmetro** em todas as funções — o módulo não instancia cliente próprio, para que as duas EFs usem o service_role já criado por elas.

```ts
/**
 * Ciclo de vida de billing_checkout_sessions (Fase 5a).
 *
 * O Asaas não tem Idempotency-Key: dois cliques abrem duas cobranças reais. A
 * linha 'creating' reservada ANTES da chamada, mais o UNIQUE parcial
 * (organization_id, plan_id, purpose) restrito a ('creating','pending'), são o
 * que serializa isso.
 *
 * REDEPLOY: create-billing-checkout, manage-whatsapp-implementations.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";

/** Janela do checkout hospedado. Dentro do intervalo aceito pelo Asaas (10–1440)
 *  e curta o bastante para uma sessão abandonada não travar o botão por horas. */
export const CHECKOUT_EXPIRY_MINUTES = 30;

export type CheckoutSessionPurpose = "subscription" | "implementation";

export type ReserveResult =
  | { ok: true; sessionId: string }
  /** Já existe checkout pagável para este produto — devolve a MESMA url. */
  | { ok: false; reuse: true; url: string; providerCheckoutId: string | null }
  | { ok: false; reuse?: false; status: number; error: string };

/**
 * Reserva a intenção de checkout ANTES de chamar o Asaas.
 *
 * O Asaas não tem Idempotency-Key: dois cliques abrem duas cobranças reais. A
 * linha 'creating' + o UNIQUE parcial (organization_id, plan_id, purpose) são o
 * que serializa isso. Sequência:
 *   1. varre sessões vencidas do mesmo produto para 'expired';
 *   2. tenta inserir a reserva;
 *   3. no 23505, lê a viva: 'pending' com url → reusa; 'creating' → 409.
 */
export async function reserveCheckoutSession(
  supabase: SupabaseClient,
  args: {
    reqId: string;
    organizationId: string;
    planId: string;
    purpose: CheckoutSessionPurpose;
    externalReference: string;
  },
): Promise<ReserveResult> {
  const nowIso = new Date().toISOString();
  // Sessão vencida não pode travar o botão. `expires_at is null` cobre as
  // reservas órfãs (isolate morto entre a reserva e a resposta do Asaas), que
  // nunca chegaram a ter data.
  const staleCutoff = new Date(Date.now() - CHECKOUT_EXPIRY_MINUTES * 60_000).toISOString();
  await supabase
    .from("billing_checkout_sessions")
    .update({ status: "expired" })
    .eq("organization_id", args.organizationId)
    .eq("plan_id", args.planId)
    .eq("purpose", args.purpose)
    .in("status", ["creating", "pending"])
    .or(`expires_at.lt.${nowIso},and(expires_at.is.null,created_at.lt.${staleCutoff})`);

  const { data: reserved, error: insErr } = await supabase
    .from("billing_checkout_sessions")
    .insert({
      provider: "asaas",
      organization_id: args.organizationId,
      plan_id: args.planId,
      purpose: args.purpose,
      external_reference: args.externalReference,
      status: "creating",
    })
    .select("id")
    .maybeSingle();

  if (!insErr && reserved) return { ok: true, sessionId: reserved.id as string };

  if (insErr && insErr.code === "23505") {
    const { data: live } = await supabase
      .from("billing_checkout_sessions")
      .select("status, checkout_url, provider_checkout_id")
      .eq("organization_id", args.organizationId)
      .eq("plan_id", args.planId)
      .eq("purpose", args.purpose)
      .in("status", ["creating", "pending"])
      .maybeSingle();

    if (live?.status === "pending" && live.checkout_url) {
      jsonLog("info", {
        reqId: args.reqId,
        evt: "checkout_session_reused",
        orgId: args.organizationId,
        purpose: args.purpose,
      });
      return {
        ok: false,
        reuse: true,
        url: live.checkout_url as string,
        providerCheckoutId: (live.provider_checkout_id as string | null) ?? null,
      };
    }
    // Irmão ainda em 'creating': a chamada ao Asaas dele está em voo. Devolver
    // 409 é melhor que abrir uma segunda cobrança real.
    return {
      ok: false,
      status: 409,
      error: "Já existe um checkout sendo aberto para este produto. Aguarde alguns segundos e tente de novo.",
    };
  }

  jsonLog("error", {
    reqId: args.reqId,
    evt: "checkout_session_reserve_error",
    orgId: args.organizationId,
    err: insErr?.message ?? "insert sem linha",
  });
  return { ok: false, status: 500, error: "Falha ao registrar o checkout. Tente novamente em instantes." };
}

/**
 * Promove a reserva a 'pending'. Devolve false quando a escrita falha — e o
 * caller ABORTA: um checkout pagável sem linha correlacionável é pagamento
 * perdido em silêncio (o webhook resolve a org pelo checkoutSession).
 */
export async function finalizeCheckoutSession(
  supabase: SupabaseClient,
  sessionId: string,
  args: { providerCheckoutId: string; checkoutUrl: string },
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRY_MINUTES * 60_000).toISOString();
  const { error } = await supabase
    .from("billing_checkout_sessions")
    .update({
      status: "pending",
      provider_checkout_id: args.providerCheckoutId,
      checkout_url: args.checkoutUrl,
      expires_at: expiresAt,
    })
    .eq("id", sessionId);
  if (error) {
    jsonLog("error", {
      evt: "checkout_session_finalize_error",
      sessionId,
      err: error.message,
    });
    return false;
  }
  return true;
}

/** Libera o UNIQUE quando o Asaas recusou — sem isto o cliente ficaria 30min
 *  sem conseguir tentar de novo por causa de um erro que não foi dele. */
export async function failCheckoutSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const { error } = await supabase
    .from("billing_checkout_sessions")
    .update({ status: "failed" })
    .eq("id", sessionId);
  if (error) jsonLog("warn", { evt: "checkout_session_fail_mark_error", sessionId, err: error.message });
}
```

- [ ] **Step 3: Criar `subscription.ts`**

Move o ramo Asaas de assinatura e o ramo Stripe (legado, incluindo `payment_method_update`) para cá, agora usando o ciclo de sessão. Os gates específicos da instância de R$ 149 são da Task 11, e este arquivo **não** carrega um comentário de pendência: ele já chama `assertCanContractPlan`, que nasce como no-op e ganha corpo na Task 11.

```ts
import { jsonLog } from "../_shared/security.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { buildExternalReference } from "../_shared/asaas-billing-events.ts";
import { getStripeSecretKey } from "../_shared/stripe-config.ts";
import { createStripeCustomer } from "../_shared/stripe-billing.ts";
import {
  supabase,
  requireAsaasEnabled,
  resolveAsaasCustomer,
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  CHECKOUT_EXPIRY_MINUTES,
  type CheckoutContext,
  type CheckoutPurpose,
} from "./context.ts";
import { assertCanContractPlan } from "./eligibility.ts";

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleSubscription(
  ctx: CheckoutContext,
  purpose: CheckoutPurpose,
): Promise<HandlerResult> {
  const plan = ctx.plan;
  if (!plan) return { status: 400, body: { error: "plan_id é obrigatório para contratar uma assinatura." } };
  if (!plan.active) return { status: 400, body: { error: "Plano inativo." } };
  // Produto de cobrança única (implantação, recarga de IA) não é assinatura:
  // seguir aqui abriria um RECURRENT e cobraria todo mês por algo avulso.
  if (plan.billing_type === "one_time") {
    return {
      status: 400,
      body: { error: "Este produto é de cobrança única e não pode ser contratado como assinatura." },
    };
  }

  // Elegibilidade por categoria (Task 11). Para SYSTEM_SUBSCRIPTION é no-op.
  const eligibility = await assertCanContractPlan(ctx, plan);
  if (!eligibility.ok) return { status: eligibility.status, body: { error: eligibility.error } };

  const provider = plan.provider === "asaas" || plan.provider === "stripe" ? plan.provider : null;
  if (provider === "asaas") return await asaasSubscriptionCheckout(ctx, plan);
  return await stripeCheckout(ctx, purpose);
}
```

O corpo de `asaasSubscriptionCheckout` é o ramo Asaas atual da EF (linhas 266-497 do arquivo original), com **três** mudanças:

1. o gate de flag vira `await requireAsaasEnabled(ctx.reqId, ctx.organizationId, plan.id)`;
2. o cliente Asaas vem de `resolveAsaasCustomer(ctx, (a) => asaas.createCustomer(a))`;
3. o `insert` inline em `billing_checkout_sessions` some, substituído por:

```ts
  const externalReference = buildExternalReference({
    orgId: ctx.organizationId,
    planId: plan.id,
    purpose: "subscription",
  });

  const reserved = await reserveCheckoutSession(supabase, {
    reqId: ctx.reqId,
    organizationId: ctx.organizationId,
    planId: plan.id,
    purpose: "subscription",
    externalReference,
  });
  if (!reserved.ok && reserved.reuse) {
    return { status: 200, body: { success: true, url: reserved.url, session_id: reserved.providerCheckoutId } };
  }
  if (!reserved.ok) return { status: reserved.status, body: { error: reserved.error } };

  const checkout = await asaas.createCheckout({
    providerCustomerId: customerId,
    amountCents: plan.amount_cents!,
    description: plan.name,
    interval: plan.interval,
    externalReference,
    mode: "subscription",
    minutesToExpire: CHECKOUT_EXPIRY_MINUTES,
    successUrl: `${ctx.successBase}?session=success`,
    cancelUrl: `${ctx.successBase}?session=cancel`,
  });

  if (!checkout.ok || !checkout.data?.checkoutId) {
    await failCheckoutSession(supabase, reserved.sessionId);
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_asaas_error",
      orgId: ctx.organizationId,
      planId: plan.id,
      err: checkout.error ?? "checkout sem id",
    });
    return {
      status: 502,
      body: { error: "Não foi possível abrir o checkout de pagamento. Tente novamente em instantes." },
    };
  }

  // Persistir é PRÉ-REQUISITO: sem a linha correlacionável, o webhook não
  // resolve a org e o pagamento se perde em silêncio.
  const finalized = await finalizeCheckoutSession(supabase, reserved.sessionId, {
    providerCheckoutId: checkout.data.checkoutId,
    checkoutUrl: checkout.data.url,
  });
  if (!finalized) {
    return { status: 500, body: { error: "Falha ao registrar o checkout. Tente novamente em instantes." } };
  }

  jsonLog("info", {
    reqId: ctx.reqId,
    evt: "checkout_session_created",
    provider: "asaas",
    orgId: ctx.organizationId,
    planId: plan.id,
    purpose: "subscription",
    sessionId: checkout.data.checkoutId,
  });
  return {
    status: 200,
    body: { success: true, url: checkout.data.url, session_id: checkout.data.checkoutId },
  };
```

`stripeCheckout(ctx, purpose)` recebe o caminho Stripe **inalterado** das linhas 500-578, com `mode` derivado do purpose: `purpose === "payment_method_update" ? "setup" : "subscription"`. O ramo Stripe **não** passa pelo gate `asaas_enabled` nem pelo ciclo de sessão — ele é legado e continua exatamente como está.

Crie também `eligibility.ts` com o stub que a Task 11 preenche:

```ts
// Elegibilidade por categoria de plano. Na Fase 5a só WHATSAPP_SUBSCRIPTION tem
// regra própria (Task 11); SYSTEM_SUBSCRIPTION passa direto.
import type { CheckoutContext, PlanRow, HandlerFailure } from "./context.ts";

export async function assertCanContractPlan(
  _ctx: CheckoutContext,
  _plan: PlanRow,
): Promise<{ ok: true } | HandlerFailure> {
  return { ok: true };
}
```

- [ ] **Step 4: Reescrever `index.ts` como roteador**

```ts
// Edge Function: create-billing-checkout
// Abre o checkout hospedado, roteado por PURPOSE (Fase 5a).
//
// Auth: JWT obrigatório. Caller precisa ser platform_admin OU member
// (owner|gerente) de alguma unit da organization_id alvo.
//
// purpose=subscription           → assinatura (sistema R$449 ou instância R$149)
// purpose=implementation         → cobrança avulsa da implantação (R$750)
// purpose=payment_method_update  → troca de cartão (só Stripe, legado)
//
// O SERVIDOR resolve categoria, modalidade, preço e intervalo a partir de
// billing_plans. O navegador manda apenas organization_id, plan_id e purpose.
// Nada aqui ativa acesso — quem ativa é o webhook do provedor.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  supabase,
  loadPlan,
  resolveOrg,
  resolveUnitSlug,
  APP_BASE_URL,
  type CheckoutContext,
  type CheckoutPurpose,
} from "./context.ts";
import { handleSubscription } from "./subscription.ts";
import { handleImplementation } from "./implementation.ts";

const PURPOSES: ReadonlySet<string> = new Set([
  "subscription",
  "implementation",
  "payment_method_update",
]);

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function canManageOrgBilling(userId: string, organizationId: string): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  const { data } = await supabase
    .from("unit_members")
    .select("role, units!inner(organization_id)")
    .eq("user_id", userId)
    .in("role", ["owner", "gerente"])
    .eq("units.organization_id", organizationId)
    .limit(1);
  return !!(data && data.length > 0);
}

/**
 * `mode` saiu do contrato. Aceito por UMA release porque o frontend em produção
 * ainda manda `mode:'setup'` para trocar cartão, e derrubar isso quebraria a
 * troca de cartão entre o deploy da EF e o do frontend. A remoção do compat é
 * item da Fase 5b.
 */
function resolvePurpose(body: { purpose?: string; mode?: string }, reqId: string): string | null {
  if (body.purpose) return body.purpose;
  if (body.mode) {
    jsonLog("warn", { reqId, evt: "checkout_legacy_mode_param", mode: body.mode });
    if (body.mode === "setup") return "payment_method_update";
    if (body.mode === "subscription") return "subscription";
    return null;
  }
  return "subscription";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "Método não permitido." }, 405);

  const reqId = genRequestId();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);

    const body = (await req.json().catch(() => ({}))) as {
      organization_id?: string;
      plan_id?: string;
      purpose?: string;
      mode?: string;
    };

    if (!body.organization_id) {
      return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
    }

    const purpose = resolvePurpose(body, reqId);
    if (!purpose || !PURPOSES.has(purpose)) {
      return jsonResponse(req, { error: "Tipo de checkout inválido." }, 400);
    }
    if (purpose !== "payment_method_update" && !body.plan_id) {
      return jsonResponse(req, { error: "plan_id é obrigatório." }, 400);
    }

    if (!(await canManageOrgBilling(callerData.user.id, body.organization_id))) {
      return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
    }

    const plan = body.plan_id ? await loadPlan(body.plan_id) : null;
    if (body.plan_id && !plan) return jsonResponse(req, { error: "Plano não encontrado." }, 404);

    const [org, unitSlug] = await Promise.all([
      resolveOrg(body.organization_id),
      resolveUnitSlug(body.organization_id),
    ]);

    const ctx: CheckoutContext = {
      reqId,
      organizationId: body.organization_id,
      callerId: callerData.user.id,
      callerEmail: callerData.user.email ?? null,
      org,
      plan,
      successBase: unitSlug
        ? `${APP_BASE_URL}/g/${unitSlug}/cobranca`
        : `${APP_BASE_URL}/platform/billing/${body.organization_id}`,
    };

    const result = purpose === "implementation"
      ? await handleImplementation(ctx)
      : await handleSubscription(ctx, purpose as CheckoutPurpose);

    return jsonResponse(req, result.body, result.status);
  } catch (err) {
    jsonLog("error", {
      reqId,
      evt: "checkout_unexpected_error",
      err: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(req, { error: "Erro inesperado ao criar checkout." }, 500);
  }
});
```

> `handleImplementation` é da Task 10. Para manter esta task compilável isoladamente, crie `implementation.ts` já com a assinatura final devolvendo `{ status: 503, body: { error: "Fluxo indisponível." } }`; a Task 10 substitui o corpo.

- [ ] **Step 5: Revisão manual do que o compilador não vê**

Reler os quatro arquivos confirmando:
1. o gate `asaas_enabled` continua **antes** de qualquer I/O no Asaas (inclusive antes de `createCustomer`);
2. nenhum valor monetário vem do `body`;
3. o ramo Stripe não passa a depender de nada novo;
4. `failCheckoutSession` é chamado em **todo** caminho de erro depois da reserva.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/create-billing-checkout/ supabase/functions/_shared/checkout-sessions.ts supabase/functions/_shared/billing-provider.ts
git commit -m "refactor(billing): create-billing-checkout roteada por purpose com ciclo de sessao"
```

---

## Task 10: Checkout da implantação (R$ 750) — `DETACHED`

O caminho avulso (`chargeTypes: ["DETACHED"]`) existe em `billing-provider.ts` desde a Fase 2 e **nunca teve um call site**. Esta task é o primeiro uso real dele, e por isso é também o primeiro item do roteiro de sandbox.

A lógica vive em `_shared/implementation-checkout.ts`, não no handler, porque o painel administrativo (`manage-whatsapp-implementations`, action `create_asaas_charge`) precisa abrir exatamente a mesma cobrança.

**Files:**
- Create: `supabase/functions/_shared/implementation-checkout.ts`
- Rewrite: `supabase/functions/create-billing-checkout/implementation.ts` (o stub da Task 9)

**Interfaces:**
- Consumes: `reserveCheckoutSession` / `finalizeCheckoutSession` / `failCheckoutSession` / `requireAsaasEnabled` / `resolveAsaasCustomer` (Task 9), `whatsapp_implementations` (Task 2), `checkFlagEnabled` (`whatsapp_implementation_flow`).
- Produces: `openImplementationCheckout(args): Promise<ImplementationCheckoutResult>`, consumida também pela Task 13.

- [ ] **Step 1: Criar `_shared/implementation-checkout.ts`**

```ts
/**
 * Abre a cobrança avulsa da implantação do WhatsApp (R$ 750) e cria a linha de
 * whatsapp_implementations correspondente.
 *
 * COMPARTILHADO de propósito entre a contratação pelo cliente
 * (create-billing-checkout, purpose=implementation) e o painel administrativo
 * (manage-whatsapp-implementations, action create_asaas_charge): as duas
 * precisam da MESMA cobrança, do mesmo valor e da mesma linha. Duplicar isso
 * criaria dois formatos de externalReference e duas verdades sobre o preço.
 *
 * O valor vem SEMPRE de billing_plans. Nenhum caller passa preço.
 *
 * REDEPLOY: create-billing-checkout, manage-whatsapp-implementations.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { getBillingProvider } from "./billing-provider.ts";
import { buildExternalReference } from "./asaas-billing-events.ts";

export const IMPLEMENTATION_PLAN_SLUG = "implementacao-whatsapp";

export interface ImplementationPlan {
  id: string;
  name: string;
  amount_cents: number | null;
  category: string | null;
  billing_type: string | null;
  active: boolean;
}

export type ImplementationCheckoutResult =
  | { ok: true; url: string; providerCheckoutId: string; implementationId: string }
  | { ok: false; status: number; error: string };

/** Carrega o plano da implantação pelo slug e valida que ele é o que dizemos ser. */
export async function loadImplementationPlan(
  supabase: SupabaseClient,
): Promise<ImplementationPlan | null> {
  const { data } = await supabase
    .from("billing_plans")
    .select("id, name, amount_cents, category, billing_type, active")
    .eq("slug", IMPLEMENTATION_PLAN_SLUG)
    .maybeSingle();
  return (data as ImplementationPlan | null) ?? null;
}

/**
 * Fluxo completo. A ORDEM importa e cada passo desfaz o anterior no erro:
 *
 *  1. valida o plano (categoria e modalidade vêm do banco, não do caller);
 *  2. recusa se a organização já tem implantação aberta (o UNIQUE parcial é o
 *     backstop; aqui damos a mensagem decente);
 *  3. reserva a sessão de checkout ('creating');
 *  4. abre o checkout DETACHED no Asaas (cartão + PIX);
 *  5. promove a sessão a 'pending' — se falhar, aborta: checkout pagável sem
 *     linha correlacionável é pagamento perdido;
 *  6. cria whatsapp_implementations (origin=ASAAS, payment_status=PENDING).
 *
 * O passo 6 por último de propósito: só depois de existir um checkout de
 * verdade é que a linha tem sentido. Falha nele NÃO desfaz o checkout no Asaas
 * (não há como) — devolve erro e loga alto, para conferência manual, em vez de
 * fingir sucesso.
 */
export async function openImplementationCheckout(args: {
  supabase: SupabaseClient;
  reqId: string;
  organizationId: string;
  plan: ImplementationPlan;
  asaasCustomerId: string;
  successUrl: string;
  cancelUrl: string;
  minutesToExpire: number;
  createdBy: string | null;
  reserve: (a: {
    reqId: string;
    organizationId: string;
    planId: string;
    purpose: "implementation";
    externalReference: string;
  }) => Promise<
    | { ok: true; sessionId: string }
    | { ok: false; reuse: true; url: string; providerCheckoutId: string | null }
    | { ok: false; reuse?: false; status: number; error: string }
  >;
  finalize: (sessionId: string, a: { providerCheckoutId: string; checkoutUrl: string }) => Promise<boolean>;
  fail: (sessionId: string) => Promise<void>;
}): Promise<ImplementationCheckoutResult> {
  const { supabase, plan } = args;

  if (!plan.active) return { ok: false, status: 400, error: "Produto indisponível no momento." };
  if (plan.category !== "WHATSAPP_IMPLEMENTATION" || plan.billing_type !== "one_time") {
    // Configuração errada no catálogo — não é erro do cliente, mas não dá para
    // cobrar: um checkout RECURRENT aqui viraria mensalidade de R$750.
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_plan_misconfigured",
      planId: plan.id,
      category: plan.category,
      billingType: plan.billing_type,
    });
    return { ok: false, status: 500, error: "Produto mal configurado. Fale com o suporte." };
  }
  if (!plan.amount_cents || plan.amount_cents <= 0) {
    return { ok: false, status: 500, error: "Produto sem valor configurado." };
  }

  const { data: open, error: openErr } = await supabase
    .from("whatsapp_implementations")
    .select("id, payment_status, operational_status")
    .eq("organization_id", args.organizationId)
    .neq("operational_status", "CANCELED")
    .maybeSingle();
  if (openErr) {
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_open_check_failed",
      orgId: args.organizationId,
      err: openErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar a implantação da empresa." };
  }
  if (open) {
    return {
      ok: false,
      status: 409,
      error: open.payment_status === "PENDING"
        ? "Já existe uma implantação aguardando pagamento para esta empresa."
        : "Esta empresa já tem uma implantação registrada.",
    };
  }

  const externalReference = buildExternalReference({
    orgId: args.organizationId,
    planId: plan.id,
    purpose: "implementation",
  });

  const reserved = await args.reserve({
    reqId: args.reqId,
    organizationId: args.organizationId,
    planId: plan.id,
    purpose: "implementation",
    externalReference,
  });
  if (!reserved.ok && reserved.reuse) {
    // Sessão viva: devolve a MESMA url. A linha de implantação já existe (foi
    // criada na primeira tentativa) e o `open` acima teria barrado — este ramo
    // só é alcançável numa corrida, e reusar é o comportamento correto.
    return {
      ok: false,
      status: 409,
      error: "Já existe um checkout aberto para esta implantação. Use o link enviado ou aguarde a expiração.",
    };
  }
  if (!reserved.ok) return { ok: false, status: reserved.status, error: reserved.error };

  const asaas = getBillingProvider("asaas");
  const checkout = await asaas.createCheckout({
    providerCustomerId: args.asaasCustomerId,
    amountCents: plan.amount_cents,
    description: plan.name,
    externalReference,
    // DETACHED: cobrança única. Habilita cartão E PIX (o RECURRENT do Asaas só
    // aceita cartão; aqui deixar a escolha com o pagador aumenta a conversão).
    mode: "one_time",
    minutesToExpire: args.minutesToExpire,
    successUrl: args.successUrl,
    cancelUrl: args.cancelUrl,
  });

  if (!checkout.ok || !checkout.data?.checkoutId) {
    await args.fail(reserved.sessionId);
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_checkout_error",
      orgId: args.organizationId,
      err: checkout.error ?? "checkout sem id",
    });
    return {
      ok: false,
      status: 502,
      error: "Não foi possível abrir o checkout de pagamento. Tente novamente em instantes.",
    };
  }

  const finalized = await args.finalize(reserved.sessionId, {
    providerCheckoutId: checkout.data.checkoutId,
    checkoutUrl: checkout.data.url,
  });
  if (!finalized) {
    return { ok: false, status: 500, error: "Falha ao registrar o checkout. Tente novamente em instantes." };
  }

  const { data: created, error: implErr } = await supabase
    .from("whatsapp_implementations")
    .insert({
      organization_id: args.organizationId,
      origin: "ASAAS",
      payment_status: "PENDING",
      operational_status: "NOT_STARTED",
      amount_cents: plan.amount_cents,
      billing_plan_id: plan.id,
      provider_checkout_id: checkout.data.checkoutId,
      created_by: args.createdBy,
    })
    .select("id")
    .maybeSingle();

  if (implErr || !created) {
    // O checkout EXISTE no Asaas e não há como desfazê-lo. Loga alto: se o
    // cliente pagar, o webhook não vai achar linha para confirmar (cai em
    // implementation_confirm_noop) e isso precisa ser resolvido à mão.
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_row_insert_failed",
      orgId: args.organizationId,
      checkout: checkout.data.checkoutId,
      err: implErr?.message ?? "insert sem linha",
    });
    return {
      ok: false,
      status: 500,
      error: "Falha ao registrar a implantação. Fale com o suporte antes de pagar.",
    };
  }

  jsonLog("info", {
    reqId: args.reqId,
    evt: "implementation_checkout_created",
    orgId: args.organizationId,
    implementationId: created.id,
    checkout: checkout.data.checkoutId,
  });

  return {
    ok: true,
    url: checkout.data.url,
    providerCheckoutId: checkout.data.checkoutId,
    implementationId: created.id as string,
  };
}
```

- [ ] **Step 2: Escrever `implementation.ts`**

```ts
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { jsonLog } from "../_shared/security.ts";
import {
  loadImplementationPlan,
  openImplementationCheckout,
} from "../_shared/implementation-checkout.ts";
import {
  supabase,
  requireAsaasEnabled,
  resolveAsaasCustomer,
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  CHECKOUT_EXPIRY_MINUTES,
  type CheckoutContext,
} from "./context.ts";
import type { HandlerResult } from "./subscription.ts";

export async function handleImplementation(ctx: CheckoutContext): Promise<HandlerResult> {
  // Gate de visibilidade. Repetido no servidor mesmo com o botão escondido: o
  // frontend não é fronteira de autorização.
  const flag = await checkFlagEnabled("whatsapp_implementation_flow");
  if (!flag.enabled) {
    jsonLog(flag.readFailed ? "error" : "info", {
      reqId: ctx.reqId,
      evt: "implementation_flow_disabled",
      orgId: ctx.organizationId,
      readFailed: flag.readFailed,
    });
    return { status: 403, body: { error: "Este produto ainda não está disponível para contratação." } };
  }

  const asaasGate = await requireAsaasEnabled(ctx.reqId, ctx.organizationId, ctx.plan?.id ?? null);
  if (!asaasGate.ok) return { status: asaasGate.status, body: { error: asaasGate.error } };

  // O plano vem do SLUG, não do plan_id do request: a implantação é um produto
  // único, e aceitar qualquer plan_id aqui deixaria o navegador escolher o
  // preço da "implantação" apontando para outro produto do catálogo.
  const plan = await loadImplementationPlan(supabase);
  if (!plan) return { status: 404, body: { error: "Produto não encontrado." } };

  const asaas = getBillingProvider("asaas");
  const customer = await resolveAsaasCustomer(ctx, (a) => asaas.createCustomer(a));
  if (!customer.ok) return { status: customer.status, body: { error: customer.error } };

  const result = await openImplementationCheckout({
    supabase,
    reqId: ctx.reqId,
    organizationId: ctx.organizationId,
    plan,
    asaasCustomerId: customer.customerId,
    successUrl: `${ctx.successBase}?session=success`,
    cancelUrl: `${ctx.successBase}?session=cancel`,
    minutesToExpire: CHECKOUT_EXPIRY_MINUTES,
    createdBy: ctx.callerId,
    // Injetadas com o `supabase` desta EF — o módulo de sessão não instancia
    // cliente próprio, para que as duas EFs usem o service_role já criado.
    reserve: (a) => reserveCheckoutSession(supabase, a),
    finalize: (id, a) => finalizeCheckoutSession(supabase, id, a),
    fail: (id) => failCheckoutSession(supabase, id),
  });

  if (!result.ok) return { status: result.status, body: { error: result.error } };
  return {
    status: 200,
    body: { success: true, url: result.url, session_id: result.providerCheckoutId },
  };
}
```

- [ ] **Step 3: Revisão manual**

Confirmar:
1. o `plan_id` enviado pelo navegador é **ignorado** neste caminho (o produto vem do slug);
2. `whatsapp_implementation_flow` é checada **antes** de `asaas_enabled`, e as duas antes de qualquer I/O no Asaas;
3. a linha de `whatsapp_implementations` nasce com `origin='ASAAS'` e `payment_status='PENDING'` — nunca `CONFIRMED`;
4. o retorno **não** afirma que o pagamento aconteceu.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/implementation-checkout.ts supabase/functions/create-billing-checkout/implementation.ts
git commit -m "feat(billing): checkout avulso da implantacao WhatsApp (DETACHED, R$750)"
```

---

## Task 11: Gates da assinatura da instância (R$ 149)

Cinco condições, todas verificadas no servidor, todas repetidas mesmo com o botão escondido no frontend.

**Files:**
- Rewrite: `supabase/functions/create-billing-checkout/eligibility.ts` (o stub da Task 9)

**Interfaces:**
- Consumes: `canContractInstance` (Task 1), `resolveOrgEntitlements` (`_shared/entitlements.ts`), `whatsapp_implementations` (Task 2), flag `whatsapp_subscription_checkout` (Task 5).
- Produces: `assertCanContractPlan(ctx, plan)` com o mesmo shape do stub — nenhuma mudança em quem já a chama.

- [ ] **Step 1: Implementar `eligibility.ts`**

```ts
// Elegibilidade por categoria de plano.
//
// Só WHATSAPP_SUBSCRIPTION tem regra própria na Fase 5a. SYSTEM_SUBSCRIPTION
// passa direto: as condições dele (org existe, plano ativo, não é one_time) já
// foram verificadas no handler.

import { jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import { resolveOrgEntitlements } from "../_shared/entitlements.ts";
import { canContractInstance, type InstanceBlockReason } from "../_shared/whatsapp-implementation-core.ts";
import { supabase, type CheckoutContext, type PlanRow, type HandlerFailure } from "./context.ts";

const BLOCK_MESSAGE: Record<InstanceBlockReason, { status: number; error: string }> = {
  flag_off: {
    status: 403,
    error: "A contratação da mensalidade da instância ainda não está disponível.",
  },
  implementation_incomplete: {
    status: 409,
    error: "A mensalidade da instância só pode ser contratada depois que a implantação for concluída.",
  },
  system_not_allowed: {
    status: 409,
    error: "Regularize a assinatura do sistema antes de contratar a automação do WhatsApp.",
  },
  already_subscribed: {
    status: 409,
    error: "Esta empresa já tem a mensalidade da instância ativa.",
  },
  override_active: {
    // Cobrar quem tem cortesia é pior que negar a venda.
    status: 409,
    error: "O WhatsApp desta empresa já está liberado pela plataforma, sem cobrança mensal.",
  },
};

export async function assertCanContractPlan(
  ctx: CheckoutContext,
  plan: PlanRow,
): Promise<{ ok: true } | HandlerFailure> {
  if (plan.category !== "WHATSAPP_SUBSCRIPTION") return { ok: true };

  const flag = await checkFlagEnabled("whatsapp_subscription_checkout");

  const [implRes, entitlements, subsRes] = await Promise.all([
    supabase
      .from("whatsapp_implementations")
      .select("operational_status")
      .eq("organization_id", ctx.organizationId)
      .neq("operational_status", "CANCELED")
      .maybeSingle(),
    resolveOrgEntitlements(supabase, ctx.organizationId),
    supabase
      .from("billing_subscriptions")
      .select("id, billing_plans!inner(category)")
      .eq("organization_id", ctx.organizationId)
      .neq("status", "canceled")
      .eq("billing_plans.category", "WHATSAPP_SUBSCRIPTION"),
  ]);

  if (implRes.error) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "instance_eligibility_impl_read_failed",
      orgId: ctx.organizationId,
      err: implRes.error.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar a implantação da empresa." };
  }
  if (subsRes.error) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "instance_eligibility_subs_read_failed",
      orgId: ctx.organizationId,
      err: subsRes.error.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar as assinaturas da empresa." };
  }

  const verdict = canContractInstance({
    flagEnabled: flag.enabled,
    implementationOperationalStatus:
      (implRes.data?.operational_status as never) ?? null,
    systemAllowed: entitlements.system.allowed,
    hasActiveWhatsappSubscription: (subsRes.data ?? []).length > 0,
    // `source === "override"` distingue cortesia de assinatura paga — as duas
    // dão allowed=true, e só a primeira impede a venda.
    hasActiveWhatsappOverride:
      entitlements.whatsapp.allowed && entitlements.whatsapp.source === "override",
  });

  if (verdict.ok) return { ok: true };

  jsonLog("info", {
    reqId: ctx.reqId,
    evt: "instance_checkout_blocked",
    orgId: ctx.organizationId,
    reason: verdict.reason,
  });
  const msg = BLOCK_MESSAGE[verdict.reason!];
  return { ok: false, status: msg.status, error: msg.error };
}
```

- [ ] **Step 2: Verificar a cobertura contra o núcleo puro**

As cinco razões de `InstanceBlockReason` têm entrada em `BLOCK_MESSAGE`. Um `Record<InstanceBlockReason, ...>` completo faz o TypeScript reclamar se a Task 1 ganhar uma razão nova sem mensagem — mas como este arquivo não passa por `tsc`, confira à mão:

```bash
grep -o '"[a-z_]*"' supabase/functions/_shared/whatsapp-implementation-core.ts | sort -u | grep -E "flag_off|implementation_incomplete|system_not_allowed|already_subscribed|override_active"
```
Esperado: as cinco. Todas precisam existir em `BLOCK_MESSAGE`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/create-billing-checkout/eligibility.ts
git commit -m "feat(billing): gates server-side da assinatura da instancia WhatsApp"
```

---

## Task 12: `_shared/entitlement-overrides.ts` — writer único dos overrides

Hoje `organization_entitlement_overrides` só recebe INSERT pela migration de seed. A partir da 5a o admin concede e revoga cortesia de WhatsApp pela UI, e a fase seguinte fará o mesmo com IA. Um helper único agora evita que cada tela invente sua própria validação de datas e de conflito.

**Files:**
- Create: `supabase/functions/_shared/entitlement-overrides.ts`

**Interfaces:**
- Consumes: `organization_entitlement_overrides` (migration 062), `resolveOrgEntitlements` (`_shared/entitlements.ts`).
- Produces:
  - `grantOverride(supabase, args): Promise<OverrideResult>`
  - `revokeOverride(supabase, args): Promise<OverrideResult>`
  - `type OverrideResult = { ok: true; entitlements: OrgEntitlements } | { ok: false; status: number; error: string }`

  Consumidas pela Task 14.

- [ ] **Step 1: Escrever o helper**

```ts
/**
 * Único writer de organization_entitlement_overrides.
 *
 * INVARIANTE: nenhum insert/update direto nessa tabela fora deste módulo.
 * Espalhar inserts significa espalhar as regras de coerência de data, de
 * conflito e de motivo obrigatório — e a primeira que divergir cria uma
 * cortesia que o resolver não enxerga (ou uma que nunca expira).
 *
 * Webhook financeiro NUNCA chama estas funções: override é decisão
 * administrativa, e um pagamento não concede cortesia.
 *
 * REDEPLOY: manage-whatsapp-implementations.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { resolveOrgEntitlements, type OrgEntitlements } from "./entitlements.ts";

export type OverrideFeature = "system" | "whatsapp" | "ai";
/** Espelha o CHECK da migration 062. Rótulos de UI vivem em src/types/billing.ts. */
export type OverrideGrantType = "LIFETIME" | "TEMPORARY" | "PROMOTIONAL" | "MANUAL_OVERRIDE";

const FEATURES: ReadonlySet<string> = new Set(["system", "whatsapp", "ai"]);
const GRANT_TYPES: ReadonlySet<string> = new Set([
  "LIFETIME",
  "TEMPORARY",
  "PROMOTIONAL",
  "MANUAL_OVERRIDE",
]);

export type OverrideResult =
  | { ok: true; entitlements: OrgEntitlements }
  | { ok: false; status: number; error: string };

export interface GrantOverrideArgs {
  organizationId: string;
  feature: OverrideFeature;
  grantType: OverrideGrantType;
  reason: string;
  grantedBy: string;
  /** ISO. Obrigatório e futuro em TEMPORARY; recusado em LIFETIME. */
  endsAt?: string | null;
  /** false = bloqueio administrativo explícito (prioridade 1 no resolver). */
  enabled?: boolean;
}

export async function grantOverride(
  supabase: SupabaseClient,
  args: GrantOverrideArgs,
): Promise<OverrideResult> {
  if (!FEATURES.has(args.feature)) {
    return { ok: false, status: 400, error: "Funcionalidade inválida." };
  }
  if (!GRANT_TYPES.has(args.grantType)) {
    return { ok: false, status: 400, error: "Tipo de concessão inválido." };
  }
  if (!args.reason?.trim()) {
    // Motivo é obrigatório no banco (NOT NULL) e é o que torna a auditoria
    // legível seis meses depois. Recusar aqui dá mensagem melhor que 23502.
    return { ok: false, status: 400, error: "Informe o motivo da concessão." };
  }
  if (!args.grantedBy) {
    return { ok: false, status: 400, error: "Responsável pela concessão não identificado." };
  }

  const nowMs = Date.now();
  if (args.grantType === "TEMPORARY") {
    if (!args.endsAt) {
      return { ok: false, status: 400, error: "Acesso temporário exige uma data de validade." };
    }
    const endsMs = new Date(args.endsAt).getTime();
    if (!Number.isFinite(endsMs) || endsMs <= nowMs) {
      return { ok: false, status: 400, error: "A validade precisa ser uma data futura." };
    }
  } else if (args.grantType === "LIFETIME" && args.endsAt) {
    // Coerência: LIFETIME com ends_at é um TEMPORARY disfarçado, e o resolver
    // trataria como expirável — o operador acharia que deu acesso vitalício.
    return { ok: false, status: 400, error: "Acesso vitalício não tem data de validade." };
  }

  // Conflito com override vivo da MESMA feature. Empilhar dois grants deixaria
  // a revogação parcial (o resolver escolhe o mais duradouro e o outro fica
  // órfão, invisível na UI e ainda válido).
  const nowIso = new Date().toISOString();
  const { data: existing, error: existingErr } = await supabase
    .from("organization_entitlement_overrides")
    .select("id, enabled, grant_type")
    .eq("organization_id", args.organizationId)
    .eq("feature", args.feature)
    .is("revoked_at", null)
    .lte("starts_at", nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .limit(1);

  if (existingErr) {
    jsonLog("error", {
      evt: "override_conflict_check_failed",
      org: args.organizationId,
      feature: args.feature,
      err: existingErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar as concessões atuais." };
  }
  if ((existing ?? []).length > 0) {
    const cur = existing![0];
    return {
      ok: false,
      status: 409,
      error: cur.enabled
        ? "Já existe uma concessão ativa para esta funcionalidade. Revogue a atual antes de criar outra."
        : "Existe um bloqueio administrativo ativo para esta funcionalidade. Revogue o bloqueio antes de conceder.",
    };
  }

  const { error: insErr } = await supabase.from("organization_entitlement_overrides").insert({
    organization_id: args.organizationId,
    feature: args.feature,
    enabled: args.enabled ?? true,
    grant_type: args.grantType,
    ends_at: args.grantType === "TEMPORARY" ? args.endsAt : null,
    reason: args.reason.trim(),
    granted_by: args.grantedBy,
  });
  if (insErr) {
    jsonLog("error", {
      evt: "override_grant_failed",
      org: args.organizationId,
      feature: args.feature,
      err: insErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao registrar a concessão." };
  }

  jsonLog("info", {
    evt: "override_granted",
    org: args.organizationId,
    feature: args.feature,
    grantType: args.grantType,
    enabled: args.enabled ?? true,
  });

  // Devolve o entitlement RESOLVIDO após a escrita — a UI reflete o efeito real,
  // não o que ela supõe que a escrita causou.
  return { ok: true, entitlements: await resolveOrgEntitlements(supabase, args.organizationId) };
}

export interface RevokeOverrideArgs {
  organizationId: string;
  overrideId: string;
  revokedBy: string;
}

/** Nunca deleta — `revoked_at` preserva a trilha. */
export async function revokeOverride(
  supabase: SupabaseClient,
  args: RevokeOverrideArgs,
): Promise<OverrideResult> {
  if (!args.revokedBy) {
    return { ok: false, status: 400, error: "Responsável pela revogação não identificado." };
  }

  const { data: updated, error } = await supabase
    .from("organization_entitlement_overrides")
    .update({ revoked_at: new Date().toISOString(), revoked_by: args.revokedBy })
    .eq("id", args.overrideId)
    // Escopo por org: o id sozinho permitiria revogar a cortesia de OUTRO
    // cliente com um id chutado.
    .eq("organization_id", args.organizationId)
    .is("revoked_at", null)
    .select("id, feature");

  if (error) {
    jsonLog("error", { evt: "override_revoke_failed", id: args.overrideId, err: error.message });
    return { ok: false, status: 500, error: "Falha ao revogar a concessão." };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, status: 404, error: "Concessão não encontrada ou já revogada." };
  }

  jsonLog("info", {
    evt: "override_revoked",
    org: args.organizationId,
    id: args.overrideId,
    feature: updated[0].feature,
  });
  return { ok: true, entitlements: await resolveOrgEntitlements(supabase, args.organizationId) };
}
```

- [ ] **Step 2: Confirmar que nenhum outro writer existe**

```bash
grep -rn "organization_entitlement_overrides" supabase/functions --include=*.ts
```
Esperado: só `_shared/entitlements.ts` (SELECT), `_shared/billing-notify.ts` (SELECT em `hasActiveSystemOverride`) e este módulo. Nenhum `insert`/`update` fora daqui.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/entitlement-overrides.ts
git commit -m "feat(billing): helper unico de concessao e revogacao de entitlement override"
```

---

## Task 13: EF `manage-whatsapp-implementations` — actions administrativas

Edge Function nova (e não mais uma action em `manage-billing`, que já tem 1347 linhas). Todas as actions desta task exigem `platform_admin`; a projeção do cliente é da Task 14.

**Files:**
- Create: `supabase/functions/manage-whatsapp-implementations/index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `whatsapp_implementations` (Task 2), `validateOriginPayment` / `canTransitionOperational` (Task 1), `openImplementationCheckout` (Task 10) e o ciclo de sessão de `_shared/checkout-sessions.ts` (Task 9, Step 2b — já em `_shared/` justamente para esta EF poder usá-lo sem duplicar a dedupe).
- Produces: as actions `list`, `get`, `create`, `create_asaas_charge`, `register_external_payment`, `set_operational_status`, `cancel`.

- [ ] **Step 1: Escrever a EF**

Estrutura (o corpo de cada action está nos passos seguintes):

```ts
// Edge Function: manage-whatsapp-implementations
// Painel da implantação do WhatsApp (Fase 5a).
//
// Auth: JWT obrigatório. Todas as actions exigem platform_admin, EXCETO
// get_service_status, que aceita owner/gerente da própria organização e devolve
// uma PROJEÇÃO SEGURA (nunca a linha crua — ela carrega notas internas, motivo
// da cortesia, referência de pagamento e responsáveis).
//
// Nada aqui suspende serviço: enforcement é a Fase 5b.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  validateOriginPayment,
  canTransitionOperational,
  type ImplementationOrigin,
  type ImplementationPaymentStatus,
  type ImplementationOperationalStatus,
} from "../_shared/whatsapp-implementation-core.ts";
import {
  loadImplementationPlan,
  openImplementationCheckout,
} from "../_shared/implementation-checkout.ts";
import {
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  CHECKOUT_EXPIRY_MINUTES,
} from "../_shared/checkout-sessions.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

/** Colunas completas — só para platform_admin. */
const ADMIN_COLUMNS =
  "id, organization_id, origin, payment_status, operational_status, amount_cents, " +
  "billing_plan_id, billing_invoice_id, provider_checkout_id, paid_at, payment_method, " +
  "external_payment_reference, reason, notes, owner_admin_id, scheduled_for, started_at, " +
  "completed_at, canceled_at, cancel_reason, created_by, updated_by, created_at, updated_at";

/** Única action liberada para não-admin. Ver Task 14. */
const CLIENT_FRIENDLY_ACTIONS = new Set(["get_service_status"]);

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function canReadOrg(userId: string, organizationId: string): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  const { data } = await supabase
    .from("unit_members")
    .select("role, units!inner(organization_id)")
    .eq("user_id", userId)
    .in("role", ["owner", "gerente"])
    .eq("units.organization_id", organizationId)
    .limit(1);
  return !!(data && data.length > 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "Método não permitido." }, 405);

  const reqId = genRequestId();

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (!action) return jsonResponse(req, { error: "action é obrigatória." }, 400);

    // Autorização ANTES do dispatch: nenhuma action roda sem passar por aqui.
    if (CLIENT_FRIENDLY_ACTIONS.has(action)) {
      const orgId = String(body.organization_id ?? "");
      if (!orgId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
      if (!(await canReadOrg(callerId, orgId))) {
        return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
      }
    } else if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Acesso restrito." }, 403);
    }

    // ... dispatch das actions (Steps 3-6 e Task 14)

    return jsonResponse(req, { error: "Ação desconhecida." }, 400);
  } catch (err) {
    jsonLog("error", {
      reqId,
      evt: "whatsapp_impl_unexpected_error",
      err: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(req, { error: "Erro inesperado." }, 500);
  }
});
```

- [ ] **Step 2: Actions de leitura (`list`, `get`)**

```ts
    if (action === "list") {
      const { status, organization_id, page = 0, page_size = 50 } = body as {
        status?: string; organization_id?: string; page?: number; page_size?: number;
      };
      const from = Number(page) * Number(page_size);
      let query = supabase
        .from("whatsapp_implementations")
        .select(`${ADMIN_COLUMNS}, organizations!inner(name, slug)`, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, from + Number(page_size) - 1);
      if (status) query = query.eq("operational_status", status);
      if (organization_id) query = query.eq("organization_id", organization_id);

      const { data, error, count } = await query;
      if (error) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_list_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar implantações." }, 500);
      }
      return jsonResponse(req, { success: true, implementations: data ?? [], total: count });
    }

    if (action === "get") {
      const id = String(body.id ?? "");
      if (!id) return jsonResponse(req, { error: "id é obrigatório." }, 400);
      const { data, error } = await supabase
        .from("whatsapp_implementations")
        .select(`${ADMIN_COLUMNS}, organizations!inner(name, slug)`)
        .eq("id", id)
        .maybeSingle();
      if (error) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_get_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao carregar a implantação." }, 500);
      }
      if (!data) return jsonResponse(req, { error: "Implantação não encontrada." }, 404);
      return jsonResponse(req, { success: true, implementation: data });
    }
```

- [ ] **Step 3: Registro manual (`create`, `register_external_payment`)**

```ts
    if (action === "create" || action === "register_external_payment") {
      const {
        organization_id, origin, amount_cents, payment_method,
        external_payment_reference, reason, notes, owner_admin_id, scheduled_for, paid_at,
      } = body as Record<string, never>;

      if (!organization_id) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      // `create` aceita as três origens manuais; `register_external_payment` é o
      // atalho da UI e força a origem — o admin não escolhe errado por descuido.
      const resolvedOrigin: ImplementationOrigin = action === "register_external_payment"
        ? "EXTERNAL_PAYMENT"
        : (origin as ImplementationOrigin);

      if (resolvedOrigin === "ASAAS") {
        // Cobrança real tem fluxo próprio: create_asaas_charge. Aceitar aqui
        // criaria uma linha ASAAS sem checkout, que nunca seria confirmada.
        return jsonResponse(req, {
          error: "Para cobrar pelo Asaas use a ação de gerar cobrança.",
        }, 400);
      }

      const paymentStatus: ImplementationPaymentStatus =
        resolvedOrigin === "EXTERNAL_PAYMENT" ? "CONFIRMED" : "WAIVED";

      if (!validateOriginPayment(resolvedOrigin, paymentStatus)) {
        return jsonResponse(req, { error: "Combinação de origem e pagamento inválida." }, 400);
      }
      if (resolvedOrigin !== "EXTERNAL_PAYMENT" && !String(reason ?? "").trim()) {
        return jsonResponse(req, { error: "Informe o motivo da cortesia ou do override." }, 400);
      }
      if (resolvedOrigin === "EXTERNAL_PAYMENT") {
        const cents = Number(amount_cents);
        if (!Number.isFinite(cents) || cents <= 0) {
          return jsonResponse(req, { error: "Informe o valor recebido." }, 400);
        }
        if (!String(payment_method ?? "").trim()) {
          return jsonResponse(req, { error: "Informe a forma de pagamento." }, 400);
        }
      }

      const { data: plan } = await supabase
        .from("billing_plans")
        .select("id")
        .eq("slug", "implementacao-whatsapp")
        .maybeSingle();

      const { data: created, error: insErr } = await supabase
        .from("whatsapp_implementations")
        .insert({
          organization_id,
          origin: resolvedOrigin,
          payment_status: paymentStatus,
          operational_status: "NOT_STARTED",
          // WAIVED não tem valor recebido — gravar 75000 inflaria o faturamento.
          amount_cents: resolvedOrigin === "EXTERNAL_PAYMENT" ? Number(amount_cents) : null,
          billing_plan_id: plan?.id ?? null,
          paid_at: resolvedOrigin === "EXTERNAL_PAYMENT"
            ? (paid_at ?? new Date().toISOString())
            : null,
          payment_method: resolvedOrigin === "EXTERNAL_PAYMENT" ? payment_method : null,
          external_payment_reference: external_payment_reference ?? null,
          reason: reason ?? null,
          notes: notes ?? null,
          owner_admin_id: owner_admin_id ?? null,
          scheduled_for: scheduled_for ?? null,
          created_by: callerId,
          updated_by: callerId,
        })
        .select("id")
        .maybeSingle();

      if (insErr) {
        // 23505 = já existe implantação aberta para a org (UNIQUE parcial).
        if (insErr.code === "23505") {
          return jsonResponse(req, {
            error: "Esta empresa já tem uma implantação registrada. Cancele a atual antes de criar outra.",
          }, 409);
        }
        jsonLog("error", { reqId, evt: "whatsapp_impl_create_error", err: insErr.message });
        return jsonResponse(req, { error: "Falha ao registrar a implantação." }, 500);
      }

      jsonLog("info", {
        reqId, evt: "whatsapp_impl_created_manual",
        orgId: organization_id, origin: resolvedOrigin, by: callerId,
      });
      return jsonResponse(req, { success: true, id: created?.id });
    }
```

- [ ] **Step 4: `create_asaas_charge`**

```ts
    if (action === "create_asaas_charge") {
      const organizationId = String(body.organization_id ?? "");
      if (!organizationId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      const flag = await checkFlagEnabled("asaas_enabled");
      if (!flag.enabled) {
        return jsonResponse(req, {
          error: "A cobrança pelo Asaas está temporariamente indisponível.",
        }, 503);
      }

      const plan = await loadImplementationPlan(supabase);
      if (!plan) return jsonResponse(req, { error: "Produto não encontrado." }, 404);

      const { data: customer } = await supabase
        .from("billing_customers")
        .select("asaas_customer_id, tax_id")
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!customer?.asaas_customer_id) {
        // O admin não cria cliente Asaas por aqui: o cadastro fiscal é fluxo do
        // onboarding, e criar um `cus_` a partir deste painel duplicaria o que
        // o checkout do cliente cria (o Asaas não deduplica).
        return jsonResponse(req, {
          error: "Esta empresa ainda não tem cadastro no Asaas. Peça ao cliente para concluir o cadastro fiscal.",
        }, 409);
      }

      const { data: unit } = await supabase
        .from("units").select("slug").eq("organization_id", organizationId)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      const successBase = unit?.slug
        ? `${APP_BASE_URL}/g/${unit.slug}/cobranca`
        : `${APP_BASE_URL}/platform/billing/${organizationId}`;

      const result = await openImplementationCheckout({
        supabase, reqId, organizationId, plan,
        asaasCustomerId: customer.asaas_customer_id,
        successUrl: `${successBase}?session=success`,
        cancelUrl: `${successBase}?session=cancel`,
        minutesToExpire: CHECKOUT_EXPIRY_MINUTES,
        createdBy: callerId,
        reserve: (a) => reserveCheckoutSession(supabase, a),
        finalize: (id, a) => finalizeCheckoutSession(supabase, id, a),
        fail: (id) => failCheckoutSession(supabase, id),
      });

      if (!result.ok) return jsonResponse(req, { error: result.error }, result.status);
      return jsonResponse(req, {
        success: true,
        url: result.url,
        implementation_id: result.implementationId,
      });
    }
```

- [ ] **Step 5: `set_operational_status` e `cancel`**

```ts
    if (action === "set_operational_status") {
      const id = String(body.id ?? "");
      const to = String(body.operational_status ?? "") as ImplementationOperationalStatus;
      if (!id || !to) {
        return jsonResponse(req, { error: "id e operational_status são obrigatórios." }, 400);
      }

      const { data: row, error: readErr } = await supabase
        .from("whatsapp_implementations")
        .select("id, payment_status, operational_status")
        .eq("id", id)
        .maybeSingle();
      if (readErr) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_read_error", err: readErr.message });
        return jsonResponse(req, { error: "Falha ao carregar a implantação." }, 500);
      }
      if (!row) return jsonResponse(req, { error: "Implantação não encontrada." }, 404);

      const verdict = canTransitionOperational(
        row.operational_status as ImplementationOperationalStatus,
        to,
        row.payment_status as ImplementationPaymentStatus,
      );
      if (!verdict.ok) {
        return jsonResponse(req, {
          error: verdict.reason === "payment_not_settled"
            ? "Só é possível concluir a implantação depois que o pagamento estiver confirmado (ou registrado como cortesia)."
            : "Esta mudança de etapa não é permitida a partir da etapa atual.",
        }, 409);
      }

      const patch: Record<string, unknown> = { operational_status: to, updated_by: callerId };
      if (to === "IN_PROGRESS" && !row.started_at) patch.started_at = new Date().toISOString();
      if (to === "COMPLETED") patch.completed_at = new Date().toISOString();
      if (body.scheduled_for !== undefined) patch.scheduled_for = body.scheduled_for;
      if (body.owner_admin_id !== undefined) patch.owner_admin_id = body.owner_admin_id;
      if (body.notes !== undefined) patch.notes = body.notes;

      // UPDATE condicional na etapa lida: se outro admin mudou no meio, este
      // não sobrescreve em silêncio.
      const { data: updated, error: updErr } = await supabase
        .from("whatsapp_implementations")
        .update(patch)
        .eq("id", id)
        .eq("operational_status", row.operational_status)
        .select("id");
      if (updErr) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_status_error", err: updErr.message });
        return jsonResponse(req, { error: "Falha ao atualizar a etapa." }, 500);
      }
      if (!updated || updated.length === 0) {
        return jsonResponse(req, {
          error: "A etapa mudou enquanto você editava. Recarregue e tente de novo.",
        }, 409);
      }

      jsonLog("info", {
        reqId, evt: "whatsapp_impl_status_changed",
        id, from: row.operational_status, to, by: callerId,
      });
      return jsonResponse(req, { success: true });
    }

    if (action === "cancel") {
      const id = String(body.id ?? "");
      const cancelReason = String(body.cancel_reason ?? "").trim();
      if (!id) return jsonResponse(req, { error: "id é obrigatório." }, 400);
      if (!cancelReason) return jsonResponse(req, { error: "Informe o motivo do cancelamento." }, 400);

      // NUNCA apaga: o histórico financeiro (pagamento externo confirmado, por
      // exemplo) mora nesta linha. CANCELED só a tira do índice de "uma aberta".
      const { data: updated, error } = await supabase
        .from("whatsapp_implementations")
        .update({
          operational_status: "CANCELED",
          canceled_at: new Date().toISOString(),
          cancel_reason: cancelReason,
          updated_by: callerId,
        })
        .eq("id", id)
        .neq("operational_status", "CANCELED")
        .select("id");
      if (error) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_cancel_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao cancelar a implantação." }, 500);
      }
      if (!updated || updated.length === 0) {
        return jsonResponse(req, { error: "Implantação não encontrada ou já cancelada." }, 404);
      }
      jsonLog("info", { reqId, evt: "whatsapp_impl_canceled", id, by: callerId });
      return jsonResponse(req, { success: true });
    }
```

- [ ] **Step 6: Registrar no `config.toml` (mesmo PR)**

```toml
# Painel da implantação do WhatsApp (super-admin, com uma action client-friendly)
[functions.manage-whatsapp-implementations]
verify_jwt = true
```

Sem esta entrada o CLI ≥2.95 usa o default e a EF fica sem a defesa em profundidade que todas as `manage-*` têm.

- [ ] **Step 7: Revisão manual**

1. Toda action passa pelo bloco de autorização **antes** do dispatch;
2. nenhuma action manual preenche `billing_invoice_id`/`provider_checkout_id`;
3. `cancel` nunca deleta;
4. nenhum `error.message` do Postgres chega ao cliente.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/manage-whatsapp-implementations/index.ts supabase/config.toml
git commit -m "feat(billing): EF manage-whatsapp-implementations com as acoes administrativas"
```

---

## Task 14: Override de WhatsApp e projeção segura do cliente

Fecha a EF: o admin concede e revoga cortesia de WhatsApp, e o cliente lê o próprio estado sem que a tabela crua saia do servidor.

**Files:**
- Modify: `supabase/functions/manage-whatsapp-implementations/index.ts`

**Interfaces:**
- Consumes: `grantOverride` / `revokeOverride` (Task 12), `buildClientImplementationView` / `summarizeMonthlyCosts` / `SETTLED_PAYMENT_STATUSES` (Task 1), `resolveOrgEntitlements`.
- Produces: as actions `grant_whatsapp_override`, `revoke_whatsapp_override`, `list_whatsapp_overrides`, `get_service_status`. O shape de `get_service_status` é o contrato do hook da Task 15.

- [ ] **Step 1: Actions de override**

Imports novos no topo do arquivo (o `import` do núcleo puro da Task 13 ganha três nomes a mais):

```ts
import { grantOverride, revokeOverride } from "../_shared/entitlement-overrides.ts";
import { resolveOrgEntitlements } from "../_shared/entitlements.ts";
import {
  validateOriginPayment,
  canTransitionOperational,
  buildClientImplementationView,
  summarizeMonthlyCosts,
  SETTLED_PAYMENT_STATUSES,
  type ImplementationOrigin,
  type ImplementationPaymentStatus,
  type ImplementationOperationalStatus,
} from "../_shared/whatsapp-implementation-core.ts";
```

```ts
    if (action === "grant_whatsapp_override") {
      const { organization_id, grant_type, reason, ends_at } = body as Record<string, never>;
      if (!organization_id) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      // `feature` é FIXA aqui. A UI genérica das três features é da Fase 9;
      // aceitar feature pelo corpo agora deixaria esta ação conceder IA — que
      // depende da carteira (Fase 7) e não tem efeito nenhum hoje.
      const result = await grantOverride(supabase, {
        organizationId: organization_id,
        feature: "whatsapp",
        grantType: grant_type,
        reason: String(reason ?? ""),
        grantedBy: callerId,
        endsAt: ends_at ?? null,
      });
      if (!result.ok) return jsonResponse(req, { error: result.error }, result.status);

      jsonLog("info", {
        reqId, evt: "whatsapp_override_granted",
        orgId: organization_id, grantType: grant_type, by: callerId,
      });
      return jsonResponse(req, { success: true, entitlements: result.entitlements });
    }

    if (action === "revoke_whatsapp_override") {
      const { organization_id, override_id } = body as Record<string, never>;
      if (!organization_id || !override_id) {
        return jsonResponse(req, { error: "organization_id e override_id são obrigatórios." }, 400);
      }
      const result = await revokeOverride(supabase, {
        organizationId: organization_id,
        overrideId: override_id,
        revokedBy: callerId,
      });
      if (!result.ok) return jsonResponse(req, { error: result.error }, result.status);
      return jsonResponse(req, { success: true, entitlements: result.entitlements });
    }

    if (action === "list_whatsapp_overrides") {
      const organizationId = String(body.organization_id ?? "");
      if (!organizationId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
      const { data, error } = await supabase
        .from("organization_entitlement_overrides")
        .select("id, feature, enabled, grant_type, starts_at, ends_at, reason, granted_by, created_at, revoked_at, revoked_by")
        .eq("organization_id", organizationId)
        .eq("feature", "whatsapp")
        .order("created_at", { ascending: false });
      if (error) {
        jsonLog("error", { reqId, evt: "whatsapp_override_list_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar as concessões." }, 500);
      }
      return jsonResponse(req, { success: true, overrides: data ?? [] });
    }
```

- [ ] **Step 2: `get_service_status` — a projeção segura**

```ts
    if (action === "get_service_status") {
      const organizationId = String(body.organization_id ?? "");
      // Permissão já checada no bloco de autorização (CLIENT_FRIENDLY_ACTIONS).

      const [implRes, entitlements, subsRes, plansRes, flags] = await Promise.all([
        supabase
          .from("whatsapp_implementations")
          // Colunas EXPLÍCITAS, nunca "*": a projeção descarta o resto, mas não
          // trazer o que não se usa é a defesa que sobrevive a um refactor.
          .select("payment_status, operational_status, amount_cents, paid_at, scheduled_for, started_at, completed_at")
          .eq("organization_id", organizationId)
          .neq("operational_status", "CANCELED")
          .maybeSingle(),
        resolveOrgEntitlements(supabase, organizationId),
        supabase
          .from("billing_subscriptions")
          .select("id, status, current_period_end, billing_plans!inner(category)")
          .eq("organization_id", organizationId)
          .neq("status", "canceled"),
        supabase
          .from("billing_plans")
          .select("slug, amount_cents, active")
          .in("slug", ["sistema-reservas", "implementacao-whatsapp", "instancia-whatsapp"]),
        Promise.all([
          checkFlagEnabled("whatsapp_implementation_flow"),
          checkFlagEnabled("whatsapp_subscription_checkout"),
        ]),
      ]);

      if (implRes.error) {
        jsonLog("error", { reqId, evt: "service_status_impl_error", err: implRes.error.message });
        return jsonResponse(req, { error: "Falha ao carregar o status do serviço." }, 500);
      }

      const subs = (subsRes.data ?? []) as Array<{
        status: string;
        current_period_end: string | null;
        billing_plans: { category: string } | { category: string }[];
      }>;
      const categoryOf = (s: typeof subs[number]) =>
        (Array.isArray(s.billing_plans) ? s.billing_plans[0] : s.billing_plans)?.category;
      const instanceSub = subs.find((s) => categoryOf(s) === "WHATSAPP_SUBSCRIPTION") ?? null;
      const systemSub = subs.find((s) => categoryOf(s) === "SYSTEM_SUBSCRIPTION") ?? null;

      const priceOf = (slug: string) =>
        ((plansRes.data ?? []).find((p) => p.slug === slug)?.amount_cents as number | undefined) ?? null;

      const implRow = implRes.data as
        | {
            payment_status: ImplementationPaymentStatus;
            operational_status: ImplementationOperationalStatus;
            amount_cents: number | null;
            paid_at: string | null;
            scheduled_for: string | null;
            started_at: string | null;
            completed_at: string | null;
          }
        | null;

      const whatsappSponsored =
        entitlements.whatsapp.allowed && entitlements.whatsapp.source === "override";
      const systemSponsored =
        entitlements.system.allowed && entitlements.system.source === "override";

      return jsonResponse(req, {
        success: true,
        // NOT_REQUESTED quando não há linha — ausência é um estado legítimo, não
        // um erro nem uma linha vazia no banco.
        implementation: buildClientImplementationView(implRow),
        subscription: {
          has_instance: !!instanceSub,
          status: instanceSub?.status ?? null,
          next_due: instanceSub?.current_period_end ?? null,
        },
        override: {
          active: whatsappSponsored,
          grant_type: whatsappSponsored ? entitlements.whatsapp.status : null,
          ends_at: whatsappSponsored ? entitlements.whatsapp.expiresAt : null,
        },
        costs: summarizeMonthlyCosts({
          systemMonthlyCents: priceOf("sistema-reservas"),
          instanceMonthlyCents: priceOf("instancia-whatsapp"),
          implementationOneTimeCents: priceOf("implementacao-whatsapp"),
          hasActiveInstanceSubscription: !!instanceSub,
          whatsappSponsored,
          implementationSettled: implRow
            ? SETTLED_PAYMENT_STATUSES.has(implRow.payment_status)
            : false,
          // Cortesia de sistema zera o mensal inteiro; sem assinatura de
          // sistema nem cortesia, o preço de vitrine ainda é o que a tela mostra.
          systemSponsored,
        }),
        flags: {
          implementation_flow: flags[0].enabled,
          subscription_checkout: flags[1].enabled,
        },
        // Usado pela UI para saber se o mensal atual reflete cobrança real.
        has_system_subscription: !!systemSub,
      });
    }
```

- [ ] **Step 3: Provar que nada interno vaza**

```bash
grep -n "notes\|external_payment_reference\|owner_admin_id\|created_by\|reason" supabase/functions/manage-whatsapp-implementations/index.ts
```
Esperado: **nenhuma** dessas palavras dentro do bloco `get_service_status`. Elas aparecem apenas em `ADMIN_COLUMNS`, nas actions de criação e em `list_whatsapp_overrides` — todas gateadas por `platform_admin`.

Confira também que `get_service_status` é a **única** entrada de `CLIENT_FRIENDLY_ACTIONS`.

- [ ] **Step 4: Gate de isolamento multi-tenant**

Rodar `saas-shield-br:tenant-isolation-auditor` e `saas-shield-br:identity-access-auditor` sobre `supabase/functions/manage-whatsapp-implementations/index.ts`. É a primeira EF da fase com uma action acessível a não-admin — o risco de vazamento cross-tenant mora aqui.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/manage-whatsapp-implementations/index.ts
git commit -m "feat(billing): override de WhatsApp e projecao segura do status do servico"
```

---

## Task 15: Tela do cliente — card "Automação WhatsApp" e resumo consolidado

Preços visíveis **antes** de qualquer clique, e os quatro números do resumo. O retorno da URL de sucesso não confirma nada — a tela faz polling do estado real, como já faz para a assinatura.

**Files:**
- Modify: `src/types/billing.ts`
- Create: `src/hooks/useWhatsappImplementation.ts`
- Create: `src/components/gestao/AutomacaoWhatsappCard.tsx`
- Modify: `src/pages/gestao/Cobranca.tsx`
- Modify: `src/hooks/useBilling.ts`

**Interfaces:**
- Consumes: action `get_service_status` (Task 14) e `purpose` no contrato do checkout (Task 9).
- Produces: `useWhatsappServiceStatus(organizationId)` e `ENTITLEMENT_GRANT_TYPE_LABEL`, usados também pela Task 16.

- [ ] **Step 1: Tipos e o mapa único de rótulos**

Em `src/types/billing.ts`, ao final:

```ts
// ─── Implantação do WhatsApp (Fase 5a) ───────────────────────────────────────

export type ImplementationOrigin =
  | "ASAAS" | "EXTERNAL_PAYMENT" | "COURTESY" | "ADMIN_OVERRIDE";

export type ImplementationPaymentStatus =
  | "PENDING" | "CONFIRMED" | "WAIVED" | "REFUNDED" | "CHARGEBACK" | "CANCELED";

export type ImplementationOperationalStatus =
  | "NOT_STARTED" | "SCHEDULED" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "COMPLETED" | "CANCELED";

export type ClientImplementationState =
  | "NOT_REQUESTED" | "AWAITING_PAYMENT" | "PAID_NOT_STARTED"
  | "IN_PROGRESS" | "WAITING_CUSTOMER" | "COMPLETED" | "CANCELED";

export interface WhatsappServiceStatus {
  implementation: {
    state: ClientImplementationState;
    payment_status: ImplementationPaymentStatus | null;
    operational_status: ImplementationOperationalStatus | null;
    amount_cents: number | null;
    paid_at: string | null;
    scheduled_for: string | null;
    started_at: string | null;
    completed_at: string | null;
    next_step: string;
  };
  subscription: { has_instance: boolean; status: string | null; next_due: string | null };
  override: { active: boolean; grant_type: string | null; ends_at: string | null };
  costs: {
    currentMonthlyCents: number;
    projectedMonthlyCents: number;
    oneTimeDueCents: number;
    aiVariable: true;
  };
  flags: { implementation_flow: boolean; subscription_checkout: boolean };
  has_system_subscription: boolean;
}

/**
 * Rótulos de UI dos grant types. Mapa ÚNICO, deliberadamente separado dos
 * valores do banco: o CHECK da migration 062 não é ampliado só para criar
 * sinônimos ("cortesia" é como se fala de PROMOTIONAL, não um valor novo).
 */
export const ENTITLEMENT_GRANT_TYPE_LABEL: Record<EntitlementGrantType, string> = {
  LIFETIME: "Acesso vitalício",
  TEMPORARY: "Acesso temporário",
  PROMOTIONAL: "Cortesia",
  MANUAL_OVERRIDE: "Override administrativo",
};

export const IMPLEMENTATION_ORIGIN_LABEL: Record<ImplementationOrigin, string> = {
  ASAAS: "Cobrança Asaas",
  EXTERNAL_PAYMENT: "Pagamento externo",
  COURTESY: "Cortesia",
  ADMIN_OVERRIDE: "Override administrativo",
};

export const IMPLEMENTATION_PAYMENT_LABEL: Record<ImplementationPaymentStatus, string> = {
  PENDING: "Aguardando pagamento",
  CONFIRMED: "Pago",
  WAIVED: "Sem cobrança",
  REFUNDED: "Estornado",
  CHARGEBACK: "Chargeback",
  CANCELED: "Cancelado",
};

export const IMPLEMENTATION_OPERATIONAL_LABEL: Record<ImplementationOperationalStatus, string> = {
  NOT_STARTED: "Não iniciada",
  SCHEDULED: "Agendada",
  IN_PROGRESS: "Em andamento",
  WAITING_CUSTOMER: "Aguardando cliente",
  COMPLETED: "Concluída",
  CANCELED: "Cancelada",
};
```

- [ ] **Step 2: Hook de dados**

Crie `src/hooks/useWhatsappImplementation.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { WhatsappServiceStatus } from "@/types/billing";

/**
 * `functions.invoke` mascara o corpo de erro non-2xx — a mensagem PT-BR do
 * backend só existe em `error.context`. Mesmo padrão de useSendManualMessage.
 */
async function invokeWhatsappImplementations(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke(
    "manage-whatsapp-implementations",
    { body },
  );
  if (error) {
    let message = error.message ?? "Erro inesperado.";
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        // corpo não-JSON — mantém error.message
      }
    }
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

export function useWhatsappServiceStatus(organizationId: string | undefined) {
  return useQuery<WhatsappServiceStatus>({
    queryKey: ["whatsapp-service-status", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const res = await invokeWhatsappImplementations({
        action: "get_service_status",
        organization_id: organizationId,
      });
      return res as WhatsappServiceStatus;
    },
  });
}

// ── Admin ────────────────────────────────────────────────────────────────────

export function useImplementations(filters: {
  status?: string;
  organization_id?: string;
  page?: number;
  page_size?: number;
}) {
  return useQuery({
    queryKey: ["whatsapp-implementations", filters],
    queryFn: async () => {
      const res = await invokeWhatsappImplementations({ action: "list", ...filters });
      return res as { implementations: Record<string, unknown>[]; total: number | null };
    },
  });
}

/** Invalida status do cliente E lista do admin — as duas leem a mesma linha. */
function useImplementationMutation<TVars>(build: (v: TVars) => Record<string, unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => invokeWhatsappImplementations(build(vars)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-implementations"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-service-status"] });
      qc.invalidateQueries({ queryKey: ["org-entitlements"] });
    },
  });
}

export const useCreateImplementation = () =>
  useImplementationMutation<Record<string, unknown>>((v) => ({ action: "create", ...v }));

export const useRegisterExternalPayment = () =>
  useImplementationMutation<Record<string, unknown>>((v) => ({
    action: "register_external_payment", ...v,
  }));

export const useSetOperationalStatus = () =>
  useImplementationMutation<{
    id: string; operational_status: string; scheduled_for?: string | null;
    owner_admin_id?: string | null; notes?: string | null;
  }>((v) => ({ action: "set_operational_status", ...v }));

export const useCancelImplementation = () =>
  useImplementationMutation<{ id: string; cancel_reason: string }>((v) => ({
    action: "cancel", ...v,
  }));

export const useGrantWhatsappOverride = () =>
  useImplementationMutation<{
    organization_id: string; grant_type: string; reason: string; ends_at?: string | null;
  }>((v) => ({ action: "grant_whatsapp_override", ...v }));

export const useRevokeWhatsappOverride = () =>
  useImplementationMutation<{ organization_id: string; override_id: string }>((v) => ({
    action: "revoke_whatsapp_override", ...v,
  }));

export function useWhatsappOverrides(organizationId: string | undefined) {
  return useQuery({
    queryKey: ["whatsapp-overrides", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const res = await invokeWhatsappImplementations({
        action: "list_whatsapp_overrides",
        organization_id: organizationId,
      });
      return (res as { overrides: Record<string, unknown>[] }).overrides;
    },
  });
}

/** Abre o checkout da implantação e redireciona. O `purpose` vai explícito — o
 *  servidor resolve produto e preço; o navegador não escolhe nenhum dos dois. */
export function useCreateImplementationCheckout() {
  return useMutation({
    mutationFn: async (params: { organization_id: string; plan_id: string }) => {
      const { data, error } = await supabase.functions.invoke("create-billing-checkout", {
        body: { ...params, purpose: "implementation" },
      });
      if (error) {
        let message = error.message ?? "Erro inesperado.";
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const parsed = await ctx.json();
            if (parsed?.error) message = String(parsed.error);
          } catch { /* corpo não-JSON */ }
        }
        throw new Error(message);
      }
      return data as { success: true; url: string; session_id: string };
    },
    onSuccess: (data) => {
      if (data?.url) window.location.href = data.url;
    },
  });
}
```

- [ ] **Step 3: Trocar `mode` por `purpose` em `useBilling.ts`**

Em `useCreateBillingCheckout`, o parâmetro e o corpo:

```ts
    mutationFn: async (params: {
      organization_id: string;
      plan_id?: string;
      /** `mode` saiu do contrato na Fase 5a. A EF ainda aceita o campo legado
       *  por uma release; o frontend já manda `purpose`. */
      purpose?: "subscription" | "payment_method_update";
    }) => {
```

E em `Cobranca.tsx`, `handleChangeCard` passa a mandar `purpose: "payment_method_update"` no lugar de `mode: "setup"`; `handleChoose` passa `purpose: "subscription"`.

- [ ] **Step 4: Criar o card**

`src/components/gestao/AutomacaoWhatsappCard.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { MessageSquare, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { formatDateBR } from "@/lib/utils";
import {
  formatCentsBRL,
  ENTITLEMENT_GRANT_TYPE_LABEL,
  type EntitlementGrantType,
  type WhatsappServiceStatus,
} from "@/types/billing";
import {
  useWhatsappServiceStatus,
  useCreateImplementationCheckout,
} from "@/hooks/useWhatsappImplementation";
import { useBillingPlans, useCreateBillingCheckout } from "@/hooks/useBilling";

interface Props {
  organizationId: string;
}

export function AutomacaoWhatsappCard({ organizationId }: Props) {
  const { data, isLoading, isError, refetch } = useWhatsappServiceStatus(organizationId);
  const { data: plans } = useBillingPlans();
  const implCheckout = useCreateImplementationCheckout();
  const subCheckout = useCreateBillingCheckout();

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  // Erro tratado como branch PRÓPRIO, nunca como "não tem nada": silenciar aqui
  // faria uma implantação em andamento sumir da tela do cliente.
  if (isError || !data) {
    return (
      <Card className="border-warning/20 bg-warning/10">
        <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <p className="text-sm text-warning">
              Não foi possível carregar o status da automação do WhatsApp.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data.flags.implementation_flow) return null;

  const implPlan = (plans ?? []).find((p) => p.slug === "implementacao-whatsapp");
  const instancePlan = (plans ?? []).find((p) => p.slug === "instancia-whatsapp");

  async function contratarImplantacao() {
    if (!implPlan) return;
    try {
      await implCheckout.mutateAsync({ organization_id: organizationId, plan_id: implPlan.id });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao iniciar o checkout.");
    }
  }

  async function contratarInstancia() {
    if (!instancePlan) return;
    try {
      await subCheckout.mutateAsync({
        organization_id: organizationId,
        plan_id: instancePlan.id,
        purpose: "subscription",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao iniciar o checkout.");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Automação no WhatsApp</CardTitle>
        </div>
        {data.override.active && (
          <Badge variant="secondary" className="bg-info/10 text-info">
            Liberado pela plataforma
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Preços SEMPRE visíveis, antes de qualquer clique. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Implantação</p>
            <p className="font-semibold">
              {implPlan ? formatCentsBRL(implPlan.amount_cents) : "—"}{" "}
              <span className="font-normal text-muted-foreground">uma vez</span>
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Instância</p>
            <p className="font-semibold">
              {instancePlan ? formatCentsBRL(instancePlan.amount_cents) : "—"}
              <span className="font-normal text-muted-foreground">/mês</span>
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Créditos de IA</p>
            <p className="font-semibold">
              R$ 50 a R$ 200{" "}
              <span className="font-normal text-muted-foreground">recarga</span>
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          A mensalidade da instância e os créditos de IA <strong>não</strong> estão
          inclusos no valor da implantação.
        </p>

        <Separator />

        <div className="space-y-2">
          <p className="text-sm">{data.implementation.next_step}</p>
          {data.implementation.state === "NOT_REQUESTED" && (
            <Button onClick={contratarImplantacao} disabled={implCheckout.isPending || !implPlan}>
              {implCheckout.isPending ? "Abrindo checkout..." : "Contratar implementação"}
            </Button>
          )}
          {data.implementation.state === "COMPLETED"
            && !data.subscription.has_instance
            && !data.override.active
            && data.flags.subscription_checkout && (
            <Button onClick={contratarInstancia} disabled={subCheckout.isPending || !instancePlan}>
              {subCheckout.isPending
                ? "Abrindo checkout..."
                : `Contratar instância — ${instancePlan ? formatCentsBRL(instancePlan.amount_cents) : ""}/mês`}
            </Button>
          )}
          {data.subscription.has_instance && data.subscription.next_due && (
            <p className="text-sm text-muted-foreground">
              Próximo vencimento da instância:{" "}
              <span className="font-medium">{formatDateBR(data.subscription.next_due.slice(0, 10))}</span>
            </p>
          )}
          {data.override.active && (
            <p className="text-sm text-muted-foreground">
              {ENTITLEMENT_GRANT_TYPE_LABEL[
                (data.override.grant_type ?? "MANUAL_OVERRIDE") as EntitlementGrantType
              ]}
              {" — "}
              {data.override.ends_at
                ? `válido até ${formatDateBR(data.override.ends_at.slice(0, 10))}`
                : "próxima cobrança: não aplicável"}
              .
            </p>
          )}
        </div>

        <Separator />
        <ResumoCustos costs={data.costs} sponsored={data.override.active} />
      </CardContent>
    </Card>
  );
}

/** Os quatro números do §9.1 da spec, sempre os quatro — inclusive quando algum é zero. */
function ResumoCustos({
  costs,
  sponsored,
}: {
  costs: WhatsappServiceStatus["costs"];
  sponsored: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Resumo dos custos</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Total mensal atual</dt>
          <dd className="font-medium">{formatCentsBRL(costs.currentMonthlyCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Total mensal com a automação</dt>
          <dd className="font-medium">{formatCentsBRL(costs.projectedMonthlyCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Pagamentos únicos</dt>
          <dd className="font-medium">{formatCentsBRL(costs.oneTimeDueCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Créditos de IA</dt>
          <dd className="font-medium">Variável</dd>
        </div>
      </dl>
      {sponsored && (
        <p className="text-xs text-muted-foreground">
          O WhatsApp desta conta é patrocinado pela plataforma — não há cobrança
          mensal por ele.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Montar o card em `Cobranca.tsx`**

Importe e renderize logo depois do bloco "Meu cartão" e antes de "Planos disponíveis":

```tsx
      <AutomacaoWhatsappCard organizationId={organizationId} />
```

Estenda também o polling pós-checkout: o `tick` atual só procura assinatura. Acrescente o refetch do status do serviço, para que o retorno de uma implantação paga por PIX atualize a tela quando o webhook chegar:

```tsx
      const [detailResult] = await Promise.all([
        refetchDetail(),
        refetchPms(),
        qc.invalidateQueries({ queryKey: ["whatsapp-service-status", organizationId] }),
      ]);
```

(Adicione `const qc = useQueryClient();` ao componente.) A mensagem de sucesso continua condicionada ao estado REAL ter mudado — nunca ao `session=success` da URL.

- [ ] **Step 6: Verificar**

```bash
npm run typecheck && npm run lint && npm run test
```
Esperado: zero erros nos três. Qualquer erro novo de tipo é regressão desta task.

- [ ] **Step 7: Commit**

```bash
git add src/types/billing.ts src/hooks/useWhatsappImplementation.ts src/hooks/useBilling.ts src/components/gestao/AutomacaoWhatsappCard.tsx src/pages/gestao/Cobranca.tsx
git commit -m "feat(billing): card de automacao WhatsApp e resumo consolidado na tela do cliente"
```

---

## Task 16: Painel administrativo da implantação

Lista com filtro, detalhe com as ações, e o bloco de WhatsApp no detalhe da organização — separando visualmente **origem comercial** de **fonte do acesso**.

**Files:**
- Create: `src/pages/platform/WhatsappImplementations.tsx`
- Modify: `src/App.tsx`
- Modify: `src/pages/platform/BillingDetail.tsx`

**Interfaces:**
- Consumes: os hooks da Task 15 e os rótulos de `src/types/billing.ts`.
- Produces: rota `/platform/billing/implementacoes`.

- [ ] **Step 1: Página de listagem e ações**

`src/pages/platform/WhatsappImplementations.tsx`. Esqueleto com os quatro branches obrigatórios — silenciar erro como "lista vazia" já mascarou incidente neste repositório:

```tsx
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { formatDateBR } from "@/lib/utils";
import {
  formatCentsBRL,
  IMPLEMENTATION_ORIGIN_LABEL,
  IMPLEMENTATION_PAYMENT_LABEL,
  IMPLEMENTATION_OPERATIONAL_LABEL,
  type ImplementationOperationalStatus,
} from "@/types/billing";
import { useImplementations } from "@/hooks/useWhatsappImplementation";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "NOT_STARTED", label: "Não iniciadas" },
  { value: "SCHEDULED", label: "Agendadas" },
  { value: "IN_PROGRESS", label: "Em andamento" },
  { value: "WAITING_CUSTOMER", label: "Aguardando cliente" },
  { value: "COMPLETED", label: "Concluídas" },
  { value: "CANCELED", label: "Canceladas" },
];

export default function WhatsappImplementations() {
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const { data, isLoading, isError, refetch } = useImplementations(
    status === "all" ? {} : { status },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Implantações de WhatsApp</h1>
          <p className="text-sm text-muted-foreground">
            Venda, cortesia e execução da configuração assistida.
          </p>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <Card className="border-warning/20 bg-warning/10">
          <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-warning">Falha ao carregar as implantações.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : (data?.implementations ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Nenhuma implantação neste filtro.
          </CardContent>
        </Card>
      ) : (
        <Card>
          {/* Container próprio de rolagem: o body da página nunca rola na horizontal. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="p-3">Empresa</th>
                  <th className="p-3">Origem</th>
                  <th className="p-3">Financeiro</th>
                  <th className="p-3">Operacional</th>
                  <th className="p-3">Valor</th>
                  <th className="p-3">Criada em</th>
                </tr>
              </thead>
              <tbody>
                {(data?.implementations ?? []).map((row) => {
                  const r = row as Record<string, never>;
                  return (
                    <tr
                      key={r.id}
                      className="border-t cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelected(row)}
                    >
                      <td className="p-3 font-medium">{r.organizations?.name ?? "—"}</td>
                      <td className="p-3">{IMPLEMENTATION_ORIGIN_LABEL[r.origin]}</td>
                      <td className="p-3">
                        <Badge variant="secondary">
                          {IMPLEMENTATION_PAYMENT_LABEL[r.payment_status]}
                        </Badge>
                      </td>
                      <td className="p-3">
                        {IMPLEMENTATION_OPERATIONAL_LABEL[
                          r.operational_status as ImplementationOperationalStatus
                        ]}
                      </td>
                      <td className="p-3">
                        {r.amount_cents == null ? "—" : formatCentsBRL(r.amount_cents)}
                      </td>
                      <td className="p-3">{formatDateBR(String(r.created_at).slice(0, 10))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ResponsiveDialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        {/* Detalhe e ações — Step 1b */}
      </ResponsiveDialog>
    </div>
  );
}
```

Rótulos **sempre** pelos mapas de `src/types/billing.ts` — nenhuma string de status escrita à mão no JSX.

- [ ] **Step 1b: Ações no diálogo de detalhe**

Dentro do `ResponsiveDialog`, quatro blocos:

1. **Avanço de etapa** (`useSetOperationalStatus`) — um `Select` com os destinos válidos a partir da etapa atual. O botão "Concluir" fica **desabilitado** quando `payment_status` não é `CONFIRMED` nem `WAIVED`, com o texto de apoio "conclua depois que o pagamento for confirmado"; o servidor recusa de qualquer forma (Task 13), isto é só UX.
2. **Pagamento externo** (`useRegisterExternalPayment`) — forma, valor, data, referência, observação, responsável. Pares de campos em `grid grid-cols-1 sm:grid-cols-2` (o `sm:` casa com a largura em que o Dialog deixa de ser fullscreen).
3. **Cortesia / override** (`useCreateImplementation` com `origin` `COURTESY` ou `ADMIN_OVERRIDE`) — motivo obrigatório, botão desabilitado enquanto vazio.
4. **Cancelar** (`useCancelImplementation`) — motivo obrigatório, dentro de um `AlertDialog` de confirmação.

Todas as mutations já invalidam `whatsapp-implementations`, `whatsapp-service-status` e `org-entitlements` (Task 15) — nenhuma tela fica com dado velho.

- [ ] **Step 2: Rota**

Em `src/App.tsx`, junto das outras rotas de `/platform/billing`:

```tsx
const PWhatsappImplementations = lazy(() => import("./pages/platform/WhatsappImplementations"));
```
```tsx
<Route
  path="/platform/billing/implementacoes"
  element={<PlatformGuard><PWhatsappImplementations /></PlatformGuard>}
/>
```

**Ordem importa:** esta rota precisa vir **antes** de `/platform/billing/:organizationId`, senão `implementacoes` é capturado como um `organizationId`.

- [ ] **Step 3: Bloco no detalhe da organização**

Em `src/pages/platform/BillingDetail.tsx`, dois cards novos, visualmente separados:

- **Implantação** — origem, valor, status financeiro, status operacional, responsável, datas. Botão que leva ao detalhe na página de implantações.
- **WhatsApp** — fonte do acesso (assinatura paga × override), tipo (`ENTITLEMENT_GRANT_TYPE_LABEL`), validade, e o custo patrocinado quando é override.

A concessão de cortesia (`useGrantWhatsappOverride`) exige `AlertDialog` de confirmação com o aviso literal:

> Esta empresa poderá gerar um custo mensal de Z-API para a plataforma, mesmo sem uma assinatura paga pelo cliente.

**Nenhum campo de gratuidade ou limite de IA aparece nesta fase** — controle sem efeito no banco não é entregue (a carteira é a Fase 7).

- [ ] **Step 4: Verificar**

```bash
npm run typecheck && npm run lint && npm run build
```

Verificação manual no navegador (`npm run dev`, logado como platform_admin):
1. `/platform/billing/implementacoes` carrega e a rota **não** cai no detalhe de organização;
2. tabela rola horizontalmente em viewport estreito sem estourar o body;
3. o diálogo de cortesia mostra o aviso de custo Z-API antes de confirmar.

- [ ] **Step 5: Commit**

```bash
git add src/pages/platform/WhatsappImplementations.tsx src/App.tsx src/pages/platform/BillingDetail.tsx
git commit -m "feat(billing): painel administrativo da implantacao e bloco de WhatsApp na organizacao"
```

---

## Task 17: Fechamento — ativação dos planos, documentação, gates e sandbox

Última task. Liga os produtos no catálogo, atualiza os invariantes do `CLAUDE.md`, roda os gates de segurança e executa o roteiro de sandbox.

**Files:**
- Create: `supabase/migrations/20260726100500_076_activate_whatsapp_plans.sql`
- Create: `docs/billing-asaas/FASE-5A-RESUMO.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Migration 076**

```sql
-- Liga os produtos de WhatsApp no catálogo. ÚLTIMA migration da Fase 5a.
--
-- Os dois nasceram active=false na 065 de propósito: plano ativo sem fluxo que o
-- processe vira botão quebrado. Agora os dois fluxos existem — o checkout
-- DETACHED da implantação e o RECURRENT da instância — e a visibilidade de cada
-- um continua governada por flag (whatsapp_implementation_flow e
-- whatsapp_subscription_checkout), não por esta coluna.
--
-- PricingTable filtra SYSTEM_SUBSCRIPTION (isSelectableSystemPlan), então
-- ativá-los NÃO os transforma em card contratável na tabela de planos: eles
-- aparecem só no bloco dedicado da tela de cobrança.

begin;

update billing_plans
   set active = true,
       updated_at = now()
 where slug in ('implementacao-whatsapp', 'instancia-whatsapp')
   and active = false;

commit;

-- Validação (esperado: 2 linhas, active=t, e instancia-whatsapp apontando para
-- implementacao-whatsapp em requires_plan_id):
--   select slug, active, category, billing_type,
--          (select slug from billing_plans r where r.id = p.requires_plan_id) as requires
--     from billing_plans p
--    where slug in ('implementacao-whatsapp', 'instancia-whatsapp');
--
-- Rollback:
--   update billing_plans set active = false
--    where slug in ('implementacao-whatsapp', 'instancia-whatsapp');
```

- [ ] **Step 2: Atualizar o `CLAUDE.md`**

Três edições, todas no formato obrigatório do arquivo (regra em uma frase + porquê em uma frase + ponteiro):

Na seção **Billing — mensalidades**, acrescente:

```markdown
- **Só assinatura/fatura de categoria `SYSTEM_SUBSCRIPTION` pode escrever `organizations.billing_status`.** A coluna representa o acesso ao sistema; sem a guarda, uma fatura de R$ 149 da instância bloquearia a org inteira e pagá-la desbloquearia um sistema inadimplente. Pergunta centralizada em [_shared/billing-category.ts](supabase/functions/_shared/billing-category.ts) — todo writer novo de `billing_status` passa por ela.
- **Assinatura é resolvida pela CATEGORIA do plano, via RPC `resolve_or_activate_subscription`, nunca por "a assinatura da org".** Uma organização tem sistema e instância ao mesmo tempo, e `maybeSingle()` sobre as duas devolve `PGRST116` e derruba o pagamento. A RPC serializa por `pg_advisory_xact_lock(org, categoria)` e trata ambiguidade como falha alta. [asaas-billing-events-apply.ts](supabase/functions/_shared/asaas-billing-events-apply.ts).
- **`organization_entitlement_overrides` tem um writer único: [_shared/entitlement-overrides.ts](supabase/functions/_shared/entitlement-overrides.ts).** Insert direto espalha as regras de coerência de data e de conflito, e a primeira que divergir cria cortesia invisível ao resolver. Webhook financeiro nunca escreve nessa tabela.
- **`whatsapp_implementations` separa `payment_status` de `operational_status`, e ausência de linha significa `NOT_REQUESTED`.** Um campo só faz "pago mas não entregue" e "entregue de graça" caírem no mesmo balde; e uma linha vazia sem origem, valor nem responsável tornaria inútil o índice de "uma implantação aberta por org". [migration 071](supabase/migrations/20260726100000_071_whatsapp_implementations.sql).
- **Checkout novo reserva a sessão em `billing_checkout_sessions` ANTES de chamar o provedor.** O Asaas não tem `Idempotency-Key`: sem a reserva `creating` + o UNIQUE parcial `(organization_id, plan_id, purpose)`, dois cliques abrem duas cobranças reais. [_shared/checkout-sessions.ts](supabase/functions/_shared/checkout-sessions.ts).
- **`create-billing-checkout` roteia por `purpose` (`subscription` | `implementation` | `payment_method_update`); `mode` é compat legado de uma release.** O servidor resolve categoria, modalidade, preço e intervalo a partir de `billing_plans` — o navegador não envia nenhum deles.
```

No **checklist de redeploy por mudança em `_shared/`**, acrescente:

```markdown
- **`whatsapp-implementation-core.ts`** (núcleo puro, testado em [src/lib/whatsapp-implementation-core.test.ts](src/lib/whatsapp-implementation-core.test.ts)) → `create-billing-checkout`, `manage-whatsapp-implementations`
- **`billing-category.ts`** → `process-billing-overdue`, `process-billing-reminders`, `process-billing-unblock`, `process-trial-expiry`, `process-billing-reconcile`, `manage-billing`
- **`checkout-sessions.ts`** → `create-billing-checkout`, `manage-whatsapp-implementations`
- **`implementation-checkout.ts`** → `create-billing-checkout`, `manage-whatsapp-implementations`
- **`entitlement-overrides.ts`** → `manage-whatsapp-implementations`
- **`billing-notify.ts`** ganhou `resolvePlatformAdminRecipients` → soma `asaas-webhook` e `process-asaas-reconcile` à lista já existente
```

Na tabela de **workers automáticos**, nada muda. Na seção de **Roteamento**, acrescente:

```markdown
- `/platform/billing/implementacoes` lista as implantações de WhatsApp e precisa vir ANTES de `/platform/billing/:organizationId` no `App.tsx` — senão o segmento vira um `organizationId`.
```

- [ ] **Step 3: Gates de segurança (bloqueantes antes do merge)**

Rodar os agentes `saas-shield-br` sobre a branch inteira, na ordem:

| Agente | Alvo |
|---|---|
| `rls-auditor` | migrations 071-076 |
| `tenant-isolation-auditor` | repositório (foco em `manage-whatsapp-implementations` e `get_service_status`) |
| `identity-access-auditor` | `manage-whatsapp-implementations`, `create-billing-checkout`, `entitlement-overrides.ts` |
| `migration-validator` | as seis migrations |
| `secret-hunter` | diff completo da branch |
| `integration-reliability-auditor` | `asaas-billing-events-apply.ts`, `checkout-sessions.ts`, `implementation-checkout.ts` |

Achado de severidade alta é bloqueante. Registre no resumo da fase o que cada um devolveu.

- [ ] **Step 4: Verificação local completa**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```
Esperado: zero erros nos quatro. Baseline de testes: 229 (Fase 4b) + os casos da Task 1.

- [ ] **Step 5: Aplicar as migrations**

```bash
supabase db push
```

Depois, rodar as queries de validação de **cada** migration (estão comentadas no rodapé de cada arquivo) e confirmar ausência de drift:

```sql
select version, name from supabase_migrations.schema_migrations order by version desc limit 8;
```
Esperado: `version` igual ao prefixo do filename em todas as seis novas. Divergência = alguém aplicou SQL pelo Studio; resolver com `supabase migration repair --status reverted <ver>` antes de seguir.

- [ ] **Step 6: Deploy das Edge Functions**

Ordem importa: `_shared` não é compartilhado em runtime, então **toda** EF que importa um helper alterado precisa ir junto.

```bash
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
```

- [ ] **Step 7: Roteiro de sandbox (roteiro B, como na Fase 4b)**

Use a organização de teste (não o Ren Sushi, que é vitalício). Ligue `whatsapp_implementation_flow` e `asaas_enabled`; **mantenha `whatsapp_subscription_checkout` OFF em produção** — os cenários B9-B11 rodam com ela ligada apenas durante o teste, e ela volta a OFF no fim.

| # | Cenário | Esperado |
|---|---|---|
| B1 | Contratar implantação pelo cliente | Checkout `DETACHED` criado, cartão **e** PIX oferecidos, linha `whatsapp_implementations` `ASAAS`/`PENDING`, sessão `pending` |
| B2 | Voltar pela `successUrl` sem pagar | Tela **não** afirma pagamento; estado continua `AWAITING_PAYMENT` |
| B3 | Clicar "Contratar" duas vezes | Segundo clique devolve a mesma URL (ou 409 "em criação"), **uma** cobrança no Asaas |
| B4 | Pagar (cartão de teste) | `PAYMENT_CONFIRMED` → implantação `CONFIRMED` + `paid_at` + `billing_invoice_id`; sessão `used`; `billing_notifications` com `implementation_paid` |
| B5 | Reenviar o mesmo evento pelo painel Asaas | Nenhuma linha muda; log `implementation_confirm_noop`; **nenhuma** notificação nova |
| B6 | Concluir com pagamento `PENDING` (outra org) | 409 "só é possível concluir depois que o pagamento estiver confirmado" |
| B7 | Criar segunda implantação para a mesma org | 409 "já tem uma implantação registrada" |
| B8 | Registrar pagamento externo `WAIVED` via API | Recusado (23514 traduzido) — a matriz não admite |
| B9 | Contratar instância antes de `COMPLETED` | 409 `implementation_incomplete` |
| B10 | Concluir a implantação e contratar a instância | Duas assinaturas vivas na org, **sem** `PGRST116`; `organizations.billing_status` **inalterado** |
| B11 | Fatura da instância vencida D+6 | `process-billing-overdue` **não** muda `billing_status`; log `billing_overdue_skip_non_system` |
| B12 | Cancelamento imediato da instância | Assinatura `canceled`; organização **continua** `active` |
| B13 | Org em trial com assinatura de instância | `process-trial-expiry` bloqueia normalmente (a instância não prorroga) |
| B14 | Conceder override de WhatsApp | Entitlement `whatsapp` vira `override`; botão de contratar instância some; resumo mostra "não aplicável" |
| B15 | Conceder um segundo override de WhatsApp | 409 "revogue a atual antes de criar outra" |
| B16 | Revogar o override | Botão de contratar instância volta; auditoria com `revoked_at`/`revoked_by` |
| B17 | Chamar `get_service_status` como owner não-admin | 200 com a projeção; **nenhum** campo interno no corpo |
| B18 | Chamar `set_operational_status` como owner não-admin | 403 |
| B19 | Trocar `category` de um plano com assinatura | 409 traduzido, não 500 |
| B20 | Trocar cartão pelo frontend novo (`purpose`) e por um cliente antigo (`mode`) | Os dois funcionam; o segundo loga `checkout_legacy_mode_param` |

Limpeza ao final: cancelar as assinaturas sandbox no painel Asaas, apagar as linhas de teste, **devolver `whatsapp_subscription_checkout` e `billing_notifications_dispatch` para OFF** e conferir `asaas_enabled` no estado em que estava.

- [ ] **Step 8: Escrever `docs/billing-asaas/FASE-5A-RESUMO.md`**

Mesmo formato do [FASE-4B-RESUMO.md](../../billing-asaas/FASE-4B-RESUMO.md): bloco "ESTADO ATUAL" no topo com a tabela de situação, escopo entregue, arquitetura, arquivos, commits, decisões, riscos residuais, resultado do sandbox e rollback.

Riscos residuais que **precisam** estar registrados:

1. `DETACHED` exercitado pela primeira vez — resultado real do B1 anotado;
2. renovação do mês 2+ sem `checkoutSession` (herdado da 4a) agora vale para duas assinaturas — correlação por `provider_subscription_id` continua pendente e é **bloqueante antes do primeiro ciclo real**;
3. sessões `creating` órfãs só são varridas na próxima tentativa do mesmo produto — varredura periódica é follow-up da 5b;
4. aviso `implementation_paid` vai para **um** admin (o mais antigo), por causa do UNIQUE de dedupe e do `to` único do Resend;
5. `regularized` com `invoice_id=null` na renovação — follow-up #2 da 4b, ainda aberto;
6. queries sem `.range()` em overdue/reminders — débito herdado, irrelevante na base atual.

- [ ] **Step 9: Commit, merge e tag**

```bash
git add supabase/migrations/20260726100500_076_activate_whatsapp_plans.sql docs/billing-asaas/FASE-5A-RESUMO.md CLAUDE.md
git commit -m "docs(billing): ativa planos de WhatsApp, invariantes no CLAUDE.md e resumo da Fase 5a"
```

Merge e tag **só depois** do sandbox validado. A tag e a branch compartilham o nome — use `refs/heads/...` explicitamente:

```bash
git checkout main
git merge --no-ff refs/heads/billing-asaas/fase-5a -m "merge: Fase 5a (comercial) - implantacao WhatsApp R\$750 + instancia R\$149"
git tag -a billing-asaas/fase-5a -m "Fase 5a validada em sandbox"
git push origin refs/heads/main
git push origin refs/tags/billing-asaas/fase-5a
```

---

## Nota de encerramento

**Nada nesta fase suspende serviço.** Uma instância inadimplente continua funcionando até a Fase 5b entregar o gate central de envio, o gate do agente, o estacionamento de jobs e a restauração pós-pagamento. Por isso `whatsapp_subscription_checkout` permanece **OFF em produção** ao fim da 5a: vender a mensalidade sem poder suspender é assumir custo de Z-API sem contrapartida.
