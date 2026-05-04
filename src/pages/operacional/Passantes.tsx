import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import {
  useWalkIns,
  useCreateWalkIn,
  useUpdateWalkInStatus,
  useDeleteWalkIn,
} from "@/hooks/useWalkIns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatPhone } from "@/lib/utils";
import type { WalkIn, WalkInStatus } from "@/types/reserva";
import { Clock, Plus, Trash2, UtensilsCrossed, Users } from "lucide-react";
import { toast } from "sonner";

const STATUS_CONFIG: Record<WalkInStatus, { label: string; className: string }> = {
  waiting:  { label: "Aguardando", className: "bg-amber-50 text-amber-800 border-amber-200" },
  seated:   { label: "Na mesa",    className: "bg-green-50 text-green-800 border-green-200" },
  left:     { label: "Foi embora", className: "bg-muted text-muted-foreground" },
  no_show:  { label: "Não apareceu", className: "bg-destructive/10 text-destructive border-destructive/20" },
};

function WaitingTime({ arrivedAt }: { arrivedAt: string }) {
  const mins = Math.floor((Date.now() - new Date(arrivedAt).getTime()) / 60_000);
  const className = mins >= 30 ? "text-destructive font-semibold" : mins >= 15 ? "text-amber-600" : "text-muted-foreground";
  return (
    <span className={`flex items-center gap-1 text-xs ${className}`}>
      <Clock className="h-3 w-3" />
      {mins < 1 ? "agora" : `${mins} min`}
    </span>
  );
}

export default function Passantes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [notes, setNotes] = useState("");

  const { data: walkIns, isLoading } = useWalkIns(unitId);
  const createWalkIn = useCreateWalkIn(unitId);
  const updateStatus = useUpdateWalkInStatus(unitId);
  const deleteWalkIn = useDeleteWalkIn(unitId);

  const { data: mesas } = useQuery({
    queryKey: ["mesas", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tables")
        .select("id, number, capacity")
        .eq("unit_id", unitId)
        .eq("active", true)
        .order("number");
      if (error) throw error;
      return data as Array<{ id: string; number: number; capacity: number }>;
    },
    enabled: !!unitId,
  });

  const reset = () => { setName(""); setPhone(""); setPartySize("2"); setNotes(""); };

  const handleCreate = () => {
    if (!name.trim()) { toast.error("Informe o nome do cliente."); return; }
    createWalkIn.mutate(
      { customer_name: name.trim(), customer_phone: phone.replace(/\D/g, "") || null, party_size: Number(partySize), notes: notes.trim() || null },
      { onSuccess: () => { setOpen(false); reset(); } }
    );
  };

  const handleSeat = (walkIn: WalkIn, tableId?: string) => {
    updateStatus.mutate({ id: walkIn.id, status: "seated", table_id: tableId ?? null });
  };

  const waiting = walkIns?.filter((w) => w.status === "waiting") ?? [];
  const seated  = walkIns?.filter((w) => w.status === "seated") ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UtensilsCrossed className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold">Walk-ins</h1>
          {waiting.length > 0 && (
            <Badge className="bg-amber-100 text-amber-800 border-amber-200">
              {waiting.length} aguardando
            </Badge>
          )}
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Registrar
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : !walkIns?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            <UtensilsCrossed className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Nenhum walk-in no momento.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {waiting.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Aguardando ({waiting.length})
              </p>
              {waiting.map((w) => (
                <WalkInCard
                  key={w.id}
                  walkIn={w}
                  mesas={mesas ?? []}
                  onSeat={handleSeat}
                  onStatus={(id, status) => updateStatus.mutate({ id, status })}
                  onDelete={(id) => deleteWalkIn.mutate(id)}
                />
              ))}
            </div>
          )}
          {seated.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Na mesa ({seated.length})
              </p>
              {seated.map((w) => (
                <WalkInCard
                  key={w.id}
                  walkIn={w}
                  mesas={mesas ?? []}
                  onSeat={handleSeat}
                  onStatus={(id, status) => updateStatus.mutate({ id, status })}
                  onDelete={(id) => deleteWalkIn.mutate(id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Formulário de novo walk-in */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Registrar walk-in</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1">
              <Label>Nome do cliente *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: João Silva" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>WhatsApp (opcional)</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 99999-9999" />
              </div>
              <div className="space-y-1">
                <Label>Pessoas *</Label>
                <Select value={partySize} onValueChange={setPartySize}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} {n === 1 ? "pessoa" : "pessoas"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Observações (opcional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex: aniversário, alergia..." />
            </div>
            <Button onClick={handleCreate} disabled={createWalkIn.isPending} className="w-full">
              Registrar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WalkInCard({
  walkIn,
  mesas,
  onSeat,
  onStatus,
  onDelete,
}: {
  walkIn: WalkIn;
  mesas: Array<{ id: string; number: number; capacity: number }>;
  onSeat: (w: WalkIn, tableId?: string) => void;
  onStatus: (id: string, status: WalkInStatus) => void;
  onDelete: (id: string) => void;
}) {
  const [selectedTable, setSelectedTable] = useState("");
  const statusCfg = STATUS_CONFIG[walkIn.status];

  return (
    <Card>
      <CardContent className="py-3 flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <p className="font-medium text-sm">{walkIn.customer_name}</p>
            <Badge variant="outline" className={`text-[10px] ${statusCfg.className}`}>{statusCfg.label}</Badge>
            {walkIn.table && (
              <Badge variant="outline" className="text-[10px]">Mesa {walkIn.table.number}</Badge>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {walkIn.party_size} {walkIn.party_size === 1 ? "pessoa" : "pessoas"}
            </span>
            {walkIn.customer_phone && <span>{formatPhone(walkIn.customer_phone)}</span>}
            <WaitingTime arrivedAt={walkIn.arrived_at} />
          </div>
          {walkIn.notes && (
            <p className="text-xs text-muted-foreground italic mt-1 truncate">{walkIn.notes}</p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {walkIn.status === "waiting" && (
            <>
              <Select value={selectedTable} onValueChange={setSelectedTable}>
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue placeholder="Alocar mesa" />
                </SelectTrigger>
                <SelectContent>
                  {mesas.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      Mesa {m.number} · {m.capacity}p
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={() => onSeat(walkIn, selectedTable || undefined)}>
                Sentar
              </Button>
              <Button size="sm" variant="outline" onClick={() => onStatus(walkIn.id, "no_show")}>
                Não apareceu
              </Button>
            </>
          )}
          {walkIn.status === "seated" && (
            <Button size="sm" variant="outline" onClick={() => onStatus(walkIn.id, "left")}>
              Foi embora
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remover walk-in?</AlertDialogTitle>
                <AlertDialogDescription>O registro será removido permanentemente.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(walkIn.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Remover
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
