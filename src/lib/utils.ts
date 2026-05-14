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

export function formatDateBR(
  dateStr: string | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!dateStr) return "—";
  return safeDateParse(dateStr).toLocaleDateString("pt-BR", options);
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

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
