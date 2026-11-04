import { useEffect, useState } from "react";

/** Relógio de tela: atualiza no intervalo e pausa com a aba oculta (reatualiza ao voltar). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const start = () => {
      stop();
      id = setInterval(() => setNow(new Date()), intervalMs);
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        setNow(new Date());
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return now;
}
