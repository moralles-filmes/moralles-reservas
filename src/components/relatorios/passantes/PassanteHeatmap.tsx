import type { PassanteHeatRow } from "@/lib/relatorio-passantes";

interface Props {
  rows: PassanteHeatRow[];
  max: number;
}

/** Hora x dia da semana. Intensidade = opacidade do token de cor do tema. */
export function PassanteHeatmap({ rows, max }: Props) {
  // Só a faixa de horas com dados (±1h), como no gráfico por horário.
  const active = new Set<number>();
  for (const r of rows) r.hours.forEach((v, h) => v > 0 && active.add(h));
  const lo = active.size ? Math.max(0, Math.min(...active) - 1) : 0;
  const hi = active.size ? Math.min(23, Math.max(...active) + 1) : 23;
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  return (
    <div className="overflow-x-auto">
      <div
        className="grid gap-1 min-w-[520px]"
        style={{ gridTemplateColumns: `2.5rem repeat(${hours.length}, minmax(0, 1fr))` }}
        role="table"
        aria-label="Mapa de calor de chegadas por dia da semana e hora"
      >
        <div />
        {hours.map((h) => (
          <div key={h} className="text-[10px] text-center text-muted-foreground">
            {h}h
          </div>
        ))}
        {rows.map((r) => (
          <div key={r.dow} className="contents" role="row">
            <div className="text-xs text-muted-foreground self-center">{r.label}</div>
            {hours.map((h) => {
              const v = r.hours[h] ?? 0;
              const intensity = max > 0 ? v / max : 0;
              const text = `${r.label} ${h}h: ${v} ${v === 1 ? "grupo" : "grupos"}`;
              return (
                <div
                  key={h}
                  role="cell"
                  aria-label={text}
                  title={text}
                  className="relative h-7 rounded-sm bg-muted/40"
                >
                  {v > 0 && (
                    <div
                      className="absolute inset-0 rounded-sm"
                      style={{
                        background: "hsl(var(--chart-geral))",
                        opacity: 0.15 + 0.85 * intensity,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
