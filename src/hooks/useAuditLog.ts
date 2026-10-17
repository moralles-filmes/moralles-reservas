import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { AUDIT_LOG_MEMBER_TABLES } from "@/lib/audit-log-tables";
import type { AuditLogEntry } from "@/types/reserva";

export interface AuditLogFilters {
  table?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

// audit_log popula unit_id apenas para reservations e organization_id apenas para customers.
// Filtrar pelos dois cobre os dois tipos; RLS (is_unit_member + is_org_member) é a
// camada de segurança real e impede vazamento cross-tenant. A policy de membro
// também restringe às tabelas de AUDIT_LOG_MEMBER_TABLES (customers,
// reservations, unit_members); tabela nova só aparece aqui se a policy, a
// constante e o rótulo mudarem juntos. O `.in` abaixo é sempre aplicado: o
// platform_admin que opera a unidade como pseudo-owner passa pela policy de
// admin (lê tudo) e, sem ele, veria dado da plataforma na tela do cliente.
export function useAuditLog(
  unitId: string,
  organizationId: string,
  filters?: AuditLogFilters,
) {
  const table = filters?.table;
  const action = filters?.action;
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  return useQuery({
    queryKey: ["audit-log", unitId, organizationId, table, action, limit, offset],
    queryFn: async () => {
      let query = supabase
        .from("audit_log")
        .select("*")
        .or(`unit_id.eq.${unitId},organization_id.eq.${organizationId}`)
        .in("table_name", [...AUDIT_LOG_MEMBER_TABLES])
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (table) query = query.eq("table_name", table);
      if (action) query = query.eq("action", action);

      const { data, error } = await query;
      if (error) throw error;
      return data as AuditLogEntry[];
    },
    enabled: !!unitId && !!organizationId,
  });
}
