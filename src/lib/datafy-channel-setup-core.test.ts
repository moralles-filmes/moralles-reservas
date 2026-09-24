import { describe, it, expect } from "vitest";
import { decideDatafyChannelSetup, decideDatafySecretRotation } from "../../supabase/functions/_shared/datafy-channel-setup-core.ts";

const account = {
  clienteId: "cli_1", phoneNumberId: "123", wabaId: "456", businessId: "789",
};

describe("decideDatafyChannelSetup", () => {
  it("monta credenciais a partir da descoberta, sem digitação manual de id", () => {
    const verdict = decideDatafyChannelSetup({
      token: "sk_live_x", webhookSecret: "whsec_y", account,
    });
    if (verdict.ok === false) throw new Error(`esperava ok, veio ${verdict.reason}`);
    expect(verdict.credentials).toEqual({
      access_token: "sk_live_x", phone_number_id: "123", business_account_id: "456",
    });
  });

  it("recusa sem token", () => {
    for (const token of [null, "", "  "]) {
      const v = decideDatafyChannelSetup({ token, webhookSecret: "whsec_y", account });
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.reason).toBe("missing_token");
    }
  });

  // A Datafy responde 403 a webhook_configuration: o secret é colado à mão.
  // Sem ele o canal nasceria aceitando qualquer POST assinado por ninguém.
  it("exige o webhook_secret na criação, porque a Datafy não configura webhook por API", () => {
    const v = decideDatafyChannelSetup({ token: "sk_live_x", webhookSecret: null, account });
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.reason).toBe("missing_webhook_secret");
  });

  it("recusa quando a descoberta falhou, em vez de criar canal sem âncora de identidade", () => {
    const v = decideDatafyChannelSetup({ token: "sk_live_x", webhookSecret: "whsec_y", account: null });
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.reason).toBe("discovery_failed");
  });

  it("aceita waba ausente: só o phone_number_id é âncora obrigatória", () => {
    const v = decideDatafyChannelSetup({
      token: "sk_live_x", webhookSecret: "whsec_y",
      account: { ...account, wabaId: null },
    });
    if (v.ok === false) throw new Error("esperava ok");
    expect(v.credentials.business_account_id).toBeNull();
  });
});

describe("decideDatafySecretRotation", () => {
  // Gerar um hex nosso por cima do `whsec_` da Datafy faz toda entrega seguinte
  // morrer em 401 — e a mesma ação zera is_active e manual_echo_verified_at,
  // então o canal fica mudo sem erro visível. É o defeito que estes testes travam.
  it("nunca gera segredo próprio para datafy", () => {
    const r = decideDatafySecretRotation({ provider: "datafy", webhookSecret: "whsec_novo" });
    expect(r.mode).toBe("provider_issued");
    if (r.mode === "provider_issued") expect(r.secret).toBe("whsec_novo");
  });

  it("recusa rotação datafy sem o segredo novo, em vez de gerar um", () => {
    for (const secret of [null, undefined, "", "   "]) {
      const r = decideDatafySecretRotation({ provider: "datafy", webhookSecret: secret });
      expect(r.mode).toBe("refused");
    }
  });

  // Controle negativo: os três providers que EMITEM o próprio segredo continuam
  // gerando. Se alguém "simplificar" exigindo o campo de todo mundo, isto falha.
  it("mantém a geração local nos providers que emitem o próprio segredo", () => {
    for (const provider of ["zapi", "waha", "official"]) {
      expect(decideDatafySecretRotation({ provider, webhookSecret: null }).mode).toBe("generate");
      expect(decideDatafySecretRotation({ provider, webhookSecret: "whsec_x" }).mode).toBe("generate");
    }
  });
});
