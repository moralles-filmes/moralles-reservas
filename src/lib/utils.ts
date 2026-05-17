import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function safeDateParse(dateStr: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr + "T12:00:00");
  }
  return new Date(dateStr);
}

/**
 * Extrai a data local (YYYY-MM-DD) de um timestamp ISO UTC.
 * Necessário porque `.slice(0,10)` em UTC pode atribuir o dia errado
 * para eventos próximos da meia-noite no fuso do restaurante.
 */
export function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Data de hoje no fuso local do browser, formato YYYY-MM-DD.
 * Substitui `new Date().toISOString().split("T")[0]`, que retorna em UTC
 * e dá o dia ERRADO entre 21:00–23:59 BRT (já passou da meia-noite UTC).
 */
export function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Data N dias à frente (ou atrás, se negativo) no fuso local, YYYY-MM-DD.
 * Útil pra calcular maxDate/minDate de pickers respeitando o fuso do usuário.
 */
export function addDaysLocalISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Timestamp ISO correspondente ao fim do dia (23:59:59.999) no fuso local,
 * N dias à frente. Usado em validade de vouchers — o cliente tem o dia
 * inteiro até a meia-noite local independente do horário em que o voucher
 * foi emitido. Quando rodado em Edge Function (Deno=UTC), o "fim do dia
 * local" é o fim do dia UTC; pra um end-of-day em BRT a partir de um
 * runtime UTC, prefira `endOfDayBrtISO`.
 */
export function endOfDayLocalISO(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function formatDateBR(
  dateStr: string | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!dateStr) return "—";
  return safeDateParse(dateStr).toLocaleDateString("pt-BR", options);
}

/**
 * Label de dia no estilo WhatsApp: "Hoje", "Ontem" ou "DD/MM/AAAA".
 * Comparação feita no fuso local do browser.
 */
export function humanDateLabel(dateStr: string | null | undefined): string {
  if (!dateStr) return "Sem data";
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return "Sem data";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Hoje";
  if (sameDay(d, yesterday)) return "Ontem";
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Renderização segura de hora HH:MM em pt-BR para mensagens de chat.
 * Retorna "" se timestamp ausente ou inválido (evita "Invalid Date" no DOM).
 */
export function formatMessageTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Chave de agrupamento por dia local. Usada para detectar mudança de dia
 * entre mensagens consecutivas no chat (e renderizar separador).
 */
export function getMessageDayKey(dateStr: string | null | undefined): string {
  if (!dateStr) return "no-date";
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return "no-date";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatPhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  // Tira o prefixo do país (Brasil) se vier com 12 ou 13 dígitos.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

export function generateReservationCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export function getConversationDisplayName(
  conv: {
    contact_name?: string | null;
    customer?: { name?: string | null; phone?: string | null } | null;
  }
): string {
  const phone = conv.customer?.phone ?? "";
  const customerName = conv.customer?.name?.trim();
  if (customerName && customerName !== phone) return customerName;
  const contactName = conv.contact_name?.trim();
  if (contactName) return contactName;
  return formatPhone(phone);
}

/**
 * Valida se uma URL é http(s) — bloqueia javascript:, data:, vbscript:, etc.
 * Usado em campos onde a URL chega ao DOM via href (banners de cardápio).
 */
export function isSafeHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Sanitiza um termo de busca antes de interpolar dentro de um filtro
 * PostgREST do tipo `.or("name.ilike.%${term}%,phone.ilike.%${term}%")`.
 *
 * Remove:
 *  - `,` `(` `)` — separadores do parser de or()/and() do PostgREST.
 *    Sem isso, buscar "Silva, João" injeta uma vírgula que vira separador
 *    de filtros e quebra a query (400 / resultado errado).
 *  - `%` `_` `\` — wildcards e escape de ILIKE. Sem isso, "100%" casa
 *    qualquer coisa começando com "100".
 *  - aspas e crase — defesa em profundidade contra qualquer parsing exótico.
 *
 * Trunca a 80 chars (busca por substring acima disso não tem valor real).
 */
export function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()%_\\"'`*]/g, "").trim().slice(0, 80);
}
