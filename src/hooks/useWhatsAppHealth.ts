import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

type WhatsAppHealthProvider = "zapi" | "uazapi" | "waha" | "official" | "datafy";

export interface WhatsAppHealthChannel {
  id: string;
  provider: WhatsAppHealthProvider;
  status: "connected" | "disconnected" | "error";
  display_phone: string | null;
  last_event_at: string | null;
  last_error: string | null;
  credentials_present: string[];
  created_at: string;
  updated_at: string;
}

export interface WhatsAppHealthAi {
  provider: string;
  model: string | null;
  key_source: "byok" | "global" | "missing";
  byok_last4: string | null;
  byok_updated_at: string | null;
  global_env: string;
}

export interface WhatsAppHealthExecution {
  id: string;
  request_id: string;
  outcome: string;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  phone_hash: string | null;
  meta: Record<string, unknown> | null;
}

export interface WhatsAppHealthResponse {
  success: boolean;
  generated_at: string;
  channel: WhatsAppHealthChannel | null;
  ai: WhatsAppHealthAi;
  stats_24h: {
    total: number;
    by_outcome: Record<string, number>;
    sample_size: number;
  };
  last_executions: WhatsAppHealthExecution[];
}

export function useWhatsAppHealth(unitId: string | undefined) {
  return useQuery({
    queryKey: ["whatsapp-health", unitId],
    queryFn: async (): Promise<WhatsAppHealthResponse> => {
      const { data, error } = await supabase.functions.invoke("whatsapp-health", {
        body: { unit_id: unitId },
      });
      if (error) {
        const msg = (data as { error?: string } | null)?.error ?? error.message ?? "Falha ao consultar saúde do WhatsApp.";
        throw new Error(msg);
      }
      if (data && typeof data === "object" && "error" in data && data.error) {
        throw new Error(String(data.error));
      }
      return data as WhatsAppHealthResponse;
    },
    enabled: !!unitId,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
