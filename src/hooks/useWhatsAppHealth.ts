import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { FunctionsHttpError } from "@supabase/supabase-js";

type WhatsAppHealthProvider = "zapi" | "uazapi" | "waha" | "official" | "datafy";

export interface WhatsAppHealthChannel {
  id: string;
  provider: WhatsAppHealthProvider;
  status: "connected" | "disconnected" | "error";
  is_active?: boolean | null;
  ingestion_mode_effective?: "sync" | "async" | "unknown";
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

/**
 * Uma contagem da fila de inbound, com a JANELA que ela cobre.
 *
 * `count: null` é "a Edge Function não conseguiu contar" — nunca zero. E o
 * bloco inteiro é OPCIONAL porque a EF que o produz é deployada à mão: enquanto
 * a versão antiga estiver no ar, o campo simplesmente não vem, e afirmar "0
 * dead letters" a partir da ausência seria um falso negativo exatamente na
 * investigação em que o número importa.
 */
export interface WhatsAppHealthQueueCount {
  count: number | null;
  window_days: number;
}

/**
 * O BACKLOG NÃO É UMA `WhatsAppHealthQueueCount`, e a diferença é a ausência de
 * `window_days`.
 *
 * Linha não-terminal nunca é purgada (`purge_whatsapp_inbound_events` só alcança
 * `done` e `dead`), então este número é o estado AGORA, não um acumulado de N dias.
 * Anexar uma janela por simetria com as outras duas seria afirmação falsa — o tipo
 * separado é o que impede alguém de "unificar" os dois e reintroduzi-la.
 *
 * `oldest_received_at` é o `received_at` CRU da mais antiga, escrito pelo relógio do
 * BANCO: a idade é calculada na exibição, contra o `generated_at` da resposta. Ele é
 * AMBÍGUO sozinho (fila vazia e leitura falha dão o mesmo `null`) — quem desempata é
 * o `count`, e `describeInboundBacklog` em `@/lib/whatsapp-inbound-backlog` é quem
 * garante essa ordem.
 */
export interface WhatsAppHealthQueueBacklog {
  count: number | null;
  oldest_received_at: string | null;
}

export interface WhatsAppHealthResponse {
  ops_alert_configured?: boolean;
  success: boolean;
  generated_at: string;
  channel: WhatsAppHealthChannel | null;
  ai: WhatsAppHealthAi;
  stats_24h: {
    total: number;
    by_outcome: Record<string, number>;
    sample_size: number;
  };
  inbound_queue?: {
    dead_letter: WhatsAppHealthQueueCount;
    unauthorized_terminal: WhatsAppHealthQueueCount;
    /**
     * OPCIONAL por si, e não só porque o bloco pai é: `dead_letter` e
     * `unauthorized_terminal` foram ao ar numa versão anterior desta EF, então uma
     * resposta pode ter o bloco e NÃO ter este campo. Tratar a ausência como
     * `count: 0` afirmaria "fila vazia" sobre uma EF que nem sabe responder — a
     * mesma armadilha do `?? 0`, um nível acima.
     */
    pending?: WhatsAppHealthQueueBacklog;
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
        if (error instanceof FunctionsHttpError) {
          const body = await error.context.json().catch(() => null);
          throw new Error(body?.error ?? "Falha ao consultar saúde do WhatsApp.");
        }
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
