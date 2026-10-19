import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { admitAutomationReceipts } from "../_shared/whatsapp-automation-receipts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  runAgentLoop,
  resolveModel,
  estimateCostUsd,
  isAgentDeadlineError,
  sanitizeProviderError,
  type AgentBudgetHooks,
  type AgentLoopResult,
  type AIProvider,
  type AgentTool,
} from "../_shared/ai-providers.ts";
// ─── Franquia de IA (Plano D) ────────────────────────────────────────────────
// O adapter faz I/O; a decisão é dos núcleos puros. Nada aqui reimplementa
// "cabe?", "isto é teto ou soluço?" ou "o que dizer ao cliente".
import {
  finalizeTurn,
  loadAiFranchise,
  makeBudgetHooks,
  openTurnBudget,
  recordMilestones,
  type TurnBudget,
} from "../_shared/ai-budget-gate.ts";
import {
  AI_BUDGET_HANDOFF_REASON,
  isCommercialHardStop,
  shouldAutoResolveHandoff,
  telemetryEventFor,
} from "../_shared/ai-budget-core.ts";
import {
  AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
  AI_BUDGET_HARDCODED_TEXTS,
  resolveMutationStopText,
  type MutationOutcome,
} from "../_shared/ai-budget-copy.ts";
import { resolveOrgEntitlements } from "../_shared/entitlements.ts";
import { checkFlagEnabled, isFlagEnabled } from "../_shared/platform-flags.ts";
// ─── Ingestão assíncrona (Fase C) ────────────────────────────────────────────
// Adapter de I/O; NENHUMA decisão desta fase é redigitada aqui. `vitest` não
// importa este arquivo (`serve()` no carregamento + imports de `deno.land`),
// então regra escrita aqui só se confere por leitura — e leitura já deixou
// passar defeito duas vezes neste repo.
import {
  agentDeadlineVerdict,
  decideAckVerdict,
  decideIngestionMode,
  decodeRawBodyHex,
  deliveryDedupeKey,
  encodeRawBodyHex,
  parseSelectedEventIds,
  providerDeclaresDeliveryId,
  queuedEventVerdict,
  sanitizeQueueErrorText,
  shouldPromoteToDead,
  sweepShouldStartAnother,
  DATAFY_DELIVERY_ID_HEADER,
  INBOUND_DEBOUNCE_WINDOW_MS,
  SIGNATURE_HEADER_BY_SCHEME,
  SWEEP_SELECT_LIMIT,
  type IngestionSource,
  type InsertOutcome,
} from "../_shared/whatsapp-inbound-queue-core.ts";
import {
  WEBHOOK_SIGNATURE_SCHEME,
  hasAdReferralCapture,
  isMetaShapedProvider,
  parseAdReferral,
  parseInbound,
  parseOwnMessageEchoes,
  peekInboundMedia,
  sendOutbound,
  validateChannelSecret,
  validateMetaSignature,
  validateProviderToken,
  verifyDatafySignature,
  getWhatsAppProvider,
  type WhatsAppProvider,
  type ChannelCredentials,
  type InboundMediaKind,
  type OwnMessageEcho,
} from "../_shared/whatsapp-providers.ts";
// O gate de ingestão lê daqui a reentrega declarada do provider. Indexa o
// registry por nome, sem resolver o adapter; pela fachada,
// `getWhatsAppProvider(provider).capabilities` expõe o mesmo objeto.
import { PROVIDER_CAPABILITIES } from "../_shared/whatsapp-provider-core.ts";
import { parseStatusCallback, type StatusUpdate } from "../_shared/whatsapp-status.ts";
import { resolveChannelCredentials } from "../_shared/whatsapp-channel-credentials.ts";
import { resolveWhatsAppGateByOrg, clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";
import { decideInboundAutoReply } from "../_shared/whatsapp-service-state-core.ts";
import { canonicalBrPhone } from "../_shared/phone.ts";
import { splitMetaWebhookPayloadCore } from "../_shared/whatsapp-meta-batch-core.ts";
import { createTemplateEventRuntime } from "../_shared/whatsapp-template-events.ts";
import {
  declaredProviderIdentityMatchesChannel,
  manualEchoMatchesConfiguredChannel,
  metaPayloadMatchesChannel,
} from "../_shared/whatsapp-echo-identity-core.ts";
import { shapeOf } from "../_shared/webhook-payload-shape-core.ts";
// ─── Referral CTWA (Fase D) ──────────────────────────────────────────────────
// Adapter de I/O; a decisão é do núcleo. Nada aqui reimplementa limite, dedupe
// ou forma de log.
import {
  buildAdTouchpointRow,
  classifyTouchpointInsert,
  describeCapturedReferral,
  describeReferralProbe,
} from "../_shared/whatsapp-ad-touchpoint-core.ts";
import { sanitizeForWhatsApp } from "../_shared/whatsapp-format.ts";
import {
  genRequestId,
  jsonLog,
  requireInternalAuth,
  sanitizePhone,
} from "../_shared/security.ts";
import {
  checkAvailability as checkAvailabilityCore,
  reserveSlot,
} from "../_shared/availability.ts";
import { resolveOrCreateCustomer } from "../_shared/resolve-customer.ts";
import { resolveHandoffClock } from "../_shared/handoff-clock-core.ts";
import {
  buildUpcomingDaysLines,
  WEEKDAY_NAMES_PT,
} from "../_shared/agent-calendar-core.ts";
import {
  DEFAULT_GIFTBACK_TEMPLATE,
  ensureUniqueVoucherCode,
  expiresAtEndOfDayBrt,
  formatExpiryBR,
  renderGiftbackTemplate,
} from "../_shared/giftback.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

/**
 * `EdgeRuntime.waitUntil` — primeira utilização neste repo (o `asaas-webhook`
 * documenta deliberadamente NÃO usá-lo, porque o Asaas corta em 10 s).
 *
 * Declarado porque o runtime expõe este global e o compilador não o conhece;
 * declarado ESTREITO (só `waitUntil`, que recebe uma promise e devolve `void`)
 * porque o resto do objeto não é usado. Como `tsc -b` não alcança
 * `supabase/functions/`, esquecer esta declaração não reprovaria nada
 * localmente — o `no-undef` do eslint já conhece o global, e é só isso que ele
 * vê.
 *
 * NÃO é garantia de conclusão: o wall clock é do WORKER, não da request, e a
 * própria doc do Supabase diz que `waitUntil` "does not extend the hard wall
 * clock limit". O caminho rápido é OTIMISTA; a varredura é o backstop.
 */
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function splitMetaWebhookPayload(payload: unknown): unknown[] {
  return splitMetaWebhookPayloadCore(payload);
}

// Aplica callbacks de status em notifications_sent, correlacionando por
// provider_message_id. MONOTÔNICO: só preenche um carimbo se ainda nulo, e
// `read` garante `delivered` (não regride entregue→enviado). Best-effort:
// linhas antigas sem provider_message_id simplesmente não casam.
async function applyDeliveryStatus(
  updates: StatusUpdate[],
  unitId: string,
  provider: WhatsAppProvider,
  channelId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const u of updates) {
    const id = u.providerMessageId;
    try {
      if (u.status === "delivered") {
        await supabase
          .from("notifications_sent")
          .update({ delivered_at: nowIso })
          .eq("unit_id", unitId)
          .eq("whatsapp_provider", provider)
          .eq("whatsapp_channel_id", channelId)
          .eq("provider_message_id", id)
          .is("delivered_at", null);
      } else if (u.status === "read") {
        // read implica delivered — backfill do delivered_at se faltou o RECEIVED.
        await supabase
          .from("notifications_sent")
          .update({ delivered_at: nowIso })
          .eq("unit_id", unitId)
          .eq("whatsapp_provider", provider)
          .eq("whatsapp_channel_id", channelId)
          .eq("provider_message_id", id)
          .is("delivered_at", null);
        await supabase
          .from("notifications_sent")
          .update({ read_at: nowIso })
          .eq("unit_id", unitId)
          .eq("whatsapp_provider", provider)
          .eq("whatsapp_channel_id", channelId)
          .eq("provider_message_id", id)
          .is("read_at", null);
      } else if (u.status === "failed") {
        await supabase
          .from("notifications_sent")
          .update({ failed_at: nowIso, status: "failed" })
          .eq("unit_id", unitId)
          .eq("whatsapp_provider", provider)
          .eq("whatsapp_channel_id", channelId)
          .eq("provider_message_id", id)
          .is("failed_at", null);
      }
      // status "sent" não muda nada — já sabíamos do envio.
    } catch (e) {
      jsonLog("warn", { evt: "apply_delivery_status_failed", id, status: u.status, err: String(e) });
    }
  }
}

// Resolve a chave de API: BYOK por unidade no banco.
// Sem fallback global da plataforma (removido em 2026-05-20). Razão: secrets
// globais (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) compartilhados entre units
// faziam parecer "vazamento de chave entre lojas" e bagunçavam cobrança por
// tenant. Sem chave própria = throw → handoff humano automático no catch do
// caller.
async function resolveApiKey(provider: AIProvider, unitId: string): Promise<string> {
  const { data } = await supabase
    .from("ai_provider_credentials")
    .select("api_key")
    .eq("unit_id", unitId)
    .eq("provider", provider)
    .eq("active", true)
    .maybeSingle();

  if (data?.api_key) return data.api_key;

  throw new Error(`api_key_not_configured:${provider}`);
}

// ─── Agent tools ──────────────────────────────────────────────────────────────

const agentTools: AgentTool[] = [
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

async function resolveHallId(
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

// deno-lint-ignore no-explicit-any
async function checkAvailability(date: string, time: string, partySize: number, unitId: string, hallName?: string): Promise<any> {
  const hallId = await resolveHallId(unitId, hallName, partySize);
  const result = await checkAvailabilityCore(supabase, { unitId, hallId, date, time, partySize });
  if (!result.available) {
    return { available: false, reason: result.reason, message: result.message };
  }
  return { available: true, message: result.message };
}

async function createReservation(params: {
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

  const hallId = await resolveHallId(params.unit_id, params.hall_name, params.party_size);
  const result = await reserveSlot(supabase, {
    unitId: params.unit_id,
    hallId,
    date: params.date,
    time: params.time,
    partySize: params.party_size,
    customerId: customer.id,
    notes: params.notes ?? null,
    status: "confirmed",
    source: "whatsapp",
  });

  if (!result.success) {
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
async function getReservation(params: { reservation_code?: string; phone?: string }, unitId: string): Promise<any> {
  let query = supabase
    .from("reservations")
    .select("*, customer:customers(*)")
    .eq("unit_id", unitId)
    .in("status", ["confirmed", "pending"]);

  if (params.reservation_code) {
    query = query.eq("reservation_code", params.reservation_code.toUpperCase());
  } else if (params.phone) {
    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("phone", params.phone.replace(/\D/g, ""))
      .maybeSingle();
    if (!customer) return { found: false, message: "Nenhuma reserva encontrada." };
    query = query.eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(1);
  } else {
    return { found: false, message: "Informe o código ou o telefone." };
  }

  const { data } = await query.maybeSingle();
  if (!data) return { found: false, message: "Reserva não encontrada ou já cancelada." };
  const [y, m, d] = data.date.split("-");
  return { found: true, reservation_code: data.reservation_code, date: `${d}/${m}/${y}`, time: data.time, party_size: data.party_size, status: data.status, notes: data.notes };
}

// deno-lint-ignore no-explicit-any
async function updateReservation(params: { reservation_code: string; date?: string; time?: string; party_size?: number; notes?: string }): Promise<any> {
  const updates: Record<string, unknown> = {};
  if (params.date) updates.date = params.date;
  if (params.time) updates.time = params.time;
  if (params.party_size) updates.party_size = params.party_size;
  if (params.notes !== undefined) updates.notes = params.notes;
  if (!Object.keys(updates).length) return { success: false, message: "Nenhuma alteração informada." };

  const { error } = await supabase
    .from("reservations")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("reservation_code", params.reservation_code.toUpperCase());

  if (error) return { success: false, error: error.message };
  return { success: true, message: "Reserva atualizada com sucesso!" };
}

// deno-lint-ignore no-explicit-any
async function cancelReservation(code: string): Promise<any> {
  if (!code?.trim()) return { success: false, error: "Código da reserva não informado. Use get_reservation ou list_customer_reservations para obter o código." };
  const upperCode = code.toUpperCase();
  const { data, error } = await supabase
    .from("reservations")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("reservation_code", upperCode)
    .in("status", ["confirmed", "pending"])
    .select("reservation_code")
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: "Reserva não encontrada ou já cancelada." };
  return { success: true, message: `Reserva #${upperCode} cancelada.` };
}

// deno-lint-ignore no-explicit-any
async function listCustomerReservations(customerId: string, unitId: string): Promise<any> {
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

// ─── Conversation helpers ──────────────────────────────────────────────────────

async function getOrCreateConversation(
  customerId: string,
  unitId: string,
  contactName?: string,
  chatLid?: string | null,
) {
  const { data: conversationId, error: resolveError } = await supabase.rpc(
    "get_or_create_whatsapp_conversation",
    {
      p_customer_id: customerId,
      p_unit_id: unitId,
      p_contact_name: contactName ?? null,
      p_chat_lid: chatLid ?? null,
    },
  );
  if (resolveError || !conversationId) throw new Error("conversation_resolve_failed");

  const { data, error: loadError } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("unit_id", unitId)
    .single();
  if (loadError || !data) throw new Error("conversation_load_failed");
  return data;
}

// Chama a RPC atômica (single UPDATE com `messages || jsonb_build_array(msg)`)
// e devolve se a escrita foi confirmada — `false` em erro, após o mesmo warn
// log que já existia. Extraído de `appendToConversation` para que callers que
// precisam de um sinal de sucesso real (ex.: `persistInboundOnly`) não dependam
// do array "previsão local" que `appendToConversation` sempre retorna.
// deno-lint-ignore no-explicit-any
async function appendConversationMessageRpc(
  convId: string,
  newMsg: ConversationMessageRecord,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase.rpc("append_conversation_message", {
      p_conversation_id: convId,
      p_message: newMsg,
    });
    if (!error) return true;
    jsonLog("warn", { evt: "append_conversation_message_failed", convId, attempt, err: error.message });
  }
  return false;
}

type ConversationMessageAuthor = "customer" | "ai" | "automation" | "human";

type ConversationMessageRecord = {
  event_id: string;
  role: "user" | "assistant" | "human";
  content: string;
  timestamp: string;
  author: ConversationMessageAuthor;
  received_at?: string;
};

function conversationTimestamp(value?: number | string | null): string {
  const parsed = typeof value === "number" ? value : value ? new Date(value).getTime() : Number.NaN;
  const earliestAccepted = Date.UTC(2000, 0, 1);
  const latestAccepted = Date.now() + 10 * 60_000;
  return Number.isFinite(parsed) && parsed >= earliestAccepted && parsed <= latestAccepted
    ? new Date(parsed).toISOString()
    : new Date().toISOString();
}

function defaultConversationAuthor(role: ConversationMessageRecord["role"]): ConversationMessageAuthor {
  if (role === "user") return "customer";
  if (role === "human") return "human";
  return "automation";
}

// deno-lint-ignore no-explicit-any
async function appendToConversationResult(
  convId: string,
  // deno-lint-ignore no-explicit-any
  existing: any[],
  // "human" = digitada por um atendente (painel ou celular da loja).
  role: "user" | "assistant" | "human",
  content: string,
  options: {
    author?: ConversationMessageAuthor;
    timestamp?: number | string | null;
    receivedAt?: string;
    eventId?: string;
    required?: boolean;
  } = {},
) {
  // Append atômico via RPC: evita perda quando dois processos appendam
  // simultaneamente (inbound + worker). O array retornado é uma "previsão
  // local" mantida pra callers que encadeiam appendToConversation. Inbound
  // usa `required` + event_id do provider e força reentrega antes de qualquer
  // resposta; append após envio externo devolve `persisted:false` para o
  // outcome registrar degradação sem repetir cegamente a mensagem.
  const newMsg: ConversationMessageRecord = {
    event_id: options.eventId ?? crypto.randomUUID(),
    role,
    content,
    timestamp: conversationTimestamp(options.timestamp),
    author: options.author ?? defaultConversationAuthor(role),
    ...(options.receivedAt ? { received_at: options.receivedAt } : {}),
  };
  const persisted = await appendConversationMessageRpc(convId, newMsg);
  if (options.required && !persisted) throw new Error("conversation_message_persist_failed");
  return { messages: [...existing, newMsg], persisted };
}

/**
 * Grava a mensagem recebida na conversa e RETORNA — sem agente, sem resposta
 * automática, sem ferramenta, sem envio. Chamado pelos gates de billing, que
 * silenciam a IA mas não podem fazer o cliente sumir do histórico: o operador
 * precisa ver o que chegou quando o serviço voltar (§6.10 da spec).
 *
 * RAMO-FOLHA DE PROPÓSITO: nada aqui é movido para antes dos gates. Não roda
 * interceptador de avaliação, não roda handoff, não dorme no debounce e não
 * reivindica `try_claim_conversation_for_ai` — a ordem do fluxo concorrente
 * fica intocada. A deduplicação por `providerMessageId` já aconteceu a
 * montante (INSERT em `processed_messages`), então reentrega do mesmo id nem
 * chega aqui; e o append é atômico pela RPC `append_conversation_message`.
 *
 * Não lança internamente; o caller converte `false` em falha reentregável. O
 * event_id estável torna a reentrega segura e impede confirmar sucesso sem que
 * o inbound exista na timeline.
 */
async function persistInboundOnly(args: {
  requestId: string;
  organizationId: string;
  unitId: string;
  phone: string;
  contactName: string | null | undefined;
  text: string;
  chatLid: string | null;
  timestamp: number;
  receivedAt: string;
  eventId: string;
}): Promise<boolean> {
  try {
    if (!args.organizationId || !args.unitId) return false;

    const customer = await resolveOrCreateCustomer(supabase, {
      organizationId: args.organizationId,
      phone: args.phone,
      name: args.contactName ?? args.phone,
    });

    const conv = await getOrCreateConversation(customer.id, args.unitId, args.contactName ?? undefined, args.chatLid);
    if (!conv) return false;

    const newMsg: ConversationMessageRecord = {
      event_id: args.eventId,
      role: "user",
      content: args.text,
      timestamp: conversationTimestamp(args.timestamp),
      author: "customer",
      received_at: args.receivedAt,
    };
    return await appendConversationMessageRpc(conv.id, newMsg);
  } catch (e) {
    jsonLog("warn", { requestId: args.requestId, evt: "persist_inbound_only_failed", err: String(e) });
    return false;
  }
}

/**
 * Fase D — captura do `referral` de anúncio Click-to-WhatsApp.
 *
 * Adapter de I/O: toda decisão está em `_shared/whatsapp-ad-touchpoint-core.ts`.
 * Chamado nos DOIS caminhos de inbound (texto e mídia), sempre DEPOIS do claim de
 * `processed_messages` (reentrega barrada não chega aqui; o UNIQUE é a segunda
 * barreira) e ANTES de rate limit, billing, suspensão e de qualquer efeito
 * externo — "esta pessoa chegou por este anúncio" não depende de a loja estar
 * adimplente, e é o "antes de efeito externo" que torna a falha reentregável.
 *
 * - Provider sem `adReferral` (Z-API, WAHA, UazAPI): sai antes de qualquer I/O e
 *   de qualquer log — comportamento de hoje, byte a byte.
 * - Falha de banco LANÇA `ad_touchpoint_persist_failed`: o `catch` externo libera
 *   o claim e o provider reentrega (D8 da spec). `23505` é dedupe silencioso.
 * - Cliente com `deleted_at` (`customer_not_alive`, SQLSTATE dedicado da 115)
 *   NÃO lança: loga em `warn` e segue. A recusa é persistente — um soft delete
 *   direto que não troca o telefone devolve sempre o mesmo cliente — e
 *   reentregá-la calaria o cliente para sempre.
 * - Recusa do núcleo NÃO lança: bug nosso de split não pode calar o cliente.
 *
 * `unitId`/`channelId` vêm do canal lido pela querystring — nunca do payload: o
 * referral é dado do cliente, não identidade de tenant.
 */
async function captureAdTouchpoint(args: {
  requestId: string;
  provider: WhatsAppProvider;
  payload: unknown;
  unitId: string;
  channelId: string;
  inboundProviderMessageId: string;
  phone: string;
  contactName: string | null;
  messageAtMs: number;
}): Promise<void> {
  if (!hasAdReferralCapture(args.provider)) return;

  jsonLog("info", {
    requestId: args.requestId,
    evt: "meta_inbound_referral_probe",
    provider: args.provider,
    ...describeReferralProbe(args.payload),
  });

  const referral = parseAdReferral(args.provider, args.payload);
  if (!referral) return;

  const { data: unitRow, error: unitError } = await supabase
    .from("units")
    .select("organization_id")
    .eq("id", args.unitId)
    .maybeSingle();
  if (unitError || !unitRow?.organization_id) throw new Error("ad_touchpoint_persist_failed");

  let customerId: string;
  try {
    // Idempotente. No caminho de texto o cliente ainda não foi resolvido neste
    // ponto; no de mídia será resolvido de novo logo adiante — uma consulta a
    // mais, só quando há referral.
    const customer = await resolveOrCreateCustomer(supabase, {
      organizationId: String(unitRow.organization_id),
      phone: args.phone,
      name: args.contactName ?? args.phone,
    });
    customerId = customer.id;
  } catch {
    throw new Error("ad_touchpoint_persist_failed");
  }

  const built = buildAdTouchpointRow({
    provider: args.provider,
    unitId: args.unitId,
    channelId: args.channelId,
    customerId,
    inboundProviderMessageId: args.inboundProviderMessageId,
    messageAtMs: args.messageAtMs,
    referral,
  });
  if (built.ok === false) {
    jsonLog("warn", {
      requestId: args.requestId,
      evt: "ad_referral_rejected",
      ...describeCapturedReferral({ provider: args.provider, outcome: "rejected", referral, rejectReason: built.reason }),
    });
    return;
  }

  const { error: insertError } = await supabase.from("whatsapp_ad_touchpoints").insert(built.row);
  const outcome = classifyTouchpointInsert(insertError);
  jsonLog(outcome === "failed" ? "error" : outcome === "customer_not_alive" ? "warn" : "info", {
    requestId: args.requestId,
    evt: "ad_referral_captured",
    ...describeCapturedReferral({
      provider: args.provider,
      outcome,
      referral,
      rawOmittedReason: built.rawOmittedReason,
      rawDroppedKeys: built.rawDroppedKeys,
    }),
    // Só o SQLSTATE: a mensagem do Postgres pode repetir valores da linha.
    ...(outcome === "failed" ? { code: insertError?.code ?? null } : {}),
  });
  if (outcome === "failed") throw new Error("ad_touchpoint_persist_failed");
}

function mediaPlaceholder(kind: InboundMediaKind): string {
  switch (kind) {
    case "audio": return "[áudio]";
    case "image": return "[imagem]";
    case "video": return "[vídeo]";
    case "document": return "[documento]";
    case "sticker": return "[figurinha]";
    case "location": return "[localização]";
    case "contacts": return "[contato]";
    default: return "[mídia]";
  }
}

const MEDIA_REPLY_TEXT = "Por aqui só consigo ler texto. Pode me escrever a informação que precisa? Se quiser falar com a equipe, é só pedir.";

// Remetente implausível = não é cliente. O eco da Z-API chega com `phone` no
// formato LID do WhatsApp (14+ dígitos), que `canonicalBrPhone` deixa passar
// intacto por não ter 10/12/13 dígitos — vira customer fantasma. Telefone real,
// BR ou internacional, cabe em 13 dígitos após a canonicalização.
function isPlausibleCustomerPhone(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 13;
}

// Grava no thread a mensagem que SAIU do número da loja e a Z-API devolveu ao
// webhook (toggle "Notificar as enviadas por mim também"). É a única forma de o
// painel enxergar o que o atendente digita no celular — sem isso o operador vê
// a pergunta do cliente, um vazio, e a próxima pergunta.
//
//   fromApi: true  → saiu pela API (agente/painel). Já foi appendada no envio;
//                    gravar de novo duplicaria o balão.
//   fromApi: false → digitada no aparelho por uma pessoa → `role: "human"`.
//
// A conversa é resolvida em duas camadas porque o `phone` do eco às vezes vem
// como LID do WhatsApp: telefone utilizável resolve direto; senão cai no
// `wa_chat_lid` aprendido do inbound (migration 070). Sem nenhum dos dois,
// termina em `own_message_echo_unresolved` — outcome visível é melhor do que
// pendurar a mensagem na conversa errada.
//
// NÃO cria customer: um eco pode ser pra fornecedor ou contato pessoal, e criar
// cliente a partir daí poluiria a base que alimenta giftback/aniversário.
async function handleOwnMessageEcho(
  provider: WhatsAppProvider,
  echo: OwnMessageEcho,
  unitId: string | null,
  channelId: string,
): Promise<{ outcome: string; reason: string; meta: Record<string, unknown> }> {
  const shape = describeIgnoredPayload(provider, echo.raw);
  let echoMessageId: string | null = null;
  let echoClaimId: string | null = null;
  const done = async (outcome: string, reason: string, extra?: Record<string, unknown>) => {
    if (echoMessageId && echoClaimId) {
      await markProcessed(provider, echoMessageId, echoClaimId, outcome);
      echoMessageId = null;
      echoClaimId = null;
    }
    return { outcome, reason, meta: { ...shape, reason, ...extra } };
  };

  try {
    if (!unitId) return await done("own_message_echo", "unit_missing");
    if (echo.source === "provider_api") return await done("own_message_echo", "from_api");

    const text = echo.text;
    const messageId = echo.providerMessageId;
    if (messageId) {
      // A Z-API reentrega o mesmo evento (observado em produção nos callbacks de
      // status). A RPC distingue duplicata de indisponibilidade do banco e
      // cerca takeover/finalização com UUID; erro de persistência nunca vira 200.
      const { data: echoClaimData, error: echoClaimError } = await supabase.rpc(
        "claim_processed_whatsapp_message",
        {
          p_provider: provider,
          p_message_id: messageId,
          p_unit_id: unitId,
          p_stale_after_seconds: Math.ceil(STUCK_PROCESSING_TIMEOUT_MS / 1000),
        },
      );
      if (echoClaimError) throw new Error("processed_message_claim_failed");
      const echoClaim = Array.isArray(echoClaimData) ? echoClaimData[0] : echoClaimData;
      if (!echoClaim?.claimed || !echoClaim.claim_id) {
        if (!echoClaim?.previous_outcome) throw new Error("processed_message_inflight");
        return await done("own_message_echo", "duplicate");
      }
      echoMessageId = messageId;
      echoClaimId = String(echoClaim.claim_id);

      // Trava extra: se o id é de notificação NOSSA, não veio do atendente.
      // Protege se `fromApi` mudar de semântica numa versão futura da Z-API.
      const { data: ours, error: oursError } = await supabase
        .from("notifications_sent")
        .select("id")
        .eq("unit_id", unitId)
        .eq("whatsapp_provider", provider)
        .eq("whatsapp_channel_id", channelId)
        .eq("provider_message_id", messageId)
        .limit(1)
        .maybeSingle();
      if (oursError) throw new Error("own_notification_lookup_failed");
      if (ours) return await done("own_message_echo", "own_notification");
    }

    const phone = canonicalBrPhone(String(echo.peerPhone ?? ""));
    const chatLid = echo.peerLid;
    const contactName = echo.contactName?.trim() ?? "";

    // deno-lint-ignore no-explicit-any
    let conv: any = null;

    if (isPlausibleCustomerPhone(phone)) {
      const { data: unitRow, error: unitError } = await supabase
        .from("units").select("organization_id").eq("id", unitId).maybeSingle();
      if (unitError) throw new Error("echo_unit_lookup_failed");
      const orgId: string = unitRow?.organization_id ?? "";
      if (orgId) {
        const { data: customer, error: customerError } = await supabase
          .from("customers").select("id")
          .eq("organization_id", orgId).eq("phone", phone).maybeSingle();
        if (customerError) throw new Error("echo_customer_lookup_failed");
        if (customer) {
          conv = await getOrCreateConversation(customer.id, unitId, contactName || undefined, chatLid);
        }
      }
      if (!conv) return await done("own_message_echo_unresolved", "customer_unknown");
    } else if (chatLid) {
      const { data, error: conversationError } = await supabase
        .from("conversations").select("*")
        .eq("unit_id", unitId).eq("wa_chat_lid", chatLid).maybeSingle();
      if (conversationError) throw new Error("echo_conversation_lookup_failed");
      conv = data;
      if (!conv) return await done("own_message_echo_unresolved", "lid_unknown");
    } else {
      return await done("own_message_echo_unresolved", "no_identity");
    }

    const humanMessage: ConversationMessageRecord = {
      event_id: `wa-own:${provider}:${echo.providerMessageId}`,
      role: "human",
      content: text,
      timestamp: conversationTimestamp(echo.timestamp),
      author: "human",
      received_at: new Date().toISOString(),
    };
    let recordError: { message: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await supabase.rpc("record_whatsapp_human_message", {
        p_conversation_id: conv.id,
        p_unit_id: unitId,
        p_message: humanMessage,
        p_handoff_reason: "atendente respondeu pelo WhatsApp da loja",
      });
      recordError = result.error;
      if (!recordError) break;
    }
    if (recordError) {
      jsonLog("warn", { evt: "own_message_echo_record_failed", convId: conv.id, err: recordError.message });
      if (echoMessageId && echoClaimId) {
        const { error: releaseError } = await supabase.rpc("release_processed_whatsapp_message_claim", {
          p_provider: provider,
          p_message_id: echoMessageId,
          p_claim_id: echoClaimId,
        });
        if (releaseError) {
          jsonLog("error", { evt: "own_message_echo_claim_release_failed", err: releaseError.message });
        } else {
          echoMessageId = null;
          echoClaimId = null;
        }
      }
      throw new Error("human_message_record_failed");
    }

    return await done("own_message_echo_recorded", "recorded", {
      convId: conv.id,
      silenced: true,
    });
  } catch (e) {
    const mustRetry = e instanceof Error && [
      "processed_message_claim_failed",
      "processed_message_inflight",
      "human_message_record_failed",
      "own_notification_lookup_failed",
      "echo_unit_lookup_failed",
      "echo_customer_lookup_failed",
      "echo_conversation_lookup_failed",
    ].includes(e.message);
    if (mustRetry && echoMessageId && echoClaimId) {
      const { error: releaseError } = await supabase.rpc("release_processed_whatsapp_message_claim", {
        p_provider: provider,
        p_message_id: echoMessageId,
        p_claim_id: echoClaimId,
      });
      if (releaseError) jsonLog("error", { evt: "own_message_echo_claim_release_failed", err: releaseError.message });
      else {
        echoMessageId = null;
        echoClaimId = null;
      }
    }
    if (mustRetry) throw e;
    // Nunca derruba o webhook por causa do eco: pior caso é a mensagem do
    // atendente não aparecer, que é exatamente o estado anterior. A exceção é
    // indisponibilidade da idempotência: nesse caso 5xx força reentrega segura.
    jsonLog("warn", { evt: "own_message_echo_failed", err: String(e) });
    return await done("own_message_echo", "handler_error");
  }
}

// Qual campo do eco carrega o telefone REAL do destinatário. No eco da Z-API o
// `phone` vem como LID do WhatsApp (14+ dígitos), não como número — sem saber a
// alternativa, não dá pra pendurar a mensagem do atendente na conversa certa.
// Só COMPRIMENTO e flags: nenhum número sai daqui.
// deno-lint-ignore no-explicit-any
function identityShape(p: any): Record<string, unknown> {
  const digits = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");
  const len = (v: unknown) => (typeof v === "string" ? digits(v).length : null);
  const phoneD = digits(p.phone);
  const connectedD = digits(p.connectedPhone);
  return {
    phone_len: len(p.phone),
    chat_lid_len: len(p.chatLid),
    participant_phone_len: len(p.participantPhone),
    participant_lid_len: len(p.participantLid),
    connected_phone_len: len(p.connectedPhone),
    // Se true, `phone` é o número da LOJA (inútil como destinatário).
    phone_is_connected: !!phoneD && phoneD === connectedD,
    from_api: p.fromApi === true,
    is_group: p.isGroup === true,
  };
}

// Sumário PRIVACY-SAFE do payload que caiu em `ignored_non_text` — só NOMES de
// chave, flags booleanas e o discriminador de tipo/evento; nunca conteúdo,
// telefone ou credencial. Sem isso o outcome é um ponto cego: é o 2º evento
// mais frequente do webhook e não dá pra saber se é eco das nossas próprias
// mensagens, mensagem digitada no celular da loja, ou tipo de mídia novo.
// deno-lint-ignore no-explicit-any
function describeIgnoredPayload(provider: WhatsAppProvider, payload: any): Record<string, unknown> {
  try {
    if (!payload || typeof payload !== "object") return { provider, shape: typeof payload };
    // WAHA aninha em `payload`; Meta aninha em entry[0].changes[0].value.
    const inner = provider === "waha"
      ? (payload.payload ?? payload)
      : isMetaShapedProvider(provider)
      ? (payload.entry?.[0]?.changes?.[0]?.value ?? payload)
      : payload;
    const p = inner && typeof inner === "object" ? inner : {};
    const metaMsg = isMetaShapedProvider(provider) ? p.messages?.[0] : null;
    return {
      provider,
      keys: Object.keys(p).slice(0, 30),
      type: typeof (metaMsg?.type ?? p.type) === "string" ? (metaMsg?.type ?? p.type) : null,
      event: typeof payload.event === "string" ? payload.event : null,
      // Discriminador de FAMÍLIA de envelope do provedor (ex.: "messages" x
      // "messages_update" na UazAPI), não é dado do cliente. É ele que decide
      // qual parser roda — e o que `keys` sozinho não revelava.
      event_type: typeof p.EventType === "string" ? p.EventType : null,
      // Só a FORMA do evento aninhado (nomes + tipos). É aqui que a UazAPI põe
      // os ids e o status de um recibo, e é o que falta pra escrever o parser.
      nested_shape: p.event && typeof p.event === "object" ? shapeOf(p.event) : null,
      // Enum de recibo do whatsmeow ("", "delivery", "read", "read-self",
      // "played", ...) — é ELE que separa entregue de lida. String vazia é um
      // valor legítimo (entrega), por isso `null` só quando o campo não existe.
      receipt_type: typeof p.event?.Type === "string" ? p.event.Type : null,
      receipt_from_me: typeof p.event?.IsFromMe === "boolean" ? p.event.IsFromMe : null,
      // Enum do provedor (SENT/RECEIVED/READ/READ_BY_ME/...), não é dado do cliente.
      // É o discriminador de qual status o mapa de whatsapp-status.ts não cobre.
      status: typeof p.status === "string" ? p.status : null,
      ...identityShape(p),
      from_me: p.isFromMe === true || p.fromMe === true,
      has_text: !!(p.text?.message ?? p.body ?? metaMsg?.text?.body),
      has_message_id: !!(p.messageId ?? p.id ?? metaMsg?.id),
    };
  } catch {
    return { provider, describe_failed: true };
  }
}

// ─── Tool log helpers ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
function summarizeToolInput(input: any): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["date", "time", "party_size", "reservation_code", "reason"]) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  if (input.customer_name) out.customer_name = "***";
  return out;
}

// deno-lint-ignore no-explicit-any
function summarizeToolResult(result: any): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["available", "success", "found", "ok", "reason", "reservation_code", "count"]) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  if (result.error) out.error = String(result.error).slice(0, 200);
  return out;
}

