/** Rótulo curto do tempo decorrido desde `sinceIso` até `now`: "agora", "8 min", "1h", "1h 05". */
export function elapsedLabel(sinceIso: string, now: Date): string {
  const diff = now.getTime() - new Date(sinceIso).getTime();
  // Data inválida ou no futuro (relógio do aparelho adiantado/atrasado) conta como "agora".
  const min = Number.isFinite(diff) ? Math.max(0, Math.floor(diff / 60_000)) : 0;
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}`;
}
