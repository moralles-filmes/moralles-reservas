// Relógio do auto-resolve do handoff humano. Puro (sem imports remotos) para
// rodar no Deno e no Vitest.
//
// silenceStartMs = max(handoff_at, última mensagem humana). Se os dois faltam
// (ex.: conversa assumida por um writer que não gravou handoff_at), o relógio
// nunca partiria e a IA ficaria silenciada para sempre: nesse caso o relógio
// começa agora e o chamador deve persistir `persistHandoffAt`.

export type HandoffClockInput = {
  handoffAt: string | null;
  lastHumanTs: number;
  nowMs: number;
};

export type HandoffClock = {
  silenceStartMs: number;
  persistHandoffAt: string | null;
};

export function resolveHandoffClock(input: HandoffClockInput): HandoffClock {
  const parsed = input.handoffAt ? new Date(input.handoffAt).getTime() : 0;
  const handoffMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const lastHuman = Number.isFinite(input.lastHumanTs) && input.lastHumanTs > 0 ? input.lastHumanTs : 0;

  if (handoffMs > 0 || lastHuman > 0) {
    return { silenceStartMs: Math.max(handoffMs, lastHuman), persistHandoffAt: null };
  }
  return { silenceStartMs: input.nowMs, persistHandoffAt: new Date(input.nowMs).toISOString() };
}
