import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { describeSavedModel, type AIProvider } from "@/lib/aiModels";

/**
 * Aviso sob o seletor de modelo, derivado do valor SALVO da unidade.
 * Não reescreve nada: o usuário confirma escolhendo um modelo e salvando.
 */
export function SavedModelNotice({
  provider,
  saved,
}: {
  provider: AIProvider;
  saved?: string | null;
}) {
  const state = describeSavedModel(provider, saved);

  if (state.kind === "retired" || state.kind === "unknown") {
    return (
      <div
        role="status"
        className="rounded border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <p>
          <span className="font-mono break-all">{state.saved}</span>{" "}
          {state.kind === "retired"
            ? `aposentado — em uso: ${state.usedLabel} (confirme)`
            : `descontinuado — usando o padrão ${state.usedLabel}`}
        </p>
      </div>
    );
  }

  if (state.kind === "active" && !state.verified) {
    return <Badge variant="warning">não testado em produção</Badge>;
  }

  if (state.kind === "empty" && !state.verified) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>padrão: {state.usedLabel}</span>
        <Badge variant="warning">não testado em produção</Badge>
      </div>
    );
  }

  return null;
}
