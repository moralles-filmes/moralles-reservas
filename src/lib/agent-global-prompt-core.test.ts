import { describe, expect, it } from "vitest";
import {
  CONTROL_CHAR_CLASS,
  GLOBAL_PERSONA_BASELINE,
  GLOBAL_PROMPT_BASELINE_VERSION,
  GLOBAL_PROMPT_CACHE_TTL_MS,
  GLOBAL_PROMPT_MAX_CHARS,
  freshCachedGlobalPrompt,
  isValidGlobalPromptBody,
  renderGlobalLayer,
  resolveGlobalPrompt,
  type GlobalPromptCacheEntry,
} from "../../supabase/functions/_shared/agent/global-prompt-core";

/**
 * Núcleo puro da camada global do prompt (spec Entrega B §4.2, §8; plano B3
 * passo A): render, validação gêmea do CHECK SQL e decisão da fonte (D7).
 */

describe("renderGlobalLayer: substituição literal dos 2 placeholders", () => {
  it("o baseline renderizado é o trecho atual do prompt, com os nomes nos 4 lugares", () => {
    const out = renderGlobalLayer(GLOBAL_PERSONA_BASELINE, { agentName: "Sakura", restaurantName: "Exemplo Sushi" });
    expect(out.startsWith("IDENTIDADE: Você se chama Sakura e atende como parte da equipe do Exemplo Sushi — ")).toBe(true);
    expect(out).toContain('(ex: "Sou a Sakura, faço o atendimento virtual do Exemplo Sushi e quando precisar');
    expect(out).not.toMatch(/\{\{|\}\}/);
    expect(out.endsWith("Evite excesso de emojis. ")).toBe(true);
  });

  it("sem template engine: padrões de replace e placeholders dentro do valor ficam literais", () => {
    const body = "A {{agent_name}} B {{restaurant_name}} C {{agent_name}}";
    expect(renderGlobalLayer(body, { agentName: "$& $1 $$", restaurantName: "{{agent_name}}" }))
      .toBe("A $& $1 $$ B {{agent_name}} C $& $1 $$");
  });

  it("texto sem placeholder volta igual", () => {
    expect(renderGlobalLayer("Seja breve. ", { agentName: "x", restaurantName: "y" })).toBe("Seja breve. ");
  });
});

describe("isValidGlobalPromptBody: gêmea de app_private.ai_prompt_body_valid (casos do P4/P4b)", () => {
  const recusados: Array<[string, unknown]> = [
    ["vazio", ""],
    ["só brancos", "  \n\t  "],
    ["4001 caracteres", "a".repeat(4001)],
    ["placeholder desconhecido", "ola {{x}}"],
    ["placeholder aberto", "ola {{agent_name}"],
    ["}} solto", "ola }} fim"],
    ["placeholder com espaço", "ola {{ agent_name }}"],
    ["<<<", "abre <<< aqui"],
    [">>>", "fecha >>> aqui"],
    ["\\x07", "sino \x07 aqui"],
    ["\\r", "cr \r aqui"],
    ["DEL", "del \x7f aqui"],
    ["NUL", "nul \u0000 aqui"],
    ["nulo", null],
    ["não string", 42],
  ];
  for (const [nome, body] of recusados) {
    it(`recusa: ${nome}`, () => expect(isValidGlobalPromptBody(body)).toBe(false));
  }

  it("aceita a borda: 4000 com \\t, \\n e os dois placeholders", () => {
    const head = "x\t{{agent_name}}\n{{restaurant_name}} ";
    const body = head + "a".repeat(GLOBAL_PROMPT_MAX_CHARS - head.length);
    expect(body.length).toBe(GLOBAL_PROMPT_MAX_CHARS);
    expect(isValidGlobalPromptBody(body)).toBe(true);
  });

  it("conta caracteres como o char_length do Postgres (code points, não UTF-16)", () => {
    const emoji = "🍣".repeat(GLOBAL_PROMPT_MAX_CHARS);
    expect(emoji.length).toBe(GLOBAL_PROMPT_MAX_CHARS * 2);
    expect(isValidGlobalPromptBody(emoji)).toBe(true);
    expect(isValidGlobalPromptBody(emoji + "🍣")).toBe(false);
  });

  it("o baseline é válido", () => expect(isValidGlobalPromptBody(GLOBAL_PERSONA_BASELINE)).toBe(true));

  it("a classe de controle é a do SQL (sem NUL, que o Postgres recusa antes)", () => {
    expect(`[${CONTROL_CHAR_CLASS}]`).toBe("[\\x01-\\x08\\x0b-\\x1f\\x7f]");
  });
});

