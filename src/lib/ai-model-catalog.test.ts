import { describe, expect, it } from "vitest";
import {
  AI_MODEL_CATALOG,
  activeModelsFor,
  defaultModelFor,
  getModelEntry,
  resolveModel,
  type AIModelEntry,
  type AIProvider,
} from "../../supabase/functions/_shared/ai-model-catalog";

const PROVIDERS: readonly AIProvider[] = ["claude", "openai", "gemini", "grok", "deepseek"];

/**
 * Invariantes do catálogo como detector puro: devolve uma frase por violação.
 * O mesmo detector valida o catálogo real e os catálogos sintéticos do controle
 * positivo, então "vazio no real" só vale porque o detector enxerga o defeito.
 */
function catalogViolations(entries: readonly AIModelEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.provider}/${e.id}`;
    if (seen.has(key)) out.push(`id duplicado: ${key}`);
    seen.add(key);
  }
  for (const p of PROVIDERS) {
    const defaults = entries.filter((e) => e.provider === p && e.status === "active" && e.role === "default");
    if (defaults.length !== 1) out.push(`${p}: esperado 1 default ativo, achou ${defaults.length}`);
  }
  for (const e of entries) {
    const key = `${e.provider}/${e.id}`;
    if (e.status === "retired") {
      const succ = entries.find((x) => x.provider === e.provider && x.id === e.successor);
      if (!e.successor) out.push(`${key}: aposentado sem successor`);
      else if (!succ || succ.status !== "active") out.push(`${key}: successor não é ativo do mesmo provider`);
      else if (succ.role !== e.role) out.push(`${key}: successor de papel diferente (${e.role} → ${succ.role})`);
      if (e.requestProfile !== "retired") out.push(`${key}: aposentado deve usar requestProfile "retired"`);
    } else {
      if (e.successor) out.push(`${key}: ativo não pode ter successor`);
      if (e.requestProfile === "retired") out.push(`${key}: ativo não pode usar requestProfile "retired"`);
    }
    if (e.sameProviderFallback) {
      const fb = entries.find((x) => x.provider === e.provider && x.id === e.sameProviderFallback);
      if (!fb || fb.status !== "active") out.push(`${key}: sameProviderFallback não é ativo do mesmo provider`);
    }
  }
  return out;
}

const entry = (over: Partial<AIModelEntry>): AIModelEntry => ({
  provider: "gemini",
  id: "x",
  label: "X",
  status: "active",
  role: "default",
  capabilities: { vision: true, reasoning: "none" },
  requestProfile: "gemini-2.5",
  verifiedInProduction: false,
  ...over,
});

/** Catálogo mínimo válido para os 5 providers, base dos sintéticos. */
const validBase = (): AIModelEntry[] => PROVIDERS.map((p) => entry({ provider: p, id: `${p}-ok` }));

describe("AI_MODEL_CATALOG", () => {
  it("não tem violação de invariante (ids únicos, um default, sucessores, perfis, fallback)", () => {
    expect(catalogViolations(AI_MODEL_CATALOG)).toEqual([]);
  });

  it("cobre os 5 providers com ao menos um modelo ativo", () => {
    for (const p of PROVIDERS) expect(activeModelsFor(p).length).toBeGreaterThan(0);
  });

  it("fallback do mesmo provider existe só no Gemini 2.5: Flash → Pro, e Pro → ele mesmo", () => {
    // Pro → Pro preserva o comportamento de antes do catálogo: com o Pro como
    // principal, a resposta vazia ganha UMA re-tentativa no próprio Pro (a lista
    // de tentativas pós-5xx ignora o fallback igual ao ativo).
    const pairs = AI_MODEL_CATALOG.filter((e) => e.sameProviderFallback).map((e) => `${e.id}→${e.sameProviderFallback}`);
    expect(pairs).toEqual(["gemini-2.5-flash→gemini-2.5-pro", "gemini-2.5-pro→gemini-2.5-pro"]);
  });

  it("a lista de ids é exatamente a do plano §8.1 (deepseek-v4-pro e Pro 3.x preview ficaram de fora)", () => {
    expect(AI_MODEL_CATALOG.map((e) => `${e.provider}/${e.id}:${e.status}`).sort()).toEqual(
      [
        "gemini/gemini-2.5-flash:active",
        "gemini/gemini-2.5-pro:active",
        "gemini/gemini-3.8-flash:active",
        "gemini/gemini-3.5-flash-lite:active",
        "claude/claude-haiku-5-5:active",
        "claude/claude-sonnet-5-5:active",
        "claude/claude-haiku-4-5:retired",
        "claude/claude-sonnet-4-6:retired",
        "openai/gpt-6-luna:active",
        "openai/gpt-5.6-sol:active",
        "openai/gpt-4o:retired",
        "openai/gpt-4o-mini:retired",
        "grok/grok-4.20-0309-non-reasoning:active",
        "grok/grok-4.3:active",
        "grok/grok-3:retired",
        "deepseek/deepseek-flash:active",
        "deepseek/deepseek-chat:retired",
      ].sort(),
    );
  });

  it("só os dois Gemini 2.5 estão verificados em produção", () => {
    const verified = AI_MODEL_CATALOG.filter((e) => e.verifiedInProduction).map((e) => e.id).sort();
    expect(verified).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
  });

  it("o default do Gemini é gemini-2.5-flash (D5)", () => {
    expect(defaultModelFor("gemini").id).toBe("gemini-2.5-flash");
  });

  it("activeModelsFor devolve só ativos, default primeiro", () => {
    for (const p of PROVIDERS) {
      const list = activeModelsFor(p);
      expect(list[0].id).toBe(defaultModelFor(p).id);
      expect(list.every((e) => e.status === "active" && e.provider === p)).toBe(true);
    }
    expect(activeModelsFor("claude").map((e) => e.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });

  it("getModelEntry acha por provider + id e não cruza providers", () => {
    expect(getModelEntry("gemini", "gemini-2.5-pro")?.role).toBe("strong");
    expect(getModelEntry("claude", "gemini-2.5-pro")).toBeUndefined();
    expect(getModelEntry("gemini", "nao-existe")).toBeUndefined();
  });
});

describe("catalogViolations (controle positivo do detector)", () => {
  it("catálogo sintético válido passa", () => {
    expect(catalogViolations(validBase())).toEqual([]);
  });

  it("dois defaults ativos no mesmo provider é violação", () => {
    const bad = [...validBase(), entry({ provider: "gemini", id: "gemini-outro", role: "default" })];
    expect(catalogViolations(bad)).toContain("gemini: esperado 1 default ativo, achou 2");
  });

  it("provider sem default ativo é violação", () => {
    const bad = validBase().filter((e) => e.provider !== "grok");
    expect(catalogViolations(bad)).toContain("grok: esperado 1 default ativo, achou 0");
  });

  it("aposentado sem successor é violação", () => {
    const bad = [
      ...validBase(),
      entry({ provider: "claude", id: "claude-velho", status: "retired", requestProfile: "retired" }),
    ];
    expect(catalogViolations(bad)).toContain("claude/claude-velho: aposentado sem successor");
  });

  it("successor de outro papel, aposentado ou de outro provider é violação", () => {
    const base = validBase();
    const retired = entry({
      provider: "claude",
      id: "a",
      status: "retired",
      requestProfile: "retired",
      successor: "claude-ok",
    });
    const strong = entry({ provider: "claude", id: "claude-strong", role: "strong" });
    expect(catalogViolations([...base, strong, { ...retired, successor: "claude-strong" }]).join("|")).toContain(
      "successor de papel diferente",
    );
    expect(catalogViolations([...base, retired, { ...retired, id: "c", successor: "a" }]).join("|")).toContain(
      "claude/c: successor não é ativo",
    );
    expect(catalogViolations([...base, { ...retired, successor: "gemini-ok" }]).join("|")).toContain(
      "claude/a: successor não é ativo",
    );
  });

  it("ativo com successor, ativo com perfil retired e aposentado com perfil real são violações", () => {
    const base = validBase();
    expect(catalogViolations([...base, entry({ id: "g2", role: "light", successor: "gemini-ok" })]).join("|")).toContain(
      "ativo não pode ter successor",
    );
    expect(
      catalogViolations([...base, entry({ id: "g3", role: "light", requestProfile: "retired" })]).join("|"),
    ).toContain('ativo não pode usar requestProfile "retired"');
    const r = entry({ id: "g4", status: "retired", successor: "gemini-ok" });
    expect(catalogViolations([...base, r]).join("|")).toContain('aposentado deve usar requestProfile "retired"');
  });

  it("sameProviderFallback apontando para inexistente é violação", () => {
    const bad = validBase().map((e) => (e.provider === "gemini" ? { ...e, sameProviderFallback: "fantasma" } : e));
    expect(catalogViolations(bad).join("|")).toContain("sameProviderFallback não é ativo");
  });

  it("id duplicado no mesmo provider é violação", () => {
    const bad = [...validBase(), entry({ provider: "gemini", id: "gemini-ok", role: "light" })];
    expect(catalogViolations(bad)).toContain("id duplicado: gemini/gemini-ok");
  });
});

describe("resolveModel", () => {
  it("modelo salvo ativo é mantido (saved)", () => {
    expect(resolveModel("gemini", "gemini-2.5-pro")).toEqual({ model: "gemini-2.5-pro", reason: "saved" });
  });

  it("espaços em volta de id válido são aparados", () => {
    expect(resolveModel("gemini", "  gemini-2.5-pro ")).toEqual({ model: "gemini-2.5-pro", reason: "saved" });
  });

  it("vazio, undefined, null ou só espaços caem no default sem rejected", () => {
    for (const v of [undefined, null, "", "   "]) {
      expect(resolveModel("gemini", v)).toEqual({ model: "gemini-2.5-flash", reason: "default" });
    }
  });

  it("aposentado vira o sucessor e registra o rejeitado", () => {
    expect(resolveModel("claude", "claude-haiku-4-5")).toEqual({
      model: "claude-haiku-5-5",
      reason: "retired_successor",
      rejected: "claude-haiku-4-5",
    });
    expect(resolveModel("claude", " claude-sonnet-4-6 ")).toEqual({
      model: "claude-sonnet-5-5",
      reason: "retired_successor",
      rejected: "claude-sonnet-4-6",
    });
  });

  it("id desconhecido cai no default e registra o rejeitado", () => {
    expect(resolveModel("gemini", "gemini-2.0-flash")).toEqual({
      model: "gemini-2.5-flash",
      reason: "unknown_default",
      rejected: "gemini-2.0-flash",
    });
  });

  it("id de outro provider é desconhecido para este", () => {
    expect(resolveModel("claude", "gpt-6-luna")).toEqual({
      model: "claude-haiku-5-5",
      reason: "unknown_default",
      rejected: "gpt-6-luna",
    });
  });

  it("todo aposentado do catálogo resolve para um ativo do mesmo provider", () => {
    for (const e of AI_MODEL_CATALOG.filter((x) => x.status === "retired")) {
      const r = resolveModel(e.provider, e.id);
      expect(r.reason).toBe("retired_successor");
      expect(getModelEntry(e.provider, r.model)?.status).toBe("active");
    }
  });
});
