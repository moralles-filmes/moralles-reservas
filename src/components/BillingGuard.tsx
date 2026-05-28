import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useParams } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { BillingBanner } from "@/components/BillingBanner";
import PaymentRequired from "@/pages/PaymentRequired";
import type { BillingStatus } from "@/types/billing";

const BLOCKED_STATUSES: BillingStatus[] = ["blocked", "suspended"];
const WARNING_STATUSES: BillingStatus[] = ["pending_payment", "past_due", "grace_period"];

export function BillingGuard({ children }: { children: React.ReactNode }) {
  const { isPlatformAdmin, memberships } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();

  const membership = memberships.find((m) => m.unit_slug === unitSlug);
  const orgId = membership?.organization_id;

  const { data: org, isLoading } = useQuery({
    queryKey: ["org-billing-status", orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("billing_status, trial_ends_at, blocked_at, blocked_reason")
        .eq("id", orgId!)
        .single();
      if (error) throw error;
      return data as {
        billing_status: BillingStatus;
        trial_ends_at: string | null;
        blocked_at: string | null;
        blocked_reason: string | null;
      };
    },
    enabled: !!orgId && !isPlatformAdmin,
    staleTime: 60_000,
  });

  if (isPlatformAdmin) return <>{children}</>;
  if (!orgId) return <>{children}</>;
  if (isLoading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!org) return <>{children}</>;

  const bs = org.billing_status;

  if (bs === "canceled") {
    return <PaymentRequired status={bs} blockedReason={org.blocked_reason} />;
  }

  if (BLOCKED_STATUSES.includes(bs)) {
    return <PaymentRequired status={bs} blockedReason={org.blocked_reason} />;
  }

  return (
    <>
      {WARNING_STATUSES.includes(bs) && <BillingBanner status={bs} />}
      {children}
    </>
  );
}
