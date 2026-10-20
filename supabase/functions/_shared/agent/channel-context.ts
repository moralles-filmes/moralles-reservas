/**
 * Contrato entre um canal de mensagens e o núcleo do agente de IA.
 *
 * O núcleo (`turn.ts`, `system-prompt.ts`, `tools.ts`) não sabe de provider,
 * credencial nem formato de mensagem: tudo o que muda por canal entra por aqui.
 * O WhatsApp é o único consumidor hoje; o Instagram (Fase 1) entra com o próprio
 * contexto. Spec: docs/superpowers/specs/2026-10-19-instagram-modulo-design.md.
 *
 * Fase 0 mantém `customer` OBRIGATÓRIO. O contato do Instagram sem telefone
 * (`customer: null`), a ferramenta `link_customer_phone` e o `need_phone` de
 * `create_reservation` chegam juntos na Fase 1, que é quem os consome: aceitar
 * `null` aqui antes disso seria um ramo sem consumidor e sem teste.
 *
 * Só tipos: nada aqui entra no bundle.
 */

export type AgentChannel = "whatsapp" | "instagram";

/**
 * Valor de `reservations.source` que o agente grava. Load-bearing: o trigger
 * `enqueue_confirmation_notification` pula `whatsapp` para não duplicar a
 * confirmação. `instagram` só entra aqui junto com a migration que o libera no
 * CHECK e no trigger (Fase 1).
 */
export type AgentReservationSource = "whatsapp";

/** Formato mínimo que o núcleo lê do envio do canal. */
export interface ChannelSendResult {
  ok: boolean;
  status?: number;
  error?: string;
  missingCreds?: unknown;
  bodySnippet?: string;
}

/** Linha de `customers` como o canal a resolveu (`resolveOrCreateCustomer`). */
export interface AgentCustomer {
  id: string;
  name?: string | null;
  phone: string;
  birthday?: string | null;
  allergies?: string | null;
  dietary_restrictions?: string | null;
  vip_notes?: string | null;
  preferred_table_location?: string | null;
}

/** Linha de `conversations` carregada pelo canal; o núcleo a atualiza em memória. */
export interface AgentConversation {
  id: string;
  // deno-lint-ignore no-explicit-any
  messages: any[];
  status: string;
  handoff_reason?: string | null;
  handoff_at?: string | null;
  last_silenced_reply_at?: string | null;
}

/** Dados da unidade que o canal já leu (`units` com `SELECT *`). */
export interface AgentUnit {
  // deno-lint-ignore no-explicit-any
  row: Record<string, any> | null;
  name: string;
  slug: string | null;
  address: string;
  ticketMax: number | null;
}

export interface ChannelContext {
  channel: AgentChannel;
  unitId: string;
  organizationId: string;
  unit: AgentUnit;
  conversation: AgentConversation;
  customer: AgentCustomer;
  /**
   * Telefone do contato como chegou pelo canal (WhatsApp: `inbound.fromPhone`).
   * `create_reservation` o usa para resolver o cliente, e o prompt o usa para
   * reconhecer nome-placeholder (cliente gravado com o telefone no nome).
   */
  phone: string;
  /** Frase de identidade do cliente no prompt, sem ponto final duplicado. */
  identityLine: string;
  /** Bloco de regras de formatação do canal, sem as quebras de linha iniciais. */
  formattingRules: string;
  /** Aplica-se SÓ à saída do LLM, nunca a texto determinístico. */
  sanitize(text: string): string;
  /** Envio cru do canal. O núcleo o chama atrás da cerca de handoff. */
  send(text: string): Promise<ChannelSendResult>;
  reservationSource: AgentReservationSource;
  /** Lido de forma preguiçosa, só quando há cardápio digital ativo. */
  appBaseUrl(): string;
  /** Rótulo que acompanha os logs de ferramenta e uso (WhatsApp: `channelId`). */
  channelId: string | null;
}

/** A mensagem do cliente que abriu este turno. */
export interface TurnInbound {
  text: string;
  timestamp: number | string | null | undefined;
  receivedAt: string;
  /** `event_id` estável por tentativa (o banco deduplica). */
  eventId: string;
}
