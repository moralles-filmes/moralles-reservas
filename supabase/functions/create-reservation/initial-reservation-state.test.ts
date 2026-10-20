// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { initialNoDepositReservationState, type ReservationChargeReader } from './initial-reservation-state';

const input = { unitId: '00000000-0000-4000-8000-000000000001', date: '2026-10-19',
  time: '19:00', hallId: '00000000-0000-4000-8000-000000000002' };
function reader(): ReservationChargeReader {
  return { special: vi.fn(async () => null), schedule: vi.fn(async () => null) };
}

describe('public no-deposit state before the insert/outbox boundary', () => {
  it('confirms an ordinary booking without depending on any provider', async () => {
    const io = reader();
    expect(await initialNoDepositReservationState(input, io)).toEqual({ status: 'confirmed', paymentStatus: 'not_required',
      paymentAmountCents: null, paymentExpiresAt: null });
    expect(io.special).toHaveBeenCalledWith(input.unitId, input.date, input.hallId);
    expect(io.schedule).toHaveBeenCalledWith(input.hallId, 1, input.time);
  });
  it('refuses an active special-date charge, including zero, without reading the schedule', async () => {
    const io = reader(); vi.mocked(io.special).mockResolvedValue({ charge_enabled: true, charge_amount_cents: 12500 });
    await expect(initialNoDepositReservationState(input, io)).rejects.toThrow('prepaid_reservation_not_supported');
    vi.mocked(io.special).mockResolvedValue({ charge_enabled: true, charge_amount_cents: 0 });
    await expect(initialNoDepositReservationState(input, io)).rejects.toThrow('prepaid_reservation_not_supported');
    expect(io.schedule).not.toHaveBeenCalled();
  });
  it('refuses an active selected-hall schedule and honors a global special date', async () => {
    const io = reader(); vi.mocked(io.schedule).mockResolvedValue({ charge_enabled: true, charge_amount_cents: 4000 });
    await expect(initialNoDepositReservationState(input, io)).rejects.toThrow('prepaid_reservation_not_supported');
    const global = reader(); vi.mocked(global.special).mockResolvedValue({ charge_enabled: true, charge_amount_cents: 5000 });
    await expect(initialNoDepositReservationState({ ...input, hallId: undefined }, global))
      .rejects.toThrow('prepaid_reservation_not_supported');
    expect(global.schedule).not.toHaveBeenCalled();
  });
  it('fails closed on charge-read errors and malformed active charges before INSERT', async () => {
    const io = reader(); vi.mocked(io.special).mockRejectedValue(new Error('database unavailable'));
    await expect(initialNoDepositReservationState(input, io)).rejects.toThrow('database unavailable');
    vi.mocked(io.special).mockResolvedValue({ charge_enabled: true, charge_amount_cents: null });
    await expect(initialNoDepositReservationState(input, io)).rejects.toThrow('charge_configuration_unavailable');
    expect(io.schedule).not.toHaveBeenCalled();
  });
});
