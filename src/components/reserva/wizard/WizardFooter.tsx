import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReservaWizardContext } from "./useReservaWizard";
import { wizardSummaryLine } from "./summary-line";
import { cn } from "@/lib/utils";

/**
 * Rodapé fixo do wizard com botões contextuais:
 *   - Step 1: [Avançar]
 *   - Step 2: [Voltar] [Avançar]
 *   - Step 3: [Voltar] [Reservar] (loading state durante submit)
 * Deve ser renderizado dentro de um ResponsiveDialogFooter (em Dialog) ou
 * envolvido pelo container do widget (em WidgetPortal).
 */
export function WizardFooter({ floating = false }: { floating?: boolean }) {
  const { state, computed, actions, isSubmitting } = useReservaWizardContext();

  if (state.step === "success") return null;

  const isStep1 = state.step === 1;
  const isStep3 = state.step === 3;
  const summary = wizardSummaryLine(state);

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-2.5",
        // No dialog o conteúdo já é vidro; o rodapé fica liso para não aninhar
        // backdrop-filter.
        floating && "border-t border-border bg-background/95 px-5 sm:px-6 pt-3 pb-[calc(0.875rem+env(safe-area-inset-bottom))] sm:pb-4",
      )}
    >
      {summary && (
        <p aria-live="polite" aria-atomic="true" className="text-center text-sm text-muted-foreground tabular">
          {summary}
        </p>
      )}
      <div className="flex items-center gap-3">
        {!isStep1 && (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={actions.goBack}
            disabled={isSubmitting}
            className="shrink-0"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Voltar
          </Button>
        )}
        {isStep3 ? (
          <Button
            type="button"
            size="lg"
            onClick={actions.submit}
            disabled={isSubmitting}
            className="flex-1"
          >
            {isSubmitting
              ? "Criando reserva..."
              : computed.chargeInfo
                ? "Continuar para pagamento"
                : "Reservar"}
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            onClick={actions.goNext}
            disabled={isSubmitting}
            className="flex-1"
          >
            Avançar
          </Button>
        )}
      </div>
    </div>
  );
}
