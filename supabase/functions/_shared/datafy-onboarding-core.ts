/**
 * Núcleo PURO do onboarding self-service do parceiro Datafy.
 *
 * ZERO imports — importável pelas Edge Functions, pelo vitest e pelo FRONTEND
 * (`classifyConnectMessage` é lido direto de `supabase/functions/_shared/`,
 * cross-boundary deliberado, mesmo motivo de `whatsapp-implementation-core.ts`).
 * Um import de https://esm.sh/..., mesmo só de tipo, quebra a resolução do
 * Vite. Por isso o núcleo NÃO importa o cliente `datafy-admin-client.ts`: as
 * entradas são estruturais e mínimas, e o adapter (`manage-channels`) converte
 * o snapshot do GET.
 *
 * **Falha fechada em campo malformado.** O adapter nunca passa por type-check
 * (sem Deno local; o `tsc -b` não alcança `supabase/functions/`), então um nome
 * de campo errado chega aqui como `undefined`. Toda decisão que apaga canal,
 * emite link ou assina exige evidência POSITIVA e estrita: `found === true`,
 * `subscribed === false`, `phoneNumberId === null`. Qualquer outra forma conta
 * como "não sei" e recusa, ou como "comprometido" e nunca é apagada.
 *
 * Nenhuma decisão lê relógio: o único tempo usado é o `trialEndsAt` que o
 * chamador passa (string do GET da Datafy), e só para ordenar candidatos.
 * Posse de claim e TTL vivem no SQL (`claim_datafy_onboarding_step`).
 *
 * Regras medidas ao vivo na Fase 0
 * (docs/superpowers/specs/2026-10-13-datafy-parceiro-validacao-fase0.md §4).
 */

export type OnboardingState =
  | "open"
  | "channel_created"
  | "webhook_ready"
  | "connected"
  | "completed"
  | "abandoned";

/** Estado do canal na Datafy, lido pelo adapter num GET. Nunca vem do navegador. */
export interface RemoteChannelState {
  found: boolean; // false = o GET devolveu 404 (canal apagado na Datafy)
  phoneNumberId: string | null;
  subscribed: boolean;
  onTrial: boolean;
}

