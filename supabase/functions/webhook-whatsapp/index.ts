import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { admitAutomationReceipts } from "../_shared/whatsapp-automation-receipts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sanitizeProviderError } from "../_shared/ai-providers.ts";
// ─── Núcleo do agente de IA ─────────────────────────────────────────────────
// Turno, prompt e ferramentas são independentes de canal (`_shared/agent/`).
// Este adapter entra com o `ChannelContext` do WhatsApp: envio pelo provider,
// `sanitizeForWhatsApp`, identidade e formatação do prompt, origem da reserva.
import { createAgentTurn } from "../_shared/agent/turn.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
// ─── Ingestão assíncrona (Fase C) ────────────────────────────────────────────
// Adapter de I/O; NENHUMA decisão desta fase é redigitada aqui. `vitest` não
// importa este arquivo (`serve()` no carregamento + imports de `deno.land`),
// então regra escrita aqui só se confere por leitura — e leitura já deixou
// passar defeito duas vezes neste repo.
import {
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
import { resolveOrCreateCustomer } from "../_shared/resolve-customer.ts";
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

/**
 * Bloco de formatação do prompt para o WhatsApp. O núcleo o anexa depois das
 * regras de reserva; `sanitizeForWhatsApp` é a rede defensiva da saída.
 */
const WHATSAPP_FORMATTING_RULES =
  `FORMATAÇÃO DA RESPOSTA NO WHATSAPP:\n` +
  `- Negrito é *um único asterisco* (ex: *importante*). NUNCA use **dois asteriscos**, ### header ou markdown — WhatsApp mostra os símbolos literais.\n` +
  `- Itálico com _texto_ entre underlines. Tachado com ~texto~.\n` +
  `- Listas SEMPRE com "- " (hífen + espaço) no começo da linha, uma por linha. NUNCA use "* " — o asterisco solto aparece literal pro cliente.\n` +
  `- Separe blocos lógicos (preços, horários, opções, observação) com UMA linha em branco. Frases e parágrafos curtos — o cliente está lendo no celular.\n` +
  `- Não use tabelas, blocos de código com \`\`\`, nem links no formato [texto](url) — WhatsApp não interpreta. Cole a URL direto.\n` +
  `- Emojis: máximo 1 ou 2 por mensagem, só quando agregam contexto. Sugestões: 📅 data, 🕐 horário, 📍 endereço, 🍽️ cardápio, ✅ confirmação, ❌ cancelamento, 🙏 agradecimento. Não exagere — mensagem cheia de emoji parece spam.`;

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

// ─── Telemetry helpers (idempotência + webhook_executions) ────────────────────

const STUCK_PROCESSING_TIMEOUT_MS = 90_000;

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

  // Turno do agente desta invocação. O estado do lock e da reserva de
  // orçamento vive dentro dele, e `settleTurnBudget`/`releaseAiLock` ficam
  // visíveis aqui porque o catch externo é irmão do try e precisa liquidar
  // e soltar o lock — nessa ordem — quando algo explode.
  const agentTurn = createAgentTurn({
    supabase,
    requestId,
    requestStartedAt: t0,
    ingestionSource,
    finish,
    appendToConversation,
    markExternalSideEffect: () => {
      externalSideEffectStarted = true;
    },
  });
  const { settleTurnBudget, releaseAiLock } = agentTurn;

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

    // Do status da conversa até a resposta (handoff, debounce, lock, franquia,
    // prompt, laço e desfechos): núcleo em `_shared/agent/turn.ts`. Toda saída
    // dele já registrou o próprio desfecho via `finish`.
    await agentTurn.run(
      {
        channel: "whatsapp",
        unitId,
        organizationId,
        unit: {
          row: unitRow ?? null,
          name: unitName,
          slug: unitSlug,
          address: unitAddress,
          ticketMax: unitTicketMax,
        },
        conversation: conv,
        customer,
        phone,
        identityLine: `O número de WhatsApp do cliente é ${phone}.`,
        formattingRules: WHATSAPP_FORMATTING_RULES,
        // Só a saída do LLM passa por aqui — nunca texto determinístico.
        sanitize: sanitizeForWhatsApp,
        // Envio cru do provider; o núcleo o chama atrás da cerca de handoff.
        send: (text) => sendOutbound(provider, credentials, { toPhone: phone, text }),
        // Load-bearing: o trigger de confirmação pula a origem `whatsapp`.
        reservationSource: "whatsapp",
        appBaseUrl: () => Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br",
        channelId,
      },
      {
        text: incomingText,
        timestamp: inbound.timestamp,
        receivedAt: inboundReceivedAt,
        eventId: `wa-in:${provider}:${inbound.providerMessageId}`,
      },
    );
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
      // PRIMEIRO de todos, aqui: antes do `finish` pela mesma razão dos outros
      // cinco desfechos, e antes do `releaseAiLock` porque soltar o lock com a
      // reserva ainda `HELD` deixa uma inbound irmã abrir orçamento novo contra
      // capacidade que ainda está comprometida. É também a SEGUNDA tentativa de
      // liquidação quando a primeira não aplicou — o estado local só é zerado
      // no sucesso.
      // Os dois vêm antes de devolver o claim da mensagem: o `throw` daquela
      // RPC (o mesmo soluço de banco que costuma causar o erro) não pode pular
      // a liquidação nem deixar o lock órfão até o TTL — a reentrega cairia em
      // `conversation_locked` e o cliente ficaria sem resposta.
      await settleTurnBudget("RELEASED");
      await releaseAiLock();
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
