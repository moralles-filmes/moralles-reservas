import { describe, expect, it } from "vitest";
import {
  SHAPE_MAX_DEPTH,
  SHAPE_MAX_KEYS,
  shapeOf,
} from "../../supabase/functions/_shared/webhook-payload-shape-core";

// Envelope real de recibo da UazAPI (observado em produção em 2026-09-19),
// preenchido com valores sensíveis DE PROPÓSITO: é isso que o webhook recebe
// cru e passa para a telemetria de payload descartado.
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const BASE_URL = "https://exemplo.uazapi.com";
const PHONE = "5514999998888";
const TEXT = "Confirmo minha reserva de sábado";

const RECEIPT_ENVELOPE = {
  BaseUrl: BASE_URL,
  EventType: "messages_update",
  type: "ReadReceipt",
  instanceName: "moralles-9dc55e51",
  owner: PHONE,
  state: "connected",
  token: TOKEN,
  event: {
    Chat: `${PHONE}@s.whatsapp.net`,
    Type: "read",
    Sender: `${PHONE}@s.whatsapp.net`,
    chatid: `${PHONE}@s.whatsapp.net`,
    IsGroup: false,
    chatlid: `${PHONE}@lid`,
    IsFromMe: false,
    Timestamp: 1_758_241_343,
    sender_pn: PHONE,
    MessageIDs: ["3EB085AB9A33BB4CE82A0C"],
    sender_lid: `${PHONE}@lid`,
    MessageSource: { Sender: `${PHONE}@s.whatsapp.net`, Text: TEXT },
  },
};

const SENSIVEIS = [TOKEN, BASE_URL, PHONE, TEXT, "3EB085AB9A33BB4CE82A0C"];

describe("shapeOf — telemetria de payload de provedor", () => {
  it("descreve a estrutura do recibo sem emitir nenhum valor", () => {
    const saida = JSON.stringify(shapeOf(RECEIPT_ENVELOPE.event));
    for (const valor of SENSIVEIS) expect(saida).not.toContain(valor);
  });

  it("preserva os NOMES de campo, que é o ponto da telemetria", () => {
    const forma = shapeOf(RECEIPT_ENVELOPE.event) as Record<string, unknown>;
    // Sem estes nomes a instrumentação não responderia por que o parser recusou.
    expect(Object.keys(forma)).toEqual(
      expect.arrayContaining(["MessageIDs", "Type", "IsFromMe", "Chat"]),
    );
    expect(forma.MessageIDs).toBe("array[1]");
    expect(forma.Type).toBe("string");
    expect(forma.IsFromMe).toBe("boolean");
    expect(forma.Timestamp).toBe("number");
  });

  it("colapsa objeto aninhado além do corte, em vez de descer nele", () => {
    const forma = shapeOf(RECEIPT_ENVELOPE.event) as Record<string, unknown>;
    // MessageSource carrega telefone e texto; nunca pode virar mapa detalhado.
    expect(forma.MessageSource).toBe("object");
  });

  it("não vaza valor nem quando o envelope inteiro é descrito", () => {
    const saida = JSON.stringify(shapeOf(RECEIPT_ENVELOPE));
    for (const valor of SENSIVEIS) expect(saida).not.toContain(valor);
    // A CHAVE `token` pode aparecer; o VALOR é que não pode.
    expect(saida).toContain("token");
  });

  it("aplica o teto de chaves em payload hostil", () => {
    const hostil: Record<string, string> = {};
    for (let i = 0; i < 200; i++) hostil[`k${i}`] = PHONE;
    const forma = shapeOf(hostil) as Record<string, unknown>;
    expect(Object.keys(forma)).toHaveLength(SHAPE_MAX_KEYS);
    expect(JSON.stringify(forma)).not.toContain(PHONE);
  });

  it("trata primitivos e nulos sem devolvê-los", () => {
    expect(shapeOf(PHONE)).toBe("string");
    expect(shapeOf(42)).toBe("number");
    expect(shapeOf(null)).toBe("object");
    expect(shapeOf(undefined)).toBe("undefined");
  });

  // A profundidade NÃO é a garantia contra vazamento de valor: as folhas
  // continuam virando `typeof` em qualquer nível. Ela limita a exposição de
  // NOMES de chave (ver o teste seguinte) e o tamanho da saída. Este teste
  // fixa esse entendimento — foi um controle positivo mal formulado que o
  // revelou, e sem ele a próxima pessoa reaprende do mesmo jeito.
  it("profundidade maior não vazaria valor — ela limita nomes de chave, não conteúdo", () => {
    const maisFundo = (value: unknown, depth = 0): unknown => {
      if (Array.isArray(value)) return `array[${value.length}]`;
      if (value && typeof value === "object") {
        if (depth >= SHAPE_MAX_DEPTH + 1) return "object";
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value).slice(0, SHAPE_MAX_KEYS)) {
          out[k] = maisFundo(v, depth + 1);
        }
        return out;
      }
      return typeof value;
    };
    const saida = JSON.stringify(maisFundo(RECEIPT_ENVELOPE.event));
    for (const valor of SENSIVEIS) expect(saida).not.toContain(valor);
  });

  // O vetor que a profundidade REALMENTE limita: chave é emitida como nome.
  // Um mapa indexado por telefone vaza pela chave, não pelo valor — por isso o
  // chamador só pode passar objeto de esquema conhecido.
  it("emite NOMES de chave, então mapa indexado por dado vazaria pela chave", () => {
    const mapaPorTelefone = { [PHONE]: { ultimaLeitura: 1 } };
    expect(JSON.stringify(shapeOf(mapaPorTelefone))).toContain(PHONE);
    // O corte impede que isso aconteça em níveis mais fundos do payload.
    expect(JSON.stringify(shapeOf({ envelope: mapaPorTelefone }))).not.toContain(PHONE);
  });

  // CONTROLE POSITIVO — sem isto, os `not.toContain` acima passariam mesmo se
  // fossem incapazes de falhar. Aqui o defeito real é reintroduzido de
  // propósito: a folha devolvendo o VALOR em vez do `typeof`, que é a
  // "melhoria" de quem está depurando. O vazamento DEVE aparecer.
  it("controle positivo: folha devolvendo valor vaza telefone, texto e credencial", () => {
    const vazante = (value: unknown, depth = 0): unknown => {
      if (Array.isArray(value)) return `array[${value.length}]`;
      if (value && typeof value === "object") {
        if (depth >= SHAPE_MAX_DEPTH) return "object";
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value).slice(0, SHAPE_MAX_KEYS)) {
          out[k] = vazante(v, depth + 1);
        }
        return out;
      }
      return String(value); // ← o defeito
    };

    const vazado = JSON.stringify(vazante(RECEIPT_ENVELOPE));
    const seguro = JSON.stringify(shapeOf(RECEIPT_ENVELOPE));

    // A cópia quebrada publica credencial e telefone...
    expect(vazado).toContain(TOKEN);
    expect(vazado).toContain(PHONE);
    // ...enquanto a de produção, com o mesmo payload, não publica nenhum.
    for (const valor of SENSIVEIS) expect(seguro).not.toContain(valor);
  });
});
