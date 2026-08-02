import { describe, it, expect } from "vitest";
import {
  EVENT_TYPE_BY_ALERT,
  resolveD1Reasons,
  shouldEmitD7,
  shouldEmitD1,
  economicImbalanceHash,
  dedupeKeyD1,
  dedupeKeyD7,
  dedupeKeyDateReview,
  CANONICAL_EVENT_TYPES,
  type D1Input,
} from "../../supabase/functions/_shared/whatsapp-instance-alerts-core";

function d1(p: Partial<D1Input> = {}): D1Input {
  return {
    costCents: 10000,
    hasOpenDivergence: false,
    cancellationIntendedNotRegistered: false,
    revenueSource: "SUBSCRIPTION_SOLE_INSTANCE",
    customerRevenueCents: 14900,
    ...p,
  };
}

describe("EVENT_TYPE_BY_ALERT — o acoplamento por string com process-billing-notifications", () => {
  it("os seis event_type são exatamente os da spec §10.6", () => {
    expect(EVENT_TYPE_BY_ALERT).toEqual({
      CYCLE_DUE_SOON: "admin_zapi_cycle_d7",
      CYCLE_DUE_TOMORROW: "admin_zapi_cycle_d1_action_required",
      END_CONFIRMATION_REQUIRED: "admin_zapi_end_confirmation_required",
      DATE_REVIEW_REQUIRED: "admin_zapi_date_review_required",
      DIVERGENCE: "admin_zapi_divergence",
      ECONOMIC_IMBALANCE: "admin_zapi_economic_imbalance",
    });
  });

  it("custo desconhecido NÃO tem event_type próprio — é motivo do D-1, não aviso isolado", () => {
    expect(CANONICAL_EVENT_TYPES).not.toContain("admin_zapi_cycle_cost_unknown");
    expect(CANONICAL_EVENT_TYPES).toHaveLength(6);
  });

  it("CANONICAL_EVENT_TYPES é a lista achatada e ordenada dos mesmos seis", () => {
    expect(CANONICAL_EVENT_TYPES).toEqual(Object.values(EVENT_TYPE_BY_ALERT).sort());
  });
});

describe("resolveD1Reasons — sem motivo, silêncio (spec §10.5)", () => {
  it("tudo em ordem: lista VAZIA — é o que torna o D-1 condicional", () => {
    expect(resolveD1Reasons(d1())).toEqual([]);
  });

  it("custo desconhecido é motivo", () => {
    expect(resolveD1Reasons(d1({ costCents: null }))).toEqual(["COST_UNKNOWN"]);
  });

  it("divergência aberta é motivo", () => {
    expect(resolveD1Reasons(d1({ hasOpenDivergence: true }))).toEqual(["OPEN_DIVERGENCE"]);
  });

  it("cancelamento pretendido e não registrado é motivo", () => {
    expect(resolveD1Reasons(d1({ cancellationIntendedNotRegistered: true }))).toEqual([
      "CANCELLATION_INTENDED_NOT_REGISTERED",
    ]);
  });

  it("receita NULL fora dos casos previstos é motivo", () => {
    expect(
      resolveD1Reasons(d1({ customerRevenueCents: null, revenueSource: "NO_ENTITLEMENT" })),
    ).toEqual(["REVENUE_UNKNOWN"]);
  });

  it("AMBIGUOUS_MULTI_INSTANCE é caso PREVISTO: receita NULL ali não é motivo", () => {
    expect(
      resolveD1Reasons(d1({ customerRevenueCents: null, revenueSource: "AMBIGUOUS_MULTI_INSTANCE" })),
    ).toEqual([]);
  });

  it("LIFETIME_OVERRIDE com receita 0 não é motivo", () => {
    expect(
      resolveD1Reasons(d1({ customerRevenueCents: 0, revenueSource: "LIFETIME_OVERRIDE" })),
    ).toEqual([]);
  });

  it("múltiplos motivos mantêm ORDEM DEFINIDA e não duplicam", () => {
    const r = resolveD1Reasons(
      d1({
        costCents: null,
        hasOpenDivergence: true,
        cancellationIntendedNotRegistered: true,
        customerRevenueCents: null,
        revenueSource: "NO_ENTITLEMENT",
      }),
    );
    expect(r).toEqual([
      "COST_UNKNOWN",
      "OPEN_DIVERGENCE",
      "CANCELLATION_INTENDED_NOT_REGISTERED",
      "REVENUE_UNKNOWN",
    ]);
    expect(new Set(r).size).toBe(r.length);
  });

  it("é determinístico: mesma entrada, mesma saída", () => {
    const input = d1({ costCents: null, hasOpenDivergence: true });
    expect(resolveD1Reasons(input)).toEqual(resolveD1Reasons(input));
  });
});

