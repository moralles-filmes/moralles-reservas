import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Mesa } from "@/types/reserva";

/** Lista todas as mesas da unit (opcionalmente filtradas por hall). */
export function useUnitTables(unitId: string, { activeOnly = true } = {}) {
  return useQuery({
    queryKey: ["unit-tables", unitId, activeOnly ? "active" : "all"],
    queryFn: async () => {
      let q = supabase
        .from("tables")
        .select("id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active")
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

export function useHallTables(hallId: string | undefined, { activeOnly = false } = {}) {
  return useQuery({
    queryKey: ["hall-tables", hallId, activeOnly ? "active" : "all"],
    queryFn: async () => {
      let q = supabase
        .from("tables")
        .select("id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active")
        .eq("hall_id", hallId!)
        .order("number", { ascending: true });
      if (activeOnly) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data as Mesa[];
    },
    enabled: !!hallId,
  });
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
        .select("id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active")
        .single();
      if (error) throw error;
      return data as Mesa;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["unit-tables", data.unit_id] });
      if (data.hall_id) qc.invalidateQueries({ queryKey: ["hall-tables", data.hall_id] });
    },
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
        .select("id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active");
      if (error) throw error;
      return data as Mesa[];
    },
    onSuccess: (rows) => {
      const unitId = rows[0]?.unit_id;
      const hallId = rows[0]?.hall_id;
      if (unitId) qc.invalidateQueries({ queryKey: ["unit-tables", unitId] });
      if (hallId) qc.invalidateQueries({ queryKey: ["hall-tables", hallId] });
    },
  });
}

export function useUpdateTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & Partial<Omit<Mesa, "id" | "capacity">>) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("tables")
        .update(patch)
        .eq("id", id)
        .select("id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active")
        .single();
      if (error) throw error;
      return data as Mesa;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["unit-tables", data.unit_id] });
      if (data.hall_id) qc.invalidateQueries({ queryKey: ["hall-tables", data.hall_id] });
    },
  });
}

export function useDeleteTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; unit_id: string; hall_id: string | null }) => {
      const { error } = await supabase.from("tables").delete().eq("id", input.id);
      if (error) throw error;
      return input;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["unit-tables", data.unit_id] });
      if (data.hall_id) qc.invalidateQueries({ queryKey: ["hall-tables", data.hall_id] });
    },
  });
}
