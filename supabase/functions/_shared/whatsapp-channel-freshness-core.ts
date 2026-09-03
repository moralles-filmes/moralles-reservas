// supabase/functions/_shared/whatsapp-channel-freshness-core.ts
/**
 * `whatsapp_channels.status` é uma PROJEÇÃO, e projeção pode estar velha.
 *
 * Medido em produção: o canal Z-API do Ren Sushi permaneceu `connected` de
 * 2026-08-28 a 2026-09-03 com a instância fora do ar o tempo todo. A Z-API não
 * mandou `DisconnectedCallback`, e a revalidação de 30s do portal
 * (2026-09-01-zapi-connection-status-design.md) é gateada por aba visível —
 * ninguém abriu o painel. Durante 6,6 dias o envio leu `connected`, postou, e a
 * Z-API respondeu 2xx enfileirando tudo para despejar na reconexão.
 *
 * A correção não é ler o status com mais cuidado: é parar de tratá-lo como
 * verdade atemporal. Este núcleo responde uma pergunta só — dá para confiar na
 * projeção agora, ou é preciso perguntar ao provedor antes de gastar um envio?
 */

/** Idade máxima da projeção para ela responder sozinha. */
export const CHANNEL_FRESHNESS_MS = 5 * 60_000;

export type ChannelUsability =
  /** Projeção fresca e conectada — envia sem consultar o provedor. */
  | "use"
  /** Projeção velha ou inexistente — consultar o provedor antes de decidir. */
  | "recheck"
  /** Projeção fresca e não conectada — recusa sem gastar consulta. */
  | "refuse";

export interface ChannelFreshnessInput {
  /** `whatsapp_channels.status`. */
  status: string | null | undefined;
  /** `whatsapp_channels.last_health_check_at`. */
  lastHealthCheckAt: string | null | undefined;
  now: string | number | Date;
  /** Injetável só para teste; produção usa o default. */
  freshnessMs?: number;
}

function toMillis(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

/**
 * NÃO existe atalho por status aqui: um canal `disconnected` com projeção velha
 * também vai a `recheck`, não a `refuse`. O caso que isso protege é real e do
 * lado oposto do incidente — o operador reconecta o WhatsApp pelo celular e
 * clica em "avisar mesa pronta" antes do worker de health rodar. Recusar por
 * uma projeção velha diria "desconectado" sobre um canal que está no ar.
 *
 * A consequência de `recheck` (usar / recusar conforme o snapshot, e recusar
 * quando a consulta falha) é do caller — ver `whatsapp-send.ts`.
 */
export function decideChannelUsability(input: ChannelFreshnessInput): ChannelUsability {
  const { status, lastHealthCheckAt, now } = input;
  const freshnessMs = input.freshnessMs ?? CHANNEL_FRESHNESS_MS;

  if (!lastHealthCheckAt) return "recheck";

  const checkedMs = new Date(lastHealthCheckAt).getTime();
  const nowMs = toMillis(now);
  if (!Number.isFinite(checkedMs) || !Number.isFinite(nowMs)) return "recheck";

  // Carimbo no futuro (relógio torto, fuso escrito errado) não é frescor —
  // aceitá-lo deixaria a projeção se auto-validar para sempre.
  const ageMs = nowMs - checkedMs;
  if (ageMs < 0 || ageMs > freshnessMs) return "recheck";

  return status === "connected" ? "use" : "refuse";
}
