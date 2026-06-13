import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Status de ENTREGA de uma mensagem (notifications_sent). `status` é o resultado
 * do ENVIO (provedor aceitou); `delivered_at`/`read_at`/`failed_at` vêm do
 * callback de status do WhatsApp (consumido em webhook-whatsapp). `sent` ≠
 * `delivered`: a Z-API pode aceitar (2xx) e não entregar (número sem WhatsApp,
 * typo, instância fora).
 */
export interface DeliveryRow {
  kind: string;
  status: string; // sent | failed | skipped
  provider_message_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
}

// Pausa polling em aba background (mesmo padrão da Fila/painéis operacionais).
const pollWhenVisible = () =>
  typeof document !== "undefined" && document.hidden ? false : 30_000;

function useDeliveries(
  unitId: string,
  idColumn: "waitlist_id" | "reservation_id",
  ids: string[],
) {
  // Key estável: ordena os ids pra não refazer fetch só por reordenação da lista.
  const idsKey = [...ids].sort().join(",");
  return useQuery({
    queryKey: ["notification-deliveries", idColumn, unitId, idsKey],
    queryFn: async () => {
      const map: Record<string, DeliveryRow[]> = {};
      if (!ids.length) return map;
      const { data, error } = await supabase
        .from("notifications_sent")
        .select(
          `${idColumn}, kind, status, provider_message_id, sent_at, delivered_at, read_at, failed_at`,
        )
        .eq("unit_id", unitId)
        .in(idColumn, ids);
      if (error) throw error;
      for (const r of (data ?? []) as Array<DeliveryRow & Record<string, unknown>>) {
        const owner = r[idColumn] as string | null;
        if (!owner) continue;
        (map[owner] ??= []).push(r);
      }
      return map;
    },
    enabled: !!unitId && ids.length > 0,
    refetchInterval: pollWhenVisible,
  });
}

/** Entregas das mensagens de fila (kinds waitlist_entered / waitlist_table_ready). */
export function useWaitlistDeliveries(unitId: string, waitlistIds: string[]) {
  return useDeliveries(unitId, "waitlist_id", waitlistIds);
}

/** Entregas das confirmações de reserva (kind confirmation). */
export function useReservationDeliveries(unitId: string, reservationIds: string[]) {
  return useDeliveries(unitId, "reservation_id", reservationIds);
}

// ── Derivação de estado de entrega pra UI ────────────────────────────────────

export type DeliveryState =
  | "no_phone"
  | "not_sent"
  | "failed"
  | "sent_pending" // aceito pelo provedor, aguardando confirmação de entrega
  | "sent_untracked" // enviado sem messageId (linha antiga) — sem como rastrear
  | "undelivered" // aceito mas sem entrega após o limiar → provável não-entrega
  | "delivered"
  | "read";

// Acima desse tempo sem `delivered_at`, tratamos "enviado" como provável
// não-entrega (a Z-API normalmente confirma entrega em segundos).
const UNDELIVERED_THRESHOLD_MS = 5 * 60_000;

export function deriveDeliveryState(
  row: DeliveryRow | undefined,
  hasPhone: boolean,
): DeliveryState {
  if (!hasPhone) return "no_phone";
  if (!row) return "not_sent";
  if (row.read_at) return "read";
  if (row.delivered_at) return "delivered";
  if (row.failed_at || row.status === "failed") return "failed";
  // status 'sent' sem entrega confirmada:
  if (!row.provider_message_id) return "sent_untracked";
  const sentMs = row.sent_at ? new Date(row.sent_at).getTime() : null;
  if (sentMs && Date.now() - sentMs > UNDELIVERED_THRESHOLD_MS) return "undelivered";
  return "sent_pending";
}

/** Acha a linha de um kind específico dentro das entregas de uma entidade. */
export function findDelivery(
  rows: DeliveryRow[] | undefined,
  kind: string,
): DeliveryRow | undefined {
  return rows?.find((r) => r.kind === kind);
}

/** Tooltip com os carimbos de envio/entrega/leitura/falha de uma mensagem. */
export function deliveryTooltip(row: DeliveryRow | undefined): string | undefined {
  if (!row) return undefined;
  const f = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  const parts: string[] = [];
  if (row.sent_at) parts.push(`Enviada ${f(row.sent_at)}`);
  if (row.delivered_at) parts.push(`Entregue ${f(row.delivered_at)}`);
  if (row.read_at) parts.push(`Lida ${f(row.read_at)}`);
  if (row.failed_at) parts.push(`Falhou ${f(row.failed_at)}`);
  return parts.join(" · ") || undefined;
}
