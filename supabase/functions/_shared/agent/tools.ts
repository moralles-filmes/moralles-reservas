/**
 * Ferramentas do agente de IA: as definições que o LLM vê e as implementações
 * de leitura/criação. Todas são escopadas pela unidade do turno; o caller nunca
 * escolhe o escopo — ele vem do canal e do cliente já resolvidos.
 *
 * O despacho mora em `tool-dispatch.ts`, com as consequências de cada chamada:
 * `mutatingToolUsed` (desliga o retry silencioso) e `lastMutationOutcome`
 * (copy de §17.7.4). Ferramenta mutante nova DEVE setar as duas no despacho.
 *
 * Sem client global nem `Deno.env`: o client entra por parâmetro.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkAvailability as checkAvailabilityCore,
  loadSeatMap,
  reserveSlot,
  type ReserveSlotParams,
  type SeatChoice,
} from "../availability.ts";
import { loadSeatChoiceEnabled } from "../adapters/hall-seating.ts";
import { activeHallIds, insertSeatLink, purgeExpiredSeatLinks } from "../adapters/seat-choice-links.ts";
import { resolveOrCreateCustomer } from "../resolve-customer.ts";
import { createSeatLinkToken, hashSeatLinkToken, SEAT_LINK_TTL_HOURS } from "../seat-link-core.ts";
import type { AgentChannel, AgentReservationSource } from "./channel-context.ts";
import { choiceLabelsFromMap, parseTableChoice, resolveTableChoice } from "./table-choice-core.ts";
import {
  AGENT_RESERVATION_NOTES_MAX_CHARS,
  reservationNotesForLlm,
  sanitizeReservationNotes,
} from "./reservation-notes.ts";

export { AGENT_RESERVATION_NOTES_MAX_CHARS };

// ─── Agent tools ──────────────────────────────────────────────────────────────

/**
 * Mesma forma de `AgentTool` (`ai-providers.ts`), declarada aqui para que um
 * teste que importe este arquivo não leve o `tsc -b` até o SDK do `esm.sh`.
 * Divergir dela reprova o `deno check`, onde `turn.ts` a entrega ao laço.
 */
type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const agentTools: AgentToolDefinition[] = [
  {
    name: "check_availability",
    description: "Verifica disponibilidade de mesas. Se o restaurante tem múltiplos salões e o cliente especificou um (ex: 'área externa', 'salão principal'), passe em hall_name; senão deixa em branco que o sistema busca em todos os salões ativos.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Data no formato YYYY-MM-DD" },
        time: { type: "string", description: "Horário no formato HH:MM" },
        party_size: { type: "number", description: "Número de pessoas" },
        hall_name: { type: "string", description: "Opcional: nome do salão preferido (ex: 'Salão Principal', 'Área Externa')." },
      },
      required: ["date", "time", "party_size"],
    },
  },
  {
    name: "create_reservation",
    description: "Cria uma nova reserva para o cliente. Se o restaurante tem múltiplos salões ativos e o cliente não escolheu, pergunte antes de chamar.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Nome completo do cliente" },
        customer_email: { type: "string", description: "E-mail do cliente (opcional)" },
        date: { type: "string", description: "Data YYYY-MM-DD" },
        time: { type: "string", description: "Horário HH:MM" },
        party_size: { type: "number", description: "Número de pessoas" },
        notes: { type: "string", maxLength: AGENT_RESERVATION_NOTES_MAX_CHARS, description: `Observações opcionais (até ${AGENT_RESERVATION_NOTES_MAX_CHARS} caracteres)` },
        hall_name: { type: "string", description: "Opcional: nome do salão preferido." },
      },
      required: ["customer_name", "date", "time", "party_size"],
    },
  },
  {
    name: "get_reservation",
    description: "Busca uma reserva pelo código ou pelo telefone do cliente (última reserva ativa).",
    parameters: {
      type: "object",
      properties: {
        reservation_code: { type: "string", description: "Código da reserva" },
        phone: { type: "string", description: "Telefone do cliente" },
      },
    },
  },
  {
    name: "update_reservation",
    description: "Altera data, horário ou número de pessoas de uma reserva existente.",
    parameters: {
      type: "object",
      properties: {
        reservation_code: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        party_size: { type: "number" },
        notes: { type: "string", maxLength: AGENT_RESERVATION_NOTES_MAX_CHARS, description: `Observações (até ${AGENT_RESERVATION_NOTES_MAX_CHARS} caracteres)` },
      },
      required: ["reservation_code"],
    },
  },
  {
    name: "cancel_reservation",
    description: "Cancela uma reserva existente. Requer o código da reserva. Se o cliente não informou o código, use get_reservation ou list_customer_reservations primeiro para obtê-lo.",
    parameters: {
      type: "object",
      properties: { reservation_code: { type: "string" } },
      required: ["reservation_code"],
    },
  },
  {
    name: "list_customer_reservations",
    description: "Lista as reservas ativas (pending/confirmed) do cliente.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "request_human_handoff",
    description: "Use SOMENTE depois de tentar resolver pelas ferramentas e informações disponíveis. Se o cliente pedir para 'falar com um atendente/humano' sem dizer o motivo, NÃO transfira de imediato: pergunte primeiro, de forma cordial, o que ele precisa, e tente resolver você mesmo (reserva, dúvida de cardápio/horário/endereço/pagamento/estacionamento). Só chame esta tool quando: (a) o assunto realmente exigir julgamento humano (reclamação, evento/grupo grande, delivery não suportado, cobrança, alergia grave, imprensa/parceria), OU (b) o cliente insistir em falar com uma pessoa mesmo após você se oferecer para ajudar. Transfere a conversa para um atendente humano.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Motivo breve da transferência (ex: 'cliente quer reclamar sobre atendimento')" },
      },
      required: ["reason"],
    },
  },
];

