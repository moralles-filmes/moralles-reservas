import { describe, it, expect } from "vitest";
import {
  declaredProviderIdentityMatchesChannel,
  manualEchoMatchesConfiguredChannel,
  metaPayloadMatchesChannel,
} from "../../supabase/functions/_shared/whatsapp-echo-identity-core";
import { parseUazApiOwnMessageEcho } from "../../supabase/functions/_shared/whatsapp-provider-core";

const INSTANCE_TOKEN = "tok-instancia-exemplo-0123456789abcdef";

// Chaves de topo MEDIDAS em produção (instrumentação de forma, 30/09/2026):
// BaseUrl, EventType, chat, chatSource, instanceName, message, owner, token.
// Valores fictícios — nenhum telefone, id ou token real.
function uazApiEcho(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BaseUrl: "https://exemplo.uazapi.com",
    EventType: "messages",
    chat: {},
    chatSource: "",
    instanceName: "instancia-exemplo",
    message: {
      chatid: "5511988887777@s.whatsapp.net",
      fromMe: true,
      wasSentByApi: false,
      isGroup: false,
      messageid: "3EB0AAAAAAAAAAAAAAAAAA",
      text: "Sua mesa está confirmada.",
      messageTimestamp: Date.UTC(2026, 0, 15, 12, 0, 0),
    },
    owner: "5511900001111",
    token: INSTANCE_TOKEN,
    ...overrides,
  };
}

const uazCreds = { instance_token: INSTANCE_TOKEN };

function metaBatch(...ids: string[]) {
  return { entry: [{ changes: ids.map((id) => ({ value: { metadata: { phone_number_id: id } } })) }] };
}

describe("manualEchoMatchesConfiguredChannel — UazAPI", () => {
  it("o envelope medido é eco do aparelho para o parser de produção e não traz as âncoras antigas", () => {
    // Amarra a fixture ao parser real: é exatamente este payload que chegava à
    // guarda e era recusado com 401.
    expect(parseUazApiOwnMessageEcho(uazApiEcho())?.source).toBe("manual_device");
    for (const anchor of ["instanceId", "instance_id", "instance"]) {
      expect(Object.keys(uazApiEcho())).not.toContain(anchor);
    }
  });

  it("casa quando o token do envelope é o token da instância do canal", () => {
    expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho(), uazCreds)).toBe(true);
  });

  it("não casa sem token, com token vazio ou com token que não é string", () => {
    for (const token of [undefined, null, "", 123, { value: INSTANCE_TOKEN }, [INSTANCE_TOKEN]]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho({ token }), uazCreds)).toBe(false);
    }
  });

  // Review Focus 2: sem trim, sem prefixo.
  it("não casa com token de outra instância, nem com prefixo, extensão ou espaço do token certo", () => {
    // Mesmo tamanho do token certo: só o CONTEÚDO distingue, então comparar tamanho não basta.
    const outra = "tok-instancia-OUTRA-0123456789abcdefgh";
    expect(outra.length).toBe(INSTANCE_TOKEN.length);
    const ultimoTrocado = INSTANCE_TOKEN.slice(0, -1) + (INSTANCE_TOKEN.endsWith("0") ? "1" : "0");
    expect(ultimoTrocado.length).toBe(INSTANCE_TOKEN.length);
    for (const token of [
      outra,
      ultimoTrocado,
      INSTANCE_TOKEN.slice(0, -1),
      `${INSTANCE_TOKEN}x`,
      ` ${INSTANCE_TOKEN}`,
    ]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho({ token }), uazCreds)).toBe(false);
    }
  });

  // Review Focus 1: vazio contra vazio não pode ser "igual".
  it("não casa quando o canal não tem token de instância resolvido", () => {
    for (const creds of [{}, { instance_token: "" }]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho(), creds)).toBe(false);
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho({ token: "" }), creds)).toBe(false);
    }
  });

  // Review Focus 3: a âncora antiga, sozinha, não prova mais nada.
  it("instanceId no payload sem token não basta", () => {
    const payload = uazApiEcho({ token: undefined, instanceId: "inst-1", instance: { id: "inst-1" } });
    expect(manualEchoMatchesConfiguredChannel("uazapi", payload, uazCreds)).toBe(false);
  });

  it("payload que não é objeto não casa", () => {
    for (const payload of [null, undefined, "x", 1]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", payload, uazCreds)).toBe(false);
    }
  });
});

