import { useEffect, useState, type ReactNode } from "react";
import { STATUS_LABELS, type Mesa, type OccupantTable, type ReservaComCliente } from "@/types/reserva";
import { reservationLiveSituation, reservationTableIds, tableInUse, type TableState } from "@/lib/table-situation-core";
import { formatPhone } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ReservaDetalhe } from "./ReservaDetalhe";

interface Props {
  /** Reservas do dia, inclusive `no_show`/`cancelled` de hoje (só para a lista). */
  reservations: ReservaComCliente[];
  tables: Mesa[];
  occupantTables: OccupantTable[];
  states: Map<string, TableState>;
  /** "Hoje" em BRT (YYYY-MM-DD). */
  today: string;
  now: Date;
  durationMinutes: number;
  /** Mesa principal da reserva (null quando não tem) e a própria reserva. */
  onPick: (table: Mesa | null, reservationId: string) => void;
  /** Ações do card; `close` fecha o card antes de entrar no modo de escolha de mesa. */
  renderActions: (r: ReservaComCliente, close: () => void) => ReactNode;
}

type SectionKey = "a-chegar" | "sentadas" | "finalizadas";

const ROW =
  "flex min-h-11 w-full flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-[44px]";

/** Sem acento, sem caixa: "João" casa com "joao". */
const normalize = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const isActive = (r: ReservaComCliente) => r.status === "pending" || r.status === "confirmed";

const byTime = (a: ReservaComCliente, b: ReservaComCliente) => a.time.localeCompare(b.time);

const byArrival = (a: ReservaComCliente, b: ReservaComCliente) =>
  new Date(a.arrived_at ?? 0).getTime() - new Date(b.arrived_at ?? 0).getTime();

const customerName = (r: ReservaComCliente) => r.customer?.name?.trim() || "Cliente";

