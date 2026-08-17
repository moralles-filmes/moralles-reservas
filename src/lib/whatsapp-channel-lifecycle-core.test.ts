import { describe, expect, it } from "vitest";
import {
  isTransientWhatsAppStatus,
  normalizeUazConnectionStatus,
  shouldActivateConnectedChannel,
} from "../../supabase/functions/_shared/whatsapp-channel-lifecycle-core";

describe("lifecycle normalizado do canal WhatsApp", () => {
  it("mapeia os quatro estados UazAPI sem inventar estado conectado", () => {
    expect(normalizeUazConnectionStatus({ status: "connected" })).toBe("connected");
    expect(normalizeUazConnectionStatus({ status: "hibernated" })).toBe("suspended");
    expect(normalizeUazConnectionStatus({ status: "disconnected" })).toBe("disconnected");
    expect(normalizeUazConnectionStatus({ status: "connecting" })).toBe("connecting");
  });

  it("QR prevalece como waiting_qr enquanto ainda não conectou", () => {
    expect(normalizeUazConnectionStatus({ status: "connecting", qrCode: "data:image/png;base64,..." }))
      .toBe("waiting_qr");
  });

  it("polling é restrito a estados transitórios", () => {
    expect(isTransientWhatsAppStatus("provisioning")).toBe(true);
    expect(isTransientWhatsAppStatus("waiting_qr")).toBe(true);
    expect(isTransientWhatsAppStatus("connected")).toBe(false);
    expect(isTransientWhatsAppStatus("provider_error")).toBe(false);
  });

  it("primeiro canal conectado pode ativar", () => {
    expect(shouldActivateConnectedChannel({
      targetChannelId: "target",
      explicitActiveChannelId: null,
      activationRequested: false,
    })).toBe(true);
  });

  it("canal preparado não corta produção sem begin_switch", () => {
    expect(shouldActivateConnectedChannel({
      targetChannelId: "target",
      explicitActiveChannelId: "old",
      activationRequested: false,
    })).toBe(false);
    expect(shouldActivateConnectedChannel({
      targetChannelId: "target",
      explicitActiveChannelId: "old",
      activationRequested: true,
    })).toBe(true);
  });
});
