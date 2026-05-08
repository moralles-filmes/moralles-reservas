import { useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useWidgets, useCreateWidget } from "@/hooks/useWidgets";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code2, Link2, Plus } from "lucide-react";
import { toast } from "sonner";
import { BreadcrumbReservas } from "./Saloes";

export default function Widget() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const { data: widgets, isLoading } = useWidgets(unitId);
  const createWidget = useCreateWidget(unitId);

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) {
      toast.error("Informe o nome do widget.");
      return;
    }
    createWidget.mutate(
      { name },
      {
        onSuccess: () => {
          toast.success("Widget criado.");
          setCreateOpen(false);
          setNewName("");
        },
        onError: (err: Error) => toast.error(err.message ?? "Erro ao criar widget."),
      },
    );
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current="Widget de Reserva" />
        <h1 className="text-2xl font-bold">Widget de Reserva</h1>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-5 items-start">
        <Card className="p-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-end gap-2 p-4 border-b">
            <Button variant="outline" size="sm" className="gap-2" disabled>
              <Link2 className="h-4 w-4" /> Vincular a um widget
            </Button>
            <Button size="sm" className="gap-2" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> Criar novo widget
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead className="w-32">Slug</TableHead>
                <TableHead className="w-24">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [1, 2].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={3}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : !widgets?.length ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-32 text-center text-muted-foreground space-y-1">
                    <Code2 className="h-6 w-6 mx-auto opacity-30" />
                    <p>Nenhum widget criado ainda.</p>
                    <button
                      className="text-primary underline text-sm"
                      onClick={() => setCreateOpen(true)}
                    >
                      Criar o primeiro
                    </button>
                  </TableCell>
                </TableRow>
              ) : (
                widgets.map((w) => (
                  <TableRow key={w.id} className="cursor-pointer">
                    <TableCell>
                      <Link
                        to={`/g/${unitSlug}/reservas/widget/${w.id}`}
                        className="text-primary hover:underline font-medium"
                      >
                        {w.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{w.slug}</TableCell>
                    <TableCell>
                      <span className={w.active ? "text-success" : "text-muted-foreground"}>
                        {w.active ? "Ativo" : "Inativo"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-4 space-y-3 opacity-60">
          <header className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Exibir banner de cardápio</h3>
            <Switch checked={false} disabled />
          </header>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Quando esta opção está ativada, exibimos um banner com o seu cardápio na tela de
            sucesso do widget.
          </p>
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
            ⚠ Você precisa ter um cardápio ativo para ativar essa função.
          </p>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Criar widget de reserva</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs">
                <span className="text-destructive">*</span> Nome do widget
              </Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ex: Site institucional, Instagram bio…"
              />
            </div>
            <div className="rounded-md border p-3 bg-muted/30 text-xs text-muted-foreground space-y-1">
              <p>O widget será criado vinculado a:</p>
              <p className="font-medium text-foreground">{unit?.unit_name ?? "—"}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleCreate} disabled={createWidget.isPending}>
              {createWidget.isPending ? "Criando…" : "Criar widget"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
