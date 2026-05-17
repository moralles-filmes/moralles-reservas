import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuditLog } from "@/hooks/useAuditLog";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import type { AuditAction, AuditLogEntry } from "@/types/reserva";
import { ScrollText } from "lucide-react";

const ACTION_LABEL: Record<AuditAction, string> = {
  INSERT: "Criou",
  UPDATE: "Alterou",
  DELETE: "Removeu",
};

const ACTION_VARIANT: Record<AuditAction, "default" | "secondary" | "destructive"> = {
  INSERT: "default",
  UPDATE: "secondary",
  DELETE: "destructive",
};

const TABLE_LABEL: Record<string, string> = {
  customers: "Cliente",
  reservations: "Reserva",
  unit_members: "Membro da unidade",
};

const PAGE_SIZE = 50;

export default function Auditoria() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const organizationId = unit?.organization_id ?? "";

  const [tableFilter, setTableFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);
  const [page, setPage] = useState(0);
  const [accumulated, setAccumulated] = useState<AuditLogEntry[]>([]);

  const { data: entries, isLoading, isError, refetch, isFetching } = useAuditLog(
    unitId,
    organizationId,
    {
      table: tableFilter === "all" ? undefined : tableFilter,
      action: actionFilter === "all" ? undefined : actionFilter,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    },
  );

  // Reset acumulado quando filtros mudam (volta pra página 0)
  useEffect(() => {
    setPage(0);
    setAccumulated([]);
  }, [tableFilter, actionFilter, unitId, organizationId]);

  // Append a cada nova página carregada
  useEffect(() => {
    if (!entries) return;
    setAccumulated((prev) => (page === 0 ? entries : [...prev, ...entries]));
  }, [entries, page]);

  const hasMore = (entries?.length ?? 0) === PAGE_SIZE;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ScrollText className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Auditoria</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Registro de quem alterou clientes, reservas e membros da unidade, quando e o que mudou.
      </p>

      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Tabela</Label>
          <Select value={tableFilter} onValueChange={setTableFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="customers">Clientes</SelectItem>
              <SelectItem value="reservations">Reservas</SelectItem>
              <SelectItem value="unit_members">Membros da unidade</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Ação</Label>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="INSERT">Criação</SelectItem>
              <SelectItem value="UPDATE">Alteração</SelectItem>
              <SelectItem value="DELETE">Exclusão</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && accumulated.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-sm text-destructive">Erro ao carregar a auditoria.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : !accumulated.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhum registro de auditoria.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {accumulated.map((e) => (
            <Card
              key={e.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(e)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSelected(e); }
              }}
              className="hover:shadow-sm transition-shadow cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <CardContent className="py-3 flex items-center gap-3 flex-wrap">
                <Badge variant={ACTION_VARIANT[e.action]} className="text-[10px]">
                  {ACTION_LABEL[e.action]}
                </Badge>
                <span className="text-sm font-medium">
                  {TABLE_LABEL[e.table_name] ?? e.table_name}
                </span>
                <code className="text-xs text-muted-foreground font-mono">
                  #{e.id}
                </code>
                <span className="text-xs text-muted-foreground ml-auto">
                  {formatTimestamp(e.created_at)}
                </span>
                <span className="text-xs text-muted-foreground w-full sm:w-auto sm:ml-3">
                  por {e.actor_email ?? <em>sistema</em>}
                </span>
              </CardContent>
            </Card>
          ))}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={isFetching}
              >
                {isFetching ? "Carregando..." : "Carregar mais"}
              </Button>
            </div>
          )}
        </div>
      )}

      <AuditDetailsDialog entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function AuditDetailsDialog({ entry, onClose }: { entry: AuditLogEntry | null; onClose: () => void }) {
  if (!entry) return null;
  const changed = computeChanges(entry);

  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {ACTION_LABEL[entry.action]} {TABLE_LABEL[entry.table_name] ?? entry.table_name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div>
              <span className="font-medium">Quando:</span>{" "}
              {formatTimestamp(entry.created_at)}
            </div>
            <div>
              <span className="font-medium">Por:</span>{" "}
              {entry.actor_email ?? "sistema (Edge Function)"}
            </div>
            <div className="col-span-2">
              <span className="font-medium">ID do registro:</span>{" "}
              <code className="font-mono">{entry.record_id}</code>
            </div>
          </div>

          {changed.length > 0 ? (
            <div className="rounded-lg border divide-y">
              {changed.map(({ field, before, after }) => (
                <div key={field} className="p-3 grid grid-cols-[120px,1fr] gap-3 items-start">
                  <div className="text-xs font-mono text-muted-foreground pt-0.5">{field}</div>
                  <div className="space-y-1">
                    {entry.action === "UPDATE" && (
                      <div className="text-xs line-through text-muted-foreground break-all">{fmt(before)}</div>
                    )}
                    <div className="text-xs break-all">
                      {entry.action === "DELETE" ? fmt(before) : fmt(after)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">Sem alterações de campos.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function computeChanges(entry: AuditLogEntry): Array<{ field: string; before: unknown; after: unknown }> {
  const old = entry.old_values ?? {};
  const next = entry.new_values ?? {};

  if (entry.action === "INSERT") {
    return Object.entries(next)
      .filter(([k]) => !["created_at", "updated_at"].includes(k))
      .map(([field, after]) => ({ field, before: undefined, after }));
  }
  if (entry.action === "DELETE") {
    return Object.entries(old)
      .filter(([k]) => !["created_at", "updated_at"].includes(k))
      .map(([field, before]) => ({ field, before, after: undefined }));
  }
  const keys = new Set([...Object.keys(old), ...Object.keys(next)]);
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const k of keys) {
    if (k === "updated_at") continue;
    const a = (old as Record<string, unknown>)[k];
    const b = (next as Record<string, unknown>)[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field: k, before: a, after: b });
  }
  return changes;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR");
}
