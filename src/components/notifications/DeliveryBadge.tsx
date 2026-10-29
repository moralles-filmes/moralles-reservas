import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  PhoneOff,
} from "lucide-react";
import type { DeliveryState } from "@/hooks/useNotificationDeliveries";

const CONFIG: Record<
  DeliveryState,
  { label: string; icon: typeof Check; className: string }
> = {
  no_phone: {
    label: "Sem WhatsApp",
    icon: PhoneOff,
    className: "bg-muted text-muted-foreground border-border",
  },
  not_sent: {
    label: "Não enviada",
    icon: AlertTriangle,
    className: "bg-warning/10 text-warning border-warning/20",
  },
  failed: {
    label: "Falhou",
    icon: Ban,
    className: "bg-destructive/10 text-destructive border-destructive/20",
  },
  sent_pending: {
    label: "Enviada",
    icon: Check,
    className: "bg-muted text-muted-foreground border-border",
  },
  sent_untracked: {
    label: "Enviada",
    icon: Check,
    className: "bg-muted text-muted-foreground border-border",
  },
  undelivered: {
    label: "Não entregue",
    icon: AlertTriangle,
    className: "bg-destructive/10 text-destructive border-destructive/20",
  },
  delivered: {
    label: "Entregue",
    icon: CheckCheck,
    className: "bg-success/10 text-success border-success/20",
  },
  read: {
    label: "Lida",
    icon: CheckCheck,
    className: "bg-info/10 text-info border-info/20",
  },
};

interface DeliveryBadgeProps {
  state: DeliveryState;
  /** Texto curto antes do rótulo (ex.: "Entrada", "Mesa pronta", "Confirmação"). */
  prefix?: string;
  title?: string;
  className?: string;
}

/**
 * Badge de status de ENTREGA de uma mensagem WhatsApp. `state` vem de
 * `deriveDeliveryState` (em useNotificationDeliveries). Distingue "enviada"
 * (provedor aceitou) de "entregue"/"lida" (callback de status confirmou).
 */
export function DeliveryBadge({ state, prefix, title, className }: DeliveryBadgeProps) {
  const cfg = CONFIG[state];
  const Icon = cfg.icon;
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn("text-[11px] gap-1 font-normal", cfg.className, className)}
    >
      <Icon className="h-3 w-3" />
      {prefix ? `${prefix}: ${cfg.label}` : cfg.label}
    </Badge>
  );
}
