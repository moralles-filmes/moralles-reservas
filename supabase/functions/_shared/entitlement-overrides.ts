/**
 * Único writer de organization_entitlement_overrides.
 *
 * INVARIANTE: nenhum insert/update direto nessa tabela fora deste módulo.
 * Espalhar inserts significa espalhar as regras de coerência de data, de
 * conflito e de motivo obrigatório — e a primeira que divergir cria uma
 * cortesia que o resolver não enxerga (ou uma que nunca expira).
 *
 * Webhook financeiro NUNCA chama estas funções: override é decisão
 * administrativa, e um pagamento não concede cortesia.
 *
 * REDEPLOY: manage-whatsapp-implementations.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { resolveOrgEntitlements, type OrgEntitlements } from "./entitlements.ts";

export type OverrideFeature = "system" | "whatsapp" | "ai";
/** Espelha o CHECK da migration 062. Rótulos de UI vivem em src/types/billing.ts. */
export type OverrideGrantType = "LIFETIME" | "TEMPORARY" | "PROMOTIONAL" | "MANUAL_OVERRIDE";

const FEATURES: ReadonlySet<string> = new Set(["system", "whatsapp", "ai"]);
const GRANT_TYPES: ReadonlySet<string> = new Set([
  "LIFETIME",
  "TEMPORARY",
  "PROMOTIONAL",
  "MANUAL_OVERRIDE",
]);

export type OverrideResult =
  /**
   * `entitlements: null` só ocorre quando o INSERT/UPDATE já foi confirmado
   * pelo Postgres e a releitura de confirmação (pós-escrita) falhou — NUNCA
   * significa que a concessão/revogação falhou. Tratar `null` como "operação
   * falhou" reverteria uma mudança que já é real. Caller mostra sucesso e,
   * se quiser, um aviso de que o snapshot não pôde ser confirmado.
   */
  | { ok: true; entitlements: OrgEntitlements | null }
  | { ok: false; status: number; error: string };

/**
 * Releitura best-effort pós-escrita. A escrita já commitou antes desta
 * chamada — uma exceção aqui é só a confirmação falhando, não a operação.
 * Reportar {ok:false} devolveria "falhou" pra uma mudança que já aconteceu
 * (mesma classe de bug da Task 7: efeito durável não pode virar falha por
 * causa de um passo best-effort depois dele).
 */
