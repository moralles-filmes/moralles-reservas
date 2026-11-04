/**
 * Rótulos PT-BR dos desfechos de `outcomes_24h` do diagnóstico. As chaves vêm
 * de process-instagram-inbound e do núcleo do agente (_shared/agent/turn.ts).
 * Chave desconhecida cai na própria chave, para nunca esconder um desfecho novo.
 */
const OUTCOME_LABELS: Record<string, string> = {
  // Evento
  processed: "Evento processado",
  no_items: "Evento sem itens",
  malformed_body: "Evento malformado",
  attempts_exhausted: "Tentativas esgotadas",
  tenant_mismatch: "Unidade divergente",
  unit_read_failed: "Falha ao ler a unidade",
  item_retry: "Item reagendado",
  worker_error: "Erro no processamento",
  account_read_failed: "Falha ao ler a conta",
  grant_read_failed: "Falha ao ler a liberação",
  settings_read_failed: "Falha ao ler as configurações",
  discarded_account_not_connected: "Descartado: conta não conectada",
  discarded_no_grant: "Descartado: módulo não liberado",
  discarded_dm_disabled: "Descartado: Direct desligado",
  // Mensagem
  success: "Respondida",
  success_history_degraded: "Respondida (histórico não gravado)",
  echo_own: "Eco de resposta própria",
  echo_unknown: "Eco de origem desconhecida",
  ignored_deleted: "Ignorada: mensagem apagada",
  ignored_unsupported: "Ignorada: tipo não suportado",
  ignored_non_message: "Ignorada: não era mensagem",
  ignored_self: "Ignorada: enviada pela própria conta",
  ignored_malformed: "Ignorada: malformada",
  ignored_story_mention: "Ignorada: menção em story",
  rate_limited: "Limite de mensagens do contato",
  org_billing_blocked: "Bloqueada por cobrança",
  media_during_handoff: "Mídia durante atendimento humano",
  media_response: "Mídia respondida com aviso",
  media_notice_deferred: "Mídia: aviso depois da resposta",
  duplicate: "Mensagem duplicada",
  send_error: "Erro no envio",
  send_outcome_unknown: "Envio com resultado desconhecido",
  conversation_tenant_mismatch: "Conversa de outra unidade",
  webhook_error: "Erro no processamento",
  agent_error: "Erro do agente de IA",
  ai_budget_error: "Erro na franquia de IA",
  ai_budget_exhausted: "Franquia de IA esgotada",
  ai_budget_denied: "Franquia de IA negada",
  ai_key_unavailable: "Chave de IA indisponível",
  ai_reply_suppressed_by_human: "Resposta da IA suprimida por atendimento humano",
  conversation_locked: "Conversa em uso",
  debounced_superseded: "Agrupada com mensagem seguinte",
  empty_response: "Resposta vazia",
  handoff_state_changed: "Atendimento mudou durante a resposta",
  status_changed_locked: "Status da conversa mudou",
  invalid_channel_context: "Contexto de canal inválido",
  human_active_reminded: "Atendimento humano: aviso enviado",
  human_active_silent: "Atendimento humano: sem resposta da IA",
  unknown_outcome: "Desfecho desconhecido",
};

export function outcomeLabel(outcome: string): string {
  return Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, outcome) ? OUTCOME_LABELS[outcome] : outcome;
}
