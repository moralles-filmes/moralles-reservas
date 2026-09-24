import { afterEach, describe, it, expect, vi } from "vitest";
import { normalizeBrPhone, canonicalBrPhone, validateBrPhone, isValidBrPhone } from "./phone";
import {
  canonicalBrPhone as backendCanonicalBrPhone,
  toE164BrPhone,
} from "../../supabase/functions/_shared/phone.ts";
import {
  WHATSAPP_PROVIDER_NAMES,
  type WhatsAppProviderAdapter,
  type WhatsAppProviderName,
} from "../../supabase/functions/_shared/whatsapp-provider-core.ts";

// Executa os adapters reais sem incluir os globals Deno no typecheck do frontend.
const providerModules = import.meta.glob<{
  getWhatsAppProvider(name: string): WhatsAppProviderAdapter;
}>("../../supabase/functions/_shared/whatsapp-providers.ts", { eager: true });
const { getWhatsAppProvider } = providerModules["../../supabase/functions/_shared/whatsapp-providers.ts"];

const outboundPhones = [
  ["55999998888", "5555999998888"], // DDD 55, celular canônico
  ["5533334444", "555533334444"], // DDD 55, fixo canônico
  ["(55) 99999-8888", "5555999998888"],
  ["(55) 3333-4444", "555533334444"],
  ["+55 (55) 99999-8888", "5555999998888"],
  ["+55 (55) 3333-4444", "555533334444"],
  ["11999998888", "5511999998888"],
  ["1133334444", "551133334444"],
  ["(43) 99133-6361", "5543991336361"],
  ["+55 (11) 99999-8888", "5511999998888"],
  ["+55 (11) 3333-4444", "551133334444"],
  // HERDADO, não desejado: celular de 10 dígitos sai sem o 9º e o WhatsApp não
  // entrega. Idêntico ao comportamento antigo e inalcançável pelo caminho real
  // (`customers.phone` é canônico por trigger, e `validateBrPhone` recusa no form),
  // então corrigir aqui seria mudar escopo. O inverso de verdade, se um dia for
  // preciso, é `toE164BrPhone(canonicalBrPhone(x))`.
  ["4391336361", "554391336361"],
  ["554391336361", "554391336361"],
] as const;

describe("toE164BrPhone", () => {
  it.each(outboundPhones)("converts %s to %s without changing subscriber digits", (raw, expected) => {
    expect(toE164BrPhone(raw)).toBe(expected);
    expect(toE164BrPhone(expected)).toBe(expected);
  });

  it.each(["55999998888", "5533334444", "11999998888", "1133334444"])(
    "round-trips canonical %s through both storage normalizers",
    (phone) => {
      expect(backendCanonicalBrPhone(toE164BrPhone(phone))).toBe(phone);
      expect(canonicalBrPhone(toE164BrPhone(phone))).toBe(phone);
    },
  );

  it("positive control: the old predicate fails both DDD 55 regression fixtures", () => {
    for (const [raw, expected] of outboundPhones.slice(0, 2)) {
      const digits = raw.replace(/\D/g, "");
      const oldDestination = digits.startsWith("55") ? digits : `55${digits}`;
      expect(oldDestination).not.toBe(expected);
      expect(toE164BrPhone(raw)).toBe(expected);
    }
  });
});

// A lista vem do registry, nunca redigitada: provider novo entra aqui sozinho e,
// sem payload esperado abaixo, reprova no `tsc -b` em vez de passar por omissão.
// É o que sustenta a afirmação do CLAUDE.md de que NENHUM adapter guarda regra
// própria de prefixo — sem isso, a invariante valeria por confiança, não por medição.
describe.each(WHATSAPP_PROVIDER_NAMES)("%s outbound destination", (provider) => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(outboundPhones)("posts %s as %s", async (raw, expected) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "test-message" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await getWhatsAppProvider(provider).sendText({
      instance_id: "test-instance",
      token: "test-token",
      base_url: "https://provider.example.test",
      instance_token: "test-instance-token",
      phone_number_id: "test-phone-id",
      access_token: "test-access-token",
    }, { toPhone: raw, text: "Mensagem de teste" });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    const expectedPayloads: Record<WhatsAppProviderName, unknown> = {
      zapi: { phone: expected, message: "Mensagem de teste" },
      uazapi: { number: expected, text: "Mensagem de teste" },
      waha: { session: "default", chatId: `${expected}@c.us`, text: "Mensagem de teste" },
      official: { messaging_product: "whatsapp", to: expected, type: "text", text: { body: "Mensagem de teste" } },
      datafy: { messaging_product: "whatsapp", recipient_type: "individual", to: expected, type: "text", text: { body: "Mensagem de teste" } },
    };
    expect(body).toEqual(expectedPayloads[provider]);
  });
});

