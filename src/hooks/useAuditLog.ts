import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { AuditLogEntry } from "@/types/reserva";

export interface AuditLogFilters {
  table?: string;
  action?: string;
  limit?: number;
}

export function useAuditLog(unitId: string, filters?: AuditLogFilters) {
  return useQuery({
    queryKey: ["audit-log", unitId, filters],
    queryFn: async () => {
      let query = supabase
        .from("audit_log")
        .select("*")
        .eq("unit_id", unitId)
        .order("created_at", { ascending: false })
        .limit(filters?.limit ?? 100);

      if (filters?.table) query = query.eq("table_name", filters.table);
      if (filters?.action) query = query.eq("action", filters.action);

      const { data, error } = await query;
      if (error) throw error;
      return data as AuditLogEntry[];
    },
    enabled: !!unitId,
  });
}
