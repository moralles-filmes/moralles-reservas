// Import-safe channel decisions; the existing runtime injects all I/O.
import type {
  ChannelCredentials,
  OutboundMessage,
  SendResult,
  SendTextOptions,
  WhatsAppProviderAdapter,
  WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";
import { isMetaShapedProvider } from "./whatsapp-provider-core.ts";
import { decideChannelUsability } from "./whatsapp-channel-freshness-core.ts";
import type {
  TemplateSendInput,
  TemplateSendOutcome,
} from "./whatsapp-template-provider-core.ts";
import { createLegacyAutomationPostGuard, LEGACY_AUTOMATION_REFUSED, LEGACY_AUTOMATION_UNCERTAIN,
  type LegacyAutomationIntent } from "./whatsapp-legacy-automation-post.ts";

/** Linha de canal no shape que o despacho precisa, resolvida por qualquer caminho. */
export interface RoutableChannel {
  id: string;
  unit_id: string;
  provider: string;
  credentials: ChannelCredentials;
  instance_token_secret_id: string | null;
  status: string | null;
  last_health_check_at: string | null;
  is_active?: boolean | null;
  template_credential_revision?: number;
}

interface BindingRow {
  id: string;
  channel_id: string;
  unit_id: string;
  provider: string;
  account_id: string | null;
  generation: number;
  channel_credential_revision: number;
}
export interface ChannelReadResult {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}
export interface ChannelReadQuery extends PromiseLike<ChannelReadResult> {
  eq(key: string, value: unknown): ChannelReadQuery;
  is(key: string, value: null): ChannelReadQuery;
  order(key: string, options: { ascending: boolean }): ChannelReadQuery;
  limit(count: number): ChannelReadQuery;
  maybeSingle(): PromiseLike<ChannelReadResult>;
}
export interface ChannelDatabase {
  from(
    table: string,
  ): {
    select(
      columns: string,
      options?: { count?: "exact"; head?: boolean },
    ): ChannelReadQuery;
  };
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}
interface ServiceGate {
  enforced: { sending: boolean };
  organizationId?: string;
  state?: string;
  reason?: string;
}
export interface ChannelServiceDependencies {
  db: ChannelDatabase;
  resolveCredentials(
    db: ChannelDatabase,
    channel: RoutableChannel,
  ): Promise<ChannelCredentials>;
  resolveServiceGate(
    db: ChannelDatabase,
    unitId: string,
  ): Promise<ServiceGate | null>;
  clearServiceGateCache(): void;
  getProvider(provider: string): WhatsAppProviderAdapter | null;
  sendOutbound(
    provider: WhatsAppProviderName,
    credentials: ChannelCredentials,
    message: OutboundMessage,
    options?: SendTextOptions,
  ): Promise<SendResult>;
  now(): number;
  log(level: "info" | "warn" | "error", event: Record<string, unknown>): void;
}
type ChannelSelection = { ok: true; channel: RoutableChannel } | {
  ok: false;
  error: string;
};
export interface ScheduledChannelPins {
  id: string;
  unitId: string;
  provider: WhatsAppProviderName;
  bindingId: string;
  /** Binding generation, distinct from the account snapshot generation. */
  generation: number;
  credentialRevision: number;
  accountId: string | null;
}
export type ScheduledChannel =
  & ScheduledChannelPins
  & (
    | {
      transport: "text";
      sendText(message: OutboundMessage): Promise<SendResult>;
    }
    | {
      transport: "template";
      sendTemplate(input: TemplateSendInput): Promise<TemplateSendOutcome>;
    }
  );
export type ScheduledChannelResult = { ok: true; channel: ScheduledChannel } | {
  ok: false;
  error: string;
};

function isBindingRow(row: unknown): row is BindingRow {
  return typeof row === "object" && row !== null &&
    "id" in row && typeof row.id === "string" && row.id.length > 0 &&
    "channel_id" in row && typeof row.channel_id === "string" &&
    "unit_id" in row && typeof row.unit_id === "string" &&
    "provider" in row && typeof row.provider === "string" &&
    "account_id" in row &&
    (row.account_id === null ||
      (typeof row.account_id === "string" && row.account_id.length > 0)) &&
    "generation" in row && typeof row.generation === "number" &&
    Number.isSafeInteger(row.generation) && row.generation >= 1 &&
    "channel_credential_revision" in row &&
    typeof row.channel_credential_revision === "number" &&
    Number.isSafeInteger(row.channel_credential_revision) &&
    row.channel_credential_revision >= 0;
}

/** New pins are decoded explicitly; the legacy path retains DB pass-through. */
function isScheduledChannelRow(row: unknown): row is RoutableChannel {
  return typeof row === "object" && row !== null &&
    "id" in row && typeof row.id === "string" && row.id.length > 0 &&
    "unit_id" in row && typeof row.unit_id === "string" &&
    "provider" in row && typeof row.provider === "string" &&
    "is_active" in row &&
    (row.is_active === null || typeof row.is_active === "boolean") &&
    "credentials" in row &&
    (row.credentials === null ||
      (typeof row.credentials === "object" &&
        !Array.isArray(row.credentials))) &&
    "instance_token_secret_id" in row &&
    (row.instance_token_secret_id === null ||
      typeof row.instance_token_secret_id === "string") &&
    "status" in row &&
    (row.status === null || typeof row.status === "string") &&
    "last_health_check_at" in row &&
    (row.last_health_check_at === null ||
      typeof row.last_health_check_at === "string") &&
    "template_credential_revision" in row &&
    typeof row.template_credential_revision === "number" &&
    Number.isSafeInteger(row.template_credential_revision) &&
    row.template_credential_revision >= 0;
}

export function createWhatsAppChannelService(deps: ChannelServiceDependencies) {
  function withChannelRoute(
    result: SendResult,
    channel: { id: string; provider: string },
  ): SendResult {
    return {
      ...result,
      provider: channel.provider as WhatsAppProviderName,
      channelId: channel.id,
    };
  }

  /**
   * Canais já confirmados como conectados NESTA invocação.
   *
   * Não é o que evita rajada de consultas ao provedor — quem evita é o frescor de
   * 5 min da projeção, mantido pelo worker `process-whatsapp-channel-health`.
   * Cada mensagem de um lote chega como uma invocação HTTP separada de
   * `send-whatsapp`, então este cache só rende dentro de uma invocação que envie
   * mais de uma mensagem. Fica porque é barato e porque a alternativa (cachear
   * entre invocações) faria um isolate quente afirmar "conectado" sobre um canal
   * que caiu, sem nenhum horizonte definido.
   *
   * Guarda SÓ confirmações positivas. Uma recusa não é cacheada de propósito: se
   * o operador reconectar o aparelho no meio da invocação, a próxima mensagem
   * deve poder passar.
   */
  const connectedChannels = new Set<string>();

  function clearChannelConnectivityCache(): void {
    connectedChannels.clear();
  }

  /**
   * Persiste o snapshot observado. Best-effort: falha aqui NÃO altera a decisão
   * de envio já tomada — perder o carimbo custa uma consulta extra na próxima
   * mensagem, enquanto recusar por causa dele calaria um canal saudável.
   */
  async function persistChannelStatus(
    channel: RoutableChannel,
    status: string,
    errorCode: string | null,
    scheduled = false,
  ): Promise<void> {
    const { error } = await deps.db.rpc("record_whatsapp_channel_status", {
      p_unit_id: channel.unit_id,
      p_channel_id: channel.id,
      p_status: status,
      p_display_phone: null,
      p_error_code: errorCode,
      p_actor_id: null,
      p_request_id: null,
      p_event_type: null,
    });
    if (error) {
      deps.log("warn", {
        evt: "send_whatsapp_status_persist_failed",
        channel_id: channel.id,
        err: scheduled ? "scheduled_status_persist_failed" : error.message,
      });
    }
  }

  /**
   * Confirma que o canal está conectado ANTES de postar.
   *
   * FAIL-CLOSED, e a polaridade é oposta à do gate de billing
   * (`whatsapp-service-gate.ts`) de propósito. Lá, não conseguir ler o banco não
   * pode calar o WhatsApp de um cliente adimplente. Aqui, não conseguir
   * confirmar a conexão não autoriza empurrar mensagem para dentro da fila do
   * provedor: a Z-API aceita com 2xx enquanto a instância está fora do ar e
   * despeja tudo na reconexão — foi assim que 88 mensagens saíram em 2,5 minutos
   * em 2026-09-03, com risco de bloqueio do número do lojista pela Meta. Entre
   * atrasar um aviso e queimar o WhatsApp do restaurante, o lado seguro é não
   * postar.
   */
  async function ensureChannelConnected(
    channel: RoutableChannel,
    credentials: ChannelCredentials,
    scheduled = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!scheduled && connectedChannels.has(channel.id)) return { ok: true };

    const usability = decideChannelUsability({
      status: channel.status,
      lastHealthCheckAt: channel.last_health_check_at,
      now: deps.now(),
    });

    if (usability === "use") {
      connectedChannels.add(channel.id);
      return { ok: true };
    }

    if (usability === "refuse") {
      deps.log("warn", {
        evt: "send_whatsapp_channel_not_connected",
        channel_id: channel.id,
        provider: channel.provider,
        status: channel.status,
        source: "projection",
      });
      return { ok: false, error: "whatsapp_not_connected" };
    }

    // recheck — projeção velha demais para responder sozinha.
    //
    // `tryGet`, NÃO `getWhatsAppProvider`: este último é fail-closed por LANÇAR,
    // contrato certo para lifecycle/UI e errado aqui. `sendOutbound` devolve
    // `unknown_provider:<nome>` como `SendResult` para uma linha com provider
    // desconhecido, e trocar isso por uma exceção faria a EF responder 500
    // genérico no lugar de um erro nomeado — regressão de diagnóstico numa
    // função cujo contrato inteiro é devolver `SendResult`.
    const adapter = deps.getProvider(channel.provider);
    if (!adapter?.getConnectionStatus) {
      if (scheduled) {
        return { ok: false, error: "scheduled_provider_unsupported" };
      }
      // Provider desconhecido ou adapter sem observação de conexão: não há como
      // confirmar. Segue e deixa `sendOutbound` dar o veredito — recusar aqui
      // calaria um provider inteiro por uma capability que ele nunca prometeu, e
      // hoje nenhum adapter registrado cai neste caminho.
      deps.log("info", {
        evt: "send_whatsapp_status_unsupported",
        channel_id: channel.id,
        provider: channel.provider,
        known_provider: adapter !== null,
      });
      connectedChannels.add(channel.id);
      return { ok: true };
    }

    try {
      const snapshot = await adapter.getConnectionStatus(credentials);
      await persistChannelStatus(
        channel,
        snapshot.status,
        snapshot.status === "provider_error" || snapshot.status === "error"
          ? "SEND_STATUS_CHECK"
          : null,
        scheduled,
      );
      if (snapshot.status === "connected") {
        connectedChannels.add(channel.id);
        return { ok: true };
      }
      deps.log("warn", {
        evt: "send_whatsapp_channel_not_connected",
        channel_id: channel.id,
        provider: channel.provider,
        status: snapshot.status,
        source: "provider",
      });
      return { ok: false, error: "whatsapp_not_connected" };
    } catch (error) {
      deps.log("error", {
        evt: "send_whatsapp_status_check_failed",
        channel_id: channel.id,
        provider: channel.provider,
        err: scheduled
          ? "scheduled_status_check_failed"
          : String(error).slice(0, 200),
      });
      return { ok: false, error: "whatsapp_not_connected" };
    }
  }

  /**
   * Caminho único de despacho: resolve credencial, confirma conexão, posta.
   *
   * Os três pontos de resolução de canal (por `channel_id`, pela projeção ativa e
   * pelo fallback legado) convergem aqui — antes cada um repetia o bloco de
   * credenciais, e foi essa duplicação que deixou a checagem de conexão presente
   * em dois deles e ausente no terceiro.
   */
  async function dispatchToChannel(
    channel: RoutableChannel,
    phone: string,
    messageText: string,
    beforeOutbound?: (channel: RoutableChannel) => string | null,
    outboundOptions?: SendTextOptions,
    legacyAutomation?: LegacyAutomationIntent,
  ): Promise<SendResult> {
    // Credentials and revision come from ONE selected snapshot. Never replace
    // this revision with a fresher claim result while retaining old credentials.
    const credentialRevision = channel.template_credential_revision;
    if (legacyAutomation && (!Number.isSafeInteger(credentialRevision) || credentialRevision! < 0))
      return withChannelRoute({ ok: false, error: LEGACY_AUTOMATION_REFUSED }, channel);
    if (legacyAutomation) channel = { ...channel, credentials: { ...channel.credentials } };
    let credentials: ChannelCredentials;
    try {
      credentials = await deps.resolveCredentials(deps.db, channel);
    } catch (error) {
      deps.log("error", {
        evt: "send_whatsapp_credentials_unavailable",
        channel_id: channel.id,
        provider: channel.provider,
        err: legacyAutomation ? 'legacy_credentials_unavailable' : String(error),
      });
      return { ok: false, error: legacyAutomation ? LEGACY_AUTOMATION_REFUSED : "whatsapp_credentials_unavailable" };
    }

    let connectivity: Awaited<ReturnType<typeof ensureChannelConnected>>;
    try { connectivity = await ensureChannelConnected(channel, credentials); }
    catch (error) {
      if (!legacyAutomation) throw error;
      return withChannelRoute({ ok: false, error: LEGACY_AUTOMATION_REFUSED }, channel);
    }
    if (connectivity.ok === false) {
      return withChannelRoute(
        { ok: false, error: legacyAutomation ? LEGACY_AUTOMATION_REFUSED : connectivity.error },
        channel,
      );
    }

    if (legacyAutomation) {
      const guard = createLegacyAutomationPostGuard(deps.db);
      const claim = await guard.claim(legacyAutomation, channel.id, credentialRevision!);
      if (claim.allowed === false) return withChannelRoute({ ok: false, error: LEGACY_AUTOMATION_REFUSED }, channel);
      const message = { toPhone: phone, text: messageText };
      const provider = channel.provider as WhatsAppProviderName;
      // SQL posting is one-use. This is the FINAL await before the synchronous
      // existing guard and adapter. No cache/read/logging await enters this gap.
      const confirmed = await guard.confirm(claim, channel.id, credentialRevision!);
      if (confirmed.allowed === false) return withChannelRoute({ ok: false, error: LEGACY_AUTOMATION_REFUSED }, channel);
      let result: SendResult;
      try {
        const refusal = beforeOutbound?.(channel);
        if (refusal) {
          await guard.finish(claim, 'uncertain');
          return withChannelRoute({ ok: false, error: LEGACY_AUTOMATION_UNCERTAIN }, channel);
        }
        result = await deps.sendOutbound(provider, credentials, message, { retryPolicy: 'none' });
      } catch {
        await guard.finish(claim, 'uncertain');
        return withChannelRoute({ ok: false, error: LEGACY_AUTOMATION_UNCERTAIN }, channel);
      }
      // Preserve acceptance independently BEFORE notification/conversation I/O.
      const finished = await guard.finish(claim, result.ok ? 'accepted' : 'uncertain', result.providerMessageId);
      return withChannelRoute(finished === 'accepted' ? result
        : { ok: false, error: LEGACY_AUTOMATION_UNCERTAIN, providerMessageId: result.providerMessageId }, channel);
    }

    // Synchronous final guard: no await may separate this check from the
    // outbound adapter call. Manual Meta replies use it to enforce the 24h
    // deadline after credential and connectivity reads have completed.
    const outboundRefusal = beforeOutbound?.(channel);
    if (outboundRefusal) {
      return withChannelRoute({ ok: false, error: outboundRefusal }, channel);
    }

    return withChannelRoute(
      await deps.sendOutbound(
        channel.provider as WhatsAppProviderName,
        credentials,
        {
          toPhone: phone,
          text: messageText,
        },
        outboundOptions,
      ),
      channel,
    );
  }

  /** Colunas mínimas para `RoutableChannel` — uma lista só, três consultas. */
  const CHANNEL_COLUMNS =
    "id, unit_id, provider, credentials, instance_token_secret_id, status, last_health_check_at";

  async function selectChannel(
    channelIdOrUnitId?: { channel_id?: string; unit_id?: string },
    scheduled = false,
    legacyAutomation = false,
  ): Promise<ChannelSelection> {
    const selectColumns = scheduled
      ? CHANNEL_COLUMNS + ", is_active, template_credential_revision"
      : legacyAutomation ? CHANNEL_COLUMNS + ", template_credential_revision" : CHANNEL_COLUMNS;
    // Gate de serviço. Precisa de unit_id; quando só veio channel_id, resolve a
    // unit pelo canal primeiro (a consulta do canal já acontece logo abaixo, mas
    // o gate tem que vir ANTES de tocar no provedor — depois já custou dinheiro).
    let gateUnitId = channelIdOrUnitId?.unit_id ?? null;
    if (!gateUnitId && channelIdOrUnitId?.channel_id) {
      const { data: ch } = await deps.db
        .from("whatsapp_channels")
        .select("unit_id")
        .eq("id", channelIdOrUnitId.channel_id)
        .maybeSingle();
      // Existing DB projection contract; no extra runtime validation in legacy.
      gateUnitId = ((ch as { unit_id?: string } | null)?.unit_id) ?? null;
    }

    if (gateUnitId) {
      const gate = await deps.resolveServiceGate(deps.db, gateUnitId);
      if (gate?.enforced.sending) {
        deps.log("warn", {
          evt: "send_whatsapp_service_suspended",
          unit_id: gateUnitId,
          org: gate.organizationId,
          state: gate.state,
          reason: gate.reason,
        });
        return { ok: false, error: "whatsapp_service_suspended" };
      }
    }

    // Quando ambos channel_id e unit_id são fornecidos, exige que pertençam à
    // mesma unit — defesa contra envio cross-tenant se INTERNAL_API_KEY vazar.
    if (channelIdOrUnitId?.channel_id) {
      let q = deps.db
        .from("whatsapp_channels")
        .select(scheduled ? selectColumns : `${selectColumns}, is_active`)
        .eq("id", channelIdOrUnitId.channel_id);
      if (channelIdOrUnitId.unit_id) {
        q = q.eq("unit_id", channelIdOrUnitId.unit_id);
      }
      const { data: channelData, error: channelError } = await q.maybeSingle();
      // Preserve the old schema-guaranteed row pass-through (not an SDK cast).
      const channel = channelData as RoutableChannel | null;
      if (channelError) {
        deps.log("error", { evt: "send_whatsapp_channel_read_failed" });
        return { ok: false, error: "whatsapp_channel_unavailable" };
      }
      if (channel) {
        const { count: explicitActiveCount, error: activeCountError } =
          await deps.db
            .from("whatsapp_channels")
            .select("id", { count: "exact", head: true })
            .eq("unit_id", channel.unit_id)
            .eq("is_active", true);
        if (activeCountError) {
          deps.log("error", {
            evt: "send_whatsapp_active_projection_read_failed",
          });
          return { ok: false, error: "whatsapp_channel_unavailable" };
        }
        const explicitlyInactive = (explicitActiveCount ?? 0) > 0 &&
          channel.is_active !== true;
        if (explicitlyInactive || channel.is_active === false) {
          return { ok: false, error: "whatsapp_channel_inactive" };
        }
        // A checagem de conexão saiu daqui e virou parte do despacho. Antes ela
        // era `provider === "uazapi"`, isentando a Z-API por este caminho — a
        // porta por onde o envio para canal caído passava sem ser perguntado.
        return { ok: true, channel: channel };
      }
      // channel_id não encontrado/não pertence à unit informada — sem fallback.
      deps.log("warn", {
        evt: "send_whatsapp_channel_mismatch",
        channel_id: channelIdOrUnitId.channel_id,
        unit_id: channelIdOrUnitId.unit_id ?? null,
      });
      return { ok: false, error: "channel_mismatch" };
    }

    if (channelIdOrUnitId?.unit_id) {
      // Modelo explícito: somente a projeção ativa pode enviar. Se ela estiver
      // desconectada não caímos silenciosamente em um canal legado/antigo.
      // Sem `.eq("status","connected")` no filtro: a projeção deixou de ser
      // critério de SELEÇÃO e passou a ser critério de USO, decidido no despacho
      // junto com o frescor. Filtrar aqui esconderia o canal ativo caído atrás de
      // um `whatsapp_not_configured` — diagnóstico errado para quem investiga.
      const { data: activeData, error: activeChannelError } = await deps.db
        .from("whatsapp_channels")
        .select(selectColumns)
        .eq("unit_id", channelIdOrUnitId.unit_id)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      const activeChannel = activeData as RoutableChannel | null;

      if (activeChannelError) {
        deps.log("error", { evt: "send_whatsapp_active_channel_read_failed" });
        return { ok: false, error: "whatsapp_channel_unavailable" };
      }

      if (activeChannel) {
        return { ok: true, channel: activeChannel };
      }

      const { count: anyExplicitActive, error: explicitCountError } = await deps
        .db
        .from("whatsapp_channels")
        .select("id", { count: "exact", head: true })
        .eq("unit_id", channelIdOrUnitId.unit_id)
        .eq("is_active", true);

      if (explicitCountError) {
        deps.log("error", {
          evt: "send_whatsapp_active_projection_read_failed",
        });
        return { ok: false, error: "whatsapp_channel_unavailable" };
      }

      if ((anyExplicitActive ?? 0) === 0) {
        // Compatibilidade de rollout: somente linhas NULL participam do fallback
        // legado. `false` é sempre inativo, mesmo sem outra linha ativa.
        // `status='connected'` PERMANECE no filtro deste caminho, ao contrário do
        // anterior: aqui ele não decide uso, decide QUAL linha legada é a
        // candidata entre várias. Tirá-lo elegeria uma linha morta como fallback.
        const { data: legacyData, error: legacyChannelError } = await deps.db
          .from("whatsapp_channels")
          .select(selectColumns)
          .eq("unit_id", channelIdOrUnitId.unit_id)
          .is("is_active", null)
          .eq("status", "connected")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        const legacyChannel = legacyData as RoutableChannel | null;

        if (legacyChannelError) {
          deps.log("error", {
            evt: "send_whatsapp_legacy_channel_read_failed",
          });
          return { ok: false, error: "whatsapp_channel_unavailable" };
        }

        if (legacyChannel) {
          return { ok: true, channel: legacyChannel };
        }
      }
    }

    // Sem canal `connected` pra esta unit (ou nenhum identificador). SEM fallback
    // global: o antigo sendZApiLegacy (env ZAPI_*) mandava do número de OUTRA conta
    // — vazamento cross-tenant — e, quando as creds globais caducavam, devolvia um
    // 403 confuso. Retorna erro explícito pra UI/worker tratar (ex.: "configure o
    // canal em Plataforma → Automação").
    deps.log("warn", {
      evt: "send_whatsapp_not_configured",
      unit_id: channelIdOrUnitId?.unit_id ?? null,
    });
    return { ok: false, error: "whatsapp_not_configured" };
  }

  async function sendWhatsApp(
    phone: string,
    message: string,
    selector?: {
      channel_id?: string;
      unit_id?: string;
      beforeOutbound?: (channel: RoutableChannel) => string | null;
      outboundOptions?: SendTextOptions;
      legacyAutomation?: LegacyAutomationIntent;
    },
  ): Promise<SendResult> {
    let selected: ChannelSelection;
    try { selected = await selectChannel(selector, false, !!selector?.legacyAutomation); }
    catch (error) {
      if (!selector?.legacyAutomation) throw error;
      return { ok: false, error: LEGACY_AUTOMATION_REFUSED };
    }
    if (selected.ok === false) return selector?.legacyAutomation ? { ok: false, error: LEGACY_AUTOMATION_REFUSED } : selected;
    return dispatchToChannel(selected.channel, phone, message, selector?.beforeOutbound, selector?.outboundOptions, selector?.legacyAutomation);
  }

  /** Transport preparation only. SQL and the dispatcher retain POST authority. */
  async function resolveScheduledChannel(
    unitId: string,
    channelId?: string,
  ): Promise<ScheduledChannelResult> {
    // New invocations cannot inherit either positive service or connectivity proof.
    clearChannelConnectivityCache();
    deps.clearServiceGateCache();
    try {
      const selected = await selectChannel({
        unit_id: unitId,
        channel_id: channelId,
      }, true);
      if (selected.ok === false) return selected;
      const channel = selected.channel;
      if (
        !isScheduledChannelRow(channel) || channel.unit_id !== unitId ||
        (channelId && channel.id !== channelId)
      ) {
        return { ok: false, error: "scheduled_channel_unavailable" };
      }
      const adapter = deps.getProvider(channel.provider);
      if (!adapter || adapter.name !== channel.provider) {
        return { ok: false, error: "scheduled_provider_unsupported" };
      }
      const template = isMetaShapedProvider(channel.provider);
      if (
        template &&
        (!adapter.capabilities.templateMessages || !adapter.sendTemplate)
      ) {
        return { ok: false, error: "scheduled_provider_unsupported" };
      }
      if (!template && typeof adapter.sendText !== "function") {
        return { ok: false, error: "scheduled_provider_unsupported" };
      }
      const current = channel;
      const { data: binding, error: be } = await deps.db.from(
        "whatsapp_template_bindings",
      )
        .select(
          "id,channel_id,unit_id,provider,account_id,generation,channel_credential_revision",
        )
        .eq("channel_id", current.id).eq("unit_id", unitId).eq(
          "provider",
          current.provider,
        ).maybeSingle();
      if (
        be || !isBindingRow(binding) || binding.channel_id !== current.id ||
        binding.unit_id !== unitId || binding.provider !== current.provider ||
        typeof current.template_credential_revision !== "number" ||
        !Number.isSafeInteger(current.template_credential_revision) ||
        current.template_credential_revision < 0 ||
        binding.channel_credential_revision !==
          current.template_credential_revision ||
        (template ? !binding.account_id : binding.account_id !== null)
      ) {
        return { ok: false, error: "scheduled_binding_unavailable" };
      }
      let credentials: ChannelCredentials;
      try {
        credentials = await deps.resolveCredentials(deps.db, current);
      } catch {
        return { ok: false, error: "whatsapp_credentials_unavailable" };
      }
      const connectivity = await ensureChannelConnected(
        current,
        credentials,
        true,
      );
      if (connectivity.ok === false) return connectivity;
      const pins: ScheduledChannelPins = {
        id: current.id,
        unitId: current.unit_id,
        provider: adapter.name,
        bindingId: binding.id,
        generation: binding.generation,
        credentialRevision: binding.channel_credential_revision,
        accountId: binding.account_id,
      };
      if (template && adapter.sendTemplate) {
        const sendTemplate = adapter.sendTemplate;
        return {
          ok: true,
          channel: {
            ...pins,
            transport: "template",
            sendTemplate: (input) => sendTemplate(credentials, input),
          },
        };
      }
      return {
        ok: true,
        channel: {
          ...pins,
          transport: "text",
          sendText: (message) =>
            deps.sendOutbound(adapter.name, credentials, message, {
              retryPolicy: "none",
            }),
        },
      };
    } catch {
      // New preparation failures are local blocks. No exception/URL enters logs.
      return { ok: false, error: "scheduled_channel_unavailable" };
    }
  }

  /** Returns current pins. Task 9 compares historical pins and confirms SQL
   * authority immediately before invoking only this preparation's capability. */
  async function prepareScheduledChannel(
    channelId: string,
    unitId: string,
  ): Promise<ScheduledChannelResult> {
    return resolveScheduledChannel(unitId, channelId);
  }
  return {
    sendWhatsApp,
    clearChannelConnectivityCache,
    resolveScheduledChannel,
    prepareScheduledChannel,
  };
}
