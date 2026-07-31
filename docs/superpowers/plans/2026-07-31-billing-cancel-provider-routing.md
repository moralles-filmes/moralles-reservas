# Cancelamento de assinatura roteado por provedor — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancelar uma assinatura Asaas passa a cancelar no Asaas — hoje só o banco é atualizado e o provedor segue cobrando.

**Architecture:** Um núcleo puro decide para onde roteia o cancelamento e que colunas escrever. O adapter de provedor passa a devolver o efeito real (`immediate` | `at_period_end`) e o banco grava a partir dessa resposta, nunca do que o caller pediu. Os dois call sites de `manage-billing` param de chamar a Stripe direto.

**Tech Stack:** Deno (Edge Functions Supabase) · TypeScript · vitest · React + TanStack Query no frontend.

**Spec:** [2026-07-31-billing-cancel-provider-routing-design.md](../specs/2026-07-31-billing-cancel-provider-routing-design.md)
**Bug de origem:** [08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md](../../billing-asaas/08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md)

## Global Constraints

- **`npm run typecheck` NÃO cobre `supabase/functions/`.** O root tem `files:[]` + references; `tsc -b` alcança só `src/`. Deno não está instalado nesta máquina. **A única verificação automática do núcleo puro é o teste vitest, que o importa por caminho relativo** — por isso toda a lógica decidível mora no núcleo, e o que sobra nas Edge Functions é fiação.
- **Nunca `tsc --noEmit` sem `-b`** — vira no-op silencioso (exit 0 sem checar).
- **`git add caminho/arquivo` sempre.** Nunca `git add .` nem `git add -A`.
- **Ordem obrigatória em todo cancelamento: provedor primeiro, banco depois.** Nunca o inverso, e nunca banco sem provedor.
- **Mensagem de erro ao cliente é curta e em PT-BR.** Detalhe do Postgres ou do provedor vai só para `jsonLog`, nunca para a resposta.
- **`tsconfig.app.json` tem `strict: false`** — `if (!x.ok) { x.campo }` não estreita união discriminada. Use `x.kind === "..."` ou early-return.
- **Copy que promete fim de período é proibida para assinatura Asaas.** Não existe período contratual, `current_period_end` é `null` nessas linhas e nada o preenche.
- **Não tocar:** as outras cinco operações não roteadas de `manage-billing`, `entitlements-core.ts`, `current_period_end`, `process-billing-reconcile`, qualquer caminho Stripe além de preservar comportamento.

---

## File Structure

| arquivo | responsabilidade |
|---|---|
| `supabase/functions/_shared/billing-cancel-core.ts` (**criar**) | Núcleo puro: para onde roteia, que colunas escrever. Sem I/O. |
| `src/lib/billing-cancel-core.test.ts` (**criar**) | Testes vitest do núcleo. Única verificação automática. |
| `supabase/functions/_shared/billing-provider.ts` (**modificar**) | Assinatura de `cancelSubscription` devolve `effective`; adapter Asaas sempre `INACTIVE`. |
| `supabase/functions/_shared/asaas.ts` (**modificar**) | Remove `deleteAsaasSubscription`, que fica sem caller. |
| `supabase/functions/manage-billing/index.ts` (**modificar**) | Os dois call sites roteiam pelo núcleo e pelo adapter. |
| `src/pages/platform/BillingDetail.tsx` (**modificar**) | Diálogo admin esconde a caixa de fim de período quando é Asaas. |
| `src/pages/gestao/Cobranca.tsx` (**modificar**) | Diálogo e toast do lojista param de prometer fim de período em Asaas. |
| `CLAUDE.md` (**modificar**) | Invariante novo + checklist de redeploy. |

---

## Task 1: Núcleo puro de decisão

**Files:**
- Create: `supabase/functions/_shared/billing-cancel-core.ts`
- Test: `src/lib/billing-cancel-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `CancelEffective`, `CancelTarget`, `CancelSubscriptionRow`, `LocalCancelPatch`, `decideCancelTarget(sub: CancelSubscriptionRow): CancelTarget`, `localCancelPatch(effective: CancelEffective, nowIso: string): LocalCancelPatch`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `src/lib/billing-cancel-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  decideCancelTarget,
  localCancelPatch,
} from "../../supabase/functions/_shared/billing-cancel-core";

