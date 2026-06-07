import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useWaitlist,
  useAddToWaitlist,
  useUpdateWaitlistStatus,
  useNotifyWaitlist,
  useRemoveFromWaitlist,
} from "@/hooks/useWaitlist";
import {
  WAITLIST_TEMPLATES,
  renderWaitlistTemplate,
  useWaitlistTemplates,
} from "@/hooks/useWaitlistTemplates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PartySizeInput } from "@/components/reserva/wizard/PartySizeInput";
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
import type {
  WaitlistEntry,
  WaitlistPriorityCategory,
  WaitlistStatus,
} from "@/types/reserva";
import { Accessibility, AlertCircle, Baby, Bell, Clock, Plus, Trash2, UserCircle2, Users } from "lucide-react";
import { toast } from "sonner";

const STATUS_CONFIG: Record<WaitlistStatus, { label: string; className: string }> = {
  waiting:   { label: "Aguardando", className: "bg-amber-50 text-amber-800 border-amber-200" },
  notified:  { label: "Notificado", className: "bg-blue-50 text-blue-800 border-blue-200" },
  seated:    { label: "Sentou",     className: "bg-green-50 text-green-800 border-green-200" },
  cancelled: { label: "Cancelado",  className: "bg-muted text-muted-foreground" },
};

const PRIORITY_CONFIG: Record<
  Exclude<WaitlistPriorityCategory, "normal">,
  { label: string; icon: typeof UserCircle2 }
> = {
  senior:   { label: "Idoso",    icon: UserCircle2 },
  pregnant: { label: "Gestante", icon: Baby },
  disabled: { label: "PCD",      icon: Accessibility },
  other:    { label: "Prioridade", icon: Accessibility },
};

function WaitingTime({ createdAt }: { createdAt: string }) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
  const className = mins >= 30 ? "text-destructive font-semibold" : mins >= 15 ? "text-amber-600" : "text-muted-foreground";
  return (
    <span className={`flex items-center gap-1 text-xs ${className}`}>
      <Clock className="h-3 w-3" />
      {mins < 1 ? "agora" : `${mins} min`}
    </span>
  );
}

