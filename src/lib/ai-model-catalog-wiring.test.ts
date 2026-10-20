import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_MODEL_CATALOG, activeModelsFor } from "../../supabase/functions/_shared/ai-model-catalog";
import { AI_PROVIDER_ORDER, DEFAULT_MODEL_BY_PROVIDER, MODELS_BY_PROVIDER } from "./aiModels";

/** Literal de id de modelo entre aspas: o catálogo é o único lugar onde ele pode viver. */
const MODEL_ID_LITERAL = /["'`](claude|gpt|gemini|grok|deepseek)-/;

describe("aiModels.ts é só derivação do catálogo", () => {
  it("não contém literal de id de modelo", () => {
    const src = readFileSync(resolve(__dirname, "aiModels.ts"), "utf8");
    expect(src).not.toMatch(MODEL_ID_LITERAL);
  });

  it("controle positivo: o regex pega literal de id e ignora fonte sem ele", () => {
    expect(`const m = "gemini-2.5-flash";`).toMatch(MODEL_ID_LITERAL);
    expect(`const m = 'claude-haiku-5-5';`).toMatch(MODEL_ID_LITERAL);
    expect("const m = `gpt-6-luna`;").toMatch(MODEL_ID_LITERAL);
    expect(`const m = AI_MODEL_CATALOG.filter((e) => e.status === "active");`).not.toMatch(MODEL_ID_LITERAL);
  });

  it("MODELS_BY_PROVIDER lista os ativos do catálogo, default primeiro", () => {
    expect(MODELS_BY_PROVIDER.gemini.map((o) => o.value)).toEqual(activeModelsFor("gemini").map((e) => e.id));
    expect(MODELS_BY_PROVIDER.gemini[0].value).toBe("gemini-2.5-flash");
    for (const p of AI_PROVIDER_ORDER) {
      expect(MODELS_BY_PROVIDER[p].map((o) => o.value)).toEqual(activeModelsFor(p).map((e) => e.id));
      expect(DEFAULT_MODEL_BY_PROVIDER[p]).toBe(MODELS_BY_PROVIDER[p][0].value);
    }
  });

  it("aposentados não aparecem nas opções da UI", () => {
    const shown = new Set(AI_PROVIDER_ORDER.flatMap((p) => MODELS_BY_PROVIDER[p].map((o) => o.value)));
    for (const retired of ["claude-haiku-4-5", "grok-3"]) expect(shown.has(retired)).toBe(false);
    for (const e of AI_MODEL_CATALOG.filter((x) => x.status === "retired")) expect(shown.has(e.id)).toBe(false);
  });
});

// ─── Runner e turno ligados ao catálogo e aos perfis (B1.3–B1.5) ────────────
//
// O vitest não importa `ai-providers.ts` (SDK via esm.sh) nem o turno (Deno), então
// a ligação é presa pela FONTE. Cada guarda tem controle positivo sobre fonte
// sintética: um detector que não reprova nada não prova nada.

const SHARED = resolve(__dirname, "..", "..", "supabase", "functions", "_shared");
const read = (...p: string[]) => readFileSync(resolve(SHARED, ...p), "utf8").replace(/\r\n/g, "\n");

/** Tira comentários de bloco e de linha (o `//` de `https://` fica: vem depois de `:`). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1");
}

/** Do cabeçalho da função de topo até o `}` na coluna zero. */
function fn(src: string, name: string): string {
  const m = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m").exec(src);
  if (!m) throw new Error(`função ${name} não encontrada`);
  const end = src.indexOf("\n}\n", m.index);
  return src.slice(m.index, end === -1 ? src.length : end + 3);
}

/** O builder `activeCredentials` do turno, até o `;` que fecha a cadeia. */
function activeCredentialsHelper(src: string): string {
  const i = src.indexOf("const activeCredentials =");
  if (i === -1) throw new Error("activeCredentials não encontrado");
  return src.slice(i, src.indexOf(";", i) + 1);
}

/** Filtros que a leitura de credencial não pode perder: tabela, unidade, provider e ativa. */
function credentialFilterViolations(helper: string): string[] {
  const required: Array<[string, RegExp]> = [
    ["from", /\.from\("ai_provider_credentials"\)/],
    ["unit_id", /\.eq\("unit_id", unitId\)/],
    ["provider", /\.eq\("provider", provider\)/],
    ["active", /\.eq\("active", true\)/],
  ];
  return required.filter(([, re]) => !re.test(helper)).map(([name]) => name);
}

const LIMIT_OR_REASONING_LITERAL =
  /\bmax_tokens\s*:|\bmax_completion_tokens\b|\bmaxOutputTokens\s*:|\bthinkingBudget\b|\bthinkingLevel\b|\breasoning_effort\b/;

describe("o runner manda o que o núcleo de perfis devolve (B1.3)", () => {
  const providers = read("ai-providers.ts");

  it("fora do núcleo, ai-providers.ts não monta limite nem raciocínio", () => {
    expect(code(providers)).not.toMatch(LIMIT_OR_REASONING_LITERAL);
  });

  it("CONTROLE POSITIVO: o detector pega limite e raciocínio escritos à mão, e ignora comentário", () => {
    for (const s of [
      "body: { max_tokens: 1024 }",
      "{ max_completion_tokens: 1024 }",
      "generationConfig: { maxOutputTokens: 3072 }",
      "thinkingConfig: { thinkingBudget: 1024 }",
      `{ reasoning_effort: "none" }`,
    ]) {
      expect(code(s), s).toMatch(LIMIT_OR_REASONING_LITERAL);
    }
    expect(code("// o perfil manda `max_completion_tokens`\nconst x = 1;")).not.toMatch(LIMIT_OR_REASONING_LITERAL);
  });

  it("os três runners pegam os parâmetros do perfil do modelo, e o corpo os espalha", () => {
    expect(providers).toContain(
      `import { requestParamsFor, type AIRequestParams } from "./ai-request-profile-core.ts"`,
    );
    const helper = fn(providers, "requestParamsForModel");
    expect(helper).toMatch(/getModelEntry\(provider, model\)/);
    expect(helper).toMatch(/requestParamsFor\(entry\.requestProfile\)/);
    expect(helper, "modelo fora do catálogo tem de falhar, não cair num limite padrão").toMatch(/throw new Error/);

    const claude = fn(providers, "runClaude");
    expect(claude).toMatch(/requestParamsForModel\("claude", model\)/);
    expect(claude).toMatch(/\.\.\.params\.body,/);

    const compat = fn(providers, "runOpenAICompatible");
    expect(compat).toMatch(/requestParamsForModel\(opts\.provider, model\)/);
    expect(compat).toMatch(/\.\.\.params\.body,/);

    const gemini = fn(providers, "runGemini");
    // Perfil do modelo ATIVO, recalculado a cada iteração (o empty-retry troca o modelo).
    expect(gemini).toMatch(/requestParamsForModel\("gemini", activeModel\)/);
    expect(gemini).toMatch(/generationConfig: params\.generationConfig/);
  });

  it("o default do loop vem do catálogo", () => {
    expect(fn(providers, "runAgentLoop")).toMatch(/opts\.model \|\| defaultModelFor\(opts\.provider\)\.id/);
  });
});

describe("Flash→Pro condicional ligado (B1.4)", () => {
  const providers = read("ai-providers.ts");
  const turn = read("agent", "turn.ts");

  it("o runner não tem mais tabela de fallback; o Gemini PERGUNTA ao chamador, na hora, nos três caminhos", () => {
    expect(providers).not.toContain("FALLBACK_MODELS");
    expect(providers).toMatch(/sameProviderFallbackModel: \(\) => string \| null;/);
    const gemini = code(fn(providers, "runGemini"));
    // 5xx e timeout: a lista nasce só com o ativo e ganha o fallback depois da
    // falha da 1ª tentativa — a pergunta é feita nessa hora.
    expect(gemini).toMatch(/const attemptModels = \[activeModel\];/);
    const onFailure = gemini.slice(gemini.indexOf("lastError = err;"));
    expect(onFailure.slice(0, onFailure.indexOf("throw err;"))).toMatch(
      /if \(a === 0 && shouldTryGeminiFallback\(err\)\) \{\s*const fallbackModel = opts\.sameProviderFallbackModel\(\);\s*if \(fallbackModel && fallbackModel !== activeModel\) attemptModels\.push\(fallbackModel\);/,
    );
    // Vazio: o empty-retry pergunta de novo.
    expect(gemini).toMatch(/const fallbackModel = emptyRetried \? null : opts\.sameProviderFallbackModel\(\);/);
    expect(gemini).toMatch(/if \(!emptyRetried && fallbackModel\)/);
    expect(gemini).toMatch(/activeModel = fallbackModel;/);
    // Nenhuma decisão de fallback guardada antes do laço.
    expect(gemini.slice(0, gemini.indexOf("while (iterations-- > 0)"))).not.toMatch(/sameProviderFallbackModel/);
  });

  it("o turno decide por alvo, com a existência da chave do reserva e o alcance dele no momento", () => {
    expect(turn).toMatch(/decideSameProviderFallback,\n\s*parseFallbackConfig,/);
    expect(turn).toMatch(/\? await hasActiveApiKey\(fallbackConfig\.provider, unitId\)/);
    const decl = turn.slice(turn.indexOf("const sameProviderFallbackFor"));
    const call = decl.slice(0, decl.indexOf("});") + 3);
    expect(call).toMatch(/entry: getModelEntry\(target\.provider, target\.model\)/);
    expect(call).toMatch(/reserve: target === primaryTarget \? fallbackConfig : null,/);
    expect(call).toMatch(/reserveHasActiveKey: target === primaryTarget && reserveHasActiveKey,/);
    expect(call).toMatch(/reserveStillUsable: target === primaryTarget && reserveStillUsable\(\),/);
    // O alcance usa as MESMAS travas do retry silencioso.
    const reach = turn.slice(turn.indexOf("const reserveStillUsable"));
    expect(reach.slice(0, reach.indexOf(";"))).toMatch(
      /currentAttempt === 0 && !mutatingToolUsed && Date\.now\(\) - t0 < AGENT_RETRY_BUDGET_MS/,
    );
    expect(turn).toMatch(/for \(let attempt = 0; attempt <= 1; attempt\+\+\) \{\n\s*currentAttempt = attempt;/);
    expect(turn).toMatch(/sameProviderFallbackModel: sameProviderFallbackFor\(agentTarget\),/);
  });

  it("CONTROLE POSITIVO: alcance do reserva sem a trava de mutação reprova", () => {
    const sintetico = "const reserveStillUsable = (): boolean =>\n  currentAttempt === 0 && Date.now() - t0 < AGENT_RETRY_BUDGET_MS;";
    const reach = sintetico.slice(sintetico.indexOf("const reserveStillUsable"));
    expect(reach.slice(0, reach.indexOf(";"))).not.toMatch(
      /currentAttempt === 0 && !mutatingToolUsed && Date\.now\(\) - t0 < AGENT_RETRY_BUDGET_MS/,
    );
  });

  it("a chave vem antes da resolução do modelo: provider inválido cai no handoff de sempre", () => {
    const key = turn.indexOf("apiKey = await resolveApiKey(provider_ai, unitId);");
    const model = turn.indexOf("const modelResolved = resolveModel(provider_ai, rawModel);");
    expect(key).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(key);
  });

  it("a leitura da chave do reserva é só existência, da própria unidade, e erro não vira 'tem reserva'", () => {
    const i = turn.indexOf("async function hasActiveApiKey");
    expect(i).toBeGreaterThan(-1);
    const body = turn.slice(i, turn.indexOf("\n  }\n", i) + 4);
    expect(body).toMatch(/activeCredentials\(provider, unitId, "id"\)\.limit\(1\)/);
    expect(body, "o valor da chave não é lido aqui").not.toMatch(/api_key/);
    expect(body).toMatch(/if \(error\) return false;/);
    expect(credentialFilterViolations(activeCredentialsHelper(turn))).toEqual([]);
  });

  it("CONTROLE POSITIVO: o filtro de credencial sem a unidade ou sem 'active' reprova", () => {
    const helper = activeCredentialsHelper(turn);
    expect(credentialFilterViolations(helper.replace('.eq("unit_id", unitId)', ""))).toEqual(["unit_id"]);
    expect(credentialFilterViolations(helper.replace('.eq("active", true)', ""))).toEqual(["active"]);
  });

  it("CONTROLE POSITIVO: um runner com tabela própria de fallback reprova", () => {
    const sintetico = "async function runGemini(opts, model) {\n  const fallbackModel = FALLBACK_MODELS.gemini;\n}\n";
    expect(fn(sintetico, "runGemini")).not.toMatch(/const fallbackModel = opts\.sameProviderFallbackModel;/);
  });
});

describe("modelo resolvido em franquia e telemetria (B1.5, D6)", () => {
  const turn = read("agent", "turn.ts");
  const turnCode = code(turn);

  it("resolveModel é o do catálogo, para o principal e para o reserva", () => {
    expect(turn).toContain(`import { getModelEntry, resolveModel } from "../ai-model-catalog.ts";`);
    expect(turnCode).toMatch(/const modelResolved = resolveModel\(provider_ai, rawModel\);/);
    expect(turnCode).toMatch(/const modelOverride: string = modelResolved\.model;/);
    expect(turnCode).toMatch(/\? resolveModel\(fallbackConfig\.provider, fallbackConfig\.model\)/);
    expect(turnCode, "sobrou a forma antiga do resolvedor").not.toMatch(/\.fellBack\b/);
  });

  it("aposentado loga ai_model_retired (provider, saved, used); desconhecido segue em ai_model_fallback", () => {
    const retired = [...turnCode.matchAll(/evt: "ai_model_retired",([\s\S]*?)\}\);/g)].map((m) => m[1]);
    expect(retired.length, "principal e reserva").toBe(2);
    for (const r of retired) {
      expect(r).toMatch(/provider:/);
      expect(r).toMatch(/saved: \w+\.rejected/);
      expect(r).toMatch(/used:/);
    }
    expect(turnCode).toMatch(/modelResolved\.reason === "retired_successor"/);
    expect(turnCode).toMatch(/modelResolved\.reason === "unknown_default"/);
    expect([...turnCode.matchAll(/evt: "ai_model_fallback"/g)].length).toBe(2);
  });

  it("franquia, alvo do turno, agent_usage e handoff usam o modelo RESOLVIDO", () => {
    const open = turnCode.slice(turnCode.indexOf("openTurnBudget(supabase, {"));
    expect(open.slice(0, open.indexOf("});"))).toMatch(/model: modelOverride,/);
    expect(turnCode).toMatch(
      /const primaryTarget: AgentTarget = \{ provider: provider_ai, apiKey, model: modelOverride \};/,
    );
    expect(turnCode).toMatch(/model: fallbackModelResolved\.model \}/);
    expect(turnCode).toMatch(/const usedModel = agentTarget\.model;/);
    expect(turnCode).toMatch(/`agent_error:\$\{usedProvider\}:\$\{usedModel\}`/);
    // O valor salvo cru nunca chega a franquia nem a telemetria.
    expect(turnCode.slice(turnCode.indexOf("const modelResolved"))).not.toMatch(/model: rawModel/);
  });

  it("CONTROLE POSITIVO: franquia aberta com o modelo salvo cru reprova", () => {
    const sintetico = "openTurnBudget(supabase, {\n  provider: provider_ai,\n  model: rawModel,\n});";
    const open = sintetico.slice(sintetico.indexOf("openTurnBudget(supabase, {"));
    expect(open.slice(0, open.indexOf("});"))).not.toMatch(/model: modelOverride,/);
  });
});

