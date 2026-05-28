import { AlertTriangle } from "lucide-react";
import type { BillingStatus } from "@/types/billing";

// "trial_ending" é variante CLIENT-SIDE (não persiste no banco) — calculada
// quando billing_status='trialing' E trial_ends_at < now() + 3 dias.
export type BillingBannerStatus = BillingStatus | "trial_ending";

interface Props {
  status: BillingBannerStatus;
  /** Dias restantes — usado em status='trial_ending' pra completar a mensagem. */
  daysRemaining?: number;
}

const MESSAGES: Partial<Record<BillingBannerStatus, string>> = {
  pending_payment: "Sua mensalidade está pendente de pagamento. Regularize para evitar interrupções.",
  past_due: "Sua mensalidade está vencida. O acesso poderá ser suspenso em breve.",
  grace_period: "Período de carência ativo. Regularize o pagamento para manter o acesso.",
  blocked: "Acesso bloqueado. Escolha um plano em Cobrança para reativar.",
  suspended: "Acesso suspenso. Escolha um plano em Cobrança para reativar.",
  canceled: "Sua assinatura foi cancelada. Escolha um novo plano em Cobrança para voltar.",
  // trial_ending é resolvido em tempo de render abaixo (depende de daysRemaining)
};

function urgencyClass(status: BillingBannerStatus): string {
  switch (status) {
    case "blocked":
    case "suspended":
    case "canceled":
      return "bg-red-50 text-red-800 border-b border-red-200";
    case "past_due":
    case "grace_period":
    case "trial_ending":
      return "bg-amber-50 text-amber-800 border-b border-amber-200";
    default:
      return "bg-blue-50 text-blue-800 border-b border-blue-200";
  }
}

export function BillingBanner({ status, daysRemaining }: Props) {
  let message: string | undefined;
  if (status === "trial_ending") {
    if (daysRemaining == null || daysRemaining < 0) return null;
    if (daysRemaining === 0) {
      message = "Seu trial termina hoje. Escolha um plano em Cobrança para não perder o acesso.";
    } else if (daysRemaining === 1) {
      message = "Seu trial acaba amanhã. Escolha um plano em Cobrança para continuar usando.";
    } else {
      message = `Seu trial acaba em ${daysRemaining} dias. Escolha um plano em Cobrança para continuar usando.`;
    }
  } else {
    message = MESSAGES[status];
  }
  if (!message) return null;

  return (
    <div className={`px-4 py-2.5 text-sm flex items-center gap-2 ${urgencyClass(status)}`}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
