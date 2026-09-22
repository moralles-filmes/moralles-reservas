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

describe("capability declarada exige método no adapter", () => {
  it("mapeia rawCloudApiProxy ao método opcional cloudApiRequest", () => {
    expect(CAPABILITY_REQUIRED_METHOD.rawCloudApiProxy).toBe("cloudApiRequest");
  });

  it.each(WHATSAPP_PROVIDER_NAMES)("valida o adapter real de %s", (name) => {
    const adapter = getWhatsAppProvider(name);
    expect(adapter.capabilities).toEqual(PROVIDER_CAPABILITIES[name]);
    expect(missingCapabilityMethods(adapter)).toEqual([]);
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
});