// ─── Telemetry helpers (idempotência + webhook_executions) ────────────────────

const STUCK_PROCESSING_TIMEOUT_MS = 90_000;
const HANDOFF_AUTO_RESOLVE_MS = 12 * 60 * 60 * 1000;       // 12h
const HANDOFF_REMINDER_THROTTLE_MS = 6 * 60 * 60 * 1000;   // 6h

/**
 * Texto de instabilidade — UMA constante, não quatro literais.
 *
 * Ele é enviado em três desfechos diferentes E precisa estar no
 * `HARDCODED_AGENT_NOISE`. Redigitado, editar um sem os outros faz a mensagem
 * escapar do filtro e poluir o histórico das invocações seguintes, que é
 * exatamente a razão de os textos do Plano D entrarem por lista importada.
 */
const AGENT_INSTABILITY_TEXT =
  "Tive um instante de instabilidade aqui. Já chamei alguém da equipe pra te responder. Em breve um humano assume.";

// Janela de agregação (debounce) de rajada: cliente costuma mandar várias
// mensagens picadas em poucos segundos. Esperamos esse intervalo antes de
// acionar o LLM; se chegar mensagem mais nova na MESMA conversa durante a
// espera, esta invocação desiste — quem responde é a invocação da ÚLTIMA
// mensagem, que relê o histórico fresco e responde uma vez só com a rajada
// inteira. Tunável: maior = pega rajadas mais lentas mas atrasa toda resposta.
//
// O valor vem do núcleo (e não é literal aqui) porque a varredura da Fase C
// reserva o pior caso de UM evento, e esta janela é a primeira parcela dele:
// mudar o debounce sem mudar a reserva faria a varredura começar um evento que
// não cabe no que resta do wall clock.
const DEBOUNCE_WINDOW_MS = INBOUND_DEBOUNCE_WINDOW_MS;
// Orçamento de tempo (desde o início da request) para um retry silencioso do
// agente após erro transitório. Acima disso não retentamos, porque uma segunda
// tentativa longa arrisca o cliente não receber NADA.
//
// A versão anterior desta linha justificava o valor com "o limite de 60s da Edge
// Function". Esse número é crença herdada, não medição, e este mesmo arquivo o
// contradiz: `AI_LOCK_TTL_SECONDS` existe porque um turno de pior caso leva
// ~51s, e somado ao debounce de 6s isso já passaria de 60s no caminho síncrono
// que atende loja real hoje. O wall clock, além disso, é do WORKER e não da
// request. Os 30s seguem valendo como política — uma resposta que demora demais
// já é resposta errada —, e não como dedução de um teto que ninguém mediu.
const AGENT_RETRY_BUDGET_MS = 30_000;
// TTL do lock de exclusão do agente por conversa. Auto-expira se a função
// crashar segurando o lock. Ver migration 056_conversation_ai_lock.
//
// O valor deixou de ser adivinhado: `lockTtlSecondsRequired()` o deriva da soma
// declarada — orçamento do prazo + pior turno único + envio —, e um teste de
// acoplamento reprova se ele cair abaixo disso. A justificativa antiga ("pior
// caso de runOnce, ~51 s") media UM turno, não o laço.
//
// A aritmética VINCULA o caminho da FILA, que é onde o prazo vale. No síncrono
// não há teto de parede nenhum (ver a nota em `shouldContinue`), então aqui os
// 90 s são piso de segurança contra lock órfão, nunca prova de que o turno cabe.
const AI_LOCK_TTL_SECONDS = 90;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Marca o ciclo de vida da mensagem em processed_messages.
async function markProcessed(
  provider: WhatsAppProvider,
  messageId: string,
  claimId: string,
  outcome: string,
  error?: string | null,
): Promise<void> {
  try {
    const { data, error: completeError } = await supabase.rpc(
      "complete_processed_whatsapp_message",
      {
        p_provider: provider,
        p_message_id: messageId,
        p_claim_id: claimId,
        p_outcome: outcome,
        p_error: error ?? null,
      },
    );
    if (completeError || data !== true) {
      jsonLog("warn", { evt: "mark_processed_fence_lost", messageId });
    }
  } catch (e) {
    jsonLog("error", { evt: "mark_processed_failed", messageId, err: String(e) });
  }
}

// Insere uma linha em webhook_executions — best-effort, nunca lança.
async function recordExecution(payload: {
  request_id: string;
  unit_id: string | null;
  channel_id: string | null;
  phone_hash: string | null;
  outcome: string;
  error?: string | null;
  duration_ms: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await supabase.from("webhook_executions").insert({
      request_id: payload.request_id,
      unit_id: payload.unit_id,
      channel_id: payload.channel_id,
      phone_hash: payload.phone_hash,
      outcome: payload.outcome,
      error: payload.error ?? null,
      duration_ms: payload.duration_ms,
      meta: payload.meta ?? {},
    });
  } catch (e) {
    jsonLog("error", { evt: "record_execution_failed", err: String(e) });
  }
}

// ─── Giftback helper ──────────────────────────────────────────────────────────

/**
 * Resolve a regra e código de voucher candidato, mas NÃO persiste ainda.
 * Retorna null quando: WhatsApp desabilitado pra unit, sem regra ativa
 * compatível com a nota, ou já existe voucher ativo (rule, customer).
 *
 * Caller chama `commitGiftbackVoucher` depois do send confirmado.
 */
// deno-lint-ignore no-explicit-any
async function prepareGiftbackVoucher(args: {
  supabase: any;
  unitId: string;
  customerId: string;
  rating: number;
}): Promise<
  | {
      ruleId: string;
      discountPercent: number;
      validityDays: number;
      code: string;
      expiresAtIso: string;
      text: string;
      template: string;
      unitName: string;
    }
  | null
> {
  const { supabase, unitId, customerId, rating } = args;

  // Settings: WhatsApp ligado? Template?
  const { data: settingsRows } = await supabase
    .from("settings")
    .select("key, value")
    .eq("unit_id", unitId)
    .in("key", ["giftback_whatsapp_enabled", "giftback_message_template"]);
  // deno-lint-ignore no-explicit-any
  const settings = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value]));
  const whatsappEnabled =
    settings.giftback_whatsapp_enabled === false ||
    settings.giftback_whatsapp_enabled === "false"
      ? false
      : true;
  if (!whatsappEnabled) return null;
  const template: string =
    typeof settings.giftback_message_template === "string" && settings.giftback_message_template
      ? settings.giftback_message_template
      : DEFAULT_GIFTBACK_TEMPLATE;

  // Regra ativa after_rating compatível com a nota.
  // min_rating é NOT NULL via CHECK quando trigger_type='after_rating' (migration
  // 20260517110000), então não testamos IS NULL aqui.
  const { data: rule } = await supabase
    .from("voucher_rules")
    .select("id, discount_percent, validity_days, min_rating")
    .eq("unit_id", unitId)
    .eq("trigger_type", "after_rating")
    .eq("active", true)
    .lte("min_rating", rating)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!rule) return null;

  // Já existe voucher ativo (rule, customer)? Constraint
  // vouchers_unit_rule_customer_active_idx também protege via 23505 no insert,
  // mas o check explícito evita gerar mensagem que nunca vai ser persistida.
  const { data: existing } = await supabase
    .from("vouchers")
    .select("id")
    .eq("unit_id", unitId)
    .eq("customer_id", customerId)
    .eq("rule_id", rule.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (existing) return null;

  const code = await ensureUniqueVoucherCode(supabase);
  const expiresAtIso = expiresAtEndOfDayBrt(rule.validity_days as number);

  const { data: unitRow } = await supabase
    .from("units")
    .select("name")
    .eq("id", unitId)
    .maybeSingle();
  const unitName = (unitRow?.name as string) ?? "nosso restaurante";

  const text = renderGiftbackTemplate(template, {
    discount: rule.discount_percent as number,
    unidade: unitName,
    codigo: code,
    validade: formatExpiryBR(expiresAtIso),
  });

  return {
    ruleId: rule.id as string,
    discountPercent: rule.discount_percent as number,
    validityDays: rule.validity_days as number,
    code,
    expiresAtIso,
    text,
    template,
    unitName,
  };
}

/**
 * Persiste o voucher e a notification após confirmação de envio.
 * `sendOk` reflete o resultado real do WhatsApp — `notifications_sent.status`
 * é gravado fiel (sent/failed). Voucher só é inserido quando `sendOk=true`
 * pra evitar voucher fantasma quando o envio falha.
 */
async function commitGiftbackVoucher(args: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  unitId: string;
  customerId: string;
  prepared: NonNullable<Awaited<ReturnType<typeof prepareGiftbackVoucher>>>;
  sendOk: boolean;
  sendError?: string | null;
  reservationId: string | null;
  requestId: string;
}): Promise<void> {
  const { supabase, unitId, customerId, prepared, sendOk, sendError, reservationId, requestId } = args;

  if (sendOk) {
    const { error: insertErr } = await supabase
      .from("vouchers")
      .insert({
        unit_id: unitId,
        rule_id: prepared.ruleId,
        customer_id: customerId,
        code: prepared.code,
        discount_percent: prepared.discountPercent,
        expires_at: prepared.expiresAtIso,
      });

    if (insertErr) {
      // 23505 = UNIQUE violation. Outro handler em paralelo já inseriu
      // (B4 — race em reprocessing_stuck_message). Tratamos como dedupe.
      const isDuplicate = String(insertErr.code ?? "") === "23505";
      jsonLog(isDuplicate ? "info" : "warn", {
        requestId,
        evt: isDuplicate ? "voucher_dedup_race" : "voucher_insert_failed",
        error: insertErr.message,
      });
      if (!isDuplicate) {
        // Cliente já recebeu a mensagem com o code mas nada está persistido.
        // Caso raríssimo. Loga pra investigação manual.
        return;
      }
    } else {
      jsonLog("info", { requestId, evt: "voucher_issued", code: prepared.code });
    }
  }

  await supabase.from("notifications_sent").insert({
    unit_id: unitId,
    kind: "voucher_issued",
    status: sendOk ? "sent" : "failed",
    sent_at: new Date().toISOString(),
    reservation_id: reservationId ?? null,
    error: sendOk ? null : (sendError ?? "send_failed"),
  });
}

// ─── System prompt: bloco de horários por salão ────────────────────────────────
//
// Monta a representação textual dos horários de reserva a partir de
// `halls` + `hall_schedules` — fonte autoritativa desde a migration 030.
// O prompt do agente usava `business_hours` (DEPRECATED, fallback pré-030).
// Unidades novas (Ren Sushi etc.) só preenchem `hall_schedules`, então o
// bloco "Horário de funcionamento" ia vazio e o LLM caía em handoff por
// "não tenho a informação aqui". Retorna `null` se não há halls ativos com
// schedules — caller usa fallback de business_hours nesse caso.
const DAY_ABBR = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

// Agrupa dias 0-6 que compartilham o mesmo padrão de janelas. Dias
// consecutivos viram range ("seg a sex"), 2 não-consecutivos viram "sex e
// sáb", e o caso geral fica solto ("dom"). Dias sem janela são ignorados.
function formatDaysByPattern(daysByPattern: Map<string, number[]>): { pattern: string; days: number[] }[] {
  return [...daysByPattern.entries()].map(([pattern, days]) => ({
    pattern,
    days: [...days].sort((a, b) => a - b),
  }));
}

function describeDays(days: number[]): string {
  if (days.length === 0) return "";
  if (days.length === 1) return DAY_ABBR[days[0]];
  // Verifica se é range consecutivo (ex: 1,2,3,4,5 → "seg a sex").
  const isRange = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (isRange && days.length >= 3) {
    return `${DAY_ABBR[days[0]]} a ${DAY_ABBR[days[days.length - 1]]}`;
  }
  if (days.length === 2) return `${DAY_ABBR[days[0]]} e ${DAY_ABBR[days[1]]}`;
  // 3+ dias não-consecutivos: lista com vírgulas e "e" no último.
  const labels = days.map((d) => DAY_ABBR[d]);
  return `${labels.slice(0, -1).join(", ")} e ${labels[labels.length - 1]}`;
}

interface WindowRow {
  open_time: string;
  close_time: string;
  min_advance_minutes: number | null;
  discount_percent: number | null;
  charge_enabled: boolean;
  charge_amount_cents: number | null;
}

