import {
  INBOUND_SWEEP_INTERVAL_MS,
  MAX_PENDING_BACKLOG_AGE_MS,
  SWEEP_SELECT_LIMIT,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core";

/**
 * O que o painel de diagnóstico DIZ sobre o backlog da fila de inbound.
 *
 * Núcleo puro, e mora em `src/` por duas razões que se somam:
 *
 * 1. É COPY de painel, e copy que afirma consequência diz QUAL — invariante deste
 *    repo, a mesma que tirou `"Custo atualizado."` seco do call site do painel de
 *    instâncias. Um número solto ("3") não diz nada; `"Custo atualizado."` afirmava
 *    o que não sabia. Aqui o risco é o segundo: um backlog de três horas afirmado
 *    como "3 na fila" faz o admin ler rotina onde há incidente.
 * 2. É o VEREDITO, e ele precisa de teste. A Edge Function que produz os números
 *    (`whatsapp-health`) chama `serve()` no carregamento e importa `deno.land`: o
 *    vitest não a alcança. Um limiar avaliado por filtro de PostgREST nunca seria
 *    exercitável; aqui é.
 *
 * Importa o núcleo direto de `supabase/functions/_shared/` — cross-boundary
 * deliberado, mesma razão de `whatsapp-instance-format.ts`: o limite de idade é
 * DERIVADO da escada de retentativa e do intervalo do cron, e uma segunda cópia
 * daquela aritmética em `src/` é como a divergência nasce.
 */

/** O que a EF entrega: dois fatos crus, sem veredito e sem janela. */
export interface InboundBacklogFacts {
  /** `null` = a EF não conseguiu contar. NUNCA zero. */
  count: number | null;
  /** `received_at` CRU da linha não-terminal mais antiga, escrito pelo banco. */
  oldest_received_at: string | null;
}

export type InboundBacklogKind =
  /** Não se sabe: a contagem falhou. Nunca afirma saúde nem parada. */
  | "unknown"
  /** Nada não-terminal. O pipeline não deve nada a ninguém. */
  | "empty"
  /** Há backlog, e ele está dentro do prazo da escada. Rotina. */
  | "draining"
  /** Há backlog e a mais antiga passou do prazo. Algo não está drenando. */
  | "stalled"
  /** Há backlog e a idade não é legível. Dimensiona, não conclui. */
  | "age_unknown";

export interface InboundBacklogVerdict {
  kind: InboundBacklogKind;
  /** O que o painel escreve como VALOR. `"—"` quando ninguém contou. */
  value: string;
  /** Uma frase. Diz o que o número significa e, quando é ruim, o que investigar. */
  detail: string;
  /** `true` só em `stalled` — o único caso que pede ação agora. */
  alarming: boolean;
  /** Idade da mais antiga em ms, quando legível. Para exibição, nunca decisão. */
  oldestAgeMs: number | null;
}

/** Idade em português curto. Minutos e horas: dias aqui já é catástrofe antiga. */
export function formatBacklogAge(ms: number): string {
  if (ms < 60_000) return "menos de 1 min";
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} h`;
  return `${Math.floor(horas / 24)} d`;
}

const MINUTOS_DO_LIMITE = Math.round(MAX_PENDING_BACKLOG_AGE_MS / 60_000);
const DRENO_POR_MINUTO = Math.round(
  SWEEP_SELECT_LIMIT * (60_000 / INBOUND_SWEEP_INTERVAL_MS),
);

/**
 * A ORDEM DAS PERGUNTAS É LOAD-BEARING, e a primeira é a da ignorância.
 *
 * `oldest_received_at: null` é ambíguo por natureza — "fila vazia" e "não consegui
 * ler" produzem o mesmo `null`. Quem desempata é o `count`, então ele vem primeiro:
 * `count === null` é ignorância e sai por `unknown` antes de a data ser consultada.
 * Perguntar a data primeiro faria uma leitura falha virar "fila vazia", que é o
 * `?? 0` proibido por outra porta.
 *
 * `now` é parâmetro, e o chamador passa o `generated_at` da RESPOSTA — não
 * `Date.now()`. O `received_at` vem do relógio do BANCO; comparar com o relógio do
 * navegador colocaria um viewer de relógio quebrado inventando três horas de
 * backlog. Com `generated_at` a comparação é servidor-contra-servidor, e a
 * defasagem que restaria desloca uma idade de horas em milissegundos.
 *
 * FAIL-OPEN NO VEREDITO, NUNCA NA CONTAGEM: idade ilegível ou negativa não afirma
 * parada (`age_unknown`), porque alarme falso ensina o operador a ignorar o painel
 * — e aí o sinal deixa de existir quando for verdadeiro. Mas a contagem continua
 * sendo dita: ela é o fato, e nenhum ramo a esconde.
 */
export function describeInboundBacklog(
  facts: InboundBacklogFacts | null | undefined,
  now: string | number | Date,
): InboundBacklogVerdict {
  const count = facts?.count ?? null;

  if (count === null || !Number.isFinite(count)) {
    return {
      kind: "unknown",
      value: "—",
      detail:
        "Não foi possível contar a fila. Isto não é o mesmo que fila vazia — nada "
        + "se sabe sobre o pipeline agora.",
      alarming: false,
      oldestAgeMs: null,
    };
  }

  if (count <= 0) {
    return {
      kind: "empty",
      value: "0",
      detail:
        "Nenhuma entrega aguardando ou em processamento. O pipeline não deve "
        + "resposta a ninguém.",
      alarming: false,
      oldestAgeMs: null,
    };
  }

  const nowMs = new Date(now).getTime();
  const oldestMs = facts?.oldest_received_at
    ? new Date(facts.oldest_received_at).getTime()
    : NaN;
  const idade = nowMs - oldestMs;

  if (!Number.isFinite(idade) || idade < 0) {
    return {
      kind: "age_unknown",
      value: String(count),
      detail:
        "Entregas aguardando ou em processamento. A idade da mais antiga não pôde "
        + "ser lida, então não há como dizer se a fila está drenando.",
      alarming: false,
      oldestAgeMs: null,
    };
  }

  if (idade <= MAX_PENDING_BACKLOG_AGE_MS) {
    return {
      kind: "draining",
      value: String(count),
      detail:
        `Entregas aguardando ou em processamento; a mais antiga há `
        + `${formatBacklogAge(idade)}. Dentro do prazo da escada de retentativa — `
        + `a fila está drenando.`,
      alarming: false,
      oldestAgeMs: idade,
    };
  }

  // A COPY NOMEIA AS DUAS CAUSAS, e isto não é cautela — é a lição que a contagem
  // de `unauthorized_terminal` deste mesmo painel já aprendeu: descrever uma causa
  // só ensina o admin a ler o número como rotina e parar de olhar, perdendo o
  // rastro no caso que importa. Aqui a segunda causa é real e comum: um backlog
  // mais profundo que o que a varredura serve por minuto demora mais que o limite
  // para drenar mesmo com a varredura perfeita. Afirmar "a varredura não está
  // rodando" seria afirmar o que este número não sabe.
  return {
    kind: "stalled",
    value: String(count),
    detail:
      `A mais antiga está aqui há ${formatBacklogAge(idade)} — acima dos `
      + `~${MINUTOS_DO_LIMITE} min em que a escada de retentativa termina. O backlog `
      + `não está drenando: ou a varredura não está rodando (job desagendado, ou o `
      + `POST do pg_net levando 401 desde uma rotação da chave interna — pg_net é `
      + `fire-and-forget e não reporta a ninguém), ou o backlog é mais fundo que as `
      + `~${DRENO_POR_MINUTO} entregas por minuto que ela serve. Confira `
      + `net._http_response e o job whatsapp-inbound-sweep em cron.job.`,
    alarming: true,
    oldestAgeMs: idade,
  };
}
