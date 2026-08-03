/**
 * Textos DETERMINÍSTICOS enviados ao cliente final quando a IA é bloqueada
 * (spec §17.7.4, §18.3). ZERO IMPORTS.
 *
 * POR QUE NÃO GERAR COM IA: explicar que a IA foi bloqueada exigiria justamente
 * a chamada que foi negada. O texto é hardcoded, e entra no
 * `HARDCODED_AGENT_NOISE` do `webhook-whatsapp` no MESMO PR — precedente direto
 * de `MEDIA_REPLY_TEXT`. Sem isso, ele polui o histórico das invocações
 * seguintes e ensina o modelo que "atendimento interrompido" é o padrão.
 *
 * O DESTINATÁRIO É O CLIENTE DO RESTAURANTE, não o lojista. Nenhum texto aqui
 * pode citar custo em reais, tokens, preço de modelo, margem, o limite de
 * R$ 100 — nem a palavra "franquia", que é vocabulário do contrato entre a
 * plataforma e o lojista e não significa nada para quem quer reservar uma mesa.
 * A spec §18.3 apresenta um texto "conceitual" com esse vocabulário; ele descreve
 * o QUE comunicar (atendimento humano assume, nada quebrou), e a regra da própria
 * §18.3 — "nunca informar ao cliente ... o limite" — é o que fixa o vocabulário
 * final aqui. Desvio registrado em docs/billing-asaas/PLANO-D-PENDENCIAS.md.
 *
 * Também não pode afirmar falha técnica (§18.3): não houve falha nenhuma.
 */

/** Hard stop puro: nenhuma ferramenta mutante rodou neste turno. */
export const AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT =
  "Vou passar sua conversa para a equipe do restaurante. Sua mensagem já está registrada e alguém da equipe continua com você por aqui.";

/**
 * As TRÊS situações de §17.7.4. Usar a mesma frase para as três é o erro que
 * produz cliente aparecendo no restaurante sem mesa.
 */
export const AI_BUDGET_STOP_AFTER_MUTATION_COMPLETED_TEXT =
  "Pronto, sua solicitação foi confirmada. Vou passar a conversa para a equipe do restaurante, que segue com você por aqui.";

export const AI_BUDGET_STOP_AFTER_MUTATION_PENDING_TEXT =
  "Registrei sua solicitação — ela ainda depende de uma confirmação do restaurante. Passei a conversa para a equipe, que finaliza com você por aqui.";

export const AI_BUDGET_STOP_AFTER_MUTATION_UNKNOWN_TEXT =
  "Vou passar sua conversa para a equipe do restaurante agora. Eles verificam tudo com você por aqui antes de seguir.";

export type MutationOutcome = "COMPLETED" | "PENDING" | "UNKNOWN";

/**
 * Na dúvida, `UNKNOWN`. Afirmar conclusão de uma ação que ainda exige validação
 * é o único dos três erros que manda alguém para o restaurante sem mesa.
 */
export function resolveMutationStopText(outcome: MutationOutcome): string {
  if (outcome === "COMPLETED") return AI_BUDGET_STOP_AFTER_MUTATION_COMPLETED_TEXT;
  if (outcome === "PENDING") return AI_BUDGET_STOP_AFTER_MUTATION_PENDING_TEXT;
  return AI_BUDGET_STOP_AFTER_MUTATION_UNKNOWN_TEXT;
}

/**
 * TODOS os textos deste arquivo. `webhook-whatsapp` espalha esta lista dentro do
 * `HARDCODED_AGENT_NOISE` — importar a lista em vez de redigitar as frases é o
 * que impede que um texto novo apareça sem entrar no filtro.
 */
export const AI_BUDGET_HARDCODED_TEXTS: string[] = [
  AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
  AI_BUDGET_STOP_AFTER_MUTATION_COMPLETED_TEXT,
  AI_BUDGET_STOP_AFTER_MUTATION_PENDING_TEXT,
  AI_BUDGET_STOP_AFTER_MUTATION_UNKNOWN_TEXT,
];
