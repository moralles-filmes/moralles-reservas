/**
 * Núcleo PURO da resolução de entitlements por feature (system | whatsapp | ai).
 *
 * ZERO dependências (sem Deno, sem supabase-js) — importável tanto pelas Edge
 * Functions (via _shared/entitlements.ts) quanto pelo vitest do frontend
 * (src/lib/entitlements-core.test.ts), garantindo que a prioridade de acesso
 * seja testada em CI.
 *
 * Prioridade (spec §12, decisão 2026-07-16):
 *   1. Bloqueio administrativo explícito (override enabled=false)
 *   2. Override vitalício/administrativo (enabled=true)
 *   3. Assinatura paga (status active|trialing|past_due — past_due mantém
 *      acesso durante a tolerância; a suspensão D+6 é aplicada pelos workers,
 *      que mudam o status da assinatura/org)
 *   4. Trial (org-level, SOMENTE feature system)
 *   5. Sem acesso
 *
 * IA (pré vs pós carteira):
 *   - Plano com `includedFeatures` não vazio (modelo de dois planos) GOVERNA a
 *     IA pela declaração: concede se declara `ai`, nega (`not_included`) se
 *     não declara. Nunca herda `system`.
 *   - Trial nunca concede IA (`trial_no_ai`).
 *   - aiWalletBalanceCents === undefined → carteira ainda não implantada
 *     (pré-Fase 7) e plano LEGADO (sem declaração): ai herda o resultado de
 *     system (mundo BYOK atual).
 *   - aiWalletBalanceCents number|null → carteira implantada: ai exige
 *     (override de ai) OU (system permitido E saldo > 0). Override de system
 *     NÃO libera ai automaticamente (cenário 26 da spec).
 *   - Plano que declara `ai` resolve por FRANQUIA (`source: "franchise"`), com
 *     `status: within_budget | budget_exhausted`. Franquia é teto financeiro
 *     interno da plataforma — nunca crédito comprado pelo cliente, e por isso
 *     `budgetRemainingCents` é campo próprio, não `balanceCents`.
 */

export type EntitlementFeature = "system" | "whatsapp" | "ai";

export type EntitlementSource =
  | "admin_block"
  | "override"
  | "subscription"
  /** Franquia de IA inclusa no plano (Plano D). NÃO é crédito do cliente. */
  | "franchise"
  | "trial"
  | "wallet"
  | "legacy"
  | "none";

export type EntitlementGrantType = "LIFETIME" | "TEMPORARY" | "PROMOTIONAL" | "MANUAL_OVERRIDE";

export interface EntitlementOverrideInput {
  feature: EntitlementFeature;
  enabled: boolean;
  grant_type: EntitlementGrantType;
  starts_at: string;
  ends_at: string | null;
  revoked_at: string | null;
}

export interface EntitlementSubscriptionInput {
  /** billing_subscriptions.status: active|trialing|past_due|canceled|unpaid|paused */
  status: string;
  /** billing_plans.category do plano da assinatura */
  category: string;
  current_period_end: string | null;
  /**
   * billing_plans.included_features — features declaradas pelo PLANO.
   * Ausente ou vazio => plano LEGADO: resolve só por categoria e a IA mantém
   * a herança histórica.
   * Não vazio => plano NOVO: a declaração GOVERNA e substitui a herança.
   *
   * NÃO confundir com billing_plans.features (copy de marketing).
   */
  includedFeatures?: string[];
}

/**
 * Estado do orçamento de franquia do ciclo corrente (Plano D, spec §17.3).
 *
 * OPCIONAL de propósito: o caller que só quer saber "esta organização tem IA?"
 * (catálogo, painel administrativo) não paga uma leitura de orçamento, e o
 * resultado continua `allowed: true`. Só quem vai efetivamente gastar carrega
 * o estado.
 */
export interface AiFranchiseInput {
  state: "OPEN" | "EXHAUSTED" | "CLOSED";
  /** limit − settled − comprometido. NUNCA vai ao frontend do lojista (§18.4). */
  remainingCents: number;
}

