// Resposta pública de sucesso do create-reservation.
//
// F-004: a EF é anônima e o telefone não é verificado, então o cadastro achado
// pelo telefone NUNCA volta (nome/e-mail de outra pessoa). Só o que o visitante
// digitou + os dados da reserva. Vale também para a reserva reaproveitada (F-002B).

export interface TypedCustomer {
  name: string;
  phone: string;
  email: string | null;
}

export interface PublicReservationSuccess {
  reservationId: string;
  reservationCode: string;
  tableId: string | null | undefined;
  tableIds: string[];
  reservationStatus: string | null;
  customerId: string;
  /** true = mesmo pedido reenviado; nada foi criado agora. */
  alreadyExisted: boolean;
}

export function publicReservationSuccessBody(r: PublicReservationSuccess, typed: TypedCustomer) {
  return {
    success: true,
    reservation_id: r.reservationId,
    reservation_code: r.reservationCode,
    table_id: r.tableId ?? null,
    table_ids: r.tableIds,
    reservation_status: r.reservationStatus,
    requires_payment: false,
    payment_amount_cents: null,
    already_existed: r.alreadyExisted,
    customer: {
      id: r.customerId,
      name: typed.name,
      phone: typed.phone,
      email: typed.email,
    },
    message: r.alreadyExisted ? "Sua reserva já estava feita." : "Reserva confirmada.",
  };
}

/** A reserva reaproveitada só vira sucesso se estiver confirmada e sem pagamento. */
export function isReplayableAsConfirmed(status: string, paymentStatus: string | null): boolean {
  return status === "confirmed" && (paymentStatus === null || paymentStatus === "not_required");
}
