import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getWhatsAppProvider,
  tryGetWhatsAppProvider,
  listWhatsAppProviderMetadata,
  type WhatsAppProvider,
  type ChannelCredentials,
  type ProviderConnectionSnapshot,
} from "../_shared/whatsapp-providers.ts";
import { parseDatafyAccount } from "../_shared/datafy-client.ts";
import { getDatafyAccountToken } from "../_shared/datafy-account-config.ts";
import { createDatafyOnboardingActions, DATAFY_ACTIONS } from "../_shared/datafy-onboarding-actions.ts";
import { resolveUnitChannelBinding } from "../_shared/whatsapp-org-provider-core.ts";
import { createTemplateRuntime } from "../_shared/whatsapp-template-runtime.ts";
import {
  decideDatafyChannelSetup,
  decideDatafySecretRotation,
  readManualCredentialField,
  type DatafyChannelSetupRefusal,
} from "../_shared/datafy-channel-setup-core.ts";
import { shapeOf } from "../_shared/webhook-payload-shape-core.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  resolveWhatsAppGateByUnit,
  clearWhatsAppGateCache,
  type WhatsAppServiceState,
} from "../_shared/whatsapp-service-gate.ts";
import {
  checkConnectionAllowance,
  type ConnectionAllowance,
  type ConnectionFundingSource,
  type ConnectionOperation,
} from "../_shared/whatsapp-connection-allowance-core.ts";
import {
  resolveWhatsAppSubscription,
  type WhatsAppSubscriptionFact,
} from "../_shared/whatsapp-subscription-resolver-core.ts";
import {
  UazApiError,
  type UazInstanceSnapshot,
} from "../_shared/uazapi-client.ts";
import { resolveChannelCredentials } from "../_shared/whatsapp-channel-credentials.ts";
import {
  normalizeUazConnectionStatus,
  shouldActivateConnectedChannel,
  type WhatsAppChannelStatus,
} from "../_shared/whatsapp-channel-lifecycle-core.ts";
import { assertProvisioningAllowed } from "../_shared/whatsapp-instance-core.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const { refreshTemplateChannel } = createTemplateRuntime(supabase);

function jsonResponse(req: Request, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json", ...headers },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

const CLIENT_LIFECYCLE_ACTIONS = new Set([
  "list_client",
  "connect",
  "refresh_qr",
  "status",
  "disconnect",
  "restart",
  "official_connection_state",
  "official_connect_start",
  "official_connect_confirm",
]);

const MANUAL_STATUS_REFRESH_INTERVAL_MS = 30_000;
const HEALTH_CHECK_IN_PROGRESS = "HEALTH_CHECK_IN_PROGRESS";

interface ChannelRow {
  id: string;
  unit_id: string;
  provider: WhatsAppProvider;
  status: string;
  credentials: ChannelCredentials | null;
  webhook_secret: string | null;
  display_phone: string | null;
  is_active: boolean | null;
  instance_token_secret_id: string | null;
  external_instance_id: string | null;
  activation_requested_at: string | null;
  connected_at: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
  provisioning_create_attempted_at: string | null;
  manual_echo_verified_at: string | null;
  manual_echo_verification_source: "provider_callback" | "managed_configuration" | null;
}

type ClientChannelRow = ChannelRow & { created_at?: string };

const CLIENT_CHANNEL_COLUMNS = "id, unit_id, provider, status, credentials, webhook_secret, display_phone, is_active, instance_token_secret_id, external_instance_id, activation_requested_at, connected_at, last_health_check_at, last_error, provisioning_create_attempted_at, manual_echo_verified_at, manual_echo_verification_source, created_at";

function selectClientChannel(rows: readonly ClientChannelRow[]): ClientChannelRow | null {
  return rows.find((row) => row.is_active === true)
    ?? rows.find((row) => row.is_active === null && row.status === "connected")
    ?? rows.find((row) => row.provider === "uazapi")
    ?? rows.find((row) => row.is_active === null)
    ?? null;
}

function hasValidActivationRequest(channel: ChannelRow): boolean {
  return !!channel.activation_requested_at
    && Number.isFinite(Date.parse(channel.activation_requested_at));
}

async function loadClientChannels(unitId: string): Promise<ClientChannelRow[]> {
  const { data, error } = await supabase
    .from("whatsapp_channels")
    .select(CLIENT_CHANNEL_COLUMNS)
    .eq("unit_id", unitId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new ChannelActionError(500, "CHANNEL_LIST_FAILED", "Falha ao consultar a conexão.");
  }
  return (data ?? []) as ClientChannelRow[];
}

function generateWebhookSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function webhookUrlFor(channelId: string, secret?: string | null): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const projectRef = supabaseUrl.match(/^https:\/\/([^.]+)\./)?.[1];
  if (!projectRef) throw new Error("supabase_project_ref_unavailable");
  const url = new URL(`https://${projectRef}.supabase.co/functions/v1/webhook-whatsapp`);
  url.searchParams.set("channel", channelId);
  if (secret) url.searchParams.set("secret", secret);
  return url.toString();
}