export default function Fila() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [requestedTime, setRequestedTime] = useState("");
  const [notes, setNotes] = useState("");
  // Pendings por entry id — botões "Notificar" ficam independentes entre si.
  const [notifyingIds, setNotifyingIds] = useState<Set<string>>(new Set());

  const { data: waitlist, isLoading, isError, refetch } = useWaitlist(unitId);
  const { data: templates } = useWaitlistTemplates(unitId);
  const addToWaitlist = useAddToWaitlist(unitId);
  const updateStatus = useUpdateWaitlistStatus(unitId);
  const notifyEntry = useNotifyWaitlist(unitId);
  const removeEntry = useRemoveFromWaitlist(unitId);

  // updateStatus é compartilhado entre todas as entries — pra evitar double-click
  // sem desabilitar TODOS os botões da lista, checamos por id usando o `variables`
  // que o TanStack expõe enquanto o mutate está em flight.
  const isUpdatingEntry = (id: string) =>
    updateStatus.isPending && updateStatus.variables?.id === id;

  const reset = () => { setName(""); setPhone(""); setPartySize(2); setRequestedTime(""); setNotes(""); };

  const handleAdd = () => {
    if (!name.trim()) { toast.error("Informe o nome do cliente."); return; }
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits && phoneDigits.length < 10) {
      toast.error("Telefone inválido. Informe DDD + número (ex: 11999998888).");
      return;
    }
    addToWaitlist.mutate(
      {
        customer_name: name.trim(),
        customer_phone: phoneDigits || null,
        party_size: partySize,
        requested_for_time: requestedTime || null,
        notes: notes.trim() || null,
      },
      { onSuccess: () => { setOpen(false); reset(); } }
    );
  };

  const handleNotify = (entry: WaitlistEntry) => {
    if (!entry.customer_phone) {
      toast.error("Este cliente não tem WhatsApp cadastrado.");
      return;
    }
    if (notifyingIds.has(entry.id)) return; // evita double-click na mesma entry

    // Usa o template `table_ready` customizado, se houver. Senão, padrão.
    // `.trim()` garante paridade com o que as edge functions fazem.
    const tpl = templates?.find((t) => t.event === "table_ready");
    const defaultBody =
      WAITLIST_TEMPLATES.find((t) => t.event === "table_ready")?.defaultBody ?? "";
    const body = tpl?.customized && tpl.body && tpl.body.trim() ? tpl.body : defaultBody;

    const message = renderWaitlistTemplate(body, {
      cliente_nome: entry.customer_name,
      // Fallback consistente com edge functions (evita "sua mesa em  está pronta").
      unidade_nome: unit?.unit_name || "nosso restaurante",
      party_size: entry.party_size,
      codigo_fila: entry.code,
      link_status: `${window.location.origin}/r/${unit?.unit_slug ?? ""}`,
    });

    setNotifyingIds((prev) => {
      const next = new Set(prev);
      next.add(entry.id);
      return next;
    });
    notifyEntry.mutate(
      { id: entry.id, phone: entry.customer_phone, message },
      {
        onSettled: () => {
          setNotifyingIds((prev) => {
            const next = new Set(prev);
            next.delete(entry.id);
            return next;
          });
        },
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold">Fila de espera</h1>
          {waitlist && waitlist.length > 0 && (
            <Badge className="bg-amber-100 text-amber-800 border-amber-200">
              {waitlist.length} na fila
            </Badge>
          )}
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Adicionar
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : isError ? (
        <Card className="border-destructive">
          <CardContent className="py-8 flex flex-col items-center gap-3 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm font-medium">Erro ao carregar a fila de espera.</p>
            <p className="text-xs text-muted-foreground">
              Verifique sua conexão e tente novamente.
            </p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Tentar de novo
            </Button>
          </CardContent>
        </Card>
      ) : !waitlist?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Fila de espera vazia.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {waitlist.map((entry, idx) => {
            const statusCfg = STATUS_CONFIG[entry.status];
            const priorityCfg =
              entry.priority_category && entry.priority_category !== "normal"
                ? PRIORITY_CONFIG[entry.priority_category]
                : null;
            const PriorityIcon = priorityCfg?.icon;
            return (
              <Card key={entry.id}>
                <CardContent className="py-3 flex items-start gap-4 flex-wrap">
                  <div className="flex flex-col items-center gap-0.5 shrink-0">
                    {entry.code != null ? (
                      <div className="h-10 w-10 rounded-md bg-primary/10 text-primary flex items-center justify-center text-base font-bold font-mono">
                        #{entry.code}
                      </div>
                    ) : (
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-sm font-bold">
                        {idx + 1}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="font-medium text-sm">{entry.customer_name}</p>
                      <Badge variant="outline" className={`text-[10px] ${statusCfg.className}`}>
                        {statusCfg.label}
                      </Badge>
                      {priorityCfg && PriorityIcon && (
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-muted text-foreground border-border gap-1"
                        >
                          <PriorityIcon className="h-3 w-3" />
                          {priorityCfg.label}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {entry.party_size} {entry.party_size === 1 ? "pessoa" : "pessoas"}
                      </span>
                      {entry.customer_phone && <span>{formatPhone(entry.customer_phone)}</span>}
                      {entry.requested_for_time && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Prefere {entry.requested_for_time.slice(0, 5)}
                        </span>
                      )}
                      <WaitingTime createdAt={entry.created_at} />
                    </div>
                    {entry.notes && (
                      <p className="text-xs text-muted-foreground italic mt-1 truncate">{entry.notes}</p>
                    )}
                    {entry.notified_at && (
                      <p className="text-xs text-blue-600 mt-1">
                        Notificado às {new Date(entry.notified_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    {entry.status === "waiting" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1"
                          onClick={() => handleNotify(entry)}
                          disabled={!entry.customer_phone || notifyingIds.has(entry.id)}
                        >
                          <Bell className="h-3 w-3" />
                          Notificar
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => updateStatus.mutate({ id: entry.id, status: "seated" })}
                          disabled={isUpdatingEntry(entry.id)}
                        >
                          Sentar
                        </Button>
                      </>
                    )}
                    {entry.status === "notified" && (
                      <Button
                        size="sm"
                        onClick={() => updateStatus.mutate({ id: entry.id, status: "seated" })}
                        disabled={isUpdatingEntry(entry.id)}
                      >
                        Confirmar entrada
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
                          <AlertDialogTitle>Remover da fila?</AlertDialogTitle>
                          <AlertDialogDescription>
                            O cliente será removido da fila de espera.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={removeEntry.isPending}>Cancelar</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => removeEntry.mutate(entry.id)}
                            disabled={removeEntry.isPending}
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
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Adicionar à fila</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1">
              <Label>Nome do cliente *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Maria Costa" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>WhatsApp (opcional)</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 99999-9999" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fila-party">Pessoas *</Label>
                {/* enter_waitlist: anon trava em 20; operador não tem cap no DB — 20 mantido por consistência de UI. */}
                <PartySizeInput
                  id="fila-party"
                  value={partySize}
                  onChange={setPartySize}
                  max={20}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Horário preferencial (opcional)</Label>
              <Input type="time" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Observações (opcional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex: aniversário, alergia..." />
            </div>
            <Button onClick={handleAdd} disabled={addToWaitlist.isPending} className="w-full">
              Adicionar à fila
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