function formatWindowAnnotations(w: WindowRow): string {
  const parts: string[] = [];
  if (w.discount_percent && w.discount_percent > 0) parts.push(`${w.discount_percent}% off`);
  if (w.min_advance_minutes && w.min_advance_minutes > 0) {
    const h = Math.floor(w.min_advance_minutes / 60);
    const m = w.min_advance_minutes % 60;
    const label = h > 0 && m > 0 ? `${h}h${m}min` : h > 0 ? `${h}h` : `${m}min`;
    parts.push(`antecedência mínima ${label}`);
  }
  if (w.charge_enabled && w.charge_amount_cents && w.charge_amount_cents > 0) {
    const brl = (w.charge_amount_cents / 100).toFixed(2).replace(".", ",");
    parts.push(`caução R$ ${brl}/mesa`);
  }
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

function formatWindowsForDayDetailed(rows: WindowRow[]): string {
  const sorted = [...rows].sort((a, b) => a.open_time.localeCompare(b.open_time));
  return sorted
    .map((r) => `${r.open_time.slice(0, 5)} às ${r.close_time.slice(0, 5)}${formatWindowAnnotations(r)}`)
    .join("; ");
}

async function buildHallSchedulesBlock(unitId: string): Promise<string | null> {
  const { data: halls } = await supabase
    .from("halls")
    .select("id, name, description, allow_empty_seat, sort_order")
    .eq("unit_id", unitId)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (!halls || halls.length === 0) return null;

  const hallIds = halls.map((h: { id: string }) => h.id);
  const { data: schedules } = await supabase
    .from("hall_schedules")
    .select("hall_id, day_of_week, open_time, close_time, min_advance_minutes, discount_percent, charge_enabled, charge_amount_cents")
    .in("hall_id", hallIds);

  if (!schedules || schedules.length === 0) return null;

  // Capacidade por hall: agrega min(min_capacity) e max(max_capacity) das
  // mesas ativas. Pra responder "tem mesa pra X pessoas?" sem chamar tool.
  const { data: tables } = await supabase
    .from("tables")
    .select("hall_id, min_capacity, max_capacity")
    .in("hall_id", hallIds)
    .eq("active", true);

  const capByHall = new Map<string, { min: number; max: number }>();
  for (const t of (tables ?? []) as { hall_id: string | null; min_capacity: number; max_capacity: number }[]) {
    if (!t.hall_id) continue;
    const cur = capByHall.get(t.hall_id);
    if (!cur) {
      capByHall.set(t.hall_id, { min: t.min_capacity, max: t.max_capacity });
    } else {
      cur.min = Math.min(cur.min, t.min_capacity);
      cur.max = Math.max(cur.max, t.max_capacity);
    }
  }

  const hallLines: string[] = [];
  for (const hall of halls as { id: string; name: string; description: string | null; allow_empty_seat: boolean }[]) {
    const byDay = new Map<number, WindowRow[]>();
    for (const s of schedules as (WindowRow & { hall_id: string; day_of_week: number })[]) {
      if (s.hall_id !== hall.id) continue;
      const arr = byDay.get(s.day_of_week) ?? [];
      arr.push(s);
      byDay.set(s.day_of_week, arr);
    }

    if (byDay.size === 0) continue;

    // Header do hall: nome + descrição + capacidade.
    const headerParts: string[] = [];
    if (hall.description) headerParts.push(hall.description);
    const cap = capByHall.get(hall.id);
    if (cap) {
      const effectiveMin = hall.allow_empty_seat ? Math.max(1, cap.min - 1) : cap.min;
      headerParts.push(`mesas para ${effectiveMin}${effectiveMin === cap.max ? "" : ` a ${cap.max}`} pessoas`);
    }
    const headerSuffix = headerParts.length > 0 ? ` — ${headerParts.join("; ")}` : "";

    // Padrão de janelas (detalhado) → dias que compartilham.
    const patternToDays = new Map<string, number[]>();
    for (const [dow, rows] of byDay.entries()) {
      const pattern = formatWindowsForDayDetailed(rows);
      const days = patternToDays.get(pattern) ?? [];
      days.push(dow);
      patternToDays.set(pattern, days);
    }

    const groups = formatDaysByPattern(patternToDays);
    groups.sort((a, b) => a.days[0] - b.days[0]);

    const lines = groups.map((g) => `  - ${describeDays(g.days)}: ${g.pattern}`);
    hallLines.push(`- ${hall.name}${headerSuffix}:\n${lines.join("\n")}`);
  }

  if (hallLines.length === 0) return null;

  return `Horários de reservas por salão:\n${hallLines.join("\n")}`;
}

// ─── Main handler ──────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 10;
const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/**
 * Persiste a entrega crua. UMA linha por ENTREGA — o split do lote acontece no
 * processamento, sobre este mesmo corpo intacto.
 *
 * Nunca lança: o veredito de HTTP é de `decideAckVerdict`, e uma exceção aqui
 * viraria 500 no lugar do 503 que pede reentrega.
 */
async function persistInboundEvent(input: {
  provider: WhatsAppProvider;
  channelId: string;
  unitId: string;
  bodyText: string;
  deliveryId: string | null;
  signatureHeader: string | null;
  signatureScheme: string | null;
}): Promise<{ outcome: InsertOutcome; id: string | null }> {
  const { data, error } = await supabase
    .from("whatsapp_inbound_events")
    .insert({
      provider: input.provider,
      channel_id: input.channelId,
      unit_id: input.unitId,
      raw_body: encodeRawBodyHex(input.bodyText),
      delivery_id: input.deliveryId,
      signature_header: input.signatureHeader,
      signature_scheme: input.signatureScheme,
    })
    .select("id")
    .maybeSingle();

  if (!error && data) return { outcome: "inserted", id: data.id };
  // Unique parcial `(channel_id, delivery_id)`: a entrega já está durável, e
  // reprocessar seria responder duas vezes ao mesmo cliente.
  if (error?.code === "23505") return { outcome: "duplicate", id: null };
  return { outcome: "failed", id: null };
}

/**
 * Projeção que `claim_whatsapp_inbound_event` devolve. Tipa as SEIS colunas do
 * `returning` da migration 113 — é a documentação do contrato da RPC, no arquivo
 * que a consome.
 */
interface ClaimedInboundEvent {
  id: string;
  provider: WhatsAppProvider;
  channel_id: string;
  /** `bytea`: o PostgREST entrega literal hex (`\x...`), com ou sem prefixo. */
  raw_body: string;
  /**
   * TENTATIVAS GASTAS, já incluindo esta quando o claim foi TAKEOVER de lease
   * vencido — o SQL incrementa no próprio `update` e devolve o valor novo. Quem
   * escreve o número é sempre o banco (aqui e na finalização); incrementá-lo no
   * Deno a partir do que se leu é lost update por construção.
   */
  attempts: number;
  claim_id: string;
}

/**
 * Dead letter VISÍVEL: a entrega que a fila desistiu de processar vira
 * `awaiting_human` na conversa do cliente — reusando o contador que
 * `useAwaitingHumanCount` já mostra ao operador, sem inventar tela.
 *
 * Best-effort e NUNCA LANÇA: é chamada do caminho de finalização da fila, depois
 * de a escrita já ter pegado. Quando não dá para resolver a conversa (o evento
 * morreu antes de ela existir, ou antes de existir cliente), sobra a contagem do
 * diagnóstico — que é por isso que ela existe, e não como decoração.
 *
 * ─── NUNCA CRIA CONVERSA ────────────────────────────────────────────────────
 * Se não existe, não existe. `appendOutboundToConversation` é quem auto-cria;
 * criar uma só para marcá-la em handoff inventaria thread vazia no painel, e o
 * operador abriria uma conversa sem nenhuma mensagem para ler.
 *
 * ─── A CADEIA NÃO É POR TELEFONE ────────────────────────────────────────────
 * `conversations` não tem coluna de telefone: é chaveada por `(customer_id,
 * unit_id)`. E `customers` pertencem à ORGANIZAÇÃO, não à unidade. Então o
 * caminho é unit → `organization_id` → customer por `(organization_id, phone)`
 * → conversa por `(customer_id, unit_id)`. Toda consulta aqui é escopada pelo
 * tenant da PRÓPRIA linha; nada vem de fora.
 *
 * ─── UM LOTE PODE TER VÁRIOS CLIENTES ───────────────────────────────────────
 * A linha da fila guarda o corpo INTEIRO do POST, e um payload de forma Meta
 * agrupa mensagens de remetentes DIFERENTES — é por isso que o handler chama
 * `splitMetaWebhookPayload` antes de processar. `parseInbound` devolve no
 * máximo UMA mensagem, então resolver o payload inteiro promoveria a conversa
 * de um cliente e deixaria os outros sem nada: pior que "não deu para
 * resolver", onde ao menos o contador do painel acusa. Dividir primeiro é o
 * mesmo caminho para todos os providers — `splitMetaWebhookPayloadCore`
 * devolve `[payload]` quando não há `entry`, que é o caso dos quatro legados.
 */
async function promoteDeadLetterToHandoff(eventId: string): Promise<void> {
  try {
    const { data: row } = await supabase
      .from("whatsapp_inbound_events")
      .select("provider, unit_id, raw_body")
      .eq("id", eventId)
      .maybeSingle();
    if (!row) return;

    const provider = row.provider as WhatsAppProvider;
    const unitId = String(row.unit_id);

    // REDIGIDO NA FONTE, e não no `catch` de baixo: a mensagem de erro do
    // `JSON.parse` do V8 EMBUTE um trecho da entrada (`... "{corpo}" is not
    // valid JSON`), e a entrada aqui é o corpo cru do cliente — telefone e
    // texto. `sanitizeProviderError` redige credencial e trunca, mas não
    // conhece essa forma; contar com ele publicaria PII no log sem erro de tipo
    // nem aviso de lint. Mesma disciplina de `fetchConnectionStatus`, que redige
    // a URL com credencial no lugar onde ela nasce.
    let payload: unknown;
    try {
      payload = JSON.parse(decodeRawBodyHex(String(row.raw_body)));
    } catch {
      jsonLog("warn", { evt: "dead_letter_payload_unparseable", eventId });
      return;
    }

    // `Set`: um lote com três mensagens do MESMO cliente é uma conversa só, e
    // promovê-la três vezes reescreveria `handoff_at` a cada volta.
    const senders = new Set<string>();
    for (const part of splitMetaWebhookPayload(payload)) {
      const inbound = parseInbound(provider, part);
      if (!inbound?.fromPhone) continue;
      const phone = canonicalBrPhone(inbound.fromPhone);
      // Mesmo guarda do caminho normal: o eco traz LID do WhatsApp (14+
      // dígitos), que `canonicalBrPhone` deixa passar intacto e que não é
      // cliente nenhum.
      if (!isPlausibleCustomerPhone(phone)) continue;
      senders.add(phone);
    }

    const conta = {
      senders: senders.size,
      promoted: 0,
      alreadyWithHuman: 0,
      noCustomer: 0,
      noConversation: 0,
      updateFailed: 0,
      unitUnresolved: false,
    };

    // A unidade é o degrau para a ORGANIZAÇÃO, que é onde o cliente vive. Não
    // achá-la só acontece se a leitura falhar: a FK de `unit_id` é
    // `on delete cascade`, então unidade apagada leva a linha da fila junto e
    // não haveria evento a promover.
    const { data: unit } = await supabase
      .from("units")
      .select("organization_id")
      .eq("id", unitId)
      .maybeSingle();
    if (!unit) conta.unitUnresolved = true;

    if (unit && senders.size > 0) {
      for (const phone of senders) {
        const { data: customer } = await supabase
          .from("customers")
          .select("id")
          .eq("organization_id", unit.organization_id)
          .eq("phone", phone)
          .maybeSingle();
        if (!customer) {
          conta.noCustomer++;
          continue;
        }

        const { data: conv } = await supabase
          .from("conversations")
          .select("id")
          .eq("unit_id", unitId)
          .eq("customer_id", customer.id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!conv) {
          conta.noConversation++;
          continue;
        }

        // O PREDICADO DE ESTADO ABAIXO PROMOVE SÓ O QUE NENHUMA PESSOA DETÉM.
        // Sem ele, um atendente no meio da conversa (`human_active`)
        // era jogado de volta para a fila de "aguardando"; `handoff_at` —
        // relógio do auto-resolve de 12 h e do lembrete de 6 h — era zerado
        // sob os pés dele; e um `handoff_reason` anterior (`agent_error`,
        // `ai_budget_exhausted`) era APAGADO, levando junto o motivo real da
        // investigação.
        //
        // `resolved` ENTRA na lista, e a primeira versão disto o deixava de fora
        // alegando que "ali um humano já encerrou". Isso lê o passado e erra o
        // presente: `resolved` é estado FÓSSIL — o botão "Resolver" não o grava
        // mais, e o próprio pipeline o promove para `ai_active` na inbound
        // seguinte (linha ~3285), justamente para a UI parar de exibir badge
        // "Resolvida" para sempre. Ninguém está atendendo uma conversa ali.
        //
        // A consequência de omiti-lo era a pior disponível: a promoção casava
        // ZERO linhas, a conversa continuava fóssil, `useAwaitingHumanCount`
        // conta só `awaiting_human` — então a dead letter ficava INVISÍVEL para o
        // lojista, sobrando apenas a contagem do diagnóstico, que é
        // platform-admin-only. E o log afirmava
        // `..._human_already_active` sobre conversa que ninguém atende: rastro de
        // investigação FALSO, que é pior que rastro ausente. Isso reprovava o
        // critério de aceite §14.8 ("quando resolvível, com a conversa em
        // `awaiting_human`") para uma conversa que É resolvível — nós a achamos.
        const { data: promovidas, error: updateError } = await supabase
          .from("conversations")
          .update({
            status: "awaiting_human",
            // UM motivo só, de propósito: o que o operador precisa saber aqui
            // é "esta mensagem não foi processada". POR QUE ela não foi está em
            // `whatsapp_inbound_events.outcome` (`queue_dead_letter` =
            // respondeu não-2xx N vezes; `queue_dead_letter_no_verdict` =
            // consumiu as tentativas sem nunca chegar a um veredito), e é lá
            // que se investiga.
            handoff_reason: "inbound_dead_letter",
            handoff_at: new Date().toISOString(),
            last_silenced_reply_at: null,
          })
          .eq("id", conv.id)
          .in("status", ["ai_active", "resolved"])
          .select("id");

        if (updateError) {
          conta.updateFailed++;
          jsonLog("error", {
            evt: "inbound_dead_letter_promote_failed",
            eventId,
            convId: conv.id,
            err: updateError.message,
          });
          continue;
        }
        // `UPDATE` que casa zero linhas devolve `error: null` no supabase-js
        // (invariante do CLAUDE.md): sem conferir o retorno, "não promovi
        // porque a conversa já era de uma pessoa" fica indistinguível de
        // "promovi", e o log afirmaria a segunda coisa. Zero linhas aqui NÃO é
        // falha — é o caso comum e desejado.
        //
        // O NOME DESTE EVENTO É DERIVADO DO PREDICADO, não escolhido: com
        // `in ('ai_active','resolved')` acima, zero linhas só pode significar
        // `human_active` (uma pessoa atendendo agora) ou `awaiting_human` (já na
        // fila de espera, por este ou outro motivo). Nos dois casos a conversa já
        // está com uma pessoa e aparece para o lojista, que é o que importa aqui.
        // Dizer `human_already_active` cobriria só o primeiro e mentiria sobre o
        // segundo — e quem aperta o predicado depois precisa reconferir este
        // nome, porque ele é uma AFIRMAÇÃO sobre o complemento do predicado.
        if (!promovidas || promovidas.length === 0) {
          conta.alreadyWithHuman++;
          jsonLog("info", {
            evt: "inbound_dead_letter_already_with_human",
            eventId,
            convId: conv.id,
          });
          continue;
        }

        conta.promoted++;
        jsonLog("warn", { evt: "inbound_dead_letter", eventId, convId: conv.id });
      }
    }

    // Uma linha por evento, com as CONTAGENS de cada desfecho — nunca telefone
    // nem texto de cliente. `senders: 0` é o caso "morreu antes de existir
    // cliente", e é ele que justifica a contagem do diagnóstico existir.
    jsonLog("warn", { evt: "inbound_dead_letter_summary", eventId, ...conta });
  } catch (err) {
    // SANITIZADO, nunca o texto cru do erro: neste caminho o `err` pode vir do
    // `JSON.parse` sobre o CORPO CRU do cliente, e mensagem de parse já carregou
    // fragmento de entrada em outros runtimes. A disciplina desta fase é
    // instrumentar FORMA, nunca valor.
    jsonLog("warn", {
      evt: "dead_letter_handoff_failed",
      eventId,
      err: sanitizeProviderError(err),
    });
  }
}

/**
 * Grava o veredito da linha da fila, CERCADO pelo `claim_id`.
 *
 * A decisão — status, outcome, atraso, dead letter — é de `queuedEventVerdict`,
 * no núcleo puro. Nada aqui redigita a escada de retentativa, e nada aqui
 * escreve coluna de tempo: o atraso viaja em SEGUNDOS e quem monta o instante é
 * `now()` do banco. Escrever o futuro com o relógio do Deno para o banco
 * compará-lo com o dele é a borda que este repo já pagou em `availability.ts`.
 *
 * Nunca lança, pelo mesmo motivo de `processQueuedEventById` — e também para que
 * uma falha aqui não faça o caller finalizar duas vezes pelo caminho do catch.
 */
async function finalizeQueuedEvent(input: {
  eventId: string;
  claimId: string;
  attempts: number;
  /** `null` = exceção antes de haver resposta HTTP. */
  httpStatus: number | null;
  error: string | null;
  /**
   * `true` = a linha chegou ao processador já sem degrau e não foi processada.
   * Atravessa até o núcleo em vez de virar um veredito montado aqui: o
   * `index.ts` não é alcançado por compilador nem por vitest, e um segundo
   * produtor de `QueuedEventVerdict` seria a forma de os dois divergirem.
   */
  exhaustedBeforeProcessing?: boolean;
}): Promise<void> {
  const verdict = queuedEventVerdict({
    httpStatus: input.httpStatus,
    attempts: input.attempts,
    exhaustedBeforeProcessing: input.exhaustedBeforeProcessing,
  });

  try {
    const call = (errorText: string | null) =>
      supabase.rpc("finalize_whatsapp_inbound_event", {
        p_event_id: input.eventId,
        p_claim_id: input.claimId,
        p_status: verdict.status,
        p_outcome: verdict.outcome,
        p_error: errorText,
        p_retry_delay_seconds: verdict.retryDelaySeconds,
      });

    // `sanitizeQueueErrorText` já tira o que o Postgres recusa em `text`. A
    // segunda tentativa SEM o texto existe para o que ele não pode prever: uma
    // falha da finalização dependente do PAYLOAD do erro deixaria a linha sem
    // `next_attempt_at` novo, devida e reivindicável a cada 90 s, e primeira na
    // ordem da varredura — adiando o inbound dos outros tenants.
    //
    // UMA VERSÃO ANTERIOR DESTE COMENTÁRIO PROMETIA MAIS: dizia que "é a
    // finalização que escreve `attempts`" e que sem esta retentativa a linha
    // "jamais viraria dead letter". As duas afirmações são falsas desde que o
    // CLAIM passou a gastar uma tentativa no takeover de lease vencido — com
    // isso a linha avança sozinha, chega ao teto e é promovida a `dead` pelo
    // `shouldPromoteToDead` logo após o claim, sem ser processada. Então esta
    // retentativa NÃO é o que salva a linha do limbo; ela economiza tentativas e
    // três esperas de lease, o que é bem menos, e é a razão honesta de mantê-la.
    //
    // Perder o texto NOVO do erro é barato; perder a contabilidade não é.
    // "Novo" é exato e depende da 113: lá o `last_error` é
    // `coalesce(left(p_error, 500), e.last_error)`, então esta segunda chamada
    // com `null` não apaga o erro que uma tentativa anterior registrou. Antes
    // desse `coalesce` ela apagava.
    // Compara o texto JÁ SANITIZADO, não o cru: se o sanitizador devolveu
    // `null`, a primeira chamada já foi sem texto e repeti-la emitiria uma
    // segunda chamada byte-idêntica — retentar o mesmo não é retentar.
    const errorText = sanitizeQueueErrorText(input.error);
    let { data, error } = await call(errorText);
    let retentou = false;

    if (error && errorText !== null) {
      jsonLog("warn", {
        evt: "queued_event_finalize_retry_without_error_text",
        eventId: input.eventId,
        err: error.message,
      });
      retentou = true;
      ({ data, error } = await call(null));
    }

    if (error) {
      // Aqui a falha não depende do payload: banco indisponível, timeout de
      // statement, conexão caindo no meio. A linha fica `processing` com lease
      // vivo e o takeover de 90 s a retoma quando o banco voltar, que é o
      // comportamento certo para uma indisponibilidade. O que impede resposta
      // dupla nesse caso não é esta função — é o claim de
      // `processed_messages (provider, message_id)`, que recusa a parte já
      // concluída como duplicata.
      //
      // NÃO é `PGRST202` (função ausente por deploy antes do `db push`): o
      // claim e a finalização nascem na MESMA migration, então sem uma não há a
      // outra — nada teria sido reivindicado e nada chegaria aqui.
      jsonLog("error", {
        evt: "queued_event_finalize_failed",
        eventId: input.eventId,
        err: error.message,
      });
      return;
    }

    // `UPDATE` que casa zero linhas devolve `error: null` no supabase-js
    // (invariante do CLAUDE.md). Sem conferir, "a cerca negou" ficaria
    // indistinguível de "gravei" — e a promoção a dead letter sairia sobre uma
    // linha que pertence a outro processo.
    if (Number(data ?? 0) < 1) {
      // `retried: true` muda o que esta linha SIGNIFICA, e por isso viaja junto.
      // Sem retentativa, zero linhas é a cerca negando: outro processo tem a
      // linha. DEPOIS de uma retentativa, zero linhas tem uma segunda leitura,
      // oposta e mais provável — a PRIMEIRA chamada gravou e só a resposta se
      // perdeu, e como a finalização zera `claim_id`, a segunda não acha mais o
      // crachá. Ler as duas como "a cerca negou" mandaria investigar uma corrida
      // que não houve.
      jsonLog("warn", {
        evt: "queued_event_finalize_fenced",
        eventId: input.eventId,
        status: verdict.status,
        retried: retentou,
      });
      return;
    }

    jsonLog("info", {
      evt: "queued_event_finalized",
      eventId: input.eventId,
      status: verdict.status,
      outcome: verdict.outcome,
      attempts: input.attempts,
      httpStatus: input.httpStatus,
    });

    // Só depois de a escrita ter pegado: promover sobre linha fencida anunciaria
    // dead letter de trabalho alheio.
    if (verdict.promoteToHandoff) await promoteDeadLetterToHandoff(input.eventId);
  } catch (err) {
    jsonLog("error", {
      evt: "queued_event_finalize_failed",
      eventId: input.eventId,
      err: sanitizeProviderError(err),
    });
  }
}

/**
 * Processa uma linha da fila re-entrando no PRÓPRIO pipeline.
 *
 * O mecanismo não é novo: o split de lote Meta já sintetiza `Request` e re-entra
 * em produção em todo POST multiparte. O que é novo é `source`, e é ele que
 * impede a re-entrada de persistir o evento de novo — laço infinito, o defeito
 * mais perigoso disponível neste desenho. A decisão mora em
 * `decideIngestionMode`, com controle positivo; nada aqui reimplementa a
 * pergunta.
 *
 * O PRIMEIRO ATO É REIVINDICAR A LINHA, cercado por UUID. Dois caminhos podem
 * alcançá-la — o rápido (`waitUntil`, disparado pela própria request que a
 * persistiu) e a varredura (`pg_cron`) — e duas execuções da mesma linha são
 * duas IAs respondendo ao mesmo cliente. A exposição que sobra é UMA ida ao
 * banco, não uma janela: quem perde a corrida recebe zero linhas e sai.
 *
 * NUNCA LANÇA: é chamada por `EdgeRuntime.waitUntil` (ninguém está esperando, e
 * rejeição não tratada em Deno pode derrubar o isolate) e pela varredura, que
 * precisa seguir para a próxima linha.
 */
async function processQueuedEventById(eventId: string): Promise<void> {
  let claimId: string | null = null;
  let attempts = 0;

  try {
    const { data, error } = await supabase.rpc("claim_whatsapp_inbound_event", {
      p_event_id: eventId,
    });

    if (error) {
      // NÃO finaliza: sem claim não há cerca a apresentar, e escrever sem ela
      // sobrescreveria o veredito de quem tem a linha. A varredura tenta depois.
      //
      // `attempts` não avança aqui, e está certo: nada foi tentado. A linha
      // continua `received`, com a escada intacta — gastar degrau por uma falha
      // de leitura encurtaria as retentativas de um trabalho que nunca começou.
      jsonLog("error", { evt: "queued_event_claim_failed", eventId, err: error.message });
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as ClaimedInboundEvent | null | undefined;
    if (!row?.claim_id) {
      // Zero linhas, e nenhuma das causas é erro: outro processo tem o lease
      // vivo, a linha já terminou (`done`/`dead`), ou ela deixou de existir
      // porque o canal foi apagado e a FK é `on delete cascade` — trabalho que
      // deixou de existir, não falha (Review Focus #4). Insistir criaria lease
      // preso.
      jsonLog("info", { evt: "queued_event_not_claimable", eventId });
      return;
    }

    claimId = row.claim_id;
    attempts = Number(row.attempts ?? 0);
    jsonLog("info", {
      evt: "queued_event_claimed",
      eventId,
      provider: row.provider,
      attempts,
    });

    // ─── A LINHA ENVENENADA POR DURAÇÃO MORRE AQUI ───────────────────────────
    //
    // `attempts` chega JÁ INCREMENTADO quando este claim foi um takeover de
    // lease vencido — e um takeover é a prova de que uma tentativa começou e
    // morreu sem chegar a veredito nenhum (worker retirado no meio: wall clock
    // do WORKER, isolate derrubado, `waitUntil` cortado). Sem esta pergunta, a
    // única promoção a `dead` era a do caminho de FINALIZAÇÃO — que, por
    // construção, essa linha nunca alcança. Ela era servida para sempre, nunca
    // virava dead letter, e o `raw_body` (telefone e texto de cliente, PII)
    // ficava retido indefinidamente, porque a purga só alcança `done`/`dead`.
    //
    // Processar mesmo assim gastaria um turno de IA para chegar ao MESMO
    // `dead`. A pergunta é do núcleo (`shouldPromoteToDead`), a mesma que
    // `queuedEventVerdict` faz do outro lado — divergir as duas produziria uma
    // linha que o processador recusa e o veredito manda retentar.
    //
    // A finalização incrementa `attempts` mais uma vez (o SQL soma em `dead`
    // como soma em `received`), e isso é inofensivo: a linha é terminal e o
    // número só é lido por quem estiver investigando. Isentá-la exigiria um
    // ramo a mais no SQL para não mudar decisão nenhuma.
    if (shouldPromoteToDead(attempts)) {
      jsonLog("warn", { evt: "queued_event_exhausted_without_verdict", eventId, attempts });
      await finalizeQueuedEvent({
        eventId,
        claimId,
        attempts,
        httpStatus: null,
        error: null,
        exhaustedBeforeProcessing: true,
      });
      return;
    }

    // Estoura em hex ímpar ou não-hex, de propósito: corpo corrompido não pode
    // virar payload silenciosamente diferente do que o provider assinou. O
    // `catch` abaixo transforma a exceção em retentativa da linha — erro claro
    // na fila, em vez de um 401 inexplicável na revalidação do HMAC.
    const bodyText = decodeRawBodyHex(String(row.raw_body));

    // O canal vai na QUERYSTRING, nunca no corpo: é isso que faz a guarda
    // anti-cross-tenant do handler valer alguma coisa. O host é irrelevante (o
    // handler só lê `searchParams` de `req.url`), e o fallback existe para que
    // env ausente vire erro de configuração e não uma linha em dead letter.
    const origin = Deno.env.get("SUPABASE_URL") ?? "http://localhost";
    const res = await handleWebhookRequest(
      new Request(`${origin}/functions/v1/webhook-whatsapp?channel=${row.channel_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      }),
      { signatureAlreadyVerified: true, source: "queue", queuedEventId: eventId },
    );

    await finalizeQueuedEvent({
      eventId,
      claimId,
      attempts,
      httpStatus: res.status,
      error: res.ok ? null : `http_${res.status}`,
    });
  } catch (err) {
    // SANITIZADO: o que vai para `last_error` fica persistido, e uma URL de
    // provider com credencial no path não pode acabar numa linha de tabela.
    const detail = sanitizeProviderError(err);
    jsonLog("error", { evt: "queued_event_failed", eventId, err: detail });
    if (!claimId) return;
    await finalizeQueuedEvent({
      eventId,
      claimId,
      attempts,
      httpStatus: null,
      error: detail,
    });
  }
}

/**
 * Apaga o que já passou da retenção. Separada e chamada em TODOS os caminhos de
 * saída da varredura, inclusive quando a seleção falha: `raw_body` é PII, e a
 * retenção não pode depender de a seleção estar funcionando. Uma seleção quebrada
 * de forma persistente reteria telefone e texto de cliente indefinidamente por
 * um motivo que não tem relação nenhuma com retenção.
 */
async function purgeInboundEvents(requestId: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("purge_whatsapp_inbound_events");
  if (error) {
    jsonLog("error", { requestId, evt: "sweep_purge_failed", err: error.message });
    return null;
  }
  return Number(data ?? 0);
}

/**
 * A varredura: o backstop do caminho rápido.
 *
 * O caminho rápido (`EdgeRuntime.waitUntil`, disparado pela própria request que
 * persistiu a linha) é OTIMISTA — o wall clock é do WORKER e ele pode ser
 * retirado a qualquer momento. Esta função é o que garante que a entrega seja
 * processada de qualquer jeito, com ~1 min de atraso em vez de nunca.
 *
 * ELA NÃO REIVINDICA EM LOTE. `select_due_whatsapp_inbound_events` só ESCOLHE
 * ids; quem reivindica é `claim_whatsapp_inbound_event`, por linha, dentro de
 * `processQueuedEventById`. O porquê está no comentário da migration 113 — em
 * resumo: reivindicar 20 e processar duas deixaria 18 leases órfãos por minuto,
 * e o claim por linha recusaria exatamente as linhas que o lote reivindicou.
 *
 * ELA TAMBÉM NÃO FINALIZA. `processQueuedEventById` já chama
 * `finalizeQueuedEvent` cercado pelo `claim_id`; finalizar por fora escreveria
 * por cima do veredito de quem de fato respondeu ao cliente.
 *
 * O ORÇAMENTO DE LAÇO decide se vale COMEÇAR outro evento, nunca aborta o em
 * curso — a decisão é de `sweepShouldStartAnother`, no núcleo puro, e nada aqui
 * a reimplementa. Linha não começada não foi reivindicada: ela fica para o minuto
 * seguinte, sem lease preso e sem tentativa gasta.
 *
 * `pg_cron` NÃO PULA EXECUÇÕES SOBREPOSTAS: duas varreduras podem estar no ar ao
 * mesmo tempo, e as duas podem selecionar o mesmo id. O que torna isso seguro é
 * o claim por linha — a perdedora recebe zero linhas e segue adiante.
 */
async function runInboundSweep(requestId: string): Promise<Response> {
  const startedAt = Date.now();

  const { data, error } = await supabase.rpc("select_due_whatsapp_inbound_events", {
    p_limit: SWEEP_SELECT_LIMIT,
  });

  if (error) {
    await purgeInboundEvents(requestId);
    // 500 de propósito: quem chama é o `pg_cron`, que não reentrega — e o
    // `net._http_response` guarda o status. Devolver 200 aqui faria uma fila
    // parada parecer uma fila vazia.
    jsonLog("error", { requestId, evt: "sweep_select_failed", err: error.message });
    return new Response(JSON.stringify({ error: "sweep_select_failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const { ids, descartados } = parseSelectedEventIds(data);

  // CANÁRIO. Uma forma de retorno que ninguém previu não produz erro: o
  // PostgREST devolve 200, isto devolveria `{"processed":0}` e o
  // `net._http_response` ficaria verde enquanto a fila cresce — 1440 vezes por
  // dia, parecendo "não havia nada a fazer". `descartados > 0` é o único sinal
  // que existe, e ele só aparece se alguém o emitir.
  if (descartados > 0) {
    jsonLog("error", {
      requestId,
      evt: "sweep_select_shape_unexpected",
      descartados,
      reconhecidos: ids.length,
      // FORMA, nunca valor — e por `shapeOf`, não por descritor próprio.
      // Reimplementar aqui poria a regra fora do alcance do vitest (esta EF não
      // é importável: `serve()` no carregamento e imports de `deno.land`), e a
      // garantia contra vazamento é justamente a FOLHA devolver `typeof value`.
      // A "melhoria" de quem está depurando — trocar por `String(value)` —
      // publicaria id de tenant sem erro de tipo nem aviso de lint; o controle
      // positivo que reprova isso vive no teste do núcleo, e só alcança quem
      // usa o núcleo.
      forma: shapeOf(Array.isArray(data) ? data[0] : data),
      itens: Array.isArray(data) ? data.length : null,
    });
  }

  let processed = 0;

  for (const eventId of ids) {
    if (!sweepShouldStartAnother({ startedAt, now: Date.now(), processed })) break;
    // Nunca lança (contrato da própria função) — um evento que falha não pode
    // interromper a varredura dos outros tenants.
    await processQueuedEventById(eventId);
    processed++;
  }

  // Purga na própria varredura: nenhum job novo. Roda DEPOIS do laço e fora
  // dele: é manutenção, e falhar aqui não pode esconder o que a varredura de
  // fato processou.
  const purged = await purgeInboundEvents(requestId);

  const skipped = ids.length - processed;
  jsonLog("info", {
    requestId,
    evt: "sweep_processed",
    selected: ids.length,
    processed,
    // `skipped > 0` é o orçamento tendo mordido: sobrou trabalho devido que esta
    // invocação decidiu não começar. É sinal de fila acumulando, não de erro.
    skipped,
    purged,
    duration_ms: Date.now() - startedAt,
  });

  return new Response(
    JSON.stringify({ selected: ids.length, processed, skipped, purged }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * `signatureAlreadyVerified` e `source` são DUAS perguntas, não uma.
 *
 * O antigo booleano `trustedMetaPayload` significava "sou parte filha de um lote
 * cujo pai já validou a assinatura". Reusá-lo para "vim da fila durável"
 * juntaria duas perguntas num sinal — o anti-padrão que este repo já nomeia em
 * `isMetaShapedProvider` (forma de payload e esquema de assinatura são duas
 * perguntas). `source` é o que decide persistir ou não; ele é o guardião contra
 * reinserção infinita, e a decisão mora em `decideIngestionMode`, com controle
 * positivo.
 *
 * O objeto é INTERNO: o `serve` público sempre entra com o default `{}`, então
 * nenhum chamador externo consegue afirmar "já validei" nem "vim da fila".
 */
interface HandlerOptions {
  signatureAlreadyVerified?: boolean;
  source?: IngestionSource;
  /** Preenchido quando `source !== "provider"`: a linha já existe na fila. */
  queuedEventId?: string;
}

async function handleWebhookRequest(
  req: Request,
  opts: HandlerOptions = {},
): Promise<Response> {
  const trustedMetaPayload = opts.signatureAlreadyVerified === true;
  const ingestionSource: IngestionSource = opts.source ?? "provider";
  const requestId = genRequestId();
  const t0 = Date.now();

  // Cache do gate de serviço de WhatsApp é por invocação — zera aqui, mesmo
  // padrão do unitCache dos workers e do clearWhatsAppGateCache() nas EFs de
  // envio (Task 14), senão um isolate quente serve estado de suspensão velho
  // depois de o cliente pagar.
  clearWhatsAppGateCache();

  // Estado mutável que vamos completar conforme avançamos no handler — usado
  // pelo finalizador (recordExecution) para registrar a execução de forma
  // consistente, mesmo em early returns.
  let unitId: string | null = null;
  let channelId: string | null = null;
  let phoneHash: string | null = null;
  let messageIdForOutcome: string | null = null;
  let messageProvider: WhatsAppProvider | null = null;
  let messageProcessingClaimId: string | null = null;
  let externalSideEffectStarted = false;
  let conversationHistoryDegraded = false;
  const appendToConversation = async (...args: Parameters<typeof appendToConversationResult>) => {
    const result = await appendToConversationResult(...args);
    if (!result.persisted) conversationHistoryDegraded = true;
    return result;
  };
  // Estado do lock de exclusão do agente por conversa. Hasteado aqui (e não só
  // dentro do try) pra que releaseAiLock seja visível no outer catch — que é
  // irmão do try e está fora do escopo de `conv`.
  let convIdForLock: string | null = null;
  let aiLockToken: string | null = null;
  let lockAcquired = false;

  // Reserva de orçamento do turno (Plano D). Hasteada aqui pelo MESMO motivo do
  // lock: o catch externo é irmão do try, e sem enxergar a reserva ele deixaria
  // o custo real do turno fora do teto para sempre.
  let turnBudget: TurnBudget | null = null;
  let turnBudgetOrgId: string | null = null;

  /**
   * REGRA ÚNICA: todo desfecho do turno liquida a reserva.
   *
   * Enquanto a reserva fica `HELD`, o consumido não é `settled_cents` — e só
   * `finalize_ai_reservation` incrementa esse campo. A varredura de expiradas
   * marca `EXPIRED` e devolve `released_cents` SEM incrementar o liquidado
   * (migration 102): deixar um desfecho sem liquidar não atrasa a contabilidade,
   * apaga-a. Custo real de LLM que some do teto é a classe de falha que esta
   * frente existe para impedir.
   *
   * `SETTLED` quando o turno chegou ao fim que pretendia (resposta produzida,
   * ou negação que encerrou o turno de propósito); `RELEASED` quando ele foi
   * interrompido. Os dois movem exatamente o mesmo dinheiro — a RPC só apropria
   * `consumed_cents`, escrito unicamente por `record_ai_call_usage` para
   * chamadas que OCORRERAM —, então a escolha é de rótulo para quem audita, não
   * de valor.
   *
   * No-op fora da franquia e quando não houve reserva.
   *
   * O ESTADO LOCAL SÓ É ZERADO NO SUCESSO. Zerar antes do `await` fazia de uma
   * RPC que falha um custo perdido para sempre: ninguém mais tentava, nem o
   * catch externo, porque o estado já tinha sido apagado — a reserva ficava
   * `HELD`, a varredura marcava `EXPIRED` e o consumido real sumia do teto.
   * Mantido o estado, o catch externo tem uma segunda tentativa (duas no total,
   * nunca um laço). Dupla liquidação continua impossível nos DOIS níveis: a
   * guarda local, e a própria RPC, que devolve sem redebitar quando o status já
   * não é `HELD` (migration 102).
   *
   * ISSO NÃO É COBERTURA COMPLETA, e não deve ser lido como tal: nos desfechos
   * que terminam sem exceção não existe segunda tentativa nenhuma — ou seja, no
   * modo de falha COMUM (a RPC falha e o resto do turno corre normal) a segunda
   * tentativa nunca acontece; ela só cobre "falhou a liquidação E depois algo
   * mais explodiu". Fechar de verdade exige uma varredura que LIQUIDE reserva
   * com `consumed_cents > 0` em vez de expirá-la — trabalho de outra fase.
   *
   * O `if (!fin)` também não distingue "a RPC errou" de `RESERVATION_NOT_FOUND`
   * / `CYCLE_NOT_FOUND`, então o log abaixo pode sair sobre uma reserva que
   * nunca existiu. É ruído no log, não erro de contabilidade.
   */
  const settleTurnBudget = async (status: "SETTLED" | "RELEASED") => {
    if (!turnBudget || !turnBudgetOrgId) return;
    const { reservationId, cycleId } = turnBudget;
    const orgId = turnBudgetOrgId;
    const fin = await finalizeTurn(supabase, { organizationId: orgId, reservationId, status });
    if (!fin) {
      // NÃO zera: a RPC não aplicou (erro, ou reserva/ciclo não encontrados) e o
      // consumido ainda não virou `settled_cents`.
      jsonLog("error", {
        requestId,
        evt: "ai_budget_settle_not_applied",
        reservation: reservationId,
        status,
      });
      return;
    }
    turnBudget = null;
    turnBudgetOrgId = null;
    try {
      // Best-effort por contrato: o custo já está liquidado, e um aviso de
      // marco que falha não pode derrubar a resposta ao cliente.
      await recordMilestones(supabase, {
        organizationId: orgId,
        cycleId,
        settledCents: fin.settledCents,
        limitCents: fin.limitCents,
      });
    } catch (e) {
      jsonLog("error", { requestId, evt: "ai_budget_milestones_failed", err: String(e) });
    }
  };

  // Helper local que finaliza a execução (grava processed_messages.outcome
  // se já houver message_id, e registra webhook_executions). Nunca lança.
  const finish = async (outcome: string, error?: string | null, meta?: Record<string, unknown>) => {
    const recordedOutcome = conversationHistoryDegraded && !outcome.includes("history_degraded")
      ? `${outcome}_history_degraded`
      : outcome;
    const duration_ms = Date.now() - t0;
    if (messageIdForOutcome && messageProvider && messageProcessingClaimId) {
      await markProcessed(
        messageProvider,
        messageIdForOutcome,
        messageProcessingClaimId,
        recordedOutcome,
        error,
      );
    }
    await recordExecution({
      request_id: requestId,
      unit_id: unitId,
      channel_id: channelId,
      phone_hash: phoneHash,
      outcome: recordedOutcome,
      error: error ?? null,
      duration_ms,
      // `queued_event_id` é o ÚNICO vínculo entre a linha da fila e as execuções
      // que ela produziu — sem ele, investigar um dead letter obriga a cruzar
      // `webhook_executions` por janela de tempo. Só aparece na re-entrada: na
      // porta do provider o campo é `undefined` e `meta` segue idêntico ao de
      // hoje, inclusive quando é `undefined` (recordExecution grava `{}`).
      meta: opts.queuedEventId
        ? { ...(meta ?? {}), queued_event_id: opts.queuedEventId }
        : meta,
    });
  };

  // Libera o lock de exclusão do agente. No-op se esta invocação não o detém.
  // Nunca propaga — o TTL de 90s é o backstop se a RPC falhar.
  const releaseAiLock = async () => {
    if (!lockAcquired || !convIdForLock || !aiLockToken) return;
    try {
      await supabase.rpc("release_conversation_ai_claim", {
        p_conv: convIdForLock,
        p_token: aiLockToken,
      });
    } catch (e) {
      jsonLog("warn", { requestId, evt: "ai_lock_release_failed", convId: convIdForLock, err: String(e) });
    }
  };

  try {
    const url = new URL(req.url);
    channelId = url.searchParams.get("channel");

    // A varredura não tem canal — ela resolve o canal de CADA linha. Por isso
    // este branch precisa vir ANTES da exigência de `?channel=`.
    //
    // SEGURANÇA: ele NÃO ACEITA PAYLOAD NENHUM. Lê exclusivamente da tabela, e
    // cada linha de lá já foi persistida depois de a assinatura do provider ter
    // sido validada. Se a chave interna vazar, o poder conferido é "fazer uma
    // varredura rodar mais cedo" sobre eventos já validados — não injetar
    // inbound, não escolher canal, não escrever nada que venha de fora.
    //
    // Sem `finish()` nos dois caminhos, de propósito: cada evento processado já
    // grava a PRÓPRIA linha em `webhook_executions` na re-entrada, e uma linha
    // por minuto da varredura em si inflaria a tabela (TTL 30 d) com registros
    // sem unidade nem canal. O rastro do 401 é o log estruturado mais o status
    // em `net._http_response`, que é onde se confere `pg_net` de todo modo.
    if (url.searchParams.get("sweep") === "1") {
      if (!requireInternalAuth(req)) {
        jsonLog("warn", { requestId, evt: "sweep_unauthorized" });
        return new Response("unauthorized", { status: 401 });
      }
      return await runInboundSweep(requestId);
    }

    if (!channelId) {
      jsonLog("warn", { requestId, evt: "missing_channel_param" });
      await finish("missing_channel_param");
      return new Response("missing channel", { status: 400 });
    }

    // Resolve channel → unit_id, provider, credentials, webhook_secret
    //
    // `async_ingestion_enabled` é a perna POR CANAL do gate da Fase C, e entra
    // nesta lista porque a coluna é lida logo adiante: pedir a coluna e ler a
    // coluna são o mesmo passo. Sem ela na projeção o valor chega `undefined`,
    // `channelEnabled !== true` é sempre verdadeiro, o modo é sempre `sync` e a
    // fase inteira embarca morta com a suíte verde.
    //
    // Consequência de ordem de deploy (já invariante no CLAUDE.md): a migration
    // 111 precisa estar APLICADA antes do deploy desta função. Coluna ainda
    // inexistente é 400 do PostgREST aqui, e este SELECT falhando devolve 404
    // para TODO inbound de TODO canal.
    const { data: channel, error: channelErr } = await supabase
      .from("whatsapp_channels")
      .select("id, unit_id, provider, credentials, webhook_secret, status, is_active, instance_token_secret_id, external_instance_id, template_credential_revision, activation_requested_at, manual_echo_verified_at, async_ingestion_enabled")
      .eq("id", channelId)
      .maybeSingle();

    if (channelErr || !channel) {
      jsonLog("warn", { requestId, evt: "channel_not_found", channelId });
      await finish("channel_not_found", channelErr?.message);
      return new Response("channel not found", { status: 404 });
    }

    unitId = channel.unit_id as string;
    const provider: WhatsAppProvider = channel.provider;
    messageProvider = provider;
    let credentials: ChannelCredentials = channel.credentials ?? {};

    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
      jsonLog("warn", { requestId, evt: "webhook_payload_too_large", channelId, declaredLength });
      await finish("payload_too_large");
      return new Response("payload too large", { status: 413 });
    }

    // Lê o body como texto antes do parse — para Meta a validação HMAC precisa
    // do body cru (JSON.stringify de volta não preserva whitespace/ordering e
    // quebra a assinatura).
    const bodyText = await req.text();
    if (new TextEncoder().encode(bodyText).byteLength > MAX_WEBHOOK_BODY_BYTES) {
      jsonLog("warn", { requestId, evt: "webhook_payload_too_large", channelId });
      await finish("payload_too_large");
      return new Response("payload too large", { status: 413 });
    }

    // Validate por provider, ramificado pelo esquema declarado em
    // WEBHOOK_SIGNATURE_SCHEME — nunca por uma comparação crua com o nome de
    // um provider específico, que é indistinguível à leitura de uma checagem
    // de FORMA de payload:
    //  - Meta Cloud API: HMAC-SHA256 do body com app_secret (header x-hub-signature-256)
    //  - Datafy: HMAC-SHA256 de `{timestamp}.{corpo}` com o whsec_ do canal (header x-datafy-signature-256)
    //  - Z-API / WAHA / UazAPI: secret per-channel (header x-webhook-secret OU query ?secret=)
    let isValid = false;
    switch (WEBHOOK_SIGNATURE_SCHEME[provider]) {
      case "meta_app_secret":
        isValid = trustedMetaPayload
          || await validateMetaSignature(req, bodyText, credentials.app_secret ?? "");
        break;
      case "datafy_whsec":
        // O whsec_ da Datafy mora em webhook_secret; o sk_live_ fica em
        // credentials.access_token. Segredo ausente falha fechado no núcleo.
        isValid = trustedMetaPayload
          || await verifyDatafySignature(req, bodyText, channel.webhook_secret ?? "", Date.now());
        break;
      case "channel_secret": {
        // `trustedMetaPayload` aqui pela MESMA razão dos dois ramos acima — o
        // sinal significa "a assinatura desta entrega já foi validada", e o nome
        // herdado do lote Meta não restringe o esquema a que ele se aplica.
        //
        // Sem esta linha, a re-entrada a partir da fila (Fase C) morre: o
        // `Request` sintetizado carrega só `content-type`, sem
        // `x-webhook-secret` e sem `?secret=`. Todo evento enfileirado de canal
        // Z-API/WAHA/UazAPI daria 401, esgotaria as três tentativas e morreria
        // no dead letter — calando a loja em produção.
        //
        // O bypass é seguro porque o sinal só é ligado DENTRO do processo:
        // `HandlerOptions` é objeto interno, o `serve` público sempre entra com
        // `{}`, e as duas origens que o ligam já validaram a assinatura (o pai
        // do lote, sobre o corpo cru; a linha da fila, antes do insert).
        const secret = channel.webhook_secret ?? Deno.env.get("ZAPI_WEBHOOK_SECRET") ?? "";
        isValid = trustedMetaPayload || validateChannelSecret(req, secret);
        break;
      }
    }

    if (!isValid) {
      jsonLog("warn", { requestId, evt: "webhook_unauthorized", channelId, provider });
      await finish("webhook_unauthorized", undefined, { reason: "signature_invalid" });
      return new Response("unauthorized", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch (e) {
      jsonLog("warn", { requestId, evt: "webhook_invalid_json", channelId, err: String(e) });
      await finish("invalid_json", String(e));
      return new Response("invalid json", { status: 400 });
    }

    if (!declaredProviderIdentityMatchesChannel(provider, payload, credentials)) {
      jsonLog("warn", { requestId, evt: "webhook_channel_identity_mismatch", channelId, provider });
      await finish("webhook_unauthorized", undefined, { reason: "declared_identity_mismatch" });
      return new Response("unauthorized", { status: 401 });
    }

    // O token UazAPI nunca mora no JSONB. Ele é resolvido do Vault somente
    // depois da autenticação por secret do webhook. Quando o provider inclui
    // `token` no payload, ele precisa coincidir; ausência continua permitida
    // porque esse campo não é garantido em todos os tipos de evento oficiais.
    if (provider === "uazapi") {
      try {
        credentials = await resolveChannelCredentials(supabase, {
          id: channel.id,
          provider,
          credentials,
          instance_token_secret_id: channel.instance_token_secret_id,
        });
      } catch (error) {
        jsonLog("error", { requestId, evt: "uazapi_token_unavailable", channelId, err: String(error) });
        await finish("provider_credentials_unavailable");
        return new Response("provider unavailable", { status: 503 });
      }

      const payloadToken = payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).token
        : null;
      if (
        typeof payloadToken === "string"
        && !validateProviderToken(payloadToken, credentials.instance_token ?? "")
      ) {
        jsonLog("warn", { requestId, evt: "webhook_provider_token_mismatch", channelId, provider });
        await finish("webhook_unauthorized", undefined, { reason: "provider_token_mismatch" });
        return new Response("unauthorized", { status: 401 });
      }

      const payloadRecord = payload && typeof payload === "object"
        ? payload as Record<string, unknown>
        : {};
      const payloadInstance = payloadRecord.instance && typeof payloadRecord.instance === "object"
        ? payloadRecord.instance as Record<string, unknown>
        : {};
      const payloadInstanceId = [
        payloadRecord.instanceId,
        payloadRecord.instance_id,
        payloadInstance.id,
      ].find((value) => typeof value === "string" && value.length > 0);
      if (
        typeof payloadInstanceId === "string"
        && channel.external_instance_id
        && payloadInstanceId !== channel.external_instance_id
      ) {
        jsonLog("warn", { requestId, evt: "webhook_instance_mismatch", channelId, provider });
        await finish("webhook_unauthorized", undefined, { reason: "instance_mismatch" });
        return new Response("unauthorized", { status: 401 });
      }
    }

    // O HMAC (Meta ou Datafy) só comprova qual app/canal enviou o lote. Sem
    // conferir o phone_number_id, um callback válido de outro número do mesmo
    // app/cliente poderia ser encaminhado ao channel_id errado e atravessar
    // tenants. Vale para todo provider Meta-shaped, não só "official".
    // Only management-bearing envelopes load the backend WABA binding/catalog.
    // Message/status/echo-only deliveries preserve their existing identity path.
    const preparedTemplates = isMetaShapedProvider(provider)
      ? await createTemplateEventRuntime(supabase).prepare(payload, {
        id: channel.id, unit_id: channel.unit_id, provider,
        phoneNumberId: credentials.phone_number_id ?? "",
      }, new Date().toISOString())
      : { kind: "chat" as const };
    if (preparedTemplates.kind === "refused") {
      if (preparedTemplates.status === 401) {
        await finish("webhook_unauthorized", undefined, { reason: "template_batch_invalid" });
        return new Response("unauthorized", { status: 401 });
      }
      await finish("template_dependency_unavailable");
      return new Response("template unavailable", { status: 503 });
    }
    if (preparedTemplates.kind !== "prepared" && isMetaShapedProvider(provider) && !metaPayloadMatchesChannel(payload, credentials)) {
      jsonLog("warn", { requestId, evt: "webhook_channel_identity_mismatch", channelId, provider });
      await finish("webhook_unauthorized", undefined, { reason: "meta_identity_mismatch" });
      return new Response("unauthorized", { status: 401 });
    }

    // Whole original envelope admission precedes ACK/split and any WABA write.
    // Trusted queue/split children consume evidence already admitted by their parent.
    if (ingestionSource === "provider" && !trustedMetaPayload) {
      const originalStatuses = parseStatusCallback(provider, payload);
      if (originalStatuses?.length) {
        const receiptAdmission = await admitAutomationReceipts(supabase, channel, payload, originalStatuses, channel.webhook_secret);
        if (receiptAdmission.kind === "refused") {
          await finish(receiptAdmission.reason);
          return new Response(receiptAdmission.reason, { status: receiptAdmission.status });
        }
      }
    }
    // Receipt admission and WABA are separate transactions: an error here keeps
    // admitted receipt evidence pending, and provider redelivery dedupes it.
    const templateEvents = preparedTemplates.kind === "prepared" ? await preparedTemplates.commit() : preparedTemplates;
    if (templateEvents.kind === "refused") {
      await finish("template_dependency_unavailable");
      return new Response("template unavailable", { status: 503 });
    }
    const managementPersisted = templateEvents.kind === "persisted";

    if (templateEvents.kind === "persisted" && !templateEvents.hasChat) {
      await finish("template_events_persisted", undefined, { count: templateEvents.count });
      return new Response("ok");
    }

    // Instrumentação de FORMA, nunca de valor — mesma disciplina de
    // `webhook-payload-shape-core.ts`. Publicar o id de entrega ou o header de
    // assinatura vazaria correlação e credencial no log.
    //
    // Fica FORA do gate, e ANTES dele, de propósito: ela responde metade da
    // pendência de validação real nº 6 da spec ("o header
    // `x-datafy-delivery-id` existe?"), e medir o envelope só depois de ligar o
    // gate (flag e coluna do canal) seria ovo e galinha — instrumentar forma
    // serve para medir ANTES de assumir o risco. A outra metade ("se repete
    // na reentrega?") NÃO é respondida aqui: quem responde é o outcome
    // `queue_duplicate_delivery`, que só existe com o gate ligado.
    //
    // ESCOPADA NA PORTA DO PROVIDER. Sem `ingestionSource === "provider"`, a
    // MESMA entrega emite esta linha duas vezes — uma na porta, outra na
    // re-entrada a partir da fila —, e contar a mesma entrega duas vezes é
    // exatamente a medida errada que uma instrumentação de forma deveria evitar.
    //
    // O QUE O ESCOPO NÃO IMPEDE, e quem lê o log precisa saber: lote Meta-shaped
    // MULTIPARTE emite 1 + N linhas. O split adiante re-entra em
    // `handleWebhookRequest` por parte, PROPAGANDO `source`, e não remove o
    // `x-datafy-delivery-id` dos filhos (remover faria o filho declarar "header
    // ausente" — falso negativo na única pergunta que esta linha responde). Só
    // acontece com o gate OFF: com ele ON o pai responde no ACK antes do split,
    // e a re-entrada da fila propaga `"queue"`. Ou seja, distorce a contagem
    // justo no modo em que esta instrumentação serve — ao responder a pendência
    // nº 6 da spec, conte ENTREGAS DISTINTAS por `delivery_id_shape`, nunca
    // linhas.
    if (ingestionSource === "provider" && providerDeclaresDeliveryId(provider)) {
      jsonLog("info", {
        requestId,
        evt: "inbound_delivery_shape",
        provider,
        has_delivery_id: deliveryDedupeKey(provider, (name) => req.headers.get(name)) !== null,
        delivery_id_type: typeof req.headers.get(DATAFY_DELIVERY_ID_HEADER),
      });
    }

    // ─── Fronteira do ACK (Fase C) ───────────────────────────────────────────
    //
    // Fica AQUI, e é ÚNICA: depois de todas as guardas que produzem não-200
    // (assinatura, identidade declarada, token/instância UazAPI, identidade
    // Meta) e antes de QUALQUER trabalho. Tudo a jusante é diferido em bloco
    // quando o gate está ON: split de lote, callback de status, callback de
    // conexão, descarte de canal inativo, eco de aparelho e inbound.
    //
    // Não se recorta "o que é caro" para diferir só isso: o split do lote
    // produz partes RE-SERIALIZADAS (`JSON.stringify(part)`), e guardar isso
    // destruiria a capacidade de revalidar a assinatura. O corpo é guardado uma
    // vez, intacto, e quem divide é o processador, em memória.
    //
    // `providerRedelivery` vem do registry pelo provider do PRÓPRIO canal: só
    // provider com reentrega documentada entra na fila, porque o 503 de uma
    // gravação falha só é seguro para quem reentrega. O `?.` é inalcançável
    // hoje — o CHECK `whatsapp_channels_provider_check` (migration 110) só
    // admite providers do registry, e o `switch` da assinatura, sem `default`,
    // já devolveu 401 a qualquer outro — e fica só como defesa: `undefined`
    // vira `sync` no núcleo.
    const flagCheck = await checkFlagEnabled("whatsapp_async_ingestion");
    const ingestionMode = decideIngestionMode({
      source: ingestionSource,
      flagEnabled: flagCheck.enabled,
      flagReadFailed: flagCheck.readFailed,
      channelEnabled: channel.async_ingestion_enabled,
      providerRedelivery: PROVIDER_CAPABILITIES[provider]?.inboundRedelivery,
    });

    if (ingestionMode !== "sync") {
      let insert: { outcome: InsertOutcome; id: string | null } = { outcome: "skipped", id: null };

      if (ingestionMode === "async") {
        const scheme = WEBHOOK_SIGNATURE_SCHEME[provider];
        insert = await persistInboundEvent({
          provider,
          channelId: channelId!,
          unitId: unitId!,
          bodyText,
          deliveryId: deliveryDedupeKey(provider, (name) => req.headers.get(name)),
          signatureHeader: req.headers.get(SIGNATURE_HEADER_BY_SCHEME[scheme]),
          signatureScheme: scheme,
        });
      }

      const verdict = decideAckVerdict({ mode: ingestionMode, insert: insert.outcome });
      if (verdict.kind !== "passthrough") {
        await finish(verdict.outcome);
        if (verdict.kind === "ack" && insert.id) {
          // Caminho rápido OTIMISTA: o wall clock é do WORKER, não da request, e
          // ele pode ser retirado a qualquer momento. A varredura é o backstop, e
          // a degradação é benigna — o cliente espera ~70 s em vez de nunca.
          //
          // DOIS modos de falha DISTINTOS, e por isso dois tratamentos com
          // eventos próprios:
          //  - o `try/catch` pega `EdgeRuntime` ausente ou `waitUntil` lançando
          //    de forma síncrona (`queue_dispatch_failed`);
          //  - o `.catch()` pega exceção DENTRO do processamento, que num
          //    `async` vira promise rejeitada e nunca passaria pelo `try`
          //    (`queue_background_unhandled`). Ele NÃO é decoração: rejeição
          //    não tratada em Deno pode derrubar o isolate, e o que roda ali é
          //    o processamento inteiro — resolução de canal, agente, envio.
          //
          // Nenhum dos dois pode derrubar o ACK: a linha já está durável, e
          // devolver 500 aqui faria o provider reentregar sobre um evento
          // persistido — providers legados não têm `delivery_id` para deduplicar
          // a segunda linha.
          try {
            EdgeRuntime.waitUntil(
              processQueuedEventById(insert.id).catch((bgErr) => {
                jsonLog("error", {
                  requestId,
                  evt: "queue_background_unhandled",
                  err: sanitizeProviderError(bgErr),
                });
              }),
            );
          } catch (dispatchErr) {
            jsonLog("error", {
              requestId,
              evt: "queue_dispatch_failed",
              err: sanitizeProviderError(dispatchErr),
            });
          }
        }
        return new Response(verdict.kind === "ack" ? "ok" : "queue unavailable", {
          status: verdict.status,
        });
      }
    }

    // Meta (e a Datafy, que encaminha o mesmo envelope) pode agrupar
    // entries/changes e várias mensagens no mesmo POST. Cada inbound precisa
    // atravessar claim/debounce/lock separadamente; status e ecos também não
    // podem fazer o handler retornar antes dos demais itens.
    if (isMetaShapedProvider(provider)) {
      const parts = splitMetaWebhookPayload(payload);
      if (parts.length > 1 || managementPersisted) {
        const results = await Promise.all(parts.map((part) => {
          const headers = new Headers(req.headers);
          headers.delete("content-length");
          headers.delete("x-hub-signature-256");
          headers.delete("x-datafy-signature-256");
          // `source: ingestionSource` PROPAGA a origem: um lote que chegou pela
          // fila tem de manter `"queue"` nos filhos, senão cada parte reinsere
          // o próprio corpo e o laço é infinito.
          return handleWebhookRequest(new Request(req.url, {
            method: "POST",
            headers,
            body: JSON.stringify(part),
          }), { signatureAlreadyVerified: true, source: ingestionSource });
        }));
        const failed = results.find((result) => !result.ok);
        if (failed) {
          await finish("meta_batch_partial_failure", `child_http_${failed.status}`);
          return new Response("error", { status: 500 });
        }
        await finish("meta_batch_processed", undefined, { count: parts.length });
        return new Response("ok");
      }
    }

    // Callback de STATUS (entregue/lido/falhou) das NOSSAS mensagens enviadas —
    // NÃO é mensagem do cliente. Atualiza notifications_sent por
    // provider_message_id e encerra: não roda agente, debounce nem lock de
    // conversa (status ≠ inbound). Antes caía em `ignored_non_text` e sumia.
    const statusUpdates = parseStatusCallback(provider, payload);
    if (statusUpdates) {
      await applyDeliveryStatus(statusUpdates, unitId, provider, channelId);
      await finish("status_callback", undefined, {
        statuses: statusUpdates.map((u) => u.status),
        ids: statusUpdates.map((u) => u.providerMessageId).slice(0, 5),
      });
      return new Response("ok");
    }

    const connectionUpdate = getWhatsAppProvider(provider).parseConnectionCallback?.(payload) ?? null;
    if (connectionUpdate) {
      const displayPhone = connectionUpdate.displayPhone?.replace(/\D/g, "") || null;
      const { error: recordError } = await supabase.rpc("record_whatsapp_channel_status", {
        p_unit_id: unitId,
        p_channel_id: channelId,
        p_status: connectionUpdate.status,
        p_display_phone: displayPhone,
        p_error_code: connectionUpdate.status === "provider_error" ? "PROVIDER_CALLBACK_ERROR" : null,
        p_actor_id: null,
        p_request_id: requestId,
      });
      if (recordError) throw new Error("connection_status_persist_failed");
      if (connectionUpdate.connected && channel.activation_requested_at && channel.manual_echo_verified_at) {
        const { error: activateError } = await supabase.rpc("activate_whatsapp_channel", {
          p_unit_id: unitId,
          p_channel_id: channelId,
          p_actor_id: null,
          p_request_id: requestId,
        });
        if (activateError) throw new Error("connection_callback_activation_failed");
      }
      await finish("connection_callback", undefined, {
        status: connectionUpdate.status,
        connected: connectionUpdate.connected,
      });
      return new Response("ok");
    }

    // Um callback manual válido comprova que a configuração do provider
    // entrega exatamente o evento necessário para manter a timeline e o
    // handoff. A prova pode chegar com o alvo ainda inativo.
    const ownMessageEchoes = parseOwnMessageEchoes(provider, payload);
    const hasManualEcho = ownMessageEchoes.some((echo) => echo.source === "manual_device");
    const manualEchoMatchesChannel = hasManualEcho && manualEchoMatchesConfiguredChannel(
      provider,
      payload,
      credentials,
    );
    if (hasManualEcho && !manualEchoMatchesChannel) {
      jsonLog("warn", { requestId, evt: "manual_echo_channel_identity_mismatch", channelId, provider });
      await finish("webhook_unauthorized", undefined, { reason: "manual_echo_identity_mismatch" });
      return new Response("unauthorized", { status: 401 });
    }
    let manualEchoActivated = false;
    if (manualEchoMatchesChannel) {
      if (!channel.manual_echo_verified_at) {
        let verificationQuery = supabase
          .from("whatsapp_channels")
          .update({
            manual_echo_verified_at: new Date().toISOString(),
            manual_echo_verification_source: "provider_callback",
          })
          .eq("id", channelId)
          .eq("unit_id", unitId)
          .eq("template_credential_revision", channel.template_credential_revision);
        verificationQuery = channel.external_instance_id == null
          ? verificationQuery.is("external_instance_id", null)
          : verificationQuery.eq("external_instance_id", channel.external_instance_id);
        const { data: verifiedChannel, error: verificationError } = await verificationQuery.select("id").maybeSingle();
        if (verificationError || !verifiedChannel) throw new Error("channel_parity_verification_persist_failed");
      }

      // Releitura também no replay: a prova pode ter sido gravada antes de
      // uma falha transitória na ativação. Status e intenção precisam ser atuais.
      let activationQuery = supabase
        .from("whatsapp_channels")
        .select("status, activation_requested_at, manual_echo_verified_at, template_credential_revision")
        .eq("id", channelId)
        .eq("unit_id", unitId)
        .eq("template_credential_revision", channel.template_credential_revision);
      activationQuery = channel.external_instance_id == null
        ? activationQuery.is("external_instance_id", null)
        : activationQuery.eq("external_instance_id", channel.external_instance_id);
      const { data: activationChannel, error: activationReadError } = await activationQuery.maybeSingle();
      if (activationReadError || !activationChannel) throw new Error("channel_parity_activation_read_failed");
      if (activationChannel.manual_echo_verified_at
        && activationChannel.activation_requested_at
        && activationChannel.status === "connected") {
        const { error: activateError } = await supabase.rpc("activate_whatsapp_channel", {
          p_unit_id: unitId,
          p_channel_id: channelId,
          p_actor_id: null,
          p_request_id: requestId,
        });
        if (activateError) throw new Error("manual_echo_activation_failed");
        manualEchoActivated = true;
      }
    }

    // Canal preparado/inativo pode receber callbacks de conexão, mas nunca
    // entra na pipeline de conversa/IA. Em rollout legado (nenhum true), linhas
    // NULL mantêm a semântica antiga; false é sempre inativo.
    const { count: explicitActiveCount, error: explicitActiveError } = await supabase
      .from("whatsapp_channels")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", unitId)
      .eq("is_active", true);
    if (explicitActiveError) throw new Error("active_channel_projection_read_failed");
    const channelInactive = channel.is_active === false
      || ((explicitActiveCount ?? 0) > 0 && channel.is_active !== true);
    if (channelInactive) {
      jsonLog("info", { requestId, evt: "inactive_channel_event_ignored", channelId, provider });
      await finish(manualEchoActivated
        ? "conversation_parity_verified_activated"
        : manualEchoMatchesChannel ? "conversation_parity_verified" : "inactive_channel");
      return new Response("ok");
    }

    // Eco das mensagens da loja é normalizado pelo adapter antes do inbound:
    // nunca cria customer nem roda agente. Eco de API já foi persistido pelo
    // writer original; eco do aparelho entra como humano e silencia a IA.
    if (ownMessageEchoes.length > 0) {
      const results = [];
      for (const echo of ownMessageEchoes) {
        results.push(await handleOwnMessageEcho(provider, echo, unitId, channelId));
      }
      const recorded = results.filter((result) => result.outcome === "own_message_echo_recorded").length;
      await finish(
        results.length === 1 ? results[0].outcome : "own_message_echo_batch",
        undefined,
        results.length === 1
          ? results[0].meta
          : { count: results.length, recorded, outcomes: results.map((result) => result.outcome) },
      );
      return new Response("ok");
    }

    // `chatLid` do inbound do cliente: gravado na conversa pra que o eco da
    // mensagem do atendente — que às vezes só traz LID — ache onde se pendurar.
    // deno-lint-ignore no-explicit-any
    const rawPayload = payload as any;
    const inboundChatLid: string | null =
      provider === "zapi" && typeof rawPayload?.chatLid === "string" && rawPayload.chatLid
        ? String(rawPayload.chatLid)
        : null;

    // Parse inbound message using provider-specific adapter
    const inbound = parseInbound(provider, payload);
    if (!inbound) {
      // Não é texto. Antes silenciávamos — agora detectamos áudio/foto/sticker/etc
      // e respondemos uma vez pedindo texto, pra cliente não ficar achando que
      // mandou pro vazio. O fluxo de LLM/tools NÃO roda nesse path.
      const media = peekInboundMedia(provider, payload);
      if (!media) {
        await finish("ignored_non_text", undefined, describeIgnoredPayload(provider, payload));
        return new Response("ok");
      }

      const mediaPhone = media.fromPhone;
      phoneHash = sanitizePhone(mediaPhone);

      // Mesmo guarda do path de texto — mídia ecoada não pode virar customer.
      if (!isPlausibleCustomerPhone(mediaPhone)) {
        jsonLog("warn", { requestId, evt: "implausible_sender_phone_media", len: mediaPhone.length });
        await finish("implausible_sender_phone", undefined, {
          len: mediaPhone.length,
          media: true,
          ...describeIgnoredPayload(provider, payload),
        });
        return new Response("ok");
      }

      messageIdForOutcome = media.providerMessageId;

      // Idempotência: se a mensagem já foi processada, não responde de novo.
      const { data: mediaClaimData, error: mediaClaimError } = await supabase.rpc(
        "claim_processed_whatsapp_message",
        {
          p_provider: provider,
          p_message_id: media.providerMessageId,
          p_unit_id: unitId,
          p_stale_after_seconds: Math.ceil(STUCK_PROCESSING_TIMEOUT_MS / 1000),
        },
      );
      if (mediaClaimError) {
        throw new Error("processed_message_claim_failed");
      }
      const mediaClaim = Array.isArray(mediaClaimData) ? mediaClaimData[0] : mediaClaimData;
      if (!mediaClaim?.claimed || !mediaClaim.claim_id) {
        if (mediaClaim?.previous_outcome == null) throw new Error("processed_message_inflight");
        messageIdForOutcome = null;
        await finish("duplicate_media");
        return new Response("ok");
      }
      messageProcessingClaimId = String(mediaClaim.claim_id);

      // Fase D: depois do claim e antes de qualquer efeito externo (falha aqui é
      // reentregável). Zero I/O para provider sem `adReferral`.
      await captureAdTouchpoint({
        requestId,
        provider,
        payload,
        unitId: channel.unit_id,
        channelId: channel.id,
        inboundProviderMessageId: media.providerMessageId,
        phone: mediaPhone,
        contactName: media.contactName ?? null,
        messageAtMs: media.timestamp,
      });

      // Resolve org → customer → conversation (mesmo padrão do path de texto).
      const { data: unitRow2, error: unitRow2Error } = await supabase
        .from("units")
        .select("organization_id")
        .eq("id", unitId)
        .maybeSingle();
      if (unitRow2Error || !unitRow2?.organization_id) throw new Error("media_unit_lookup_failed");
      const orgId2: string = unitRow2?.organization_id ?? "";

      // deno-lint-ignore no-explicit-any
      let mediaCustomer: any = null;
      if (orgId2) {
        try {
          mediaCustomer = await resolveOrCreateCustomer(supabase, {
            organizationId: orgId2,
            phone: mediaPhone,
            name: media.contactName ?? mediaPhone,
          });
        } catch {
          throw new Error("media_customer_resolve_failed");
        }
      }

      const userPlaceholder = mediaPlaceholder(media.mediaKind);
      const mediaReceivedAt = new Date().toISOString();
      // deno-lint-ignore no-explicit-any
      let mediaConv: any = null;
      // deno-lint-ignore no-explicit-any
      let mediaMessages: any[] = [];
      if (mediaCustomer && unitId) {
        mediaConv = await getOrCreateConversation(mediaCustomer.id, unitId, media.contactName, inboundChatLid);
        if (mediaConv) {
          const mediaAppend = await appendToConversation(
            mediaConv.id,
            mediaConv.messages || [],
            "user",
            userPlaceholder,
            {
              author: "customer",
              timestamp: media.timestamp,
              receivedAt: mediaReceivedAt,
              eventId: `wa-in:${provider}:${media.providerMessageId}`,
              required: true,
            },
          );
          mediaMessages = mediaAppend.messages;
        }
      }
      if (!mediaConv) throw new Error("media_conversation_lookup_failed");

      // Conversa em handoff humano? Não responde — atendente assume.
      if (mediaConv && (mediaConv.status === "human_active" || mediaConv.status === "awaiting_human")) {
        jsonLog("info", { requestId, evt: "media_during_handoff", mediaKind: media.mediaKind, phone: phoneHash });
        await finish("media_during_handoff", null, { mediaKind: media.mediaKind });
        return new Response("ok");
      }

      // Gate de serviço, nas duas dimensões (§6.5 da spec). Vem DEPOIS do
      // append na conversa — a mensagem recebida nunca se perde — e ANTES do
      // sendOutbound: bloqueado significa ZERO chamada à Z-API. Reusa o helper
      // central; não reimplementa os sete estados.
      if (orgId2) {
        const waGate = await resolveWhatsAppGateByOrg(supabase, orgId2);
        const verdict = decideInboundAutoReply({
          systemBlocked: waGate.systemBlocked,
          enforcedSending: waGate.enforced.sending,
        });
        if (verdict !== "REPLY") {
          const outcome = verdict === "SILENT_SYSTEM_BLOCKED"
            ? "org_billing_blocked"
            : "whatsapp_service_suspended";
          jsonLog("warn", {
            requestId, evt: "media_reply_suppressed", unitId, organizationId: orgId2,
            state: waGate.state, reason: waGate.reason, verdict,
          });
          await finish(outcome, undefined, { media: true, mediaKind: media.mediaKind, verdict });
          return new Response("ok");
        }
      }

      externalSideEffectStarted = true;
      const sendRes = await sendOutbound(provider, credentials, { toPhone: mediaPhone, text: MEDIA_REPLY_TEXT });
      let historyPersisted = true;
      if (sendRes.ok && mediaConv) {
        const replyAppend = await appendToConversation(
          mediaConv.id,
          mediaMessages,
          "assistant",
          MEDIA_REPLY_TEXT,
          { author: "automation" },
        );
        historyPersisted = replyAppend.persisted;
      }
      jsonLog("info", { requestId, evt: "media_response", mediaKind: media.mediaKind, sent: sendRes.ok });
      await finish(
        sendRes.ok ? (historyPersisted ? "media_response" : "media_response_history_degraded") : "send_error",
        sendRes.ok ? undefined : (sendRes.error ?? `status_${sendRes.status}`),
        { mediaKind: media.mediaKind },
      );
      return new Response("ok");
    }

    const phone = inbound.fromPhone;
    const incomingText = inbound.text;
    const inboundReceivedAt = new Date().toISOString();
    phoneHash = sanitizePhone(phone);

    // Backstop do guarda de eco: se a Z-API mudar o nome do campo `fromMe`, o
    // LID ainda é barrado aqui — antes de criar customer e antes do agente.
    if (!isPlausibleCustomerPhone(phone)) {
      jsonLog("warn", { requestId, evt: "implausible_sender_phone", len: phone.length });
      await finish("implausible_sender_phone", undefined, {
        len: phone.length,
        ...describeIgnoredPayload(provider, payload),
      });
      return new Response("ok");
    }

    // Receber webhook é sinal de saúde — sempre marca como connected.
    if (channel.status !== "connected") {
      jsonLog("info", { requestId, evt: "channel_recovered", channelId, prevStatus: channel.status });
    }
    await supabase
      .from("whatsapp_channels")
      .update({ last_event_at: new Date().toISOString(), status: "connected", last_error: null })
      .eq("id", channelId);

    // ─── Idempotência segura ──────────────────────────────────────────────────
    // Antes: INSERT do message_id era cego (qualquer falha posterior deixava
    // a mensagem "marcada como processada" sem ter respondido).
    // Agora: se o INSERT falha (já existe), checamos se está "presa"
    // (started_at antigo + completed_at NULL) e, se sim, reprocessamos.
    messageIdForOutcome = inbound.providerMessageId;

    const { data: claimData, error: claimError } = await supabase.rpc(
      "claim_processed_whatsapp_message",
      {
        p_provider: provider,
        p_message_id: inbound.providerMessageId,
        p_unit_id: unitId,
        p_stale_after_seconds: Math.ceil(STUCK_PROCESSING_TIMEOUT_MS / 1000),
      },
    );
    if (claimError) throw new Error("processed_message_claim_failed");
    const processingClaim = Array.isArray(claimData) ? claimData[0] : claimData;

    if (!processingClaim?.claimed || !processingClaim.claim_id) {
        if (processingClaim?.previous_outcome == null) throw new Error("processed_message_inflight");
        jsonLog("info", {
          requestId,
          evt: "duplicate_message",
          phone: phoneHash,
          prev_outcome: processingClaim?.previous_outcome ?? null,
        });
        await recordExecution({
          request_id: requestId,
          unit_id: unitId,
          channel_id: channelId,
          phone_hash: phoneHash,
          outcome: "duplicate",
          error: null,
          duration_ms: Date.now() - t0,
          meta: { prev_outcome: processingClaim?.previous_outcome ?? null },
        });
        // Não chama markProcessed (já estava completed_at correto).
        messageIdForOutcome = null;
        return new Response("ok");
    }
    messageProcessingClaimId = String(processingClaim.claim_id);
    if (processingClaim.previous_outcome !== null) {
      jsonLog("warn", {
        requestId,
        evt: "reprocessing_stuck_message",
        message_id: inbound.providerMessageId,
        prev_outcome: processingClaim.previous_outcome,
      });
    }

    // Fase D: depois do claim e ANTES de rate limit, billing e suspensão — os três
    // desviam antes de o cliente ser resolvido, e "esta pessoa chegou por este
    // anúncio" não depende de a loja estar adimplente (mesmo raciocínio do
    // persistInboundOnly). Antes de qualquer efeito externo: falha é reentregável.
    await captureAdTouchpoint({
      requestId,
      provider,
      payload,
      unitId: channel.unit_id,
      channelId: channel.id,
      inboundProviderMessageId: inbound.providerMessageId,
      phone,
      contactName: inbound.contactName ?? null,
      messageAtMs: inbound.timestamp,
    });

    // Rate limit por telefone (sliding window, por unidade)
    const { data: allowed } = await supabase.rpc("check_rate_limit", {
      p_phone: phone,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_max: RATE_LIMIT_MAX,
      p_unit_id: unitId,
    });
    if (allowed === false) {
      jsonLog("warn", { requestId, evt: "rate_limited", phone: phoneHash });
      await finish("rate_limited");
      return new Response("ok");
    }

    // Load organization_id + address + name + slug + ticket médio for the unit.
    // `name` é usado como fallback do system prompt do agente — `settings.restaurant_name`
    // virou legado, UI nova escreve em `units.name`. Sem o fallback real, o LLM
    // recebe "Você é o assistente do Restaurante" e papagueia esse nome.
    // SELECT * garante que colunas novas ficam disponíveis sem mexer na query.
    // O prompt builder (buildRestaurantInfoLines) é o gatekeeper do que entra no prompt.
    const { data: unitRow } = await supabase
      .from("units")
      .select("*")
      .eq("id", unitId)
      .maybeSingle();
    const organizationId: string = unitRow?.organization_id ?? "";
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
    const unitAddress: string =
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
    const unitName: string = (unitRow?.name as string | undefined) ?? "";
    const unitSlug: string | null = (unitRow?.slug as string | undefined) ?? null;
    const unitTicketMax: number | null = (unitRow?.price_range_max as number | null | undefined) ?? null;

    // Billing check — se org estiver blocked/suspended, não ativar agente IA
    {
      const { data: orgBilling } = await supabase
        .from("organizations")
        .select("billing_status")
        .eq("id", organizationId)
        .single();
      if (orgBilling && (orgBilling.billing_status === "blocked" || orgBilling.billing_status === "suspended")) {
        const persisted = await persistInboundOnly({
          requestId, organizationId, unitId, phone,
          contactName: inbound.contactName, text: incomingText, chatLid: inboundChatLid,
          timestamp: inbound.timestamp, receivedAt: inboundReceivedAt,
          eventId: `wa-in:${provider}:${inbound.providerMessageId}`,
        });
        if (!persisted) throw new Error("conversation_message_persist_failed");
        jsonLog("warn", { requestId, evt: "webhook_org_billing_blocked", unitId, organizationId, status: orgBilling.billing_status, persisted });
        await finish("org_billing_blocked", undefined, { inbound_persisted: persisted });
        return new Response("ok");
      }
    }

    // Suspensão do SERVIÇO de WhatsApp (mensalidade da instância), separada
    // do bloqueio do sistema logo acima. Roda ANTES do runAgentLoop: zero
    // token de IA consumido. SILÊNCIO, não mensagem — mesmo tratamento (e
    // mesma posição no fluxo, ANTES do upsert de customer/conversation) do
    // org_billing_blocked logo acima: o cliente do restaurante é terceiro
    // inocente. Outcome "whatsapp_service_suspended".
    {
      const waGate = await resolveWhatsAppGateByOrg(supabase, organizationId);
      if (waGate.enforced.sending) {
        const persisted = await persistInboundOnly({
          requestId, organizationId, unitId, phone,
          contactName: inbound.contactName, text: incomingText, chatLid: inboundChatLid,
          timestamp: inbound.timestamp, receivedAt: inboundReceivedAt,
          eventId: `wa-in:${provider}:${inbound.providerMessageId}`,
        });
        if (!persisted) throw new Error("conversation_message_persist_failed");
        jsonLog("warn", {
          requestId, evt: "webhook_whatsapp_service_suspended",
          unitId, organizationId, state: waGate.state, reason: waGate.reason, persisted,
        });
        await finish("whatsapp_service_suspended", undefined, { inbound_persisted: persisted });
        return new Response("ok");
      }
    }

    // Upsert customer (org-scoped). Preserva nome real cadastrado via reserva;
    // só preenche/atualiza quando o customer é novo ou ainda tem placeholder
    // (name == phone). Push_name do WhatsApp entra como matéria-prima quando
    // disponível — caso contrário, mantém fallback histórico (name == phone).
    const contactName = inbound.contactName;
    // deno-lint-ignore no-explicit-any
    let customer: any = null;
    try {
      customer = await resolveOrCreateCustomer(supabase, {
        organizationId,
        phone,
        name: contactName ?? phone,
      });
    } catch {
      throw new Error("customer_resolve_failed");
    }
    if (contactName && (!customer.name || customer.name === customer.phone)) {
      const { data: updated, error: updateCustomerError } = await supabase
        .from("customers")
        .update({ name: contactName })
        .eq("id", customer.id)
        .eq("organization_id", organizationId)
        .select("id, name, phone, email, emails, birthday")
        .single();
      if (updateCustomerError) throw new Error("customer_name_update_failed");
      customer = updated;
    }

    // Survey comment intercept — janela de 30 min após gravar nota.
    // Se o cliente avaliou recentemente e ainda não comentou, qualquer texto
    // livre vira comentário. A mensagem do rating intercept avisa o cliente.
    const commentCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: pendingComment } = await supabase
      .from("reservations")
      .select("id")
      .eq("unit_id", unitId)
      .eq("customer_id", customer.id)
      .gt("satisfaction_at", commentCutoff)
      .is("satisfaction_comment", null)
      .not("satisfaction_rating", "is", null)
      .order("satisfaction_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingComment) {
      // B2/B3: appenda incoming + outgoing na conversation pra operador ver
      // o ciclo completo da pesquisa de satisfação na timeline.
      const commentConv = await getOrCreateConversation(customer.id, unitId, contactName, inboundChatLid);
      const afterUser = await appendToConversation(
        commentConv.id,
        commentConv.messages || [],
        "user",
        incomingText,
        {
          author: "customer",
          timestamp: inbound.timestamp,
          receivedAt: inboundReceivedAt,
          eventId: `wa-in:${provider}:${inbound.providerMessageId}`,
          required: true,
        },
      );
      const { data: updatedComment, error: updateCommentError } = await supabase
        .from("reservations")
        .update({ satisfaction_comment: incomingText })
        .eq("id", pendingComment.id)
        .eq("unit_id", unitId)
        .eq("customer_id", customer.id)
        .is("satisfaction_comment", null)
        .select("id")
        .maybeSingle();
      if (updateCommentError || !updatedComment) throw new Error("survey_comment_update_failed");
      const replyText = "Comentário registrado. Obrigado! 🙏";
      externalSideEffectStarted = true;
      const sendRes = await sendOutbound(provider, credentials, { toPhone: phone, text: replyText });
      let historyPersisted = true;
      if (sendRes.ok) {
        const replyAppend = await appendToConversation(
          commentConv.id,
          afterUser.messages,
          "assistant",
          replyText,
          { author: "automation" },
        );
        historyPersisted = replyAppend.persisted;
      }

      jsonLog("info", { requestId, evt: "survey_comment_captured", phone: phoneHash, sent: sendRes.ok });
      await finish(
        sendRes.ok ? (historyPersisted ? "survey_comment" : "survey_comment_history_degraded") : "send_error",
        sendRes.ok ? undefined : (sendRes.error ?? `status_${sendRes.status}`),
      );
      return new Response("ok");
    }

    // Survey response intercept
    const ratingMatch = /^([1-5])$/.exec(incomingText);
    if (ratingMatch) {
      const rating = parseInt(ratingMatch[1], 10);
      const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

      const { data: pending } = await supabase
        .from("notifications_sent")
        .select("reservation_id, reservations!inner(unit_id, customer_id, satisfaction_rating)")
        .eq("unit_id", unitId)
        .eq("kind", "survey_d1")
        .eq("status", "sent")
        .gt("sent_at", cutoff)
        .eq("reservations.customer_id", customer.id)
        .eq("reservations.unit_id", unitId)
        .is("reservations.satisfaction_rating", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pending) {
        // Prepara voucher SEM persistir — code e texto montados, banco intocado.
        // Commit acontece DEPOIS do send pra evitar voucher fantasma (B3).
        const prepared = unitId
          ? await prepareGiftbackVoucher({
              supabase,
              unitId,
              customerId: customer.id,
              rating,
            })
          : null;

        const baseText = "Obrigado pelo feedback! 🙏";
        const tailText = "Se quiser comentar (sugestão, sua experiência), responda agora — sua próxima mensagem vira comentário.";
        const fullText = prepared
          ? `${baseText}\n\n${prepared.text}\n\n${tailText}`
          : `${baseText} ${tailText}`;

        const ratingConv = await getOrCreateConversation(customer.id, unitId, contactName, inboundChatLid);
        const afterUser = await appendToConversation(
          ratingConv.id,
          ratingConv.messages || [],
          "user",
          incomingText,
          {
            author: "customer",
            timestamp: inbound.timestamp,
            receivedAt: inboundReceivedAt,
            eventId: `wa-in:${provider}:${inbound.providerMessageId}`,
            required: true,
          },
        );
        const { data: updatedRating, error: updateRatingError } = await supabase
          .from("reservations")
          .update({ satisfaction_rating: rating, satisfaction_at: new Date().toISOString() })
          .eq("id", pending.reservation_id)
          .eq("unit_id", unitId)
          .eq("customer_id", customer.id)
          .is("satisfaction_rating", null)
          .select("id")
          .maybeSingle();
        if (updateRatingError || !updatedRating) throw new Error("survey_rating_update_failed");
        externalSideEffectStarted = true;
        const sendRes = await sendOutbound(provider, credentials, { toPhone: phone, text: fullText });

        // Persiste voucher (se houve) + notifications_sent com status REAL (B1).
        if (prepared && unitId) {
          await commitGiftbackVoucher({
            supabase,
            unitId,
            customerId: customer.id,
            prepared,
            sendOk: sendRes.ok,
            sendError: sendRes.ok ? null : (sendRes.error ?? `status_${sendRes.status}`),
            reservationId: pending.reservation_id ?? null,
            requestId,
          });
        }

        // B2: appenda incoming "5" + outgoing na conversation pra timeline ficar completa.
        let historyPersisted = true;
        if (sendRes.ok && unitId) {
          const replyAppend = await appendToConversation(
            ratingConv.id,
            afterUser.messages,
            "assistant",
            fullText,
            { author: "automation" },
          );
          historyPersisted = replyAppend.persisted;
        }

        jsonLog("info", { requestId, evt: "survey_response_captured", rating, phone: phoneHash, sent: sendRes.ok, voucher_emitted: !!prepared && sendRes.ok });
        await finish(
          sendRes.ok ? (historyPersisted ? "survey_response" : "survey_response_history_degraded") : "send_error",
          sendRes.ok ? undefined : (sendRes.error ?? `status_${sendRes.status}`),
        );
        return new Response("ok");
      }
    }

    // Load conversation history
    const conv = await getOrCreateConversation(customer.id, unitId, contactName, inboundChatLid);

    // ─── Promove status 'resolved' legado pra 'ai_active' ────────────────────
    // O botão "Resolver" da UI deixou de gravar 'resolved' (vide
    // useConversations.markResolved — agora limpa handoff e volta pra
    // ai_active). Conversas antigas que ainda estão em 'resolved' no banco
    // sobem aqui na próxima inbound; sem isso, handoff_reason/handoff_at
    // poderiam ficar fósseis e a UI mostraria badge "Resolvida" pra sempre.
    if (conv.status === "resolved") {
      const { error: promoteErr } = await supabase
        .from("conversations")
        .update({
          status: "ai_active",
          handoff_reason: null,
          handoff_at: null,
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);
      if (promoteErr) {
        jsonLog("warn", { requestId, evt: "resolved_promote_failed", convId: conv.id, err: String(promoteErr) });
      } else {
        jsonLog("info", { requestId, evt: "resolved_promoted_to_ai", convId: conv.id });
      }
      conv.status = "ai_active";
      conv.handoff_reason = null;
      conv.handoff_at = null;
      conv.last_silenced_reply_at = null;
    }

    // ─── UX de handoff humano ────────────────────────────────────────────────
    // Auto-resolve quando passar muito tempo sem resposta humana, e responde
    // ao cliente uma vez a cada N horas durante o silêncio para não parecer
    // que o sistema morreu.
    if (conv.status === "human_active" || conv.status === "awaiting_human") {
      // Já registra a mensagem no histórico independente do que decidirmos.
      await appendToConversation(
        conv.id,
        conv.messages || [],
        "user",
        incomingText,
        {
          author: "customer",
          timestamp: inbound.timestamp,
          receivedAt: inboundReceivedAt,
          eventId: `wa-in:${provider}:${inbound.providerMessageId}`,
          required: true,
        },
      );

      // Relógio do auto-resolve = ÚLTIMA atividade humana (início do handoff ou
      // a mensagem mais recente do atendente, venha do painel ou do celular da
      // loja). Antes bastava UMA resposta humana pra travar o auto-resolve pra
      // sempre; com o eco do celular gravado como `human`, uma única mensagem
      // do atendente silenciaria a IA indefinidamente nessa conversa.
      // deno-lint-ignore no-explicit-any
      const lastHumanTs = (conv.messages ?? []).reduce((acc: number, m: any) => {
        if (!m || m.role !== "human") return acc;
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        return ts > acc ? ts : acc;
      }, 0);

      // Sem handoff_at e sem mensagem humana (ex.: "Assumir" legado, que não
      // gravava handoff_at) o relógio nunca partia e a IA ficava silenciada
      // para sempre: inicia agora e persiste, só se ainda estiver NULL.
      const handoffClock = resolveHandoffClock({
        handoffAt: conv.handoff_at ?? null,
        lastHumanTs,
        nowMs: Date.now(),
      });
      const silenceStart = handoffClock.silenceStartMs;
      const handoffAge = silenceStart ? Date.now() - silenceStart : 0;

      if (handoffClock.persistHandoffAt) {
        const { error: clockError } = await supabase
          .from("conversations")
          .update({ handoff_at: handoffClock.persistHandoffAt })
          .eq("id", conv.id)
          .eq("unit_id", unitId)
          .is("handoff_at", null);
        if (clockError) {
          jsonLog("warn", { requestId, evt: "handoff_clock_persist_failed", convId: conv.id, err: clockError.message });
        }
      }

      // Handoff por franquia esgotada NÃO volta para a IA pelo decurso do
      // prazo: devolveria a conversa a uma IA que não pode responder. Só a
      // virada do ciclo — orçamento não mais esgotado — devolve. A leitura do
      // orçamento só acontece quando a razão é essa; nenhum custo nas demais.
      let budgetStillExhausted = false;
      if (conv.handoff_reason === AI_BUDGET_HANDOFF_REASON) {
        const franchise = await loadAiFranchise(supabase, organizationId);
        budgetStillExhausted = franchise?.state === "EXHAUSTED";
      }

      const shouldAutoResolve =
        silenceStart > 0 &&
        shouldAutoResolveHandoff({
          handoffReason: conv.handoff_reason ?? null,
          ageMs: handoffAge,
          thresholdMs: HANDOFF_AUTO_RESOLVE_MS,
          budgetExhausted: budgetStillExhausted,
        });

      if (shouldAutoResolve) {
        await supabase
          .from("conversations")
          .update({
            status: "ai_active",
            handoff_reason: null,
            handoff_at: null,
            last_silenced_reply_at: null,
          })
          .eq("id", conv.id);

        const resumedText = "Oi! Voltei a te atender por aqui. Em que posso ajudar?";
        externalSideEffectStarted = true;
        const resumedSend = await sendOutbound(provider, credentials, {
          toPhone: phone,
          text: resumedText,
        });
        if (resumedSend.ok) {
          await appendToConversation(conv.id, conv.messages || [], "assistant", resumedText, { author: "automation" });
        }

        jsonLog("info", {
          requestId,
          evt: "handoff_auto_resolved",
          convId: conv.id,
          ageHours: Math.round(handoffAge / 3600000),
        });
        // Atualiza estado local para o agente processar a mensagem normalmente.
        conv.status = "ai_active";
        conv.handoff_reason = null;
        conv.handoff_at = null;
        // Cai pra fora do bloco e segue o fluxo do agente IA.
      } else {
        // Mantém silenciada, mas avisa o cliente uma vez por janela.
        const lastSilenced = conv.last_silenced_reply_at
          ? new Date(conv.last_silenced_reply_at).getTime()
          : 0;
        const shouldRemind = !lastSilenced || (Date.now() - lastSilenced) > HANDOFF_REMINDER_THROTTLE_MS;

        if (shouldRemind) {
          const reminderText = "Recebi sua mensagem! Já avisei alguém da equipe — vou te responder por aqui assim que possível. 🙏";
          externalSideEffectStarted = true;
          const sendRes = await sendOutbound(provider, credentials, {
            toPhone: phone,
            text: reminderText,
          });
          if (sendRes.ok) {
            await appendToConversation(conv.id, conv.messages || [], "assistant", reminderText, { author: "automation" });
            await supabase
              .from("conversations")
              .update({
                last_silenced_reply_at: new Date().toISOString(),
              })
              .eq("id", conv.id);
          }
        } else {
          await supabase
            .from("conversations")
            .update({ last_message_at: new Date().toISOString() })
            .eq("id", conv.id);
        }

        jsonLog("info", {
          requestId,
          evt: "skipped_ai_human_active",
          convId: conv.id,
          status: conv.status,
          reminded: shouldRemind,
        });
        await finish(shouldRemind ? "human_active_reminded" : "human_active_silent");
        return new Response("ok");
      }
    }

    // ─── Append imediato + debounce de rajada ────────────────────────────────
    // Grava esta mensagem já (append atômico) pra que as invocações irmãs da
    // rajada e a invocação vencedora a enxerguem no histórico. Depois espera a
    // janela de debounce: se durante a espera chegou mensagem MAIS NOVA nesta
    // conversa, esta invocação desiste — quem responde é a invocação da última
    // mensagem, que relê o histórico fresco e responde uma vez só com a rajada
    // inteira. Resolve o "embaralha" (respostas paralelas fora de ordem) e
    // reduz a carga simultânea no provider de IA (menos 503/timeout → handoff).
    const appendedSelf = await appendToConversation(
      conv.id,
      conv.messages || [],
      "user",
      incomingText,
      {
        author: "customer",
        timestamp: inbound.timestamp,
        receivedAt: inboundReceivedAt,
        eventId: `wa-in:${provider}:${inbound.providerMessageId}`,
        required: true,
      },
    );
    const appendedInbound = appendedSelf.messages[appendedSelf.messages.length - 1];
    const myInboundTs = appendedInbound?.received_at ?? appendedInbound?.timestamp ?? inboundReceivedAt;

    await sleep(DEBOUNCE_WINDOW_MS);
    {
      const { data: latestConv } = await supabase
        .from("conversations")
        .select("messages")
        .eq("id", conv.id)
        .maybeSingle();
      // deno-lint-ignore no-explicit-any
      const latestMsgs = (latestConv?.messages ?? []) as any[];
      // deno-lint-ignore no-explicit-any
      const newestUserTs = latestMsgs.reduce((acc: string, m: any) => {
        const arrival = m?.received_at ?? m?.timestamp;
        if (m && m.role === "user" && typeof arrival === "string" && arrival > acc) return arrival;
        return acc;
      }, "");
      if (newestUserTs && newestUserTs > myInboundTs) {
        jsonLog("info", { requestId, evt: "debounced_superseded", convId: conv.id });
        await finish("debounced_superseded");
        return new Response("ok");
      }
      // Vencedora da rajada: assume o histórico fresco (inclui toda a rajada).
      conv.messages = latestMsgs;
    }

    // ─── Relógio do deadline suave (Fase C) ───────────────────────────────────
    // Começa AQUI, e não em `t0`: o prazo é do PROCESSAMENTO, e o que vem antes
    // desta linha — resolução de canal, CRM, janela de rajada — não é tempo que
    // o agente gastou. Gastar o orçamento com os 6 s de debounce faria o
    // deadline morder uma rodada que ele não deveria alcançar.
    //
    // E é a vizinhança certa do claim logo abaixo: `AI_LOCK_TTL_SECONDS` existe
    // para cobrir `orçamento + pior turno + envio` a partir do instante em que a
    // conversa é reivindicada (`lockTtlSecondsRequired`, no núcleo). Os dois
    // relógios começam juntos porque medem a mesma janela.
    const processingStartedAt = Date.now();

    // ─── Lock de exclusão por conversa ────────────────────────────────────────
    // O debounce acima é OTIMISTA (comparação de timestamp) e NÃO garante
    // exclusão: empate de milissegundo, ou janelas não-sobrepostas (irmão chega
    // logo após esta invocação acordar do sleep), deixam DUAS invocações
    // seguirem. Duas chamadas concorrentes ao LLM saturam o provider → ambas
    // caem em agent_error → handoff DUPLICADO. Após vencer o timestamp, esta
    // invocação reivindica a conversa: só o holder roda o agente.
    aiLockToken = requestId; // único por invocação
    const { data: claimed, error: claimErr } = await supabase.rpc("try_claim_conversation_for_ai", {
      p_conv: conv.id,
      p_token: aiLockToken,
      p_ttl_seconds: AI_LOCK_TTL_SECONDS,
    });
    if (claimErr) {
      jsonLog("warn", { requestId, evt: "ai_lock_claim_failed", convId: conv.id, err: claimErr.message });
      throw new Error("ai_lock_claim_failed");
    } else if (claimed !== true) {
      // Outro irmão da rajada detém o lock. Desiste — mas via finish() pra que
      // markProcessed marque completed_at neste message_id (senão vira "stuck" e
      // reprocessa após 90s). O holder já enxerga esta mensagem no histórico.
      jsonLog("info", { requestId, evt: "conversation_locked", convId: conv.id });
      await finish("conversation_locked");
      return new Response("ok");
    } else {
      lockAcquired = true;
      convIdForLock = conv.id;
    }

    // Re-leitura FRESCA pós-lock: entre o debounce e o claim, um irmão (erro do
    // agente / request_human_handoff) ou o operador podem ter virado o status.
    if (lockAcquired) {
      const { data: freshConv } = await supabase
        .from("conversations")
        .select("status, messages")
        .eq("id", conv.id)
        .maybeSingle();
      if (freshConv && freshConv.status !== "ai_active") {
        jsonLog("info", { requestId, evt: "status_changed_after_lock", convId: conv.id, status: freshConv.status });
        await releaseAiLock();
        await finish("status_changed_locked");
        return new Response("ok");
      }
      // deno-lint-ignore no-explicit-any
      conv.messages = (freshConv?.messages ?? conv.messages) as any[];
    }

    // Toda saída automática depois do claim passa por uma única cerca. O eco
    // humano limpa o token atomicamente; logo mesmo um status sobrescrito pelo
    // próprio ramo de handoff não autoriza envio com token perdido.
    const sendAutomatic = async (text: string): Promise<Awaited<ReturnType<typeof sendOutbound>>> => {
      const { data: fence, error: fenceError } = await supabase
        .from("conversations")
        .select("status, ai_lock_token")
        .eq("id", conv.id)
        .maybeSingle();
      if (fenceError || !fence) throw new Error("conversation_handoff_fence_failed");
      if (fence.status === "human_active" || fence.ai_lock_token !== aiLockToken) {
        return { ok: false, error: "suppressed_by_human" } as const;
      }
      externalSideEffectStarted = true;
      return await sendOutbound(provider, credentials, { toPhone: phone, text });
    };

    // Mensagens manuais do operador (send-manual-message) ficam salvas com
    // role: "human" — do ponto de vista do modelo isso é "assistant" (resposta
    // que veio do nosso lado). Sem o remap, Anthropic rejeita o request com
    // "Unexpected role 'human'".
    //
    // Além do remap, aplicamos 2 filtros antes de enviar pro LLM (mensagens
    // continuam no banco e na UI — filtro só afeta o contexto do agente):
    //
    // (a) Lixo de retentativa: respostas hardcoded de erro/handoff/empty
    //     response não agregam contexto pro modelo e ainda viciam o LLM em
    //     achar que "problema técnico" é o padrão. Lista pequena e EXATA pra
    //     evitar falso positivo (cliente reclamando de "problema técnico" do
    //     restaurante NÃO pode ser filtrado).
    //
    // (b) Janela temporal: mensagens com timestamp > 72h atrás raramente são
    //     relevantes pro pedido atual. Cortar reduz input tokens e melhora
    //     latência. Sem timestamp (legado pré-backfill) → mantém.
    const HARDCODED_AGENT_NOISE = new Set<string>([
      AGENT_INSTABILITY_TEXT,
      "Desculpa, não consegui montar uma resposta agora. Pode reformular ou aguardar um instante?",
      "Desculpe, não consegui processar sua solicitação. Tente novamente.",
      // Plano D: os textos determinísticos do bloqueio por franquia entram pela
      // LISTA, nunca redigitados — é o que impede que um texto novo apareça sem
      // entrar no filtro. Mesmo motivo de MEDIA_REPLY_TEXT: sem isso a mensagem
      // polui o histórico das invocações seguintes e ensina o modelo que
      // "atendimento interrompido" é o padrão.
      ...AI_BUDGET_HARDCODED_TEXTS,
    ]);
    const HISTORY_WINDOW_MS = 72 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - HISTORY_WINDOW_MS;

    // Separa o histórico (turnos já respondidos) das mensagens de usuário ainda
    // PENDENTES — a rajada que ainda não respondemos: tudo que veio depois da
    // última resposta do nosso lado (assistant/human). As pendentes viram UMA
    // mensagem combinada pro LLM; o resto vira histórico. Sem isso, a rajada
    // entraria no histórico E como userMessage (duplicada) ou fora de ordem.
    // deno-lint-ignore no-explicit-any
    const allMsgs: any[] = conv.messages || [];
    let lastReplyIdx = -1;
    for (let i = allMsgs.length - 1; i >= 0; i--) {
      const r = allMsgs[i]?.role;
      if (r === "assistant" || r === "human") { lastReplyIdx = i; break; }
    }
    const pendingUserMsgs = allMsgs
      .slice(lastReplyIdx + 1)
      // deno-lint-ignore no-explicit-any
      .filter((m: any) =>
        m && m.role === "user" && typeof m.content === "string"
        && !HARDCODED_AGENT_NOISE.has(m.content.trim()) && m.content.trim());
    const priorMsgs = allMsgs.slice(0, lastReplyIdx + 1);

    const history: Array<{ role: "user" | "assistant"; content: string }> = priorMsgs
      // deno-lint-ignore no-explicit-any
      .filter((m: any) => {
        if (!m || typeof m.content !== "string") return false;
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "human") return false;
        if (HARDCODED_AGENT_NOISE.has(m.content.trim())) return false;
        // Janela temporal: descarta só quando o timestamp É válido E antigo.
        // Mensagem sem timestamp (legado) ou com timestamp inválido → mantém.
        if (m.timestamp) {
          const t = new Date(m.timestamp).getTime();
          if (Number.isFinite(t) && t < cutoffMs) return false;
        }
        return true;
      })
      // deno-lint-ignore no-explicit-any
      .map((m: any) => ({
        role: m.role === "human" ? ("assistant" as const) : (m.role as "user" | "assistant"),
        content: m.content,
      }));

    // Mensagem combinada da rajada (várias linhas se o cliente picou em vários
    // balões). Fallback pro texto desta invocação se a separação vier vazia.
    const combinedUserMessage =
      // deno-lint-ignore no-explicit-any
      pendingUserMsgs.map((m: any) => m.content.trim()).join("\n").trim() || incomingText;

    // ─── Franquia de IA (Plano D) ────────────────────────────────────────────
    // Resolve o entitlement de IA COM o estado do orçamento. Só o ramo
    // `franchise` entra no caminho novo: override vitalício (Ren Sushi),
    // carteira legada e BYOK puro seguem exatamente como antes — `budgetHooks`
    // fica `undefined` e o laço roda byte a byte como hoje.
    //
    // NENHUMA CONTAGEM DE CONVERSA, MENSAGEM OU INTERAÇÃO AUTORIZA NADA AQUI.
    // O único teto é financeiro e por organização.
    const aiFranchiseState = await loadAiFranchise(supabase, organizationId);
    const entitlements = await resolveOrgEntitlements(
      supabase,
      organizationId,
      undefined,
      aiFranchiseState ?? undefined,
    );
    const isFranchise = entitlements.ai.source === "franchise";

    if (entitlements.readFailed) {
      // Leitura degradada resolve com os defaults de quem NÃO leu (sem
      // overrides, sem assinaturas), então a franquia deixa de ser reconhecida
      // e o turno roda SEM ganchos e SEM medição. NÃO negamos — a consequência
      // recairia sobre o cliente do restaurante, e negar é decisão comercial.
      // Mas o silêncio era o defeito: sem esta linha, gasto não medido é
      // invisível justamente quando o banco está com soluço.
      jsonLog("warn", {
        requestId,
        evt: "ai_budget_entitlements_read_failed",
        unitId,
        organizationId,
        franchise: isFranchise,
      });
    }

    // Com `source: "franchise"`, `allowed: false` significa UMA coisa só: o
    // ciclo está EXHAUSTED. É teto comercial, e por isso obedece à mesma flag
    // que `openTurnBudget` — que devolve `UNMETERED` em vez de `EXHAUSTED` com
    // o gate desligado. Esta porta é mais curta e chegaria antes: sem a mesma
    // disciplina, a organização que estourou o teto seria bloqueada pelo
    // atalho, e o modo que existe para MEDIR antes de bloquear nunca mediria
    // nada justamente dela. A flag é lida só quando já se sabe que o teto
    // estourou — nenhuma leitura no caminho comum.
    const budgetExhaustedNow = isFranchise && !entitlements.ai.allowed;
    if (budgetExhaustedNow && (await isFlagEnabled("ai_wallet_enforced"))) {
      // HARD STOP. O canal NÃO é desligado, o sistema NÃO é bloqueado, a
      // conversa continua visível e o atendimento humano continua possível
      // (§18.3). Nada de "falha técnica": não houve falha nenhuma.
      //
      // A mensagem do cliente JÁ ESTÁ no histórico — foi appendada antes do
      // debounce. Reappendá-la aqui duplicaria a linha na thread.
      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: AI_BUDGET_HANDOFF_REASON,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // Texto determinístico, hardcoded. NÃO passa por sanitizeForWhatsApp
      // (só saída de LLM passa) e NÃO expõe custo, tokens, modelo ou limite.
      const budgetNotice = await sendAutomatic(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT);
      if (budgetNotice.ok) {
        await appendToConversation(
          conv.id,
          conv.messages || [],
          "assistant",
          AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
          { author: "automation" },
        );
      }

      jsonLog("warn", {
        requestId,
        evt: "ai_budget_exhausted_handoff",
        unitId,
        organizationId,
        convId: conv.id,
      });
      await finish("ai_budget_exhausted");
      await releaseAiLock();
      return new Response("ok");
    }

    // Load AI config from settings (unit-scoped)
    const { data: configSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "ai_config")
      .maybeSingle();

    const aiConfig = (configSetting?.value ?? {}) as Record<string, unknown>;
    const provider_ai: AIProvider = (aiConfig.provider as AIProvider) ?? "claude";
    const rawModel: string | undefined = (aiConfig.models as Record<string, string>)?.[provider_ai];
    // Blindagem: ignora modelo desconhecido/descontinuado salvo em settings (ex: legado
    // "gemini-2.0-flash" que o Google removeu pra contas novas → 404 silencioso).
    // resolveModel cai no DEFAULT_MODELS[provider] e marca fellBack pra logar/telemetria.
    const modelResolved = resolveModel(provider_ai, rawModel);
    const modelOverride: string = modelResolved.model;
    if (modelResolved.fellBack) {
      jsonLog("warn", {
        requestId,
        evt: "ai_model_fallback",
        provider: provider_ai,
        rejected: modelResolved.rejected,
        used: modelOverride,
        unitId,
      });
    }

    let apiKey: string;
    try {
      apiKey = await resolveApiKey(provider_ai, unitId);
    } catch (err) {
      // Sem chave própria cadastrada pra esta unit. Vai pra handoff humano —
      // não silenciamos, não pedimos retry (não resolve), não compartilhamos
      // chave global (cobrança ficaria misturada entre tenants).
      jsonLog("error", { requestId, evt: "ai_key_unavailable", provider: provider_ai, unitId, err: String(err) });

      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: `api_key_not_configured:${provider_ai}`,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      const handoffText = "Obrigado pela mensagem! Já avisei alguém da equipe pra continuar com você por aqui. Em breve um humano assume.";
      const keyNotice = await sendAutomatic(handoffText);
      if (keyNotice.ok) {
        await appendToConversation(
          conv.id,
          [...(conv.messages || []), { role: "user", content: incomingText }],
          "assistant",
          handoffText,
          { author: "automation" },
        );
      }

      await finish("ai_key_unavailable", String(err), {
        provider: provider_ai,
        channel_id: channelId,
      });
      await releaseAiLock();
      return new Response("ok");
    }

    // Carrega TODOS os settings da unit — sem filtro por key.
    // Prompt builder decide o que usar; settings novos ficam disponíveis sem mexer na query.
    const { data: settings } = await supabase
      .from("settings")
      .select("key, value")
      .eq("unit_id", unitId);

    const settingsMap = Object.fromEntries((settings || []).map((s: { key: string; value: unknown }) => [s.key, s.value]));
    const restaurantName =
      (settingsMap["restaurant_name"] as string) || unitName || "nosso restaurante";
    const customPrompt = (settingsMap["ai_system_prompt"] as string) ?? "";

    // Horários de reserva — fonte primária é `halls + hall_schedules` (migration
    // 030+). `business_hours` é DEPRECATED, mas mantido como fallback pra units
    // antigas que ainda não tenham hall configurado.
    const hallScheduleBlock = await buildHallSchedulesBlock(unitId);

    let hoursLines: string[] = [];
    if (!hallScheduleBlock) {
      const { data: hoursRows } = await supabase
        .from("business_hours")
        .select("day_of_week, open_time, close_time, is_closed")
        .eq("unit_id", unitId)
        .order("day_of_week");

      const dayNames = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
      hoursLines = (hoursRows ?? []).map((h: { day_of_week: number; open_time: string; close_time: string; is_closed: boolean }) =>
        h.is_closed ? `- ${dayNames[h.day_of_week]}: fechado` : `- ${dayNames[h.day_of_week]}: ${h.open_time?.slice(0, 5)} às ${h.close_time?.slice(0, 5)}`
      );
    }

    // Data/dia-da-semana SEMPRE em BRT (UTC-3). Deno roda em UTC; sem o shift, das 21h à
    // meia-noite BRT o dia vira pro seguinte e o bot cita preço do dia errado (cardápio por dia).
    const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
    const nowBrt = new Date(Date.now() - BRT_OFFSET_MS);
    const brtWeekdayIdx = nowBrt.getUTCDay();
    const weekdayName = WEEKDAY_NAMES_PT[brtWeekdayIdx];
    const today = nowBrt.toISOString().slice(0, 10);
    const horizon = new Date(nowBrt.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: specialDates } = await supabase
      .from("special_dates")
      .select("date, name, is_closed, open_time, close_time")
      .eq("unit_id", unitId)
      .gte("date", today)
      .lte("date", horizon)
      .order("date", { ascending: true });

    const specialLines = (specialDates ?? []).map((s: { date: string; name: string; is_closed: boolean; open_time: string; close_time: string }) => {
      const [y, m, d] = s.date.split("-");
      const ymd = `${d}/${m}/${y}`;
      return s.is_closed ? `- ${ymd} (${s.name}): fechado` : `- ${ymd} (${s.name}): ${s.open_time?.slice(0, 5)} às ${s.close_time?.slice(0, 5)}`;
    });

    // table_blocks macro (table_id IS NULL) ativos no horizonte de 60 dias.
    // Sem isso o LLM responde "sim, aceitamos reservas pra dia X" sem chamar
    // check_availability pra perguntas genéricas — o bloqueio só era visto
    // quando o cliente já tinha dado data+hora+party (auditoria 2026-05-20).
    const horizonISO = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const nowISO = new Date().toISOString();
    const { data: tableBlocks } = await supabase
      .from("table_blocks")
      .select("title, reason, hall_id, blocked_from, blocked_to")
      .eq("unit_id", unitId)
      .is("table_id", null)
      .gte("blocked_to", nowISO)
      .lte("blocked_from", horizonISO)
      .order("blocked_from", { ascending: true });

    // Hall names pra sufixar bloqueios hall-específicos
    const blockHallIds = Array.from(
      new Set(((tableBlocks ?? []) as { hall_id: string | null }[]).map((b) => b.hall_id).filter((id): id is string => !!id)),
    );
    const blockHallNameById = new Map<string, string>();
    if (blockHallIds.length > 0) {
      const { data: hallRows } = await supabase
        .from("halls")
        .select("id, name")
        .in("id", blockHallIds);
      for (const h of (hallRows ?? []) as { id: string; name: string }[]) {
        blockHallNameById.set(h.id, h.name);
      }
    }

    // BRT = UTC-3 fixo (BRT_OFFSET_MS declarado acima). Subtraímos 3h e lemos UTC*.
    const toBrtParts = (iso: string) => {
      const d = new Date(new Date(iso).getTime() - BRT_OFFSET_MS);
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = d.getUTCFullYear();
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const min = String(d.getUTCMinutes()).padStart(2, "0");
      return {
        ymd: `${yyyy}-${mm}-${dd}`,
        br: `${dd}/${mm}/${yyyy}`,
        time: `${hh}:${min}`,
        h: d.getUTCHours(),
        m: d.getUTCMinutes(),
      };
    };

    // IMPORTANTE: bloqueio em table_blocks = "não aceitamos reservas" naquela
    // data/horário, NÃO = "restaurante fechado". Walk-in, evento privado já
    // contratado, fila de espera, etc, podem continuar rolando. Por isso o
    // phrasing aqui evita "fechado" — é "sem reservas". `special_dates` com
    // `is_closed=true` é o canal correto pra fechamento real (formatado em
    // `specialLines` acima como "fechado").
    const blockedLines = (tableBlocks ?? []).map(
      (b: { title: string | null; reason: string | null; hall_id: string | null; blocked_from: string; blocked_to: string }) => {
        const from = toBrtParts(b.blocked_from);
        const to = toBrtParts(b.blocked_to);
        const title = b.title ?? b.reason ?? "Bloqueio";
        const hallSuffix = b.hall_id
          ? ` — só no salão ${blockHallNameById.get(b.hall_id) ?? "específico"}`
          : "";
        const sameDay = from.ymd === to.ymd;
        const allDay = from.h === 0 && from.m === 0 && to.h === 23 && to.m === 59;
        if (sameDay && allDay) return `- ${from.br} (${title}): sem reservas o dia inteiro${hallSuffix}`;
        if (sameDay) return `- ${from.br} (${title}): sem reservas das ${from.time} às ${to.time}${hallSuffix}`;
        if (allDay) return `- ${from.br} a ${to.br} (${title}): sem reservas o dia inteiro${hallSuffix}`;
        return `- ${from.br} ${from.time} a ${to.br} ${to.time} (${title}): sem reservas${hallSuffix}`;
      },
    );

    // ── Cardápio digital ativo (link público pra mandar ao cliente quando perguntar)
    let menuPublicUrl: string | null = null;
    if (unitSlug) {
      const { data: activeMenu } = await supabase
        .from("menus")
        .select("slug")
        .eq("unit_id", unitId)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (activeMenu?.slug) {
        const appBaseUrl = Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";
        menuPublicUrl = `${appBaseUrl}/m/${activeMenu.slug}`;
      }
    }

    // ── Regras Giftback ativas (resumo pro LLM saber o que existe sem inventar)
    const { data: voucherRules } = await supabase
      .from("voucher_rules")
      .select("trigger_type, discount_percent, validity_days, min_rating, visits_required, days_window")
      .eq("unit_id", unitId)
      .eq("active", true);

    const giftbackLines: string[] = [];
    for (const r of (voucherRules ?? []) as {
      trigger_type: string;
      discount_percent: number;
      validity_days: number;
      min_rating: number | null;
      visits_required: number | null;
      days_window: number | null;
    }[]) {
      const validity = `validade ${r.validity_days} ${r.validity_days === 1 ? "dia" : "dias"}`;
      if (r.trigger_type === "birthday") {
        giftbackLines.push(`- Aniversariantes ganham voucher de ${r.discount_percent}% (${validity}) — emitido automaticamente no dia.`);
      } else if (r.trigger_type === "after_rating" && r.min_rating != null) {
        giftbackLines.push(`- Avaliação de ${r.min_rating}★ ou mais gera voucher de ${r.discount_percent}% (${validity}) — emitido automaticamente após a avaliação.`);
      } else if (r.trigger_type === "frequency" && r.visits_required != null) {
        const win = r.days_window ? ` em até ${r.days_window} dias` : "";
        giftbackLines.push(`- A cada ${r.visits_required} visitas${win} o cliente ganha voucher de ${r.discount_percent}% (${validity}).`);
      } else if (r.trigger_type === "manual") {
        giftbackLines.push(`- Há voucher manual de ${r.discount_percent}% (${validity}) — emitido só pela equipe, NÃO ofereça automaticamente.`);
      }
    }

    // ── Vouchers ativos deste cliente
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data: customerVouchers } = await supabase
      .from("vouchers")
      .select("code, discount_percent, expires_at")
      .eq("unit_id", unitId)
      .eq("customer_id", customer.id)
      .eq("status", "active")
      .gte("expires_at", todayIso)
      .order("expires_at", { ascending: true });

    const customerVoucherLines: string[] = ((customerVouchers ?? []) as {
      code: string;
      discount_percent: number;
      expires_at: string;
    }[]).map((v) => {
      const [y, m, d] = v.expires_at.slice(0, 10).split("-");
      return `- Voucher *${v.code}*: ${v.discount_percent}% de desconto, válido até ${d}/${m}/${y}.`;
    });

    // ── Aniversário do cliente — hoje? nos próximos 7 dias?
    let birthdayLine: string | null = null;
    if (customer.birthday) {
      const bday = String(customer.birthday); // YYYY-MM-DD
      const bMM = bday.slice(5, 7);
      const bDD = bday.slice(8, 10);
      const now = new Date();
      const todayMM = String(now.getMonth() + 1).padStart(2, "0");
      const todayDD = String(now.getDate()).padStart(2, "0");
      if (bMM === todayMM && bDD === todayDD) {
        birthdayLine = `- HOJE é aniversário do cliente. Parabenize com calor logo no início da resposta, antes de tratar do pedido dele.`;
      } else {
        // Próximos 7 dias
        const target = new Date(`${now.getUTCFullYear()}-${bMM}-${bDD}T12:00:00Z`);
        if (target.getTime() < now.getTime()) {
          target.setUTCFullYear(target.getUTCFullYear() + 1);
        }
        const diffDays = Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 0 && diffDays <= 7) {
          birthdayLine = `- Aniversário do cliente em ${diffDays} dia(s) (${bDD}/${bMM}). Se ele tocar no assunto, parabenize antecipadamente; senão, não force.`;
        }
      }
    }

    const prefsLines: string[] = [];
    if (customer.allergies) prefsLines.push(`- Alergias: ${customer.allergies}`);
    if (customer.dietary_restrictions) prefsLines.push(`- Restrições alimentares: ${customer.dietary_restrictions}`);
    if (customer.vip_notes) prefsLines.push(`- VIP: ${customer.vip_notes}`);
    if (customer.preferred_table_location) prefsLines.push(`- Mesa preferida: ${customer.preferred_table_location === "internal" ? "interna" : "externa"}`);
    if (birthdayLine) prefsLines.push(birthdayLine);
    for (const v of customerVoucherLines) prefsLines.push(v);

    // ── Registry centralizado: UMA linha por campo = prompt atualizado.
    // Para adicionar campo novo: inclua uma entrada aqui. SELECT * na units
    // e settings sem filtro garantem que o dado já está carregado.
    const FACILITY_LABELS: Record<string, string> = { parking: "estacionamento", valet: "valet/manobrista", wifi: "Wi-Fi", accessible: "acessibilidade", air_conditioning: "ar-condicionado", kids_area: "espaço kids", pet_friendly: "aceita pets", live_music: "música ao vivo", smoking_area: "área fumante", outdoor_seating: "área externa" };
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const restaurantInfoLines: string[] = [
      str(unitRow?.description) && `- Descrição: ${str(unitRow?.description)}`,
      Array.isArray(unitRow?.cuisine_types) && (unitRow.cuisine_types as string[]).filter(Boolean).length > 0 && `- Tipo de cozinha: ${(unitRow.cuisine_types as string[]).filter(Boolean).join(", ")}`,
      str(unitRow?.opening_hours_text) && `- Horário de funcionamento: ${str(unitRow?.opening_hours_text)}`,
      unitTicketMax && unitTicketMax > 0 && `- Ticket médio: até R$ ${unitTicketMax.toFixed(2).replace(".", ",")} por pessoa (referência, não inclui bebidas/sobremesa).`,
      str(unitRow?.payment_methods) && `- Formas de pagamento: ${str(unitRow?.payment_methods)}`,
      Array.isArray(unitRow?.facilities) && (unitRow.facilities as string[]).length > 0 && `- Facilidades: ${(unitRow.facilities as string[]).map((f: string) => FACILITY_LABELS[f] || f).join(", ")}`,
      menuPublicUrl && `- Cardápio digital (envie o link quando o cliente pedir o cardápio): ${menuPublicUrl}`,
      str(unitRow?.phone) && `- Telefone do restaurante: ${str(unitRow?.phone)}`,
      str(unitRow?.instagram) && `- Instagram: @${str(unitRow?.instagram).replace(/^@/, "")}`,
      str(unitRow?.website) && `- Site: ${str(unitRow?.website)}`,
    ].filter((line): line is string => !!line);

    const [todayY, todayM, todayD] = today.split("-");
    const todayBR = `${weekdayName}, ${todayD}/${todayM}/${todayY}`;
    const upcomingDaysLines = buildUpcomingDaysLines(nowBrt);

    const agentMode = (settingsMap["agent_mode"] as string) ?? "reservations";
    const includeFaq = agentMode === "reservations_faq";
    // Nome do agente é per-unit (setting jsonb `agent_name`, default "Yumi"). str() blinda contra interpolação de jsonb cru.
    const agentName = str(settingsMap["agent_name"]) || "Yumi";
    // Nome do cliente para o prompt. customer.name pode ser placeholder (== phone)
    // quando o WhatsApp não trouxe push_name — nesse caso NÃO injetar (viraria "número").
    // Sem isso, o único nome próprio no prompt é o da persona (agentName) e o LLM
    // passa a chamar o CLIENTE pelo nome da persona ("Yumi").
    const rawCustomerName = str(customer?.name);
    const customerFirstName =
      rawCustomerName && rawCustomerName !== customer?.phone && rawCustomerName !== phone
        ? rawCustomerName.trim().split(/\s+/)[0]
        : "";
    const agentHeader = includeFaq
      ? `Você é ${agentName}, atendente do ${restaurantName}. Cuida de reservas e dúvidas gerais (cardápio, horário, endereço, estacionamento, pagamento). `
      : `Você é ${agentName}, atendente de reservas do ${restaurantName}. `;

    const systemPrompt =
      agentHeader +
      `IDENTIDADE: Você se chama ${agentName} e atende como parte da equipe do ${restaurantName} — fale sempre na primeira pessoa, de forma natural e humana, tratando o cliente por "você". NÃO diga espontaneamente que é um assistente virtual, robô, IA, bot ou sistema automático, e não use linguagem robótica. Só revele que é um atendimento virtual se o cliente perguntar DIRETAMENTE se está falando com um robô/IA/atendente automático — nesse caso seja honesta e responda com naturalidade (ex: "Sou a ${agentName}, faço o atendimento virtual do ${restaurantName} e quando precisar chamo alguém da equipe"). Ao transferir para um colega (handoff), dizer que vai chamar alguém da equipe NÃO exige revelar que você é virtual. ` +
      `Seja cordial, eficiente e responda sempre em português brasileiro. Respostas curtas e diretas — em geral 3 a 4 linhas; use mais espaço só quando precisar listar horários, opções ou preços. Evite excesso de emojis. ` +
      `O número de WhatsApp do cliente é ${phone}. Hoje é ${todayBR}. ` +
      `\n\nPróximos dias (use esta lista para saber o dia da semana de "amanhã", "sábado", "dia 18" etc. — nunca calcule de cabeça):\n${upcomingDaysLines.join("\n")}\n\n` +
      (customerFirstName
        ? `O cliente com quem você está falando se chama ${customerFirstName} — esse é o nome do CLIENTE, NÃO o seu. Você continua sendo ${agentName}. Pode tratá-lo por ${customerFirstName} quando soar natural, sem forçar o nome em toda mensagem. `
        : "") +
      `Use as ferramentas disponíveis para reservas. ` +
      `Ao criar uma reserva, sempre confirme todos os detalhes antes de finalizar. ` +
      `Não invente horários, cardápio, serviços, descontos, promoções nem benefícios de aniversário — só use o que está documentado abaixo. ` +
      `Se o pedido fugir do escopo (reclamação, evento corporativo, delivery não suportado, qualquer coisa que as ferramentas não cobrem), use a tool 'request_human_handoff' informando o motivo. ` +
      `GRUPOS GRANDES E EVENTOS: para reservas acima de 20 pessoas, eventos privados, aniversários com decoração, confraternizações ou casamentos, NÃO crie a reserva pelo sistema — chame 'request_human_handoff' para a equipe organizar. ` +
      `ANTES DE TRANSFERIR PARA UM HUMANO: quando o cliente pedir para "falar com um atendente", "falar com alguém", "quero uma pessoa" ou similar SEM explicar o motivo, NÃO chame 'request_human_handoff' de cara. Primeiro responda de forma cordial perguntando em que pode ajudar (ex: "Claro! Pra eu te ajudar mais rápido, me conta o que você precisa? Posso cuidar de reservas, cardápio, horários, endereço, pagamento e estacionamento."). Se o que o cliente quer estiver dentro do seu escopo e das ferramentas, RESOLVA você mesmo em vez de transferir. Só acione 'request_human_handoff' se (a) o assunto exigir mesmo um humano (reclamação, evento/grupo grande, delivery não suportado, cobrança, alergia grave, imprensa/parceria), ou (b) o cliente insistir em falar com uma pessoa mesmo depois de você se oferecer pra ajudar. Cliente claramente irritado ou em situação delicada: transfira direto, sem insistir em resolver sozinho. ` +
      `IMPORTANTE: ao chamar 'request_human_handoff', SEMPRE envie ao cliente uma mensagem amigável avisando que um atendente humano vai responder em breve, antes de encerrar sua resposta. Nunca silencie sem aviso.` +
      `\n\nREGRAS OBRIGATÓRIAS PARA RESERVAS:\n` +
      `1. SEMPRE chame check_availability ANTES de create_reservation. Nunca atalhe.\n` +
      `2. Se check_availability retornar available: false, NUNCA crie a reserva. Comunique ao cliente que não há mesa naquele horário e ofereça alternativas (outro horário do mesmo dia ou outra data próxima) — nunca ofereça fila/lista de espera, ver Regra 12. Use o campo 'reason' para entender o motivo (closed_day, outside_hours, no_capacity, all_blocked).\n` +
      `3. Se create_reservation retornar success: false, informe o cliente o motivo — NÃO tente criar a reserva novamente sem fazer nova consulta com data/horário diferente.\n` +
      `4. Para alterar uma reserva existente (update_reservation) que mude data ou horário, chame check_availability antes para validar o novo slot.\n` +
      `5. Se o cliente perguntar sobre uma data presente na lista 'Datas com bloqueio de reservas' (abaixo), NUNCA confirme disponibilidade de reserva. Na MESMA resposta (sem esperar o cliente perguntar de novo), deixe DUAS coisas claras juntas: (a) naquela data não estamos aceitando reservas pelo motivo entre parênteses; (b) o restaurante ESTARÁ ABERTO normalmente e o atendimento será por ORDEM DE CHEGADA — o cliente pode ir presencialmente. Exceção: se o título do bloqueio indicar evento privado, casa fechada para terceiros, manutenção ou similar, NÃO diga "venha por ordem de chegada" — nesse caso explique que naquela data não estamos atendendo o público geral. NUNCA diga que o restaurante está "fechado" — bloqueio de reserva ≠ fechamento. Use "não estamos aceitando reservas", "agenda de reservas indisponível" ou "estamos com bloqueio de reservas" pra falar da agenda; "aberto normalmente, atendimento por ordem de chegada" pra explicar o funcionamento. Se for bloqueio só de um salão (sufixo "— só no salão X"), ofereça reserva em OUTRO salão na mesma data. Para 'Datas especiais' marcadas como 'fechado', aí sim diga "estamos fechados" (é fechamento real). NÃO chame check_availability nem create_reservation para datas dessa lista — a resposta é direta com base no contexto.\n` +
      `6. Os "Horários de reservas por salão" (abaixo) são as JANELAS em que aceitamos RESERVAS — podem ser diferentes do horário completo de funcionamento do restaurante (ex: aceitamos reservas das 19:00 às 19:30, mas o restaurante funciona até 23:00). Quando o cliente perguntar "qual o horário?", "que horas abre/fecha?" ou similar (pergunta ambígua), responda DUAS coisas na mesma mensagem: (a) o horário de funcionamento do restaurante, se estiver documentado em "Observações sobre a unidade" ou "Outras informações" abaixo; E (b) os horários em que aceitamos reservas (das janelas listadas). Se o horário de funcionamento NÃO estiver documentado no contexto, responda apenas os horários de reserva, deixando claro que são os horários em que aceitamos reservas — NUNCA diga "não tenho essa informação" nem peça handoff humano só por isso. Se o cliente perguntar especificamente "até que horas funciona o almoço/jantar?" e a informação não estiver nas observações, diga que pode confirmar os horários de reserva e sugira que entre em contato para saber o horário completo de funcionamento. Para reservas: se o horário pedido não aparece nas janelas listadas, indique a janela mais próxima do mesmo dia (ou do dia seguinte). Se houver mais de um salão e algum atender no horário pedido, ofereça esse salão. Só chame check_availability quando o horário pedido CAI dentro de alguma janela listada e você precisa confirmar mesa para uma reserva concreta (data + hora + nº de pessoas). Cada janela pode ter anotações entre parênteses (% de desconto, antecedência mínima, caução). Mencione essas anotações quando relevantes pra resposta — sem inventar.\n` +
      `7. Vouchers, descontos e promoções: os vouchers ATIVOS deste cliente estão listados em "O que sabemos sobre este cliente" (se houver). Pode mencionar o código e a validade quando o cliente perguntar sobre desconto ou quando for relevante (ex: ao fechar uma reserva). NUNCA invente código de voucher. Vouchers automáticos chegam ao cliente sozinhos (worker dispara via WhatsApp) — você NÃO emite voucher. Voucher de trigger "manual" só é emitido pela equipe, não ofereça por iniciativa. CRÍTICO: NUNCA invente, prometa ou sugira qualquer desconto, promoção, cupom, brinde, cortesia ou benefício (incluindo desconto ou cortesia de aniversário) que não esteja EXPLICITAMENTE listado em "Programa Giftback", nos vouchers ativos deste cliente, ou em "Preços e condições do restaurante". Se o cliente perguntar sobre um desconto/promoção que NÃO está documentado acima, responda com clareza que NO MOMENTO não há nenhuma promoção ou desconto ativo — NÃO invente percentual, condição (ex: "mediante documento com foto", "válido no dia do aniversário") nem regra. O nome de um item do cardápio (ex: "Rodízio Especial") NÃO autoriza afirmar que existe desconto sobre ele.\n` +
      `8. Aniversário: se "O que sabemos sobre este cliente" indicar que HOJE é o aniversário do cliente, parabenize logo no início da resposta antes de tratar do pedido — mesmo que o cliente esteja só perguntando algo trivial. Se for nos próximos dias, só mencione se o cliente trouxer o assunto.\n` +
      `9. Cancelamento: quando o cliente pedir para cancelar (ex: "Cancelar", "Quero cancelar", "Cancela minha reserva"), siga este fluxo:\n` +
      `   (a) Se o cliente informou o código da reserva, confirme data/horário/código com ele e, após confirmação, chame cancel_reservation com o código.\n` +
      `   (b) Se o cliente NÃO informou o código, chame get_reservation sem parâmetros — o sistema usa o telefone do cliente automaticamente para localizar a reserva ativa mais recente.\n` +
      `   (c) Se get_reservation retornar a reserva, confirme os detalhes com o cliente (data, horário, código) antes de cancelar.\n` +
      `   (d) Se o cliente tiver múltiplas reservas ativas, chame list_customer_reservations para listar todas e pergunte qual deseja cancelar.\n` +
      `   (e) Só chame cancel_reservation APÓS confirmação explícita do cliente. NUNCA chame cancel_reservation sem reservation_code — o parâmetro é obrigatório.\n` +
      `   (f) Após cancelar, informe o código cancelado e pergunte se precisa de algo mais.\n` +
      `10. Confirmação de reserva: quando você já apresentou os detalhes (data, horário, pessoas, salão) e pediu confirmação ao cliente, interprete como SIM qualquer resposta afirmativa em português — mesmo informal. Exemplos: "Isso", "Isso mesmo", "Sim", "Pode ser", "Tá bom", "Tá", "Pode", "Fechado", "Bora", "Confirma", "Manda ver", "Perfeito", "Exato", "Aham", "Claro", "Lógico", "Beleza". Ao receber confirmação:\n` +
      `   (a) Chame check_availability com a data, horário e número de pessoas combinados — MESMO que você já tenha checado no turno anterior (a disponibilidade pode ter mudado entre mensagens).\n` +
      `   (b) Se available: true, chame create_reservation imediatamente com todos os dados coletados (nome, data, hora, party_size, hall_name se definido).\n` +
      `   (c) Se available: false, informe que a mesa não está mais disponível e ofereça alternativas.\n` +
      `   (d) Após criar com sucesso, SEMPRE informe o código da reserva ao cliente.\n` +
      `11. Preços que variam por dia da semana: o cardápio e/ou "Preços e condições" podem listar valores diferentes por dia (ex: "segunda a quarta", "quinta a domingo", "todos os dias"). HOJE é ${weekdayName}. Ao informar um preço, identifique PRIMEIRO qual faixa de dias inclui ${weekdayName} e use SOMENTE essa faixa. NUNCA cite um valor de um intervalo que NÃO inclua ${weekdayName} (ex: não dê preço de quinta num dia que é quarta). Se o cliente perguntar o preço de OUTRO dia, use a faixa daquele dia. Para descobrir o dia da semana de uma data relativa ou futura, consulte a lista "Próximos dias"; para data fora da lista, use o dia da semana da data completa informada pelo cliente ou pergunte a data. Se alguma faixa mencionar "feriado(s)": você NÃO tem como saber se hoje é feriado — informe o preço NORMAL do dia da semana e acrescente o aviso "Exceto feriados." (em feriados o valor pode ser diferente). NUNCA assuma que hoje é ou não é feriado, nem invente preço de feriado.\n` +
      // Regra 12: o agente NÃO tem tool de fila de espera — prometer isso é
      // promessa vazia (o cliente espera um aviso que nunca sai). Enquanto a
      // fila não for exposta como ferramenta, a regra é não oferecer.
      `12. Fila de espera / lista de espera: NÃO trabalhamos com fila de espera pelo WhatsApp. NUNCA ofereça, prometa, sugira nem diga que colocou o cliente em "fila de espera", "lista de espera" ou que "avisa se vagar uma mesa" — você NÃO tem ferramenta para isso, então qualquer promessa dessas é falsa e o cliente ficaria esperando um aviso que nunca chega. Quando não houver disponibilidade, ofereça alternativas concretas: outro horário do mesmo dia, outra data próxima ou outro salão. Se o cliente pedir explicitamente para entrar numa fila/lista de espera, diga com clareza e cordialidade que no momento não fazemos isso por aqui e ofereça as alternativas acima; se ele insistir, acione 'request_human_handoff' em vez de prometer qualquer coisa.` +
      `\n\nFORMATAÇÃO DA RESPOSTA NO WHATSAPP:\n` +
      `- Negrito é *um único asterisco* (ex: *importante*). NUNCA use **dois asteriscos**, ### header ou markdown — WhatsApp mostra os símbolos literais.\n` +
      `- Itálico com _texto_ entre underlines. Tachado com ~texto~.\n` +
      `- Listas SEMPRE com "- " (hífen + espaço) no começo da linha, uma por linha. NUNCA use "* " — o asterisco solto aparece literal pro cliente.\n` +
      `- Separe blocos lógicos (preços, horários, opções, observação) com UMA linha em branco. Frases e parágrafos curtos — o cliente está lendo no celular.\n` +
      `- Não use tabelas, blocos de código com \`\`\`, nem links no formato [texto](url) — WhatsApp não interpreta. Cole a URL direto.\n` +
      `- Emojis: máximo 1 ou 2 por mensagem, só quando agregam contexto. Sugestões: 📅 data, 🕐 horário, 📍 endereço, 🍽️ cardápio, ✅ confirmação, ❌ cancelamento, 🙏 agradecimento. Não exagere — mensagem cheia de emoji parece spam.` +
      (unitAddress ? `\n\nEndereço: ${unitAddress}` : "") +
      (restaurantInfoLines.length ? `\n\nSobre o restaurante:\n${restaurantInfoLines.join("\n")}` : "") +
      (hallScheduleBlock
        ? `\n\n${hallScheduleBlock}`
        : hoursLines.length
        ? `\n\nHorário de funcionamento:\n${hoursLines.join("\n")}`
        : "") +
      (specialLines.length ? `\n\nDatas especiais nos próximos 60 dias:\n${specialLines.join("\n")}` : "") +
      (blockedLines.length ? `\n\nDatas com bloqueio de reservas nos próximos 60 dias (agenda indisponível, mas o restaurante pode estar funcionando):\n${blockedLines.join("\n")}` : "") +
      (giftbackLines.length
        ? `\n\nPrograma Giftback (regras automáticas ativas):\n${giftbackLines.join("\n")}`
        : `\n\nPrograma Giftback: esta unidade NÃO tem nenhuma regra automática de promoção, desconto, cupom ou benefício de aniversário ativa no momento. Se o cliente perguntar sobre desconto ou promoção e ele NÃO tiver voucher ativo listado em "O que sabemos sobre este cliente", deixe claro que no momento não há nenhuma promoção ou desconto — NÃO invente percentual, condição nem regra.`) +
      (settingsMap["rules_and_conditions"] ? `\n\nPreços e condições do restaurante (use para responder sobre valores, regras e condições; hoje é ${weekdayName}, respeite preços por dia da semana — ver Regra 11):\n${settingsMap["rules_and_conditions"]}` : "") +
      ((() => {
        const parts: string[] = [];
        const bwd = settingsMap["booking_window_days"];
        if (bwd) parts.push(`- Antecedência máxima para reservar: ${bwd} dias`);
        const dur = settingsMap["reservation_duration_minutes"];
        if (dur) parts.push(`- Duração padrão da reserva: ${dur} minutos`);
        const tol = settingsMap["reservation_tolerance_minutes"];
        if (tol) parts.push(`- Tolerância de atraso: ${tol} minutos`);
        return parts.length ? `\n\nRegras de reserva:\n${parts.join("\n")}` : "";
      })()) +
      (settingsMap["additional_info"] ? `\n\nInformações adicionais:\n${settingsMap["additional_info"]}` : "") +
      (includeFaq && settingsMap["restaurant_menu"] ? `\n\nCardápio (hoje é ${weekdayName}; se houver preços por dia da semana, use só a faixa que inclui ${weekdayName} — ver Regra 11):\n${settingsMap["restaurant_menu"]}` : "") +
      (includeFaq && settingsMap["delivery_response"] ? `\n\nSobre delivery/take-away:\n${settingsMap["delivery_response"]}` : "") +
      (includeFaq && settingsMap["restaurant_extra_info"] ? `\n\nOutras informações:\n${settingsMap["restaurant_extra_info"]}` : "") +
      (prefsLines.length ? `\n\nO que sabemos sobre este cliente:\n${prefsLines.join("\n")}` : "") +
      (settingsMap["ai_context_extra"]
        ? `\n\nObservações sobre a unidade (use para responder dúvidas dos clientes):\n${settingsMap["ai_context_extra"]}`
        : "") +
      (customPrompt ? `\n\nInstruções adicionais: ${customPrompt}` : "");

    // Reserva ATÔMICA antes de iniciar o turno. O passo é onde o teto é
    // aplicado — verificar depois da chamada não é proteção, é detecção.
    const turnId = `${conv.id}:${requestId}`;
    let budgetHooks: AgentBudgetHooks | undefined;

    if (isFranchise) {
      const opened = await openTurnBudget(supabase, {
        organizationId,
        turnId,
        requestId,
        provider: provider_ai,
        model: modelOverride,
      });

      if (opened.kind === "EXHAUSTED") {
        // A franquia esgotou entre a resolução do entitlement e a reserva
        // (turno concorrente liquidou). Mesmo desfecho do hard stop acima.
        await supabase
          .from("conversations")
          .update({
            status: "awaiting_human",
            handoff_reason: AI_BUDGET_HANDOFF_REASON,
            handoff_at: new Date().toISOString(),
            last_silenced_reply_at: null,
          })
          .eq("id", conv.id);
        const reserveNotice = await sendAutomatic(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT);
        if (reserveNotice.ok) {
          await appendToConversation(
            conv.id,
            conv.messages || [],
            "assistant",
            AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
            { author: "automation" },
          );
        }
        jsonLog("warn", {
          requestId,
          evt: "ai_budget_exhausted_on_reserve",
          unitId,
          organizationId,
          convId: conv.id,
        });
        await finish("ai_budget_exhausted");
        await releaseAiLock();
        return new Response("ok");
      }

      if (opened.kind === "READY") {
        turnBudget = opened.budget;
        turnBudgetOrgId = organizationId;
        budgetHooks = makeBudgetHooks(supabase, {
          organizationId,
          unitId,
          conversationId: conv.id,
          requestId,
          turnId,
          budget: opened.budget,
          // O MESMO resolvedor da estimativa da reserva. Sem o repasse, a
          // reserva e o ledger voltam a ter caches independentes e podem falar
          // de vigências de preço diferentes dentro do mesmo turno.
          resolvePrice: opened.resolvePrice,
        });
      } else if (opened.kind === "UNMETERED") {
        // Flag OFF: nenhuma negação comercial acontece. O turno segue SEM
        // medição — o preço de não bloquear, nunca o contrário.
        jsonLog("warn", {
          requestId,
          evt: "ai_budget_observed_only",
          unitId,
          organizationId,
          reason: opened.reason,
        });
      } else {
        // ERROR de infraestrutura. NÃO é franquia esgotada, e a copy tem de
        // dizer outra coisa. Com o gate LIGADO não podemos chamar o LLM sem
        // medir (consumo não contabilizado); com ele desligado, seguimos.
        //
        // `opened.enforced` é o estado do gate no MOMENTO da abertura, e vem no
        // resultado exatamente para não ser relido: reler traria I/O extra e
        // permitiria que a mesma invocação decidisse com dois valores.
        jsonLog("error", {
          requestId,
          evt: "ai_budget_open_error",
          unitId,
          organizationId,
          code: opened.sanitizedCode,
        });
        // PREÇO DESCONHECIDO FALHA FECHADO EM QUALQUER MODO — é a MESMA
        // política do `beforeCall` do adapter, e duas portas para a mesma
        // ignorância não podem ter políticas opostas. Sem preço não há
        // `price_id` (NOT NULL em `ai_usage_events`) e o evento não pode
        // existir: rodar seria consumo real sem nenhum registro possível. Vale
        // inclusive quando o `null` veio de FALHA DE LEITURA da tabela de
        // preços, que é indistinguível de ausência de linha — e é por isso que
        // o gatilho não é hipotético. O modo observação abranda TETO, nunca
        // preço.
        const failClosed = opened.enforced || opened.sanitizedCode === "price_unknown";
        if (failClosed) {
          await supabase
            .from("conversations")
            .update({
              status: "awaiting_human",
              handoff_reason: `ai_budget_error:${opened.sanitizedCode}`,
              handoff_at: new Date().toISOString(),
              last_silenced_reply_at: null,
            })
            .eq("id", conv.id);
          // Texto de instabilidade JÁ EXISTENTE no noise set — não é franquia
          // esgotada e não pode dizer que é.
          const errText = AGENT_INSTABILITY_TEXT;
          const budgetErrorNotice = await sendAutomatic(errText);
          if (budgetErrorNotice.ok) {
            await appendToConversation(conv.id, conv.messages || [], "assistant", errText, { author: "automation" });
          }
          await finish("ai_budget_error", opened.sanitizedCode);
          await releaseAiLock();
          return new Response("ok");
        }
      }
    }

    const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
    let agentError: string | null = null;
    // Quem interrompeu o loop: o prazo ou o provedor. Duas consequências
    // diferentes (motivo do handoff, e o retry silencioso que NÃO pode pegar o
    // prazo), e a pergunta é do OBJETO lançado — nunca do texto sanitizado.
    let agentDeadlineReached = false;
    let finalText = "";

    let mutatingToolUsed = false;
    // Desfecho da ÚLTIMA ferramenta mutante. Na dúvida, UNKNOWN: afirmar
    // conclusão de uma ação que ainda exige validação é o erro que produz
    // cliente aparecendo no restaurante sem mesa (§17.7.4).
    let lastMutationOutcome: MutationOutcome = "UNKNOWN";
    const runOnce = () => runAgentLoop({
        provider: provider_ai,
        apiKey,
        model: modelOverride,
        systemPrompt,
        history,
        userMessage: combinedUserMessage,
        tools: agentTools,
        // AUSENTE fora da franquia: nenhuma autorização, nenhuma apropriação,
        // nenhum custo persistido — o caminho legado inteiro depende disso.
        budget: budgetHooks,
        // Deadline SUAVE: só impede COMEÇAR nova rodada de ferramenta. A
        // política é do núcleo; aqui só se entrega o relógio do PROCESSAMENTO
        // (nunca `t0`, que inclui o que veio antes do claim da conversa).
        //
        // ─── ESCOPADO À FILA, e isso é requisito da fase, não cautela ────────
        //
        // O prazo existe por causa do ORÇAMENTO DE PAREDE da varredura: um evento
        // que roda para sempre derruba o worker e adia o inbound de outros
        // tenants. O caminho SÍNCRONO não tem esse orçamento — e não tem teto
        // nenhum, o que é afirmação medida e não conforto: `AGENT_RETRY_BUDGET_MS`
        // só decide se CABE uma retentativa, nunca interrompe o laço em curso, e o
        // TTL do lock de conversa EXPIRA em vez de parar quem o segura (um irmão
        // assume e roda um segundo agente). O que o torna aceitável é outra coisa:
        // ele é o caminho que atende loja real agora, com os quatro providers
        // legados fora da fila pela capability de reentrega (`unmeasured`), não
        // só por chave desligada, e aplicar o prazo a eles seria mudar o
        // comportamento deles por efeito colateral, que esta
        // fase proíbe explicitamente. Teto de parede no síncrono é decisão própria,
        // com sua própria medição — não carona desta.
        //
        // E a aritmética mostra que não seria inócuo: `AGENT_SOFT_DEADLINE_MS`
        // (30 000) é MENOR que `WORST_SINGLE_TURN_MS` (31 000) do próprio repo,
        // então uma rodada de pior caso consome o orçamento inteiro e a SEGUINTE
        // é sempre recusada. No síncrono isso cortaria conversas de duas rodadas
        // que hoje concluem, e tiraria do ar justamente o empty-retry do Gemini —
        // a causa nº 1 de "não consegui montar uma resposta", que existe para
        // resgatar exatamente esses turnos.
        shouldContinue: ingestionSource === "queue"
          ? () =>
            agentDeadlineVerdict({ startedAt: processingStartedAt, now: Date.now() }) === "continue"
          : undefined,
        onUsage: (u) => {
          totalUsage.input_tokens += u.input_tokens;
          totalUsage.output_tokens += u.output_tokens;
          totalUsage.cache_creation_tokens += u.cache_creation_tokens;
          totalUsage.cache_read_tokens += u.cache_read_tokens;
        },
        // deno-lint-ignore no-explicit-any
        onToolCall: async (name, input: any) => {
          jsonLog("info", { requestId, evt: "tool_call", channelId, unitId, name, input: summarizeToolInput(input) });
          try {
            // deno-lint-ignore no-explicit-any
            let result: any;
            switch (name) {
              case "check_availability":
                result = await checkAvailability(input.date, input.time, input.party_size, unitId!, input.hall_name);
                break;
              case "create_reservation":
                mutatingToolUsed = true; // desliga o retry silencioso (evita reserva duplicada)
                result = await createReservation({ ...input, phone, unit_id: unitId!, organization_id: organizationId });
                // Classificação do desfecho para a copy de §17.7.4. A reserva
                // do agente nasce `confirmed` e é ISENTA de caução — não existe
                // desfecho PENDING neste caminho, e inventar um seria afirmar
                // ao cliente uma espera que não vai acontecer. `success: false`
                // é ignorância sobre o que ficou de pé: UNKNOWN.
                lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
                break;
              case "get_reservation":
                result = await getReservation(input.reservation_code ? input : { ...input, phone }, unitId!);
                break;
              case "update_reservation":
                mutatingToolUsed = true; // desliga o retry silencioso (evita alteração duplicada)
                result = await updateReservation(input);
                lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
                break;
              case "cancel_reservation":
                mutatingToolUsed = true; // desliga o retry silencioso (evita cancelamento duplicado)
                result = await cancelReservation(input.reservation_code);
                lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
                break;
              case "list_customer_reservations":
                result = await listCustomerReservations(customer.id, unitId!);
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
              default:
                result = { error: `Tool desconhecida: ${name}` };
            }
            jsonLog("info", { requestId, evt: "tool_result", channelId, unitId, name, result: summarizeToolResult(result) });
            return JSON.stringify(result);
          } catch (err) {
            jsonLog("error", { requestId, evt: "tool_error", channelId, unitId, name, err: String(err) });
            return JSON.stringify({ error: String(err) });
          }
        },
      });

    // Roda o agente. Em erro transitório (timeout / 5xx / quota momentânea)
    // ANTES de qualquer tool que altere estado, tenta UMA vez mais em silêncio
    // antes de cair pra handoff — desde que ainda dentro do orçamento de tempo.
    // Nunca retenta se uma reserva já foi criada/alterada/cancelada (evita
    // duplicar) nem se o tempo estourar (evita deixar o cliente sem resposta).
    let agentOutcome: AgentLoopResult | null = null;
    // A partir daqui pode haver chamada de LLM e tools mutantes; reentregar o
    // claim inteiro depois de uma exceção já não é comprovadamente seguro.
    externalSideEffectStarted = true;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        agentOutcome = await runOnce();
        agentError = null;
        agentDeadlineReached = false;
        break;
      } catch (err) {
        // A MARCA DO PRAZO É LIDA DO OBJETO, E ANTES DE SANITIZAR.
        // `sanitizeProviderError` devolve `${err.name}: ${err.message}` e ainda
        // passa por redação e `slice(0, 300)`: comparar a string resultante com
        // "agent_deadline" nunca casaria, e casar por `includes` amarraria a
        // decisão à forma de um texto que outra regra pode reescrever.
        agentDeadlineReached = isAgentDeadlineError(err);
        // SANITIZADO, sempre. A chave de IA é per-unit (BYOK) e o erro do
        // provedor pode ecoar o request com o header de autorização — ou a URL
        // do Gemini, que carrega `?key=<chave>` na query string. Este valor é
        // persistido em `webhook_executions.error` e em `processed_messages`.
        agentError = sanitizeProviderError(err);
        jsonLog("error", {
          requestId,
          evt: "agent_loop_error",
          attempt,
          deadline: agentDeadlineReached,
          err: agentError,
        });
        const elapsed = Date.now() - t0;
        // `!agentDeadlineReached` é EXCLUSÃO EXPLÍCITA, e a razão não é o valor
        // das constantes. Sem ela, o `catch` genérico reiniciaria o agente
        // inteiro logo depois de o prazo ter dito para não começar nem mais uma
        // rodada — o deadline anulando a si mesmo no único caso em que importa.
        // Hoje `AGENT_RETRY_BUDGET_MS` e `AGENT_SOFT_DEADLINE_MS` valem os
        // mesmos 30 s, em arquivos diferentes e contados de relógios diferentes
        // (`t0` aqui, `processingStartedAt` lá): coincidência aritmética entre
        // dois números que ninguém declarou gêmeos. Subir o orçamento de retry
        // desligaria o deadline em silêncio.
        if (
          attempt === 0 && !agentDeadlineReached && !mutatingToolUsed
          && elapsed < AGENT_RETRY_BUDGET_MS
        ) {
          jsonLog("warn", { requestId, evt: "agent_retry", elapsed_ms: elapsed });
          continue;
        }
        break;
      }
    }
    finalText = agentOutcome && agentOutcome.kind === "TEXT" ? agentOutcome.text : "";

    const usedModel = modelOverride;
    jsonLog("info", {
      requestId,
      evt: "agent_usage",
      provider: provider_ai,
      model: usedModel,
      channelId,
      unitId,
      ...totalUsage,
      estimated_cost_usd: estimateCostUsd(usedModel, totalUsage),
    });

    // ─── Negação de orçamento durante o turno ────────────────────────────────
    // O efeito de ferramenta mutante já persistido NÃO é descartado, a
    // ferramenta NÃO é repetida, o turno NÃO recebe retry integral, e a
    // resposta é texto DETERMINÍSTICO — gerar com IA a explicação de que a IA
    // foi bloqueada exigiria justamente a chamada que foi negada.
    if (agentOutcome && agentOutcome.kind === "DENIED") {
      const decision = agentOutcome.decision;
      // A pergunta é do núcleo. `ERROR` e `DENY_BUDGET` levam ao mesmo destino
      // operacional e dizem coisas OPOSTAS: só uma significa que a franquia
      // acabou.
      const hardStop = isCommercialHardStop(decision);

      // Razão PRÓPRIA por variante: `ai_budget_exhausted` é a única que
      // significa que a franquia acabou. As demais são fail-closed técnico e
      // não podem afirmar isso nem ao cliente nem ao admin.
      let handoffReason: string;
      if (hardStop) {
        handoffReason = AI_BUDGET_HANDOFF_REASON;
      } else if (decision.kind === "DENY_PRICE_UNKNOWN") {
        handoffReason = `ai_price_unknown:${decision.provider}:${decision.model}`;
      } else if (decision.kind === "DENY_USAGE_UNRESOLVED") {
        handoffReason = "ai_usage_unresolved";
      } else {
        handoffReason = "ai_budget_error";
      }

      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: handoffReason,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // Copy: só o hard stop usa o texto de franquia. As três situações de
      // ferramenta mutante têm textos distintos — usar a mesma frase para as
      // três é o erro que produz cliente aparecendo no restaurante sem mesa.
      let stopText: string;
      if (!hardStop) {
        stopText = AGENT_INSTABILITY_TEXT;
      } else if (mutatingToolUsed) {
        stopText = resolveMutationStopText(lastMutationOutcome);
      } else {
        stopText = AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT;
      }

      const stopNotice = await sendAutomatic(stopText);
      if (stopNotice.ok) {
        await appendToConversation(conv.id, conv.messages || [], "assistant", stopText, { author: "automation" });
      }

      jsonLog("warn", {
        requestId,
        evt: telemetryEventFor(decision),
        unitId,
        organizationId,
        convId: conv.id,
        provider: provider_ai,
        model: agentOutcome.meta.model,
        iteration: agentOutcome.meta.iteration,
        mutating_tool_used: mutatingToolUsed,
      });

      // DINHEIRO ANTES DE TELEMETRIA, nos seis desfechos. `finish` carimba
      // `processed_messages` como concluída, e a partir daí a reentrega do
      // provedor é DEDUPLICADA: se o isolate morrer entre o `finish` e a
      // liquidação, o custo real nunca vira `settled_cents` e some do teto para
      // sempre. Na ordem certa, a mesma morte custa só o registro — que é
      // telemetria, e reconstituível. `settleTurnBudget` não lança (engole o
      // erro da RPC e volta), então não há registro em risco aqui.
      // O turno terminou onde pretendia terminar: `SETTLED`.
      await settleTurnBudget("SETTLED");
      await finish(hardStop ? "ai_budget_exhausted" : "ai_budget_denied", undefined, {
        decision: decision.kind,
        provider: provider_ai,
        model: agentOutcome.meta.model,
      });
      await releaseAiLock();
      return new Response("ok");
    }

    if (agentError) {
      // Agente falhou (timeout, modelo descontinuado, 4xx do provider, tool error
      // não tratado, etc). Em vez de só pedir pro cliente repetir — o que não
      // resolve quando o erro é estrutural —, fazemos auto-handoff: marca a
      // conversa awaiting_human pra atendente assumir, registra provider/model
      // no handoff_reason e em webhook_executions.meta, e avisa o cliente.
      const usedModel = modelOverride;

      // O motivo distingue PRAZO de erro do provedor, e isso não é cosmética: é
      // o campo que se lê ao investigar "por que esta conversa foi para
      // atendimento humano". Um turno interrompido pelo deadline não é
      // instabilidade do provedor, e chamá-lo de `agent_error` mandaria quem
      // investiga procurar defeito onde não há.
      //
      // O NOME é próprio (`agentHandoffReason`, não `handoffReason`): o
      // guardrail que confere que cada porta de handoff manda a conversa para a
      // fila do operador ancora cada porta pelo texto da razão, e duas portas
      // com o mesmo identificador colapsam numa só aos olhos dele.
      const agentHandoffReason = agentDeadlineReached
        ? `agent_deadline:${provider_ai}:${usedModel}`
        : `agent_error:${provider_ai}:${usedModel}`;

      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: agentHandoffReason,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // COPY: mesma disciplina do hard stop de franquia 70 linhas acima, e aqui
      // ela é MODAL e não excepcional. A forma do defeito: a rodada 2 executa
      // `create_reservation`, a rodada 3 — a que CONFIRMA ao cliente — é recusada
      // pelo prazo, e a reserva fica `confirmed` no banco enquanto o cliente é
      // informado de instabilidade técnica. Ele não aparece (mesa segurada vazia)
      // ou aparece achando que não tem reserva. É literalmente o caso que
      // `ai-budget-copy.ts` nomeia: "usar a mesma frase para as três é o erro que
      // produz cliente aparecendo no restaurante sem mesa".
      //
      // Escopado a `agentDeadlineReached` de propósito. O ramo de `agent_error`
      // após ferramenta mutante tem o MESMO problema e é PREEXISTENTE — mudá-lo
      // aqui alteraria, de carona, a mensagem que a loja real já manda hoje.
      // Registrado para a revisão de branch decidir, não resolvido por efeito
      // colateral.
      //
      // TRÊS pernas, e a terceira não é simetria: sem ela o prazo SEM ferramenta
      // mutante — tão frequente quanto o caso acima — afirma "instabilidade"
      // sobre uma parada PLANEJADA, que é a outra regra que `ai-budget-copy.ts`
      // escreve no próprio cabeçalho ("não pode afirmar falha técnica: não houve
      // falha nenhuma"). O texto reusado é o do hard stop sem mutação porque, do
      // lado do CLIENTE, a situação é a mesma: nada foi alterado, a mensagem
      // ficou registrada e uma pessoa assume. Reusar em vez de redigitar é o que
      // mantém uma frase por situação — e o que garante que ela já está no
      // `HARDCODED_AGENT_NOISE`, pela lista importada.
      let handoffText: string;
      if (!agentDeadlineReached) {
        handoffText = AGENT_INSTABILITY_TEXT;
      } else if (mutatingToolUsed) {
        handoffText = resolveMutationStopText(lastMutationOutcome);
      } else {
        handoffText = AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT;
      }
      const errorNotice = await sendAutomatic(handoffText);
      if (errorNotice.ok) {
        await appendToConversation(
          conv.id,
          [...(conv.messages || []), { role: "user", content: incomingText }],
          "assistant",
          handoffText,
          { author: "automation" },
        );
      }

      jsonLog("warn", {
        requestId,
        evt: "agent_error_handoff",
        provider: provider_ai,
        model: usedModel,
        deadline: agentDeadlineReached,
        err: agentError,
      });
      // Turno INTERROMPIDO (pelo provedor ou pelo prazo): o consumido migra
      // para o liquidado e a diferença volta ao disponível. Antes do `finish` —
      // ver o desfecho de negação acima.
      await settleTurnBudget("RELEASED");
      await finish("agent_error", agentError, {
        provider: provider_ai,
        model: usedModel,
        channel_id: channelId,
        // O outcome continua `agent_error` de propósito: o vocabulário de
        // `webhook_executions.outcome` é consumido por painel e diagnóstico, e
        // trocá-lo é mudança de contrato que esta task não pede. A distinção
        // viaja no `meta` e no `handoff_reason`.
        deadline: agentDeadlineReached,
      });
      await releaseAiLock();
      return new Response("ok");
    }

    if (!finalText || !finalText.trim()) {
      // Modelo não devolveu texto algum — ainda assim respondemos pra não
      // deixar o cliente no escuro.
      jsonLog("warn", { requestId, evt: "agent_empty_response", channelId, unitId });

      const emptyText = "Desculpa, não consegui montar uma resposta agora. Pode reformular ou aguardar um instante?";
      const emptyNotice = await sendAutomatic(emptyText);
      if (emptyNotice.ok) {
        await appendToConversation(conv.id, conv.messages || [], "assistant", emptyText, { author: "automation" });
      }
      // Mesma razão do ramo de erro: turno interrompido sem produzir resposta.
      await settleTurnBudget("RELEASED");
      await finish("empty_response");
      await releaseAiLock();
      return new Response("ok");
    }

    // Sanitiza markdown padrão de LLM (**bold**, # header, `code`, listas com
    // "* ", links [text](url)) pro formato WhatsApp (*bold*, "- " em lista).
    // Rede defensiva — o system prompt já instrui, mas modelos divergem.
    // A versão sanitizada é o que vai pro cliente E o que fica no log da
    // conversa operacional (operador vê o mesmo que cliente recebeu).
    const finalTextForWhatsApp = sanitizeForWhatsApp(finalText);

    const sendRes = await sendAutomatic(finalTextForWhatsApp);

    if (sendRes.error === "suppressed_by_human") {
      await settleTurnBudget("SETTLED");
      await finish("ai_reply_suppressed_by_human");
      await releaseAiLock();
      return new Response("ok");
    }

    if (!sendRes.ok) {
      // O TURNO DE IA ACONTECEU: o que falhou foi a entrega ao WhatsApp. O
      // custo é real e já está em `ai_usage_events`; sem liquidar aqui ele
      // jamais contaria contra o teto — a varredura de expiradas devolve a
      // reserva sem incrementar `settled_cents`.
      await settleTurnBudget("SETTLED");
      await finish("send_error", sendRes.error ?? `status_${sendRes.status}`, {
        missingCreds: sendRes.missingCreds,
        bodySnippet: sendRes.bodySnippet,
      });
      await releaseAiLock();
      return new Response("ok");
    }

    const finalHistoryAppend = await appendToConversation(
      conv.id,
      [...(conv.messages || []), { role: "user", content: incomingText }],
      "assistant",
      finalTextForWhatsApp,
      { author: "ai" },
    );

    // Fim do turno: liquida o custo real e devolve a diferença ao disponível.
    // Os marcos (70/80/90/100%) saem daqui porque é aqui que o liquidado do
    // ciclo muda. Antes do `finish` — ver o desfecho de negação acima.
    await settleTurnBudget("SETTLED");
    await finish(
      finalHistoryAppend.persisted ? "success" : "success_history_degraded",
      finalHistoryAppend.persisted ? undefined : "conversation_message_persist_failed_after_send",
      { tokens: totalUsage.input_tokens + totalUsage.output_tokens },
    );
    await releaseAiLock();
    return new Response("ok");
  } catch (err) {
    // A reserva TAMBÉM é liquidada aqui — este é um desfecho do turno como
    // qualquer outro. Liquidar não inventa custo: `finalize_ai_reservation` só
    // apropria `consumed_cents`, que é escrito exclusivamente por
    // `record_ai_call_usage` para chamadas que OCORRERAM. Não liquidar é que
    // apagaria custo real, porque a varredura de expiradas marca `EXPIRED` e
    // devolve `released_cents` SEM tocar em `settled_cents` (migration 102).
    // `RELEASED` porque o turno foi interrompido; e é no-op quando não houve
    // reserva. Fica dentro do try interno pelo mesmo motivo do lock: nada aqui
    // pode transformar um erro em outro erro.
    // SANITIZADO como todo caminho de erro do agente. O laço já sanitiza o que
    // vem do provedor, então este `catch` externo é defesa em profundidade — mas
    // ele é o ÚNICO que captura o que escapar de fora do laço, e o que ele
    // registra vai para `webhook_executions.error` e para `processed_messages`,
    // onde uma URL do Gemini com `?key=<chave>` ficaria persistida.
    jsonLog("error", { requestId, evt: "webhook_error", err: sanitizeProviderError(err) });
    try {
      // Antes de qualquer side effect externo (WhatsApp/LLM/tool), toda falha
      // é reentregável. O claim cercado volta à fila; event_ids do provider
      // tornam customer/conversa/append idempotentes.
      if (
        !externalSideEffectStarted
        && messageIdForOutcome
        && messageProvider
        && messageProcessingClaimId
      ) {
        const { data: released, error: releaseError } = await supabase.rpc(
          "release_processed_whatsapp_message_claim",
          {
            p_provider: messageProvider,
            p_message_id: messageIdForOutcome,
            p_claim_id: messageProcessingClaimId,
          },
        );
        if (releaseError || released !== true) throw new Error("processed_message_claim_release_failed");
        messageProcessingClaimId = null;
      }
      // PRIMEIRO de todos, aqui: antes do `finish` pela mesma razão dos outros
      // cinco desfechos, e antes do `releaseAiLock` porque soltar o lock com a
      // reserva ainda `HELD` deixa uma inbound irmã abrir orçamento novo contra
      // capacidade que ainda está comprometida. É também a SEGUNDA tentativa de
      // liquidação quando a primeira não aplicou — o estado local só é zerado
      // no sucesso.
      await settleTurnBudget("RELEASED");
      await releaseAiLock();
      await finish("webhook_error", sanitizeProviderError(err));
    } catch {
      // ignore — TTL de 90s libera o lock
    }
    return new Response("error", { status: 500 });
  }
}

// A porta pública entra SEMPRE com o default `{}`: nenhum chamador externo
// consegue afirmar "assinatura já validada" nem "vim da fila".
serve((req) => handleWebhookRequest(req));