describe("resolveGlobalPrompt e freshCachedGlobalPrompt: fonte e polaridade D7", () => {
  const NOW = 1_000_000;
  const BODY = "Fale como {{agent_name}} do {{restaurant_name}}. ";
  const entry = (fetchedAtMs: number, body = BODY): GlobalPromptCacheEntry => ({ versionId: "v-cache", body, fetchedAtMs });

  it("leitura fresca e válida → db, entra no cache com o relógio injetado", () => {
    const r = resolveGlobalPrompt({ ok: true, versionId: "v-2", body: BODY }, null, NOW);
    expect(r).toEqual({
      body: BODY, version: "v-2", source: "db",
      cache: { versionId: "v-2", body: BODY, fetchedAtMs: NOW }, failure: null,
    });
  });

  it("erro com cache de qualquer idade → stale_cache, sem renovar o relógio do cache", () => {
    const old = entry(NOW - 10 * 24 * 60 * 60 * 1000);
    const r = resolveGlobalPrompt({ ok: false, reason: "slot_read_error", code: "42P01" }, old, NOW);
    expect(r).toEqual({
      body: BODY, version: "v-cache", source: "stale_cache", cache: old,
      failure: { reason: "slot_read_error", code: "42P01" },
    });
  });

  it("erro sem cache → baseline", () => {
    const r = resolveGlobalPrompt({ ok: false, reason: "read_threw" }, null, NOW);
    expect(r).toEqual({
      body: GLOBAL_PERSONA_BASELINE, version: GLOBAL_PROMPT_BASELINE_VERSION, source: "baseline", cache: null,
      failure: { reason: "read_threw", code: null },
    });
    expect(GLOBAL_PROMPT_BASELINE_VERSION).toBe("baseline");
  });

  it("corpo inválido → mesmo caminho do erro (com e sem cache)", () => {
    const bad = { ok: true as const, versionId: "v-3", body: "ola {{x}}" };
    expect(resolveGlobalPrompt(bad, entry(NOW - 1), NOW)).toMatchObject({
      source: "stale_cache", version: "v-cache", failure: { reason: "invalid_body", code: null },
    });
    expect(resolveGlobalPrompt(bad, null, NOW)).toMatchObject({
      source: "baseline", body: GLOBAL_PERSONA_BASELINE, failure: { reason: "invalid_body" },
    });
  });

  it("id da versão que não é string → mesmo caminho do erro", () => {
    expect(resolveGlobalPrompt({ ok: true, versionId: null, body: BODY }, null, NOW))
      .toMatchObject({ source: "baseline", failure: { reason: "invalid_version_id" } });
  });

  it("TTL de 60s: cache fresco serve como db, vencido não serve", () => {
    expect(GLOBAL_PROMPT_CACHE_TTL_MS).toBe(60_000);
    expect(freshCachedGlobalPrompt(null, NOW)).toBeNull();
    expect(freshCachedGlobalPrompt(entry(NOW - 59_999), NOW)).toEqual({
      body: BODY, version: "v-cache", source: "db", cache: entry(NOW - 59_999), failure: null,
    });
    expect(freshCachedGlobalPrompt(entry(NOW - 60_000), NOW)).toBeNull();
    // Relógio que volta (troca de isolate não acontece, mas NTP sim): não serve cache "do futuro".
    expect(freshCachedGlobalPrompt(entry(NOW + 1), NOW)).toBeNull();
  });
});
