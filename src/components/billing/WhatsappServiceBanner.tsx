import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDateBR } from "@/lib/utils";
import { useWhatsappServiceStatus } from "@/hooks/useWhatsappImplementation";

interface WhatsappServiceBannerProps {
  organizationId: string | undefined;
  unitSlug: string;
  /**
   * Esconde o CTA "Regularizar pagamento" — usar na própria página de
   * Cobrança, onde o botão navegaria pra tela em que o dono já está.
   */
  showCta?: boolean;
  className?: string;
}

/**
 * Banner de suspensão da automação de WhatsApp (Fase 5b Task 20).
 *
 * REGRA DE PRODUTO: a suspensão é do WhatsApp, nunca do sistema. Reservas,
 * agenda, clientes, relatórios, e-mails e a própria página de cobrança
 * continuam funcionando. Por isso este componente só aparece nas telas onde o
 * efeito é sentido (Cobrança, Conversas, Automação) — SEM banner global, SEM
 * bloqueio de rota. Não promover este componente pra um layout compartilhado.
 *
 * A escolha do banner é por `serviceState`, NUNCA por `sendingBlocked`: a
 * flag `whatsapp_service_enforcement` nasce OFF, e um banner keyado na
 * consequência gateada por ela nunca apareceria mesmo com a mensalidade
 * vencida há meses. `serviceState` é a decisão pura (7 estados,
 * `_shared/whatsapp-service-state-core.ts`), não a consequência.
 *
 * Loading e erro renderizam nada — silencioso de propósito. Este é um aviso
 * SUPLEMENTAR: o card de Automação (`AutomacaoWhatsappCard`) e a própria tela
 * de Cobrança já têm estado de erro próprio com retry. Um "não foi possível
 * verificar" piscando em 3 telas ao mesmo tempo leria como "o sistema caiu"
 * — exatamente o que este componente existe para evitar. O backend também
 * nunca deixa a resposta AFIRMAR um estado sobre leitura falha
 * (`get_service_status` devolve 503 quando `gate.readFailed`), então "erro"
 * aqui já significa "não dá pra confiar no dado", e "nada" é a resposta certa.
 */
export function WhatsappServiceBanner({
  organizationId,
  unitSlug,
  showCta = true,
  className,
}: WhatsappServiceBannerProps) {
  const { data, isLoading, isError } = useWhatsappServiceStatus(organizationId);

  if (isLoading || isError || !data) return null;

  if (data.serviceState === "SUSPENDED_UNPAID") {
    // `suspendedAt` é a coluna real (billing_subscriptions.suspended_at), mas
    // só é escrita pelo worker de enforcement — que fica de fora enquanto a
    // flag estiver OFF. `graceEndsAt` (quando a carência teoricamente acabou)
    // é o fallback honesto: nunca mostra a data em branco nem inventa "hoje".
    const sinceIso = data.suspendedAt ?? data.graceEndsAt;
    return (
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3",
          className,
        )}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-destructive" />
          <p className="text-sm text-destructive">
            Automação de WhatsApp suspensa por falta de pagamento
            {sinceIso ? ` desde ${formatDateBR(sinceIso.slice(0, 10))}` : ""}. Reservas,
            agenda e relatórios seguem funcionando.
          </p>
        </div>
        {showCta && (
          <Button asChild size="sm" variant="destructive" className="shrink-0">
            <Link to={`/g/${unitSlug}/cobranca`}>Regularizar pagamento</Link>
          </Button>
        )}
      </div>
    );
  }

  if (data.serviceState === "GRACE_PERIOD") {
    return (
      <div
        className={cn(
          "flex items-start gap-2.5 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3",
          className,
        )}
      >
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-warning" />
        <p className="text-sm text-warning">
          Mensalidade da automação em aberto.
          {data.graceEndsAt ? ` Suspensão em ${formatDateBR(data.graceEndsAt.slice(0, 10))}.` : ""}
        </p>
      </div>
    );
  }

  if (data.serviceState === "ADMIN_BLOCKED") {
    return (
      <div
        className={cn(
          "flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3",
          className,
        )}
      >
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-destructive" />
        <p className="text-sm text-destructive">
          Automação bloqueada administrativamente. Fale com o suporte.
        </p>
      </div>
    );
  }

  // ACTIVE / OVERRIDE_ACTIVE / LEGACY_GRANDFATHERED / NOT_ENTITLED: nada — o
  // banner só existe para os três casos acima.
  return null;
}