async function safeResolveEntitlements(
  supabase: SupabaseClient,
  organizationId: string,
  evt: string,
): Promise<OrgEntitlements | null> {
  try {
    return await resolveOrgEntitlements(supabase, organizationId);
  } catch (err) {
    jsonLog("error", {
      evt,
      org: organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface GrantOverrideArgs {
  organizationId: string;
  feature: OverrideFeature;
  grantType: OverrideGrantType;
  reason: string;
  grantedBy: string;
  /** ISO. Obrigatório e futuro em TEMPORARY; recusado em qualquer outro grantType. */
  endsAt?: string | null;
  /** false = bloqueio administrativo explícito (prioridade 1 no resolver). */
  enabled?: boolean;
}

export async function grantOverride(
  supabase: SupabaseClient,
  args: GrantOverrideArgs,
): Promise<OverrideResult> {
  if (!FEATURES.has(args.feature)) {
    return { ok: false, status: 400, error: "Funcionalidade inválida." };
  }
  if (!GRANT_TYPES.has(args.grantType)) {
    return { ok: false, status: 400, error: "Tipo de concessão inválido." };
  }
  if (!args.reason?.trim()) {
    // Motivo é obrigatório no banco (NOT NULL) e é o que torna a auditoria
    // legível seis meses depois. Recusar aqui dá mensagem melhor que 23502.
    return { ok: false, status: 400, error: "Informe o motivo da concessão." };
  }
  if (!args.grantedBy) {
    return { ok: false, status: 400, error: "Responsável pela concessão não identificado." };
  }

  // Regra única de data do módulo: só TEMPORARY carrega prazo. LIFETIME,
  // PROMOTIONAL e MANUAL_OVERRIDE recusam `endsAt` em vez de coagir pra null —
  // honrar a data mudando o grant_type seria inventar semântica de validade
  // fora do que a fase desenhou; descartar a data em silêncio concederia MAIS
  // do que foi pedido (o admin pede "até 30/09", recebe vitalício, sem aviso).
  // Ambos os desvios violam a direção de erro deste módulo: prefira falhar
  // sem conceder. Recusar mantém as três num único enunciado testável.
  const nowMs = Date.now();
  if (args.grantType === "TEMPORARY") {
    if (!args.endsAt) {
      return { ok: false, status: 400, error: "Acesso temporário exige uma data de validade." };
    }
    const endsMs = new Date(args.endsAt).getTime();
    if (!Number.isFinite(endsMs) || endsMs <= nowMs) {
      return { ok: false, status: 400, error: "A validade precisa ser uma data futura." };
    }
  } else if (args.endsAt) {
    return {
      ok: false,
      status: 400,
      error: "Este tipo de concessão não expira. Para conceder acesso com prazo, use o tipo Temporário.",
    };
  }

  // Conflito com override vivo da MESMA feature. Empilhar dois grants deixaria
  // a revogação parcial (o resolver escolhe o mais duradouro e o outro fica
  // órfão, invisível na UI e ainda válido).
  const nowIso = new Date().toISOString();
  const { data: existing, error: existingErr } = await supabase
    .from("organization_entitlement_overrides")
    .select("id, enabled, grant_type")
    .eq("organization_id", args.organizationId)
    .eq("feature", args.feature)
    .is("revoked_at", null)
    .lte("starts_at", nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .limit(1);

  if (existingErr) {
    jsonLog("error", {
      evt: "override_conflict_check_failed",
      org: args.organizationId,
      feature: args.feature,
      err: existingErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar as concessões atuais." };
  }
  if ((existing ?? []).length > 0) {
    const cur = existing![0];
    return {
      ok: false,
      status: 409,
      error: cur.enabled
        ? "Já existe uma concessão ativa para esta funcionalidade. Revogue a atual antes de criar outra."
        : "Existe um bloqueio administrativo ativo para esta funcionalidade. Revogue o bloqueio antes de conceder.",
    };
  }

  const { error: insErr } = await supabase.from("organization_entitlement_overrides").insert({
    organization_id: args.organizationId,
    feature: args.feature,
    enabled: args.enabled ?? true,
    grant_type: args.grantType,
    ends_at: args.grantType === "TEMPORARY" ? args.endsAt : null,
    reason: args.reason.trim(),
    granted_by: args.grantedBy,
  });
  if (insErr) {
    jsonLog("error", {
      evt: "override_grant_failed",
      org: args.organizationId,
      feature: args.feature,
      err: insErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao registrar a concessão." };
  }

  jsonLog("info", {
    evt: "override_granted",
    org: args.organizationId,
    feature: args.feature,
    grantType: args.grantType,
    enabled: args.enabled ?? true,
  });

  // Override formal de whatsapp=true SUBSTITUI o grandfathering: a organização
  // passa a ter direito por decisão administrativa registrada, não por
  // antiguidade. A revogação é TERMINAL — revogar o override depois NÃO
  // devolve o grandfathering, senão "concedo, revogo, volto a ser legado"
  // viraria isenção permanente com aparência de processo. Best-effort: falha
  // aqui loga e NÃO derruba a concessão do override já commitada acima — o
  // direito de acesso é o efeito principal, o encerramento do grandfathering é
  // consequência administrativa.
  if (args.feature === "whatsapp" && (args.enabled ?? true) === true) {
    const { error: revokeErr } = await supabase
      .from("organizations")
      .update({
        whatsapp_grandfather_revoked_at: new Date().toISOString(),
        whatsapp_grandfather_revoked_reason: "REPLACED_BY_OVERRIDE",
        whatsapp_grandfather_revoked_by: args.grantedBy,
      })
      .eq("id", args.organizationId)
      .eq("whatsapp_legacy_grandfathered", true)
      .is("whatsapp_grandfather_revoked_at", null);
    if (revokeErr) {
      jsonLog("error", {
        evt: "override_grant_grandfather_revoke_failed",
        org: args.organizationId,
        err: revokeErr.message,
      });
    }
  }

  // Devolve o entitlement RESOLVIDO após a escrita — a UI reflete o efeito real,
  // não o que ela supõe que a escrita causou.
  return {
    ok: true,
    entitlements: await safeResolveEntitlements(
      supabase,
      args.organizationId,
      "override_grant_reread_failed",
    ),
  };
}

export interface RevokeOverrideArgs {
  organizationId: string;
  overrideId: string;
  revokedBy: string;
}

/** Nunca deleta — `revoked_at` preserva a trilha. */
export async function revokeOverride(
  supabase: SupabaseClient,
  args: RevokeOverrideArgs,
): Promise<OverrideResult> {
  if (!args.revokedBy) {
    return { ok: false, status: 400, error: "Responsável pela revogação não identificado." };
  }

  const { data: updated, error } = await supabase
    .from("organization_entitlement_overrides")
    .update({ revoked_at: new Date().toISOString(), revoked_by: args.revokedBy })
    .eq("id", args.overrideId)
    // Escopo por org: o id sozinho permitiria revogar a cortesia de OUTRO
    // cliente com um id chutado.
    .eq("organization_id", args.organizationId)
    .is("revoked_at", null)
    .select("id, feature");

  if (error) {
    jsonLog("error", { evt: "override_revoke_failed", id: args.overrideId, err: error.message });
    return { ok: false, status: 500, error: "Falha ao revogar a concessão." };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, status: 404, error: "Concessão não encontrada ou já revogada." };
  }

  jsonLog("info", {
    evt: "override_revoked",
    org: args.organizationId,
    id: args.overrideId,
    feature: updated[0].feature,
  });
  return {
    ok: true,
    entitlements: await safeResolveEntitlements(
      supabase,
      args.organizationId,
      "override_revoke_reread_failed",
    ),
  };
}