/**
 * Escolha de mesa pelo link (só WhatsApp, só com `seat_choice_enabled`): a
 * ferramenta e o parâmetro `table_choice` entram no turno por `agentToolsFor`.
 * Com a chave desligada, o turno fica idêntico ao de antes.
 */
export const TABLE_CHOICE_LINK_TOOL: AgentToolDefinition = {
  name: "get_table_choice_link",
  description: "Gera o link para o cliente ver o salão e escolher a mesa. Chame depois de saber data, horário, número de pessoas e salão, antes de create_reservation. Não cria reserva.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "Data YYYY-MM-DD" },
      time: { type: "string", description: "Horário HH:MM" },
      party_size: { type: "number", description: "Número de pessoas" },
      hall_name: { type: "string", description: "Opcional: nome do salão escolhido." },
    },
    required: ["date", "time", "party_size"],
  },
};

export const TABLE_CHOICE_PARAM = {
  type: "string",
  description: "Só o número da mesa ou das mesas que o cliente escolheu no link, ex.: \"12\" ou \"3+4+5\" (sem horário, pessoas ou outros números). Omita se ele não tem preferência.",
} as const;

// ─── Tool implementations (all unit-scoped) ───────────────────────────────────

/**
 * Resolver de entidade nomeada do LLM: NUNCA `ilike + limit(1)` (PostgREST
 * devolve linha não-determinística com vários matches). `undefined` faz o
 * caller iterar todos os salões.
 */
export async function resolveHallId(
  supabase: SupabaseClient,
  unitId: string,
  hallName?: string,
  partySize?: number,
): Promise<string | undefined> {
  if (!hallName?.trim()) return undefined;

  const { data: matches } = await supabase
    .from("halls")
    .select("id, allow_empty_seat")
    .eq("unit_id", unitId)
    .eq("active", true)
    .ilike("name", `%${hallName.trim()}%`)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  const list = (matches ?? []) as { id: string; allow_empty_seat: boolean }[];
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0].id;

  // 2+ matches: desambigua por partySize via capacidade das mesas ativas.
  // Se exatamente um hall comporta partySize, escolhe esse. Senão devolve
  // undefined e o core itera todos os halls em sort_order (mesmo
  // comportamento de quando hall_name é vazio). Evita o bug em que o
  // PostgREST escolhia um hall arbitrário entre nomes com prefixo comum
  // (ex.: "Salão principal - até 4 pessoas" vs "Salão principal - 6 a 20").
  if (partySize == null) return undefined;

  const ids = list.map((h) => h.id);
  const { data: tbls } = await supabase
    .from("tables")
    .select("hall_id, min_capacity, max_capacity")
    .in("hall_id", ids)
    .eq("active", true);

  const tableRows = (tbls ?? []) as { hall_id: string; min_capacity: number; max_capacity: number }[];
  const candidates = list.filter((h) =>
    tableRows.some((t) => {
      if (t.hall_id !== h.id) return false;
      const lower = h.allow_empty_seat ? Math.max(1, t.min_capacity - 1) : t.min_capacity;
      return partySize >= lower && partySize <= t.max_capacity;
    }),
  );

  if (candidates.length === 1) return candidates[0].id;
  return undefined;
}

