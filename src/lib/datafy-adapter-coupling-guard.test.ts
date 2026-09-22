import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  META_SHAPED_PROVIDERS,
  PROVIDER_CAPABILITIES,
  WEBHOOK_SIGNATURE_SCHEME,
  WHATSAPP_PROVIDER_NAMES,
  isMetaShapedProvider,
} from "../../supabase/functions/_shared/whatsapp-provider-core.ts";
import type { WhatsAppProviderAdapter } from "../../supabase/functions/_shared/whatsapp-provider-core.ts";

// NÃO troque por `import { tryGetWhatsAppProvider } from ".../whatsapp-providers.ts"`.
// Medido na Task 1: o import direto passa no vitest mas puxa o arquivo para o
// grafo do `tsc -b` do frontend e quebra o typecheck com 6 erros — o global
// `Deno` não existe ali, e o próprio arquivo carrega um TS2339 latente. O glob
// carrega os adapters reais em runtime sem entrar no grafo de tipos.
// Mesmo padrão de `src/lib/whatsapp-capability-guard.test.ts`.
const FACADE = "../../supabase/functions/_shared/whatsapp-providers.ts";
const modules = import.meta.glob<{
  tryGetWhatsAppProvider(name: string): WhatsAppProviderAdapter | null;
}>("../../supabase/functions/_shared/whatsapp-providers.ts", { eager: true });
const { tryGetWhatsAppProvider } = modules[FACADE];

const WEBHOOK = readFileSync(
  resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"),
  "utf8",
);

describe("datafy é Meta-shaped e reusa os parsers official", () => {
  it("todo nome do registry tem adapter", () => {
    for (const name of WHATSAPP_PROVIDER_NAMES) {
      expect(tryGetWhatsAppProvider(name), `sem adapter: ${name}`).not.toBeNull();
    }
  });

  it("o conjunto Meta-shaped contém official e datafy, e só eles", () => {
    expect([...META_SHAPED_PROVIDERS].sort()).toEqual(["datafy", "official"]);
    expect(isMetaShapedProvider("datafy")).toBe(true);
    expect(isMetaShapedProvider("zapi")).toBe(false);
    expect(isMetaShapedProvider("inexistente")).toBe(false);
  });

  it("datafy usa exatamente as mesmas funções de parse que official", () => {
    const datafy = tryGetWhatsAppProvider("datafy");
    const official = tryGetWhatsAppProvider("official");
    if (!datafy || !official) throw new Error("adapters ausentes");
    expect(datafy.parseInbound).toBe(official.parseInbound);
    expect(datafy.parseStatusCallback).toBe(official.parseStatusCallback);
    expect(datafy.parseOwnMessageEchoes).toBe(official.parseOwnMessageEchoes);
    expect(datafy.peekInboundMedia).toBe(official.peekInboundMedia);
  });

  it("datafy declara as capabilities que a Fase A+B realmente entrega", () => {
    const caps = PROVIDER_CAPABILITIES.datafy;
    expect(caps.manualCredentials).toBe(true);
    expect(caps.deliveryReceipts).toBe(true);
    expect(caps.adReferral).toBe(true);
    expect(caps.rawCloudApiProxy).toBe(true);
    expect(caps.qrConnection).toBe(false);
    expect(caps.automaticWebhook).toBe(false); // Datafy bloqueia webhook_configuration (403)
    expect(caps.manualDeviceEcho).toBe("conditional"); // só em coexistência
    // Ainda não implementados — Fases E e F.
    expect(caps.templateMessages).toBe(false);
    expect(caps.mediaMessages).toBe(false);
    expect(caps.interactiveMessages).toBe(false);
    expect(caps.inboundMediaDownload).toBe(false);
  });

  // O defeito real: um caminho do webhook que ficou perguntando só por "official".
  it("o webhook não decide forma de payload comparando com a string official", () => {
    const comparacoesCruas = WEBHOOK.match(/provider\s*===\s*"official"/g) ?? [];
    expect(
      comparacoesCruas,
      "use isMetaShapedProvider(provider); comparar com a string deixa datafy de fora em silêncio",
    ).toEqual([]);
  });

  it("o webhook usa o helper em vez da string", () => {
    expect(WEBHOOK).toContain("isMetaShapedProvider(provider)");
  });

  // Review Focus 3: o HMAC prova QUEM enviou, não PARA QUAL canal. Sem a guarda
  // de identidade, um callback legitimamente assinado por outro número do mesmo
  // cliente Datafy seria encaminhado ao channel_id errado — e atravessaria tenants.
  // metaPayloadMatchesChannel não é exportado, então a cobertura aqui é estrutural.
  it("a guarda de identidade por phone_number_id cobre todo provider Meta-shaped", () => {
    expect(WEBHOOK).toMatch(
      /isMetaShapedProvider\(provider\)\s*&&\s*!metaPayloadMatchesChannel\(/,
    );
  });

  it("todo provider tem esquema de assinatura declarado, e datafy não usa o da Meta", () => {
    for (const name of WHATSAPP_PROVIDER_NAMES) {
      expect(WEBHOOK_SIGNATURE_SCHEME[name], `sem esquema: ${name}`).toBeDefined();
    }
    expect(WEBHOOK_SIGNATURE_SCHEME.official).toBe("meta_app_secret");
    expect(WEBHOOK_SIGNATURE_SCHEME.datafy).toBe("datafy_whsec");
    expect(WEBHOOK_SIGNATURE_SCHEME.zapi).toBe("channel_secret");
  });

  it("o webhook ramifica a assinatura pelo mapa, não por string", () => {
    expect(WEBHOOK).toContain("WEBHOOK_SIGNATURE_SCHEME[provider]");
  });

  it("o re-dispatch de lote apaga as assinaturas dos DOIS esquemas", () => {
    const bloco = WEBHOOK.slice(WEBHOOK.indexOf("splitMetaWebhookPayload(payload)"));
    expect(bloco).toContain('headers.delete("x-hub-signature-256")');
    expect(bloco).toContain('headers.delete("x-datafy-signature-256")');
  });
});
