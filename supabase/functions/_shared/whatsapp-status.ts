// Fachada compatível dos callbacks de entrega. A decisão por provider vive no
// registry central, junto dos parsers inbound e do adapter de envio.

import {
  tryGetWhatsAppProvider,
  type WhatsAppProvider,
} from "./whatsapp-providers.ts";

export type { DeliveryStatus, StatusUpdate } from "./whatsapp-provider-core.ts";
import type { StatusUpdate } from "./whatsapp-provider-core.ts";

// deno-lint-ignore no-explicit-any
export function parseStatusCallback(provider: WhatsAppProvider, payload: any): StatusUpdate[] | null {
  try {
    return tryGetWhatsAppProvider(provider)?.parseStatusCallback(payload) ?? null;
  } catch {
    return null;
  }
}
