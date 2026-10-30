/**
 * Despacho das ferramentas do agente: o `switch` que o laço chama a cada tool
 * call, com os logs de sempre (`tool_call`/`tool_result`/`tool_error`) e as
 * consequências que o turno lê depois (`mutatingToolUsed`, que desliga o retry
 * silencioso, e `lastMutationOutcome`, a copy de §17.7.4).
 *
 * Identidade declarada (`ctx.claimedIdentity`, Instagram: telefone digitado no
 * Direct, não verificado — D4/C5):
 * - `link_customer_phone { phone, name }` só existe com a porta. Ela resolve o
 *   cliente no servidor; nenhum id vem do LLM. É idempotente (mesmo telefone,
 *   mesmo cliente), por isso NÃO liga `mutatingToolUsed`.
 * - Sem cliente no estado, as ferramentas de cliente devolvem
 *   `NEED_PHONE_RESULT` sem I/O.
 * - As ferramentas de reserva só alcançam o ledger do contato
 *   (`reservationIds()`, lido uma vez por turno). Reserva criada no turno entra
 *   no ledger local só se `recordReservation` resolveu: o ledger do banco é a
 *   autoridade, e uma reserva que não está nele também não estará no próximo
 *   turno — abri-la só neste turno daria acesso que o banco não sustenta.
 * - O que volta ao LLM passa por allowlist de chaves: sem `notes` da reserva
 *   (a equipe pode anotar alergia/VIP nela) e sem campo do cadastro. Chave
 *   nova num resultado é descartada até entrar na lista.
 * - `get_reservation` não oferece `phone` (o escopo vem da porta, não do LLM).
 * - `create_reservation` não oferece nem repassa `customer_email`: o e-mail iria
 *   para o cadastro do dono do telefone e desviaria a confirmação por e-mail
 *   (com o nome cadastrado) para quem digitou o número.
 *
 * Sem porta (WhatsApp) o despacho é o de antes, byte a byte (paridade).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { MutationOutcome } from "../ai-budget-copy.ts";
import { jsonLog } from "../security.ts";
import { checkAvailability as checkAvailabilityCore } from "../availability.ts";
import {
  cancelReservationScoped,
  getReservationScoped,
  updateReservationScoped,
  type ReservationToolScope,
} from "../agent-reservation-tools.ts";
import {
  agentTools,
  checkAvailability,
  createReservation,
  listCustomerReservations,
  summarizeToolInput,
  summarizeToolResult,
} from "./tools.ts";
import type { AgentConversation, AgentCustomer, ChannelContext } from "./channel-context.ts";

/** Resultado (ao LLM) de ferramenta de cliente chamada antes de ligar o telefone. */
export const NEED_PHONE_RESULT = {
  success: false,
  found: false,
  reason: "need_phone",
  message: "Antes de reservar ou consultar, peça o número de WhatsApp do cliente (com DDD) e registre com link_customer_phone.",
} as const;

/** Ferramentas que precisam de cliente resolvido. */
const CUSTOMER_TOOLS = new Set([
  "create_reservation",
  "get_reservation",
  "update_reservation",
  "cancel_reservation",
  "list_customer_reservations",
]);

const LINK_CUSTOMER_PHONE_TOOL = {
  name: "link_customer_phone",
  description: "Registra o número de WhatsApp (com DDD) e o nome que o cliente informou nesta conversa. Chame antes de criar, consultar, alterar ou cancelar reservas.",
  parameters: {
    type: "object" as const,
    properties: {
      phone: { type: "string", description: "WhatsApp do cliente com DDD" },
      name: { type: "string", description: "Nome do cliente" },
    },
    required: ["phone", "name"],
  },
};

/**
 * Parâmetros que somem do schema com identidade declarada: `customer_email`
 * (não grava e-mail no cadastro do dono do telefone) e o `phone` de
 * `get_reservation` (o escopo vem da porta).
 */
const CLAIMED_IDENTITY_HIDDEN_PARAMS: Record<string, string> = {
  create_reservation: "customer_email",
  get_reservation: "phone",
};

function forClaimedIdentity(tool: (typeof agentTools)[number]): (typeof agentTools)[number] {
  const hidden = CLAIMED_IDENTITY_HIDDEN_PARAMS[tool.name];
  if (!hidden) return tool;
  const properties = { ...tool.parameters.properties };
  delete properties[hidden];
  return { ...tool, parameters: { ...tool.parameters, properties } };
}

/**
 * Sem porta, exatamente `agentTools`. Com porta, sem os parâmetros de
 * `CLAIMED_IDENTITY_HIDDEN_PARAMS` e com `link_customer_phone` no fim.
 */
