import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

export type WhatsappConnectionStatus =
  | "not_configured"
  | "provisioning"
  | "waiting_qr"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "suspended"
  | "provider_error"
  | "switching_provider"
  | "error";

/** Shape deliberadamente client-safe: provider, credenciais e external ID não entram. */
export interface WhatsappConnectionSnapshot {
  channel_id: string | null;
  status: WhatsappConnectionStatus;
  display_phone: string | null;
  qr_code: string | null;
  qr_expires_at: string | null;
  connected_at: string | null;
  last_health_check_at: string | null;
  lifecycle_available: boolean;
}

type ClientAction =
  | "list_client"
  | "connect"
  | "refresh_qr"
  | "status"
  | "disconnect"
  | "restart";

const CLIENT_STATUSES = new Set<WhatsappConnectionStatus>([
  "not_configured",
  "provisioning",
  "waiting_qr",
  "connecting",
  "connected",
  "disconnected",
  "reconnecting",
  "suspended",
  "provider_error",
  "switching_provider",
  "error",
]);

const TRANSIENT_STATUSES = new Set<WhatsappConnectionStatus>([
  "provisioning",
  "waiting_qr",
  "connecting",
  "reconnecting",
  "switching_provider",
]);

const EMPTY_SNAPSHOT: WhatsappConnectionSnapshot = {
  channel_id: null,
  status: "not_configured",
  display_phone: null,
  qr_code: null,
  qr_expires_at: null,
  connected_at: null,
  last_health_check_at: null,
  lifecycle_available: false,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getSnapshotCandidate(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;

  for (const key of ["connection", "snapshot", "channel"] as const) {
    const nested = asRecord(root[key]);
    if (nested) return nested;
  }

  if (Array.isArray(root.channels)) {
    const rows = root.channels.map(asRecord).filter(Boolean) as Record<string, unknown>[];
    return rows.find((row) => row.is_active === true) ?? rows[0] ?? null;
  }

  return root;
}

function responseContainsSnapshot(payload: unknown): boolean {
  const candidate = getSnapshotCandidate(payload);
  return !!candidate && ["status", "channel_id", "id", "connected", "loggedIn"].some(
    (key) => candidate[key] !== undefined,
  );
}

/**
 * Normaliza apenas os campos públicos necessários ao portal. Mesmo que o backend
 * acrescente campos administrativos à resposta, eles não atravessam este limite.
 */
export function normalizeWhatsappConnection(payload: unknown): WhatsappConnectionSnapshot {
  const candidate = getSnapshotCandidate(payload);
  if (!candidate) return { ...EMPTY_SNAPSHOT };

  const rawStatus = nullableString(candidate.status);
  const status = rawStatus && CLIENT_STATUSES.has(rawStatus as WhatsappConnectionStatus)
    ? (rawStatus as WhatsappConnectionStatus)
    : candidate.connected === true || candidate.loggedIn === true
      ? "connected"
      : "not_configured";

  return {
    channel_id: nullableString(candidate.channel_id) ?? nullableString(candidate.id),
    status,
    display_phone:
      nullableString(candidate.display_phone) ?? nullableString(candidate.phone),
    qr_code:
      nullableString(candidate.qr_code) ??
      nullableString(candidate.qrcode) ??
      nullableString(candidate.qr),
    qr_expires_at: nullableString(candidate.qr_expires_at),
    connected_at: nullableString(candidate.connected_at),
    last_health_check_at: nullableString(candidate.last_health_check_at),
    lifecycle_available: candidate.lifecycle_available === true,
  };
}

export function isWhatsappConnectionTransient(status: WhatsappConnectionStatus): boolean {
  return TRANSIENT_STATUSES.has(status);
}

export function whatsappPollingInterval(
  snapshot: WhatsappConnectionSnapshot | undefined,
  isPageVisible: boolean,
): number | false {
  if (!isPageVisible || !snapshot) return false;
  if (isWhatsappConnectionTransient(snapshot.status)) return 5_000;
  if (
    snapshot.channel_id
    && snapshot.status !== "not_configured"
    && snapshot.status !== "suspended"
  ) return 30_000;
  return false;
}

export function whatsappConnectionReadAction(
  snapshot: WhatsappConnectionSnapshot | undefined,
): "list_client" | "status" {
  return snapshot?.lifecycle_available ? "status" : "list_client";
}

function subscribePageVisibility(onStoreChange: () => void) {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
}

function getPageVisibleSnapshot() {
  return typeof document === "undefined" || !document.hidden;
}

function usePageVisible() {
  return useSyncExternalStore(subscribePageVisibility, getPageVisibleSnapshot, () => true);
}

async function invokeClientAction(
  action: ClientAction,
  unitId: string,
  channelId?: string | null,
) {
  const body: Record<string, unknown> = { action, unit_id: unitId };
  if (channelId) body.channel_id = channelId;

  const { data, error } = await supabase.functions.invoke("manage-channels", { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const parsed = (await error.context.json().catch(() => null)) as
        | { error?: string; code?: string }
        | null;
      throw Object.assign(
        new Error(parsed?.error ?? "Não foi possível atualizar a conexão."),
        { httpStatus: error.context.status, code: parsed?.code },
      );
    }
    throw new Error("Não foi possível atualizar a conexão.");
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error("Não foi possível atualizar a conexão.");
  }
  return data;
}

export function useWhatsappConnection(unitId: string) {
  const queryClient = useQueryClient();
  const isPageVisible = usePageVisible();
  const queryKey = ["whatsapp-connection", unitId] as const;

  return useQuery({
    queryKey,
    queryFn: async () => {
      const cached = queryClient.getQueryData<WhatsappConnectionSnapshot>(queryKey);
      const action: ClientAction = whatsappConnectionReadAction(cached);
      return normalizeWhatsappConnection(
        await invokeClientAction(action, unitId, cached?.channel_id),
      );
    },
    enabled: !!unitId,
    refetchInterval: (query) =>
      whatsappPollingInterval(query.state.data, isPageVisible),
  });
}

function useWhatsappConnectionAction(
  unitId: string,
  action: Exclude<ClientAction, "list_client" | "status">,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  const queryKey = ["whatsapp-connection", unitId] as const;

  return useMutation({
    mutationFn: async (channelId?: string | null) => {
      const payload = await invokeClientAction(action, unitId, channelId);
      return responseContainsSnapshot(payload)
        ? normalizeWhatsappConnection(payload)
        : queryClient.getQueryData<WhatsappConnectionSnapshot>(queryKey) ?? {
            ...EMPTY_SNAPSHOT,
          };
    },
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(queryKey, snapshot);
      await queryClient.invalidateQueries({ queryKey });
      toast.success(successMessage);
    },
    onError: () => toast.error("Não foi possível concluir a ação. Tente novamente."),
  });
}

