import { describe, expect, it } from "vitest";
import {
  deleteInstanceOutcomeResponse,
  hasCostHistory,
} from "../../supabase/functions/_shared/whatsapp-instance-delete-core";

describe("deleteInstanceOutcomeResponse", () => {
  it("deleted vira 200", () => {
    expect(deleteInstanceOutcomeResponse("deleted")).toEqual({ status: 200, body: { deleted: true } });
  });
  it("not_found vira 404", () => {
    expect(deleteInstanceOutcomeResponse("not_found").status).toBe(404);
  });
  it("not_ended vira 409 com código próprio", () => {
    const r = deleteInstanceOutcomeResponse("not_ended");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INSTANCE_NOT_ENDED");
  });
  it("has_cost vira 409 com código próprio e diz que o histórico fica", () => {
    const r = deleteInstanceOutcomeResponse("has_cost");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INSTANCE_HAS_COST_HISTORY");
    expect(String(r.body.error)).toMatch(/custo/);
  });
  it("open_alerts vira 409 com código próprio e manda resolver os alertas", () => {
    const r = deleteInstanceOutcomeResponse("open_alerts");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INSTANCE_HAS_OPEN_ALERTS");
    expect(String(r.body.error)).toMatch(/alertas abertos/);
  });
  it("desfecho desconhecido ou ausente nunca vira sucesso", () => {
    for (const v of [undefined, null, "", "DELETED", 1]) {
      const r = deleteInstanceOutcomeResponse(v);
      expect(r.status).toBe(500);
      expect(r.body).not.toHaveProperty("deleted");
    }
  });
});

describe("hasCostHistory", () => {
  const vazio = new Set<string>();
  it("custo atual informado é histórico", () => {
    expect(hasCostHistory(9990, "i1", vazio)).toBe(true);
    expect(hasCostHistory(0, "i1", vazio)).toBe(true);
  });
  it("custo só em ciclo é histórico", () => {
    expect(hasCostHistory(null, "i1", new Set(["i1"]))).toBe(true);
  });
  it("sem custo atual e sem ciclo com custo não é", () => {
    expect(hasCostHistory(null, "i1", new Set(["outra"]))).toBe(false);
    expect(hasCostHistory(undefined, "i1", vazio)).toBe(false);
  });
});
