import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Mesa } from "@/types/reserva";
import { Plus, Table2 } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";

export default function Mesas() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, reset, setValue } = useForm<Omit<Mesa, "id">>();

  const { data: mesas, isLoading } = useQuery({
    queryKey: ["mesas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tables")
        .select("*")
        .order("number");
      if (error) throw error;
      return data as Mesa[];
    },
  });

  const createMesa = useMutation({
    mutationFn: async (data: Omit<Mesa, "id">) => {
      const { error } = await supabase.from("tables").insert(data);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mesas"] });
      toast.success("Mesa criada.");
      setOpen(false);
      reset();
    },
    onError: () => toast.error("Erro ao criar mesa."),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from("tables")
        .update({ active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mesas"] }),
  });

  const activeMesas = mesas?.filter((m) => m.active) || [];
  const inactiveMesas = mesas?.filter((m) => !m.active) || [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mesas</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> Nova mesa
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Nova mesa</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={handleSubmit((d) => createMesa.mutate({ ...d, active: true }))}
              className="space-y-4 mt-2"
            >
              <div className="space-y-1">
                <Label>Número da mesa</Label>
                <Input
                  type="number"
                  min={1}
                  {...register("number", { valueAsNumber: true })}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label>Capacidade (pessoas)</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  {...register("capacity", { valueAsNumber: true })}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label>Localização</Label>
                <Select onValueChange={(v) => setValue("location", v as "internal" | "external")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="internal">Interna</SelectItem>
                    <SelectItem value="external">Externa / Varanda</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={createMesa.isPending}>
                Criar mesa
              </Button>
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
            <p className="text-3xl font-bold">
              {activeMesas.reduce((s, m) => s + m.capacity, 0)}
            </p>
            <p className="text-sm text-muted-foreground">Capacidade total</p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
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
                    onCheckedChange={(checked) =>
                      toggleActive.mutate({ id: m.id, active: checked })
                    }
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
