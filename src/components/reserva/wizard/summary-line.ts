import { format, isValid, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";

// Dia da semana em três letras ("sex", "sáb"). O `EEE` do ptBR vem por extenso
// e o `EEEEEE` perde o acento de sábado.
export function shortWeekdayPtBR(date: Date): string {
  return format(date, "EEEE", { locale: ptBR }).slice(0, 3);
}

// Linha de resumo do rodapé do wizard: "4 pessoas · sex, 30/10 · 20:00".
export function wizardSummaryLine(input: {
  party_size?: number | null;
  date?: string | null;
  time?: string | null;
}): string {
  const parts: string[] = [];
  if (input.party_size) {
    parts.push(`${input.party_size} ${input.party_size === 1 ? "pessoa" : "pessoas"}`);
  }
  if (input.date) {
    const parsed = parseISO(input.date);
    if (isValid(parsed)) parts.push(`${shortWeekdayPtBR(parsed)}, ${format(parsed, "dd/MM")}`);
  }
  const time = input.time?.slice(0, 5);
  if (time) parts.push(time);
  return parts.join(" · ");
}
