import type { KpiDelta } from "@/lib/relatorio-passantes";

/** Segundos -> "h:mm" (ex.: 4980 -> "1:23"). */
export function formatHM(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
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
