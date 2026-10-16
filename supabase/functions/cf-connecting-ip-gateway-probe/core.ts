import { trustedClientIp } from "../public-waitlist/ip-rate-key.ts";

// RFC 5737 documentation address. It must never identify a real internet client.
export const FORGED_MARKER = "198.51.100.247";

export function probeHeaders(headers: Headers) {
  const received = headers.get("cf-connecting-ip");
  return {
    present: received !== null,
    valid: trustedClientIp(headers) !== null,
    equalsForgedMarker: received === FORGED_MARKER,
  };
}
