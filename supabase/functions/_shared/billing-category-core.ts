/**
 * Núcleo PURO da classificação de fatura (hotfix pré-6b do Risco 7).
 *
 * ZERO imports — importável tanto pelas Edge Functions quanto pelo vitest a
 * partir de src/ (mesmo contrato de whatsapp-implementation-core.ts,
 * billing-delinquency-core.ts e entitlements-core.ts). Um import de
 * https://esm.sh/..., mesmo só de tipo, quebra a resolução do Vite e derruba a
 * suíte inteira.
 *
 * INVARIANTE QUE ESTE MÓDULO PROTEGE:
 *
 *   Somente uma obrigação inequivocamente classificada como SYSTEM pode
 *   escrever ou escalar organizations.billing_status.
 *
 * A pergunta "essa fatura é do sistema?" tinha três respostas possíveis no
 * módulo antigo (billing-category.ts) mas só dois valores de retorno
 * (`boolean`), e o empate era resolvido por um default de compatibilidade:
 * fatura SEM VÍNCULO NENHUM devolvia `true`. Isso é correto para fatura
 * legada — toda fatura anterior à Fase 5a é de sistema, e devolver `false`
 * as tiraria da inadimplência em silêncio. E é ERRADO para fatura moderna:
 * uma renovação de R$149 da instância de WhatsApp que nasça sem vínculo
 * (o Asaas não propaga `externalReference` para renovação, e o
 * `provider_subscription_id` pode estar ausente ou defasado) é lida como
 * fatura de sistema e bloqueia a organização inteira em D+6.
 *
 * A correção é dar à ausência de evidência um terceiro valor — NEEDS_REVIEW —
 * em vez de forçá-la a virar um dos dois lados. Falha FECHADA: ambiguidade
 * nunca escala, nunca desbloqueia, e nunca decide sozinha.
 *
 * REDEPLOY: este núcleo é consumido via billing-category.ts, então qualquer
 * mudança aqui exige redeploy dos mesmos seis: process-billing-overdue,
 * process-billing-reminders, process-billing-unblock, process-trial-expiry,
 * process-billing-reconcile e manage-billing.
 */

export const SYSTEM_CATEGORY = "SYSTEM_SUBSCRIPTION";

/** Categorias que NUNCA governam o acesso ao sistema. */
export const NON_SYSTEM_CATEGORIES: readonly string[] = [
  "WHATSAPP_SUBSCRIPTION",
  "WHATSAPP_IMPLEMENTATION",
  "AI_CREDIT_PACKAGE",
];

/**
 * Resultado de uma leitura que o caller já fez. Distingue os três desfechos
 * que o módulo antigo colapsava em `null`:
 *
 *  - RESOLVED   → leu e encontrou;
 *  - NOT_FOUND  → leu e não existe (plano órfão, assinatura apagada);
 *  - READ_FAILED→ não conseguiu ler (erro transitório de banco).
 *
 * NOT_FOUND e READ_FAILED levam ao mesmo veredito hoje (NEEDS_REVIEW), mas
 * são fatos diferentes e a telemetria precisa distinguir: um é dado
 * inconsistente, o outro é indisponibilidade.
 */
export type FactRead<T> =
  | { kind: "RESOLVED"; value: T }
  | { kind: "NOT_FOUND" }
  | { kind: "READ_FAILED" };

export type InvoiceCategoryVerdict = "SYSTEM" | "NON_SYSTEM" | "NEEDS_REVIEW";

/**
 * Motivo do veredito. Código estável (nunca frase livre) — vai para
 * telemetria, para o painel administrativo e para o texto do alerta.
 */
export type InvoiceCategoryReason =
  | "PURPOSE_NON_SYSTEM"
  | "PURPOSE_CATEGORY_CONFLICT"
  | "SUBSCRIPTION_CATEGORY_SYSTEM"
  | "SUBSCRIPTION_CATEGORY_NON_SYSTEM"
  | "SUBSCRIPTION_TERMINAL_STATUS"
  | "SUBSCRIPTION_UNREADABLE"
  | "SUBSCRIPTION_AMBIGUOUS"
  | "PLAN_CATEGORY_SYSTEM"
  | "PLAN_CATEGORY_NON_SYSTEM"
  | "PLAN_UNREADABLE"
  | "LEGACY_COMPAT_SYSTEM"
  | "MODERN_WITHOUT_LINK";

export interface InvoiceCategoryDecision {
  verdict: InvoiceCategoryVerdict;
  reason: InvoiceCategoryReason;
  /**
   * A fatura deve ser retida (`enforcement_hold`) para revisão humana.
   * SEMPRE verdadeiro em NEEDS_REVIEW. Nunca em SYSTEM/NON_SYSTEM — uma
   * classificação inequívoca não precisa de freio.
   */
  holdRequired: boolean;
}

