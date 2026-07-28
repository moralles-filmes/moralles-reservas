import { describe, it, expect } from "vitest";
import {
  SETTLED_ASAAS_PAYMENT_STATUSES,
  isSettledAsaasPaymentStatus,
  mapAsaasBillingTypeToPaymentMethod,
  decideMissingInvoiceIngestion,
  shouldSettleOpenInvoice,
  shouldHoldValueMismatch,
} from "../../supabase/functions/_shared/asaas-invoice-reconcile-core";

describe("isSettledAsaasPaymentStatus", () => {
  it("RECEIVED, CONFIRMED e RECEIVED_IN_CASH são liquidados", () => {
    expect(isSettledAsaasPaymentStatus("RECEIVED")).toBe(true);
    expect(isSettledAsaasPaymentStatus("CONFIRMED")).toBe(true);
    expect(isSettledAsaasPaymentStatus("RECEIVED_IN_CASH")).toBe(true);
  });

  it("PENDING, OVERDUE, REFUNDED e statuses desconhecidos não são liquidados", () => {
    expect(isSettledAsaasPaymentStatus("PENDING")).toBe(false);
    expect(isSettledAsaasPaymentStatus("OVERDUE")).toBe(false);
    expect(isSettledAsaasPaymentStatus("REFUNDED")).toBe(false);
    expect(isSettledAsaasPaymentStatus("RECEIVED_IN_CASH_UNDONE")).toBe(false);
    expect(isSettledAsaasPaymentStatus("")).toBe(false);
    expect(isSettledAsaasPaymentStatus("received")).toBe(false); // case-sensitive de propósito
  });

  it("pin do conjunto exato — evita crescer/encolher em silêncio", () => {
    expect([...SETTLED_ASAAS_PAYMENT_STATUSES].sort()).toEqual(
      ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"].sort(),
    );
  });
});

describe("mapAsaasBillingTypeToPaymentMethod", () => {
  it("mapeia os 3 tipos conhecidos", () => {
    expect(mapAsaasBillingTypeToPaymentMethod("CREDIT_CARD")).toBe("card");
    expect(mapAsaasBillingTypeToPaymentMethod("PIX")).toBe("pix");
    expect(mapAsaasBillingTypeToPaymentMethod("BOLETO")).toBe("boleto");
  });

  it("null e desconhecido nunca chutam um método", () => {
    expect(mapAsaasBillingTypeToPaymentMethod(null)).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod("UNDEFINED")).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod("")).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod("credit_card")).toBeNull(); // case-sensitive
  });
});

describe("decideMissingInvoiceIngestion", () => {
  it("since vazia ('' — ingestão nunca configurada) nunca vira BACKFILL", () => {
    const d = decideMissingInvoiceIngestion({ sinceValue: "", dueDate: "2020-01-01", settled: false });
    expect(d).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
  });

  it("dueDate anterior a since e não liquidada → BACKFILL retida com INITIAL_BACKFILL", () => {
    const d = decideMissingInvoiceIngestion({
      sinceValue: "2026-07-28",
      dueDate: "2026-07-01",
      settled: false,
    });
    expect(d).toEqual({ ingestionSource: "BACKFILL", hold: true, holdReason: "INITIAL_BACKFILL" });
  });

  it("dueDate anterior a since MAS já liquidada → BACKFILL sem retenção", () => {
    const d = decideMissingInvoiceIngestion({
      sinceValue: "2026-07-28",
      dueDate: "2026-07-01",
      settled: true,
    });
    expect(d).toEqual({ ingestionSource: "BACKFILL", hold: false, holdReason: null });
  });

  it("dueDate == since (fronteira do dia 0) NÃO é backfill — dueDate < since é estrito", () => {
    const d = decideMissingInvoiceIngestion({
      sinceValue: "2026-07-28",
      dueDate: "2026-07-28",
      settled: false,
    });
    expect(d).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
  });

  it("dueDate posterior a since → RECONCILE sem retenção, liquidada ou não", () => {
    expect(
      decideMissingInvoiceIngestion({ sinceValue: "2026-07-28", dueDate: "2026-08-01", settled: false }),
    ).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
    expect(
      decideMissingInvoiceIngestion({ sinceValue: "2026-07-28", dueDate: "2026-08-01", settled: true }),
    ).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
  });
});

describe("shouldSettleOpenInvoice", () => {
  it("open + liquidada remotamente → true", () => {
    expect(shouldSettleOpenInvoice("open", true)).toBe(true);
  });

  it("open + não liquidada remotamente → false", () => {
    expect(shouldSettleOpenInvoice("open", false)).toBe(false);
  });

  it("qualquer status que não seja 'open' nunca liquida por aqui, mesmo remotamente paga", () => {
    expect(shouldSettleOpenInvoice("draft", true)).toBe(false);
    expect(shouldSettleOpenInvoice("paid", true)).toBe(false);
    expect(shouldSettleOpenInvoice("void", true)).toBe(false);
    expect(shouldSettleOpenInvoice("uncollectible", true)).toBe(false);
  });
});

describe("shouldHoldValueMismatch", () => {
  const base = { localStatus: "open" as const, alreadyHeld: false, localAmountCents: 14900, remoteAmountCents: 14900 };

  it("open + não retida + valores divergentes → true", () => {
    expect(shouldHoldValueMismatch({ ...base, remoteAmountCents: 19900 })).toBe(true);
  });

  it("open + não retida + valores iguais → false", () => {
    expect(shouldHoldValueMismatch(base)).toBe(false);
  });

  it("já retida → false, mesmo com valores divergentes (não reescreve retenção existente)", () => {
    expect(shouldHoldValueMismatch({ ...base, alreadyHeld: true, remoteAmountCents: 19900 })).toBe(false);
  });

  it("status fora de 'open' → false, mesmo com valores divergentes", () => {
    for (const status of ["draft", "paid", "void", "uncollectible"] as const) {
      expect(shouldHoldValueMismatch({ ...base, localStatus: status, remoteAmountCents: 19900 })).toBe(false);
    }
  });
});
