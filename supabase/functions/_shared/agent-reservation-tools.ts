/**
 * Ferramentas de reserva do agente de IA (get/update/cancel) com escopo
 * obrigatório de tenant.
 *
 * `reservation_code` é UNIQUE global: filtrar só por ele deixava quem conhece
 * o código de outra pessoa (print, mensagem encaminhada) ler, alterar ou
 * cancelar a reserva dela pela IA — inclusive em outra loja. Toda query aqui
 * leva unidade + cliente do turno + status ativo, e o caller NUNCA escolhe o
 * escopo: ele vem do canal e do cliente já resolvidos pelo webhook.
 *
 * Contrato com o LLM: zero linhas vira "não encontrada" (sem distinguir "não
 * existe" de "é de outra pessoa") e erro de banco vira frase genérica — o
 * `error.message` do Postgres só vai para o log.
 *
 * Sem client global nem `Deno.env`: o client entra por parâmetro para o
 * núcleo ser testável no Vitest.
 */

export type ReservationToolScope = { unitId: string; customerId: string };

type DbResult = { data: unknown; error: { code?: string; message?: string } | null };

// deno-lint-ignore no-explicit-any
type ReservationToolDb = { from(table: string): any };

const ACTIVE_STATUSES = ["confirmed", "pending"];
const NOT_FOUND = "Reserva não encontrada ou já cancelada.";
const DB_UNAVAILABLE = "Não consegui acessar a reserva agora. Tente novamente em instantes.";

function logToolError(tool: string, error: { code?: string } | null): void {
  console.error(JSON.stringify({ evt: "agent_reservation_tool_error", tool, code: error?.code ?? null }));
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

type ReservationRow = {
  reservation_code: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  notes: string | null;
};

export async function getReservationScoped(
  db: ReservationToolDb,
  params: { reservation_code?: string },
  scope: ReservationToolScope,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  let query = db
    .from("reservations")
    .select("reservation_code, date, time, party_size, status, notes")
    .eq("unit_id", scope.unitId)
    .eq("customer_id", scope.customerId)
    .in("status", ACTIVE_STATUSES);

  const code = params.reservation_code?.trim();
  query = code
    ? query.eq("reservation_code", normalizeCode(code))
    : query.order("created_at", { ascending: false }).limit(1);

  const { data, error } = (await query.maybeSingle()) as DbResult;
  if (error) {
    logToolError("get_reservation", error);
    return { found: false, message: DB_UNAVAILABLE };
  }
  if (!data) return { found: false, message: NOT_FOUND };
  const row = data as ReservationRow;
  const [y, m, d] = row.date.split("-");
  return {
    found: true,
    reservation_code: row.reservation_code,
    date: `${d}/${m}/${y}`,
    time: row.time,
    party_size: row.party_size,
    status: row.status,
    notes: row.notes,
  };
}

export async function updateReservationScoped(
  db: ReservationToolDb,
  params: { reservation_code: string; date?: string; time?: string; party_size?: number; notes?: string },
  scope: ReservationToolScope,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  if (!params.reservation_code?.trim()) {
    return { success: false, error: "Código da reserva não informado. Use get_reservation ou list_customer_reservations para obter o código." };
  }
  const updates: Record<string, unknown> = {};
  if (params.date) updates.date = params.date;
  if (params.time) updates.time = params.time;
  if (params.party_size) updates.party_size = params.party_size;
  if (params.notes !== undefined) updates.notes = params.notes;
  if (!Object.keys(updates).length) return { success: false, message: "Nenhuma alteração informada." };

  const { data, error } = (await db
    .from("reservations")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("reservation_code", normalizeCode(params.reservation_code))
    .eq("unit_id", scope.unitId)
    .eq("customer_id", scope.customerId)
    .in("status", ACTIVE_STATUSES)
    .select("reservation_code")
    .maybeSingle()) as DbResult;

  if (error) {
    logToolError("update_reservation", error);
    return { success: false, error: DB_UNAVAILABLE };
  }
  if (!data) return { success: false, error: NOT_FOUND };
  return { success: true, message: "Reserva atualizada com sucesso!" };
}

export async function cancelReservationScoped(
  db: ReservationToolDb,
  code: string,
  scope: ReservationToolScope,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  if (!code?.trim()) {
    return { success: false, error: "Código da reserva não informado. Use get_reservation ou list_customer_reservations para obter o código." };
  }
  const upperCode = normalizeCode(code);
  const { data, error } = (await db
    .from("reservations")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("reservation_code", upperCode)
    .eq("unit_id", scope.unitId)
    .eq("customer_id", scope.customerId)
    .in("status", ACTIVE_STATUSES)
    .select("reservation_code")
    .maybeSingle()) as DbResult;

  if (error) {
    logToolError("cancel_reservation", error);
    return { success: false, error: DB_UNAVAILABLE };
  }
  if (!data) return { success: false, error: NOT_FOUND };
  return { success: true, message: `Reserva #${upperCode} cancelada.` };
}