export interface EntitlementInputs {
  /** Injetável nos testes; default = agora. */
  now?: string | Date;
  /** organizations.billing_status */
  billingStatus: string;
  /** organizations.trial_ends_at */
  trialEndsAt: string | null;
  overrides: EntitlementOverrideInput[];
  subscriptions: EntitlementSubscriptionInput[];
  /** Ver doc do módulo: undefined = pré-carteira (ai herda system). */
  aiWalletBalanceCents?: number | null;
  /** Plano D: orçamento do ciclo. Ausente = não consultado, não "esgotado". */
  aiFranchise?: AiFranchiseInput;
}

export interface FeatureEntitlement {
  allowed: boolean;
  source: EntitlementSource;
  /** Detalhe machine-readable: grant_type, status da sub, 'trialing', 'no_credits', 'none'... */
  status: string;
  expiresAt: string | null;
  /** Só ai com carteira implantada. */
  balanceCents?: number;
  /**
   * Só ai por franquia. Campo PRÓPRIO — `balanceCents` significa "crédito do
   * cliente", e franquia não é crédito do cliente. NUNCA vai ao frontend do
   * lojista: caminho de resposta separado, não filtragem pós-montagem (§18.4).
   */
  budgetRemainingCents?: number;
}

export interface OrgEntitlements {
  system: FeatureEntitlement;
  whatsapp: FeatureEntitlement;
  ai: FeatureEntitlement;
}

/** Assinatura nesses status mantém o serviço (tolerância inclusa). */
const ALLOWED_SUB_STATUSES = new Set(["active", "trialing", "past_due"]);

/** Categoria de plano que concede cada feature via assinatura. */
const FEATURE_CATEGORIES: Record<EntitlementFeature, string[]> = {
  system: ["SYSTEM_SUBSCRIPTION"],
  whatsapp: ["WHATSAPP_SUBSCRIPTION"],
  ai: [], // IA nunca é concedida por assinatura — é carteira (ou override)
};

function toMs(value: string | Date | undefined): number {
  if (value === undefined) return Date.now();
  return typeof value === "string" ? new Date(value).getTime() : value.getTime();
}

function isOverrideValid(o: EntitlementOverrideInput, nowMs: number): boolean {
  if (o.revoked_at) return false;
  if (new Date(o.starts_at).getTime() > nowMs) return false;
  if (o.ends_at && new Date(o.ends_at).getTime() <= nowMs) return false;
  return true;
}

function resolveFeature(
  feature: EntitlementFeature,
  inputs: EntitlementInputs,
  nowMs: number,
): FeatureEntitlement {
  const valid = inputs.overrides.filter(
    (o) => o.feature === feature && isOverrideValid(o, nowMs),
  );

  // 1. Bloqueio administrativo explícito vence tudo
  const block = valid.find((o) => !o.enabled);
  if (block) {
    return { allowed: false, source: "admin_block", status: "admin_block", expiresAt: block.ends_at };
  }

  // 2. Override de concessão — preferir o mais duradouro (LIFETIME/ends_at null primeiro)
  const grants = valid
    .filter((o) => o.enabled)
    .sort((a, b) => {
      if (a.ends_at === null && b.ends_at !== null) return -1;
      if (a.ends_at !== null && b.ends_at === null) return 1;
      if (a.ends_at === null && b.ends_at === null) return 0;
      return new Date(b.ends_at!).getTime() - new Date(a.ends_at!).getTime();
    });
  if (grants.length > 0) {
    const g = grants[0];
    return { allowed: true, source: "override", status: g.grant_type, expiresAt: g.ends_at };
  }

  // 3. Assinatura paga cobrindo a feature — por CATEGORIA (plano legado) ou
  //    por DECLARAÇÃO do plano (included_features, modelo de dois planos).
  const categories = FEATURE_CATEGORIES[feature];
  const sub = inputs.subscriptions.find(
    (s) =>
      ALLOWED_SUB_STATUSES.has(s.status) &&
      (categories.includes(s.category) || (s.includedFeatures ?? []).includes(feature)),
  );
  if (sub) {
    return { allowed: true, source: "subscription", status: sub.status, expiresAt: sub.current_period_end };
  }

  // 4. Trial (org-level) — somente sistema
  if (feature === "system") {
    if (
      inputs.billingStatus === "trialing" &&
      inputs.trialEndsAt &&
      new Date(inputs.trialEndsAt).getTime() > nowMs
    ) {
      return { allowed: true, source: "trial", status: "trialing", expiresAt: inputs.trialEndsAt };
    }
    // Compat legado: manual_override era o "grant_access" do modelo antigo
    if (inputs.billingStatus === "manual_override") {
      return { allowed: true, source: "legacy", status: "manual_override", expiresAt: null };
    }
  }

  // 5. Sem acesso
  return { allowed: false, source: "none", status: "none", expiresAt: null };
}

