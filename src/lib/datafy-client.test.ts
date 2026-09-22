import { describe, it, expect } from "vitest";
import {
  DATAFY_BASE_URL,
  buildDatafyRequest,
  classifyDatafyStatus,
  parseDatafyAccount,
  pickDatafyMessageId,
} from "../../supabase/functions/_shared/datafy-client";

describe("buildDatafyRequest", () => {
  it("monta URL absoluta e Bearer a partir do path relativo", () => {
    const { url, init } = buildDatafyRequest({ token: "sk_live_x", method: "GET", path: "me" });
    expect(url).toBe(`${DATAFY_BASE_URL}/me`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_x");
    expect(init.body).toBeUndefined();
  });

  it("aceita path com barra inicial sem duplicar", () => {
    expect(buildDatafyRequest({ token: "t", method: "GET", path: "/v1/123/messages" }).url)
      .toBe(`${DATAFY_BASE_URL}/v1/123/messages`);
  });

  it("serializa corpo e declara Content-Type só quando há corpo", () => {
    const { init } = buildDatafyRequest({
      token: "t", method: "POST", path: "v1/1/messages", body: { a: 1 },
    });
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("nunca coloca o token na URL", () => {
    const { url } = buildDatafyRequest({ token: "sk_live_segredo", method: "GET", path: "me" });
    expect(url).not.toContain("sk_live_segredo");
  });
});

describe("classifyDatafyStatus", () => {
  it("mapeia os códigos próprios da Datafy", () => {
    expect(classifyDatafyStatus(401)).toBe("AUTH_ERROR");
    expect(classifyDatafyStatus(402)).toBe("AUTH_ERROR");
    expect(classifyDatafyStatus(403)).toBe("AUTH_ERROR");
    expect(classifyDatafyStatus(429)).toBe("RATE_LIMITED");
    expect(classifyDatafyStatus(404)).toBe("INSTANCE_NOT_FOUND");
    expect(classifyDatafyStatus(400)).toBe("INVALID_REQUEST");
    expect(classifyDatafyStatus(422)).toBe("INVALID_REQUEST");
    expect(classifyDatafyStatus(500)).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyDatafyStatus(503)).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyDatafyStatus(418)).toBe("UNKNOWN_PROVIDER_ERROR");
  });

  it("devolve null em 2xx", () => {
    expect(classifyDatafyStatus(200)).toBeNull();
    expect(classifyDatafyStatus(201)).toBeNull();
  });
});

describe("parseDatafyAccount", () => {
  it("extrai os quatro ids do /me", () => {
    expect(parseDatafyAccount({
      cliente_id: "cli_123",
      phone_number_id: "123456789012345",
      waba_id: "234567890123456",
      business_id: "345678901234567",
    })).toEqual({
      clienteId: "cli_123",
      phoneNumberId: "123456789012345",
      wabaId: "234567890123456",
      businessId: "345678901234567",
    });
  });

  it("devolve null para corpo que não é objeto", () => {
    for (const body of [null, undefined, "x", 1, []]) {
      expect(parseDatafyAccount(body)).toBeNull();
    }
  });

  it("devolve null quando falta o phone_number_id, que é o que identifica o canal", () => {
    expect(parseDatafyAccount({ cliente_id: "cli_1", waba_id: "w" })).toBeNull();
  });

  it("tolera campos extras e ausência dos opcionais", () => {
    expect(parseDatafyAccount({ phone_number_id: "1", novidade: true })).toEqual({
      clienteId: null, phoneNumberId: "1", wabaId: null, businessId: null,
    });
  });
});

describe("pickDatafyMessageId", () => {
  it("extrai o wamid da resposta de envio", () => {
    expect(pickDatafyMessageId({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.HBgNNTUxMTk5", message_status: "accepted" }],
    })).toBe("wamid.HBgNNTUxMTk5");
  });

  // Review Focus 5: 200 sem id quebraria o rastreio em silêncio.
  it("devolve undefined quando o 200 não traz id, em vez de inventar", () => {
    for (const body of [{}, { messages: [] }, { messages: [{}] }, { messages: [{ id: "" }] }, null]) {
      expect(pickDatafyMessageId(body)).toBeUndefined();
    }
  });
});
