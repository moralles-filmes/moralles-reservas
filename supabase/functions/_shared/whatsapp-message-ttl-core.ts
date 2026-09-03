// supabase/functions/_shared/whatsapp-message-ttl-core.ts
/**
 * Prazo de validade das mensagens automáticas de WhatsApp.
 *
 * POR QUE ISTO EXISTE, e o que ele NÃO resolve — registrado porque a leitura
 * intuitiva superestima a peça. No incidente de 2026-09-03 (canal Z-API fora do
 * ar por 6,6 dias, 88 mensagens despejadas em 2,5 minutos na reconexão), TODAS
 * as mensagens estavam VÁLIDAS no instante em que foram postadas: o lembrete
 * saiu no dia da reserva, o aviso de fila saiu minutos após a entrada. Elas
 * venceram DENTRO da fila da Z-API, onde o nosso código não tem autoridade
 * nenhuma. Quem impede aquele cenário é o gate de conexão em
 * `whatsapp-send.ts`, não este arquivo.
 *
 * Este núcleo cobre os caminhos em que a mensagem fica represada DO NOSSO LADO
 * e alcança o envio já sem sentido:
 *   - `resend-notification`, alimentado pelo painel Entregas — depois de uma
 *     queda longa ele fica cheio de não-entregues antigos e o reenvio em lote é
 *     um clique;
 *   - `notification_outbox`, único caminho com retry nosso (backoff até ~5,5h);
 *   - represamento criado pelo próprio gate de conexão, quando uma execução
 *     posterior do worker alcança um fato já vencido.
 *
 * FUSO: este núcleo NÃO conhece BRT. Ele compara instantes, e `factAt` precisa
 * chegar como ISO com offset explícito — quem monta a data+hora de uma reserva
 * (`YYYY-MM-DD` + `HH:MM` do Postgres) é responsável por escrever `-03:00`,
 * mesma regra de `availability.ts`. Um `factAt` sem offset seria interpretado
 * como UTC e venceria 3h cedo demais.
 */

/**
 * Kinds com prazo definido. Deliberadamente NÃO é `notifications_sent.kind`
 * inteiro: `cancellation` e `confirmation_email` ficam de fora porque um aviso
 * de cancelamento atrasado continua sendo informação que o cliente quer, e
 * e-mail não participa do risco de bloqueio que motivou esta peça.
 */
export type ExpirableMessageKind =
  | "waitlist_table_ready"
  | "waitlist_entered"
  | "waitlist_feedback"
  | "reminder_d1"
  | "survey_d1"
  | "confirmation"
  | "voucher_issued";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Prazo contado a partir do FATO que originou a mensagem, nunca do instante em
 * que ela foi produzida ou postada. Fonte única — consumidor que redigite um
 * número aqui reintroduz a divergência que este arquivo existe para impedir.
 *
 * `reminder_d1` e `confirmation` valem 0ms porque o fato de referência JÁ É o
 * horário da reserva: elas vencem exatamente quando a reserva começa. Não é um
 * caso especial no código, só o mesmo cálculo com prazo zero.
 */
export const MESSAGE_TTL_MS: Readonly<Record<ExpirableMessageKind, number>> = Object.freeze({
  waitlist_table_ready: 30 * MINUTE,
  waitlist_entered: 2 * HOUR,
  waitlist_feedback: 24 * HOUR,
  reminder_d1: 0,
  survey_d1: 48 * HOUR,
  confirmation: 0,
  voucher_issued: 7 * DAY,
});

/**
 * `send` e `discard` são as ÚNICAS consequências. Um campo booleano `valid`
 * seria ambíguo justamente onde importa: `missing_fact_at` é uma invalidez que
 * NÃO descarta, e um caller lendo `if (!valid) return` silenciaria envio
 * legítimo. Aqui a pergunta do caller é uma só — `decision === "discard"`.
 */
export type MessageTtlDecision = "send" | "discard";

export type MessageTtlReason =
  /** Dentro do prazo. */
  | "within_ttl"
  /** Fora do prazo — único motivo que descarta. */
  | "expired"
  /** Kind sem prazo definido; segue por não haver regra que o cubra. */
  | "unmapped_kind"
  /** Produtor não informou `fact_at`; segue, mas é defeito a corrigir. */
  | "missing_fact_at"
  /** `fact_at` impossível de interpretar; segue, mas é defeito a corrigir. */
  | "invalid_fact_at";

