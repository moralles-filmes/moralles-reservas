import { useEffect, useRef, useState } from "react";

/** Largura útil do contêiner; jsdom não tem ResizeObserver, então cai num padrão. */
export function useContainerWidth(fallback = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Altura da janela, acompanhando resize e rotação do aparelho; 900 fora do navegador. */
export function useViewportHeight(fallback = 900) {
  const read = () => (typeof window === "undefined" || !window.innerHeight ? fallback : window.innerHeight);
  const [height, setHeight] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setHeight(read());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return height;
}