export function useConnectWhatsapp(unitId: string) {
  return useWhatsappConnectionAction(unitId, "connect", "Conexão iniciada.");
}

export function useRefreshWhatsappQr(unitId: string) {
  return useWhatsappConnectionAction(unitId, "refresh_qr", "QR Code atualizado.");
}

export function useDisconnectWhatsapp(unitId: string) {
  return useWhatsappConnectionAction(unitId, "disconnect", "Número desconectado.");
}

export function useRestartWhatsapp(unitId: string) {
  return useWhatsappConnectionAction(unitId, "restart", "Reconexão iniciada.");
}

export function useRefreshWhatsappStatus(unitId: string) {
  const queryClient = useQueryClient();
  const queryKey = ["whatsapp-connection", unitId] as const;

  return useMutation({
    mutationFn: async (channelId?: string | null) => {
      const payload = await invokeClientAction("status", unitId, channelId);
      return responseContainsSnapshot(payload)
        ? normalizeWhatsappConnection(payload)
        : queryClient.getQueryData<WhatsappConnectionSnapshot>(queryKey) ?? {
            ...EMPTY_SNAPSHOT,
          };
    },
    onSuccess: (snapshot) => queryClient.setQueryData(queryKey, snapshot),
    onError: () => toast.error("Não foi possível atualizar o estado. Tente novamente."),
  });
}
