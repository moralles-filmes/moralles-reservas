/**
 * Montagem da `AgentUnit` a partir da linha de `units` lida com `SELECT *`
 * (a leitura fica no `index.ts` de cada EF). Uma função para os dois canais:
 * o prompt do Instagram e o do WhatsApp veem a mesma unidade.
 *
 * Endereço: `address.full` aparado; sem ele, as partes não vazias unidas por
 * ", ". Coluna JSONB nunca é interpolada inteira.
 */
import type { AgentUnit } from "./channel-context.ts";

// deno-lint-ignore no-explicit-any
export function buildAgentUnit(unitRow: Record<string, any> | null | undefined): AgentUnit {
  const addressJson = unitRow?.address as
    | {
        full?: string | null;
        street?: string | null;
        number?: string | null;
        neighborhood?: string | null;
        city?: string | null;
        state?: string | null;
      }
    | null;
  const address: string =
    (typeof addressJson?.full === "string" && addressJson.full.trim()) ||
    [
      addressJson?.street,
      addressJson?.number,
      addressJson?.neighborhood,
      addressJson?.city,
      addressJson?.state,
    ]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(", ");
  return {
    row: unitRow ?? null,
    name: (unitRow?.name as string | undefined) ?? "",
    slug: (unitRow?.slug as string | undefined) ?? null,
    address,
    ticketMax: (unitRow?.price_range_max as number | null | undefined) ?? null,
  };
}
