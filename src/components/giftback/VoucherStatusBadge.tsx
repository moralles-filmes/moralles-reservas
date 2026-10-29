import { STATUS_LABEL, type VoucherStatus } from "@/hooks/useVouchers";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<VoucherStatus, string> = {
  active: "bg-success/10 text-success border-success/20",
  used: "bg-info/10 text-info border-info/20",
  expired: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-destructive/10 text-destructive border-destructive/20",
};

export function VoucherStatusBadge({ status }: { status: VoucherStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}
