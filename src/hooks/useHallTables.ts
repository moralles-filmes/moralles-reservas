import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Mesa } from "@/types/reserva";
import { TABLE_COLUMNS } from "@/features/planta/api";
import { TABLE_NOT_IN_UNIT_MESSAGE, assertWrote } from "@/lib/layout-errors";

/** Lista todas as mesas da unit (opcionalmente filtradas por hall). */
export function useUnitTables(unitId: string, { activeOnly = true } = {}) {
  return useQuery({
    queryKey: ["unit-tables", unitId, activeOnly ? "active" : "all"],
    queryFn: async () => {
      let q = supabase
        .from("tables")
        .select(TABLE_COLUMNS)
        .eq("unit_id", unitId)
        .order("number", { ascending: true });
      if (activeOnly) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data as Mesa[];
    },
    enabled: !!unitId,
  });
}

/** Mesas de um salão, só da unidade ativa (a RLS libera todas as unidades do membro). */
export function useHallTables(unitId: string, hallId: string | undefined, { activeOnly = false } = {}) {
  return useQuery({
    queryKey: ["hall-tables", unitId, hallId, activeOnly ? "active" : "all"],
    queryFn: async () => {
      let q = supabase
        .from("tables")
        .select(TABLE_COLUMNS)
        .eq("unit_id", unitId)
        .eq("hall_id", hallId!)
        .order("number", { ascending: true });
      if (activeOnly) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data as Mesa[];
    },
    enabled: !!unitId && !!hallId,
  });
}

function invalidateTables(qc: QueryClient, unitId: string | undefined, hallId: string | null | undefined) {
  if (!unitId) return;
  qc.invalidateQueries({ queryKey: ["unit-tables", unitId] });
  if (hallId) qc.invalidateQueries({ queryKey: ["hall-tables", unitId, hallId] });
}

export type CreateTableInput = {
  unit_id: string;
  hall_id: string | null;
  /** Opcional: se vazio, gera o próximo número livre da unit. */
  number?: number;
  min_capacity: number;
  max_capacity: number;
  location?: "internal" | "external";
  active?: boolean;
};

export function useCreateTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTableInput) => {
      let nextNumber = input.number;
      if (!nextNumber) {
        const { data: maxRow } = await supabase
          .from("tables")
          .select("number")
          .eq("unit_id", input.unit_id)
          .order("number", { ascending: false })
          .limit(1)
          .maybeSingle();
        nextNumber = (maxRow?.number ?? 0) + 1;
      }
      const { data, error } = await supabase
        .from("tables")
        .insert({
          unit_id: input.unit_id,
          hall_id: input.hall_id,
          number: nextNumber,
          min_capacity: input.min_capacity,
          max_capacity: input.max_capacity,
          location: input.location ?? "internal",
          active: input.active ?? true,
        })
        .select(TABLE_COLUMNS)
        .single();
      if (error) throw error;
      return data as Mesa;
    },
    onSuccess: (data) => invalidateTables(qc, data.unit_id, data.hall_id),
  });
}

/** Cria várias mesas idênticas de uma vez (atalho usado no modal de schedule). */
export function useCreateTablesBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTableInput & { count: number }) => {
      const { data: maxRow } = await supabase
        .from("tables")
        .select("number")
        .eq("unit_id", input.unit_id)
        .order("number", { ascending: false })
        .limit(1)
        .maybeSingle();
      const start = (maxRow?.number ?? 0) + 1;
      const rows = Array.from({ length: input.count }, (_, i) => ({
        unit_id: input.unit_id,
        hall_id: input.hall_id,
        number: start + i,
        min_capacity: input.min_capacity,
        max_capacity: input.max_capacity,
        location: input.location ?? "internal",
        active: input.active ?? true,
      }));
      const { data, error } = await supabase
        .from("tables")
        .insert(rows)
        .select(TABLE_COLUMNS);
      if (error) throw error;
      return data as Mesa[];
    },
    onSuccess: (_rows, input) => invalidateTables(qc, input.unit_id, input.hall_id),
  });
}

/** `unit_id` é o predicado de tenant, não um campo a gravar. */
export function useUpdateTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; unit_id: string } & Partial<Omit<Mesa, "id" | "capacity" | "unit_id">>) => {
      const { id, unit_id, ...patch } = input;
      const { data, error } = await supabase
        .from("tables")
        .update(patch)
        .eq("id", id)
        .eq("unit_id", unit_id)
        .select(TABLE_COLUMNS);
      if (error) throw error;
      assertWrote(data, TABLE_NOT_IN_UNIT_MESSAGE);
      return data![0] as Mesa;
    },
    onSettled: (data, _err, input) => {
      invalidateTables(qc, input.unit_id, input.hall_id);
      if (data && data.hall_id !== input.hall_id) invalidateTables(qc, input.unit_id, data.hall_id);
    },
  });
}

export function useDeleteTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; unit_id: string; hall_id: string | null }) => {
      const { data, error } = await supabase
        .from("tables")
        .delete()
        .eq("id", input.id)
        .eq("unit_id", input.unit_id)
        .select("id");
      if (error) throw error;
      assertWrote(data, TABLE_NOT_IN_UNIT_MESSAGE);
      return input;
    },
    onSettled: (_data, _err, input) => invalidateTables(qc, input.unit_id, input.hall_id),
  });
}