describe("normalizeBrPhone", () => {
  it("strips non-digits", () => {
    expect(normalizeBrPhone("(11) 99999-8888")).toBe("11999998888");
  });
  it("removes country code 55 from 12/13-digit numbers", () => {
    expect(normalizeBrPhone("5511999998888")).toBe("11999998888"); // 13
    expect(normalizeBrPhone("551133334444")).toBe("1133334444"); // 12
  });
  it("keeps 55 when it is the DDD (11 digits, not a country prefix)", () => {
    expect(normalizeBrPhone("55999998888")).toBe("55999998888"); // DDD 55 (RS)
  });
  it("handles null/undefined", () => {
    expect(normalizeBrPhone(null)).toBe("");
    expect(normalizeBrPhone(undefined)).toBe("");
  });
});

describe("canonicalBrPhone", () => {
  it("adds the 9th digit to a 10-digit mobile (the dup bug)", () => {
    expect(canonicalBrPhone("4391336361")).toBe("43991336361");
    expect(canonicalBrPhone("(43) 9133-6361")).toBe("43991336361");
  });
  it("keeps an 11-digit mobile unchanged", () => {
    expect(canonicalBrPhone("43991336361")).toBe("43991336361");
    expect(canonicalBrPhone("(43) 99133-6361")).toBe("43991336361");
  });
  it("strips country code 55 then canonicalizes", () => {
    expect(canonicalBrPhone("554391336361")).toBe("43991336361"); // 12 díg, sem o 9
    expect(canonicalBrPhone("5543991336361")).toBe("43991336361"); // 13 díg, com o 9
  });
  it("leaves a 10-digit landline untouched (3rd digit 2-5)", () => {
    expect(canonicalBrPhone("4330251234")).toBe("4330251234");
  });
  it("does not touch the DDD 55 (RS) 11-digit number", () => {
    expect(canonicalBrPhone("55999998888")).toBe("55999998888");
  });
  it("handles empty/short input", () => {
    expect(canonicalBrPhone(null)).toBe("");
    expect(canonicalBrPhone(undefined)).toBe("");
    expect(canonicalBrPhone("123")).toBe("123");
  });
});

describe("validateBrPhone", () => {
  it("accepts valid 11-digit mobile", () => {
    expect(validateBrPhone("11999998888").valid).toBe(true);
    expect(validateBrPhone("(11) 99999-8888").valid).toBe(true);
  });
  it("accepts valid 10-digit landline", () => {
    expect(validateBrPhone("1133334444").valid).toBe(true);
  });
  it("accepts number with country code 55", () => {
    expect(validateBrPhone("5511999998888").valid).toBe(true);
    expect(validateBrPhone("5511999998888").digits).toBe("11999998888");
  });
  it("rejects invalid DDD (the real bug: 12-digit starting 01)", () => {
    const r = validateBrPhone("019999999999");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("inválido");
  });
  it("rejects DDD not in the official list", () => {
    expect(validateBrPhone("20999998888").valid).toBe(false); // 20 inválido
    expect(validateBrPhone("00999998888").valid).toBe(false);
  });
  it("rejects 10-digit mobile missing the 9", () => {
    expect(validateBrPhone("1199999888").valid).toBe(false); // 10 díg começando 9
  });
  it("rejects 11-digit whose 3rd digit is not 9", () => {
    expect(validateBrPhone("11333344445").valid).toBe(false);
  });
  it("rejects wrong length", () => {
    expect(validateBrPhone("119999").valid).toBe(false);
    expect(validateBrPhone("119999988887777").valid).toBe(false);
  });
  it("rejects all-same digits", () => {
    expect(validateBrPhone("11111111111").valid).toBe(false);
  });
  it("respects allowEmpty", () => {
    expect(validateBrPhone("", { allowEmpty: true }).valid).toBe(true);
    expect(validateBrPhone("", { allowEmpty: false }).valid).toBe(false);
    expect(validateBrPhone("").valid).toBe(false); // default: required
  });
  it("returns normalized digits on success", () => {
    expect(validateBrPhone("(11) 99999-8888").digits).toBe("11999998888");
  });
});

describe("isValidBrPhone", () => {
  it("is a boolean shortcut", () => {
    expect(isValidBrPhone("11999998888")).toBe(true);
    expect(isValidBrPhone("019999999999")).toBe(false);
  });
});
