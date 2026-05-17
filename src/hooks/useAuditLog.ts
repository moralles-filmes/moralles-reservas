import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { AuditLogEntry } from "@/types/reserva";

export interface AuditLogFilters {
  table?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

// audit_log popula unit_id apenas para reservations e organization_id apenas para customers.
// Filtrar pelos dois cobre os dois tipos; RLS (is_unit_member + is_org_member) é a
// camada de segurança real e impede vazamento cross-tenant.
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
