import type { KpiDelta } from "@/lib/relatorio-passantes";

/** Segundos -> "<1 min", "23 min" ou "1h 05min" ("0:02" se lia como segundos). */
export function formatHM(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return "<1 min";
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? `${m} min` : `${h}h ${String(m).padStart(2, "0")}min`;
}

/** Bucket "03-04" -> "3–4"; "20+" fica. */
export function bucketLabel(bucket: string): string {
  const m = /^(\d+)-(\d+)$/.exec(bucket);
  return m ? `${Number(m[1])}–${Number(m[2])}` : bucket;
}

export function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function formatDecimal(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "+12% vs período anterior" / "-3,2 p.p. vs período anterior"; null sem base. */
export function deltaText(d: KpiDelta | undefined): string | null {
  if (!d || d.delta == null || !Number.isFinite(d.delta)) return null;
  const rounded = Math.round(d.delta * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const num = rounded.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  const unit = d.unit === "pp" ? " p.p." : "%";
  return `${sign}${num}${unit} vs período anterior`;
}
