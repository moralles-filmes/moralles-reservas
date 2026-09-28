import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REQUIRED_METHOD,
  PROVIDER_CAPABILITIES,
  WHATSAPP_PROVIDER_NAMES,
  type WhatsAppProviderAdapter,
} from "../../supabase/functions/_shared/whatsapp-provider-core";

// Carrega os adapters reais pelo Vite sem incluir módulos Deno no projeto tsc
// do frontend. Nenhum método de rede ou de leitura de credenciais é executado.
const modules = import.meta.glob<{
  getWhatsAppProvider(name: string): WhatsAppProviderAdapter;
}>("../../supabase/functions/_shared/whatsapp-providers.ts", { eager: true });
const { getWhatsAppProvider } = modules["../../supabase/functions/_shared/whatsapp-providers.ts"];

function missingCapabilityMethods(adapter: WhatsAppProviderAdapter): string[] {
  return Object.entries(CAPABILITY_REQUIRED_METHOD)
    .filter(([capability, method]) =>
      adapter.capabilities[capability] === true && typeof adapter[method] !== "function"
    )
    .map(([capability, method]) => `${adapter.name}.${capability} → ${method}`);
}

// Direção 2: método presente exige capability `true`. É o que impede um adapter
// legado de ganhar a leitura do referral sem declarar a capability.
function undeclaredCapabilityMethods(adapter: WhatsAppProviderAdapter): string[] {
  return Object.entries(CAPABILITY_REQUIRED_METHOD)
    .filter(([capability, method]) =>
      typeof adapter[method] === "function" && adapter.capabilities[capability] !== true
    )
    .map(([capability, method]) => `${adapter.name}.${method} sem ${capability}`);
}

describe("capability ⇔ método no adapter, nas duas direções", () => {
  it("mapeia rawCloudApiProxy ao método opcional cloudApiRequest", () => {
    expect(CAPABILITY_REQUIRED_METHOD.rawCloudApiProxy).toBe("cloudApiRequest");
  });

  it("mapeia adReferral ao método opcional parseAdReferral", () => {
    expect(CAPABILITY_REQUIRED_METHOD.adReferral).toBe("parseAdReferral");
  });

  it.each(WHATSAPP_PROVIDER_NAMES)("valida o adapter real de %s", (name) => {
    const adapter = getWhatsAppProvider(name);
    expect(adapter.capabilities).toEqual(PROVIDER_CAPABILITIES[name]);
    expect(missingCapabilityMethods(adapter)).toEqual([]);
    expect(undeclaredCapabilityMethods(adapter)).toEqual([]);
  });

  it("CONTROLE POSITIVO: detecta capability habilitada sem método", () => {
    const adapter: WhatsAppProviderAdapter = {
      ...getWhatsAppProvider("official"),
      capabilities: { ...PROVIDER_CAPABILITIES.official, rawCloudApiProxy: true },
      cloudApiRequest: undefined,
    };
    expect(missingCapabilityMethods(adapter)).toEqual([
      "official.rawCloudApiProxy → cloudApiRequest",
    ]);

    adapter.cloudApiRequest = async () => ({ status: 200, body: {} });
    expect(missingCapabilityMethods(adapter)).toEqual([]);
  });

  it("não aceita propriedade não chamável como implementação", () => {
    const adapter = {
      ...getWhatsAppProvider("official"),
      capabilities: { ...PROVIDER_CAPABILITIES.official, rawCloudApiProxy: true },
      cloudApiRequest: true,
    } as unknown as WhatsAppProviderAdapter;
    expect(missingCapabilityMethods(adapter)).toEqual([
      "official.rawCloudApiProxy → cloudApiRequest",
    ]);
  });

  it("CONTROLE POSITIVO (direção 1): adReferral declarada sem parseAdReferral reprova", () => {
    const adapter: WhatsAppProviderAdapter = {
      ...getWhatsAppProvider("official"),
      parseAdReferral: undefined,
    };
    expect(missingCapabilityMethods(adapter)).toEqual([
      "official.adReferral → parseAdReferral",
    ]);
  });

  it("CONTROLE POSITIVO (direção 2): adapter legado com parseAdReferral e sem a capability reprova", () => {
    const adapter: WhatsAppProviderAdapter = {
      ...getWhatsAppProvider("zapi"),
      parseAdReferral: () => null,
    };
    expect(undeclaredCapabilityMethods(adapter)).toEqual(["zapi.parseAdReferral sem adReferral"]);

    adapter.capabilities = { ...PROVIDER_CAPABILITIES.zapi, adReferral: true };
    expect(undeclaredCapabilityMethods(adapter)).toEqual([]);
  });

  it("CONTROLE POSITIVO (direção 2): cloudApiRequest sem rawCloudApiProxy reprova", () => {
    const adapter: WhatsAppProviderAdapter = {
      ...getWhatsAppProvider("waha"),
      cloudApiRequest: async () => ({ status: 200, body: {} }),
    };
    expect(undeclaredCapabilityMethods(adapter)).toEqual(["waha.cloudApiRequest sem rawCloudApiProxy"]);
  });
});
