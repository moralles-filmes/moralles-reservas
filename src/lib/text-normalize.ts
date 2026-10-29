/** `\r\n` e `\r` solto viram `\n`. Texto sem `\r` volta igual. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
