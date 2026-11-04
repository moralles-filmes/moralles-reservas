import { useEffect, useState } from "react";

const supports = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/** `matchMedia` com listener; sem suporte devolve `false`. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (supports() ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!supports()) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener?.("change", update);
    return () => mql.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}
