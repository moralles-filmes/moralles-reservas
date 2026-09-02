import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

import {
  isWhatsappConnectionTransient,
  normalizeWhatsappConnection,
  whatsappConnectionReadAction,
  whatsappPollingInterval,
} from "@/hooks/useWhatsappConnection";
import { defaultWhatsappProviderSchema } from "@/lib/validators/organization";

describe("defaultWhatsappProviderSchema", () => {
  it("aceita somente providers disponíveis na criação de empresa", () => {
    expect(defaultWhatsappProviderSchema.parse("zapi")).toBe("zapi");
    expect(defaultWhatsappProviderSchema.parse("uazapi")).toBe("uazapi");
    expect(defaultWhatsappProviderSchema.safeParse("outro").success).toBe(false);
  });
});

describe("normalizeWhatsappConnection", () => {
  it("expõe somente o snapshot client-safe", () => {
    const snapshot = normalizeWhatsappConnection({
      channel: {
        id: "channel-1",
        status: "waiting_qr",
        display_phone: "5511999999999",
        qr_code: "qr-temporario",
        provider: "uazapi",
        credentials: { token: "nao-pode-vazar" },
        external_instance_id: "instancia-administrativa",
      },
    });

    expect(snapshot).toEqual({
      channel_id: "channel-1",
      status: "waiting_qr",
      display_phone: "5511999999999",
      qr_code: "qr-temporario",
      qr_expires_at: null,
      connected_at: null,
      last_health_check_at: null,
      lifecycle_available: false,
    });
    expect(snapshot).not.toHaveProperty("provider");
    expect(snapshot).not.toHaveProperty("credentials");
    expect(snapshot).not.toHaveProperty("external_instance_id");
  });

  it("prefere o canal explicitamente ativo numa lista", () => {
    const snapshot = normalizeWhatsappConnection({
      channels: [
        { id: "antigo", status: "connected", is_active: false },
        { id: "novo", status: "connecting", is_active: true },
      ],
    });

    expect(snapshot.channel_id).toBe("novo");
    expect(snapshot.status).toBe("connecting");
  });
});

describe("polling da conexão", () => {
  it("escolhe a leitura pela capability do canal, não pelo status", () => {
    const manualTransient = normalizeWhatsappConnection({
      id: "zapi-1",
      status: "connecting",
      lifecycle_available: false,
    });
    const managedStable = normalizeWhatsappConnection({
      id: "uazapi-1",
      status: "connected",
      lifecycle_available: true,
    });

    expect(whatsappConnectionReadAction(undefined)).toBe("list_client");
    expect(whatsappConnectionReadAction(manualTransient)).toBe("list_client");
    expect(whatsappConnectionReadAction(managedStable)).toBe("status");
  });

  it.each(["provisioning", "waiting_qr", "connecting", "reconnecting", "switching_provider"])(
    "trata %s como transitório",
    (status) => {
      expect(isWhatsappConnectionTransient(status as never)).toBe(true);
      expect(
        whatsappPollingInterval(
          { ...normalizeWhatsappConnection({ status }), status: status as never },
          true,
        ),
      ).toBe(5_000);
    },
  );

  it.each(["connected", "disconnected", "provider_error", "error"])(
    "revalida o estado configurado %s a cada 30 segundos",
    (status) => {
      const snapshot = normalizeWhatsappConnection({ id: "channel-1", status });
      expect(whatsappPollingInterval(snapshot, true)).toBe(30_000);
    },
  );

  it("não faz polling sem canal, suspenso ou com a página oculta", () => {
    const notConfigured = normalizeWhatsappConnection({ status: "not_configured" });
    const suspended = normalizeWhatsappConnection({ id: "channel-1", status: "suspended" });
    const connecting = normalizeWhatsappConnection({ status: "connecting" });

    expect(whatsappPollingInterval(notConfigured, true)).toBe(false);
    expect(whatsappPollingInterval(suspended, true)).toBe(false);
    expect(whatsappPollingInterval(connecting, false)).toBe(false);
  });
});
