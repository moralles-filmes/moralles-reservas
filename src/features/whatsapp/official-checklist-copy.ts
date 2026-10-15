import type { OfficialChecklistItemId } from "../../../supabase/functions/_shared/datafy-onboarding-core";

export const OFFICIAL_ITEM_COPY: Record<OfficialChecklistItemId, string> = {
  granted: "Conexão liberada",
  channel_created: "Canal preparado",
  webhook_ready: "Recebimento de mensagens configurado",
  number_connected: "Número conectado",
  subscribed: "Assinatura confirmada",
  echo_verified: "Mensagem do app verificada",
  active: "Canal ativado",
};