export async function checkAvailability(
  supabase: SupabaseClient,
  date: string,
  time: string,
  partySize: number,
  unitId: string,
  hallName?: string,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const hallId = await resolveHallId(supabase, unitId, hallName, partySize);
  const result = await checkAvailabilityCore(supabase, { unitId, hallId, date, time, partySize });
  if (!result.available) {
    return { available: false, reason: result.reason, message: result.message };
  }
  return { available: true, message: result.message };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Salão do pedido: o nomeado, ou o único salão ativo da unidade. */
async function hallForChoice(
  supabase: SupabaseClient,
  unitId: string,
  hallName: string | undefined,
  partySize: number,
): Promise<string | undefined> {
  const named = await resolveHallId(supabase, unitId, hallName, partySize);
  if (named) return named;
  if (hallName?.trim()) return undefined;
  const ids = await activeHallIds(supabase, unitId);
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * `get_table_choice_link`: grava um link de escolha (só o hash do token) e
 * devolve a URL `/mesa/:token`. WhatsApp (canal) ou Instagram (conta), só com `seat_choice_enabled`;
 * salão sem planta ou sem mesa livre não ganha link. Unidade e canal vêm do
 * turno, nunca do LLM.
 */
export async function getTableChoiceLink(
  supabase: SupabaseClient,
  // deno-lint-ignore no-explicit-any
  input: any,
  scope: {
    unitId: string;
    channel: AgentChannel;
    channelId: string | null;
    appBaseUrl: () => string;
    now?: () => Date;
  },
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  // No Instagram o `channelId` do turno é a conta (`instagram_accounts.id`); o guard do banco confere a unidade.
  if ((scope.channel !== "whatsapp" && scope.channel !== "instagram") || !scope.channelId) {
    return { available: false, reason: "channel_unsupported" };
  }
  const partySize = input?.party_size;
  if (
    !validDate(input?.date) || typeof input?.time !== "string" || !TIME_RE.test(input.time) ||
    !Number.isInteger(partySize) || partySize < 1 || partySize > 50
  ) {
    return { available: false, reason: "invalid_input" };
  }
  const date = input.date as string;
  const time = (input.time as string).slice(0, 5);
  if (!(await loadSeatChoiceEnabled(supabase, scope.unitId))) return { available: false, reason: "disabled" };

  const hallName = typeof input?.hall_name === "string" ? input.hall_name : undefined;
  const hallId = await hallForChoice(supabase, scope.unitId, hallName, partySize);
  if (!hallId) return { available: false, reason: "no_hall" };

  const map = await loadSeatMap(supabase, { unitId: scope.unitId, hallId, date, time, partySize });
  if ("error" in map) return { available: false, reason: map.error };
  if (!map.hall.plan) return { available: false, reason: "no_plan" };
  if (!map.options.some((o) => o.available)) return { available: false, reason: "no_capacity" };

  const now = (scope.now ?? (() => new Date()))();
  // Links vencidos da unidade saem aqui (ninguém mais os apaga). Falha não impede o novo.
  const purge = await purgeExpiredSeatLinks(supabase, scope.unitId, now.toISOString());
  if (purge.failed) console.error(JSON.stringify({ evt: "seat_choice_links_purge_failed", code: purge.errorCode }));

  const token = createSeatLinkToken();
  const inserted = await insertSeatLink(supabase, {
    unit_id: scope.unitId,
    hall_id: hallId,
    channel_id: scope.channel === "whatsapp" ? scope.channelId : null,
    instagram_account_id: scope.channel === "instagram" ? scope.channelId : null,
    date,
    time,
    party_size: partySize,
    token_hash: await hashSeatLinkToken(token),
    expires_at: new Date(now.getTime() + SEAT_LINK_TTL_HOURS * 3_600_000).toISOString(),
  });
  if (inserted.failed) {
    console.error(JSON.stringify({ evt: "seat_choice_link_insert_failed", code: inserted.errorCode }));
    return { available: false, reason: "unavailable" };
  }
  const base = scope.appBaseUrl().replace(/\/+$/, "");
  return { available: true, url: `${base}/mesa/${token}`, expires_in_hours: SEAT_LINK_TTL_HOURS, hall_name: map.hall.name };
}

const SEAT_OPTIONS_LIMIT = 3;

/** Até 3 rótulos livres do salão, para o agente oferecer. Falha de leitura = lista vazia. */
async function freeSeatLabels(
  supabase: SupabaseClient,
  args: { unitId: string; hallId: string; date: string; time: string; partySize: number },
): Promise<string[]> {
  try {
    const map = await loadSeatMap(supabase, args);
    return "error" in map ? [] : choiceLabelsFromMap(map, SEAT_OPTIONS_LIMIT);
  } catch {
    return [];
  }
}

type TableChoiceResolution =
  | { ok: true; hallId: string; choice: SeatChoice }
  // deno-lint-ignore no-explicit-any
  | { ok: false; result: any };

/**
 * A mesa que o cliente escreveu, procurada só nos salões da unidade do turno
 * (o nomeado, ou todos os ativos). Achou em exatamente um salão → a escolha;
 * em nenhum → `seat_unavailable` com opções livres; em mais de um → pede o salão.
 */
async function resolveCustomerTableChoice(
  supabase: SupabaseClient,
  args: { unitId: string; hallId: string | undefined; date: string; time: string; partySize: number; text: string },
): Promise<TableChoiceResolution> {
  const numbers = parseTableChoice(args.text);
  if (!numbers) {
    return {
      ok: false,
      result: { success: false, reason: "seat_unavailable", message: "Não entendi a mesa escolhida. Peça o número da mesa como aparece no salão.", options: [] },
    };
  }
  const time = args.time.slice(0, 5);
  const hallIds = args.hallId ? [args.hallId] : await activeHallIds(supabase, args.unitId);
  const found: Array<{ hallId: string; choice: SeatChoice }> = [];
  let firstOptions: string[] = [];
  for (const hallId of hallIds) {
    const map = await loadSeatMap(supabase, { unitId: args.unitId, hallId, date: args.date, time, partySize: args.partySize });
    if ("error" in map) continue;
    if (firstOptions.length === 0) firstOptions = choiceLabelsFromMap(map, SEAT_OPTIONS_LIMIT);
    const combinations = map.options
      .filter((o) => o.choice.kind === "combination")
      .map((o) => ({ id: o.choice.id, tableIds: o.tableIds }));
    const choice = resolveTableChoice(numbers, map.tables, combinations);
    if (choice) found.push({ hallId, choice });
  }
  if (found.length === 1) return { ok: true, ...found[0] };
  if (found.length > 1) {
    return {
      ok: false,
      result: { success: false, reason: "hall_required", message: "Essa mesa existe em mais de um salão. Pergunte em qual salão o cliente quer sentar e passe hall_name." },
    };
  }
  return {
    ok: false,
    result: {
      success: false,
      reason: "seat_unavailable",
      message: "A mesa escolhida não está livre (ou não existe) para esse horário e número de pessoas. Ofereça as opções abaixo ou envie um novo link.",
      // Com vários salões e nenhum nomeado, não há salão certo para sugerir.
      options: hallIds.length === 1 ? firstOptions : [],
    },
  };
}

/**
 * Código que o hook da porta (`ClaimedIdentityPort.insertReservation`) devolve
 * quando a RPC recusa pelo teto de reservas ativas do contato. Gêmeo de
 * `RESERVATION_LIMIT_ERROR_CODE` em `instagram-inbound-core.ts` (teste).
 */
export const CLAIMED_RESERVATION_LIMIT_CODE = "instagram_contact_reservation_limit";

/**
 * Resultado ao LLM quando o teto barra a reserva (R4-h): mensagem fixa e
 * própria, para ele oferecer alterar ou cancelar em vez de tentar de novo.
 * Só existe com identidade declarada.
 */
export const CLAIMED_RESERVATION_LIMIT_RESULT = {
  success: false,
  reason: "reservation_limit",
  message: "Este contato já tem o número máximo de reservas ativas. Ofereça alterar ou cancelar uma reserva existente.",
} as const;

export async function createReservation(supabase: SupabaseClient, params: {
  customer_name: string;
  customer_email?: string;
  date: string;
  time: string;
  party_size: number;
  notes?: string;
  hall_name?: string;
  /** Mesa escolhida no link, como o cliente escreveu ("12", "3+4+5"). */
  table_choice?: string;
  /**
   * Cliente do turno, vindo do estado do despacho (canal ou `link_customer_phone`),
   * nunca do LLM. O telefone dele é o que resolve o cadastro.
   */
  customer: { id: string; phone: string };
  /**
   * Identidade declarada (Instagram): telefone digitado, não verificado. Com
   * ela o núcleo não faz I/O de cliente e a reserva só nasce pelo
   * `insertReservation` da porta.
   */
  claimedIdentity: boolean;
  /**
   * INSERT da porta (`ClaimedIdentityPort.insertReservation`): grava reserva e
   * ledger numa transação. Repassado ao `reserveSlot` só com identidade
   * declarada; sem ele, a identidade declarada falha fechado.
   */
  insertReservation?: ReserveSlotParams["insertReservation"];
  unit_id: string;
  organization_id: string;
  source: AgentReservationSource;
// deno-lint-ignore no-explicit-any
}): Promise<any> {
  const GENERIC_FAIL = { success: false, error: "Não foi possível registrar a reserva agora. Tente novamente em instantes." };

  // Mesa escolhida antes do cadastro: escolha que não existe não cria cliente.
  // Sem escolha, a ordem das leituras fica a de sempre (salão depois do cliente).
  let hallId: string | undefined;
  let hallResolved = false;
  let choice: SeatChoice | undefined;
  const tableChoiceText = typeof params.table_choice === "string" ? params.table_choice.trim() : "";
  if (tableChoiceText) {
    hallId = await resolveHallId(supabase, params.unit_id, params.hall_name, params.party_size);
    hallResolved = true;
    // Salão nomeado que não resolve: pergunta, nunca procura a mesa em outro salão.
    if (!hallId && params.hall_name?.trim()) {
      return {
        success: false,
        reason: "hall_required",
        message: "Não identifiquei o salão. Pergunte em qual salão o cliente quer sentar e passe hall_name com o nome dele.",
      };
    }
    const resolved = await resolveCustomerTableChoice(supabase, {
      unitId: params.unit_id,
      hallId,
      date: params.date,
      time: params.time,
      partySize: params.party_size,
      text: tableChoiceText,
    });
    if (resolved.ok === false) return resolved.result;
    hallId = resolved.hallId;
    choice = resolved.choice;
  }

  let customerId: string;
  if (params.claimedIdentity) {
    // Identidade declarada: nenhum I/O de cliente aqui (nem resolveOrCreateCustomer,
    // nem leitura de `customers`). O id vem do estado do despacho, nunca do LLM.
    // A ÚNICA barreira é a RPC `create_instagram_contact_reservation`, atrás do
    // `insertReservation` da porta: confere sob lock que o cliente está vivo, é
    // da organização e é o ligado ao contato. Sem o hook, nada de INSERT direto.
    if (!params.insertReservation) {
      console.error(JSON.stringify({ evt: "agent_claimed_identity_without_insert_hook" }));
      return { ...GENERIC_FAIL };
    }
    customerId = params.customer.id;
  } else {
    // Resolve customer com merge preservando dados:
    //   - lookup por (organization_id, phone)
    //   - se existe: PRESERVA nome cadastrado, append em emails[]
    //   - se não existe: cria
    let resolved;
    try {
      resolved = await resolveOrCreateCustomer(supabase, {
        organizationId: params.organization_id,
        phone: params.customer.phone,
        name: params.customer_name,
        email: params.customer_email ?? null,
      });
    } catch (err) {
      // O erro do PostgREST/rede não vai ao LLM (e dali ao cliente): só o code ao log.
      console.error(JSON.stringify({
        evt: "agent_resolve_customer_failed",
        code: (err as { code?: string } | null)?.code ?? null,
      }));
      return { ...GENERIC_FAIL };
    }
    // WhatsApp (telefone verificado pelo canal): se o telefone resolve para
    // outro cadastro (editado/fundido no meio do turno), reserva para o que hoje
    // o detém e só loga o evento.
    if (resolved.id !== params.customer.id) {
      console.error(JSON.stringify({ evt: "agent_customer_identity_mismatch", claimedIdentity: false }));
    }
    customerId = resolved.id;
  }

  // Com porta, o hook é embrulhado só para saber se a ÚLTIMA recusa foi o teto
  // do contato; a linha e o retorno passam intactos (o 23505 segue no retry).
  let reservationLimitHit = false;
  const portInsert = params.insertReservation;
  const insertReservation: ReserveSlotParams["insertReservation"] = portInsert
    ? async (row) => {
      const r = await portInsert(row);
      reservationLimitHit = r.error?.code === CLAIMED_RESERVATION_LIMIT_CODE;
      return r;
    }
    : undefined;

  if (!hallResolved) hallId = await resolveHallId(supabase, params.unit_id, params.hall_name, params.party_size);
  const result = await reserveSlot(supabase, {
    unitId: params.unit_id,
    hallId,
    date: params.date,
    time: params.time,
    partySize: params.party_size,
    customerId,
    notes: sanitizeReservationNotes(params.notes) ?? null,
    status: "confirmed",
    // Load-bearing: o trigger `enqueue_confirmation_notification` pula a
    // origem do agente; sem isso o cliente recebe a confirmação duplicada.
    source: params.source,
    // Escolha do cliente: ela ou `seat_unavailable`, nunca outra mesa.
    ...(choice ? { choice } : {}),
    // Só com identidade declarada; sem porta, a chamada de sempre (paridade).
    ...(params.claimedIdentity ? { insertReservation } : {}),
  });

  // `=== false`, não `!`: com `strict: false` o `!` não estreita a união.
  if (result.success === false) {
    if (params.claimedIdentity && reservationLimitHit) return { ...CLAIMED_RESERVATION_LIMIT_RESULT };
    if (choice && hallId && result.reason === "seat_unavailable") {
      const options = await freeSeatLabels(supabase, {
        unitId: params.unit_id, hallId, date: params.date, time: params.time.slice(0, 5), partySize: params.party_size,
      });
      return {
        success: false,
        reason: "seat_unavailable",
        message: "A mesa escolhida acabou de ser ocupada. Ofereça as opções abaixo ou envie um novo link.",
        options,
      };
    }
    return { success: false, reason: result.reason, message: result.message };
  }

  const [y, m, d] = params.date.split("-");
  return {
    success: true,
    reservation_code: result.reservationCode,
    message: `Reserva criada! Código: #${result.reservationCode}. Data: ${d}/${m}/${y} às ${params.time} para ${params.party_size} pessoas.`,
    // Só para o despacho (ledger da identidade declarada); ele o remove antes
    // de devolver ao LLM.
    reservationId: result.reservationId,
  };
}

/**
 * Com `reservationIds` (identidade declarada), só as reservas do ledger: a
 * consulta ganha `.in("id", ids)` e a lista vazia responde sem consultar.
 */
export async function listCustomerReservations(
  supabase: SupabaseClient,
  customerId: string,
  unitId: string,
  reservationIds?: readonly string[],
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  if (reservationIds && reservationIds.length === 0) {
    return { found: false, message: "Você não tem reservas ativas no momento." };
  }
  // "Hoje" em BRT: Deno roda em UTC e, das 21h à meia-noite, o dia UTC já virou
  // — o filtro esconderia as reservas de hoje justamente na hora do jantar.
  const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
  const todayBrt = new Date(Date.now() - BRT_OFFSET_MS).toISOString().slice(0, 10);
  let query = supabase
    .from("reservations")
    .select("reservation_code, date, time, party_size, status, notes")
    .eq("customer_id", customerId)
    .eq("unit_id", unitId)
    .in("status", ["pending", "confirmed"]);
  if (reservationIds) query = query.in("id", [...reservationIds]);
  const { data, error } = await query
    .gte("date", todayBrt)
    .order("date", { ascending: true })
    .limit(10);

  // Falha de leitura não pode virar "você não tem reservas": o cliente
  // reservaria de novo.
  if (error) {
    console.error(JSON.stringify({ evt: "agent_list_reservations_failed", code: error.code ?? null }));
    return { found: false, error: "unavailable", message: "Não consegui consultar suas reservas agora. Tente novamente em instantes." };
  }
  if (!data || data.length === 0) return { found: false, message: "Você não tem reservas ativas no momento." };
  return {
    found: true,
    count: data.length,
    reservations: data.map((r) => { const [y, m, d] = r.date.split("-"); return { reservation_code: r.reservation_code, date: `${d}/${m}/${y}`, time: r.time, party_size: r.party_size, status: r.status, notes: reservationNotesForLlm(r.notes) }; }),
  };
}

// ─── Tool log helpers ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function summarizeToolInput(input: any): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["date", "time", "party_size", "reservation_code", "reason", "table_choice"]) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  if (input.customer_name) out.customer_name = "***";
  return out;
}

// deno-lint-ignore no-explicit-any
export function summarizeToolResult(result: any): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["available", "success", "found", "ok", "reason", "reservation_code", "count"]) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  if (result.error) out.error = String(result.error).slice(0, 200);
  return out;
}
