/**
 * Remoção de canal WhatsApp em lotes.
 *
 * O `DELETE` direto do canal fazia o `on delete set null` reescrever todas as
 * linhas de `webhook_executions` num comando só e estourava os 8 s do PostgREST
 * (57014). O núcleo decide o laço de desvinculação; a guarda de wiring confere
 * que `manage-channels:delete` desvincula ANTES de apagar e não apaga quando a
 * desvinculação falha.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNEL_DETACH_BATCH_SIZE,
  CHANNEL_DETACH_DEADLINE_MS,
  detachChannelReferences,
  isUuid,
} from "../../supabase/functions/_shared/whatsapp-channel-delete-core";

/** RPC simulada: desvincula até `limit` das `remaining` linhas a cada chamada. */
function fakeRpc(remaining: number) {
  const calls: number[] = [];
  const fn = async (limit: number) => {
    calls.push(limit);
    const n = Math.min(limit, remaining);
    remaining -= n;
    return n;
  };
  return { fn, calls, left: () => remaining };
}

describe("detachChannelReferences", () => {
  it("canal sem histórico: uma chamada e termina", async () => {
    const rpc = fakeRpc(0);
    const r = await detachChannelReferences(rpc.fn);
    expect(r).toEqual({ ok: true, detached: 0, batches: 1 });
    expect(rpc.calls).toEqual([CHANNEL_DETACH_BATCH_SIZE]);
  });

  it("49.420 linhas (o caso real da Ren Sushi) são desvinculadas em lotes até zerar", async () => {
    const rpc = fakeRpc(49_420);
    const r = await detachChannelReferences(rpc.fn);
    expect(r.ok).toBe(true);
    expect(r.detached).toBe(49_420);
    expect(rpc.left()).toBe(0);
    // 25 lotes com linhas + 1 lote vazio que prova o fim.
    expect(r.batches).toBe(Math.ceil(49_420 / CHANNEL_DETACH_BATCH_SIZE) + 1);
  });

  it("total múltiplo exato do lote: precisa de uma chamada extra que devolve 0", async () => {
    const rpc = fakeRpc(4);
    const r = await detachChannelReferences(rpc.fn, { batchSize: 2 });
    expect(r).toEqual({ ok: true, detached: 4, batches: 3 });
  });

  it("erro da RPC falha fechado e preserva o progresso", async () => {
    let n = 0;
    const err = { code: "PGRST202", message: "function not found" };
    const r = await detachChannelReferences(async () => {
      if (++n === 2) throw err;
      return 2;
    }, { batchSize: 2 });
    expect(r).toEqual({ ok: false, reason: "rpc_error", detached: 2, batches: 1, error: err });
  });

  it.each([[null], ["3"], [1.5], [-1], [3], [undefined]])(
    "contagem inválida (%p) falha fechado em vez de seguir para o DELETE",
    async (bad) => {
      const r = await detachChannelReferences(async () => bad, { batchSize: 2 });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("invalid_count");
    },
  );

  it("teto de lotes esgotado não declara sucesso", async () => {
    const rpc = fakeRpc(100);
    const r = await detachChannelReferences(rpc.fn, { batchSize: 2, maxBatches: 3 });
    expect(r).toEqual({ ok: false, reason: "budget_exhausted", detached: 6, batches: 3 });
  });

  it("prazo de parede esgotado devolve budget_exhausted antes do teto de lotes", async () => {
    let t = 0;
    const rpc = fakeRpc(1_000_000);
    const r = await detachChannelReferences(
      async (limit) => { t += 40_000; return rpc.fn(limit); },
      { now: () => t },
    );
    expect(CHANNEL_DETACH_DEADLINE_MS).toBe(90_000);
    expect(r).toMatchObject({ ok: false, reason: "budget_exhausted", batches: 3 });
  });

  it("lote curto não encerra: só o lote vazio prova o fim", async () => {
    // Linhas apagadas por outro processo entre o SELECT e o UPDATE da RPC fazem
    // um lote voltar curto com referências ainda restando.
    const script = [1, 2, 0];
    const calls: number[] = [];
    const r = await detachChannelReferences(async (limit) => {
      calls.push(limit);
      return script.shift();
    }, { batchSize: 2 });
    expect(r).toEqual({ ok: true, detached: 3, batches: 3 });
    expect(calls).toHaveLength(3);
  });

  it("controle positivo: parar no lote curto deixaria a referência seguinte para o DELETE", async () => {
    const script = [1, 2, 0];
    let detached = 0;
    let calls = 0;
    // Política recusada: tratar count < batchSize como fim.
    for (;;) {
      calls += 1;
      const n = script.shift()!;
      detached += n;
      if (n < 2) break;
    }
    expect(calls).toBe(1);
    expect(detached).toBe(1);
    expect(script).toEqual([2, 0]);
  });
});

