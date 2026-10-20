import { z } from "zod";
import { supabase } from "@/lib/supabase";

export const programSchema = z.enum(["birthday_voucher", "frequency_voucher", "waitlist_feedback"]);
export type MarketingProgram = z.infer<typeof programSchema>;
export const PROGRAMS: Record<MarketingProgram, { title: string; description: string }> = {
  birthday_voucher: { title: "Aniversário com voucher", description: "Planeje um benefício de aniversário usando uma regra Giftback existente." },
  frequency_voucher: { title: "Fidelidade por visitas", description: "Reconheça clientes recorrentes com uma regra de frequência do Giftback." },
  waitlist_feedback: { title: "Pesquisa após a fila", description: "Planeje a pesquisa de experiência após a passagem pela fila de espera." },
};
const date = z.iso.date();
const count = z.number().int().nonnegative();
export const draftInputSchema = z.object({
  program: programSchema,
  voucher_rule_id: z.uuid().nullable(),
  title: z.string().trim().min(1, "Informe um nome.").max(120),
  start_date: date.nullable(), end_date: date.nullable(),
  proposed_daily_contacts: z.number().int().min(1).max(100000).nullable(),
  proposed_daily_messages: z.number().int().min(1).max(100000).nullable(),
}).superRefine((value, ctx) => {
  if (value.program !== "waitlist_feedback" && !value.voucher_rule_id) ctx.addIssue({ code: "custom", path: ["voucher_rule_id"], message: "Escolha uma regra Giftback." });
  if (value.program === "waitlist_feedback" && value.voucher_rule_id) ctx.addIssue({ code: "custom", path: ["voucher_rule_id"], message: "Pesquisa não usa regra Giftback." });
  if (value.start_date && value.end_date && value.end_date < value.start_date) ctx.addIssue({ code: "custom", path: ["end_date"], message: "O fim deve ser igual ou posterior ao início." });
});
export type DraftInput = z.infer<typeof draftInputSchema>;
const draftSchema = z.object({
  id: z.uuid(), unit_id: z.uuid(), program: programSchema, voucher_rule_id: z.uuid().nullable(),
  voucher_rule_name: z.string().nullable(), title: z.string(), start_date: date.nullable(), end_date: date.nullable(),
  proposed_daily_contacts: count.nullable(), proposed_daily_messages: count.nullable(),
  status: z.enum(["draft", "archived"]), revision: z.number().int().positive(), updated_at: z.string(),
});
export type MarketingDraft = z.infer<typeof draftSchema>;
const draftsSchema = z.object({ drafts: z.array(draftSchema), rules: z.array(z.object({ id: z.uuid(), name: z.string(), trigger_type: z.enum(["birthday", "frequency"]), active: z.boolean() })) });
export type MarketingDrafts = z.infer<typeof draftsSchema>;
export const RESULT_PROGRAMS = { giftback_rule: "Giftback por regra", waitlist_feedback: "Pesquisa após a fila" } as const;
const resultProgramSchema = z.enum(["giftback_rule", "waitlist_feedback"]);
const resultsSchema = z.object({
  from: date, to: date, retention_start: z.string(),
  giftback: z.array(z.object({ program: z.literal("giftback_rule"), rule_id: z.uuid().nullable(), rule_name: z.string().nullable(), issued: count, redeemed_cohort: count, redeemed_in_period: count })),
  managed: z.array(z.object({ channel_kind: z.enum(["official", "text", "unbound"]), program: resultProgramSchema, rule_id: z.uuid().nullable(), rule_name: z.string().nullable(), intentions: count, accepted: count, delivered: count.nullable(), read: count.nullable(), uncertain: count, pending: count, failed: count })),
  legacy: z.object({ waitlist_feedback_sent: count.nullable() }), legacy_available: z.boolean(), managed_available: z.boolean(), unknown_giftback_source: z.boolean(),
});
export type MarketingResults = z.infer<typeof resultsSchema>;
class MarketingError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
export function isMarketingConflict(error: unknown) {
  return error instanceof MarketingError && error.code === "40001";
}
export function marketingErrorMessage(error: unknown) {
  return error instanceof MarketingError ? error.message : "Não foi possível carregar Marketing. Tente novamente.";
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const message = error.code === "40001" ? "Este rascunho foi alterado em outra sessão. Atualize a lista antes de editar novamente."
      : error.code === "42501" ? "Você não tem acesso a esta operação."
      : error.code === "23505" ? "Já existe um rascunho para este programa e regra. Edite o rascunho existente."
      : error.code === "22023" ? "Revise os dados e a regra escolhida antes de salvar."
      : "Não foi possível concluir a operação. Tente novamente.";
    throw new MarketingError(message, error.code);
  }
  return data;
}
export async function getMarketingDrafts(unitId: string) {
  return draftsSchema.parse(await rpc("get_marketing_drafts", { p_unit_id: unitId }));
}
export async function saveMarketingDraft(unitId: string, input: DraftInput, draft?: MarketingDraft) {
  const value = draftInputSchema.parse(input);
  return draftSchema.parse(await rpc("save_marketing_draft", {
    p_unit_id: unitId, p_draft_id: draft?.id ?? null, p_expected_revision: draft?.revision ?? null,
    ...Object.fromEntries(Object.entries(value).map(([key, entry]) => [`p_${key}`, entry])),
  }));
}
export async function archiveMarketingDraft(draft: MarketingDraft) {
  return draftSchema.parse(await rpc("archive_marketing_draft", { p_draft_id: draft.id, p_expected_revision: draft.revision }));
}
export async function getMarketingResults(unitId: string, from: string, to: string) {
  return resultsSchema.parse(await rpc("get_marketing_results", { p_unit_id: unitId, p_from: from, p_to: to }));
}
