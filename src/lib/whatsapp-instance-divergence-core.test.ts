import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_CHANNEL_DIVERGENCE_DAYS,
  detectChannelWithoutInstance,
  detectInstanceDivergences,
  type ChannelRow,
  type InstanceRow,
} from "../../supabase/functions/_shared/whatsapp-instance-divergence-core";

function channel(p: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channelId: "ch1",
    organizationId: "org1",
    isEligibleInventoryChannel: true,
    hasLinkedInstance: false,
    monthBrt: "2026-08",
    ...p,
  };
}

function instance(p: Partial<InstanceRow> = {}): InstanceRow {
  return {
    instanceId: "in1",
    organizationId: "org1",
    lifecycleState: "ACTIVE",
    channelId: "ch1",
    providerInstanceRef: "REF1",
    legacyChannelInstanceRef: "REF1",
    channelState: "connected",
    channelStateAgeDays: 0,
    hasAdminExplanation: false,
    endedAtIso: null,
    lastLocalSignalAtIso: null,
    ...p,
  };
}

describe("o limiar é constante única e documentada", () => {
  it("sete dias", () => {
    expect(LIFECYCLE_CHANNEL_DIVERGENCE_DAYS).toBe(7);
  });
});

describe("CHANNEL_WITHOUT_INSTANCE — custo invisível (spec §10.7)", () => {
  it("canal elegível sem instância correspondente GERA", () => {
    const f = detectChannelWithoutInstance(channel());
    expect(f?.kind).toBe("CHANNEL_WITHOUT_INSTANCE");
    expect(f?.instanceId).toBeNull();
    expect(f?.channelId).toBe("ch1");
    expect(f?.dedupeKey).toBe("channel_without_instance:ch1:2026-08");
  });

  it("canal já associado NÃO gera", () => {
    expect(detectChannelWithoutInstance(channel({ hasLinkedInstance: true }))).toBeNull();
  });

  it("canal desativado ou fora de escopo NÃO gera", () => {
    expect(detectChannelWithoutInstance(channel({ isEligibleInventoryChannel: false }))).toBeNull();
  });
});

describe("PAYING_WITHOUT_CHANNEL", () => {
  it("instância ACTIVE sem channel_id GERA", () => {
    const f = detectInstanceDivergences(
      instance({ channelId: null, legacyChannelInstanceRef: null, channelState: null, channelStateAgeDays: null }),
    );
    expect(f.map((x) => x.kind)).toContain("PAYING_WITHOUT_CHANNEL");
  });

  it("AWAITING_PROVISION NÃO é tratada da mesma forma — ainda não existe canal por definição", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "AWAITING_PROVISION",
        channelId: null,
        legacyChannelInstanceRef: null,
        channelState: null,
        channelStateAgeDays: null,
      }),
    );
    expect(f.map((x) => x.kind)).not.toContain("PAYING_WITHOUT_CHANNEL");
  });

  it("ENDED NÃO gera este tipo", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "ENDED",
        channelId: null,
        legacyChannelInstanceRef: null,
        channelState: null,
        channelStateAgeDays: null,
        endedAtIso: "2026-07-01T12:00:00Z",
      }),
    );
    expect(f.map((x) => x.kind)).not.toContain("PAYING_WITHOUT_CHANNEL");
  });
});

describe("INSTANCE_REF_MISMATCH — nunca corrige sozinho (§3.3)", () => {
  it("referências diferentes GERAM", () => {
    const f = detectInstanceDivergences(instance({ legacyChannelInstanceRef: "OUTRO" }));
    expect(f.map((x) => x.kind)).toContain("INSTANCE_REF_MISMATCH");
  });

  it("referências iguais NÃO geram", () => {
    expect(detectInstanceDivergences(instance()).map((x) => x.kind)).not.toContain(
      "INSTANCE_REF_MISMATCH",
    );
  });

  it("valor ausente NÃO vira mismatch automaticamente", () => {
    expect(
      detectInstanceDivergences(instance({ legacyChannelInstanceRef: null })).map((x) => x.kind),
    ).not.toContain("INSTANCE_REF_MISMATCH");
    expect(
      detectInstanceDivergences(instance({ providerInstanceRef: null })).map((x) => x.kind),
    ).not.toContain("INSTANCE_REF_MISMATCH");
  });
});

describe("LIFECYCLE_VS_CHANNEL_STATE — as cinco condições", () => {
  it("desconectado há MENOS de sete dias NÃO gera", () => {
    const f = detectInstanceDivergences(instance({ channelState: "disconnected", channelStateAgeDays: 6 }));
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("sete dias COMPLETOS gera — limite exato", () => {
    const f = detectInstanceDivergences(instance({ channelState: "disconnected", channelStateAgeDays: 7 }));
    expect(f.map((x) => x.kind)).toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("status desconhecido ou nunca sincronizado NÃO gera, nem com idade alta", () => {
    const f = detectInstanceDivergences(instance({ channelState: null, channelStateAgeDays: 90 }));
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("connected RESOLVE", () => {
    const f = detectInstanceDivergences(instance({ channelState: "connected", channelStateAgeDays: 90 }));
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("explicação administrativa registrada suprime", () => {
    const f = detectInstanceDivergences(
      instance({ channelState: "disconnected", channelStateAgeDays: 30, hasAdminExplanation: true }),
    );
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("instância não-ACTIVE não gera", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "CANCELLATION_REQUESTED",
        channelState: "disconnected",
        channelStateAgeDays: 30,
      }),
    );
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });
});

describe("ALIVE_AFTER_END — evidência local, nunca afirmação sobre cobrança", () => {
  it("ENDED com sinal POSTERIOR gera", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "ENDED",
        endedAtIso: "2026-07-01T12:00:00Z",
        lastLocalSignalAtIso: "2026-07-05T09:00:00Z",
      }),
    );
    expect(f.map((x) => x.kind)).toContain("ALIVE_AFTER_END");
  });

  it("ENDED sem sinal posterior NÃO gera", () => {
    const f = detectInstanceDivergences(
      instance({ lifecycleState: "ENDED", endedAtIso: "2026-07-01T12:00:00Z", lastLocalSignalAtIso: null }),
    );
    expect(f.map((x) => x.kind)).not.toContain("ALIVE_AFTER_END");
  });

  it("sinal ANTERIOR a ended_at NÃO gera", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "ENDED",
        endedAtIso: "2026-07-01T12:00:00Z",
        lastLocalSignalAtIso: "2026-06-20T09:00:00Z",
      }),
    );
    expect(f.map((x) => x.kind)).not.toContain("ALIVE_AFTER_END");
  });

  it("o texto NUNCA afirma que a Z-API continua cobrando", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "ENDED",
        endedAtIso: "2026-07-01T12:00:00Z",
        lastLocalSignalAtIso: "2026-07-05T09:00:00Z",
      }),
    );
    const alive = f.find((x) => x.kind === "ALIVE_AFTER_END");
    expect(alive?.detail).toBe(
      "Há sinais posteriores ao encerramento registrado. Verifique o estado real no provider.",
    );
    expect(alive?.detail).not.toMatch(/cobran|cobrando|pagando/i);
  });
});
