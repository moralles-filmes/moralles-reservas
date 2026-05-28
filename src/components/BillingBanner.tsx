import { AlertTriangle } from "lucide-react";
import type { BillingStatus } from "@/types/billing";

const MESSAGES: Partial<Record<BillingStatus, string>> = {
  pending_payment: "Sua mensalidade está pendente de pagamento. Regularize para evitar interrupções.",
  past_due: "Sua mensalidade está vencida. O acesso poderá ser suspenso em breve.",
  grace_period: "Período de carência ativo. Regularize o pagamento para manter o acesso.",
};

export function BillingBanner({ status }: { status: BillingStatus }) {
  const message = MESSAGES[status];
  if (!message) return null;

  const isUrgent = status === "past_due" || status === "grace_period";

  return (
    <div className={`px-4 py-2.5 text-sm flex items-center gap-2 ${isUrgent ? "bg-amber-50 text-amber-800 border-b border-amber-200" : "bg-blue-50 text-blue-800 border-b border-blue-200"}`}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
