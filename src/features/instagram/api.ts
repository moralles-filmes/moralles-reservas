import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  InstagramApiError,
  type InstagramAccount,
  type InstagramConnectResult,
  type InstagramConnectStart,
  type InstagramDiagnostics,
  type InstagramModuleGrant,
  type InstagramModuleState,
  type InstagramSettings,
} from "./types";

const GENERIC_ERROR = "Não foi possível concluir a operação com o Instagram. Tente novamente.";

/** Converte o erro do invoke em Error com o corpo `{ error, code }` da EF. */
async function toApiError(error: unknown): Promise<InstagramApiError> {
  if (error instanceof FunctionsHttpError) {
    const body = await error.context.json().catch(() => null);
    const message = body && typeof body.error === "string" ? body.error : GENERIC_ERROR;
    const code = body && typeof body.code === "string" ? body.code : null;
    const status = typeof error.context?.status === "number" ? error.context.status : null;
    return new InstagramApiError(message, status, code);
  }
  return new InstagramApiError(GENERIC_ERROR);
}

async function invokeConnect<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("instagram-connect", { body });
  if (error) throw await toApiError(error);
  return data as T;
}

export async function readUnitModules(unitId: string): Promise<InstagramModuleState> {
  const { data, error } = await supabase.rpc("get_unit_modules", { p_unit_id: unitId });
  // Erro de leitura propaga: nunca vira "módulo desligado".
  if (error) throw error;
  const rows = (Array.isArray(data) ? data : []) as Array<{ module: string; active: boolean; granted_at: string | null }>;
  const row = rows.find((r) => r.module === "instagram");
  return { instagram: { active: row?.active === true, granted_at: row?.granted_at ?? null } };
}

export async function setUnitModule(unitId: string, active: boolean): Promise<InstagramModuleGrant> {
  const { data, error } = await supabase.rpc("set_unit_module_grant", {
    p_unit_id: unitId,
    p_module: "instagram",
    p_active: active,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as InstagramModuleGrant | undefined;
  if (!row) throw new InstagramApiError(GENERIC_ERROR);
  return row;
}

export async function readInstagramAccount(unitId: string): Promise<InstagramAccount | null> {
  const data = await invokeConnect<{ account: InstagramAccount | null }>({ action: "status", unit_id: unitId });
  return data?.account ?? null;
}

export async function readInstagramSettings(unitId: string): Promise<InstagramSettings | null> {
  const { data, error } = await supabase
    .from("instagram_settings")
    .select("unit_id, dm_enabled, updated_at")
    .eq("unit_id", unitId)
    .maybeSingle();
  if (error) throw error;
  return (data as InstagramSettings | null) ?? null;
}

export async function updateInstagramDm(unitId: string, enabled: boolean): Promise<void> {
  const { data, error } = await supabase
    .from("instagram_settings")
    .update({ dm_enabled: enabled })
    .eq("unit_id", unitId)
    .select("unit_id");
  if (error) throw error;
  // UPDATE que casa zero linhas devolve error null (RLS ou linha inexistente).
  if (!data || data.length === 0) {
    throw new InstagramApiError("Você não tem permissão para alterar esta configuração.", null, "NO_ROWS_UPDATED");
  }
}

export function connectStart(unitId: string): Promise<InstagramConnectStart> {
  return invokeConnect<InstagramConnectStart>({ action: "start", unit_id: unitId });
}

export function connectCallback(code: string, state: string): Promise<InstagramConnectResult> {
  return invokeConnect<InstagramConnectResult>({ action: "callback", code, state });
}

export async function disconnectInstagram(unitId: string): Promise<void> {
  await invokeConnect({ action: "disconnect", unit_id: unitId });
}

export async function resubscribeInstagram(unitId: string): Promise<void> {
  await invokeConnect({ action: "resubscribe", unit_id: unitId });
}

export async function readInstagramDiagnostics(unitId: string): Promise<InstagramDiagnostics> {
  const { data, error } = await supabase.rpc("get_instagram_diagnostics", { p_unit_id: unitId });
  if (error) throw error;
  return data as InstagramDiagnostics;
}