function displayPhoneFromSnapshot(snapshot: UazInstanceSnapshot): string | null {
  const digits = (snapshot.jid ?? "").split("@")[0].replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function clientConnection(
  channel: Partial<ChannelRow> | null,
  snapshot?: UazInstanceSnapshot,
  providerOverride?: string,
  qrCode?: string | null,
) {
  const provider = channel?.provider ? String(channel.provider) : providerOverride;
  const adapter = provider ? tryGetWhatsAppProvider(provider) : null;
  const lifecycleAvailable = !!adapter
    && adapter.capabilities.automaticProvisioning
    && adapter.capabilities.qrConnection;
  const qrBlockedByProviderState = ["PASSKEY_REQUIRED", "PASSKEY_CONFIRMATION_REQUIRED"]
    .includes(String(channel?.last_error ?? "").toUpperCase());
  return {
    channel_id: channel?.id ?? null,
    status: snapshot
      ? normalizeUazConnectionStatus(snapshot)
      : channel?.status ?? "not_configured",
    display_phone: snapshot ? displayPhoneFromSnapshot(snapshot) : channel?.display_phone ?? null,
    connected_at: channel?.connected_at ?? null,
    last_health_check_at: channel?.last_health_check_at ?? null,
    qr_code: qrCode === undefined ? snapshot?.qrCode ?? null : qrCode,
    lifecycle_available: lifecycleAvailable,
    qr_available: provider && !qrBlockedByProviderState
      ? supportsClientQr(provider, channel?.credentials ?? null)
      : false,
    restart_available: adapter?.capabilities.restart === true && !!adapter.lifecycle,
    disconnect_available: adapter?.capabilities.disconnect === true && !!adapter.lifecycle,
  };
}

function supportsClientLifecycle(provider: string): boolean {
  const adapter = tryGetWhatsAppProvider(provider);
  return !!adapter
    && adapter.capabilities.automaticProvisioning
    && adapter.capabilities.qrConnection;
}

function managedLifecycle(provider: WhatsAppProvider) {
  const lifecycle = getWhatsAppProvider(provider).lifecycle;
  if (!lifecycle) {
    throw new ChannelActionError(
      409,
      "MANUAL_PROVIDER_LIFECYCLE",
      "Esta conexão é administrada pelo suporte.",
    );
  }
  return lifecycle;
}

async function memberLifecycleRole(userId: string, unitId: string): Promise<"owner" | "gerente" | null> {
  const { data, error } = await supabase
    .from("unit_members")
    .select("role")
    .eq("user_id", userId)
    .eq("unit_id", unitId)
    .in("role", ["owner", "gerente"])
    .maybeSingle();
  if (error) return null;
  return data?.role === "owner" || data?.role === "gerente" ? data.role : null;
}

async function loadChannel(unitId: string, channelId: string): Promise<ChannelRow | null> {
  const { data, error } = await supabase
    .from("whatsapp_channels")
    .select(CLIENT_CHANNEL_COLUMNS)
    .eq("id", channelId)
    .eq("unit_id", unitId)
    .maybeSingle();
  if (error) {
    throw new ChannelActionError(500, "CHANNEL_READ_FAILED", "Falha ao consultar a conexão.");
  }
  return data as ChannelRow | null;
}

async function findUazChannel(unitId: string): Promise<ChannelRow | null> {
  const { data } = await supabase
    .from("whatsapp_channels")
    .select(CLIENT_CHANNEL_COLUMNS)
    .eq("unit_id", unitId)
    .eq("provider", "uazapi")
    .maybeSingle();
  return data as ChannelRow | null;
}

async function createUazPlaceholder(unitId: string): Promise<ChannelRow> {
  const { data, error } = await supabase
    .from("whatsapp_channels")
    .insert({
      unit_id: unitId,
      provider: "uazapi",
      credentials: {},
      webhook_secret: generateWebhookSecret(),
      status: "not_configured",
      is_active: false,
    })
    .select(CLIENT_CHANNEL_COLUMNS)
    .single();
  if (error?.code === "23505") {
    const concurrent = await findUazChannel(unitId);
    if (concurrent) return concurrent;
  }
  if (error || !data) throw new Error("uazapi_channel_create_failed");
  return data as ChannelRow;
}

/**
 * Mensagem por estado. Textos DIFERENTES de propósito: "regularize a
 * mensalidade" e "contrate a automação" pedem ações opostas, e um texto
 * genérico faria o cliente tentar a errada.
 */
const NEW_PROVISIONING_MESSAGE: Record<WhatsAppServiceState, string> = {
  GRACE_PERIOD:
    "Há uma mensalidade da automação em aberto. Regularize em Cobrança para adicionar um novo número.",
  LEGACY_GRANDFATHERED:
    "Sua unidade usa a automação de WhatsApp em condição anterior à cobrança. Adicionar um novo número exige contratar a mensalidade da instância.",
  NOT_ENTITLED:
    "A automação de WhatsApp não está contratada para esta organização. Contrate em Cobrança para configurar o canal.",
  SUSPENDED_UNPAID:
    "Automação de WhatsApp suspensa por falta de pagamento. Regularize em Cobrança.",
  ADMIN_BLOCKED:
    "Automação de WhatsApp bloqueada administrativamente. Fale com o suporte.",
  ACTIVE: "Não foi possível criar o canal.",
  OVERRIDE_ACTIVE: "Não foi possível criar o canal.",
};

/**
 * Estado indeterminado ≠ sem direito. Dizer "você não contratou" a quem só
 * sofreu um soluço de leitura manda o cliente comprar o que já tem.
 */
const PROVISIONING_UNVERIFIABLE =
  "Não foi possível verificar o direito de uso da automação de WhatsApp agora. Tente novamente em alguns minutos.";

/**
 * Mensagem por motivo de recusa do allowance. Cliente-facing: nenhum número de
 * custo, de preço ou de margem — o lojista não vê o que a plataforma paga.
 *
 * `Record` exaustivo de propósito — motivo novo no núcleo cobra a mensagem.
 */
const ALLOWANCE_DENIED_MESSAGE: Record<
  Extract<ConnectionAllowance, { allowed: false }>["reasonCode"],
  string
> = {
  CONNECTION_LIMIT_REACHED:
    "Seu plano já usa todas as conexões de WhatsApp incluídas. Fale com o suporte para ampliar.",
  ALLOWANCE_UNKNOWN:
    "Não foi possível confirmar quantas conexões de WhatsApp o seu plano inclui. Fale com o suporte.",
  SUBSCRIPTION_AMBIGUOUS:
    "Há mais de um contrato de automação de WhatsApp em aberto para esta organização. Fale com o suporte antes de adicionar um número.",
  BACKFILL_WITHOUT_PROVIDER_REF:
    "Informe as credenciais completas da conexão já criada no provedor para configurar o canal.",
  OVERRIDE_REQUIRES_ADMIN_DECISION:
    "A automação desta organização é uma cortesia. Adicionar um número exige uma decisão administrativa.",
  NO_FUNDING_SOURCE:
    "A automação de WhatsApp não está contratada para esta organização. Contrate em Cobrança para configurar o canal.",
};

/**
 * Mensagens PT-BR curtas para o cliente — nunca `error.message` cru do
 * Postgres/HTTP. Servem tanto a criação quanto a rotação de secret: as duas
 * ações usam o mesmo vocabulário de recusa do núcleo `datafy-channel-setup-core`.
 */
const DATAFY_SETUP_MESSAGE: Record<DatafyChannelSetupRefusal, string> = {
  missing_token: "Informe o token da Datafy (começa com sk_live_).",
  missing_webhook_secret:
    "Informe o segredo do webhook da Datafy (começa com whsec_). Ele aparece na aba Webhooks do número, no painel da Datafy.",
  discovery_failed:
    "Não foi possível validar o token na Datafy. Confira se ele está correto e se a assinatura está ativa.",
  discovery_unrecognized:
    "O token foi aceito pela Datafy, mas a resposta não tem o formato esperado. Acione o suporte.",
};

/**
 * Linha crua de `billing_subscriptions` com o plano embutido — relação aninhada
 * volta do PostgREST como objeto OU array, mesmo padrão de
 * `whatsapp-service-gate.ts` e `entitlements.ts`.
 */
interface SubscriptionPlanRef {
  category: string | null;
  included_features: string[] | null;
  included_whatsapp_connections: number | null;
}

interface SubscriptionAllowanceRow {
  id: string;
  status: string;
  canceled_at: string | null;
  suspended_at: string | null;
  billing_plans: SubscriptionPlanRef | SubscriptionPlanRef[] | null;
}

type AllowanceCheck =
  | { ok: true; allowance: ConnectionAllowance }
  | { ok: false; reason: "READ_FAILED" | "AMBIGUOUS" };

/**
 * A conexão já existe no PROVEDOR quando o canal é configurado: esta EF nunca
 * cria instância na Z-API, no WAHA ou na Meta — ela recebe as credenciais de
 * algo que já foi criado lá. Por isso a operação é `BACKFILL_EXISTING`, e a
 * evidência disso é o identificador do lado do provedor dentro das credenciais.
 *
 * Sem esse identificador não há como afirmar que a conexão existe, e "backfill"
 * vira provisionamento novo por outra porta — que o núcleo recusa.
 */
function providerConnectionRefKnown(
  provider: WhatsAppProvider,
  creds: ChannelCredentials,
): boolean {
  const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (provider === "zapi") return filled(creds.instance_id);
  if (provider === "uazapi") return filled(creds.instance_id);
  if (provider === "waha") return filled(creds.base_url);
  // Datafy: a evidência de que a conta já existe no provedor é o token — o
  // `phone_number_id` só existe depois da descoberta por `/me`, que roda DEPOIS
  // desta guarda no fluxo de `create`. Cair no ramo `official` (que exige
  // `phone_number_id` já preenchido) recusaria 100% das criações Datafy com
  // BACKFILL_WITHOUT_PROVIDER_REF antes mesmo de tentar descobrir a conta.
  if (provider === "datafy") return filled(creds.access_token);
  return filled(creds.phone_number_id); // official (Meta)
}

/**
 * O canal desta unidade cabe no contrato da ORGANIZAÇÃO?
 *
 * Guarda SEPARADA de `resolveProvisioningEligibility` (o gate de sete estados,
 * logo acima na action `create`) e composta com ela, nunca em substituição: o
 * gate responde "o serviço está ativo?", esta responde "o contrato inclui mais
 * uma conexão?". Verificar só uma deixa a outra porta aberta — o inventário é
 * onde o custo entra, o canal é onde o envio se habilita.
 *
 * O limite é por ORGANIZAÇÃO, não por unidade: dois canais em duas unidades da
 * mesma rede são duas conexões. Por isso a contagem é de `whatsapp_instances`
 * da organização, e por isso esta guarda roda mesmo quando a unidade já tem
 * canal (o gate acima só roda no primeiro canal da unidade).
 *
 * AMBIGUIDADE COMERCIAL NÃO É AUSÊNCIA DE CONTRATO — sai como desfecho próprio
 * em vez de virar `fundingSource: "NONE"`, que negaria com o motivo errado.
 * Mesmo tratamento de `process-whatsapp-instance-cycles`.
 */
async function checkChannelConnectionAllowance(
  unitId: string,
  provider: WhatsAppProvider,
  credentials: ChannelCredentials,
  operation: ConnectionOperation = "BACKFILL_EXISTING",
  adminDecisionRecorded = false,
  replacementConnectionRecorded = false,
): Promise<AllowanceCheck> {
  const { data: unit, error: unitErr } = await supabase
    .from("units")
    .select("organization_id")
    .eq("id", unitId)
    .maybeSingle();

  if (unitErr || !unit?.organization_id) {
    console.error("manage-channels:allowance unit lookup", unitErr ?? "unit_not_found");
    return { ok: false, reason: "READ_FAILED" };
  }
  const organizationId = unit.organization_id as string;

  const [countRes, subRes, overrideRes] = await Promise.all([
    // `lifecycle_state <> 'ENDED'`: instância em CANCELLATION_REQUESTED ainda
    // custa até a confirmação de encerramento.
    supabase
      .from("whatsapp_instances")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .neq("lifecycle_state", "ENDED"),
    // TODAS as candidatas, sem filtro de categoria e sem `.maybeSingle()` —
    // mesma forma da query do gate. Qual delas financia o WhatsApp é decisão do
    // núcleo puro compartilhado, não desta camada.
    supabase
      .from("billing_subscriptions")
      .select(
        "id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features, included_whatsapp_connections)",
      )
      .eq("organization_id", organizationId)
      .neq("status", "canceled"),
    supabase
      .from("organization_entitlement_overrides")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("feature", "whatsapp")
      .eq("grant_type", "LIFETIME")
      .eq("enabled", true)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle(),
  ]);

  // FALHA em vez de degradar: `count ?? 0` viraria "zero conexões" e liberaria
  // exatamente o canal que o teto existe para barrar.
  if (countRes.error || subRes.error || overrideRes.error) {
    console.error(
      "manage-channels:allowance read",
      countRes.error ?? subRes.error ?? overrideRes.error,
    );
    return { ok: false, reason: "READ_FAILED" };
  }

  // Correlação de volta por CHAVE, nunca por posição: o PostgREST não garante
  // ordem sem ORDER BY, e um índice de array casaria o teto de conexões de um
  // plano com a assinatura de outro sem que nada reclamasse.
  const planBySubscriptionId = new Map<string, SubscriptionPlanRef>();
  const facts: WhatsAppSubscriptionFact[] = (
    (subRes.data ?? []) as unknown as SubscriptionAllowanceRow[]
  ).map((row) => {
    const plan = Array.isArray(row.billing_plans) ? row.billing_plans[0] : row.billing_plans;
    if (plan) planBySubscriptionId.set(row.id, plan);
    return {
      id: row.id,
      status: row.status,
      category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
      includedFeatures: plan?.included_features ?? [],
      canceledAt: row.canceled_at,
      suspendedAt: row.suspended_at,
    };
  });

  const resolution = resolveWhatsAppSubscription({ subscriptions: facts });

  if (resolution.kind === "AMBIGUOUS") {
    console.warn(
      "manage-channels:allowance ambiguous subscription",
      JSON.stringify({
        organizationId,
        reason: resolution.reasonCode,
        candidates: resolution.candidateIds.length,
      }),
    );
    return { ok: false, reason: "AMBIGUOUS" };
  }

  let fundingSource: ConnectionFundingSource;
  let includedConnections: number | null = null;
  let provisioningAmbiguous = false;

  if (resolution.kind === "RESOLVED") {
    const plan = planBySubscriptionId.get(resolution.subscriptionId);
    // `!inner` garante o plano; sem ele a correlação não fechou, e seguir com
    // `null` afirmaria "plano sem teto declarado" sobre uma assinatura que o
    // resolvedor acabou de escolher.
    if (!plan) {
      console.error(
        "manage-channels:allowance plan not correlated",
        JSON.stringify({ organizationId, subscriptionId: resolution.subscriptionId }),
      );
      return { ok: false, reason: "READ_FAILED" };
    }
    fundingSource = resolution.source;
    includedConnections =
      typeof plan.included_whatsapp_connections === "number"
        ? plan.included_whatsapp_connections
        : null;
    provisioningAmbiguous = resolution.provisioningAmbiguous;
  } else {
    // Sem assinatura nenhuma: só a cortesia vitalícia financia — é o caso do
    // único cliente ativo, que não pode perder o canal que já usa.
    fundingSource = overrideRes.data ? "LIFETIME_OVERRIDE" : "NONE";
  }

  return {
    ok: true,
    allowance: checkConnectionAllowance({
      fundingSource,
      includedConnections,
      operation,
      activeInstanceCount: countRes.count ?? 0,
      provisioningAmbiguous,
      providerInstanceRefKnown: providerConnectionRefKnown(provider, credentials),
      adminDecisionRecorded,
      replacementConnectionRecorded,
    }),
  };
}

class ChannelActionError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function firstRpcRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return data && typeof data === "object" ? data as T : null;
}

