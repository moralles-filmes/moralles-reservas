import { beforeEach, expect, it, vi } from "vitest";
import { archiveMarketingDraft, draftInputSchema, getMarketingDrafts, getMarketingResults, isMarketingConflict, marketingErrorMessage, saveMarketingDraft, type MarketingDraft } from "./api";
import { isMarketingPeriodValid } from "./hooks";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: mocks.rpc } }));
const unitId = "00000000-0000-4000-8000-000000000001";
const input = { program: "waitlist_feedback" as const, voucher_rule_id: null, title: "Pesquisa", start_date: null, end_date: null, proposed_daily_contacts: null, proposed_daily_messages: null };
const draft: MarketingDraft = { ...input, id: "00000000-0000-4000-8000-000000000002", unit_id: unitId, voucher_rule_name: null, status: "draft", revision: 3, updated_at: "2026-10-20T12:00:00Z" };
beforeEach(() => vi.clearAllMocks());
it("restringe writes às RPCs de rascunho, preservando revisão esperada", async () => {
  mocks.rpc.mockResolvedValue({ data: draft, error: null });
  await saveMarketingDraft(unitId, input, draft);
  expect(mocks.rpc).toHaveBeenCalledWith("save_marketing_draft", expect.objectContaining({ p_unit_id: unitId, p_draft_id: draft.id, p_expected_revision: 3, p_program: "waitlist_feedback" }));
  await archiveMarketingDraft(draft);
  expect(mocks.rpc).toHaveBeenLastCalledWith("archive_marketing_draft", { p_draft_id: draft.id, p_expected_revision: 3 });
});
it("não transforma resposta de leitura inválida em lista vazia", async () => {
  mocks.rpc.mockResolvedValue({ data: {}, error: null });
  await expect(getMarketingDrafts(unitId)).rejects.toThrow();
});
it("envia unidade e período obrigatórios para agregação", async () => {
  mocks.rpc.mockResolvedValue({ data: {}, error: null });
  await getMarketingResults(unitId, "2026-10-01", "2026-10-20").catch(() => {});
  expect(mocks.rpc).toHaveBeenCalledWith("get_marketing_results", { p_unit_id: unitId, p_from: "2026-10-01", p_to: "2026-10-20" });
});
it("orienta recarregar após conflito sem expor erro SQL", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "technical-details" } });
  const error = await saveMarketingDraft(unitId, input, draft).catch((value) => value);
  expect(marketingErrorMessage(error)).toMatch(/outra sessão/);
  expect(marketingErrorMessage(error)).not.toContain("technical-details");
  expect(isMarketingConflict(error)).toBe(true);
  expect(isMarketingConflict(new Error("40001"))).toBe(false);
});
it("valida período, volume e regra exigida antes da RPC", () => {
  expect(draftInputSchema.safeParse({ ...input, program: "birthday_voucher" }).success).toBe(false);
  expect(draftInputSchema.safeParse({ ...input, start_date: "2026-10-20", end_date: "2026-10-01" }).success).toBe(false);
  expect(draftInputSchema.safeParse({ ...input, proposed_daily_messages: 100001 }).success).toBe(false);
});
it("limita a consulta a 366 datas inclusivas", () => {
  expect(isMarketingPeriodValid("2026-01-01", "2027-01-01")).toBe(true);
  expect(isMarketingPeriodValid("2026-01-01", "2027-01-02")).toBe(false);
});