describe("manualEchoMatchesConfiguredChannel — Z-API, WAHA e Meta (regra inalterada)", () => {
  it("Z-API casa pelo instanceId na raiz ou aninhado em payload, com trim", () => {
    const creds = { instance_id: "inst-1" };
    expect(manualEchoMatchesConfiguredChannel("zapi", { instanceId: "inst-1" }, creds)).toBe(true);
    expect(manualEchoMatchesConfiguredChannel("zapi", { instance_id: " inst-1 " }, creds)).toBe(true);
    expect(manualEchoMatchesConfiguredChannel("zapi", { payload: { instanceId: "inst-1" } }, creds)).toBe(true);
  });

  it("Z-API não casa com instância divergente, ausente ou canal sem instance_id", () => {
    const creds = { instance_id: "inst-1" };
    expect(manualEchoMatchesConfiguredChannel("zapi", { instanceId: "inst-2" }, creds)).toBe(false);
    expect(manualEchoMatchesConfiguredChannel("zapi", { fromMe: true }, creds)).toBe(false);
    expect(manualEchoMatchesConfiguredChannel("zapi", { instanceId: "inst-1" }, {})).toBe(false);
  });

  it("WAHA casa pela session, com 'default' quando o canal não define session_name", () => {
    expect(manualEchoMatchesConfiguredChannel("waha", { session: "default" }, {})).toBe(true);
    expect(manualEchoMatchesConfiguredChannel("waha", { session: "loja" }, { session_name: "loja" })).toBe(true);
    expect(
      manualEchoMatchesConfiguredChannel("waha", { payload: { session: "loja" } }, { session_name: "loja" }),
    ).toBe(true);
  });

  it("WAHA não casa com session divergente ou ausente", () => {
    expect(manualEchoMatchesConfiguredChannel("waha", { session: "outra" }, { session_name: "loja" })).toBe(false);
    expect(manualEchoMatchesConfiguredChannel("waha", {}, {})).toBe(false);
  });

  it.each(["official", "datafy"] as const)(
    "%s casa só quando todo change declara o phone_number_id do canal",
    (provider) => {
      const creds = { phone_number_id: "111" };
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111"), creds)).toBe(true);
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111", "111"), creds)).toBe(true);
      // Review Focus 4: lote misturando outro número do mesmo app.
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111", "222"), creds)).toBe(false);
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch(), creds)).toBe(false);
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111"), {})).toBe(false);
    },
  );
});

describe("metaPayloadMatchesChannel", () => {
  it("ignora espaços no phone_number_id e recusa payload sem entry", () => {
    expect(metaPayloadMatchesChannel(metaBatch(" 111 "), { phone_number_id: "111" })).toBe(true);
    expect(metaPayloadMatchesChannel({}, { phone_number_id: "111" })).toBe(false);
    expect(metaPayloadMatchesChannel(null, { phone_number_id: "111" })).toBe(false);
  });
});

describe("declaredProviderIdentityMatchesChannel", () => {
  it("Z-API e WAHA: ausência de identidade declarada passa, divergência não", () => {
    expect(declaredProviderIdentityMatchesChannel("zapi", { fromMe: false }, { instance_id: "inst-1" })).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("zapi", { instanceId: "inst-1" }, { instance_id: "inst-1" })).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("zapi", { instanceId: "inst-2" }, { instance_id: "inst-1" })).toBe(false);
    expect(declaredProviderIdentityMatchesChannel("waha", {}, {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("waha", { session: "default" }, {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("waha", { session: "outra" }, { session_name: "loja" })).toBe(false);
  });

  it("demais providers e payload que não é objeto passam (as âncoras deles são outras guardas)", () => {
    expect(declaredProviderIdentityMatchesChannel("uazapi", uazApiEcho({ token: "qualquer" }), {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("official", {}, {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("zapi", null, { instance_id: "inst-1" })).toBe(true);
  });
});
