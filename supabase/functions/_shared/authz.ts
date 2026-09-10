// supabase/functions/_shared/authz.ts
//
// Única fonte do guard "membro da unidade OU platform_admin" nas Edge Functions.
//
// POR QUE NÃO É RPC. Os helpers `is_unit_member`/`is_platform_admin` vivem em
// `app_private` desde a migration 106 — schema fora do que o PostgREST expõe,
// justamente para que a anon key não consiga usá-los como oráculo de
// enumeração de membership. Estas EFs rodam com service_role, que bypassa RLS,
// então a consulta direta responde a mesma pergunta sem superfície pública.
//
// INVARIANTE PRESERVADO. `useCurrentUnit.ts` fabrica pseudo-membership "owner"
// para platform_admin operar unidades alheias na UI; sem o paralelo aqui,
// super-admin recebe 403 com a UI mostrando "Proprietário". As duas perguntas
// andam juntas — nunca só a de membership.
//
// FAIL-CLOSED, EXATAMENTE COMO ANTES. O código que este helper substitui fazia
// `if (!memberResult.data && !adminResult.data) → 403`, o que já tratava erro de
// leitura como negação. A semântica é preservada byte a byte de propósito: esta
// frente não muda código de status em nenhum caminho. Trocar 403 por 503 em
// falha de banco é melhoria defensável, e está explicitamente fora de escopo.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * `true` se o usuário é membro da unidade OU platform_admin.
 * Erro de leitura devolve `false` (fail-closed) e é logado no console.
 */
export async function hasUnitAccess(
  supabase: SupabaseClient,
  userId: string,
  unitId: string,
): Promise<boolean> {
  const [membro, admin] = await Promise.all([
    supabase
      .from("unit_members")
      .select("user_id")
      .eq("user_id", userId)
      .eq("unit_id", unitId)
      .maybeSingle(),
    supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (membro.error) {
    console.error(JSON.stringify({ evt: "authz_member_read_error", message: membro.error.message }));
  }
  if (admin.error) {
    console.error(JSON.stringify({ evt: "authz_admin_read_error", message: admin.error.message }));
  }

  return Boolean(membro.data) || Boolean(admin.data);
}
