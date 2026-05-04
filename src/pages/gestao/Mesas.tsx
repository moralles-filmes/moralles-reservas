import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Mesa } from "@/types/reserva";
import { Lock, Plus, Table2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { useTableBlocks, useCreateTableBlock, useDeleteTableBlock } from "@/hooks/useTableBlocks";

export default function Mesas() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, reset, setValue } = useForm<Omit<Mesa, "id" | "unit_id">>();

  const { data: mesas, isLoading } = useQuery({
    queryKey: ["mesas", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tables")
        .select("*")
        .eq("unit_id", unitId)
        .order("number");
      if (error) throw error;
      return data as Mesa[];
    },
    enabled: !!unitId,
  });

  const createMesa = useMutation({
    mutationFn: async (data: Omit<Mesa, "id" | "unit_id">) => {
      const { error } = await supabase.from("tables").insert({ ...data, unit_id: unitId });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mesas", unitId] });
      toast.success("Mesa criada.");
      setOpen(false);
      reset();
    },
    onError: () => toast.error("Erro ao criar mesa."),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.from("tables").update({ active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mesas", unitId] }),
  });

  const activeMesas = mesas?.filter((m) => m.active) || [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mesas</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Nova mesa</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Nova mesa</DialogTitle></DialogHeader>
            <form
              onSubmit={handleSubmit((d) => createMesa.mutate({ ...d, active: true }))}
              className="space-y-4 mt-2"
            >
              <div className="space-y-1">
                <Label>Número da mesa</Label>
                <Input type="number" min={1} {...register("number", { valueAsNumber: true })} required />
              </div>
              <div className="space-y-1">
                <Label>Capacidade (pessoas)</Label>
                <Input type="number" min={1} max={20} {...register("capacity", { valueAsNumber: true })} required />
              </div>
              <div className="space-y-1">
                <Label>Localização</Label>
                <Select onValueChange={(v) => setValue("location", v as "internal" | "external")}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="internal">Interna</SelectItem>
                    <SelectItem value="external">Externa / Varanda</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={createMesa.isPending}>Criar mesa</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-2 gap-4 text-center">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-3xl font-bold text-success">{activeMesas.length}</p>
            <p className="text-sm text-muted-foreground">Mesas ativas</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-3xl font-bold">{activeMesas.reduce((s, m) => s + m.capacity, 0)}</p>
            <p className="text-sm text-muted-foreground">Capacidade total</p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : !mesas?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Table2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Nenhuma mesa cadastrada. Crie a primeira acima.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {mesas.map((m) => (
            <Card key={m.id} className={!m.active ? "opacity-60" : ""}>
              <CardContent className="py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center font-semibold text-sm">
                    {m.number}
                  </div>
                  <div>
                    <p className="font-medium text-sm">Mesa {m.number}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.capacity} pessoas · {m.location === "internal" ? "Interna" : "Externa"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={m.active ? "default" : "secondary"}>
                    {m.active ? "Ativa" : "Inativa"}
                  </Badge>
                  <Switch
                    checked={m.active}
                    onCheckedChange={(checked) => toggleActive.mutate({ id: m.id, active: checked })}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <TableBlocksSection mesas={mesas ?? []} unitId={unitId} />
    </div>
  );
}

function TableBlocksSection({ mesas, unitId }: { mesas: Mesa[]; unitId: string }) {
  const [open, setOpen] = useState(false);
  const [tableId, setTableId] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");

  const { data: blocks, isLoading } = useTableBlocks(unitId);
  const createBlock = useCreateTableBlock(unitId);
  const deleteBlock = useDeleteTableBlock(unitId);

  const reset = () => { setTableId(""); setFrom(""); setTo(""); setReason(""); };

  const handleCreate = () => {
    if (!tableId || !from || !to) { toast.error("Preencha mesa, início e fim."); return; }
    if (new Date(to) <= new Date(from)) { toast.error("Fim do bloqueio precisa ser depois do início."); return; }
    createBlock.mutate(
      { table_id: tableId, blocked_from: new Date(from).toISOString(), blocked_to: new Date(to).toISOString(), reason: reason.trim() || null },
      { onSuccess: () => { toast.success("Bloqueio criado."); setOpen(false); reset(); }, onError: () => toast.error("Erro ao criar bloqueio.") }
    );
  };

  const formatRange = (fromIso: string, toIso: string) => {
    const fmt = (d: Date) => d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    return `${fmt(new Date(fromIso))} → ${fmt(new Date(toIso))}`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Bloqueios de mesa</CardTitle>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
          <DialogTrigger asChild>
            <Button size="sm" variant="secondary"><Plus className="h-4 w-4 mr-1" /> Novo bloqueio</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Bloquear mesa</DialogTitle></DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-1">
                <Label>Mesa</Label>
                <Select value={tableId} onValueChange={setTableId}>
                  <SelectTrigger><SelectValue placeholder="Selecione a mesa" /></SelectTrigger>
                  <SelectContent>
                    {mesas.map((m) => (
                      <SelectItem key={m.id} value={m.id}>Mesa {m.number} · {m.capacity} pessoas</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Início</Label>
                  <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Fim</Label>
                  <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Motivo (opcional)</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Manutenção, evento privado..." />
              </div>
              <Button onClick={handleCreate} disabled={createBlock.isPending} className="w-full">Criar bloqueio</Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !blocks?.length ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma mesa bloqueada.</p>
        ) : (
          <div className="divide-y">
            {blocks.map((b) => {
              const upcoming = new Date(b.blocked_to) > new Date();
              return (
                <div key={b.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">Mesa {b.table?.number ?? "—"}</span>
                      <Badge variant={upcoming ? "default" : "secondary"} className="text-[10px]">
                        {upcoming ? "Ativo" : "Expirado"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{formatRange(b.blocked_from, b.blocked_to)}</p>
                    {b.reason && <p className="text-xs text-muted-foreground italic mt-0.5 truncate">{b.reason}</p>}
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Remover bloqueio">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remover bloqueio?</AlertDialogTitle>
                        <AlertDialogDescription>
                          A mesa voltará a ficar disponível no período. Esta ação não pode ser desfeita.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => deleteBlock.mutate(b.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Remover
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
