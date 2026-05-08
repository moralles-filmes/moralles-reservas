import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, type VoucherStatus } from "@/hooks/useVouchers";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<VoucherStatus, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  used: "bg-blue-50 text-blue-700 border-blue-200",
  expired: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-rose-50 text-rose-700 border-rose-200",
};

export function VoucherStatusBadge({ status }: { status: VoucherStatus }) {
  return (
    <Badge variant="outline" className={cn("font-medium", STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
