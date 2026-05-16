/**
 * ReservaWizard
 *
 * Wizard multi-step de reserva pública. Dois modos:
 *
 * - mode="dialog" (PublicPortal): renderiza ResponsiveDialogHeader/Body/Footer.
 *   Deve ser usado dentro de um <ResponsiveDialogContent>. O caller controla
 *   open/onOpenChange e o trigger.
 *
 * - mode="embedded" (WidgetPortal): renderiza inline num container fornecido
 *   pelo caller (sem dialog próprio).
 */

import {
  ResponsiveDialogHeader,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import type {
  PublicCustomField,
  PublicHall,
  Reserva,
  WidgetFieldConfigMap,
} from "@/types/reserva";
import {
  WizardContext,
  useReservaWizard,
  useReservaWizardContext,
} from "./wizard/useReservaWizard";
import { StepDateTimeParty } from "./wizard/StepDateTimeParty";
import { StepHall } from "./wizard/StepHall";
import { StepGuestInfo } from "./wizard/StepGuestInfo";
import { WizardSuccess } from "./wizard/WizardSuccess";
import { WizardFooter } from "./wizard/WizardFooter";

export interface ReservaWizardProps {
  mode: "dialog" | "embedded";
  /** Título exibido no header (só em mode=dialog). Ex: "Reservar em Moralles". */
  title?: string;
  unit: { id: string; name: string; organization_id: string } | null;
  halls: PublicHall[];
  customFields?: PublicCustomField[];
  widgetConfig?: WidgetFieldConfigMap;
  widgetId?: string;
  bookingWindowDays?: number;
  rulesAndConditions?: string;
  additionalInfo?: string;
  /** Instruções específicas do widget (só usado pelo WidgetPortal). */
  widgetInstructions?: string;
  onSuccess?: (reserva: Reserva) => void;
}

export function ReservaWizard({
  mode,
  title,
  unit,
  halls,
  customFields = [],
  widgetConfig,
  widgetId,
  bookingWindowDays,
  rulesAndConditions,
  additionalInfo,
  widgetInstructions,
  onSuccess,
}: ReservaWizardProps) {
  const ctx = useReservaWizard({
    halls,
    customFields,
    widgetConfig,
    widgetId,
    unit,
    bookingWindowDays,
    rulesAndConditions,
    additionalInfo,
    widgetInstructions,
    onSuccess,
  });

  if (mode === "dialog") {
    return (
      <WizardContext.Provider value={ctx}>
        <ResponsiveDialogHeader>
          {title && (
            <ResponsiveDialogTitle className="font-display">
              {title}
            </ResponsiveDialogTitle>
          )}
          <WizardStepIndicator />
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <WizardBody />
        </ResponsiveDialogBody>
        {ctx.state.step !== "success" && (
          <ResponsiveDialogFooter>
            <WizardFooter />
          </ResponsiveDialogFooter>
        )}
      </WizardContext.Provider>
    );
  }

  // mode === "embedded"
  return (
    <WizardContext.Provider value={ctx}>
      <div className="space-y-5">
        <WizardStepIndicator embedded />
        <WizardBody />
        {ctx.state.step !== "success" && (
          <div className="pt-2">
            <WizardFooter />
          </div>
        )}
      </div>
    </WizardContext.Provider>
  );
}

function WizardBody() {
  const { state } = useReservaWizardContext();
  if (state.step === "success") return <WizardSuccess />;
  if (state.step === 1) return <StepDateTimeParty />;
  if (state.step === 2) return <StepHall />;
  return <StepGuestInfo />;
}

/**
 * Indicador "Passo X de 3" — discreto, abaixo do título.
 * Em modo embedded fica como subtítulo antes do body.
 */
function WizardStepIndicator({ embedded = false }: { embedded?: boolean }) {
  const { state } = useReservaWizardContext();
  if (state.step === "success") return null;
  const stepNum = state.step;
  return (
    <div className={embedded ? "text-xs text-muted-foreground" : "text-xs text-muted-foreground mt-1.5"}>
      Passo {stepNum} de 3
    </div>
  );
}
