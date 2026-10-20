/**
 * Ferramentas do agente de IA: as definições que o LLM vê e as implementações
 * de leitura/criação. Todas são escopadas pela unidade do turno; o caller nunca
 * escolhe o escopo — ele vem do canal e do cliente já resolvidos.
 *
 * O despacho (`onToolCall`) mora em `turn.ts`, porque é lá que ficam as
 * consequências de cada chamada: `mutatingToolUsed` (desliga o retry
 * silencioso) e `lastMutationOutcome` (copy de §17.7.4). Ferramenta mutante
 * nova DEVE setar as duas no despacho.
 *
 * Sem client global nem `Deno.env`: o client entra por parâmetro.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkAvailability as checkAvailabilityCore,
  reserveSlot,
} from "../availability.ts";
import { resolveOrCreateCustomer } from "../resolve-customer.ts";
import type { AgentReservationSource } from "./channel-context.ts";

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
        notes: { type: "string", description: "Observações opcionais" },
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
        notes: { type: "string" },
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

export async function createReservation(supabase: SupabaseClient, params: {
  customer_name: string;
  customer_email?: string;
  date: string;
  time: string;
  party_size: number;
  notes?: string;
  hall_name?: string;
  phone: string;
  unit_id: string;
  organization_id: string;
  source: AgentReservationSource;
// deno-lint-ignore no-explicit-any
}): Promise<any> {
  // Resolve customer com merge preservando dados:
  //   - lookup por (organization_id, phone)
  //   - se existe: PRESERVA nome cadastrado, append em emails[]
  //   - se não existe: cria
  let customer;
  try {
    customer = await resolveOrCreateCustomer(supabase, {
      organizationId: params.organization_id,
      phone: params.phone,
      name: params.customer_name,
      email: params.customer_email ?? null,
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const hallId = await resolveHallId(supabase, params.unit_id, params.hall_name, params.party_size);
  const result = await reserveSlot(supabase, {
    unitId: params.unit_id,
    hallId,
    date: params.date,
    time: params.time,
    partySize: params.party_size,
    customerId: customer.id,
    notes: params.notes ?? null,
    status: "confirmed",
    // Load-bearing: o trigger `enqueue_confirmation_notification` pula a
    // origem do agente; sem isso o cliente recebe a confirmação duplicada.
    source: params.source,
  });

  // `=== false`, não `!`: com `strict: false` o `!` não estreita a união.
  if (result.success === false) {
    return { success: false, reason: result.reason, message: result.message };
  }

  const [y, m, d] = params.date.split("-");
  return {
    success: true,
    reservation_code: result.reservationCode,
    message: `Reserva criada! Código: #${result.reservationCode}. Data: ${d}/${m}/${y} às ${params.time} para ${params.party_size} pessoas.`,
  };
}

// deno-lint-ignore no-explicit-any
export async function listCustomerReservations(supabase: SupabaseClient, customerId: string, unitId: string): Promise<any> {
  const { data } = await supabase
    .from("reservations")
    .select("reservation_code, date, time, party_size, status, notes")
    .eq("customer_id", customerId)
    .eq("unit_id", unitId)
    .in("status", ["pending", "confirmed"])
    .gte("date", new Date().toISOString().slice(0, 10))
    .order("date", { ascending: true })
    .limit(10);

  if (!data || data.length === 0) return { found: false, message: "Você não tem reservas ativas no momento." };
  return {
    found: true,
    count: data.length,
    reservations: data.map((r) => { const [y, m, d] = r.date.split("-"); return { reservation_code: r.reservation_code, date: `${d}/${m}/${y}`, time: r.time, party_size: r.party_size, status: r.status, notes: r.notes }; }),
  };
}

// ─── Tool log helpers ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function summarizeToolInput(input: any): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["date", "time", "party_size", "reservation_code", "reason"]) {
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