export function agentToolsFor(ctx: Pick<ChannelContext, "claimedIdentity">): typeof agentTools {
  return ctx.claimedIdentity
    ? [...agentTools.map(forClaimedIdentity), LINK_CUSTOMER_PHONE_TOOL]
    : agentTools;
}

export interface ToolDispatchState {
  mutatingToolUsed: boolean;
  lastMutationOutcome: MutationOutcome | null;
  customer: AgentCustomer | null;
}

/**
 * Chaves que podem voltar ao LLM com identidade declarada (D4). É a união do
 * que as ferramentas devolvem hoje (`tools.ts`, `agent-reservation-tools.ts`,
 * os resultados fixos deste arquivo), menos `notes`: allowlist, não denylist —
 * campo novo num resultado (do cadastro, por exemplo) é descartado até alguém o
 * acrescentar aqui conscientemente.
 */
const CLAIMED_IDENTITY_RESULT_KEYS = new Set([
  // desfecho
  "success", "found", "available", "ok", "reason", "message", "error",
  // reserva (get, list, create)
  "reservation_code", "date", "time", "party_size", "status",
  // lista
  "count", "reservations",
]);

/** Resultado de ferramenta como pode chegar ao LLM com identidade declarada. */
// deno-lint-ignore no-explicit-any
export function claimedIdentityResult(value: any): any {
  if (Array.isArray(value)) return value.map(claimedIdentityResult);
  if (!value || typeof value !== "object") return value;
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (CLAIMED_IDENTITY_RESULT_KEYS.has(k)) out[k] = claimedIdentityResult(v);
  }
  return out;
}

