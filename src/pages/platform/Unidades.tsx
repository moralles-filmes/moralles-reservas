import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Building2, Store, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAllUnits } from "@/hooks/useAllUnits";

export default function PlatformUnidades() {
  const { data: units, isLoading, isError, error, refetch } = useAllUnits();
  const [searchParams] = useSearchParams();
  const empresa = searchParams.get("empresa");

  const visible = empresa ? (units ?? []).filter((u) => u.organization_id === empresa) : units ?? [];
  const empresaName = empresa ? visible[0]?.organization_name : null;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Unidades</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Configure WhatsApp, IA, instruções do agente e pagamentos de cada unidade.
        </p>
      </div>

      {empresa && (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span>
            {empresaName ? (
              <>
                Unidades de <span className="font-medium">{empresaName}</span>
              </>
            ) : (
              "Unidades desta empresa"
            )}
          </span>
          <Button asChild size="sm" variant="ghost" className="gap-1 h-7">
            <Link to="/platform/unidades">
              <X className="h-3.5 w-3.5" />
              Ver todas
            </Link>
          </Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Empresa</TableHead>
              <TableHead>Unidade</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead className="w-[160px] text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  Carregando…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && isError && (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 space-y-3">
                  <p className="text-sm text-destructive">{error?.message ?? "Falha ao carregar unidades."}</p>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>
                    Tentar novamente
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !isError && visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  <Building2 className="mx-auto h-8 w-8 mb-2 opacity-30" />
                  {empresa ? "Nenhuma unidade para esta empresa." : "Nenhuma unidade cadastrada ainda."}
                </TableCell>
              </TableRow>
            )}
            {!isLoading &&
              !isError &&
              visible.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.organization_name}</TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{u.slug}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline" className="gap-1">
                      <Link to={`/platform/unidades/${u.slug}`}>
                        Configurar
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
