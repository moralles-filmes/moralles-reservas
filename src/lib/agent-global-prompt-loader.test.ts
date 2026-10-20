import { describe, expect, it } from "vitest";
import { GLOBAL_PERSONA_BASELINE } from "../../supabase/functions/_shared/agent/global-prompt-core";
import { createGlobalPromptLoader } from "../../supabase/functions/_shared/agent/global-prompt";

/**
 * Loader de I/O da camada global (spec Entrega B §8; plano B3 passo A). O
 * núcleo decide; aqui se prova a leitura (slot → versão ativa, por service
 * role, sem id de escopo do caller), o cache com relógio injetado e o evento de
 * falha sem corpo.
 */

type Result = { data: unknown; error: { code?: string; message?: string } | null };
type Script = Partial<Record<"ai_prompt_slots" | "ai_prompt_versions", Result | Error>>;

const BODY = "Você é {{agent_name}}, do {{restaurant_name}}. ";
const OK: Script = {
  ai_prompt_slots: { data: { active_version_id: "v-7" }, error: null },
  ai_prompt_versions: { data: { id: "v-7", body: BODY }, error: null },
};

function fakeClient(script: () => Script) {
  const queries: Array<{ table: string; columns: string; filters: Array<[string, unknown]> }> = [];
  const client = {
    from(table: string) {
      const q = { table, columns: "", filters: [] as Array<[string, unknown]> };
      queries.push(q);
      const builder = {
        select(columns: string) { q.columns = columns; return builder; },
        eq(column: string, value: unknown) { q.filters.push([column, value]); return builder; },
        async maybeSingle() {
          const r = script()[table as keyof Script];
          if (r instanceof Error) throw r;
          if (!r) throw new Error(`tabela inesperada: ${table}`);
          return r;
        },
      };
      return builder;
    },
  };
  return { client: client as never, queries };
}

function setup(initial: Script = OK) {
  let script = initial;
  let now = 1_000_000;
  const logs: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const { client, queries } = fakeClient(() => script);
  const load = createGlobalPromptLoader(() => now);
  return {
    load: () => load(client, { requestId: "req-1", log: (level, payload) => logs.push({ level, payload }) }),
    queries, logs,
    set: (s: Script) => { script = s; },
    advance: (ms: number) => { now += ms; },
  };
}

const failures = (logs: Array<{ payload: Record<string, unknown> }>) =>
  logs.filter((l) => l.payload.evt === "ai_global_prompt_read_failed");

describe("loader do prompt global", () => {
  it("fresco → db, lê slot e versão ativa filtrando só pelo slot, e entra no cache", async () => {
    const t = setup();
    expect(await t.load()).toEqual({ body: BODY, version: "v-7", source: "db" });
    expect(t.queries).toEqual([
      { table: "ai_prompt_slots", columns: "active_version_id", filters: [["slot", "global_persona"]] },
      { table: "ai_prompt_versions", columns: "id, body", filters: [["slot", "global_persona"], ["id", "v-7"]] },
    ]);
    expect(t.logs).toEqual([]);
    t.advance(59_999);
    expect(await t.load()).toEqual({ body: BODY, version: "v-7", source: "db" });
    expect(t.queries).toHaveLength(2);
  });

  it("TTL de 60s: depois de vencer, lê de novo e pega a versão nova", async () => {
    const t = setup();
    await t.load();
    t.set({
      ai_prompt_slots: { data: { active_version_id: "v-8" }, error: null },
      ai_prompt_versions: { data: { id: "v-8", body: "Outra persona. " }, error: null },
    });
    t.advance(60_000);
    expect(await t.load()).toEqual({ body: "Outra persona. ", version: "v-8", source: "db" });
    expect(t.queries).toHaveLength(4);
  });

  it("erro com cache (de qualquer idade) → stale_cache e evt sem corpo", async () => {
    const t = setup();
    await t.load();
    t.set({ ai_prompt_slots: { data: null, error: { code: "57014", message: "canceling statement" } } });
    t.advance(30 * 24 * 60 * 60 * 1000);
    expect(await t.load()).toEqual({ body: BODY, version: "v-7", source: "stale_cache" });
    expect(failures(t.logs)).toEqual([{
      level: "warn",
      payload: { requestId: "req-1", evt: "ai_global_prompt_read_failed", slot: "global_persona",
        reason: "slot_read_error", code: "57014", source: "stale_cache", version: "v-7" },
    }]);
    expect(JSON.stringify(t.logs)).not.toContain(BODY);
    // O cache não é renovado pela falha: a próxima chamada tenta ler de novo.
    await t.load();
    expect(t.queries.filter((q) => q.table === "ai_prompt_slots")).toHaveLength(3);
  });

  for (const [nome, script, reason, code] of [
    ["tabela ausente antes do db push (42P01)", { ai_prompt_slots: { data: null, error: { code: "42P01" } } }, "slot_read_error", "42P01"],
    ["tabela fora do cache do PostgREST (PGRST205)", { ai_prompt_slots: { data: null, error: { code: "PGRST205" } } }, "slot_read_error", "PGRST205"],
    ["exceção de rede", { ai_prompt_slots: new Error("fetch failed") }, "read_threw", null],
    ["slot sem linha", { ai_prompt_slots: { data: null, error: null } }, "slot_missing", null],
    ["erro ao ler a versão", { ...OK, ai_prompt_versions: { data: null, error: { code: "PGRST301" } } }, "version_read_error", "PGRST301"],
    ["versão ativa sem linha", { ...OK, ai_prompt_versions: { data: null, error: null } }, "version_missing", null],
    ["corpo inválido", { ...OK, ai_prompt_versions: { data: { id: "v-7", body: "ola {{x}}" }, error: null } }, "invalid_body", null],
  ] as Array<[string, Script, string, string | null]>) {
    it(`sem cache, ${nome} → baseline e evt`, async () => {
      const t = setup(script);
      expect(await t.load()).toEqual({ body: GLOBAL_PERSONA_BASELINE, version: "baseline", source: "baseline" });
      expect(failures(t.logs)).toEqual([{
        level: "warn",
        payload: { requestId: "req-1", evt: "ai_global_prompt_read_failed", slot: "global_persona",
          reason, code, source: "baseline", version: "baseline" },
      }]);
    });
  }

  it("corpo inválido com cache → stale_cache (mesmo caminho do erro)", async () => {
    const t = setup();
    await t.load();
    t.set({ ...OK, ai_prompt_versions: { data: { id: "v-9", body: "abre <<< aqui" }, error: null } });
    t.advance(60_000);
    expect(await t.load()).toEqual({ body: BODY, version: "v-7", source: "stale_cache" });
    expect(failures(t.logs).map((l) => l.payload.reason)).toEqual(["invalid_body"]);
  });

  it("cada loader tem o seu cache (o do módulo é um por isolate)", async () => {
    const a = setup();
    const b = setup({ ai_prompt_slots: { data: null, error: { code: "42P01" } } });
    await a.load();
    expect((await b.load()).source).toBe("baseline");
  });
});
