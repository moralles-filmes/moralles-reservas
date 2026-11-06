// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isReplayableAsConfirmed, publicReservationSuccessBody } from './public-response';

const reservation = {
  reservationId: 'r1', reservationCode: 'ABCD2345', tableId: 't1', tableIds: ['t1'],
  reservationStatus: 'confirmed', customerId: 'c1', alreadyExisted: false,
};
const typed = { name: 'Ana', phone: '11999990000', email: null };

describe('publicReservationSuccessBody (F-004)', () => {
  it('returns only what the visitor typed, never the stored customer profile', () => {
    const body = publicReservationSuccessBody(reservation, typed);
    expect(body.customer).toEqual({ id: 'c1', name: 'Ana', phone: '11999990000', email: null });
    expect(JSON.stringify(body)).not.toContain('Cadastro');
    expect(body).toMatchObject({ success: true, reservation_code: 'ABCD2345', requires_payment: false,
      payment_amount_cents: null, already_existed: false, message: 'Reserva confirmada.' });
  });
  it('a replayed reservation says it already existed and keeps the same contract', () => {
    const body = publicReservationSuccessBody({ ...reservation, alreadyExisted: true, tableId: undefined, tableIds: [] }, typed);
    expect(body).toMatchObject({ already_existed: true, table_id: null, table_ids: [],
      message: 'Sua reserva já estava feita.', reservation_status: 'confirmed' });
  });
});

describe('isReplayableAsConfirmed', () => {
  it('only a confirmed reservation without payment becomes a success', () => {
    expect(isReplayableAsConfirmed('confirmed', 'not_required')).toBe(true);
    expect(isReplayableAsConfirmed('confirmed', null)).toBe(true);
    expect(isReplayableAsConfirmed('pending', 'not_required')).toBe(false);
    expect(isReplayableAsConfirmed('confirmed', 'pending')).toBe(false);
  });
});