describe("decideCancelTarget", () => {
  it("roteia asaas com provider_subscription_id", () => {
    expect(decideCancelTarget({
      provider: "asaas",
      provider_subscription_id: "sub_abc",
      stripe_subscription_id: null,
    })).toEqual({ kind: "provider", provider: "asaas", providerSubscriptionId: "sub_abc" });
  });

  it("roteia stripe com provider_subscription_id", () => {
    expect(decideCancelTarget({
      provider: "stripe",
      provider_subscription_id: "sub_stripe",
      stripe_subscription_id: "sub_stripe",
    })).toEqual({ kind: "provider", provider: "stripe", providerSubscriptionId: "sub_stripe" });
  });

  it("usa stripe_subscription_id como fallback em linha anterior ao backfill da 063", () => {
    expect(decideCancelTarget({
      provider: "stripe",
      provider_subscription_id: null,
      stripe_subscription_id: "sub_legado",
    })).toEqual({ kind: "provider", provider: "stripe", providerSubscriptionId: "sub_legado" });
  });

  it("NAO usa stripe_subscription_id como id de assinatura asaas", () => {
    expect(decideCancelTarget({
      provider: "asaas",
      provider_subscription_id: null,
      stripe_subscription_id: "sub_stripe",
    })).toEqual({ kind: "unroutable", provider: "asaas", reason: "missing_provider_id" });
  });

  it("manual cancela so' localmente", () => {
    expect(decideCancelTarget({
      provider: "manual",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "local_only", provider: "manual" });
  });

  it("lifetime cancela so' localmente", () => {
    expect(decideCancelTarget({
      provider: "lifetime",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "local_only", provider: "lifetime" });
  });

  it("asaas sem id nenhum e' irroteavel", () => {
    expect(decideCancelTarget({
      provider: "asaas",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "asaas", reason: "missing_provider_id" });
  });

  it("stripe sem id nenhum e' irroteavel", () => {
    expect(decideCancelTarget({
      provider: "stripe",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "stripe", reason: "missing_provider_id" });
  });

  it("provider desconhecido falha fechado", () => {
    expect(decideCancelTarget({
      provider: "paypal",
      provider_subscription_id: "sub_x",
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "paypal", reason: "unknown_provider" });
  });

  it("provider null falha fechado em vez de assumir stripe", () => {
    expect(decideCancelTarget({
      provider: null,
      provider_subscription_id: "sub_x",
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "", reason: "unknown_provider" });
  });
});

describe("localCancelPatch", () => {
  const now = "2026-07-31T18:00:00.000Z";

  it("immediate cancela de fato", () => {
    expect(localCancelPatch("immediate", now)).toEqual({
      status: "canceled",
      canceled_at: now,
      cancel_at_period_end: false,
      updated_at: now,
    });
  });

  it("at_period_end NAO toca em status", () => {
    const patch = localCancelPatch("at_period_end", now);
    expect(patch).toEqual({ cancel_at_period_end: true, updated_at: now });
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("canceled_at");
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- billing-cancel-core`
Expected: FAIL — o módulo `billing-cancel-core` não existe.

- [ ] **Step 3: Implementar o núcleo**

Crie `supabase/functions/_shared/billing-cancel-core.ts`:

```ts
/**
 * Núcleo puro do cancelamento de assinatura: decide PARA ONDE roteia e QUE
 * colunas escrever. Sem I/O, sem Supabase, sem provedor.
 *
 * Existe porque `manage-billing` cancelava chamando a Stripe direto, guardado
 * por `if (sub.stripe_subscription_id)`. Numa assinatura Asaas essa coluna é
 * null: o provedor nunca era chamado, o banco gravava `canceled`, e o Asaas
 * seguia cobrando todo mês com a tela dizendo que o cliente havia cancelado.
 * Ver docs/billing-asaas/08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md.
 */

/** O que de fato aconteceu no provedor — não o que o caller pediu. */
export type CancelEffective = "immediate" | "at_period_end";

export type CancelTarget =
  | { kind: "provider"; provider: "stripe" | "asaas"; providerSubscriptionId: string }
  | { kind: "local_only"; provider: "manual" | "lifetime" }
  | { kind: "unroutable"; provider: string; reason: "missing_provider_id" | "unknown_provider" };

export interface CancelSubscriptionRow {
  provider: string | null;
  provider_subscription_id: string | null;
  stripe_subscription_id: string | null;
}

/** Provedores com contraparte externa a cancelar. */
const EXTERNAL_PROVIDERS: ReadonlySet<string> = new Set(["stripe", "asaas"]);

/** Provedores sem contraparte externa — cancelar só no banco é legítimo. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["manual", "lifetime"]);

export function decideCancelTarget(sub: CancelSubscriptionRow): CancelTarget {
  // `provider` é NOT NULL com default 'stripe' no banco (migration 063), mas
  // chega null se o SELECT omitir a coluna. Tratar como desconhecido em vez de
  // assumir 'stripe' — assumir é exatamente como o bug original agia.
  const provider = sub.provider ?? "";

  if (LOCAL_PROVIDERS.has(provider)) {
    return { kind: "local_only", provider: provider as "manual" | "lifetime" };
  }

  if (!EXTERNAL_PROVIDERS.has(provider)) {
    return { kind: "unroutable", provider, reason: "unknown_provider" };
  }

  // Fallback SÓ para stripe: a migration 063 backfillou
  // provider_subscription_id a partir de stripe_subscription_id, e linhas
  // anteriores podem ter só a coluna velha. Usar um `sub_` da Stripe como id de
  // assinatura Asaas cancelaria o objeto errado — ou nenhum.
  const id = sub.provider_subscription_id ?? (provider === "stripe" ? sub.stripe_subscription_id : null);
  if (!id) {
    return { kind: "unroutable", provider, reason: "missing_provider_id" };
  }

  return { kind: "provider", provider: provider as "stripe" | "asaas", providerSubscriptionId: id };
}

export interface LocalCancelPatch {
  status?: "canceled";
  canceled_at?: string;
  cancel_at_period_end: boolean;
  updated_at: string;
}

/**
 * Colunas a gravar, derivadas do efeito REAL devolvido pelo provedor.
 *
 * `at_period_end` não escreve `status` de propósito: quem encerra o acesso
 * nesse caminho é o webhook `customer.subscription.deleted` da Stripe. Nenhum
 * provedor sem esse evento deve devolver `at_period_end`.
 */
export function localCancelPatch(effective: CancelEffective, nowIso: string): LocalCancelPatch {
  if (effective === "at_period_end") {
    return { cancel_at_period_end: true, updated_at: nowIso };
  }
  return {
    status: "canceled",
    canceled_at: nowIso,
    cancel_at_period_end: false,
    updated_at: nowIso,
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- billing-cancel-core`
Expected: PASS — 12 testes.

- [ ] **Step 5: Rodar typecheck**

Run: `npm run typecheck`
Expected: zero erro. O arquivo de teste está em `src/`, então o `tsc -b` alcança ele e, por tabela, os tipos importados do núcleo.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/billing-cancel-core.ts src/lib/billing-cancel-core.test.ts
git commit -m "feat(billing): nucleo puro de roteamento do cancelamento de assinatura"
```

---

## Task 2: Adapter devolve o efeito real

**Files:**
- Modify: `supabase/functions/_shared/billing-provider.ts` (import na linha 43, interface na linha 139, adapter Stripe na linha 200, adapter Asaas na linha 439)
- Modify: `supabase/functions/_shared/asaas.ts` (remover `deleteAsaasSubscription`, linhas 488-497)

**Interfaces:**
- Consumes: `CancelEffective` de `billing-cancel-core.ts`.
- Produces: `cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<ProviderResult<{ effective: CancelEffective }>>` nos dois adapters.

- [ ] **Step 1: Importar o tipo no `billing-provider.ts`**

Logo abaixo de `import { centsToAsaasValue } from "./asaas-core.ts";` (linha 51), acrescente:

```ts
import type { CancelEffective } from "./billing-cancel-core.ts";
```

- [ ] **Step 2: Remover `deleteAsaasSubscription` do import**

No bloco de import de `./asaas.ts` (linhas 38-50), apague a linha:

```ts
  deleteAsaasSubscription,
```

- [ ] **Step 3: Trocar a assinatura na interface**

Na linha 139, substitua:

```ts
  cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<ProviderResult>;
```

por:

```ts
  /** Devolve o efeito REAL. O caller grava a partir daqui, nunca do que pediu:
   *  um provedor cuja semântica não bata com `atPeriodEnd` divergiria em
   *  silêncio, que é o bug 08. */
  cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<ProviderResult<{ effective: CancelEffective }>>;
```

- [ ] **Step 4: Atualizar o adapter Stripe**

Na linha 200, substitua:

```ts
  async cancelSubscription(providerSubscriptionId, atPeriodEnd) {
    const res = await cancelStripeSubscription(providerSubscriptionId, atPeriodEnd);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  },
```

por:

```ts
  async cancelSubscription(providerSubscriptionId, atPeriodEnd) {
    const res = await cancelStripeSubscription(providerSubscriptionId, atPeriodEnd);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: { effective: atPeriodEnd ? "at_period_end" : "immediate" } };
  },
```

- [ ] **Step 5: Atualizar o adapter Asaas**

Na linha 439, substitua o método inteiro:

```ts
  async cancelSubscription(providerSubscriptionId, atPeriodEnd) {
    return safely<Record<string, unknown>>("cancelSubscription", async () => {
      if (atPeriodEnd) {
        // Não existe cancel_at_period_end no Asaas (§9): INACTIVE interrompe
        // a geração de cobranças futuras mas preserva o registro e as
        // cobranças já emitidas — o acesso do período pago continua
        // governado por billing_subscriptions.current_period_end no nosso
        // banco, não pelo Asaas.
        const res = await updateAsaasSubscription(providerSubscriptionId, { status: "INACTIVE" });
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      }
      // Cancelamento imediato: DELETE encerra a assinatura E remove as
      // cobranças pendentes/vencidas em aberto (§9) — só para quando o
      // cancelamento deve ser instantâneo, sem cobrança residual.
      const res = await deleteAsaasSubscription(providerSubscriptionId);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    });
  },
```

por:

```ts
  async cancelSubscription(providerSubscriptionId, _atPeriodEnd) {
    return safely<{ effective: CancelEffective }>("cancelSubscription", async () => {
      // `atPeriodEnd` é IGNORADO de propósito. Não existe período contratual no
      // Asaas; nada popula `current_period_end` nessas linhas (os quatro
      // escritores são todos Stripe) e nenhum evento ou worker viraria
      // `cancel_at_period_end` em `canceled` — a conta Asaas só assina eventos
      // PAYMENT_*. Honrar o pedido deixaria o cliente sem cobrança e com acesso
      // indefinidamente.
      //
      // INACTIVE e NÃO DELETE: DELETE encerra a assinatura E remove as cobranças
      // pendentes/vencidas em aberto (§9), ou seja, cancelar extinguiria a
      // própria dívida. INACTIVE interrompe a geração futura preservando o
      // histórico.
      const res = await updateAsaasSubscription(providerSubscriptionId, { status: "INACTIVE" });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { effective: "immediate" } };
    });
  },
```

- [ ] **Step 6: Remover `deleteAsaasSubscription` de `asaas.ts`**

Em `supabase/functions/_shared/asaas.ts`, apague a função inteira (linhas 488-497):

```ts
export async function deleteAsaasSubscription(
  subscriptionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await asaasRequest(`/subscriptions/${subscriptionId}`, "DELETE");
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao remover assinatura no Asaas.") };
  return { ok: true };
}
```

Ela tinha exatamente um caller — o branch removido no Step 5. Deixar função sem caller é o padrão que originou este bug.

- [ ] **Step 7: Confirmar que não sobrou referência**

Run: `grep -rn "deleteAsaasSubscription" supabase/ src/`
Expected: nenhuma linha.

- [ ] **Step 8: Rodar os testes e o typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS e zero erro. Nenhum teste cobre estes arquivos diretamente — a verificação aqui é o grep do Step 7 mais a revisão.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/billing-provider.ts supabase/functions/_shared/asaas.ts
git commit -m "feat(billing): adapter devolve o efeito real do cancelamento; Asaas sempre INACTIVE"
```

---

## Task 3: Rotear os dois call sites de `manage-billing`

**Files:**
- Modify: `supabase/functions/manage-billing/index.ts` (`cancel_subscription` nas linhas 682-726; `cancel_subscription_by_owner` nas linhas 873-910)

**Interfaces:**
- Consumes: `decideCancelTarget`, `localCancelPatch`, `CancelEffective` de `_shared/billing-cancel-core.ts`; `getBillingProvider` de `_shared/billing-provider.ts`.
- Produces: as duas actions passam a devolver `{ success: true, effective }` no corpo.

- [ ] **Step 1: Acrescentar os imports**

Junto dos demais imports de `_shared/` no topo do arquivo:

```ts
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { decideCancelTarget, localCancelPatch, type CancelEffective } from "../_shared/billing-cancel-core.ts";
```

Ambos são imports **novos**: `manage-billing` não importava `billing-provider.ts` até agora — é exatamente esse o bug. Não há duplicata a evitar.

- [ ] **Step 2: Substituir `cancel_subscription` (admin)**

Substitua o bloco inteiro das linhas 682-726 por:

```ts
    if (action === "cancel_subscription") {
      const { subscription_id, at_period_end = true } = body;
      if (!subscription_id) return jsonResponse(req, { error: "subscription_id é obrigatório." }, 400);

      const { data: sub } = await supabase
        .from("billing_subscriptions")
        .select("id, provider, provider_subscription_id, stripe_subscription_id, organization_id")
        .eq("id", subscription_id)
        .single();

      if (!sub) return jsonResponse(req, { error: "Assinatura não encontrada." }, 404);

      const target = decideCancelTarget(sub);
      if (target.kind === "unroutable") {
        jsonLog("warn", {
          reqId, evt: "billing_cancel_unroutable", subId: subscription_id,
          provider: target.provider, reason: target.reason,
        });
        return jsonResponse(req, {
          error: "Esta assinatura não tem vínculo com o provedor de pagamento. Não é possível cancelar automaticamente.",
        }, 400);
      }

      // Provedor PRIMEIRO. Falha aqui aborta sem escrever nada — era
      // exatamente o inverso disso que fazia o banco dizer "cancelado"
      // enquanto o Asaas seguia cobrando.
      let effective: CancelEffective = "immediate";
      if (target.kind === "provider") {
        const res = await getBillingProvider(target.provider).cancelSubscription(
          target.providerSubscriptionId,
          at_period_end === true,
        );
        if (!res.ok) {
          jsonLog("error", {
            reqId, evt: "billing_cancel_provider_error",
            provider: target.provider, subId: subscription_id, err: res.error,
          });
          return jsonResponse(req, { error: "Falha ao cancelar a assinatura no provedor de pagamento." }, 500);
        }
        effective = res.data?.effective ?? "immediate";
      }

      const { error: updErr } = await supabase
        .from("billing_subscriptions")
        .update(localCancelPatch(effective, new Date().toISOString()))
        .eq("id", subscription_id);

      if (updErr) {
        // Provedor já cancelou. Sem transação distribuída alguém fica na
        // frente, e cancelar no provedor primeiro erra a favor do cliente —
        // ele para de ser cobrado mesmo com o nosso banco fora. Este log é o
        // que permite achar e conciliar a divergência.
        jsonLog("error", {
          reqId, evt: "billing_cancel_local_write_failed",
          subId: subscription_id, provider: target.provider, effective, err: updErr.message,
        });
        return jsonResponse(req, { error: "Assinatura cancelada no provedor, mas o registro local falhou. Ver logs." }, 500);
      }

      // Só o cancelamento da assinatura de SISTEMA cancela a organização.
      // Cancelar a instância de WhatsApp marcava a org inteira como
      // 'canceled' — o cliente perdia o sistema por desistir da automação.
      if (effective === "immediate" && await isSystemSubscription(supabase, subscription_id)) {
        await supabase.from("organizations").update({
          billing_status: "canceled",
        }).eq("id", sub.organization_id);
      }

      jsonLog("info", {
        reqId, evt: "billing_subscription_cancelled",
        subId: subscription_id, target: target.kind, effective,
      });
      return jsonResponse(req, { success: true, effective });
    }
```

- [ ] **Step 3: Substituir `cancel_subscription_by_owner`**

Substitua o bloco inteiro das linhas 873-910 por:

```ts
    if (action === "cancel_subscription_by_owner") {
      const { subscription_id, organization_id } = body;
      if (!subscription_id || !organization_id) {
        return jsonResponse(req, { error: "subscription_id e organization_id são obrigatórios." }, 400);
      }
      if (!callerIsAdmin && !(await canManageOrgBilling(callerId, organization_id))) {
        return jsonResponse(req, { error: "Sem permissão." }, 403);
      }

      const { data: sub } = await supabase
        .from("billing_subscriptions")
        .select("id, provider, provider_subscription_id, stripe_subscription_id, organization_id, status")
        .eq("id", subscription_id)
        .single();

      if (!sub || sub.organization_id !== organization_id) {
        return jsonResponse(req, { error: "Assinatura não encontrada." }, 404);
      }
      if (sub.status === "canceled") {
        return jsonResponse(req, { error: "Assinatura já cancelada." }, 400);
      }

      const target = decideCancelTarget(sub);
      if (target.kind === "unroutable") {
        jsonLog("warn", {
          reqId, evt: "billing_cancel_by_owner_unroutable", subId: subscription_id,
          provider: target.provider, reason: target.reason,
        });
        return jsonResponse(req, {
          error: "Esta assinatura não tem vínculo com o provedor de pagamento. Fale com o suporte.",
        }, 400);
      }

      // O lojista sempre pede fim de período; o provedor responde o que de
      // fato deu. No Asaas isso volta como `immediate` — não há período
      // contratual a honrar, e a tela já avisa disso antes de confirmar.
      let effective: CancelEffective = "immediate";
      if (target.kind === "provider") {
        const res = await getBillingProvider(target.provider).cancelSubscription(
          target.providerSubscriptionId,
          true,
        );
        if (!res.ok) {
          jsonLog("error", {
            reqId, evt: "billing_cancel_by_owner_provider_error",
            provider: target.provider, subId: subscription_id, err: res.error,
          });
          return jsonResponse(req, { error: "Falha ao cancelar a assinatura no provedor de pagamento." }, 500);
        }
        effective = res.data?.effective ?? "immediate";
      }

      const { error: updErr } = await supabase
        .from("billing_subscriptions")
        .update(localCancelPatch(effective, new Date().toISOString()))
        .eq("id", subscription_id);

      if (updErr) {
        jsonLog("error", {
          reqId, evt: "billing_cancel_by_owner_local_write_failed",
          subId: subscription_id, provider: target.provider, effective, err: updErr.message,
        });
        return jsonResponse(req, { error: "Assinatura cancelada no provedor, mas o registro local falhou. Ver logs." }, 500);
      }

      jsonLog("info", {
        reqId, evt: "billing_subscription_cancelled_by_owner",
        subId: subscription_id, callerId, target: target.kind, effective,
      });
      return jsonResponse(req, { success: true, effective });
    }
```

Note que **não** há cascata para `organizations.billing_status` aqui — é o comportamento atual e permanece: o lojista cancelando a própria assinatura não bloqueia a organização.

- [ ] **Step 4: Confirmar que `cancelStripeSubscription` ficou sem uso**

Run: `grep -n "cancelStripeSubscription" supabase/functions/manage-billing/index.ts`
Expected: só a linha do import. Remova-a do bloco de import de `./stripe-billing.ts` (linha 12 do arquivo) e rode o grep de novo — deve não retornar nada.

- [ ] **Step 5: Rodar os testes e o typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS e zero erro.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/manage-billing/index.ts
git commit -m "fix(billing): cancelamento roteia pelo provedor em vez de chamar a Stripe direto"
```

---

## Task 4: UI para de prometer fim de período em Asaas

**Files:**
- Modify: `src/pages/platform/BillingDetail.tsx` (invocação nas linhas 291-297; `CancelSubDialog` na linha 912)
- Modify: `src/pages/gestao/Cobranca.tsx` (`handleCancel` nas linhas 235-247; diálogo nas linhas 515-536)

**Interfaces:**
- Consumes: `effective` no corpo da resposta das duas actions (Task 3); `provider` já vem no payload — `get_organization_billing` faz `select("*")` em `billing_subscriptions`.
- Produces: nada para tasks seguintes.

- [ ] **Step 1: `CancelSubDialog` aceita o provedor**

Em `src/pages/platform/BillingDetail.tsx`, linha 912, troque a assinatura:

```tsx
function CancelSubDialog({ open, onOpenChange, subscriptionId }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  subscriptionId: string;
}) {
  const mutation = useCancelSubscription();
  const [atPeriodEnd, setAtPeriodEnd] = useState(true);
```

por:

```tsx
function CancelSubDialog({ open, onOpenChange, subscriptionId, provider }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  subscriptionId: string;
  provider?: string;
}) {
  const mutation = useCancelSubscription();
  // Asaas não tem período contratual: nada popula current_period_end nessas
  // linhas e nenhum evento vira cancel_at_period_end em canceled. Oferecer a
  // opção prometeria algo que o sistema não sabe cumprir.
  const isAsaas = provider === "asaas";
  const [atPeriodEnd, setAtPeriodEnd] = useState(true);
  const effectiveAtPeriodEnd = isAsaas ? false : atPeriodEnd;
```

- [ ] **Step 2: Usar o valor efetivo no submit e na copy**

No mesmo componente, troque `handleSubmit` e o corpo do diálogo:

```tsx
  function handleSubmit() {
    mutation.mutate(
      { subscription_id: subscriptionId, at_period_end: atPeriodEnd },
```

por:

```tsx
  function handleSubmit() {
    mutation.mutate(
      { subscription_id: subscriptionId, at_period_end: effectiveAtPeriodEnd },
```

E troque a descrição e a caixa:

```tsx
          <AlertDialogDescription>
            {atPeriodEnd
              ? "O acesso será mantido até o fim do período atual."
              : "O cancelamento será imediato."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2 mt-2">
          <input type="checkbox" id="atPeriodEnd" checked={atPeriodEnd} onChange={(e) => setAtPeriodEnd(e.target.checked)} />
          <Label htmlFor="atPeriodEnd" className="text-sm">Cancelar apenas ao fim do período</Label>
        </div>
```

por:

```tsx
          <AlertDialogDescription>
            {isAsaas
              ? "O cancelamento é imediato: a cobrança recorrente é interrompida no provedor e o acesso termina agora. Não há reembolso do período já pago."
              : effectiveAtPeriodEnd
                ? "O acesso será mantido até o fim do período atual."
                : "O cancelamento será imediato."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!isAsaas && (
          <div className="flex items-center gap-2 mt-2">
            <input type="checkbox" id="atPeriodEnd" checked={atPeriodEnd} onChange={(e) => setAtPeriodEnd(e.target.checked)} />
            <Label htmlFor="atPeriodEnd" className="text-sm">Cancelar apenas ao fim do período</Label>
          </div>
        )}
```

- [ ] **Step 3: Passar o provedor na invocação**

Nas linhas 291-297, troque:

```tsx
      {activeSub && (
        <CancelSubDialog
          open={cancelDialog}
          onOpenChange={setCancelDialog}
          subscriptionId={activeSub.id}
        />
      )}
```

por:

```tsx
      {activeSub && (
        <CancelSubDialog
          open={cancelDialog}
          onOpenChange={setCancelDialog}
          subscriptionId={activeSub.id}
          provider={activeSub.provider}
        />
      )}
```

- [ ] **Step 4: Diálogo do lojista para de prometer período**

Em `src/pages/gestao/Cobranca.tsx`, linhas 519-523, troque:

```tsx
            <AlertDialogDescription>
              Você manterá acesso ao sistema até o fim do período já pago
              {sub?.current_period_end && ` (${formatDateBR(sub.current_period_end.slice(0, 10))})`}.
              Depois disso, o acesso será suspenso até você escolher um novo plano.
            </AlertDialogDescription>
```

por:

```tsx
            <AlertDialogDescription>
              {sub?.provider === "asaas" ? (
                <>
                  O cancelamento é imediato: a cobrança recorrente é interrompida e o acesso
                  ao sistema termina agora. Não há reembolso do período já pago.
                </>
              ) : (
                <>
                  Você manterá acesso ao sistema até o fim do período já pago
                  {sub?.current_period_end && ` (${formatDateBR(sub.current_period_end.slice(0, 10))})`}.
                  Depois disso, o acesso será suspenso até você escolher um novo plano.
                </>
              )}
            </AlertDialogDescription>
```

- [ ] **Step 5: Toast reflete o efeito devolvido**

Nas linhas 235-247, troque:

```tsx
  async function handleCancel() {
    if (!sub) return;
    try {
      await cancelMutation.mutateAsync({
        subscription_id: sub.id,
        organization_id: organizationId!,
      });
      toast.success("Assinatura agendada para cancelamento no fim do período.");
      setCancelDialog(false);
```

por:

```tsx
  async function handleCancel() {
    if (!sub) return;
    try {
      // `effective` vem do provedor, não do que pedimos: no Asaas o
      // cancelamento é sempre imediato, e afirmar "fim do período" seria falso.
      const res = await cancelMutation.mutateAsync({
        subscription_id: sub.id,
        organization_id: organizationId!,
      });
      toast.success(
        (res as { effective?: string })?.effective === "at_period_end"
          ? "Assinatura agendada para cancelamento no fim do período."
          : "Assinatura cancelada.",
      );
      setCancelDialog(false);
```

- [ ] **Step 6: Rodar os testes, o typecheck e o lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS, zero erro de tipo, zero erro de lint.

- [ ] **Step 7: Commit**

```bash
git add src/pages/platform/BillingDetail.tsx src/pages/gestao/Cobranca.tsx
git commit -m "fix(billing): UI para de prometer fim de periodo em assinatura Asaas"
```

---

## Task 5: CLAUDE.md — invariante e checklist de redeploy

**Files:**
- Modify: `CLAUDE.md` (seção "Billing — mensalidades" para o invariante; seção "Checklist de redeploy quando `_shared/X.ts` muda" para os consumidores)

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Acrescentar o invariante**

Na seção `## Billing — mensalidades`, acrescente como novo item da lista:

```markdown
- **Cancelamento de assinatura roteia por `getBillingProvider` e grava o estado local a partir do `effective` que o provedor devolve, nunca do que foi pedido.** As duas actions chamavam `cancelStripeSubscription` direto sob `if (sub.stripe_subscription_id)`: assinatura Asaas pulava o provedor, o banco gravava `canceled` e o Asaas seguia cobrando. No Asaas o cancelamento é sempre imediato (`INACTIVE`, nunca `DELETE`, que apagaria dívida em aberto) porque nada popula `current_period_end` nessas linhas e nenhum evento viraria `cancel_at_period_end` em `canceled`. Assinatura `stripe`/`asaas` sem id de provedor é recusada com 400 em vez de gravar `canceled` em silêncio; `manual`/`lifetime` cancelam só localmente, por não terem contraparte externa. [_shared/billing-cancel-core.ts](supabase/functions/_shared/billing-cancel-core.ts).
- **As outras cinco operações de `manage-billing` seguem Stripe-nativas por decisão, não por esquecimento** (`createSubscription`, `getSubscription`, `createOneTimeCharge`, `refundPayment` e a duplicata de `createCustomer` — todas sem caller no adapter). O destino é Asaas-only e a Stripe sai; roteá-las seria trabalho apagado junto. Contexto em [docs/billing-asaas/08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md](docs/billing-asaas/08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md).
```

- [ ] **Step 2: Atualizar o checklist de redeploy**

Na linha do checklist que começa com `- **billing-provider.ts**`, acrescente `manage-billing` (import direto de `getBillingProvider`) à lista de consumidores.

Na linha que começa com `- **asaas.ts**`, nada muda: `manage-billing` não o importa diretamente.

Acrescente uma linha nova, em ordem alfabética junto das demais:

```markdown
- **`billing-cancel-core.ts`** (núcleo puro, testado em [src/lib/billing-cancel-core.test.ts](src/lib/billing-cancel-core.test.ts)) → `manage-billing`. Decide a rota do cancelamento e o patch local; redeploy parcial deixaria a EF decidindo com uma tabela de provedores desatualizada.
```

- [ ] **Step 3: Não auditar o CLAUDE.md nesta task**

O arquivo já está em **85.575 caracteres** — mais que o dobro do limite de 40.000 em que a própria regra de ouro dele manda auditar e cortar. Os dois itens do Step 1 entram assim mesmo: eles mudam decisão de código futuro, que é o critério de entrada declarado no topo do arquivo.

A auditoria em si **não pertence a este plano** — é trabalho de corte em texto que documenta dezenas de features sem relação com cancelamento, e misturar isso num fix de billing enterraria o fix numa revisão de 45 KB de prosa. Fica como follow-up separado, reportado ao final.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): invariante do cancelamento roteado por provedor e checklist de redeploy"
```

---

## Verificação final (depois da última task)

- [ ] `npm test` — todos os testes passam, incluindo os 12 do núcleo novo.
- [ ] `npm run typecheck` — zero erro.
- [ ] `npm run lint` — zero erro.
- [ ] `grep -rn "deleteAsaasSubscription" supabase/ src/` — nenhuma linha.
- [ ] `grep -rn "cancelStripeSubscription" supabase/functions/manage-billing/` — nenhuma linha.
- [ ] Gates obrigatórios do CLAUDE.md antes de merge, por tocarem billing e Edge Function: agentes `saas-shield-br:integration-reliability-auditor` e `saas-shield-br:tenant-isolation-auditor`.
- [ ] **Deploy:** `supabase functions deploy manage-billing`. Nenhuma migration nesta mudança. As demais EFs que importam `billing-provider.ts` (`create-billing-checkout`, `process-asaas-reconcile`, `manage-organizations`, `asaas-webhook`, `manage-whatsapp-implementations`) **precisam de redeploy também** — a assinatura de `cancelSubscription` mudou no arquivo compartilhado, e Edge Functions não compartilham bundle em runtime.

## O que este plano NÃO faz

Reconciliar de volta uma assinatura Asaas cancelada direto no painel do provedor (a "metade 2"); popular `current_period_end` para Asaas; qualquer noção de expiração por data em `entitlements-core`; as outras cinco operações não roteadas; o bug do `externalReference`, que tem spec própria. Tudo declarado na §7 da spec.