describe("janelas de emissão", () => {
  it("D-7 cobre a janela 1..7 — o worker que perder um dia ainda avisa", () => {
    expect(shouldEmitD7(8)).toBe(false);
    expect(shouldEmitD7(7)).toBe(true);
    expect(shouldEmitD7(3)).toBe(true);
    expect(shouldEmitD7(1)).toBe(true);
    expect(shouldEmitD7(0)).toBe(false);
  });

  it("D-1 só com motivo, na janela 0..1", () => {
    expect(shouldEmitD1(1, [])).toBe(false);
    expect(shouldEmitD1(1, ["COST_UNKNOWN"])).toBe(true);
    expect(shouldEmitD1(0, ["COST_UNKNOWN"])).toBe(true);
    expect(shouldEmitD1(2, ["COST_UNKNOWN"])).toBe(false);
  });
});

describe("dedupe", () => {
  it("D-7 deduplica por cycle_start: um por ciclo", () => {
    expect(dedupeKeyD7("2026-08-10")).toBe("cycle_d7:2026-08-10");
  });

  it("D-1 deduplica por ciclo: motivo que MUDA entre D-1 e D-0 não abre linha nova", () => {
    // A janela do D-1 tem dois dias e os motivos são recalculados a cada
    // passada. Se a chave carregasse os motivos, um custo que sincroniza ou uma
    // divergência que abre no meio criaria uma SEGUNDA ocorrência para o mesmo
    // vencimento — dois avisos "created", o primeiro congelado com uma lista
    // que já não vale. Os motivos vivem no payload, que é reescrito.
    expect(dedupeKeyD1("2026-08-10")).toBe(dedupeKeyD1("2026-08-10"));
    expect(dedupeKeyD1("2026-09-10")).not.toBe(dedupeKeyD1("2026-08-10"));
  });

  it("D-7 e D-1 do mesmo ciclo são ocorrências distintas", () => {
    expect(dedupeKeyD1("2026-08-10")).not.toBe(dedupeKeyD7("2026-08-10"));
  });

  it("a pendência de data usa <YYYY-MM BRT>:<instance_id> — uma ocorrência por mês", () => {
    expect(dedupeKeyDateReview("2026-08", "in1")).toBe("2026-08:in1");
  });

  it("mês seguinte abre ocorrência NOVA em vez de reemitir a mesma linha", () => {
    expect(dedupeKeyDateReview("2026-09", "in1")).not.toBe(dedupeKeyDateReview("2026-08", "in1"));
  });
});

describe("economicImbalanceHash", () => {
  it("ordem diferente das MESMAS instâncias produz o MESMO hash", () => {
    const a = economicImbalanceHash(
      [{ instanceId: "i2", costCents: 12000 }, { instanceId: "i1", costCents: 10000 }],
      14900,
    );
    const b = economicImbalanceHash(
      [{ instanceId: "i1", costCents: 10000 }, { instanceId: "i2", costCents: 12000 }],
      14900,
    );
    expect(a).toBe(b);
  });

  it("mudança material de composição produz hash DIFERENTE", () => {
    const base = economicImbalanceHash([{ instanceId: "i1", costCents: 10000 }], 14900);
    expect(economicImbalanceHash([{ instanceId: "i1", costCents: 11000 }], 14900)).not.toBe(base);
    expect(economicImbalanceHash([{ instanceId: "i9", costCents: 10000 }], 14900)).not.toBe(base);
    expect(economicImbalanceHash([{ instanceId: "i1", costCents: 10000 }], 9900)).not.toBe(base);
  });

  it("custo desconhecido é distinto de zero no hash", () => {
    expect(economicImbalanceHash([{ instanceId: "i1", costCents: null }], 14900)).not.toBe(
      economicImbalanceHash([{ instanceId: "i1", costCents: 0 }], 14900),
    );
  });
});
