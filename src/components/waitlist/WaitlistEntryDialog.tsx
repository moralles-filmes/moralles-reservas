import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PartySizeInput } from "@/components/reserva/wizard/PartySizeInput";
import { useAddToWaitlist, useUpdateWaitlistEntry } from "@/hooks/useWaitlist";
import { validateBrPhone } from "@/lib/phone";
import type { WaitlistEntry } from "@/types/reserva";
import { toast } from "sonner";

interface Props {
  unitId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Presente = modo editar (preenche os campos); ausente/null = modo adicionar. */
  entry?: WaitlistEntry | null;
}

export function WaitlistEntryDialog({ unitId, open, onOpenChange, entry }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? "Editar cliente" : "Adicionar à fila"}</DialogTitle>
        </DialogHeader>
        {/* Radix desmonta o conteúdo ao fechar: o formulário reabre sempre com os valores de `entry`. */}
        <WaitlistEntryForm unitId={unitId} entry={entry ?? null} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function WaitlistEntryForm({
  unitId,
  entry,
  onDone,
}: {
  unitId: string;
  entry: WaitlistEntry | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(entry?.customer_name ?? "");
  const [phone, setPhone] = useState(entry?.customer_phone ?? "");
  const [partySize, setPartySize] = useState(entry?.party_size ?? 2);
  // requested_for_time vem como "HH:MM:SS" do Postgres; <input type="time"> quer "HH:MM".
  const [requestedTime, setRequestedTime] = useState(
    entry?.requested_for_time ? entry.requested_for_time.slice(0, 5) : "",
  );
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const addToWaitlist = useAddToWaitlist(unitId);
  const updateEntry = useUpdateWaitlistEntry(unitId);

  const handleSubmit = () => {
    if (!name.trim()) { toast.error("Informe o nome do cliente."); return; }
    const { valid, reason, digits: phoneDigits } = validateBrPhone(phone, { allowEmpty: true });
    if (!valid) { toast.error(reason); return; }
    const onSuccess = () => onDone();
    if (entry) {
      updateEntry.mutate(
        {
          id: entry.id,
          customer_name: name.trim(),
          customer_phone: phoneDigits || null,
          party_size: partySize,
          requested_for_time: requestedTime || null,
          notes: notes.trim() || null,
        },
        { onSuccess },
      );
    } else {
      addToWaitlist.mutate(
        {
          customer_name: name.trim(),
          customer_phone: phoneDigits || null,
          party_size: partySize,
          requested_for_time: requestedTime || null,
          notes: notes.trim() || null,
        },
        { onSuccess },
      );
    }
  };

  return (
    <div className="space-y-4 mt-2">
      <div className="space-y-1">
        <Label htmlFor="fila-name">Nome do cliente *</Label>
        <Input id="fila-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Maria Costa" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="fila-phone">WhatsApp (opcional)</Label>
          <Input id="fila-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 99999-9999" />
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
        <Label htmlFor="fila-requested-time">Horário preferencial (opcional)</Label>
        <Input id="fila-requested-time" type="time" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="fila-notes">Observações (opcional)</Label>
        <Input id="fila-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex: aniversário, alergia..." />
      </div>
      <Button
        onClick={handleSubmit}
        disabled={entry ? updateEntry.isPending : addToWaitlist.isPending}
        className="w-full"
      >
        {entry ? "Salvar alterações" : "Adicionar à fila"}
      </Button>
    </div>
  );
}
