/** Link para a conversa de um cliente. `basePath` é `/o/:slug` ou `/g/:slug`. */
export function conversationHref(basePath: string, customerId: string): string {
  return `${basePath}/conversas?cliente=${encodeURIComponent(customerId)}`;
}
