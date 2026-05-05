import { Link } from "react-router-dom";
import { ArrowRight, Bot, Building2 } from "lucide-react";
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

export default function PlatformAutomacao() {
  const { data: units, isLoading } = useAllUnits();

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Automação</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Selecione a unidade para configurar canais de WhatsApp, provedor de IA e
          instruções do agente.
        </p>
      </div>

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
            {!isLoading && (!units || units.length === 0) && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  <Building2 className="mx-auto h-8 w-8 mb-2 opacity-30" />
                  Nenhuma unidade cadastrada ainda.
                </TableCell>
              </TableRow>
            )}
            {units?.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.organization_name}</TableCell>
                <TableCell>{u.name}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {u.slug}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="outline" className="gap-1">
                    <Link to={`/platform/automacao/${u.slug}`}>
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
