import { useCallback, useEffect, useRef, useState } from "react";

function leaveNative() {
  if (typeof document === "undefined" || !document.fullscreenElement) return;
  try {
    void Promise.resolve(document.exitFullscreen?.()).catch(() => {});
  } catch {
    /* já saiu */
  }
}

/**
 * Tela cheia do documento inteiro (Dialog, Select e Sonner vivem no body).
 * Sem a API (iPhone) ou com recusa, `active` liga mesmo assim: a página cobre a área do app.
 */
export function useFullscreen() {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);

  const set = useCallback((v: boolean) => {
    activeRef.current = v;
    setActive(v);
  }, []);

  const enter = useCallback(() => {
    set(true);
    const el = document.documentElement;
    if (typeof el.requestFullscreen !== "function") return;
    try {
      void Promise.resolve(el.requestFullscreen()).catch(() => {});
    } catch {
      /* mantém só a camada */
    }
  }, [set]);

  const exit = useCallback(() => {
    set(false);
    leaveNative();
  }, [set]);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && activeRef.current) set(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !activeRef.current || e.defaultPrevented) return;
      // Em tela cheia nativa o navegador cuida do Esc (fullscreenchange).
      if (document.fullscreenElement) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      set(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("keydown", onKey);
      if (activeRef.current) leaveNative();
    };
  }, [set]);

  return { active, enter, exit };
}