describe("isUuid", () => {
  it.each([["cccccccc-0065-0000-0000-00000000000a", true], ["556A4D10-9134-4856-8A43-CE350B96F4B3", true]])(
    "%s é uuid", (v, ok) => expect(isUuid(v)).toBe(ok));
  it.each([[""], ["[object Object]"], ["556a4d10-9134-4856-8a43-ce350b96f4b"], [null], [{}], [123]])(
    "%p não é uuid", (v) => expect(isUuid(v)).toBe(false));
});

describe("manage-channels:delete wiring", () => {
  const EF = readFileSync(
    join(__dirname, "..", "..", "supabase", "functions", "manage-channels", "index.ts"),
    "utf8",
  );
  const start = EF.indexOf('if (action === "delete")');
  const end = EF.indexOf('if (action === "test")', start);
  const block = EF.slice(start, end);

  it("o bloco existe", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("desvincula pela RPC antes do DELETE do canal", () => {
    const detachAt = block.indexOf("detachChannelReferences(");
    const rpcAt = block.indexOf('"detach_whatsapp_channel_references"');
    const deleteAt = block.indexOf(".delete()");
    expect(detachAt).toBeGreaterThan(-1);
    expect(rpcAt).toBeGreaterThan(detachAt);
    expect(deleteAt).toBeGreaterThan(rpcAt);
  });

  it("a RPC recebe o unit_id da requisição (tenant conferido no banco)", () => {
    expect(block).toMatch(/p_unit_id:\s*unitId/);
  });

  it("falha da desvinculação retorna antes do DELETE", () => {
    const failAt = block.indexOf("detach.ok === false");
    const deleteAt = block.indexOf(".delete()");
    const between = block.slice(failAt, deleteAt);
    expect(failAt).toBeGreaterThan(-1);
    expect(between).toMatch(/return jsonResponse\(req, \{ error: "Falha ao remover canal\." \}, 500\)/);
  });

  it("teto/prazo esgotado responde 503 pedindo nova tentativa, sem apagar", () => {
    const failAt = block.indexOf("detach.ok === false");
    const deleteAt = block.indexOf(".delete()");
    const between = block.slice(failAt, deleteAt);
    expect(between).toMatch(/detach\.reason === "budget_exhausted"/);
    expect(between).toMatch(/Tente remover de novo em instantes\."\s*\},\s*503/);
  });

  it("ids inválidos são recusados com 400 antes da RPC", () => {
    const guardAt = block.indexOf("!isUuid(channelId) || !isUuid(unitId)");
    const detachAt = block.indexOf("detachChannelReferences(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(detachAt);
    expect(block.slice(guardAt, detachAt)).toMatch(/, 400\)/);
  });

  it("o DELETE continua escopado pela unidade", () => {
    expect(block).toMatch(/\.delete\(\)\s*\.eq\("id", channelId\)\s*\.eq\("unit_id", unitId\)/);
  });
});