export interface MessageTtlResult {
  decision: MessageTtlDecision;
  reason: MessageTtlReason;
  /** Instante do vencimento, quando calculável. Só para log e UI. */
  expiresAt: string | null;
}

export interface MessageTtlInput {
  /** `notifications_sent.kind`. Valor fora de `MESSAGE_TTL_MS` segue sem prazo. */
  kind: string;
  /** ISO 8601 COM offset explícito do fato que originou a mensagem. */
  factAt: string | null | undefined;
  /** Instante da decisão. Injetado — o núcleo nunca chama `Date.now()`. */
  now: string | number | Date;
}

function isExpirableKind(kind: string): kind is ExpirableMessageKind {
  return Object.prototype.hasOwnProperty.call(MESSAGE_TTL_MS, kind);
}

function toMillis(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

/**
 * Decide se a mensagem ainda faz sentido no instante `now`.
 *
 * FAIL-OPEN em toda incerteza (kind não mapeado, `factAt` ausente ou
 * impossível de interpretar), e isso é decisão, não descuido: esta peça não
 * pode silenciar envio legítimo por causa de um produtor que ainda não passa
 * `fact_at`. O preço é que produtor omisso não é barrado — por isso cada
 * incerteza tem `reason` PRÓPRIO, distinguível de `within_ttl` na telemetria.
 */
export function decideMessageTtl(input: MessageTtlInput): MessageTtlResult {
  const { kind, factAt, now } = input;

  if (!isExpirableKind(kind)) {
    return { decision: "send", reason: "unmapped_kind", expiresAt: null };
  }

  if (factAt === null || factAt === undefined || factAt === "") {
    return { decision: "send", reason: "missing_fact_at", expiresAt: null };
  }

  const factMs = new Date(factAt).getTime();
  if (!Number.isFinite(factMs)) {
    return { decision: "send", reason: "invalid_fact_at", expiresAt: null };
  }

  const nowMs = toMillis(now);
  if (!Number.isFinite(nowMs)) {
    // Sem instante de referência confiável não há decisão possível; a única
    // saída coerente com o fail-open acima é deixar passar.
    return { decision: "send", reason: "invalid_fact_at", expiresAt: null };
  }

  const expiresMs = factMs + MESSAGE_TTL_MS[kind];
  const expiresAt = new Date(expiresMs).toISOString();

  // Estritamente MAIOR: no instante exato do vencimento a mensagem ainda vale.
  // A fronteira precisa ser inequívoca porque `reminder_d1` vence no horário da
  // reserva, e um lembrete disparado no segundo cheio não pode sumir.
  if (nowMs > expiresMs) {
    return { decision: "discard", reason: "expired", expiresAt };
  }

  return { decision: "send", reason: "within_ttl", expiresAt };
}

/**
 * `missing_fact_at` e `invalid_fact_at` são defeitos de PRODUTOR, não mensagem
 * vencida. Quem loga precisa separar os dois sem redigitar a lista — um
 * `unmapped_kind` é decisão nossa de não dar prazo, os outros dois são bug.
 */
export function isProducerDefect(reason: MessageTtlReason): boolean {
  return reason === "missing_fact_at" || reason === "invalid_fact_at";
}

/**
 * Monta um `fact_at` em BRT a partir de data e hora vindas do Postgres.
 *
 * Existe para que os produtores não repitam DOIS gotchas já documentados no
 * `CLAUDE.md`: coluna `time` volta como `HH:MM:SS` (interpolar direto gera dois
 * blocos de segundos → `Invalid Date` silencioso), e Deno roda em UTC (sem o
 * offset `-03:00` a reserva das 20h viraria 17h BRT e todo lembrete venceria
 * três horas cedo). Devolve `null` quando falta dado, o que o núcleo trata como
 * defeito de produtor — nunca como mensagem vencida.
 */
export function brtFactAt(
  date: string | null | undefined,
  time: string | null | undefined,
): string | null {
  if (!date) return null;
  const hhmm = (time ?? "").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return null;
  return `${date}T${hhmm}:00-03:00`;
}
