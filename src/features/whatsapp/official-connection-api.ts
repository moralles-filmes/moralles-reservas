import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { DATAFY_CONNECT_ORIGIN, type OfficialChecklist, type OnboardingState } from "../../../supabase/functions/_shared/datafy-onboarding-core";

export interface OfficialConnectionState extends OfficialChecklist {
  granted: boolean;
  onboardingState: OnboardingState | null;
  connectionRevoked?: boolean;
}

const ERROR_COPY: Record<string, string> = {
  GRANT_REQUIRED: "A conexão precisa de liberação. Fale com o suporte.",
  PROVISIONING_BLOCKED: "A conexão não está liberada para esta unidade. Fale com o suporte.",
  ONBOARDING_BUSY: "A conexão já está sendo preparada. Aguarde e tente novamente.",
  DATAFY_RECONCILIATION_REQUIRED: "Estamos verificando uma tentativa anterior. Aguarde antes de tentar novamente.",
  DATAFY_MIGRATION_NOT_SUPPORTED: "Esta unidade já usa outra conexão. Fale com o suporte para fazer a troca.",
  UNIT_ALREADY_ACTIVE: "Esta unidade já tem um canal ativo. Atualize o estado da conexão.",
  DATAFY_ACCOUNT_UNAVAILABLE: "A conexão oficial está indisponível. Tente novamente mais tarde ou fale com o suporte.",
};
class OfficialConnectionError extends Error {}
export function officialConnectionErrorMessage(error: unknown, fallback: string) {
  return error instanceof OfficialConnectionError ? error.message : fallback;
}
function actionError(code?: unknown) {
  const copy = typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_COPY, code)
    ? ERROR_COPY[code]
    : "Não foi possível atualizar a conexão oficial. Tente novamente ou fale com o suporte.";
  return new OfficialConnectionError(copy);
}

async function invokeOfficial(action: string, unitId: string) {
  const { data, error } = await supabase.functions.invoke("manage-channels", {
    body: { action, unit_id: unitId },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => null);
      throw actionError(body?.code);
    }
    throw actionError();
  }
  if (data?.error) throw actionError(data.code);
  return data;
}

export async function readOfficialConnection(unitId: string): Promise<OfficialConnectionState | null> {
  const data: OfficialConnectionState | null = await invokeOfficial("official_connection_state", unitId);
  if (!data) return null;
  // Project the client-safe contract: accidental extra DTO fields never reach the query cache.
  return {
    step: data.step, granted: data.granted === true, onboardingState: data.onboardingState,
    items: data.items.map(({ id, done }) => ({ id, done })),
    templatesPending: data.templatesPending === true,
    ...(data.connectionRevoked === true ? { connectionRevoked: true } : {}),
  };
}

export async function startOfficialConnection(unitId: string, popup: Window, isCurrent: () => boolean) {
  const response = await invokeOfficial("official_connect_start", unitId);
  if (!isCurrent()) { popup.close(); return; }
  if (response?.next === "confirm") { popup.close(); return "confirm" as const; }
  try {
    const url = new URL(response?.url);
    if (url.protocol !== "https:" || url.origin !== DATAFY_CONNECT_ORIGIN || url.username || url.password) throw actionError();
    popup.location.href = url.href;
  } catch { throw actionError(); }
}

export async function confirmOfficialConnection(unitId: string) {
  await invokeOfficial("official_connect_confirm", unitId);
}
