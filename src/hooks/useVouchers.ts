import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { endOfDayLocalISO } from "@/lib/utils";

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

// 23505 PostgreSQL = unique_violation. Acontece em race entre dois operadores
// emitindo voucher manual com mesmo code gerado client-side, ou na UNIQUE
// PARTIAL (unit_id, rule_id, customer_id) — não cabe aqui (sempre rule_id=null).
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505";
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
      // 23:59:59.999 do dia local — cliente tem o dia inteiro até a meia-noite
      // independente do horário de emissão.
      const expiresAtIso = endOfDayLocalISO(input.validity_days);

      // B13: retry transparente em colisão de code (23505). 8 chars sobre
      // alfabeto 32 = ~1T possibilidades — colisão real é astronomicamente
      // rara, mas com 2 operadores emitindo simultaneamente pode acontecer.
      // Erro bruto do Postgres confunde operador; melhor regenerar e tentar.
      for (let attempt = 0; attempt < 4; attempt++) {
        const code = await ensureUniqueActiveCode();
        const { data, error } = await supabase
          .from("vouchers")
          .insert({
            unit_id: unitId,
            customer_id: input.customer_id,
            rule_id: input.rule_id ?? null,
            code,
            discount_percent: input.discount_percent,
            expires_at: expiresAtIso,
            notes: input.notes ?? null,
          })
          .select()
          .single();
        if (!error) return data as Voucher;
        if (!isUniqueViolation(error)) throw error;
        // Race detectada — outro insert pegou esse code. Próxima iteração gera novo.
      }
      throw new Error("Não foi possível gerar código único após múltiplas tentativas. Tente novamente.");
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
  // Lookup-only mutation — não invalida cache, é só leitura por código.
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
