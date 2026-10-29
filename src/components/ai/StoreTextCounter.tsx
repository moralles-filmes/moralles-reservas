import { storeTextError, type StoreTextKey } from "@/lib/store-text";
import { cn } from "@/lib/utils";
import { STORE_TEXT_LIMITS, charLength } from "../../../supabase/functions/_shared/agent/global-prompt-core";

/**
 * Contador `caracteres/limite` e, se o texto não vale, o motivo. Recebe o valor
 * JÁ preparado (normalizado, e aparado quando a tela apara): é ele que o banco vai medir.
 */
export function StoreTextCounter({ id, storeKey, value }: { id: string; storeKey: StoreTextKey; value: string }) {
  const problem = storeTextError(storeKey, value);
  return (
    <>
      <p id={`${id}-counter`} className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
        {charLength(value)}/{STORE_TEXT_LIMITS[storeKey]}
      </p>
      {problem && (
        <p id={`${id}-problem`} className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </>
  );
}