/** String com conteúdo. Campo de identidade vazio não identifica nada. */
function isFilled(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * "Pode ter número": tudo que não seja EXATAMENTE `null` — inclusive
 * `undefined` (campo com nome errado no adapter), `""` e não-string. Usado nas
 * decisões que DESTROEM ou EXPÕEM (apagar canal, emitir link): na dúvida, o
 * canal é tratado como conectado.
 */
function mayHavePhoneNumber(phoneNumberId: unknown): boolean {
  return phoneNumberId !== null;
}

// ─── start ──────────────────────────────────────────────────────────────────

export type StartStepDecision =
  | {
      kind: "refuse";
      code:
        | "GRANT_REQUIRED"
        | "PROVISIONING_BLOCKED"
        | "UNIT_ALREADY_ACTIVE"
        | "ONBOARDING_CLOSED"
        | "REMOTE_STATE_REQUIRED";
    }
  | { kind: "open_onboarding" }
  | { kind: "create_channel" }
  | { kind: "recreate_channel"; reason: "trial_expired" | "channel_missing" }
  | { kind: "create_webhook" }
  | { kind: "issue_link" }
  | { kind: "go_confirm" };

/**
 * O que o `start` deve fazer a seguir. Decide pelo GET (Fase 0, §4 itens 2 e 3),
 * nunca pelo 409 do link:
 * - canal com número → prepara webhook se ainda faltar, depois `go_confirm` (link de canal conectado reabre o Embedded
 *   Signup e troca o número; nunca é emitido). Vem ANTES do teste de trial: canal
 *   com número também nunca é recriado;
 * - canal sem número, `subscribed === false` e `onTrial === false` →
 *   `recreate_channel` (o link seria recusado; apagar e recriar canal nunca
 *   assinado não custa nada);
 * - canal sumido (`found === false`, 404) → `recreate_channel`.
 * Ordem: liberação → gates → unidade ativa → estado. Nenhum passo avança sem
 * liberação e gates.
 *
 * `onboarding` é o onboarding ABERTO da unidade (não `completed`/`abandoned`),
 * ou `null` quando não há nenhum aberto. Passar um fechado devolve
 * `ONBOARDING_CLOSED`, nunca `open_onboarding`.
 *
 * `channel_created`/`webhook_ready` exigem `remote` bem formado E
 * `datafyChannelId`: sem o id gravado, o GET não pode ser deste onboarding (o
 * mesmo UPDATE grava id e estado, então é estado impossível); `found`,
 * `subscribed` ou `onTrial` que não sejam boolean → `REMOTE_STATE_REQUIRED`.
 * `datafyWebhookId` não decide: a criação do webhook é idempotente por leitura
 * no adapter.
 */
export function decideStartStep(input: {
  grantActive: boolean;
  gatesAllowed: boolean; // resolveWhatsAppGateByUnit + checkChannelConnectionAllowance
  unitHasActiveChannel: boolean;
  onboarding: { state: OnboardingState; datafyChannelId: string | null; datafyWebhookId: string | null } | null;
  remote: RemoteChannelState | null; // obrigatório em channel_created/webhook_ready; o adapter faz o GET antes
}): StartStepDecision {
  if (input.grantActive !== true) return { kind: "refuse", code: "GRANT_REQUIRED" };
  if (input.gatesAllowed !== true) return { kind: "refuse", code: "PROVISIONING_BLOCKED" };
  if (input.unitHasActiveChannel !== false) return { kind: "refuse", code: "UNIT_ALREADY_ACTIVE" };

  const onboarding = input.onboarding;
  if (!onboarding) return { kind: "open_onboarding" };

  switch (onboarding.state) {
    case "completed":
    case "abandoned":
      return { kind: "refuse", code: "ONBOARDING_CLOSED" };
    case "open":
      return { kind: "create_channel" };
    case "connected":
      return { kind: "go_confirm" };
    case "channel_created":
    case "webhook_ready": {
      const remote = input.remote;
      if (!remote || !isFilled(onboarding.datafyChannelId)) {
        return { kind: "refuse", code: "REMOTE_STATE_REQUIRED" };
      }
      if (remote.found === false) return { kind: "recreate_channel", reason: "channel_missing" };
      if (remote.found !== true) return { kind: "refuse", code: "REMOTE_STATE_REQUIRED" };
      if (mayHavePhoneNumber(remote.phoneNumberId)) {
        return onboarding.state === "channel_created" ? { kind: "create_webhook" } : { kind: "go_confirm" };
      }
      if (typeof remote.subscribed !== "boolean" || typeof remote.onTrial !== "boolean") {
        return { kind: "refuse", code: "REMOTE_STATE_REQUIRED" };
      }
      if (remote.subscribed === false && remote.onTrial === false) {
        return { kind: "recreate_channel", reason: "trial_expired" };
      }
      return onboarding.state === "channel_created" ? { kind: "create_webhook" } : { kind: "issue_link" };
    }
    default:
      // Estado fora do CHECK da migration: recusar é o único lado seguro.
      return { kind: "refuse", code: "ONBOARDING_CLOSED" };
  }
}

/**
 * Canal remoto que pode ser apagado sem perder nada: `subscribed === false` E
 * `phoneNumberId === null`, ambos estritos (campo ausente não é prova de nada).
 * Único predicado que autoriza `deleteChannel` (Fase 0: o `DELETE` de canal
 * nunca assinado e sem número devolve 200; com número ou assinado não foi
 * medido e não é feito).
 */
export function isDisposableRemoteChannel(channel: { subscribed: boolean; phoneNumberId: string | null }): boolean {
  return channel.subscribed === false && channel.phoneNumberId === null;
}

// ─── reconciliação do create_channel ────────────────────────────────────────

export type ChannelReconciliation =
  | { kind: "absent" }
  | { kind: "adopt"; channelId: string; discard: string[] }
  | { kind: "ambiguous" };

/** Instante do fim do trial; nulo ou inválido conta como o menor possível. */
function trialEndsAtMs(value: string | null): number {
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Reconciliação do `create_channel` incerto (Fase 0, §4 item 1). `name` não é
 * único e a listagem não tem `created_at`.
 * Candidatos = `name === reservedChannelId` (exato). 0 → absent. Comprometido =
 * tudo que `isDisposableRemoteChannel` não aprova (assinado, com número, ou com
 * `subscribed`/`phoneNumberId` malformado). Mais de um comprometido → ambiguous
 * (nunca apaga comprometido). Um comprometido → adota-o. Nenhum comprometido →
 * adota o de maior `trialEndsAt` (mais trial; data inválida ou nula conta como
 * a menor), empate pelo menor `id`. `discard` = os demais candidatos, todos
 * descartáveis por construção.
 *
 * "Por construção" é literal: com dois ids comprometidos a função já devolveu
 * `ambiguous`, então todo id que sobra fora do adotado é descartável. Id
 * repetido na listagem é o MESMO canal remoto, então ele conta como
 * comprometido se QUALQUER entrada dele for — listagem inconsistente nunca
 * vira `DELETE` de canal conectado. Comparação de id por código de unidade
 * (`<`), nunca `localeCompare`, que depende de locale.
 */
export function decideChannelReconciliation(input: {
  reservedChannelId: string;
  channels: { id: string; name: string; subscribed: boolean; phoneNumberId: string | null; trialEndsAt: string | null }[];
}): ChannelReconciliation {
  const candidates = input.channels.filter((channel) => channel.name === input.reservedChannelId);
  if (candidates.length === 0) return { kind: "absent" };

  const committedIds = new Set(
    input.channels.filter((channel) => !isDisposableRemoteChannel(channel)).map((channel) => channel.id),
  );
  const candidateIds = [...new Set(candidates.map((channel) => channel.id))];
  const committedCandidateIds = candidateIds.filter((id) => committedIds.has(id));
  if (committedCandidateIds.length > 1) return { kind: "ambiguous" };

  let adoptedId: string;
  if (committedCandidateIds.length === 1) {
    adoptedId = committedCandidateIds[0];
  } else {
    let best = candidates[0];
    for (const channel of candidates.slice(1)) {
      const diff = trialEndsAtMs(channel.trialEndsAt) - trialEndsAtMs(best.trialEndsAt);
      // -Infinity - -Infinity é NaN: dois nulos/inválidos empatam e caem no id.
      const tied = Number.isNaN(diff) || diff === 0;
      if (diff > 0 || (tied && channel.id < best.id)) best = channel;
    }
    adoptedId = best.id;
  }

  return { kind: "adopt", channelId: adoptedId, discard: candidateIds.filter((id) => id !== adoptedId) };
}

export type AdoptedCredentialsDecision =
  | { kind: "use"; token: string; webhookSecret: string }
  | { kind: "discard_and_recreate" }
  | { kind: "refuse"; code: "DATAFY_CREDENTIALS_UNAVAILABLE" };

/**
 * Credenciais do canal adotado, lidas do GET. Sem token ou secret: descartável
 * (pelo predicado estrito) → apagar e recriar; qualquer outra forma → recusa
 * para o admin. Os valores passam intactos (credencial não se normaliza); só
 * string com conteúdo serve.
 */
export function decideAdoptedCredentials(snapshot: {
  subscribed: boolean;
  phoneNumberId: string | null;
  token: string | null;
  webhookSecret: string | null;
}): AdoptedCredentialsDecision {
  if (isFilled(snapshot.token) && isFilled(snapshot.webhookSecret)) {
    return { kind: "use", token: snapshot.token, webhookSecret: snapshot.webhookSecret };
  }
  if (isDisposableRemoteChannel(snapshot)) return { kind: "discard_and_recreate" };
  return { kind: "refuse", code: "DATAFY_CREDENTIALS_UNAVAILABLE" };
}

// ─── confirm ────────────────────────────────────────────────────────────────

export type ConfirmDecision =
  | { kind: "not_connected_yet" }
  | {
      kind: "refuse";
      code:
        | "GRANT_REQUIRED"
        | "PROVISIONING_BLOCKED"
        | "REMOTE_CHANNEL_MISSING"
        | "REMOTE_STATE_REQUIRED"
        | "REMOTE_IDENTITY_INCOMPLETE"
        | "PHONE_NUMBER_ALREADY_BOUND"
        | "WABA_OWNED_BY_OTHER_ORG";
    }
  | { kind: "create_channel_row"; phoneNumberId: string; wabaId: string; businessId: string | null };

/** Id de identidade utilizável como está: string com conteúdo e sem espaço nas bordas. */
function isExactIdentity(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

/**
 * Valida o GET da Datafy contra o que o `confirm` exige. Nada vem do navegador.
 * Liberação e gates vêm ANTES de olhar o `remote`: criar a linha do canal é o
 * primeiro passo que vira custo (a assinatura segue logo depois), e a regra
 * mora aqui, no núcleo testado, não no handler.
 *
 * **Sem checagem de Coexistence (Fase 0, §4 item 5, decidido em 2026-10-14):**
 * o GET não traz o campo, e o `coexistence` do `postMessage` não é fonte
 * confiável. A prova de Coexistence é o eco do aparelho, exigido para ativar
 * (`manual_echo_verified_at`). Número sem app é assinado (custo que a
 * liberação já autorizava), nunca produz eco e nunca ativa. O tipo da entrada
 * não tem campo de Coexistence de propósito — há teste de compilação.
 *
 * `wabaId` é obrigatório: sem ele a unicidade de WABA entre organizações não se
 * verifica. `phoneNumberId === null` → ainda não conectou; qualquer outra forma
 * que não seja id exato (vazio, não-string, espaço nas bordas) → identidade
 * incompleta: a âncora de `metaPayloadMatchesChannel` nunca nasce malformada.
 * Espaço nas bordas é RECUSADO, não aparado, porque o adapter calcula as duas
 * colisões a partir do valor cru: aparar aqui gravaria um valor diferente do
 * que foi checado. `businessId` não entra em unicidade e é aparado (vazio →
 * `null`).
 *
 * `phoneNumberIdTakenByOtherChannel` tem de ser calculado EXCLUINDO a linha com
 * `id = reserved_channel_id`: um retry depois de "linha inserida, update do
 * onboarding falhou" não pode se recusar contra a própria linha. As duas
 * colisões falham fechado: qualquer valor que não seja `false` recusa.
 */
export function decideConfirm(input: {
  grantActive: boolean;
  gatesAllowed: boolean;
  remote: { found: boolean; phoneNumberId: string | null; wabaId: string | null; businessId: string | null };
  phoneNumberIdTakenByOtherChannel: boolean;
  wabaOwnedByOtherOrganization: boolean;
}): ConfirmDecision {
  if (input.grantActive !== true) return { kind: "refuse", code: "GRANT_REQUIRED" };
  if (input.gatesAllowed !== true) return { kind: "refuse", code: "PROVISIONING_BLOCKED" };

  const remote = input.remote;
  if (remote.found === false) return { kind: "refuse", code: "REMOTE_CHANNEL_MISSING" };
  if (remote.found !== true) return { kind: "refuse", code: "REMOTE_STATE_REQUIRED" };
  if (remote.phoneNumberId === null) return { kind: "not_connected_yet" };
  if (!isExactIdentity(remote.phoneNumberId) || !isExactIdentity(remote.wabaId)) {
    return { kind: "refuse", code: "REMOTE_IDENTITY_INCOMPLETE" };
  }
  if (input.phoneNumberIdTakenByOtherChannel !== false) {
    return { kind: "refuse", code: "PHONE_NUMBER_ALREADY_BOUND" };
  }
  if (input.wabaOwnedByOtherOrganization !== false) {
    return { kind: "refuse", code: "WABA_OWNED_BY_OTHER_ORG" };
  }
  return {
    kind: "create_channel_row",
    phoneNumberId: remote.phoneNumberId,
    wabaId: remote.wabaId,
    businessId: isFilled(remote.businessId) ? remote.businessId.trim() : null,
  };
}

// ─── assinatura ─────────────────────────────────────────────────────────────

/**
 * Situação da liberação vista pelo passo de assinatura:
 * - `active`: não revogada e não consumida — paga UMA assinatura nova;
 * - `consumed_by_this_channel`: já consumida por ESTE canal (reexecução depois
 *   de a liberação ter sido consumida e o resto da finalização ter falhado);
 * - `none`: revogada, consumida por outro canal, ou inexistente.
 */
export type SubscribeGrantState = "active" | "consumed_by_this_channel" | "none";

export type SubscribeStepDecision =
  | { kind: "already_subscribed" }
  | { kind: "record_subscription"; code: "GRANT_REQUIRED" | "PROVISIONING_BLOCKED" }
  | { kind: "subscribe" }
  | {
      kind: "refuse";
      code: "GRANT_REQUIRED" | "PROVISIONING_BLOCKED" | "REMOTE_CHANNEL_MISSING" | "REMOTE_STATE_REQUIRED";
    };

/**
 * Assinatura, decidida pelo GET feito DEPOIS do claim de `subscribe` (nunca por
 * um GET anterior ao claim). `found`/`subscribed` têm de ser boolean.
 *
 * Canal JÁ assinado na Datafy (`subscribed === true`) é fato consumado — o
 * custo existe, e um POST anterior incerto pode tê-lo criado. Por isso nunca
 * é recusado, só se decide o que finalizar:
 * - liberação `active` ou `consumed_by_this_channel` e gates liberados →
 *   `already_subscribed`: finaliza normalmente (consumir liberação já
 *   consumida por este canal é no-op);
 * - liberação `none` (revogada no meio do caminho) ou gates negados →
 *   `record_subscription`: o adapter grava `provider_subscribed_at` a partir
 *   do GET e libera o claim com `reconciled_present`, mas NÃO consome a
 *   liberação (revogada não pode ser consumida: CHECK da migration), NÃO pede
 *   ativação e NÃO conclui o onboarding; avisa o admin, que decide entre
 *   cancelar a assinatura ou liberar de novo. `code` diz qual guarda faltou.
 *
 * Canal NÃO assinado (`subscribed === false`): só `subscribe` com liberação
 * `active` e gates liberados. Liberação já consumida não paga outra
 * assinatura; qualquer outro caso recusa — nunca `subscribe`.
 */
export function decideSubscribeStep(input: {
  grant: SubscribeGrantState;
  gatesAllowed: boolean;
  remote: { found: boolean; subscribed: boolean };
}): SubscribeStepDecision {
  const remote = input.remote;
  if (remote.found === false) return { kind: "refuse", code: "REMOTE_CHANNEL_MISSING" };
  if (remote.found !== true || typeof remote.subscribed !== "boolean") {
    return { kind: "refuse", code: "REMOTE_STATE_REQUIRED" };
  }
  const gatesAllowed = input.gatesAllowed === true;

  if (remote.subscribed === true) {
    const grantCovers = input.grant === "active" || input.grant === "consumed_by_this_channel";
    if (grantCovers && gatesAllowed) return { kind: "already_subscribed" };
    return { kind: "record_subscription", code: grantCovers ? "PROVISIONING_BLOCKED" : "GRANT_REQUIRED" };
  }

  if (input.grant !== "active") return { kind: "refuse", code: "GRANT_REQUIRED" };
  if (!gatesAllowed) return { kind: "refuse", code: "PROVISIONING_BLOCKED" };
  return { kind: "subscribe" };
}

// ─── janela de conexão (navegador) ──────────────────────────────────────────

/** Origem medida na Fase 0 (§3). Comparação por IGUALDADE, nunca prefixo. */
export const DATAFY_CONNECT_ORIGIN = "https://app.datafyapi.com.br";

export type ConnectMessageKind = "connected" | "connected_without_app" | "error" | "ignore";

/**
 * Valida o MessageEvent do navegador. Não devolve dado ao backend: o evento só
 * dispara o `confirm`, que relê tudo do GET.
 * `origin` por igualdade exata (`startsWith` aceitaria
 * `https://app.datafyapi.com.br.evil.com`); `data` precisa ser objeto não-nulo
 * com `source === "datafy"`.
 * `connected_without_app` ⇔ `data.data.coexistence === false` (boolean
 * estrito): serve só à UI, que avisa e não chama o `confirm` sozinha. Ausência
 * do campo, ou valor não-boolean, conta como `connected`; o GET decide o resto.
 */
export function classifyConnectMessage(event: { origin: string; data: unknown }): ConnectMessageKind {
  if (event.origin !== DATAFY_CONNECT_ORIGIN) return "ignore";
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "ignore";
  const message = data as Record<string, unknown>;
  if (message.source !== "datafy") return "ignore";

  if (message.event === "connected") {
    const detail = message.data;
    if (typeof detail === "object" && detail !== null && (detail as Record<string, unknown>).coexistence === false) {
      return "connected_without_app";
    }
    return "connected";
  }
  if (message.event === "error") return "error";
  return "ignore";
}

// ─── checklist ──────────────────────────────────────────────────────────────

export type OfficialChecklistStep =
  | "not_granted"
  | "ready_to_connect"
  | "connecting"
  | "subscription_pending"
  | "awaiting_echo"
  | "active";

/**
 * Ids estáveis dos itens, nesta ordem (o front mapeia id → copy). Cada item é
 * monotônico em relação ao anterior:
 * - `granted`: a unidade foi liberada — liberação ativa, ou já consumida por um
 *   canal (a linha do canal existe);
 * - `channel_created`: o canal existe na Datafy — onboarding em
 *   `channel_created` ou adiante (inclusive `completed`), ou a linha do canal
 *   existe;
 * - `webhook_ready`: webhook cadastrado — onboarding em `webhook_ready`,
 *   `connected` ou `completed`, ou a linha do canal existe;
 * - `number_connected`: a linha de `whatsapp_channels` existe, o que só
 *   acontece com `phone_number_id` vindo do GET (âncora do §5.3);
 * - `subscribed`: `provider_subscribed_at` gravado;
 * - `echo_verified`: `manual_echo_verified_at` gravado (prova de Coexistence);
 * - `active`: `is_active = true`.
 */
export const OFFICIAL_CHECKLIST_ITEM_IDS = [
  "granted",
  "channel_created",
  "webhook_ready",
  "number_connected",
  "subscribed",
  "echo_verified",
  "active",
] as const;

export type OfficialChecklistItemId = (typeof OFFICIAL_CHECKLIST_ITEM_IDS)[number];

export interface OfficialChecklist {
  step: OfficialChecklistStep;
  items: { id: OfficialChecklistItemId; done: boolean }[];
  templatesPending: boolean;
}

const LIVE_ONBOARDING_STATES: ReadonlySet<OnboardingState> = new Set([
  "open",
  "channel_created",
  "webhook_ready",
  "connected",
]);

const CHANNEL_CREATED_STATES: ReadonlySet<OnboardingState> = new Set([
  "channel_created",
  "webhook_ready",
  "connected",
  "completed",
]);

const WEBHOOK_READY_STATES: ReadonlySet<OnboardingState> = new Set(["webhook_ready", "connected", "completed"]);

/**
 * Checklist mostrado ao lojista e ao admin, derivado só de estado persistido.
 * `step` é a PRIMEIRA etapa não cumprida:
 * - com linha do canal: sem `subscribedAt` → `subscription_pending` (vence até
 *   canal ativo: sem assinatura, o fim do trial para a entrega); sem eco ou
 *   inativo → `awaiting_echo`; senão `active`. A linha do canal vence a
 *   liberação, que é consumida justamente quando a assinatura confirma;
 * - sem linha: sem liberação → `not_granted`, mesmo com onboarding vivo
 *   (nada avança sem ela, e o `start` recusaria); onboarding vivo →
 *   `connecting`; senão → `ready_to_connect`.
 * `status` é ignorado DE PROPÓSITO: o checklist é de progresso, `provider_error`
 * não é queda do número, e a UI mostra o status de conexão à parte.
 * `activationRequestedAt` também não muda o progresso (detalhe do painel).
 * `templatesPending = !automationDispatchAdopted`.
 */
export function deriveOfficialChecklist(input: {
  grantActive: boolean;
  onboardingState: OnboardingState | null;
  channel: {
    status: string | null;
    isActive: boolean | null;
    subscribedAt: string | null;
    echoVerifiedAt: string | null;
    activationRequestedAt: string | null;
  } | null;
  automationDispatchAdopted: boolean;
}): OfficialChecklist {
  const channel = input.channel ?? null;
  const hasChannel = channel !== null;
  const grantActive = input.grantActive === true;
  const state = input.onboardingState ?? null;
  const onboardingLive = state !== null && LIVE_ONBOARDING_STATES.has(state);
  const subscribed = hasChannel && isFilled(channel.subscribedAt);
  const echoVerified = hasChannel && isFilled(channel.echoVerifiedAt);
  const active = hasChannel && channel.isActive === true;

  let step: OfficialChecklistStep;
  if (hasChannel) {
    if (!subscribed) step = "subscription_pending";
    else if (!echoVerified || !active) step = "awaiting_echo";
    else step = "active";
  } else if (!grantActive) {
    step = "not_granted";
  } else if (onboardingLive) {
    step = "connecting";
  } else {
    step = "ready_to_connect";
  }

  const done: Record<OfficialChecklistItemId, boolean> = {
    granted: grantActive || hasChannel,
    channel_created: hasChannel || (state !== null && CHANNEL_CREATED_STATES.has(state)),
    webhook_ready: hasChannel || (state !== null && WEBHOOK_READY_STATES.has(state)),
    number_connected: hasChannel,
    subscribed,
    echo_verified: echoVerified,
    active,
  };

  return {
    step,
    items: OFFICIAL_CHECKLIST_ITEM_IDS.map((id) => ({ id, done: done[id] })),
    templatesPending: input.automationDispatchAdopted !== true,
  };
}
