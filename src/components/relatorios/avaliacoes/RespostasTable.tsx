import { useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Download, Star } from "lucide-react";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { StarRating } from "@/components/dashboard/StarRating";
import type { AvaliacaoRow } from "@/hooks/useAvaliacoes";

interface RespostasTableProps {
  rows: AvaliacaoRow[];
  loading?: boolean;
  onExport?: () => void;
}

const PAGE_SIZE_OPTIONS = [15, 30, 50] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

type RatingFilter = "all" | "5" | "4" | "3" | "2" | "1";

function truncate(text: string, max = 60): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export function RespostasTable({ rows, loading, onExport }: RespostasTableProps) {
  const [filter, setFilter] = useState<RatingFilter>("all");
  const [pageSize, setPageSize] = useState<PageSize>(15);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    const target = parseInt(filter, 10);
    return rows.filter((r) => r.rating === target);
  }, [rows, filter]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const visible = filtered.slice(start, start + pageSize);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-base font-semibold">Respostas</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {onExport && (
              <Button
                variant="outline"
                size="sm"
                onClick={onExport}
                disabled={total === 0}
                className="gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                Exportar CSV
              </Button>
            )}
            <Select
              value={filter}
              onValueChange={(v) => {
                setFilter(v as RatingFilter);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-44 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as respostas</SelectItem>
                <SelectItem value="5">5 estrelas</SelectItem>
                <SelectItem value="4">4 estrelas</SelectItem>
                <SelectItem value="3">3 estrelas</SelectItem>
                <SelectItem value="2">2 estrelas</SelectItem>
                <SelectItem value="1">1 estrela</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Carregando…
          </div>
        ) : total === 0 ? (
          <div className="py-12 text-center text-muted-foreground space-y-2">
            <Star className="h-6 w-6 mx-auto opacity-30" />
            <p className="text-sm">
              {filter === "all"
                ? "Nenhuma avaliação no período."
                : `Nenhuma avaliação com ${filter} estrela${filter === "1" ? "" : "s"} no período.`}
            </p>
          </div>
        ) : (
          <TooltipProvider delayDuration={150}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Comentário</TableHead>
                  <TableHead>Data da visita</TableHead>
                  <TableHead>Nota</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      {r.customerName || "—"}
                    </TableCell>
                    <TableCell>
                      {r.customerPhone ? formatPhone(r.customerPhone) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.customerEmail || "—"}
                    </TableCell>
                    <TableCell>
                      {r.comment ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-sm cursor-help">
                              {truncate(r.comment)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm">
                            <p className="text-sm whitespace-pre-wrap">{r.comment}</p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDateBR(r.date)} às {r.time?.slice(0, 5) ?? r.time}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <StarRating value={r.rating} />
                        <span className="text-xs text-muted-foreground">
                          {r.rating}/5
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TooltipProvider>
        )}

        {total > 0 && (
          <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
            <p className="text-xs text-muted-foreground">
              Total de {total} resposta{total === 1 ? "" : "s"}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground min-w-[3rem] text-center">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(parseInt(v, 10) as PageSize);
                  setPage(0);
                }}
              >
                <SelectTrigger className="w-28 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((s) => (
                    <SelectItem key={s} value={String(s)}>
                      {s} / página
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
