import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDateBR } from "@/lib/utils";
import { useReservaWizardContext } from "./useReservaWizard";

/**
 * Tela de sucesso pós-submit. Mostra código, data, hora e party_size,
 * com CTA pra criar outra reserva (reseta o wizard).
 */
export function WizardSuccess() {
  const { state, actions } = useReservaWizardContext();
  const reserva = state.confirmed;
  if (!reserva) return null;
  if (reserva.status !== "confirmed" || reserva.payment_status !== "not_required") {
    return (
      <div role="alert" className="text-center space-y-2 py-2">
        <h2 className="text-xl font-semibold">Estado da reserva não confirmado</h2>
        <p className="text-sm text-muted-foreground">
          Consulte o restaurante com o código #{reserva.reservation_code} antes de tentar novamente.
        </p>
      </div>
    );
  }
  // Reenvio do mesmo pedido: nada foi criado agora; a mesa que vale é a da
  // reserva existente, então a escolhida nesta tentativa não aparece.
  const alreadyExisted = reserva.already_existed === true;
  return (
    <div className="text-center space-y-5 py-2">
      <CheckCircle role="img" aria-label="Reserva confirmada" className="h-14 w-14 text-success mx-auto" />
      <div className="space-y-1.5">
        <h2 className="text-2xl font-semibold">
          {alreadyExisted ? "Sua reserva já estava feita" : "Reserva confirmada!"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {alreadyExisted
            ? "Recebemos o mesmo pedido de novo e não criamos outra reserva. Esta é a que está confirmada."
            : "Sua reserva está confirmada. A mensagem por WhatsApp ou e-mail, quando habilitada, é enviada separadamente."}
        </p>
      </div>
      <div className="surface rounded-card p-4 text-left space-y-2">
        <Row label="Código" value={`#${reserva.reservation_code}`} mono />
        <Row label="Data" value={formatDateBR(reserva.date)} />
        <Row label="Horário" value={reserva.time} />
        <Row label="Pessoas" value={String(reserva.party_size)} />
        {state.seat && !alreadyExisted && <Row label="Mesa" value={state.seat.label} />}
      </div>
      <p className="text-xs text-muted-foreground">
        Guarde seu código para consultar ou alterar a reserva.
      </p>
      <Button variant="outline" onClick={actions.reset}>
        Fazer outra reserva
      </Button>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className={mono ? "font-mono font-semibold" : "font-medium"}>{value}</span>
    </div>
  );
}
