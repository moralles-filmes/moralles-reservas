/** Public no-deposit reservations enter confirmed in the same INSERT that
 * fires the confirmation outbox trigger. The hall comes from availability's
 * selected slot, never from an unverified browser hint. Any active charge
 * configuration is held for the separate payment rollout. */
export interface ChargeRow {
  charge_enabled: boolean;
  charge_amount_cents: number | null;
}

export interface ReservationChargeReader {
  special(unitId: string, date: string, hallId: string | undefined): Promise<ChargeRow | null>;
  schedule(hallId: string, weekday: number, time: string): Promise<ChargeRow | null>;
}

export type InitialReservationState = {
  status: 'confirmed';
  paymentStatus: 'not_required';
  paymentAmountCents: null;
  paymentExpiresAt: null;
};

export async function initialNoDepositReservationState(input: {
  unitId: string; date: string; time: string; hallId: string | undefined;
}, reader: ReservationChargeReader): Promise<InitialReservationState> {
  const special = await reader.special(input.unitId, input.date, input.hallId);
  if (special !== null) {
    if (special.charge_enabled !== true || !Number.isSafeInteger(special.charge_amount_cents)
      || special.charge_amount_cents! < 0) throw new Error('charge_configuration_unavailable');
    throw new Error('prepaid_reservation_not_supported');
  }
  if (input.hallId) {
    const weekday = new Date(`${input.date}T12:00:00Z`).getUTCDay();
    if (!Number.isInteger(weekday)) throw new Error('charge_configuration_unavailable');
    const schedule = await reader.schedule(input.hallId, weekday, input.time);
    if (schedule !== null) {
      if (schedule.charge_enabled !== true || !Number.isSafeInteger(schedule.charge_amount_cents)
        || schedule.charge_amount_cents! < 0) throw new Error('charge_configuration_unavailable');
      throw new Error('prepaid_reservation_not_supported');
    }
  }
  return { status: 'confirmed', paymentStatus: 'not_required', paymentAmountCents: null, paymentExpiresAt: null };
}
