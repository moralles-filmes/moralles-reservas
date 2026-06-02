import { supabase } from "@/lib/supabase";
import type { DateRange } from "@/hooks/useFluxoClientes";
import type { AvaliacaoRow } from "@/hooks/useAvaliacoes";

interface ReservationRow {
  date: string;
  party_size: number;
  source: string;
  customer: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
  } | null;
}

interface CustomerSummary {
  name: string;
  phone: string;
  email: string;
  totalReservas: number;
  totalPessoas: number;
  reservasWhatsapp: number;
  reservasSite: number;
  ultimaVisita: string;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

function downloadBlob(content: string, filename: string) {
  const blob = new Blob(["﻿" + content], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exporta a base de clientes únicos que tiveram reservas no período.
 * Agrupa por customer_id (telefone único por organização) e gera CSV com
 * nome, telefone, e-mail, total de reservas no período, total de pessoas,
 * última visita.
 */
export async function exportClientesCsv(
  unitId: string,
  range: DateRange,
): Promise<{ count: number }> {
  const fromIso = range.from.toISOString().slice(0, 10);
  const toIso = range.to.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("reservations")
    .select(
      "date, party_size, source, customer:customers!inner(id, name, phone, email)",
    )
    .eq("unit_id", unitId)
    .gte("date", fromIso)
    .lte("date", toIso)
    .in("status", ["confirmed", "no_show", "cancelled"])
    .order("date", { ascending: false });

  if (error) throw error;

  const rows = (data ?? []) as unknown as ReservationRow[];

  const map = new Map<string, CustomerSummary>();
  for (const r of rows) {
    if (!r.customer) continue;
    const key = r.customer.id;
    const isWhatsapp = r.source === "whatsapp";
    const existing = map.get(key);
    if (existing) {
      existing.totalReservas += 1;
      existing.totalPessoas += r.party_size;
      if (isWhatsapp) existing.reservasWhatsapp += 1;
      else existing.reservasSite += 1;
      if (r.date > existing.ultimaVisita) existing.ultimaVisita = r.date;
    } else {
      map.set(key, {
        name: r.customer.name,
        phone: r.customer.phone,
        email: r.customer.email ?? "",
        totalReservas: 1,
        totalPessoas: r.party_size,
        reservasWhatsapp: isWhatsapp ? 1 : 0,
        reservasSite: isWhatsapp ? 0 : 1,
        ultimaVisita: r.date,
      });
    }
  }

  const customers = Array.from(map.values()).sort(
    (a, b) => b.totalReservas - a.totalReservas,
  );

  const csv = toCsv([
    [
      "Nome",
      "Telefone",
      "E-mail",
      "Reservas no período",
      "Total de pessoas",
      "Reservas WhatsApp",
      "Reservas Site",
      "Última visita",
    ],
    ...customers.map((c) => [
      c.name,
      c.phone,
      c.email,
      String(c.totalReservas),
      String(c.totalPessoas),
      String(c.reservasWhatsapp),
      String(c.reservasSite),
      c.ultimaVisita,
    ]),
  ]);

  const filename = `clientes_${fromIso}_${toIso}.csv`;
  downloadBlob(csv, filename);

  return { count: customers.length };
}

export function exportAvaliacoesCsv(
  range: DateRange,
  rows: AvaliacaoRow[],
): { count: number } {
  const fromIso = range.from.toISOString().slice(0, 10);
  const toIso = range.to.toISOString().slice(0, 10);

  const csv = toCsv([
    ["Data", "Hora", "Nome", "Telefone", "E-mail", "Nota", "Comentário"],
    ...rows.map((r) => [
      r.date,
      r.time,
      r.customerName ?? "",
      r.customerPhone ?? "",
      r.customerEmail ?? "",
      String(r.rating),
      r.comment ?? "",
    ]),
  ]);

  const filename = `avaliacoes_${fromIso}_${toIso}.csv`;
  downloadBlob(csv, filename);

  return { count: rows.length };
}
