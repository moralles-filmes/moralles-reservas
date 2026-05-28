import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useParams, useLocation } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { BillingBanner } from "@/components/BillingBanner";
import PaymentRequired from "@/pages/PaymentRequired";
import type { BillingStatus } from "@/types/billing";

const BLOCKED_STATUSES: BillingStatus[] = ["blocked", "suspended"];
const WARNING_STATUSES: BillingStatus[] = ["pending_payment", "past_due", "grace_period"];

// Mostra banner de "trial acabando" quando faltam ≤ esse número de dias.
const TRIAL_ENDING_THRESHOLD_DAYS = 3;

function trialDaysRemaining(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) return null;
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86400000));
}

export function BillingGuard({ children }: { children: React.ReactNode }) {
  const { isPlatformAdmin, memberships } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const location = useLocation();

  const membership = memberships.find((m) => m.unit_slug === unitSlug);
  const orgId = membership?.organization_id;

  // Whitelist: a página /cobranca DEVE ficar acessível mesmo em status
  // blocked/suspended/canceled — é onde o cliente reativa o acesso. Sem isso,
  // org bloqueada cai em loop (PaymentRequired → "Escolher plano" → bloqueia
  // de novo). Cliente nunca sai do limbo.
  const isCobrancaRoute = !!unitSlug && location.pathname === `/g/${unitSlug}/cobranca`;

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

  if (bs === "canceled" || BLOCKED_STATUSES.includes(bs)) {
    if (isCobrancaRoute) {
      // Mostra banner amarelo + renderiza Cobranca normalmente
      return (
        <>
          <BillingBanner status={bs} />
          {children}
        </>
      );
    }
    return <PaymentRequired status={bs} blockedReason={org.blocked_reason} unitSlug={unitSlug} />;
  }

  // Banner de "trial acabando" — D-3 client-side, sem worker envolvido.
  if (bs === "trialing") {
    const days = trialDaysRemaining(org.trial_ends_at);
    if (days != null && days <= TRIAL_ENDING_THRESHOLD_DAYS) {
      return (
        <>
          <BillingBanner status="trial_ending" daysRemaining={days} />
          {children}
        </>
      );
    }
  }

  return (
    <>
      {WARNING_STATUSES.includes(bs) && <BillingBanner status={bs} />}
      {children}
    </>
  );
}
