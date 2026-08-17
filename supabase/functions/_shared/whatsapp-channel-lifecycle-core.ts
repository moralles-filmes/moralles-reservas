// Núcleo puro do lifecycle de canal. ZERO IMPORTS para permitir testes locais.

export type WhatsAppChannelStatus =
  | "not_configured"
  | "provisioning"
  | "waiting_qr"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "suspended"
  | "provider_error"
  | "switching_provider"
  | "error";

export interface ProviderConnectionFact {
  status?: string | null;
  connected?: boolean;
  qrCode?: string | null;
}

export function normalizeUazConnectionStatus(
  fact: ProviderConnectionFact,
): WhatsAppChannelStatus {
  if (fact.connected === true || fact.status === "connected") return "connected";
  if (fact.status === "hibernated") return "suspended";
  if (fact.status === "connecting") return fact.qrCode ? "waiting_qr" : "connecting";
  if (fact.status === "disconnected" || !fact.status) {
    return fact.qrCode ? "waiting_qr" : "disconnected";
  }
  return "provider_error";
}

export function isTransientWhatsAppStatus(status: string): boolean {
  return status === "provisioning"
    || status === "waiting_qr"
    || status === "connecting"
    || status === "reconnecting"
    || status === "switching_provider";
}

export function shouldActivateConnectedChannel(input: {
  targetChannelId: string;
  explicitActiveChannelId: string | null;
  activationRequested: boolean;
}): boolean {
  // Primeira configuração entra em produção quando conecta. Em uma unidade já
  // ativa, somente begin_switch (que persiste activation_requested_at) autoriza o
  // cutover; apenas testar/conectar um canal preparado não troca produção.
  if (!input.explicitActiveChannelId) return true;
  if (input.explicitActiveChannelId === input.targetChannelId) return false;
  return input.activationRequested;
}