export function createToolDispatcher(a: {
  supabase: SupabaseClient;
  requestId: string;
  ctx: ChannelContext;
  conv: AgentConversation;
  state: ToolDispatchState;
}): (name: string, input: unknown) => Promise<string> {
  const { supabase, requestId, ctx, conv, state } = a;
  const { unitId, organizationId, channelId } = ctx;
  const port = ctx.claimedIdentity;

  // Ledger do contato, lido uma vez por turno (só sucesso fica em memória).
  let ledger: string[] | null = null;
  const ledgerIds = async (): Promise<string[]> => {
    if (!port) return [];
    if (ledger === null) ledger = [...(await port.reservationIds())];
    return ledger;
  };
  const scopeFor = async (customer: AgentCustomer): Promise<ReservationToolScope> =>
    port
      ? { unitId, customerId: customer.id, reservationIds: await ledgerIds() }
      : { unitId, customerId: customer.id };

  // deno-lint-ignore no-explicit-any
  return async (name: string, input: any): Promise<string> => {
    jsonLog("info", { requestId, evt: "tool_call", channelId, unitId, name, input: summarizeToolInput(input) });
    try {
      // deno-lint-ignore no-explicit-any
      let result: any;
      const customer = state.customer;
      if (CUSTOMER_TOOLS.has(name) && customer === null) {
        // Sem cliente (identidade declarada sem telefone): nada de I/O e nada
        // de `mutatingToolUsed` — o retry silencioso continua possível.
        result = NEED_PHONE_RESULT;
      } else {
        // As ferramentas de cliente só chegam aqui com cliente (guarda acima);
        // as outras não leem `current`.
        const current = customer as AgentCustomer;
        switch (name) {
          case "check_availability":
            result = await checkAvailability(supabase, input.date, input.time, input.party_size, unitId, input.hall_name);
            break;
          case "create_reservation": {
            state.mutatingToolUsed = true; // desliga o retry silencioso (evita reserva duplicada)
            const created = await createReservation(supabase, {
              ...input,
              // Identidade declarada: o e-mail do LLM nunca chega ao cadastro (C1).
              ...(port ? { customer_email: undefined } : {}),
              customer: { id: current.id, phone: current.phone },
              claimedIdentity: !!port,
              unit_id: unitId,
              organization_id: organizationId,
              source: ctx.reservationSource,
            });
            // Classificação do desfecho para a copy de §17.7.4. A reserva
            // do agente nasce `confirmed` e é ISENTA de caução — não existe
            // desfecho PENDING neste caminho, e inventar um seria afirmar
            // ao cliente uma espera que não vai acontecer. `success: false`
            // é ignorância sobre o que ficou de pé: UNKNOWN.
            state.lastMutationOutcome = created?.success === true ? "COMPLETED" : "UNKNOWN";
            // O id interno não vai ao LLM; com porta, entra no ledger do contato.
            const { reservationId, ...forLlm } = created ?? {};
            if (port && created?.success === true && typeof reservationId === "string") {
              // Duas tentativas: sem o registro, a reserva some das consultas do
              // contato e o LLM pode criar outra no turno seguinte. Gravação
              // atômica com a criação fica para o adapter (Bloco 4).
              let recorded = false;
              let recordError: unknown = null;
              for (let attempt = 0; attempt < 2 && !recorded; attempt++) {
                try {
                  await port.recordReservation(reservationId);
                  recorded = true;
                } catch (err) {
                  recordError = err;
                }
              }
              if (!recorded) {
                jsonLog("error", {
                  requestId,
                  evt: "agent_reservation_ledger_record_failed",
                  channelId,
                  unitId,
                  attempts: 2,
                  errorClass: recordError instanceof Error ? recordError.name : typeof recordError,
                });
              } else {
                // Registrado: a reserva fica visível às ferramentas seguintes do
                // turno. Se o ledger ainda não foi lido, a leitura já a traz.
                try {
                  const ids = await ledgerIds();
                  if (!ids.includes(reservationId)) ids.push(reservationId);
                } catch (err) {
                  jsonLog("error", {
                    requestId,
                    evt: "agent_reservation_ledger_read_failed",
                    channelId,
                    unitId,
                    errorClass: err instanceof Error ? err.name : typeof err,
                  });
                }
              }
            }
            result = forLlm;
            break;
          }
          case "get_reservation":
            result = await getReservationScoped(supabase, input, await scopeFor(current));
            break;
          case "update_reservation":
            state.mutatingToolUsed = true; // desliga o retry silencioso (evita alteração duplicada)
            result = await updateReservationScoped(
              supabase,
              input,
              await scopeFor(current),
              { checkAvailability: (p) => checkAvailabilityCore(supabase, p) },
            );
            state.lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
            break;
          case "cancel_reservation":
            state.mutatingToolUsed = true; // desliga o retry silencioso (evita cancelamento duplicado)
            result = await cancelReservationScoped(supabase, input.reservation_code, await scopeFor(current));
            state.lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
            break;
          case "list_customer_reservations":
            result = await listCustomerReservations(
              supabase,
              current.id,
              unitId,
              port ? await ledgerIds() : undefined,
            );
            break;
          case "request_human_handoff":
            await supabase.from("conversations").update({
              status: "awaiting_human",
              handoff_reason: input.reason,
              handoff_at: new Date().toISOString(),
              last_silenced_reply_at: null,
            }).eq("id", conv.id);
            jsonLog("info", { requestId, evt: "handoff_requested", convId: conv.id, reason: input.reason });
            result = { ok: true, message: "Transferência registrada. AGORA envie ao cliente uma mensagem cordial dizendo que um atendente humano vai responder em breve, antes de encerrar." };
            break;
          case "link_customer_phone":
            if (port) {
              // Idempotente: NÃO liga `mutatingToolUsed`. O cliente vem da porta
              // (resolvido no servidor, na organização do contato).
              const linked = await port.linkPhone({
                phone: typeof input?.phone === "string" ? input.phone : "",
                name: typeof input?.name === "string" ? input.name : "",
              });
              if (linked.ok === true) {
                state.customer = linked.customer;
                result = { success: true, message: "Número registrado." };
              } else if (linked.reason === "invalid_phone") {
                result = { success: false, reason: "invalid_phone", message: "O número parece incompleto. Peça o WhatsApp com DDD." };
              } else {
                result = { success: false, reason: "unavailable", message: "Não consegui registrar o número agora. Tente novamente em instantes." };
              }
              break;
            }
            result = { error: `Tool desconhecida: ${name}` };
            break;
          default:
            result = { error: `Tool desconhecida: ${name}` };
        }
      }
      if (port) result = claimedIdentityResult(result);
      jsonLog("info", { requestId, evt: "tool_result", channelId, unitId, name, result: summarizeToolResult(result) });
      return JSON.stringify(result);
    } catch (err) {
      // Só a classe e o code: a mensagem pode trazer dado do cliente (um 23505
      // em `customers` traz o telefone na `Key (...)=(...)`).
      const code = (err as { code?: unknown } | null)?.code;
      jsonLog("error", {
        requestId,
        evt: "tool_error",
        channelId,
        unitId,
        name,
        errorClass: err instanceof Error ? err.name : typeof err,
        ...(typeof code === "string" ? { code } : {}),
      });
      // O texto do erro (PostgREST, rede, host do projeto) fica no log:
      // o que volta ao LLM chega ao cliente parafraseado.
      return JSON.stringify({ error: "Não foi possível concluir esta ação agora. Tente novamente em instantes." });
    }
  };
}