export function ReservasDoDia({
  reservations,
  tables,
  occupantTables,
  states,
  today,
  now,
  durationMinutes,
  onPick,
  renderActions,
}: Props) {
  const [search, setSearch] = useState("");
  const [showFinished, setShowFinished] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const narrow = useMediaQuery("(max-width: 639px)");

  // O card relê a reserva da lista a cada atualização; se ela sumir, fecha.
  const opened = openId ? (reservations.find((r) => r.id === openId) ?? null) : null;
  useEffect(() => {
    if (openId && !opened) setOpenId(null);
  }, [openId, opened]);
  const close = () => setOpenId(null);

  const tableIdsOf = (r: ReservaComCliente) => reservationTableIds(r.id, { reservations, occupantTables });
  const tablesOf = (r: ReservaComCliente) => {
    const ids = tableIdsOf(r);
    return tables.filter((t) => ids.includes(t.id));
  };
  const tablesLabel = (r: ReservaComCliente) => {
    const numbers = tablesOf(r).map((t) => t.number).sort((a, b) => a - b);
    if (numbers.length > 0) return `${numbers.length > 1 ? "Mesas" : "Mesa"} ${numbers.join("+")}`;
    return tableIdsOf(r).length > 0 ? "Mesa fora da planta" : "Sem mesa";
  };
  const mainTable = (r: ReservaComCliente): Mesa | null =>
    tables.find((t) => t.id === r.table_id) ?? tablesOf(r)[0] ?? null;

  const query = normalize(search);
  const digits = query.replace(/\D/g, "");
  const matches = (r: ReservaComCliente) => {
    if (!query) return true;
    if (normalize(r.customer?.name ?? "").includes(query)) return true;
    return digits.length > 0 && (r.customer?.phone ?? "").replace(/\D/g, "").includes(digits);
  };
  const visible = reservations.filter(matches);

  const sections: Array<{ key: SectionKey; title: string; empty: string; rows: ReservaComCliente[] }> = [
    {
      key: "a-chegar",
      title: "A chegar",
      empty: "Nenhuma reserva a chegar",
      rows: visible.filter((r) => r.date === today && isActive(r) && !r.arrived_at && !r.released_at).sort(byTime),
    },
    {
      key: "sentadas",
      title: "Sentadas",
      empty: "Ninguém sentado",
      rows: visible.filter((r) => isActive(r) && !!r.arrived_at && !r.released_at).sort(byArrival),
    },
    {
      key: "finalizadas",
      title: "Finalizadas",
      empty: "Nenhuma finalizada",
      rows: visible
        .filter((r) => r.date === today && (isActive(r) ? !!r.released_at : true))
        .sort(byTime),
    },
  ];
  const nothingFound = query !== "" && sections.every((s) => s.rows.length === 0);

  const open = (r: ReservaComCliente) => {
    onPick(mainTable(r), r.id);
    setOpenId(r.id);
  };

  const renderRow = (r: ReservaComCliente, section: SectionKey) => {
    const live = reservationLiveSituation(r, now, durationMinutes);
    const inUse = tableInUse(r, states, tableIdsOf(r), now);
    const phone = r.customer?.phone;
    return (
      <li key={r.id}>
        <button type="button" className={ROW} onClick={() => open(r)}>
          <span className="flex w-full items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium">{customerName(r)}</span>
            <span className="text-sm tabular-nums">{r.time.slice(0, 5)}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {tablesLabel(r)}
            {phone ? ` · ${formatPhone(phone)}` : ""}
          </span>
          <span className="flex flex-wrap gap-1.5">
            {section === "finalizadas" ? (
              <StatusPill tone="muted">{isActive(r) ? "Mesa liberada" : STATUS_LABELS[r.status]}</StatusPill>
            ) : (
              live && <StatusPill tone={live.tone}>{live.label}</StatusPill>
            )}
            {inUse && (
              <span className="rounded-md border border-status-late/40 bg-status-late/10 px-2 py-0.5 text-xs font-medium text-foreground">
                Mesa em uso
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <section data-testid="reservas-do-dia" className="surface rounded-lg p-4">
      <h2 className="mb-2 text-sm font-semibold">Reservas de hoje</h2>
      <Input
        type="search"
        aria-label="Buscar por nome ou telefone"
        placeholder="Buscar por nome ou telefone"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="coarse:min-h-[44px]"
      />

      {nothingFound ? (
        <p className="mt-3 text-sm text-muted-foreground">Nenhuma reserva encontrada</p>
      ) : (
        sections.map((s) => {
          const collapsed = s.key === "finalizadas" && !showFinished;
          const heading = `${s.title} (${s.rows.length})`;
          return (
            <section key={s.key} data-testid={`reservas-${s.key}`} className="mt-4">
              <h3 className="mb-1 text-sm font-semibold">
                {s.key === "finalizadas" ? (
                  <button
                    type="button"
                    aria-expanded={showFinished}
                    onClick={() => setShowFinished((v) => !v)}
                    className="min-h-11 rounded-md text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-[44px]"
                  >
                    {heading}
                  </button>
                ) : (
                  heading
                )}
              </h3>
              {!collapsed &&
                (s.rows.length > 0 ? (
                  <ul className="space-y-1">{s.rows.map((r) => renderRow(r, s.key))}</ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{s.empty}</p>
                ))}
            </section>
          );
        })
      )}

      {/* Não modal: a mesa destacada segue visível e tocável na cena. */}
      <Sheet open={opened !== null} onOpenChange={(isOpen) => !isOpen && close()} modal={false}>
        <SheetContent side={narrow ? "bottom" : "right"} overlay={false} aria-describedby={undefined}>
          {opened && (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(opened)}</SheetTitle>
              </SheetHeader>
              <ReservaDetalhe
                reserva={opened}
                tableNumbers={tablesOf(opened).map((t) => t.number)}
                now={now}
                durationMinutes={durationMinutes}
                inUse={tableInUse(opened, states, tableIdsOf(opened), now)}
                actions={renderActions(opened, close)}
              />
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
