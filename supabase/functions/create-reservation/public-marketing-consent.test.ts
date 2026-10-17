import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_CONSENT_TIMEOUT_MS,
  publicReservationConsentArgs,
  recordPublicReservationConsent,
} from "./public-marketing-consent";

const saved = { success: true as const, reservationId: "22222222-2222-4222-8222-222222222222" };
const rejected = { success: false as const };
const unitId = "11111111-1111-4111-8111-111111111111";
const customerId = "33333333-3333-4333-8333-333333333333";

describe("public reservation promotional consent", () => {
  it("requires literal true and a persisted reservation", () => {
    for (const value of [undefined, null, false, "true", 1, {}, []]) {
      expect(publicReservationConsentArgs(value, saved, unitId, customerId)).toBeNull();
    }
    expect(publicReservationConsentArgs(true, rejected, unitId, customerId)).toBeNull();
    expect(publicReservationConsentArgs(true, saved, unitId, customerId)).toEqual({
      p_unit_id: unitId,
      p_customer_id: customerId,
      p_reference: `reservation:${saved.reservationId};form:v1`,
    });
  });

  it("records consent once after a successful reservation", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const onFailure = vi.fn();

    await recordPublicReservationConsent(true, saved, unitId, customerId, rpc, onFailure);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_public_promotional_opt_in", {
      p_unit_id: unitId,
      p_customer_id: customerId,
      p_reference: `reservation:${saved.reservationId};form:v1`,
    }, expect.any(AbortSignal));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("never writes or emits a failure event without explicit opt-in and reservation success", async () => {
    const rpc = vi.fn();
    const onFailure = vi.fn();

    for (const value of [undefined, false, "true", 1]) {
      await recordPublicReservationConsent(value, saved, unitId, customerId, rpc, onFailure);
    }
    await recordPublicReservationConsent(true, rejected, unitId, customerId, rpc, onFailure);

    expect(rpc).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports RPC errors without rejecting a saved reservation", async () => {
    const onFailure = vi.fn();
    await expect(recordPublicReservationConsent(
      true, saved, unitId, customerId,
      vi.fn().mockResolvedValue({ error: { message: "private database detail" } }),
      onFailure,
    )).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("rpc_error");
  });

  it("reports thrown RPC failures without exposing the exception to the logger", async () => {
    const onFailure = vi.fn();
    await expect(recordPublicReservationConsent(
      true, saved, unitId, customerId,
      vi.fn().mockRejectedValue(new Error("private database detail")),
      onFailure,
    )).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("rpc_exception");
  });

  it("times out a stalled RPC, aborts it, and ignores a late rejection", async () => {
    vi.useFakeTimers();
    try {
      let rejectRpc!: (reason: Error) => void;
      const pending = new Promise<{ error: unknown }>((_resolve, reject) => {
        rejectRpc = reject;
      });
      const rpc = vi.fn().mockReturnValue(pending);
      const onFailure = vi.fn();

      const recording = recordPublicReservationConsent(
        true, saved, unitId, customerId, rpc, onFailure,
      );
      await vi.advanceTimersByTimeAsync(PUBLIC_CONSENT_TIMEOUT_MS);

      await expect(recording).resolves.toBeUndefined();
      expect(rpc.mock.calls[0][2].aborted).toBe(true);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith("rpc_timeout");

      rejectRpc(new Error("private late failure"));
      await Promise.resolve();
      expect(onFailure).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
