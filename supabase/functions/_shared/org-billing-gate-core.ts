/**
 * Gate de cobrança da organização antes de rodar o agente de IA: org
 * `blocked` ou `suspended` não ativa a IA (o inbound ainda entra no histórico).
 *
 * Um predicado para os dois canais (`webhook-whatsapp` e
 * `process-instagram-inbound`). POLARIDADE: falha ABERTA. Quem chama passa a
 * linha lida de `organizations` (`select("billing_status") ... .single()`), e
 * erro de leitura chega como `null` — que NÃO bloqueia. É o comportamento do
 * WhatsApp desde antes da extração; mudar a polaridade é decisão comercial,
 * não ajuste de código.
 */
export function isOrgBillingBlocked<T extends { billing_status?: unknown }>(row: T | null | undefined): row is T {
  return !!row && (row.billing_status === "blocked" || row.billing_status === "suspended");
}
