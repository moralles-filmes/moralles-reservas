/**
 * Nucleo PURO: esta organizacao pode registrar mais uma conexao de WhatsApp?
 * ZERO IMPORTS.
 *
 * "Instancia que ainda gera custo" = lifecycle_state <> 'ENDED'. Instancia em
 * CANCELLATION_REQUESTED CONTA: ela custa ate a confirmacao de encerramento.
 *
 * A COLUNA `included_whatsapp_connections` NAO E A UNICA FONTE DA DECISAO. A
 * migration 094 da `default 0` a TODAS as linhas existentes; aplicar esse zero
 * a contrato legado ou a override vitalicio bloquearia exatamente quem nunca
 * deveria ser bloqueado. A origem do financiamento decide qual politica vale.
 *
 * Fail-CLOSED por decisao: provisionamento libera custo externo novo. A
 * polaridade oposta (fail-open) e exclusiva do ENVIO existente.
 */

export type ConnectionFundingSource =
  | "PLAN_INCLUDED" // plano novo declara whatsapp -> usa a coluna
  | "LEGACY_CATEGORY" // WHATSAPP_SUBSCRIPTION -> politica historica
  | "TRANSITION" // as duas coexistem
  | "LIFETIME_OVERRIDE" // cortesia vitalicia, sem assinatura
  | "NONE";

export type ConnectionOperation = "BACKFILL_EXISTING" | "NEW_PROVISIONING";

export interface ConnectionAllowanceInput {
  fundingSource: ConnectionFundingSource;
  /** billing_plans.included_whatsapp_connections; null = ausente/ilegivel */
  includedConnections: number | null;
  operation: ConnectionOperation;
  /** instancias com lifecycle_state <> 'ENDED' */
  activeInstanceCount: number;
  /** resolucao da assinatura em transicao ou duplicidade */
  provisioningAmbiguous: boolean;
  /** o provider_instance_ref informado corresponde a instancia REAL ja criada */
  providerInstanceRefKnown: boolean;
}

export type ConnectionAllowancePolicy =
  | "PLAN_DECLARED"
  | "LEGACY_HISTORICAL"
  | "OVERRIDE_OPERATIONAL"
  | "DENIED";

export type ConnectionAllowance =
  | { allowed: true; policy: ConnectionAllowancePolicy }
  | {
      allowed: false;
      policy: "DENIED";
      reasonCode:
        | "CONNECTION_LIMIT_REACHED"
        | "ALLOWANCE_UNKNOWN"
        | "SUBSCRIPTION_AMBIGUOUS"
        | "BACKFILL_WITHOUT_PROVIDER_REF"
        | "OVERRIDE_REQUIRES_ADMIN_DECISION"
        | "NO_FUNDING_SOURCE";
    };

const deny = (
  reasonCode: Extract<ConnectionAllowance, { allowed: false }>["reasonCode"],
): ConnectionAllowance => ({
  allowed: false as const,
  policy: "DENIED" as const,
  reasonCode,
});

export function checkConnectionAllowance(input: ConnectionAllowanceInput): ConnectionAllowance {
  // 1. Backfill precisa ser backfill DE VERDADE. Sem referencia da instancia
  //    real no provider, "backfill" e provisionamento novo por outra porta.
  if (input.operation === "BACKFILL_EXISTING" && !input.providerInstanceRefKnown) {
    return deny("BACKFILL_WITHOUT_PROVIDER_REF");
  }

  // 2. Sem fonte de financiamento nao ha o que autorizar.
  if (input.fundingSource === "NONE") return deny("NO_FUNDING_SOURCE");

  // 3. Ambiguidade bloqueia CUSTO NOVO — nao o registro do que ja existe e ja
  //    esta sendo cobrado. Registrar a realidade nunca piora a posicao.
  if (input.operation === "NEW_PROVISIONING" && input.provisioningAmbiguous) {
    return deny("SUBSCRIPTION_AMBIGUOUS");
  }

  // 4. Cortesia vitalicia: nao tem assinatura, entao nao tem coluna. Preserva
  //    a operacao existente e o backfill dela; custo NOVO exige decisao
  //    administrativa explicita, nunca autorizacao implicita por ausencia.
  if (input.fundingSource === "LIFETIME_OVERRIDE") {
    if (input.operation === "BACKFILL_EXISTING") {
      return { allowed: true, policy: "OVERRIDE_OPERATIONAL" };
    }
    return deny("OVERRIDE_REQUIRES_ADMIN_DECISION");
  }

  // 5. Contrato legado segue a politica historica. O `default 0` da 094 e
  //    artefato de migration, nao decisao comercial sobre quem ja era cliente.
  if (input.fundingSource === "LEGACY_CATEGORY" || input.fundingSource === "TRANSITION") {
    return { allowed: true, policy: "LEGACY_HISTORICAL" };
  }

  // 6. Plano novo: a coluna decide.
  if (input.includedConnections === null || input.includedConnections === undefined) {
    return deny("ALLOWANCE_UNKNOWN");
  }
  // Backfill tambem respeita o teto: registrar duas instancias reais num plano
  // de uma conexao e um problema comercial que precisa aparecer, nao ser aceito.
  if (input.activeInstanceCount >= input.includedConnections) {
    return deny("CONNECTION_LIMIT_REACHED");
  }
  return { allowed: true, policy: "PLAN_DECLARED" };
}