/**
 * `record_whatsapp_channel_status` e `release_whatsapp_channel_provisioning`
 * devolvem uma PROJEÇÃO (`channel_id` + subconjunto de colunas), não o
 * `ChannelRow` inteiro. Fazer `firstRpcRow<ChannelRow>()` direto entrega uma
 * linha sem `id`/`webhook_secret`/`activation_requested_at`, e o próximo RPC
 * do lifecycle sai com `p_channel_id: undefined` — o PostgREST omite a chave e
 * responde PGRST202 (assinatura não encontrada), o que virava 500 no cliente.
 * Sobrepor a projeção na linha já carregada preserva o resto.
 */
function mergeChannelProjection(base: ChannelRow, row: Record<string, unknown>): ChannelRow {
  const { channel_id: channelId, ...rest } = row;
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) merged[key] = value;
  }
  if (typeof channelId === "string") merged.id = channelId;
  return merged as unknown as ChannelRow;
}

function supportsClientQr(
  provider: string,
  credentials: ChannelCredentials | null = null,
): boolean {
  const adapter = tryGetWhatsAppProvider(provider);
  return !!adapter
    && adapter.capabilities.qrConnection
    && (
      !!adapter.lifecycle
      || (!!adapter.getQrCode && (adapter.canRequestQr?.(credentials ?? {}) ?? true))
    );
}

function providerStatusErrorCode(value: string | null | undefined): string {
  const normalized = String(value ?? "PROVIDER_STATUS_UNAVAILABLE")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || "PROVIDER_STATUS_UNAVAILABLE";
}

/**
 * Providers manuais não expõem lifecycle administrativo ao lojista, mas o
 * portal pode observar status e, quando suportado, obter QR efêmero. As
 * credenciais ficam nesta fronteira service-role; o retorno segue client-safe.
 */
async function refreshManualProviderStatus(
  initialChannel: ChannelRow,
  actorId: string,
  requestId: string,
): Promise<{ channel: ChannelRow; qrCode: string | null }> {
  if (supportsClientLifecycle(initialChannel.provider)) {
    return { channel: initialChannel, qrCode: null };
  }

  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - MANUAL_STATUS_REFRESH_INTERVAL_MS).toISOString();
  const claimPatch = {
    last_health_check_at: claimedAt,
    last_error: HEALTH_CHECK_IN_PROGRESS,
  };
  const claimColumns = "id, unit_id, provider, status, credentials, webhook_secret, display_phone, is_active, instance_token_secret_id, external_instance_id, activation_requested_at, connected_at, last_health_check_at, last_error, provisioning_create_attempted_at";

  let { data: claimed, error: claimError } = await supabase
    .from("whatsapp_channels")
    .update(claimPatch)
    .eq("id", initialChannel.id)
    .eq("unit_id", initialChannel.unit_id)
    .is("last_health_check_at", null)
    .select(claimColumns)
    .maybeSingle();

  if (!claimed && !claimError) {
    const staleClaim = await supabase
      .from("whatsapp_channels")
      .update(claimPatch)
      .eq("id", initialChannel.id)
      .eq("unit_id", initialChannel.unit_id)
      .lt("last_health_check_at", staleBefore)
      .select(claimColumns)
      .maybeSingle();
    claimed = staleClaim.data;
    claimError = staleClaim.error;
  }

  if (claimError) {
    console.error("manage-channels:list_client status claim", JSON.stringify({
      requestId,
      unitId: initialChannel.unit_id,
      provider: initialChannel.provider,
      code: claimError.code ?? "STATUS_CLAIM_FAILED",
    }));
    return {
      channel: { ...initialChannel, status: "provider_error", last_error: "STATUS_CLAIM_FAILED" },
      qrCode: null,
    };
  }

  if (!claimed) {
    const current = await loadChannel(initialChannel.unit_id, initialChannel.id) ?? initialChannel;
    return {
      channel: current.last_error === HEALTH_CHECK_IN_PROGRESS
        ? { ...current, status: "provider_error" }
        : current,
      qrCode: null,
    };
  }

  const channel = claimed as ChannelRow;

  let snapshot: ProviderConnectionSnapshot;
  let qrCode: string | null = null;
  try {
    const adapter = getWhatsAppProvider(channel.provider);
    if (!adapter.getConnectionStatus) throw new Error("status_not_supported");
    const credentials = await resolveChannelCredentials(supabase, channel);
    snapshot = await adapter.getConnectionStatus(credentials);
    if (
      snapshot.qrRequired
      && supportsClientQr(channel.provider, channel.credentials)
      && adapter.getQrCode
    ) {
      qrCode = (await adapter.getQrCode(credentials)).qrCode;
    }
  } catch (error) {
    snapshot = {
      status: "provider_error",
      nativeStatus: error instanceof Error ? error.message : "provider_status_unavailable",
      connected: false,
      qrRequired: false,
    };
  }

  const displayPhoneDigits = snapshot.displayPhone?.replace(/\D/g, "") ?? "";
  const displayPhone = displayPhoneDigits.length >= 10 && displayPhoneDigits.length <= 15
    ? displayPhoneDigits
    : null;
  const errorCode = snapshot.status === "provider_error" || snapshot.status === "error"
    ? providerStatusErrorCode(snapshot.nativeStatus)
    : null;
  const { data, error } = await supabase.rpc("record_whatsapp_channel_status", {
    p_unit_id: channel.unit_id,
    p_channel_id: channel.id,
    p_status: snapshot.status,
    p_display_phone: displayPhone,
    p_error_code: errorCode,
    p_actor_id: actorId,
    p_request_id: requestId,
    p_event_type: null,
  });

  if (error) {
    console.error("manage-channels:list_client status persist", JSON.stringify({
      requestId,
      unitId: channel.unit_id,
      provider: channel.provider,
      code: error.code ?? "STATUS_PERSIST_FAILED",
    }));
    return {
      channel: { ...channel, status: "provider_error", last_error: "STATUS_PERSIST_FAILED" },
      qrCode: null,
    };
  }

  const row = firstRpcRow<Record<string, unknown>>(data);
  const projectedChannel = row ? mergeChannelProjection(channel, row) : channel;
  return {
    channel: { ...projectedChannel, last_error: errorCode },
    qrCode,
  };
}

async function getManualProviderQr(
  channel: ChannelRow,
): Promise<ReturnType<typeof clientConnection>> {
  const adapter = getWhatsAppProvider(channel.provider);
  if (!supportsClientQr(channel.provider, channel.credentials) || !adapter.getQrCode) {
    throw new ChannelActionError(
      409,
      "QR_NOT_SUPPORTED",
      "Este tipo de conexão não usa pareamento por QR Code.",
    );
  }
  const credentials = await resolveChannelCredentials(supabase, channel);
  const qrCode = (await adapter.getQrCode(credentials)).qrCode;
  if (!qrCode) {
    throw new ChannelActionError(
      503,
      "QR_UNAVAILABLE",
      "Não foi possível gerar o QR Code agora. Tente novamente.",
    );
  }
  return clientConnection({ ...channel, status: "waiting_qr" }, undefined, undefined, qrCode);
}

function publicErrorForLifecycle(error: unknown): ChannelActionError {
  if (error instanceof ChannelActionError) return error;
  if (error instanceof UazApiError) {
    const status = error.code === "CAPACITY_EXCEEDED" || error.code === "RATE_LIMITED"
      ? 429
      : error.code === "INVALID_REQUEST"
        ? 400
        : 503;
    const message = error.code === "CAPACITY_EXCEEDED"
      ? "Não há capacidade disponível para conectar outro número agora. Fale com o suporte."
      : error.code === "AUTH_ERROR"
        ? "A integração está temporariamente indisponível. Fale com o suporte."
        : "Não foi possível acessar o serviço de conexão agora. Tente novamente.";
    return new ChannelActionError(status, error.code, message);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ChannelActionError(
      503,
      "TIMEOUT",
      "Não foi possível acessar o serviço de conexão agora. Tente novamente.",
    );
  }
  return new ChannelActionError(
    500,
    "CHANNEL_LIFECYCLE_FAILED",
    "Não foi possível atualizar a conexão. Tente novamente.",
  );
}

