import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export type VoucherTrigger =
  | "after_rating"
  | "manual"
  | "birthday"
  | "frequency";

export type VoucherStatus = "active" | "used" | "expired" | "cancelled";

export interface VoucherRule {
  id: string;
  unit_id: string;
  name: string;
  trigger_type: VoucherTrigger;
  discount_percent: number;
  validity_days: number;
  min_rating: number | null;
  visits_required: number | null;
  days_window: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Voucher {
  id: string;
  unit_id: string;
  rule_id: string | null;
  customer_id: string;
  code: string;
  discount_percent: number;
  status: VoucherStatus;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_user_id: string | null;
  reservation_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface VoucherWithCustomer extends Voucher {
  customer: { id: string; name: string; phone: string; email: string | null } | null;
  rule: { id: string; name: string; trigger_type: VoucherTrigger } | null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I

export function generateVoucherCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

async function ensureUniqueActiveCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateVoucherCode();
    const { data } = await supabase
      .from("vouchers")
      .select("id")
      .eq("code", code)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return code;
  }
  // Fallback estatisticamente impossível.
  return `${generateVoucherCode()}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export function useVoucherRules(unitId: string) {
  return useQuery({
    queryKey: ["voucher-rules", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("voucher_rules")
        .select("*")
        .eq("unit_id", unitId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as VoucherRule[];
    },
    enabled: !!unitId,
  });
}

export type VoucherRuleInput = {
  name: string;
  trigger_type: VoucherTrigger;
  discount_percent: number;
  validity_days: number;
  min_rating?: number | null;
  visits_required?: number | null;
  days_window?: number | null;
  active?: boolean;
};

export function useCreateVoucherRule(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VoucherRuleInput) => {
      const { data, error } = await supabase
        .from("voucher_rules")
        .insert({ unit_id: unitId, ...input })
        .select()
        .single();
      if (error) throw error;
      return data as VoucherRule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["voucher-rules", unitId] });
    },
  });
}

export function useUpdateVoucherRule(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & Partial<VoucherRuleInput>) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("voucher_rules")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as VoucherRule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["voucher-rules", unitId] });
    },
  });
}

export function useDeleteVoucherRule(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("voucher_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["voucher-rules", unitId] });
    },
  });
}

// ── Vouchers ──────────────────────────────────────────────────────────────────

export function useVouchers(unitId: string) {
  return useQuery({
    queryKey: ["vouchers", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vouchers")
        .select(
          "*, customer:customers(id, name, phone, email), rule:voucher_rules(id, name, trigger_type)",
        )
        .eq("unit_id", unitId)
        .order("issued_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as unknown as VoucherWithCustomer[];
    },
    enabled: !!unitId,
  });
}

export interface IssueVoucherInput {
  customer_id: string;
  discount_percent: number;
  validity_days: number;
  rule_id?: string | null;
  notes?: string | null;
}

export function useIssueVoucher(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: IssueVoucherInput): Promise<Voucher> => {
      const code = await ensureUniqueActiveCode();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + input.validity_days);

      const { data, error } = await supabase
        .from("vouchers")
        .insert({
          unit_id: unitId,
          customer_id: input.customer_id,
          rule_id: input.rule_id ?? null,
          code,
          discount_percent: input.discount_percent,
          expires_at: expiresAt.toISOString(),
          notes: input.notes ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      return data as Voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vouchers", unitId] });
    },
  });
}

export function useRedeemVoucher(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reservation_id?: string | null }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("vouchers")
        .update({
          status: "used",
          used_at: new Date().toISOString(),
          used_by_user_id: user?.id ?? null,
          reservation_id: input.reservation_id ?? null,
        })
        .eq("id", input.id)
        .eq("status", "active")
        .select()
        .single();
      if (error) throw error;
      return data as Voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vouchers", unitId] });
    },
  });
}

export function useCancelVoucher(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("vouchers")
        .update({ status: "cancelled" })
        .eq("id", id)
        .eq("status", "active")
        .select()
        .single();
      if (error) throw error;
      return data as Voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vouchers", unitId] });
    },
  });
}

// ── Lookup por código (tela de validação operacional) ────────────────────────

export function useFindVoucherByCode(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string): Promise<VoucherWithCustomer | null> => {
      const cleaned = code.trim().toUpperCase();
      if (!cleaned) return null;
      const { data, error } = await supabase
        .from("vouchers")
        .select(
          "*, customer:customers(id, name, phone, email), rule:voucher_rules(id, name, trigger_type)",
        )
        .eq("unit_id", unitId)
        .eq("code", cleaned)
        .eq("status", "active")
        .maybeSingle();
      if (error) throw error;
      return data as unknown as VoucherWithCustomer | null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vouchers", unitId] });
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const TRIGGER_LABEL: Record<VoucherTrigger, string> = {
  after_rating: "Após avaliação",
  manual: "Manual",
  birthday: "Aniversário",
  frequency: "Frequência",
};

export const TRIGGER_DESCRIPTION: Record<VoucherTrigger, string> = {
  after_rating: "Cliente recebe voucher ao responder a pesquisa D+1",
  manual: "Operador emite voucher individualmente",
  birthday: "Job diário emite no aniversário do cliente",
  frequency: "Cliente que veio N vezes em M dias ganha voucher",
};

export const STATUS_LABEL: Record<VoucherStatus, string> = {
  active: "Ativo",
  used: "Usado",
  expired: "Expirado",
  cancelled: "Cancelado",
};
