import { describe, expect, it } from "vitest";
import { composeAgentSystemPrompt, type AgentPromptParts } from "../../supabase/functions/_shared/agent/system-prompt";
import { GLOBAL_PERSONA_BASELINE } from "../../supabase/functions/_shared/agent/global-prompt-core";

// Falha de leitura de giftback falha fechado: "não sei, a equipe confirma",
// nunca "não há promoção" (que negaria desconto existente ao cliente).
const parts = (over: Partial<AgentPromptParts> = {}): AgentPromptParts => ({
  includeFaq: true, agentName: "Yumi", restaurantName: "Exemplo", globalPromptBody: GLOBAL_PERSONA_BASELINE,
  identityLine: "ID.", todayBR: "segunda-feira, 05/10/2026", weekdayName: "segunda-feira", upcomingDaysLines: [],
  customerFirstName: "", formattingRules: "FORMATACAO", channelLabel: "WhatsApp", channelRules: "", unitAddress: "",
  restaurantInfoLines: [], hallScheduleBlock: null, hoursLines: [], specialLines: [], blockedLines: [],
  giftbackLines: [], prefsLines: [], customPrompt: "", settingsMap: {},
  ...over,
});

const NEGA = "esta unidade NÃO tem nenhuma regra automática";
const NAO_CONSULTOU_REGRAS = "NÃO foi possível consultar agora as regras de desconto desta unidade";
const NAO_CONSULTOU_VOUCHERS = "Vouchers deste cliente: NÃO foi possível consultar agora";

describe("Programa Giftback com falha de leitura", () => {
  it("sem flags: texto de sempre (sem regras → nega; com regras → lista)", () => {
    expect(composeAgentSystemPrompt(parts())).toContain(NEGA);
    const com = composeAgentSystemPrompt(parts({ giftbackLines: ["- Aniversariantes ganham voucher de 10%"] }));
    expect(com).toContain("Programa Giftback (regras automáticas ativas):\n- Aniversariantes ganham voucher de 10%");
    expect(com).not.toContain("NÃO foi possível consultar");
  });

  it("falha nas regras: não nega e manda a equipe confirmar", () => {
    const p = composeAgentSystemPrompt(parts({ giftbackRulesReadFailed: true }));
    expect(p).toContain(NAO_CONSULTOU_REGRAS);
    expect(p).toContain("a equipe do restaurante confirma");
    expect(p).not.toContain(NEGA);
  });

  it("falha nas regras e nos vouchers: um bloco só, citando os dois", () => {
    const p = composeAgentSystemPrompt(parts({ giftbackRulesReadFailed: true, customerVouchersReadFailed: true }));
    expect(p).toContain(`${NAO_CONSULTOU_REGRAS} nem os vouchers deste cliente`);
    expect(p).not.toContain(NAO_CONSULTOU_VOUCHERS);
    expect(p).not.toContain(NEGA);
  });

  it("falha só nos vouchers: regras listadas + aviso de não negar voucher", () => {
    const p = composeAgentSystemPrompt(parts({
      giftbackLines: ["- A cada 5 visitas o cliente ganha voucher de 15%"], customerVouchersReadFailed: true,
    }));
    expect(p).toContain("- A cada 5 visitas o cliente ganha voucher de 15%");
    expect(p).toContain(NAO_CONSULTOU_VOUCHERS);
    expect(p).toContain("NÃO diga que não tem");
  });

  it("falha só nos vouchers sem regras: o 'não há' vem com a ressalva do voucher", () => {
    const p = composeAgentSystemPrompt(parts({ customerVouchersReadFailed: true }));
    expect(p).toContain(NAO_CONSULTOU_VOUCHERS);
  });
});
