import { describe, it, expect } from "vitest";
import { normalizeFinancialState } from "../../supabase/functions/_shared/billing-financial-state-core";

// 2026-07-27T15:00:00Z = 12:00 BRT do dia 27.
const NOW = "2026-07-27T15:00:00Z";

describe("normalizeFinancialState", () => {
  it("sem assinatura devolve NO_SUBSCRIPTION", () => {
    expect(
      normalizeFinancialState({ now: NOW, subscriptionStatus: null, canceledAt: null, oldestOpenInvoice: null }).state,
    ).toBe("NO_SUBSCRIPTION");
  });

  it("assinatura cancelada devolve CANCELED mesmo com fatura em aberto", () => {
    expect(
      normalizeFinancialState({
        now: NOW, subscriptionStatus: "canceled", canceledAt: "2026-07-01T00:00:00Z",
        oldestOpenInvoice: { dueDate: "2026-07-01", status: "open" },
      }).state,
    ).toBe("CANCELED");
  });

  it("sem fatura em aberto está em dia, mesmo com status past_due", () => {
    // Pagamento posterior converge: a fatura foi liquidada, o status ainda não
    // tinha sido reconciliado.
    expect(
      normalizeFinancialState({ now: NOW, subscriptionStatus: "past_due", canceledAt: null, oldestOpenInvoice: null }).state,
    ).toBe("PAID");
  });

  it("fatura que ainda não venceu está em dia", () => {
    expect(
      normalizeFinancialState({
        now: NOW, subscriptionStatus: "active", canceledAt: null,
        oldestOpenInvoice: { dueDate: "2026-07-30", status: "open" },
      }).state,
    ).toBe("PAID");
  });

  it("D+1 até D+5 é tolerância", () => {
    for (const [due, dias] of [["2026-07-26", 1], ["2026-07-22", 5]] as const) {
      const r = normalizeFinancialState({
        now: NOW, subscriptionStatus: "past_due", canceledAt: null,
        oldestOpenInvoice: { dueDate: due, status: "open" },
      });
      expect(r.state).toBe("IN_GRACE");
      expect(r.daysOverdue).toBe(dias);
    }
  });

  it("D+6 passa da tolerância", () => {
    const r = normalizeFinancialState({
      now: NOW, subscriptionStatus: "past_due", canceledAt: null,
      oldestOpenInvoice: { dueDate: "2026-07-21", status: "open" },
    });
    expect(r.state).toBe("OVERDUE_BEYOND_GRACE");
    expect(r.daysOverdue).toBe(6);
  });

  it("graceEndsAt é due_date + 5 dias e existe só quando há fatura vencida", () => {
    expect(
      normalizeFinancialState({
        now: NOW, subscriptionStatus: "past_due", canceledAt: null,
        oldestOpenInvoice: { dueDate: "2026-07-26", status: "open" },
      }).graceEndsAt,
    ).toBe("2026-07-31");
    expect(
      normalizeFinancialState({ now: NOW, subscriptionStatus: "active", canceledAt: null, oldestOpenInvoice: null }).graceEndsAt,
    ).toBeNull();
  });

  it("fatura paga ou anulada não conta como atraso", () => {
    for (const status of ["paid", "void", "uncollectible"] as const) {
      expect(
        normalizeFinancialState({
          now: NOW, subscriptionStatus: "past_due", canceledAt: null,
          oldestOpenInvoice: { dueDate: "2026-07-01", status },
        }).state,
      ).toBe("PAID");
    }
  });

  it("vencimento HOJE ainda está em dia (fronteira do dia 0)", () => {
    // Trava a fronteira: o único guard é `if (overdue < 1) return none`. Uma
    // regressão para `< 0` moveria "vence hoje" para IN_GRACE silenciosamente,
    // cobrando tolerância de quem ainda está dentro do prazo. Valores
    // conferidos contra o comportamento real do código (branch `none`):
    // daysOverdue e graceEndsAt continuam null quando não há atraso.
    const r = normalizeFinancialState({
      now: NOW, subscriptionStatus: "past_due", canceledAt: null,
      oldestOpenInvoice: { dueDate: "2026-07-27", status: "open" },
    });
    expect(r.state).toBe("PAID");
    expect(r.daysOverdue).toBeNull();
    expect(r.graceEndsAt).toBeNull();
  });

  it("canceledAt sozinho (sem subscriptionStatus) ainda precede NO_SUBSCRIPTION", () => {
    // Antes deste teste, a precedência de CANCELED só era exercitada com os
    // dois sinais juntos (canceledAt + subscriptionStatus: "canceled"). Trava
    // o ramo em que só canceledAt está preenchido.
    expect(
      normalizeFinancialState({
        now: NOW, subscriptionStatus: null, canceledAt: "2026-07-01T00:00:00Z",
        oldestOpenInvoice: null,
      }).state,
    ).toBe("CANCELED");
  });
});
