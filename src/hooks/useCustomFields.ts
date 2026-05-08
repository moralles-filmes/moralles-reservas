import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { CustomFieldType, UnitCustomField } from "@/types/reserva";

export function useCustomFields(unitId: string, { activeOnly = false } = {}) {
  return useQuery({
    queryKey: ["custom-fields", unitId, activeOnly ? "active" : "all"],
    queryFn: async () => {
      let q = supabase
        .from("unit_custom_fields")
        .select("*")
        .eq("unit_id", unitId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (activeOnly) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data as UnitCustomField[];
    },
    enabled: !!unitId,
  });
}

export type CreateCustomFieldInput = {
  label: string;
  type: CustomFieldType;
  options?: string[] | null;
  required?: boolean;
  sort_order?: number;
};

export function useCreateCustomField(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCustomFieldInput) => {
      // Pega max sort_order pra colocar o novo campo no fim
      let order = input.sort_order;
      if (order === undefined) {
        const { data: maxRow } = await supabase
          .from("unit_custom_fields")
          .select("sort_order")
          .eq("unit_id", unitId)
          .order("sort_order", { ascending: false })
          .limit(1)
          .maybeSingle();
        order = (maxRow?.sort_order ?? -1) + 1;
      }

      const { data, error } = await supabase
        .from("unit_custom_fields")
        .insert({
          unit_id: unitId,
          label: input.label,
          type: input.type,
          options: input.type === "options" ? input.options ?? [] : null,
          required: input.required ?? false,
          sort_order: order,
          active: true,
        })
        .select()
        .single();
      if (error) throw error;
      return data as UnitCustomField;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-fields", unitId] });
    },
  });
}

export function useUpdateCustomField(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { id: string } & Partial<{
        label: string;
        options: string[] | null;
        required: boolean;
        sort_order: number;
        active: boolean;
      }>,
    ) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("unit_custom_fields")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as UnitCustomField;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-fields", unitId] });
    },
  });
}

export function useDeleteCustomField(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("unit_custom_fields").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-fields", unitId] });
    },
  });
}
