import { useEffect, useState } from "react";

/**
 * Atrasa atualizações de um valor para evitar trabalho em cada keystroke.
 * Útil para campos de busca que disparam queries de rede.
 */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
