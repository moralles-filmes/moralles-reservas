/**
 * O defeito que este nucleo existe pra impedir: a coluna WhatsApp do painel da
 * plataforma lia `organizations.default_whatsapp_provider` (preferencia) e
 * afirmava "Z-API" para a Moralles, que roda UazAPI desde a troca de canal —
 * `activate_whatsapp_channel` nao reescreve a preferencia.
 *
 * A regra de binding replica a de `whatsapp-send.ts`: se divergir, o painel
 * afirma um provedor e o envio usa outro.
 */
import { describe, expect, it } from "vitest";
import {
  resolveOrganizationWhatsAppProviders,
  resolveUnitChannelBinding,
} from "../../supabase/functions/_shared/whatsapp-org-provider-core";

describe("resolveUnitChannelBinding", () => {
  it("sem canal nenhum nao ha binding", () => {
    expect(resolveUnitChannelBinding([])).toBeNull();
    expect(resolveUnitChannelBinding(null)).toBeNull();
    expect(resolveUnitChannelBinding(undefined)).toBeNull();
  });

  it("a linha is_active=true e o binding, mesmo com outra conectada ao lado", () => {
    const binding = resolveUnitChannelBinding([
      { provider: "zapi", status: "connected", is_active: false },
      { provider: "uazapi", status: "connected", is_active: true },
    ]);
    expect(binding?.provider).toBe("uazapi");
  });

  it("canal ativo porem desconectado continua sendo o binding", () => {
    // Ele volta a enviar ao reconectar e nenhum outro pode assumir enquanto
    // existir — cair para outro provedor aqui mentiria sobre a troca.
    const binding = resolveUnitChannelBinding([
      { provider: "uazapi", status: "disconnected", is_active: true },
      { provider: "zapi", status: "connected", is_active: null },
    ]);
    expect(binding?.provider).toBe("uazapi");
  });

  it("is_active=false nunca participa, mesmo sem nenhuma linha ativa", () => {
    expect(
      resolveUnitChannelBinding([
        { provider: "zapi", status: "connected", is_active: false },
      ]),
    ).toBeNull();
  });

  it("entre linhas legadas NULL, vence a mais antiga conectada", () => {
    const binding = resolveUnitChannelBinding([
      { provider: "uazapi", status: "connected", is_active: null, created_at: "2026-05-02T00:00:00Z" },
      { provider: "zapi", status: "connected", is_active: null, created_at: "2026-05-01T00:00:00Z" },
    ]);
    expect(binding?.provider).toBe("zapi");
  });

  it("linha legada desconectada nao entra no fallback", () => {
    expect(
      resolveUnitChannelBinding([
        { provider: "zapi", status: "disconnected", is_active: null },
      ]),
    ).toBeNull();
  });

  it("linha sem provider e ignorada", () => {
    expect(
      resolveUnitChannelBinding([{ provider: null, status: "connected", is_active: true }]),
    ).toBeNull();
  });
});

describe("resolveOrganizationWhatsAppProviders", () => {
  it("o caso Moralles: canal uazapi ativo prevalece sobre a preferencia zapi", () => {
    const r = resolveOrganizationWhatsAppProviders({
      units: [
        {
          whatsapp_channels: [
            { provider: "uazapi", status: "connected", is_active: true },
          ],
        },
      ],
      defaultProvider: "zapi",
    });
    expect(r).toEqual({ providers: ["uazapi"], source: "channels" });
  });

  it("sem canal nenhum devolve a preferencia marcada como default", () => {
    const r = resolveOrganizationWhatsAppProviders({
      units: [{ whatsapp_channels: [] }],
      defaultProvider: "zapi",
    });
    expect(r).toEqual({ providers: ["zapi"], source: "default" });
  });

  it("org sem unidade tambem cai na preferencia", () => {
    expect(
      resolveOrganizationWhatsAppProviders({ units: [], defaultProvider: "uazapi" }),
    ).toEqual({ providers: ["uazapi"], source: "default" });
  });

  it("unidades com provedores distintos aparecem juntas, sem repeticao", () => {
    const r = resolveOrganizationWhatsAppProviders({
      units: [
        { whatsapp_channels: [{ provider: "uazapi", status: "connected", is_active: true }] },
        { whatsapp_channels: [{ provider: "zapi", status: "connected", is_active: true }] },
        { whatsapp_channels: [{ provider: "zapi", status: "connected", is_active: true }] },
      ],
      defaultProvider: "zapi",
    });
    expect(r).toEqual({ providers: ["uazapi", "zapi"], source: "channels" });
  });

  it("unidade sem canal nao dilui as que tem — a preferencia so entra quando NINGUEM tem", () => {
    const r = resolveOrganizationWhatsAppProviders({
      units: [
        { whatsapp_channels: [{ provider: "uazapi", status: "connected", is_active: true }] },
        { whatsapp_channels: [] },
      ],
      defaultProvider: "zapi",
    });
    expect(r).toEqual({ providers: ["uazapi"], source: "channels" });
  });

  it("preferencia ausente devolve lista vazia em vez de inventar zapi", () => {
    expect(
      resolveOrganizationWhatsAppProviders({ units: [], defaultProvider: null }),
    ).toEqual({ providers: [], source: "default" });
  });
});
