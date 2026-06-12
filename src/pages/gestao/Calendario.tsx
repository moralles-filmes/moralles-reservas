import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { ReservasCalendar } from "@/components/reserva/ReservasCalendar";

export default function Calendario() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Calendário</h1>
      <ReservasCalendar unitId={unitId} />
    </div>
  );
}