async function getUnitContext(unitId: string): Promise<{
  organizationId: string;
  defaultProvider: string;
}> {
  const { data: unit, error } = await supabase
    .from("units")
    .select("organization_id, organizations!inner(default_whatsapp_provider)")
    .eq("id", unitId)
    .maybeSingle();
  if (error || !unit?.organization_id) {
    throw new ChannelActionError(404, "UNIT_NOT_FOUND", "Unidade não encontrada.");
  }
  const organization = Array.isArray(unit.organizations)
    ? unit.organizations[0]
    : unit.organizations;
  return {
    organizationId: unit.organization_id as string,
    defaultProvider: String(organization?.default_whatsapp_provider ?? "zapi"),
  };
}

async function assertProvisioningCommerciallyAllowed(
  unitId: string,
  targetChannel: ChannelRow,
  operation: ConnectionOperation,
  providerRef: string | null,
  platformAdminDecision: boolean,
): Promise<void> {
  if (operation === "NEW_PROVISIONING") {
    const structural = assertProvisioningAllowed("NEW_PROVISION", {
      credentialsEncryptedAtRest: true,
    });
    if (structural.ok === false) {
      throw new ChannelActionError(403, structural.code, structural.message);
    }

    const gate = await resolveWhatsAppGateByUnit(supabase, unitId);
    if (!gate || !gate.provisioning.allowed) {
      const message = !gate || gate.provisioning.blockReason === "STATE_READ_FAILED"
        ? PROVISIONING_UNVERIFIABLE
        : NEW_PROVISIONING_MESSAGE[gate.state];
      throw new ChannelActionError(403, "PROVISIONING_NOT_ALLOWED", message);
    }
  }

  const context = await getUnitContext(unitId);
  // O default UazAPI só pode ser escrito pela EF exclusiva de platform_admin;
  // ele é a decisão administrativa durável que autoriza o owner/gerente a
  // completar a conexão sem transformar a cortesia em autorização implícita.
  const adminDecisionRecorded = platformAdminDecision || context.defaultProvider === "uazapi";
  let replacementConnectionRecorded = false;
  if (operation === "NEW_PROVISIONING" && targetChannel.activation_requested_at) {
    const { data: explicitPrevious, error: explicitPreviousError } = await supabase
      .from("whatsapp_channels")
      .select("id")
      .eq("unit_id", unitId)
      .eq("is_active", true)
      .neq("id", targetChannel.id)
      .maybeSingle();
    if (explicitPreviousError) {
      throw new ChannelActionError(503, "ALLOWANCE_UNAVAILABLE", PROVISIONING_UNVERIFIABLE);
    }
    let previousId = explicitPrevious?.id ?? null;
    if (!previousId) {
      const { data: legacyPrevious, error: legacyPreviousError } = await supabase
        .from("whatsapp_channels")
        .select("id")
        .eq("unit_id", unitId)
        .is("is_active", null)
        .eq("status", "connected")
        .neq("id", targetChannel.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (legacyPreviousError) {
        throw new ChannelActionError(503, "ALLOWANCE_UNAVAILABLE", PROVISIONING_UNVERIFIABLE);
      }
      previousId = legacyPrevious?.id ?? null;
    }
    if (previousId) {
      const { count, error } = await supabase
        .from("whatsapp_instances")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", previousId)
        .neq("lifecycle_state", "ENDED");
      if (error) {
        throw new ChannelActionError(503, "ALLOWANCE_UNAVAILABLE", PROVISIONING_UNVERIFIABLE);
      }
      replacementConnectionRecorded = (count ?? 0) === 1;
    }
  }
  const allowance = await checkChannelConnectionAllowance(
    unitId,
    "uazapi",
    providerRef ? ({ instance_id: providerRef } as ChannelCredentials) : {},
    operation,
    adminDecisionRecorded,
    replacementConnectionRecorded,
  );
  if (allowance.ok === false) {
    throw new ChannelActionError(
      403,
      allowance.reason === "AMBIGUOUS" ? "SUBSCRIPTION_AMBIGUOUS" : "ALLOWANCE_UNAVAILABLE",
      allowance.reason === "AMBIGUOUS"
        ? ALLOWANCE_DENIED_MESSAGE.SUBSCRIPTION_AMBIGUOUS
        : PROVISIONING_UNVERIFIABLE,
    );
  }
  if (allowance.allowance.allowed === false) {
    throw new ChannelActionError(
      403,
      allowance.allowance.reasonCode,
      ALLOWANCE_DENIED_MESSAGE[allowance.allowance.reasonCode],
    );
  }
}

async function ensureInstanceInventory(
  channel: ChannelRow,
  providerInstanceId: string,
  actorId: string,
): Promise<boolean> {
  const context = await getUnitContext(channel.unit_id);
  const { data: existing, error: readError } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id, unit_id, channel_id")
    .eq("provider", "uazapi")
    .eq("provider_instance_ref", providerInstanceId)
    .maybeSingle();
  if (readError) return false;
  if (existing) {
    return existing.organization_id === context.organizationId
      && existing.unit_id === channel.unit_id
      && existing.channel_id === channel.id;
  }

  const { error } = await supabase.from("whatsapp_instances").insert({
    organization_id: context.organizationId,
    unit_id: channel.unit_id,
    channel_id: channel.id,
    provider: "uazapi",
    provider_instance_ref: providerInstanceId,
    lifecycle_state: "ACTIVE",
    cycle_source: "UNKNOWN",
    created_by: actorId,
    updated_by: actorId,
  });
  return !error;
}

async function recordUazStatus(
  channel: ChannelRow,
  snapshot: UazInstanceSnapshot,
  actorId: string,
  requestId: string,
  errorCode?: string | null,
  eventType?: "disconnect" | "restart" | "status_changed" | null,
): Promise<ChannelRow> {
  const normalized = normalizeUazConnectionStatus(snapshot);
  const { data, error } = await supabase.rpc("record_whatsapp_channel_status", {
    p_unit_id: channel.unit_id,
    p_channel_id: channel.id,
    p_status: normalized,
    p_display_phone: displayPhoneFromSnapshot(snapshot),
    p_error_code: errorCode ?? null,
    p_actor_id: actorId,
    p_request_id: requestId,
    p_event_type: eventType ?? null,
  });
  if (error) throw new Error("channel_status_persist_failed");
  const row = firstRpcRow<Record<string, unknown>>(data);
  if (!row) return await loadChannel(channel.unit_id, channel.id) ?? channel;
  return mergeChannelProjection(channel, row);
}

async function maybeActivateConnectedChannel(
  channel: ChannelRow,
  actorId: string,
  requestId: string,
): Promise<ChannelRow> {
  if (channel.status !== "connected" || !channel.manual_echo_verified_at) return channel;
  const { data: active } = await supabase
    .from("whatsapp_channels")
    .select("id")
    .eq("unit_id", channel.unit_id)
    .eq("is_active", true)
    .maybeSingle();

  if (shouldActivateConnectedChannel({
    targetChannelId: channel.id,
    explicitActiveChannelId: active?.id ?? null,
    activationRequested: !!channel.activation_requested_at,
  })) {
    const { error } = await supabase.rpc("activate_whatsapp_channel", {
      p_unit_id: channel.unit_id,
      p_channel_id: channel.id,
      p_actor_id: actorId,
      p_request_id: requestId,
    });
    if (error) throw new Error("channel_activation_failed");
    return await loadChannel(channel.unit_id, channel.id) ?? channel;
  }
  return channel;
}

async function getUazSnapshot(
  channel: ChannelRow,
  actorId: string,
  requestId: string,
): Promise<{ channel: ChannelRow; snapshot: UazInstanceSnapshot }> {
  const credentials = await resolveChannelCredentials(supabase, channel);
  const client = managedLifecycle(channel.provider);
  try {
    const snapshot = await client.status(credentials.instance_token ?? "");
    let updated = await recordUazStatus(channel, snapshot, actorId, requestId);
    updated = await maybeActivateConnectedChannel(updated, actorId, requestId);
    return { channel: updated, snapshot };
  } catch (error) {
    if (error instanceof UazApiError) {
      await supabase.rpc("record_whatsapp_channel_status", {
        p_unit_id: channel.unit_id,
        p_channel_id: channel.id,
        p_status: "provider_error",
        p_display_phone: null,
        p_error_code: error.code,
        p_actor_id: actorId,
        p_request_id: requestId,
      });
    }
    throw error;
  }
}

async function connectUazChannel(
  initialChannel: ChannelRow,
  actorId: string,
  requestId: string,
  platformAdminDecision: boolean,
): Promise<{ connection: ReturnType<typeof clientConnection>; warnings: string[] }> {
  const { data: claimData, error: claimError } = await supabase.rpc(
    "claim_whatsapp_channel_provisioning",
    {
      p_channel_id: initialChannel.id,
      p_actor_id: actorId,
      p_stale_after_seconds: 120,
      p_request_id: requestId,
    },
  );
  if (claimError) throw new Error("channel_provisioning_claim_failed");
  const claim = firstRpcRow<{
    claimed: boolean;
    claim_id: string | null;
    status: string;
    instance_token_secret_id: string | null;
  }>(claimData);
  if (!claim) throw new Error("channel_provisioning_claim_missing");

  if (!claim.claimed) {
    if (claim.status === "connected" && initialChannel.instance_token_secret_id) {
      const current = await getUazSnapshot(initialChannel, actorId, requestId);
      return { connection: clientConnection(current.channel, current.snapshot), warnings: [] };
    }
    const current = await loadChannel(initialChannel.unit_id, initialChannel.id) ?? initialChannel;
    return { connection: clientConnection(current), warnings: [] };
  }
  if (!claim.claim_id) throw new Error("channel_provisioning_claim_id_missing");

  const warnings: string[] = [];
  const client = managedLifecycle(initialChannel.provider);
  let providerInstance: UazInstanceSnapshot | null = null;
  let instanceToken: string | null = null;

  try {
    const claimedChannel = await loadChannel(initialChannel.unit_id, initialChannel.id) ?? initialChannel;
    if (claimedChannel.instance_token_secret_id) {
      const credentials = await resolveChannelCredentials(supabase, claimedChannel);
      instanceToken = credentials.instance_token ?? null;
      providerInstance = claimedChannel.external_instance_id
        ? {
            id: claimedChannel.external_instance_id,
            name: null,
            token: instanceToken,
            adminField01: claimedChannel.id,
            adminField02: claimedChannel.unit_id,
            status: claimedChannel.status,
            connected: false,
            loggedIn: false,
            jid: null,
            qrCode: null,
            pairCode: null,
          }
        : (await client.listInstances())
          .find((instance) => instance.adminField01 === claimedChannel.id) ?? null;
      if (!providerInstance) {
        throw new UazApiError("INSTANCE_NOT_FOUND", "A instância vinculada não foi encontrada.");
      }
    } else {
      const existing = (await client.listInstances())
        .find((instance) => instance.adminField01 === claimedChannel.id) ?? null;
      const operation: ConnectionOperation = existing ? "BACKFILL_EXISTING" : "NEW_PROVISIONING";
      await assertProvisioningCommerciallyAllowed(
        claimedChannel.unit_id,
        claimedChannel,
        operation,
        existing?.id ?? null,
        platformAdminDecision,
      );

      if (!existing && claimedChannel.provisioning_create_attempted_at) {
        const elapsed = Date.now() - new Date(claimedChannel.provisioning_create_attempted_at).getTime();
        if (Number.isFinite(elapsed) && elapsed < 5 * 60_000) {
          warnings.push("PROVISIONING_RECONCILIATION_PENDING");
          return {
            connection: clientConnection(claimedChannel),
            warnings,
          };
        }
      }

      if (existing) {
        providerInstance = existing;
      } else {
        const { data: attemptFence, error: attemptError } = await supabase
          .from("whatsapp_channels")
          .update({ provisioning_create_attempted_at: new Date().toISOString() })
          .eq("id", claimedChannel.id)
          .eq("provisioning_claim_id", claim.claim_id)
          .select("id")
          .maybeSingle();
        if (attemptError || !attemptFence) {
          throw new ChannelActionError(409, "STALE_PROVISIONING_CLAIM", "A conexão já está sendo atualizada.");
        }
        providerInstance = await client.provision({
          name: `moralles-${claimedChannel.unit_id.slice(0, 8)}-${claimedChannel.id.slice(0, 8)}`,
          adminField01: claimedChannel.id,
          adminField02: claimedChannel.unit_id,
        });
      }
      instanceToken = providerInstance.token;
      if (!instanceToken) {
        throw new UazApiError(
          "AUTH_ERROR",
          "A instância reconciliada não expõe token para configuração automática.",
        );
      }

      const { error: storeError } = await supabase.rpc("store_whatsapp_channel_instance_token", {
        p_channel_id: claimedChannel.id,
        p_claim_id: claim.claim_id,
        p_token: instanceToken,
        p_actor_id: actorId,
        p_request_id: requestId,
      });
      if (storeError) throw new Error("channel_token_store_failed");
      await refreshTemplateChannel(claimedChannel.id);

    }

    if (!instanceToken || !providerInstance) throw new Error("uazapi_instance_not_resolved");
    if (!(await ensureInstanceInventory(claimedChannel, providerInstance.id, actorId))) {
      warnings.push("INSTANCE_INVENTORY_RECONCILIATION_REQUIRED");
    }
    await client.configureWebhook(instanceToken, {
      url: webhookUrlFor(initialChannel.id, initialChannel.webhook_secret),
    });
    const verificationNow = new Date().toISOString();
    const { error: parityWriteError } = await supabase
      .from("whatsapp_channels")
      .update({
        manual_echo_verified_at: verificationNow,
        manual_echo_verification_source: "managed_configuration",
      })
      .eq("id", initialChannel.id)
      .eq("unit_id", initialChannel.unit_id);
    if (parityWriteError) throw new Error("channel_parity_verification_persist_failed");
    claimedChannel.manual_echo_verified_at = verificationNow;
    claimedChannel.manual_echo_verification_source = "managed_configuration";
    const snapshot = await client.connect(instanceToken);
    const normalized = normalizeUazConnectionStatus(snapshot);
    const { data: releasedData, error: releaseError } = await supabase.rpc(
      "release_whatsapp_channel_provisioning",
      {
        p_channel_id: initialChannel.id,
        p_claim_id: claim.claim_id,
        p_status: normalized,
        p_external_instance_id: providerInstance.id,
        p_display_phone: displayPhoneFromSnapshot(snapshot),
        p_error_code: null,
        p_actor_id: actorId,
        p_request_id: requestId,
      },
    );
    if (releaseError) throw new Error("channel_provisioning_release_failed");
    const releasedRow = firstRpcRow<Record<string, unknown>>(releasedData);
    let released = releasedRow
      ? mergeChannelProjection(claimedChannel, releasedRow)
      : await loadChannel(initialChannel.unit_id, initialChannel.id) ?? initialChannel;
    released = await maybeActivateConnectedChannel(released, actorId, requestId);
    return { connection: clientConnection(released, snapshot), warnings };
  } catch (error) {
    if (
      error instanceof UazApiError
      && ["TIMEOUT", "PROVIDER_UNAVAILABLE", "UNKNOWN_PROVIDER_ERROR"].includes(error.code)
      && !providerInstance
    ) {
      warnings.push("PROVISIONING_RECONCILIATION_PENDING");
      const current = await loadChannel(initialChannel.unit_id, initialChannel.id) ?? initialChannel;
      return { connection: clientConnection(current), warnings };
    }
    const code = error instanceof UazApiError ? error.code : "CHANNEL_LIFECYCLE_FAILED";
    await supabase.rpc("release_whatsapp_channel_provisioning", {
      p_channel_id: initialChannel.id,
      p_claim_id: claim.claim_id,
      p_status: "provider_error",
      p_external_instance_id: providerInstance?.id ?? null,
      p_display_phone: null,
      p_error_code: code,
      p_actor_id: actorId,
      p_request_id: requestId,
    });
    throw error;
  }
}

const datafyActions = createDatafyOnboardingActions({
  supabase,
  getAccountToken: getDatafyAccountToken,
  getOrganizationId: async (unitId) => (await getUnitContext(unitId)).organizationId,
  gatesAllowed: async (unitId, adminDecisionRecorded) => {
    const gate = await resolveWhatsAppGateByUnit(supabase, unitId);
    const allowance = await checkChannelConnectionAllowance(
      unitId, "datafy", {}, "NEW_PROVISIONING", adminDecisionRecorded,
    );
    return gate?.provisioning.allowed === true && allowance.ok === true && allowance.allowance.allowed === true;
  },
  projectUrl: Deno.env.get("SUPABASE_URL")!,
  // Task 9 conecta o remetente; este evento não afirma entrega nem grava ledger.
  emitEvent: (event) => jsonLog("warn", event),
  logCleanupFailure: () => jsonLog("warn", { evt: "datafy_discard_cleanup_failed" }),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  // Cache do gate é por invocação — zera aqui, mesmo padrão do unitCache dos
  // workers, senão um isolate quente serve estado de suspensão velho.
  clearWhatsAppGateCache();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action, unit_id: unitId } = body;

    if (!unitId) return jsonResponse(req, { error: "unit_id é obrigatório." }, 400);

    const platformAdmin = await isPlatformAdmin(callerId);
    if (!platformAdmin) {
      if (!CLIENT_LIFECYCLE_ACTIONS.has(String(action))) {
        return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
      }
      if (!(await memberLifecycleRole(callerId, unitId))) {
        return jsonResponse(req, { error: "Apenas proprietários e gerentes da unidade." }, 403);
      }
    }
    const requestId = genRequestId();

    if (DATAFY_ACTIONS.has(String(action))) {
      const response = await datafyActions.handle(String(action), unitId, callerId, requestId, body);
      return jsonResponse(req, response.body, response.status, response.headers);
    }

    const resolveLifecycleChannel = async (createWhenMissing: boolean): Promise<ChannelRow | null> => {
      const requestedId = String(body.channel_id ?? "").trim();
      let requested: ChannelRow | null = null;
      if (requestedId) {
        requested = await loadChannel(unitId, requestedId);
        if (!requested) throw new ChannelActionError(404, "CHANNEL_NOT_FOUND", "Canal não encontrado.");
        if (requested.provider !== "uazapi") {
          const selected = selectClientChannel(await loadClientChannels(unitId));
          if (selected?.id !== requested.id && !hasValidActivationRequest(requested)) {
            throw new ChannelActionError(
              409,
              "CHANNEL_NOT_SELECTED",
              "Este canal ainda não está selecionado para a unidade.",
            );
          }
          // Provisionamento sem canal continua exclusivo da UazAPI; canal
          // manual passa somente depois do binding e da seleção acima.
          return requested;
        }
      }

      const existing = requested ?? await findUazChannel(unitId);
      const { data: active, error: activeError } = await supabase
        .from("whatsapp_channels")
        .select("id, provider")
        .eq("unit_id", unitId)
        .eq("is_active", true)
        .maybeSingle();
      if (activeError) {
        throw new ChannelActionError(503, "ACTIVE_CHANNEL_UNAVAILABLE", "Não foi possível validar o canal ativo.");
      }
      if (!platformAdmin && active && active.provider !== "uazapi") {
        throw new ChannelActionError(
          409,
          "PROVIDER_SWITCH_REQUIRES_PLATFORM_ADMIN",
          "A troca da conexão precisa ser preparada pelo suporte.",
        );
      }

      if (!platformAdmin && existing && active?.id !== existing.id && !existing.activation_requested_at) {
        const context = await getUnitContext(unitId);
        if (active || !supportsClientLifecycle(context.defaultProvider)) {
          throw new ChannelActionError(
            409,
            "UAZAPI_NOT_SELECTED",
            "A conexão automática ainda não está habilitada para esta empresa.",
          );
        }
      }

      if (existing) return existing;
      if (!createWhenMissing) return null;
      if (!platformAdmin) {
        const context = await getUnitContext(unitId);
        if (active || !supportsClientLifecycle(context.defaultProvider)) {
          throw new ChannelActionError(
            409,
            "UAZAPI_NOT_SELECTED",
            "A conexão automática ainda não está habilitada para esta empresa.",
          );
        }
      }
      return await createUazPlaceholder(unitId);
    };

    // ── client-safe lifecycle ────────────────────────────────────────────────
    if (action === "list_client") {
      let rows: ClientChannelRow[];
      try {
        rows = await loadClientChannels(unitId);
      } catch (error) {
        const safe = publicErrorForLifecycle(error);
        return jsonResponse(req, { error: safe.message, code: safe.code }, safe.httpStatus);
      }
      let selected = selectClientChannel(rows);
      let qrCode: string | null = null;
      if (selected) {
        const refreshed = await refreshManualProviderStatus(selected, callerId, requestId);
        selected = refreshed.channel;
        qrCode = refreshed.qrCode;
        await refreshTemplateChannel(selected.id);
      }
      const defaultProvider = selected ? null : (await getUnitContext(unitId)).defaultProvider;
      const capabilityProvider = selected
        ? String(selected.provider)
        : defaultProvider && supportsClientLifecycle(defaultProvider)
          ? defaultProvider
          : undefined;
      return jsonResponse(req, {
        success: true,
        connection: clientConnection(selected, undefined, capabilityProvider, qrCode),
      });
    }

    if (["connect", "refresh_qr"].includes(String(action))) {
      try {
        const channel = await resolveLifecycleChannel(true);
        if (!channel) throw new Error("uazapi_channel_missing");
        if (!getWhatsAppProvider(channel.provider).capabilities.automaticProvisioning) {
          return jsonResponse(req, {
            success: true,
            connection: await getManualProviderQr(channel),
          });
        }
        const result = await connectUazChannel(
          channel,
          callerId,
          requestId,
          platformAdmin,
        );
        return jsonResponse(req, { success: true, ...result });
      } catch (error) {
        const safe = publicErrorForLifecycle(error);
        console.error("manage-channels:client connect", JSON.stringify({
          requestId,
          unitId,
          code: safe.code,
        }));
        return jsonResponse(req, { error: safe.message, code: safe.code }, safe.httpStatus);
      }
    }

    if (action === "status") {
      try {
        const channel = await resolveLifecycleChannel(false);
        if (!channel) {
          const context = await getUnitContext(unitId);
          return jsonResponse(req, {
            success: true,
            connection: clientConnection(
              null,
              undefined,
              supportsClientLifecycle(context.defaultProvider) ? context.defaultProvider : undefined,
            ),
          });
        }
        if (!getWhatsAppProvider(channel.provider).capabilities.automaticProvisioning) {
          const refreshed = await refreshManualProviderStatus(channel, callerId, requestId);
          await refreshTemplateChannel(channel.id);
          return jsonResponse(req, {
            success: true,
            connection: clientConnection(
              refreshed.channel,
              undefined,
              channel.provider,
              refreshed.qrCode,
            ),
          });
        }
        if (channel.status === "provisioning" && !channel.instance_token_secret_id) {
          return jsonResponse(req, { success: true, connection: clientConnection(channel) });
        }
        const current = await getUazSnapshot(channel, callerId, requestId);
        return jsonResponse(req, {
          success: true,
          connection: clientConnection(current.channel, current.snapshot),
        });
      } catch (error) {
        const safe = publicErrorForLifecycle(error);
        console.error("manage-channels:client status", JSON.stringify({ requestId, unitId, code: safe.code }));
        return jsonResponse(req, { error: safe.message, code: safe.code }, safe.httpStatus);
      }
    }

    if (action === "disconnect") {
      try {
        const channel = await resolveLifecycleChannel(false);
        if (!channel) return jsonResponse(req, { success: true, connection: clientConnection(null) });
        const credentials = await resolveChannelCredentials(supabase, channel);
        await managedLifecycle(channel.provider).disconnect(credentials.instance_token ?? "");
        const snapshot: UazInstanceSnapshot = {
          id: channel.external_instance_id ?? "",
          name: null,
          token: null,
          adminField01: channel.id,
          adminField02: channel.unit_id,
          status: "disconnected",
          connected: false,
          loggedIn: false,
          jid: null,
          qrCode: null,
          pairCode: null,
        };
        let updated: ChannelRow;
        try {
          updated = await recordUazStatus(channel, snapshot, callerId, requestId, null, "disconnect");
        } catch {
          return jsonResponse(req, {
            success: true,
            external_success: true,
            local_success: false,
            warning: "CHANNEL_STATUS_RECONCILIATION_REQUIRED",
            connection: clientConnection({ ...channel, status: "disconnected" }, snapshot),
          }, 202);
        }
        return jsonResponse(req, { success: true, connection: clientConnection(updated, snapshot) });
      } catch (error) {
        const safe = publicErrorForLifecycle(error);
        return jsonResponse(req, { error: safe.message, code: safe.code }, safe.httpStatus);
      }
    }

    if (action === "restart") {
      try {
        const channel = await resolveLifecycleChannel(false);
        if (!channel) throw new ChannelActionError(404, "CHANNEL_NOT_FOUND", "Canal não encontrado.");
        const credentials = await resolveChannelCredentials(supabase, channel);
        await managedLifecycle(channel.provider).restart(credentials.instance_token ?? "");
        const disconnected: UazInstanceSnapshot = {
          id: channel.external_instance_id ?? "",
          name: null,
          token: null,
          adminField01: channel.id,
          adminField02: channel.unit_id,
          status: "disconnected",
          connected: false,
          loggedIn: false,
          jid: null,
          qrCode: null,
          pairCode: null,
        };
        let resetChannel: ChannelRow;
        try {
          resetChannel = await recordUazStatus(channel, disconnected, callerId, requestId, null, "restart");
        } catch {
          return jsonResponse(req, {
            success: true,
            external_success: true,
            local_success: false,
            warning: "CHANNEL_STATUS_RECONCILIATION_REQUIRED",
            connection: clientConnection({ ...channel, status: "disconnected" }, disconnected),
          }, 202);
        }
        const result = await connectUazChannel(resetChannel, callerId, requestId, platformAdmin);
        return jsonResponse(req, { success: true, ...result });
      } catch (error) {
        const safe = publicErrorForLifecycle(error);
        return jsonResponse(req, { error: safe.message, code: safe.code }, safe.httpStatus);
      }
    }

    // ── switch seguro (platform admin) ──────────────────────────────────────
    if (action === "begin_switch") {
      const targetProvider = String(body.target_provider ?? "") as WhatsAppProvider;
      if (!["zapi", "uazapi", "waha", "official", "datafy"].includes(targetProvider)) {
        return jsonResponse(req, { error: "Provedor alvo inválido." }, 400);
      }

      try {
        if (targetProvider === "datafy") {
          const binding = resolveUnitChannelBinding(await loadClientChannels(unitId));
          if (binding && binding.provider !== "datafy") {
            throw new ChannelActionError(
              409,
              "DATAFY_MIGRATION_NOT_SUPPORTED",
              "A conexão oficial está disponível apenas na primeira configuração desta unidade.",
            );
          }
        }
        let target: ChannelRow | null = null;
        const requestedTargetId = String(body.channel_id ?? "").trim();
        if (requestedTargetId) {
          target = await loadChannel(unitId, requestedTargetId);
          if (!target || target.provider !== targetProvider) {
            throw new ChannelActionError(404, "TARGET_CHANNEL_NOT_FOUND", "Canal alvo não encontrado.");
          }
        } else if (targetProvider === "uazapi") {
          target = await findUazChannel(unitId) ?? await createUazPlaceholder(unitId);
        } else {
          const { data, error } = await supabase
            .from("whatsapp_channels")
            .select("id")
            .eq("unit_id", unitId)
            .eq("provider", targetProvider)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          if (error) throw new ChannelActionError(500, "CHANNEL_READ_FAILED", "Falha ao consultar a conexão.");
          if (data?.id) target = await loadChannel(unitId, data.id);
        }
        if (!target) {
          throw new ChannelActionError(
            409,
            "TARGET_CHANNEL_NOT_CONFIGURED",
            "Configure e teste o canal alvo antes de iniciar a troca.",
          );
        }

        const { error: intentError } = await supabase.rpc(
          "request_whatsapp_channel_activation",
          {
            p_unit_id: unitId,
            p_channel_id: target.id,
            p_actor_id: callerId,
            p_request_id: requestId,
          },
        );
        if (intentError) throw new Error("activation_request_failed");
        target = await loadChannel(unitId, target.id) ?? target;

        const targetAdapter = getWhatsAppProvider(target.provider);
        if (targetAdapter.capabilities.automaticProvisioning) {
          const result = await connectUazChannel(target, callerId, requestId, true);
          return jsonResponse(req, { success: true, ...result });
        }
        if (!targetAdapter.getConnectionStatus) {
          throw new ChannelActionError(
            409,
            "TARGET_HEALTH_UNAVAILABLE",
            "Teste o canal alvo antes de concluir a troca.",
          );
        }
        if (!target.manual_echo_verified_at) {
          throw new ChannelActionError(
            409,
            "TARGET_CONVERSATION_PARITY_UNVERIFIED",
            "Envie uma mensagem de teste pelo celular da loja e aguarde o callback antes de concluir a troca.",
          );
        }
        const targetCredentials = await resolveChannelCredentials(supabase, target);
        const health = await targetAdapter.getConnectionStatus(targetCredentials);
        if (!health.connected) {
          throw new ChannelActionError(
            409,
            "TARGET_NOT_CONNECTED",
            "O canal alvo não está conectado. O canal atual foi preservado.",
          );
        }
        const { data: healthWritten, error: healthWriteError } = await supabase
          .from("whatsapp_channels")
          .update({
            status: "connected",
            last_health_check_at: new Date().toISOString(),
            last_error: null,
            ...(health.displayPhone ? { display_phone: health.displayPhone.replace(/\D/g, "") } : {}),
          })
          .eq("id", target.id)
          .eq("unit_id", unitId)
          .select("id")
          .maybeSingle();
        if (healthWriteError || !healthWritten) throw new Error("target_health_persist_failed");
        const { error: activateError } = await supabase.rpc("activate_whatsapp_channel", {
          p_unit_id: unitId,
          p_channel_id: target.id,
          p_actor_id: callerId,
          p_request_id: requestId,
        });
        if (activateError) throw new Error("channel_activation_failed");
        target = await loadChannel(unitId, target.id) ?? target;
        return jsonResponse(req, { success: true, channel: clientConnection(target) });
      } catch (error) {
        const safe = publicErrorForLifecycle(error);
        return jsonResponse(req, { error: safe.message, code: safe.code }, safe.httpStatus);
      }
    }

    // ── list ──────────────────────────────────────────────────────────────────
    // Retorna canais da unidade com colunas seguras (sem `credentials`).
    // Necessário porque whatsapp_channels usa FORCE RLS — UI não pode mais
    // consultar a tabela direto.
    if (action === "list") {
      const { data, error } = await supabase
        .from("whatsapp_channels")
        .select("id, unit_id, provider, status, display_phone, last_event_at, last_error, webhook_secret, is_active, connected_at, last_health_check_at, activation_requested_at, manual_echo_verified_at, manual_echo_verification_source, created_at, updated_at")
        .eq("unit_id", unitId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("manage-channels:list", error);
        return jsonResponse(req, { error: "Falha ao listar canais." }, 500);
      }
      return jsonResponse(req, {
        success: true,
        channels: (data ?? []).map((channel) => ({
          ...channel,
          capabilities: getWhatsAppProvider(channel.provider).capabilities,
        })),
      });
    }

    if (action === "list_provider_metadata") {
      return jsonResponse(req, {
        success: true,
        providers: listWhatsAppProviderMetadata(),
      });
    }

    // ── create ─────────────────────────────────────────────────────────────────
    if (action === "create") {
      if (body.provider === "uazapi") {
        try {
          const existing = await findUazChannel(unitId);
          const channel = existing ?? await createUazPlaceholder(unitId);
          return jsonResponse(req, {
            success: true,
            channel: clientConnection(channel),
          });
        } catch (error) {
          console.error("manage-channels:create uazapi", error);
          return jsonResponse(req, { error: "Falha ao preparar canal UazAPI." }, 500);
        }
      }
      // Gate de NOVO provisionamento: só ACTIVE e OVERRIDE_ACTIVE autorizam
      // gerar custo externo novo. GRACE_PERIOD preserva a instância existente
      // mas não cria outra; LEGACY_GRANDFATHERED preserva o uso existente mas
      // não expande o serviço.
      //
      // NÃO consulta `whatsapp_service_enforcement`, nem para liberar nem para
      // bloquear: aquela flag governa a suspensão de uso EXISTENTE. Esta guarda
      // impede despesa recorrente nova de nascer e vale sempre. Fail-closed:
      // gate irresolvível (unidade sem organização, leitura que falhou) recusa.
      //
      // platform_admin NÃO passa por cima — esta EF já é exclusiva de
      // super-admin, então "exceto para admin" seria "nunca". Provisionar para
      // organização sem assinatura exige override formal de `whatsapp`, que
      // leva a OVERRIDE_ACTIVE e libera pela porta da frente, com rastro.
      const { count: existingChannels, error: countErr } = await supabase
        .from("whatsapp_channels")
        .select("id", { count: "exact", head: true })
        .eq("unit_id", unitId);

      if (countErr) {
        console.error("manage-channels:create count", countErr);
        return jsonResponse(req, { error: PROVISIONING_UNVERIFIABLE }, 403);
      }

      if ((existingChannels ?? 0) === 0) {
        const gate = await resolveWhatsAppGateByUnit(supabase, unitId);
        if (!gate || !gate.provisioning.allowed) {
          const message = !gate || gate.provisioning.blockReason === "STATE_READ_FAILED"
            ? PROVISIONING_UNVERIFIABLE
            : NEW_PROVISIONING_MESSAGE[gate.state];
          return jsonResponse(req, { error: message }, 403);
        }
      }

      const provider: WhatsAppProvider = body.provider;
      const credentials: ChannelCredentials = body.credentials ?? {};

      if (!provider || !["zapi", "waha", "official", "datafy"].includes(provider)) {
        return jsonResponse(req, { error: "Provedor inválido." }, 400);
      }

      // Segunda guarda, SOMADA à primeira e não em substituição a ela: o gate
      // acima pergunta "o serviço está ativo?", esta pergunta "o contrato inclui
      // mais uma conexão?". Roda em TODO `create`, inclusive quando a unidade já
      // tem canal — o teto é por organização, e duas unidades da mesma rede com
      // um canal cada são duas conexões.
      const allowanceCheck = await checkChannelConnectionAllowance(unitId, provider, credentials);
      if (allowanceCheck.ok === false) {
        // Estado indeterminado ≠ sem direito: soluço de leitura não pode dizer
        // ao cliente que ele não contratou.
        if (allowanceCheck.reason === "AMBIGUOUS") {
          return jsonResponse(req, {
            error: ALLOWANCE_DENIED_MESSAGE.SUBSCRIPTION_AMBIGUOUS,
            code: "SUBSCRIPTION_AMBIGUOUS",
          }, 403);
        }
        return jsonResponse(req, { error: PROVISIONING_UNVERIFIABLE }, 403);
      }
      if (allowanceCheck.allowance.allowed === false) {
        const reasonCode = allowanceCheck.allowance.reasonCode;
        console.warn(
          "manage-channels:allowance denied",
          JSON.stringify({ unitId, provider, reasonCode }),
        );
        return jsonResponse(req, {
          error: ALLOWANCE_DENIED_MESSAGE[reasonCode],
          code: reasonCode,
        }, 403);
      }

      // Z-API/WAHA/Meta: nós emitimos o segredo e o provedor o repete de volta.
      // Datafy: ELA emite o `whsec_` e assina com ele — gerar um nosso faria
      // toda entrega ser recusada, com o canal parecendo configurado.
      let webhookSecret: string;
      let datafyCredentials: { access_token: string; phone_number_id: string; business_account_id: string | null } | null = null;

      if (provider === "datafy") {
        // Lida UMA vez, com guarda de tipo, e reutilizado abaixo — nunca
        // `String(valor ?? "")`. `String({})` é `"[object Object]"`, uma
        // string NÃO-vazia que passaria por `.trim()`, pela checagem de
        // "faltando" e seria GRAVADA como token/segredo do canal.
        const rawToken = readManualCredentialField(credentials.access_token);
        const rawSecret = readManualCredentialField(body.webhook_secret);

        let account = null;
        let discoveryResponseOk = false;
        try {
          const response = await getWhatsAppProvider("datafy").cloudApiRequest!(
            { access_token: rawToken },
            { method: "GET", path: "me" },
          );
          discoveryResponseOk = response.status >= 200 && response.status < 300;
          account = discoveryResponseOk ? parseDatafyAccount(response.body) : null;
          // Um 2xx que não vira `DatafyAccount` é diferente de token ruim: o
          // `/me` respondeu, mas divergiu do que `parseDatafyAccount` espera.
          // Sem este log a única pista seria a mesma mensagem de "token
          // inválido" — este repo já tem incidente de suíte verde sobre
          // envelope de provedor inventado (recibos da UazAPI). FORMA, nunca
          // valor: `shapeOf` nunca devolve o corpo em si.
          if (discoveryResponseOk && !account) {
            console.error("manage-channels:create datafy discovery unrecognized", JSON.stringify({
              status: response.status,
              shape: shapeOf(response.body),
            }));
          }
        } catch (error) {
          console.error("manage-channels:create datafy discovery", error);
        }

        const setup = decideDatafyChannelSetup({
          token: rawToken,
          webhookSecret: rawSecret,
          account,
          discoveryResponseOk,
        });
        if (setup.ok === false) {
          return jsonResponse(req, { error: DATAFY_SETUP_MESSAGE[setup.reason] }, 400);
        }
        datafyCredentials = setup.credentials;
        webhookSecret = rawSecret.trim();
      } else {
        webhookSecret = Array.from(
          crypto.getRandomValues(new Uint8Array(32))
        ).map((b) => b.toString(16).padStart(2, "0")).join("");
      }

      const { data: channel, error: insertErr } = await supabase
        .from("whatsapp_channels")
        .insert({
          unit_id: unitId,
          provider,
          credentials: datafyCredentials ?? credentials,       // stored as JSONB — add pgcrypto encryption in production
          webhook_secret: webhookSecret,
          status: "disconnected",
          // Canal novo nunca participa do fallback legado (NULL). Ele só pode
          // enviar/processar depois de provar conexão + eco manual e ser ativado.
          is_active: false,
        })
        .select("id, unit_id, provider, status, display_phone, created_at")
        .single();

      if (insertErr || !channel) {
        console.error("manage-channels:create", insertErr);
        return jsonResponse(req, { error: "Falha ao criar canal." }, 500);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      if (!supabaseUrl) {
        console.error("manage-channels:create SUPABASE_URL not configured");
        return jsonResponse(req, { error: "Falha ao gerar URL de webhook." }, 500);
      }
      const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\./)?.[1];
      if (!projectRef) {
        console.error("manage-channels:create unexpected SUPABASE_URL format", supabaseUrl);
        return jsonResponse(req, { error: "Falha ao gerar URL de webhook." }, 500);
      }
      const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/webhook-whatsapp?channel=${channel.id}`;

      return jsonResponse(req, { success: true, channel, webhookUrl, webhookSecret });
    }

    // ── update ─────────────────────────────────────────────────────────────────
    // Atualiza credenciais de um canal existente SEM recriar — channel_id e
    // webhook_secret são preservados, então o webhook configurado no provedor
    // continua válido. Merge: só sobrescreve as chaves enviadas com valor
    // não-vazio (campo em branco mantém o atual). Caso de uso: rotacionar só o
    // Client Token do Z-API sem reenviar instance_id/token.
    if (action === "update") {
      const channelId = String(body.channel_id ?? "");
      if (!channelId) return jsonResponse(req, { error: "channel_id é obrigatório." }, 400);

      const incoming: Record<string, unknown> = body.credentials ?? {};

      const { data: existing, error: fetchErr } = await supabase
        .from("whatsapp_channels")
        .select("provider, credentials")
        .eq("id", channelId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (fetchErr) {
        console.error("manage-channels:update fetch", fetchErr);
        return jsonResponse(req, { error: "Falha ao carregar canal." }, 500);
      }
      if (!existing) return jsonResponse(req, { error: "Canal não encontrado." }, 404);
      if (existing.provider === "uazapi") {
        return jsonResponse(req, {
          error: "Credenciais UazAPI são gerenciadas automaticamente no Vault.",
        }, 409);
      }

      // Whitelist de chaves conhecidas — evita injeção de campos arbitrários no JSONB.
      const ALLOWED_CRED_KEYS = [
        "instance_id", "token", "client_token",                                  // Z-API
        "base_url", "api_key", "session_name",                                   // WAHA
        "phone_number_id", "business_account_id", "access_token", "app_secret",  // Official
      ];

      const merged: Record<string, unknown> = { ...((existing.credentials as Record<string, unknown>) ?? {}) };
      let changed = 0;
      for (const key of ALLOWED_CRED_KEYS) {
        const v = incoming[key];
        if (typeof v === "string" && v.trim() !== "") {
          merged[key] = v.trim();
          changed++;
        }
      }

      if (changed === 0) {
        return jsonResponse(req, { error: "Nenhuma credencial para atualizar." }, 400);
      }

      const { error: updateErr } = await supabase
        .from("whatsapp_channels")
        .update({
          credentials: merged,
          is_active: false,
          manual_echo_verified_at: null,
          manual_echo_verification_source: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelId)
        .eq("unit_id", unitId);

      if (updateErr) {
        console.error("manage-channels:update", updateErr);
        return jsonResponse(req, { error: "Falha ao atualizar credenciais." }, 500);
      }
      await refreshTemplateChannel(channelId);
      return jsonResponse(req, { success: true });
    }

    // ── rotate_secret ──────────────────────────────────────────────────────────
    // Gera um `webhook_secret` novo PRESERVANDO o `channel_id` — a URL do webhook
    // muda só no parâmetro `secret=`, e o resto continua válido no painel do
    // provedor. Existe porque a alternativa era remover e recriar o canal, o que
    // (a) troca o channel_id e obriga a reconfigurar a URL inteira e (b) desde o
    // gate de novo provisionamento pode ser RECUSADO no meio da rotação,
    // deixando a unidade sem canal nenhum.
    //
    // Deliberadamente FORA do gate de novo provisionamento: o canal já existe e
    // nenhum custo externo novo nasce aqui. Uma organização em GRACE_PERIOD ou
    // LEGACY_GRANDFATHERED PRECISA conseguir rotacionar — "preserva o uso
    // existente" inclui poder trocar um secret vazado.
    if (action === "rotate_secret") {
      const channelId = String(body.channel_id ?? "");
      if (!channelId) return jsonResponse(req, { error: "channel_id é obrigatório." }, 400);

      const { data: rotateTarget } = await supabase
        .from("whatsapp_channels")
        .select("provider")
        .eq("id", channelId)
        .eq("unit_id", unitId)
        .maybeSingle();
      if (!rotateTarget) return jsonResponse(req, { error: "Canal não encontrado." }, 404);
      if (rotateTarget.provider === "uazapi") {
        return jsonResponse(req, {
          error: "O webhook UazAPI é gerenciado automaticamente; reconecte para reconfigurá-lo.",
        }, 409);
      }

      const rotation = decideDatafySecretRotation({
        provider: rotateTarget.provider,
        webhookSecret: readManualCredentialField(body.webhook_secret),
      });
      if (rotation.mode === "refused") {
        return jsonResponse(req, { error: DATAFY_SETUP_MESSAGE[rotation.reason] }, 400);
      }
      const newSecret = rotation.mode === "provider_issued"
        ? rotation.secret
        : Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, "0")).join("");

      const { data: rotated, error: rotErr } = await supabase
        .from("whatsapp_channels")
        .update({
          webhook_secret: newSecret,
          is_active: false,
          manual_echo_verified_at: null,
          manual_echo_verification_source: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelId)
        .eq("unit_id", unitId)
        .select("id")
        .maybeSingle();

      if (rotErr) {
        console.error("manage-channels:rotate_secret", rotErr);
        return jsonResponse(req, { error: "Falha ao rotacionar o secret do webhook." }, 500);
      }
      if (!rotated) return jsonResponse(req, { error: "Canal não encontrado." }, 404);
      await refreshTemplateChannel(channelId);

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const projectRef = supabaseUrl?.match(/https:\/\/([^.]+)\./)?.[1];
      if (!projectRef) {
        console.error("manage-channels:rotate_secret unexpected SUPABASE_URL", supabaseUrl);
        // O secret JÁ rotacionou — não devolver erro seria pior, porque o
        // operador precisa saber que a URL antiga parou de valer.
        return jsonResponse(
          req,
          { error: "Secret rotacionado, mas não foi possível montar a URL do webhook. Recarregue a tela." },
          500,
        );
      }
      const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/webhook-whatsapp?channel=${channelId}`;

      return jsonResponse(req, { success: true, webhookSecret: newSecret, webhookUrl });
    }

    // ── delete ─────────────────────────────────────────────────────────────────
    if (action === "delete") {
      const channelId = String(body.channel_id ?? "");
      if (!channelId) return jsonResponse(req, { error: "channel_id é obrigatório." }, 400);

      const { error: delErr } = await supabase
        .from("whatsapp_channels")
        .delete()
        .eq("id", channelId)
        .eq("unit_id", unitId);

      if (delErr) {
        console.error("manage-channels:delete", delErr);
        return jsonResponse(req, { error: "Falha ao remover canal." }, 500);
      }
      return jsonResponse(req, { success: true });
    }

    // ── test ──────────────────────────────────────────────────────────────────
    if (action === "test") {
      const channelId = String(body.channel_id ?? "");
      if (!channelId) return jsonResponse(req, { error: "channel_id é obrigatório." }, 400);

      const { data: channel } = await supabase
        .from("whatsapp_channels")
        .select("*")
        .eq("id", channelId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!channel) return jsonResponse(req, { error: "Canal não encontrado." }, 404);

      const creds: ChannelCredentials = channel.credentials ?? {};
      const provider: WhatsAppProvider = channel.provider;

      let connected = false;
      let errorMsg: string | null = null;
      let displayPhone: string | null = null;
      let observedStatus = "provider_error";

      try {
        const runtimeCredentials = await resolveChannelCredentials(supabase, channel as ChannelRow);
        const adapter = getWhatsAppProvider(provider);
        if (!adapter.getConnectionStatus) throw new Error("status_not_supported");
        const snapshot = await adapter.getConnectionStatus(runtimeCredentials);
        connected = snapshot.connected;
        observedStatus = snapshot.status;
        displayPhone = snapshot.displayPhone ?? null;
        if (!connected) errorMsg = snapshot.nativeStatus ?? "provider_error";
      } catch (e) {
        errorMsg = String(e);
        connected = false;
        observedStatus = "provider_error";
      }

      const newStatus = observedStatus;
      const { error: statusWriteError } = await supabase
        .from("whatsapp_channels")
        .update({
          status: newStatus,
          last_event_at: connected ? new Date().toISOString() : undefined,
          last_health_check_at: new Date().toISOString(),
          last_error: newStatus === "provider_error" || newStatus === "error" ? errorMsg : null,
          ...(displayPhone ? { display_phone: displayPhone } : {}),
        })
        .eq("id", channelId)
        .eq("unit_id", unitId);
      if (statusWriteError) {
        console.error("manage-channels:test status persist", statusWriteError);
        return jsonResponse(req, { error: "Falha ao registrar o status do canal." }, 500);
      }
      if (connected) await refreshTemplateChannel(channelId);

      if (connected && channel.activation_requested_at && channel.manual_echo_verified_at) {
        const { error: activateError } = await supabase.rpc("activate_whatsapp_channel", {
          p_unit_id: unitId,
          p_channel_id: channelId,
          p_actor_id: callerId,
          p_request_id: requestId,
        });
        if (activateError) {
          return jsonResponse(req, {
            error: "Canal conectado, mas o cutover não foi concluído. Tente novamente.",
            code: "ACTIVATION_RECONCILIATION_REQUIRED",
          }, 500);
        }
      }

      return jsonResponse(req, {
        success: connected,
        status: newStatus,
        error: newStatus === "provider_error" || newStatus === "error" ? errorMsg : null,
      });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    console.error("manage-channels unhandled", err);
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