export function resolveEntitlements(inputs: EntitlementInputs): OrgEntitlements {
  const nowMs = toMs(inputs.now);

  const system = resolveFeature("system", inputs, nowMs);
  const whatsapp = resolveFeature("whatsapp", inputs, nowMs);

  // Existe alguma assinatura VIVA com declaração explícita? Se sim, o mundo
  // desta organização é o de dois planos, e a declaração governa a IA — sem
  // herança implícita de `system`.
  const hasExplicitPlan = inputs.subscriptions.some(
    (s) => ALLOWED_SUB_STATUSES.has(s.status) && (s.includedFeatures ?? []).length > 0,
  );

  // IA: override próprio primeiro; depois declaração do plano (FRANQUIA);
  // depois carteira (ou herança pré-carteira).
  //
  // A ORDEM DOS RAMOS É LOAD-BEARING: mover o ramo 3 (negação explícita) para
  // depois do ramo 5 (herança) reintroduz a herança e dá IA ao Plano 1; mover o
  // ramo 4 para depois do 5 devolve IA ao trial; mover o ramo 2 (franquia) para
  // depois do 3 faria o Plano 2 cair em `not_included`.
  const aiDirect = resolveFeature("ai", inputs, nowMs);
  let ai: FeatureEntitlement;
  if (aiDirect.source === "admin_block" || aiDirect.source === "override") {
    ai = aiDirect; // 1. override sempre primeiro
  } else if (aiDirect.source === "subscription") {
    // 2. Declarada pelo plano (included_features) → FRANQUIA financiada pela
    //    plataforma. O cliente não compra nada e o teto é interno.
    //
    //    `aiFranchise` AUSENTE não é "esgotada": é "não consultada". Negar aqui
    //    faria todo caller que só lista entitlements (catálogo, painel) reportar
    //    IA bloqueada para quem tem franquia cheia.
    const franchise = inputs.aiFranchise;
    const exhausted = franchise ? franchise.state === "EXHAUSTED" : false;
    ai = {
      allowed: !exhausted,
      source: "franchise",
      status: exhausted ? "budget_exhausted" : "within_budget",
      expiresAt: aiDirect.expiresAt,
      // `balanceCents` NÃO é reusado: significa crédito do cliente.
      ...(franchise ? { budgetRemainingCents: franchise.remainingCents } : {}),
    };
  } else if (hasExplicitPlan) {
    // 3. Plano novo que NÃO declara ai: negação EXPLÍCITA. Sem este ramo, a
    //    herança abaixo daria IA ao Plano 1.
    ai = { allowed: false, source: "none", status: "not_included", expiresAt: null };
  } else if (system.source === "trial") {
    // 4. Trial nunca concede IA (decisão comercial: custo variável sem receita).
    ai = { allowed: false, source: "none", status: "trial_no_ai", expiresAt: null };
  } else if (inputs.aiWalletBalanceCents === undefined) {
    // 5. Pré-Fase 7 (sem carteira): IA acompanha o sistema — mundo BYOK atual.
    ai = { ...system };
  } else {
    const balance = inputs.aiWalletBalanceCents ?? 0;
    if (!system.allowed) {
      ai = { ...system, balanceCents: balance };
    } else if (balance > 0) {
      ai = { allowed: true, source: "wallet", status: "active", expiresAt: null, balanceCents: balance };
    } else {
      ai = { allowed: false, source: "wallet", status: "no_credits", expiresAt: null, balanceCents: 0 };
    }
  }

  return { system, whatsapp, ai };
}