describe("aba IA da unidade ligada ao catálogo (B1.6)", () => {
  const automacao = readFileSync(resolve(__dirname, "..", "pages", "gestao", "Automacao.tsx"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const NOTICE_MAIN = /<SavedModelNotice provider=\{aiConfig\.provider\} saved=\{savedModel\} \/>/;
  const NOTICE_FALLBACK = /<SavedModelNotice provider=\{savedFallback\.provider\} saved=\{fallbackSavedModel\} \/>/;

  it("os dois seletores (principal e reserva) mostram o aviso do valor salvo", () => {
    expect(automacao).toMatch(NOTICE_MAIN);
    expect(automacao).toMatch(NOTICE_FALLBACK);
  });

  it("as opções vêm só dos ativos do catálogo (MODELS_BY_PROVIDER), sem lista própria", () => {
    expect(automacao).toMatch(/MODELS_BY_PROVIDER\[aiConfig\.provider\]/);
    expect(automacao).toMatch(/MODELS_BY_PROVIDER\[savedFallback\.provider\]/);
    expect(automacao, "a tela voltou a ter literal de id de modelo").not.toMatch(MODEL_ID_LITERAL);
  });

  it("CONTROLE POSITIVO: um seletor sem o aviso reprova", () => {
    const sintetico = automacao.replace(NOTICE_FALLBACK, "");
    expect(sintetico).not.toMatch(NOTICE_FALLBACK);
  });
});
