/**
 * Contrato entre um canal de mensagens e o núcleo do agente de IA.
 *
 * O núcleo (`turn.ts`, `system-prompt.ts`, `tools.ts`) não sabe de provider,
 * credencial nem formato de mensagem: tudo o que muda por canal entra por aqui.
 * O WhatsApp é o único consumidor hoje; o Instagram (Fase 1) entra com o próprio
 * contexto. Spec: docs/superpowers/specs/2026-10-19-instagram-modulo-design.md.
 *
 * `customer` é anulável só para canal de identidade DECLARADA (com
 * `claimedIdentity`): o contato do Instagram começa sem telefone e o liga pela
 * ferramenta `link_customer_phone`. Sem porta, `customer` nulo é contexto
 * inválido e o turno para na guarda do início de `run`.
 *
 * Só tipos: nada aqui entra no bundle.
 */

import type { ReservationInsertRow } from "../availability.ts";

export type AgentChannel = "whatsapp" | "instagram";

/**
 * Valor de `reservations.source` que o agente grava. Load-bearing: o trigger
 * `enqueue_confirmation_notification` pula `whatsapp` para não duplicar a
 * confirmação. `instagram` (CHECK liberado na migration 20261103120400) NÃO é
 * pulado: a reserva feita pelo Direct é confirmada pelo WhatsApp (D6).
 */
export type AgentReservationSource = "whatsapp" | "instagram";

export type LinkPhoneResult =
  | { ok: true; customer: Pick<AgentCustomer, "id" | "phone"> }
  | { ok: false; reason: "invalid_phone" | "unavailable" };

/**
 * Canal cuja identidade do cliente NÃO é provada pelo canal (telefone digitado).
 *
 * É a única entrada de id no núcleo para esse canal: nenhum id de cliente ou de
 * reserva vem do LLM. O adapter resolve o cliente no servidor, dentro da
 * organização do contato, e guarda o ledger das reservas feitas pelo contato.
 */
export interface ClaimedIdentityPort {
  /** Reservas criadas por este contato (ledger). Lido uma vez por turno. */
  reservationIds(): Promise<string[]>;
  /**
   * Substitui o INSERT do `reserveSlot` (mesmo retorno do hook). O adapter grava
   * a reserva E a linha do ledger numa transação (RPC
   * `create_instagram_contact_reservation`), que confere sob lock o cliente
   * (vivo, da organização, igual ao ligado ao contato), a unidade e a origem, e
   * aplica o teto de reservas ativas do contato. É a ÚNICA barreira de
   * identidade do núcleo com porta. Recusa e falha voltam em `error.code`
   * (o 23505 da mesa dispara o retry do `reserveSlot`); o teto de reservas
   * ativas do contato volta como `CLAIMED_RESERVATION_LIMIT_CODE` (`tools.ts`),
   * que o núcleo devolve ao LLM com mensagem própria.
   */
  insertReservation(row: ReservationInsertRow): Promise<{
    data: { id: string; status: string; payment_status: string | null } | null;
    error: { code?: string } | null;
  }>;
  /** Liga o telefone declarado ao contato; nenhum id atravessa a porta. */
  linkPhone(input: { phone: string; name: string }): Promise<LinkPhoneResult>;
}

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
  /**
   * Cliente resolvido pelo canal. `null` só com `claimedIdentity` (contato que
   * ainda não ligou um telefone); sem porta, nulo é contexto inválido.
   */
  customer: AgentCustomer | null;
  /**
   * Telefone do contato como chegou pelo canal (WhatsApp: `inbound.fromPhone`).
   * O prompt o usa para reconhecer nome-placeholder (cliente gravado com o
   * telefone no nome). `null` quando o canal não traz telefone.
   */
  phone: string | null;
  /**
   * Presente só em canal de identidade declarada (Instagram). Com ela: o prompt
   * nunca recebe o cadastro privado (R3-a), `link_customer_phone` passa a
   * existir e as ferramentas de reserva só alcançam o ledger do contato.
   */
  claimedIdentity?: ClaimedIdentityPort;
  /** Frase de identidade do cliente no prompt, sem ponto final duplicado. */
  identityLine: string;
  /** Bloco de regras de formatação do canal, sem as quebras de linha iniciais. */
  formattingRules: string;
  /**
   * Nome do canal como o cliente o conhece (WhatsApp: `"WhatsApp"`); entra na
   * regra 12 ("NÃO trabalhamos com fila de espera pelo …"). Obrigatório: canal
   * novo não herda o nome de outro por esquecimento.
   */
  channelLabel: string;
  /**
   * Regras próprias do canal, logo depois de `formattingRules`. Vazio = nenhum
   * byte no prompt (o WhatsApp passa `""` e o prompt dele fica idêntico).
   */
  channelRules: string;
  /** Aplica-se SÓ à saída do LLM, nunca a texto determinístico. */
  sanitize(text: string): string;
  /**
   * Envio cru do canal. O núcleo o chama atrás da cerca de handoff.
   * Contrato: NUNCA lança (falha volta em `ok:false`), e `error:
   * "provider_timeout"` significa desfecho desconhecido (a mensagem pode ter
   * saído): o núcleo não devolve a janela do lembrete de handoff nesse caso.
   */
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
