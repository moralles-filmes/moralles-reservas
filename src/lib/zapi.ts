// Z-API client — usado APENAS nas Edge Functions do Supabase (server-side).
// Este arquivo serve como referência de tipos para uso no frontend (ex: visualizar templates).

export interface ZApiMessagePayload {
  phone: string;
  message: string;
}

export interface ZApiConfig {
  instanceId: string;
  token: string;
  baseUrl: string;
}

export function buildConfirmationMessage(params: {
  name: string;
  date: string;
  time: string;
  partySize: number;
  code: string;
}): string {
  return (
    `✅ *Reserva Confirmada!*\n\n` +
    `Olá ${params.name}, sua reserva está confirmada.\n\n` +
    `📅 Data: ${params.date}\n` +
    `⏰ Horário: ${params.time}\n` +
    `👥 Pessoas: ${params.partySize}\n` +
    `🔑 Código: #${params.code}\n\n` +
    `Para alterar ou cancelar, é só responder aqui. Até logo! 😊`
  );
}

export function buildReminderMessage(params: {
  name: string;
  date: string;
  time: string;
  partySize: number;
  code: string;
}): string {
  return (
    `🔔 *Lembrete de Reserva!*\n\n` +
    `Olá ${params.name}, lembrando que sua reserva é amanhã.\n\n` +
    `📅 Data: ${params.date}\n` +
    `⏰ Horário: ${params.time}\n` +
    `👥 Pessoas: ${params.partySize}\n` +
    `🔑 Código: #${params.code}\n\n` +
    `Te esperamos! 🍽️`
  );
}

export function buildCancellationMessage(params: {
  name: string;
  date: string;
  time: string;
  partySize: number;
  code: string;
}): string {
  return (
    `❌ *Reserva Cancelada*\n\n` +
    `Olá ${params.name}, sua reserva foi cancelada.\n\n` +
    `📅 Data: ${params.date}\n` +
    `⏰ Horário: ${params.time}\n` +
    `👥 Pessoas: ${params.partySize}\n` +
    `🔑 Código: #${params.code}\n\n` +
    `Se foi engano ou quiser remarcar, é só responder aqui que ajudamos. 🙏`
  );
}
