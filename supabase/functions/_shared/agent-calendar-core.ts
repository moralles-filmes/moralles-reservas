// Calendário determinístico dos próximos dias para o system prompt do agente.
// Núcleo puro (sem imports): o chamador entrega `nowBrt` já deslocado para BRT
// (`new Date(Date.now() - BRT_OFFSET_MS)`) e aqui só se lê `getUTC*`.
// BRT é UTC-3 fixo (sem horário de verão), então somar 24h em ms é seguro.

export const WEEKDAY_NAMES_PT = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `- hoje: quarta-feira, 14/10`, `- amanhã: quinta-feira, 15/10`, `- sexta-feira, 16/10`... */
export function buildUpcomingDaysLines(nowBrt: Date, days = 8): string[] {
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(nowBrt.getTime() + i * DAY_MS);
    const weekday = WEEKDAY_NAMES_PT[d.getUTCDay()];
    const date = `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`;
    const label = i === 0 ? "hoje: " : i === 1 ? "amanhã: " : "";
    lines.push(`- ${label}${weekday}, ${date}`);
  }
  return lines;
}
