import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guardas de ACOPLAMENTO do provedor reserva no turno do `webhook-whatsapp`.
 *
 * A decisão (que erro troca de provedor, que config vale) mora em
 * `agent-provider-fallback-core.ts` e é testada lá. Aqui ficam só as amarras
 * que existem no `index.ts`, que o vitest não importa (chama `serve()` e
 * importa `deno.land`): o laço pergunta ao núcleo, a chave do reserva é BYOK da
 * própria unidade, e as travas do retry silencioso continuam valendo para ele.
 *
 * Fim de linha normalizado na leitura — mesma razão de
 * `whatsapp-inbound-reentry.test.ts` (checkout com `core.autocrlf=true`).
 */
const EF = readFileSync(
  resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

/** Fatia de `inicio` até a chave que fecha o primeiro `{` depois dele. */
function blocoDe(ancora: string): string {
  const inicio = EF.indexOf(ancora);
  expect(inicio, `âncora sumiu: ${ancora}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = EF.indexOf("{", inicio); i < EF.length; i++) {
    if (EF[i] === "{") depth++;
    else if (EF[i] === "}") {
      depth--;
      if (depth === 0) return EF.slice(inicio, i + 1);
    }
  }
  throw new Error(`chaves desbalanceadas a partir de ${ancora}`);
}

/** Condição completa do `if (` mais próximo ANTES de `marco`. */
function condicaoAntesDe(trecho: string, marco: string): string {
  const m = trecho.indexOf(marco);
  expect(m, `marco sumiu: ${marco}`).toBeGreaterThan(-1);
  const abre = trecho.lastIndexOf("if (", m);
  expect(abre).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = trecho.indexOf("(", abre); i < trecho.length; i++) {
    if (trecho[i] === "(") depth++;
    else if (trecho[i] === ")") {
      depth--;
      if (depth === 0) return trecho.slice(abre, i + 1);
    }
  }
  throw new Error("parênteses desbalanceados");
}

const LACO = blocoDe("for (let attempt = 0; attempt <= 1; attempt++)");
const TROCA = blocoDe("const switchToFallback = async");

describe("provedor reserva — ligação no turno do webhook", () => {
  it("a config vem do núcleo, contra o provedor principal da unidade", () => {
    expect(EF).toMatch(/parseFallbackConfig\(aiConfig,\s*provider_ai\)/);
    // O modelo do reserva passa pela mesma blindagem do principal.
    expect(EF).toMatch(/resolveModel\(fallbackConfig\.provider,\s*fallbackConfig\.model\)/);
  });

  it("o erro só troca de provedor pela pergunta ao núcleo, dentro do retry silencioso", () => {
    const retry = blocoDe(condicaoAntesDe(LACO, 'evt: "agent_retry"'));
    expect(retry, "o laço não consulta o núcleo").toContain("shouldUseFallbackProvider(err)");
    expect(retry, "a troca não passa pela função única").toContain("switchToFallback(");
    // As travas do retry continuam na condição que envolve a troca.
    const cond = condicaoAntesDe(LACO, 'evt: "agent_retry"');
    expect(cond).toContain("attempt === 0");
    expect(cond).toContain("!agentDeadlineReached");
    expect(cond).toContain("!mutatingToolUsed");
    expect(cond).toContain("AGENT_RETRY_BUDGET_MS");
  });

  it("resposta vazia só troca de provedor com reserva, sem mutação e dentro do tempo", () => {
    const cond = condicaoAntesDe(LACO, 'switchToFallback("empty_response")');
    expect(cond).toContain("attempt === 0");
    expect(cond).toContain("fallbackConfig");
    expect(cond).toContain("!mutatingToolUsed");
    expect(cond).toContain("AGENT_RETRY_BUDGET_MS");
    expect(cond).toMatch(/!agentOutcome\.text\.trim\(\)/);
  });

  it("CONTROLE POSITIVO: sem a trava de mutação a guarda acima reprova", () => {
    const cond = condicaoAntesDe(LACO, 'switchToFallback("empty_response")');
    const mutilada = cond.replace(/&&\s*!mutatingToolUsed/, "");
    expect(mutilada, "a cirurgia do controle não achou a trava").not.toBe(cond);
    expect(mutilada).not.toContain("!mutatingToolUsed");
  });

  it("a chave do reserva é BYOK da própria unidade, nunca de Deno.env", () => {
    expect(TROCA).toContain("resolveApiKey(fallbackConfig.provider, unitId)");
    expect(TROCA).not.toContain("Deno.env");
    expect(blocoDe("async function resolveApiKey("), "resolveApiKey ganhou fallback global").not.toContain(
      "Deno.env",
    );
    // Sem chave: loga e segue o retry atual no principal (não troca o alvo).
    expect(TROCA).toContain('evt: "fallback_unavailable"');
    expect(TROCA).toContain('evt: "agent_provider_fallback"');
  });

  it("o turno roda no alvo da vez, e o desfecho registra quem respondeu", () => {
    const runOnce = EF.slice(EF.indexOf("const runOnce = () => runAgentLoop("));
    const cabeca = runOnce.slice(0, runOnce.indexOf("systemPrompt"));
    expect(cabeca).toContain("provider: agentTarget.provider");
    expect(cabeca).toContain("apiKey: agentTarget.apiKey");
    expect(cabeca).toContain("model: agentTarget.model");
    expect(EF).toMatch(/agent_error:\$\{usedProvider\}:\$\{usedModel\}/);
    expect(EF).toMatch(/agent_deadline:\$\{usedProvider\}:\$\{usedModel\}/);
  });
});