/**
 * Fatos JÁ LIDOS pelo caller. O núcleo não busca nada e não conhece Supabase.
 *
 * `legacy` é a única porta para o default de compatibilidade, e ela é
 * decidida por FATO OBJETIVO (ver `isLegacyInvoice`), nunca por "não sei".
 */
export interface InvoiceCategoryFacts {
  /** `purpose` da fatura (`subscription` | `implementation` | `ai_topup` | `other` | null). */
  purpose?: string | null;
  /** Fatura legada — ver `isLegacyInvoice`. */
  legacy: boolean;
  /**
   * Vínculo de assinatura, quando a fatura tem `billing_subscription_id`.
   * `undefined` = a fatura não tem vínculo de assinatura nenhum (diferente de
   * ter vínculo cuja leitura falhou, que é `category: READ_FAILED`).
   */
  subscription?: {
    category: FactRead<string>;
    /** Status local da assinatura (`active`, `canceled`, `unpaid`, ...). */
    status: FactRead<string>;
    /**
     * Mais de uma assinatura viva casou com o mesmo `provider_subscription_id`
     * ou com a mesma categoria. Nunca desempatar pela mais recente.
     */
    ambiguous?: boolean;
  };
  /**
   * Categoria do plano extraído do `external_reference` (`plan:<uuid>`).
   * `undefined` = não havia `plan:` utilizável na referência.
   */
  externalReferencePlanCategory?: FactRead<string>;
}

/**
 * Status locais que significam "esta assinatura não deveria estar gerando
 * cobrança". Uma renovação correlacionada a uma delas é DIVERGÊNCIA — pode ser
 * o rescaldo do bug 08 (cancelada aqui, viva no provedor) — e nunca pode
 * escalar inadimplência sozinha.
 */
export const TERMINAL_SUBSCRIPTION_STATUSES: readonly string[] = ["canceled"];

export function isTerminalSubscriptionStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return TERMINAL_SUBSCRIPTION_STATUSES.includes(status.trim().toLowerCase());
}

/**
 * Fatura é LEGADA quando um fato objetivo diz que ela nasceu antes do regime
 * novo. Duas portas, ambas verificáveis:
 *
 *  1. `provider === 'stripe'` — a Stripe é read-only desde a Fase 4 e toda
 *     fatura dela é anterior ao modelo modular;
 *  2. `createdAt < ingestionSince` — nasceu antes do marco de ingestão
 *     (`billing_invoice_ingestion_since`, formato `YYYY-MM-DD`).
 *
 * Sem `ingestionSince` conhecida, só a porta 1 vale: presumir "legada" por
 * ausência de marco reintroduziria exatamente o default que este hotfix
 * remove.
 *
 * Comparação por prefixo de data (`YYYY-MM-DD`), a mesma granularidade de dia
 * que `parseBillingIngestionSince` já impõe no worker de reconciliação.
 */
