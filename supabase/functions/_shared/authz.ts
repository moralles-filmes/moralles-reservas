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
//
// TIPO LOCAL, NÃO `SupabaseClient` DE ESM.SH. `src/lib/authz.test.ts` importa
// `hasUnitAccess` direto daqui pra testar comportamento (não só o guardrail
// textual). `import type` é apagado em runtime pelo esbuild do Vitest, mas
// `tsc -b` ainda resolve tipos do fechamento do projeto — e falha (`TS2307`)
// tentando resolver uma URL. Mesmo risco documentado em `whatsapp-instance-
// cycle-core.ts`/`billing-category-core.ts`/outros núcleos cross-boundary;
// a superfície mínima abaixo evita o import e o client real a satisfaz
// estruturalmente, sem mudar nenhuma chamada.

interface SupabaseReadResult {
  data: { user_id: string } | null;
  error: { message: string } | null;
}

interface SupabaseFilterBuilder extends PromiseLike<SupabaseReadResult> {
  eq(column: string, value: string): SupabaseFilterBuilder;
  maybeSingle(): PromiseLike<SupabaseReadResult>;
}

interface MinimalSupabaseClient {
  from(table: string): {
    select(columns: string): SupabaseFilterBuilder;
  };
}

/**
 * `true` se o usuário é membro da unidade OU platform_admin.
 * Erro de leitura devolve `false` (fail-closed) e é logado no console.
 */
export async function hasUnitAccess(
  supabase: MinimalSupabaseClient,
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
