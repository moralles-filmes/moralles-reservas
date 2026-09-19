// Forma de um objeto aninhado para telemetria: NOMES de campo e TIPOS, nunca
// VALORES.
//
// Vive como núcleo puro, e não dentro de `webhook-whatsapp/index.ts`, porque
// aquele arquivo chama `serve()` no carregamento e importa `deno.land` — o
// vitest não consegue importá-lo, e a garantia abaixo só poderia ser conferida
// por leitura.
//
// A GARANTIA é a folha: todo primitivo vira `typeof value`, nunca `value`.
// Trocar isso por `String(value)` — a "melhoria" óbvia de quem depura — publica
// telefone de cliente e credencial de provedor dentro de `webhook_executions.meta`
// sem erro de tipo nem aviso de lint. O controle positivo do teste existe pra
// reprovar exatamente essa troca.
//
// O QUE A GARANTIA NÃO COBRE: os nomes de chave são emitidos, porque são o
// ponto da telemetria. Um objeto cujas CHAVES sejam dados (um mapa indexado por
// telefone ou JID) vazaria por aí. Por isso `SHAPE_MAX_DEPTH = 1` — ele limita
// a exposição ao primeiro nível, onde as chaves são nomes fixos do protocolo, e
// colapsa o resto em `"object"`. Chamador só passa objeto de esquema conhecido;
// nunca um mapa indexado por dado do cliente.
//
// Controle positivo em src/lib/webhook-payload-shape-core.test.ts.

/** Níveis cujos NOMES de chave são emitidos. Ver a ressalva acima antes de subir. */
export const SHAPE_MAX_DEPTH = 1;

/** Teto de chaves por nível — payload de provedor é entrada não confiável. */
export const SHAPE_MAX_KEYS = 25;

/**
 * Descreve a ESTRUTURA de `value` sem revelar seu conteúdo.
 *
 * - primitivo → `typeof` (`"string"`, `"number"`, `"boolean"`, ...)
 * - array     → `"array[N]"` (só o comprimento)
 * - objeto    → mapa de chave → forma, até `SHAPE_MAX_DEPTH`; além disso, `"object"`
 *
 * Nenhum caminho de retorno devolve o valor original.
 */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value && typeof value === "object") {
    if (depth >= SHAPE_MAX_DEPTH) return "object";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, SHAPE_MAX_KEYS)) {
      out[k] = shapeOf(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}