export function isLegacyInvoice(input: {
  provider?: string | null;
  createdAt?: string | null;
  ingestionSince?: string | null;
}): boolean {
  if ((input.provider ?? "").trim().toLowerCase() === "stripe") return true;

  const since = (input.ingestionSince ?? "").trim();
  const created = (input.createdAt ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return false;
  if (created.length < 10) return false;

  return created.slice(0, 10) < since;
}

/** `purpose` que, por si só, já diz que a cobrança não é do sistema. */
const NON_SYSTEM_PURPOSES: readonly string[] = ["implementation", "ai_topup"];

function categoryVerdict(category: string): "SYSTEM" | "NON_SYSTEM" {
  return category === SYSTEM_CATEGORY ? "SYSTEM" : "NON_SYSTEM";
}

/**
 * A decisão inteira, a partir de fatos já lidos.
 *
 * Ordem deliberada:
 *
 *  1. Conflito entre `purpose` e categoria conhecida → NEEDS_REVIEW. Vem
 *     ANTES do atalho de `purpose` porque coerção silenciosa é justamente o
 *     que não pode acontecer: uma fatura com `purpose='implementation'` cujo
 *     plano é de SISTEMA é dado inconsistente, não uma implantação.
 *  2. `purpose` não-sistêmico sem conflito → NON_SYSTEM.
 *  3. Vínculo de assinatura (caso comum da renovação).
 *  4. `plan:` do `external_reference` (primeira cobrança do checkout).
 *  5. Sem vínculo nenhum: LEGADA → SYSTEM por compatibilidade; MODERNA →
 *     NEEDS_REVIEW. **Este item 5 é o hotfix.**
 */
export function decideInvoiceCategory(facts: InvoiceCategoryFacts): InvoiceCategoryDecision {
  const purpose = (facts.purpose ?? "").trim().toLowerCase();
  const purposeSaysNonSystem = NON_SYSTEM_PURPOSES.includes(purpose);

  // A categoria que os fatos conhecem, se algum a conhecer.
  const knownCategory =
    facts.subscription?.category.kind === "RESOLVED"
      ? facts.subscription.category.value
      : facts.externalReferencePlanCategory?.kind === "RESOLVED"
        ? facts.externalReferencePlanCategory.value
        : null;

  // 1. Conflito purpose × categoria — nunca coagir.
  if (purposeSaysNonSystem && knownCategory === SYSTEM_CATEGORY) {
    return {
      verdict: "NEEDS_REVIEW",
      reason: "PURPOSE_CATEGORY_CONFLICT",
      holdRequired: true,
    };
  }

  // 2. Implantação e recarga de IA nunca governam o acesso ao sistema.
  if (purposeSaysNonSystem) {
    return { verdict: "NON_SYSTEM", reason: "PURPOSE_NON_SYSTEM", holdRequired: false };
  }

  // 3. Vínculo de assinatura.
  const sub = facts.subscription;
  if (sub) {
    if (sub.ambiguous) {
      return { verdict: "NEEDS_REVIEW", reason: "SUBSCRIPTION_AMBIGUOUS", holdRequired: true };
    }

    // Status terminal vence a categoria: mesmo sendo assinatura de sistema,
    // uma cobrança para algo que consideramos cancelado é divergência.
    // Verificado ANTES da categoria de propósito — o dano que este hotfix
    // fecha não é classificar errado, é escalar a partir de uma correlação
    // que ninguém revisou.
    if (sub.status.kind === "RESOLVED" && isTerminalSubscriptionStatus(sub.status.value)) {
      return {
        verdict: "NEEDS_REVIEW",
        reason: "SUBSCRIPTION_TERMINAL_STATUS",
        holdRequired: true,
      };
    }
    if (sub.status.kind !== "RESOLVED" || sub.category.kind !== "RESOLVED") {
      return { verdict: "NEEDS_REVIEW", reason: "SUBSCRIPTION_UNREADABLE", holdRequired: true };
    }

    const verdict = categoryVerdict(sub.category.value);
    return {
      verdict,
      reason:
        verdict === "SYSTEM"
          ? "SUBSCRIPTION_CATEGORY_SYSTEM"
          : "SUBSCRIPTION_CATEGORY_NON_SYSTEM",
      holdRequired: false,
    };
  }

  // 4. Plano vindo do external_reference.
  const planCat = facts.externalReferencePlanCategory;
  if (planCat) {
    if (planCat.kind !== "RESOLVED") {
      return { verdict: "NEEDS_REVIEW", reason: "PLAN_UNREADABLE", holdRequired: true };
    }
    const verdict = categoryVerdict(planCat.value);
    return {
      verdict,
      reason: verdict === "SYSTEM" ? "PLAN_CATEGORY_SYSTEM" : "PLAN_CATEGORY_NON_SYSTEM",
      holdRequired: false,
    };
  }

  // 5. Sem vínculo nenhum.
  if (facts.legacy) {
    // Compatibilidade LEGADA, delimitada por fato objetivo (isLegacyInvoice).
    // Toda fatura anterior ao regime novo é de sistema; devolver NEEDS_REVIEW
    // aqui tiraria o histórico da inadimplência em silêncio.
    return { verdict: "SYSTEM", reason: "LEGACY_COMPAT_SYSTEM", holdRequired: false };
  }

  // O HOTFIX: fatura moderna sem vínculo confiável não é presumida de sistema.
  return { verdict: "NEEDS_REVIEW", reason: "MODERN_WITHOUT_LINK", holdRequired: true };
}

/**
 * Açúcar para o único uso que os workers de inadimplência realmente têm:
 * "posso escrever organizations.billing_status por causa desta fatura?".
 *
 * SÓ `SYSTEM` autoriza. `NEEDS_REVIEW` responde `false` aqui — mas isso NÃO é
 * coerção para "não é do sistema": o caller que escala é obrigado a tratar o
 * veredito completo (reter, alertar), e é por isso que esta função devolve o
 * booleano a partir da decisão, em vez de o núcleo devolver booleano.
 */
export function mayGovernSystemAccess(decision: InvoiceCategoryDecision): boolean {
  return decision.verdict === "SYSTEM";
}
