type ReservationOutcome =
  | { success: true; reservationId: string }
  | { success: false };

type ConsentRpc = (
  name: "record_public_promotional_opt_in",
  args: { p_unit_id: string; p_customer_id: string; p_reference: string },
  signal: AbortSignal,
) => PromiseLike<{ error: unknown }>;

export const PUBLIC_CONSENT_TIMEOUT_MS = 2_000;

export type ConsentFailureReason = "rpc_error" | "rpc_exception" | "rpc_timeout";

/** Only an explicit checkbox and a persisted reservation can produce consent. */
export function publicReservationConsentArgs(
  marketingOptIn: unknown,
  reservation: ReservationOutcome,
  unitId: string,
  customerId: string,
) {
  if (marketingOptIn !== true || reservation.success !== true) return null;

  return {
    p_unit_id: unitId,
    p_customer_id: customerId,
    p_reference: `reservation:${reservation.reservationId};form:v1`,
  };
}

/** Consent persistence is best effort after reserveSlot has committed. */
export async function recordPublicReservationConsent(
  marketingOptIn: unknown,
  reservation: ReservationOutcome,
  unitId: string,
  customerId: string,
  rpc: ConsentRpc,
  onFailure: (reason: ConsentFailureReason) => void,
): Promise<void> {
  const args = publicReservationConsentArgs(marketingOptIn, reservation, unitId, customerId);
  if (!args) return;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: ConsentFailureReason | null = null;
  try {
    const rpcOutcome = Promise.resolve(rpc("record_public_promotional_opt_in", args, controller.signal))
      .then(({ error }) => error ? "rpc_error" as const : null, () => "rpc_exception" as const);
    const timeout = new Promise<"rpc_timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("rpc_timeout");
      }, PUBLIC_CONSENT_TIMEOUT_MS);
    });
    failure = await Promise.race([rpcOutcome, timeout]);
  } catch {
    failure = "rpc_exception";
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (failure) onFailure(failure);
}
