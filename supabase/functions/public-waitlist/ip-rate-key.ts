// O núcleo mora em _shared/ip-rate-key.ts (também usado por public-seat-map).
// Chave e balde da fila pública continuam idênticos.
import { ipRateKeyFor, trustedClientIp } from "../_shared/ip-rate-key.ts";

export { trustedClientIp };

export function ipRateKey(headers: Headers): Promise<string | null> {
  return ipRateKeyFor(headers, "public-waitlist");
}
