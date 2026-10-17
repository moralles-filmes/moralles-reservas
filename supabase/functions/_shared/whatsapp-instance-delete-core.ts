// Exclusão de instância de WhatsApp — a parte da Edge Function que dá para
// testar sem Deno.
//
// QUEM DECIDE SE PODE APAGAR É O BANCO (RPC `delete_whatsapp_instance_without_cost`,
// migration 20261015223000), sob lock. Este arquivo não reimplementa a regra:
// traduz o desfecho da RPC em resposta HTTP e calcula o `has_cost_history` que
// a tela usa para decidir se OFERECE o botão. Vive em `_shared/` porque o
// `index.ts` de `manage-whatsapp-instances` chama `serve()` no carregamento e
// importa `deno.land` — o vitest não o importa.
//
// Consumidor único: `manage-whatsapp-instances`.

export type DeleteInstanceResponse = {
  status: 200 | 404 | 409 | 500;
  body: Record<string, unknown>;
};

/** Desfecho da RPC → resposta. Desconhecido é 500, nunca sucesso. */
export function deleteInstanceOutcomeResponse(outcome: unknown): DeleteInstanceResponse {
  switch (outcome) {
    case "deleted":
      return { status: 200, body: { deleted: true } };
    case "not_found":
      return { status: 404, body: { error: "Instância não encontrada." } };
    case "not_ended":
      return {
        status: 409,
        body: { error: "Só é possível apagar instância encerrada.", code: "INSTANCE_NOT_ENDED" },
      };
    case "has_cost":
      return {
        status: 409,
        body: {
          error: "Esta instância já teve custo registrado e não pode ser apagada.",
          code: "INSTANCE_HAS_COST_HISTORY",
        },
      };
    case "open_alerts":
      return {
        status: 409,
        body: {
          error: "Resolva os alertas abertos desta instância antes de apagar.",
          code: "INSTANCE_HAS_OPEN_ALERTS",
        },
      };
    default:
      return { status: 500, body: { error: "Não foi possível apagar a instância." } };
  }
}

/**
 * Se a instância tem histórico financeiro: custo atual informado OU algum ciclo
 * com custo. É o que a tela usa para OFERECER "Apagar"; falso negativo é
 * seguro (o banco recusa), falso positivo esconderia um botão legítimo.
 */
export function hasCostHistory(
  currentMonthlyCostCents: unknown,
  instanceId: string,
  idsWithCycleCost: ReadonlySet<string>,
): boolean {
  return typeof currentMonthlyCostCents === "number" || idsWithCycleCost.has(instanceId);
}
