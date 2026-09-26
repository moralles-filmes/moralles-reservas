import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOUND_LEASE_TTL_MS,
  INBOUND_ERROR_TEXT_MAX,
  lockTtlSecondsRequired,
  sanitizeQueueErrorText,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core";

/**
 * Testes de ACOPLAMENTO da re-entrada a partir da fila.
 *
 * Eles leem FONTE, o que é um instrumento grosseiro — e é o único disponível
 * aqui: o `index.ts` do `webhook-whatsapp` chama `serve()` no carregamento e
 * importa `deno.land`, então o vitest não o importa, e a migration é SQL que
 * nenhum runtime de teste deste repo executa. Regra que só se confere por leitura
 * humana já deixou passar defeito duas vezes neste repo (o `ReferenceError` no
 * caminho de autorização do worker de ciclos, e o conflito FK × CHECK da 089).
 */

// `resolve(__dirname, ...)`, não `new URL(..., import.meta.url)`: a configuração
// de teste deste repo não entrega `import.meta.url` como URL `file:`, e a segunda
// forma estoura "The URL must be of scheme file". É a convenção dos outros testes
// de acoplamento daqui (ver `datafy-adapter-coupling-guard.test.ts`).
const EF = readFileSync(
  resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"),
  "utf8",
);

const MIGRATION_113 = readFileSync(
  resolve(
    __dirname,
    "../../supabase/migrations/20260924120200_113_inbound_claim_rpc.sql",
  ),
  "utf8",
);

// `whatsapp-health` também chama `serve()` no carregamento e importa
// `deno.land`: o vitest não a alcança, e as duas armadilhas das contagens
// (tirá-las da amostra de 50 execuções; esquecer o escopo de unidade numa tabela
// FORCE RLS sem policies) só têm guarda se alguém ler a fonte.
const HEALTH_EF = readFileSync(
  resolve(__dirname, "../../supabase/functions/whatsapp-health/index.ts"),
  "utf8",
);

/** Recorta o corpo de uma função SQL da migration, da assinatura até o `$$;`. */
const corpoSql = (sql: string, assinatura: string): string => {
  const inicio = sql.indexOf(assinatura);
  if (inicio < 0) return "";
  const fim = sql.indexOf("$$;", inicio);
  return fim > inicio ? sql.slice(inicio, fim) : "";
};

/**
 * Recorta uma função TypeScript da EF, desta declaração até a seguinte, SEM as
 * linhas de comentário.
 *
 * Tirar os comentários não é higiene: aqui as asserções são de PRESENÇA, e um
 * comentário que cite o trecho procurado (esses comentários citam bastante)
 * satisfaria a asserção sozinho — falso verde, e o controle positivo também
 * mentiria, porque a cirurgia removeria a citação em vez do código. É o oposto
 * do guard da Datafy, onde a asserção é de AUSÊNCIA e por isso o comentário
 * conta como violação.
 *
 * Só sai a linha INTEIRA de comentário — a que começa com duas barras —, nunca
 * duas barras no meio de uma linha: dentro de string (uma URL, por exemplo)
 * elas não são comentário nenhum.
 */
const corpoTs = (fonte: string, declaracao: string, ateDeclaracao: string): string => {
  const inicio = fonte.indexOf(declaracao);
  if (inicio < 0) return "";
  const fim = fonte.indexOf(ateDeclaracao, inicio);
  if (fim <= inicio) return "";
  return fonte
    .slice(inicio, fim)
    .split("\n")
    .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
    .join("\n");
};

describe("anti-laço: a re-entrada não pode reinserir o evento", () => {
  // O dano não é simétrico entre providers, e é isso que faz este teste valer.
  // Numa entrega Datafy o `delivery_id` existe e o unique parcial da 111 pararia
  // o laço no segundo insert (23505). Nos QUATRO providers legados o
  // `delivery_id` é NULL, e NULL é distinto de NULL em índice unique: cada
  // re-entrada inseriria uma linha NOVA e despacharia OUTRO `waitUntil`. O laço
  // cresce, e Z-API e UazAPI estão em produção com loja real.
  it("processQueuedEventById re-entra com source: \"queue\"", () => {
    expect(EF).toMatch(/source:\s*"queue"/);
  });

  it("a decisão de persistir vem do núcleo, não de um if solto no handler", () => {
    expect(EF).toMatch(/decideIngestionMode\(/);
    // Controle positivo: se alguém reimplementar a pergunta no handler, reprova.
    expect(EF).not.toMatch(/ingestionSource\s*===\s*"provider"\s*&&\s*[a-zA-Z]*[Ff]lag/);
  });

  it("o canal viaja na QUERYSTRING da re-entrada, nunca no corpo", () => {
    // É o que faz a guarda anti-cross-tenant do handler valer alguma coisa: ele
    // resolve o canal por `?channel=` + SELECT. Um dia em que a re-entrada
    // passasse o canal no corpo, a guarda passaria a comparar o payload consigo
    // mesmo.
    expect(EF).toMatch(/\?channel=\$\{row\.channel_id\}/);
  });

  it("o claim é o primeiro ato, e a finalização é cercada pelo claim_id", () => {
    const corpo = EF.slice(EF.indexOf("async function processQueuedEventById"));
    const claim = corpo.indexOf("claim_whatsapp_inbound_event");
    const reentrada = corpo.indexOf("handleWebhookRequest");
    expect(claim).toBeGreaterThan(-1);
    expect(reentrada).toBeGreaterThan(-1);
    // Reivindicar DEPOIS de re-entrar seria não reivindicar: duas execuções da
    // mesma linha são duas IAs respondendo ao mesmo cliente.
    expect(claim).toBeLessThan(reentrada);
    expect(EF).toMatch(/p_claim_id:\s*input\.claimId/);
  });
});

describe("gêmeos declarados: o número vive em dois lugares e nenhum importa o outro", () => {
  // O SQL não importa TypeScript. Sem este pino, `INBOUND_LEASE_TTL_MS` é um
  // export que NENHUM código de runtime consome — trocá-lo não quebraria nada, e
  // quatro lugares (migration, pré-voo 18, controles 19, README) afirmam que ele
  // está amarrado ao lease do banco. Afirmação sem mecanismo é comentário.
  // ESCOPADO AO CORPO DO CLAIM, e não ao arquivo. A Task 6 vai fazer APPEND
  // nesta mesma migration (seleção da varredura e purga), então um pino que só
  // perguntasse "o arquivo contém `secs => 90`?" passaria a poder ficar verde por
  // causa de outra função — inclusive com o lease do claim trocado. O pino tem de
  // olhar para a função cujo número ele prende.
  const CORPO_DO_CLAIM = (() => {
    const inicio = MIGRATION_113.indexOf(
      "create or replace function public.claim_whatsapp_inbound_event",
    );
    expect(inicio).toBeGreaterThan(-1);
    const fim = MIGRATION_113.indexOf("$$;", inicio);
    expect(fim).toBeGreaterThan(inicio);
    return MIGRATION_113.slice(inicio, fim);
  })();

  it("o lease do claim é exatamente INBOUND_LEASE_TTL_MS", () => {
    const segundos = INBOUND_LEASE_TTL_MS / 1000;
    expect(Number.isInteger(segundos)).toBe(true);
    expect(CORPO_DO_CLAIM).toContain(`make_interval(secs => ${segundos})`);
  });

  it("o corpo do claim monta UM intervalo só, para o pino não ter onde se esconder", () => {
    // Dois intervalos no mesmo corpo deixariam o pino verde com o lease errado,
    // bastando que o outro carregasse o número certo.
    const todos = CORPO_DO_CLAIM.match(/make_interval\(secs => \d+\)/g) ?? [];
    expect(todos).toHaveLength(1);
  });

  it("a migration nomeia o gêmeo, para quem lê o SQL primeiro", () => {
    expect(MIGRATION_113).toContain("INBOUND_LEASE_TTL_MS");
  });

  it("o backstop de last_error é MAIOR que o limite do adapter, não igual", () => {
    // Iguais convidariam a "unificar" e apagar a distinção entre o limite real
    // (que também remove o que o Postgres recusa) e a rede de segurança.
    const m = MIGRATION_113.match(/left\(p_error,\s*(\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(INBOUND_ERROR_TEXT_MAX);
  });
});

/**
 * A LINHA ENVENENADA POR DURAÇÃO — as duas metades do conserto.
 *
 * O mecanismo é do SQL (o takeover gasta uma tentativa) e a política é do
 * núcleo (`shouldPromoteToDead`), mas quem amarra os dois é o `index.ts`, que
 * nenhum compilador alcança. Sem este bloco, apagar o `case` da migration ou a
 * pergunta do processador devolve a fase ao estado em que uma classe de linha
 * nunca vira dead letter e retém PII indefinidamente — com a suíte verde.
 */
const CORPO_DO_CLAIM_SQL = corpoSql(
  MIGRATION_113,
  "create or replace function public.claim_whatsapp_inbound_event",
);

/** O takeover gasta tentativa — medido sobre um corpo qualquer, real ou falsificado. */
const takeoverGastaTentativa = (corpo: string) =>
  /attempts\s*=\s*case when e\.status = 'processing'/.test(corpo)
  && /then e\.attempts \+ 1/.test(corpo);

describe("o takeover de lease vencido GASTA uma tentativa", () => {
  it("o claim incrementa attempts, e só na perna do takeover", () => {
    expect(CORPO_DO_CLAIM_SQL, "o corpo do claim não foi encontrado").not.toBe("");
    expect(
      takeoverGastaTentativa(CORPO_DO_CLAIM_SQL),
      "o claim voltou a não gastar tentativa: a linha que o worker começa e não "
        + "termina nunca mais chega a `dead`, e o corpo cru (PII) fica retido para sempre",
    ).toBe(true);
    // A perna do claim NORMAL não pode gastar nada: ali nada foi tentado ainda,
    // e gastar encurtaria a escada de toda entrega nova.
    expect(CORPO_DO_CLAIM_SQL).toMatch(/else e\.attempts/);
  });

  it("CONTROLE POSITIVO: sem o `case`, o caso acima fica vermelho", () => {
    const mutilado = CORPO_DO_CLAIM_SQL.replace(
      /attempts\s*=\s*case when e\.status = 'processing'[\s\S]*?end,/,
      "",
    );
    expect(mutilado, "a cirurgia do controle não achou o incremento").not.toBe(
      CORPO_DO_CLAIM_SQL,
    );
    expect(takeoverGastaTentativa(mutilado)).toBe(false);
  });

  it("o valor devolvido pelo claim é o que o processador consulta", () => {
    // `returning e.attempts` devolve o valor JÁ INCREMENTADO — é dele que sai a
    // decisão de nem processar. Um `returning` que devolvesse o valor antigo
    // atrasaria a promoção em um ciclo inteiro de lease.
    expect(CORPO_DO_CLAIM_SQL).toMatch(/returning[\s\S]*e\.attempts/);
  });
});

describe("a linha sem degrau é finalizada, não processada", () => {
  const PROCESSA = corpoTs(
    EF,
    "async function processQueuedEventById",
    "async function purgeInboundEvents",
  );

  it("a pergunta é do núcleo e vem ANTES da re-entrada no pipeline", () => {
    expect(PROCESSA, "processQueuedEventById não foi encontrada").not.toBe("");
    const pergunta = PROCESSA.indexOf("shouldPromoteToDead(attempts)");
    const reentrada = PROCESSA.indexOf("handleWebhookRequest");
    expect(pergunta, "o processador voltou a não perguntar se ainda há degrau")
      .toBeGreaterThan(-1);
    expect(reentrada).toBeGreaterThan(-1);
    // Perguntar DEPOIS seria não perguntar: o turno de IA já teria sido gasto
    // para chegar ao mesmo `dead`.
    expect(pergunta).toBeLessThan(reentrada);
  });

  it("finaliza pelo MESMO caminho cercado, com a bandeira que o núcleo lê", () => {
    // Montar um veredito aqui criaria um segundo produtor de
    // `QueuedEventVerdict` fora do alcance do vitest — a forma de os dois
    // divergirem.
    expect(PROCESSA).toMatch(/exhaustedBeforeProcessing:\s*true/);
    expect(PROCESSA).not.toMatch(/status:\s*"dead"/);
  });
});

describe("dead letter visível: promover sem atropelar quem está atendendo", () => {
  const PROMOVE = corpoTs(
    EF,
    "async function promoteDeadLetterToHandoff",
    "async function finalizeQueuedEvent",
  );

  /**
   * As duas amarras da promoção, medidas sobre um corpo real ou falsificado.
   *
   * `confereRetorno` olha o `.select` que vem LOGO DEPOIS do predicado, e não
   * um `.select("id")` qualquer: este corpo tem outros dois (o cliente e a
   * conversa), e um predicado solto ficaria verde por causa deles.
   */
  const amarras = (corpo: string) => {
    const marca = corpo.indexOf('.eq("status", "ai_active")');
    const depoisDoPredicado = marca >= 0 ? corpo.slice(marca, marca + 200) : "";
    return {
      soIaAtiva: marca >= 0,
      confereRetorno: /\.select\("id"\)/.test(depoisDoPredicado)
        && /promovidas\.length === 0/.test(corpo),
    };
  };

  it("promove SÓ o que a IA ainda detém", () => {
    expect(PROMOVE, "promoteDeadLetterToHandoff não foi encontrada").not.toBe("");
    const { soIaAtiva } = amarras(PROMOVE);
    expect(
      soIaAtiva,
      "a promoção voltou a escrever sem predicado de estado: atendente em "
        + "`human_active` volta para a fila, `handoff_at` (relógio do auto-resolve "
        + "de 12 h) é zerado e o `handoff_reason` anterior é apagado",
    ).toBe(true);
  });

  it("confere o retorno, porque UPDATE que casa zero linhas não é erro", () => {
    const { confereRetorno } = amarras(PROMOVE);
    expect(
      confereRetorno,
      "sem conferir as linhas afetadas, 'não promovi porque um humano já estava "
        + "lá' fica indistinguível de 'promovi' — e o log afirmaria a segunda coisa",
    ).toBe(true);
    // Zero linhas aqui é o caso comum e DESEJADO, então tem evento próprio e
    // não entra no caminho de erro.
    expect(PROMOVE).toMatch(/evt: "inbound_dead_letter_human_already_active"/);
  });

  it("CONTROLE POSITIVO: sem o predicado de estado, o caso acima fica vermelho", () => {
    const semPredicado = PROMOVE.replace(/\s*\.eq\("status", "ai_active"\)/, "");
    expect(semPredicado, "a cirurgia do controle não achou o predicado").not.toBe(PROMOVE);
    expect(amarras(semPredicado).soIaAtiva).toBe(false);
  });

  it("CONTROLE POSITIVO: sem a conferência do retorno, o caso acima fica vermelho", () => {
    // Cirurgia MÍNIMA: tira só o `.select` do `update`, preservando o predicado
    // e os outros dois `.select("id")` do corpo. É essa precisão que impede o
    // controle de ficar verde derrubando a amarra errada.
    const semConferencia = PROMOVE.replace(
      /(\.eq\("status", "ai_active"\))\s*\.select\("id"\)/,
      "$1",
    );
    expect(semConferencia, "a cirurgia do controle não achou a conferência").not.toBe(PROMOVE);
    expect(amarras(semConferencia).soIaAtiva, "o predicado tinha de sobreviver").toBe(true);
    expect(amarras(semConferencia).confereRetorno).toBe(false);
  });

  it("divide o lote ANTES de resolver o remetente, e promove cada um", () => {
    // O corpo guardado é o do POST INTEIRO, e um payload de forma Meta agrupa
    // mensagens de clientes DIFERENTES. `parseInbound` devolve no máximo uma:
    // resolver o payload inteiro promoveria um cliente e deixaria os outros sem
    // nada — pior que "não deu para resolver", onde ao menos o contador acusa.
    const split = PROMOVE.indexOf("splitMetaWebhookPayload(payload)");
    const parse = PROMOVE.indexOf("parseInbound(provider,");
    expect(split, "a promoção voltou a resolver o payload inteiro").toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(split).toBeLessThan(parse);
    // Remetentes distintos, não mensagens: três mensagens do mesmo cliente são
    // uma conversa só, e promovê-la três vezes reescreveria `handoff_at`.
    expect(PROMOVE).toMatch(/new Set<string>\(\)/);
  });

  it("NUNCA cria conversa — só promove a que existe", () => {
    // Criar uma para marcá-la em handoff inventaria thread vazia no painel.
    expect(PROMOVE).not.toMatch(/\.from\("conversations"\)\s*\n\s*\.insert/);
    expect(PROMOVE).not.toMatch(/get_or_create_whatsapp_conversation/);
  });

  it("o corpo cru do cliente não chega ao log, nem pela mensagem de erro", () => {
    // A mensagem do `JSON.parse` do V8 EMBUTE um trecho da entrada, e a entrada
    // aqui é o corpo cru — telefone e texto. Redigido na FONTE: o parse tem
    // `catch` próprio que loga um token fixo.
    expect(PROMOVE).toMatch(/evt: "dead_letter_payload_unparseable"/);
    expect(PROMOVE, "o texto cru do erro voltou para o log").not.toMatch(/String\(err\)/);
    expect(PROMOVE).toMatch(/err: sanitizeProviderError\(err\)/);
    // E nada de telefone ou texto de cliente no log de resumo: só contagens.
    expect(PROMOVE).not.toMatch(/phone[,:]\s*phone/);
  });
});

describe("as contagens do diagnóstico: exatas, escopadas e com janela", () => {
  it("contagem EXATA, nunca tirada da amostra das últimas 50 execuções", () => {
    // `by_outcome` é calculado sobre `last_executions` (limite 50) — por isso o
    // `sample_size` ao lado. Uma contagem tirada dali sub-reporta em silêncio na
    // unidade movimentada, que é justamente onde o problema aparece.
    const bloco = HEALTH_EF.slice(HEALTH_EF.indexOf("whatsapp_inbound_events"));
    expect(bloco, "as contagens da fila sumiram do diagnóstico").not.toBe("");
    expect(bloco).toMatch(/count: "exact", head: true/);
    expect(
      HEALTH_EF,
      "a contagem da fila passou a sair de `by_outcome`, que é amostra de 50",
    ).not.toMatch(/byOutcome\[["']queue_/);
  });

  it("cada contagem é escopada pela unidade — é o único isolamento que existe", () => {
    // `whatsapp_inbound_events` é FORCE RLS SEM policies e esta EF usa
    // `service_role`: sem o `.eq("unit_id", unitId)`, a contagem seria a de
    // todos os clientes.
    const consultas = HEALTH_EF.split('.from("whatsapp_inbound_events")').slice(1);
    expect(consultas.length, "esperadas as duas contagens da fila").toBe(2);
    for (const consulta of consultas) {
      const cabeca = consulta.slice(0, 400);
      expect(cabeca).toMatch(/\.eq\("unit_id", unitId\)/);
    }
  });

  it("a janela viaja junto com o número, e vem do núcleo", () => {
    // Contagem sem janela é número que o operador interpreta errado uma vez e
    // para de olhar. E as duas janelas são DIFERENTES: `dead` fica 30 dias; o
    // 401 terminal morre em `done` e sai em 7.
    expect(HEALTH_EF).toMatch(/window_days: PURGE_DEAD_AFTER_DAYS/);
    expect(HEALTH_EF).toMatch(/window_days: PURGE_DONE_AFTER_DAYS/);
    expect(
      HEALTH_EF,
      "as janelas voltaram a ser números digitados em vez de importados do núcleo",
    ).not.toMatch(/window_days:\s*\d+/);
  });

  it("`count: null` é 'não consegui contar', nunca zero", () => {
    // Leitura que falha devolveria `count: null` no supabase-js, e um `?? 0`
    // afirmaria "nenhum dead letter" no exato momento em que ninguém sabe.
    expect(HEALTH_EF).toMatch(/deadLetterError \? null :/);
    expect(HEALTH_EF).toMatch(/unauthorizedError \? null :/);
  });
});

describe("sanitizeQueueErrorText — o que impede uma linha de ficar presa para sempre", () => {
  // Postgres recusa `\u0000` em `text` (22021). Como é a finalização quem escreve
  // `attempts` e `next_attempt_at`, uma finalização que falha SEMPRE deixa a linha
  // devida e reivindicável para sempre: retomada a cada 90 s, nunca virando dead
  // letter, e primeira na ordem da varredura — adiando o inbound dos outros
  // tenants.
  it("remove o octeto NUL, que o Postgres recusa em coluna text", () => {
    const saida = sanitizeQueueErrorText("falhou\u0000aqui");
    expect(saida).not.toContain("\u0000");
    expect(saida).toBe("falhou aqui");
  });

  it("remove todo controle C0/C1, não só o NUL", () => {
    const saida = sanitizeQueueErrorText("a\u0001b\u001fc\u007fd\u009fe");
    expect(saida).toBe("a b c d e");
  });

  it("normaliza para ESPAÇO em vez de apagar, para não fundir palavras", () => {
    // Descartar o separador funde o dado com o seguinte — o defeito que este repo
    // já pagou ao descartar `\n` de texto colado.
    expect(sanitizeQueueErrorText("erro\nno canal")).toBe("erro no canal");
    expect(sanitizeQueueErrorText("erro\tno canal")).toBe("erro no canal");
  });

  it("trunca no limite do adapter", () => {
    const saida = sanitizeQueueErrorText("x".repeat(INBOUND_ERROR_TEXT_MAX + 50));
    expect(saida).toHaveLength(INBOUND_ERROR_TEXT_MAX);
  });

  it("null/undefined/vazio viram null, nunca string vazia", () => {
    // String vazia gravaria `last_error = ''`, que se lê como "houve erro sem
    // mensagem" — diferente de "não houve erro".
    expect(sanitizeQueueErrorText(null)).toBeNull();
    expect(sanitizeQueueErrorText(undefined)).toBeNull();
    expect(sanitizeQueueErrorText("   ")).toBeNull();
    expect(sanitizeQueueErrorText("\u0000\u0000")).toBeNull();
  });

  it("texto normal atravessa intacto", () => {
    expect(sanitizeQueueErrorText("http_503")).toBe("http_503");
  });
});

describe("a finalização não pode deixar a linha sem contabilidade de tentativa", () => {
  it("há uma segunda tentativa SEM o texto do erro", () => {
    // Perder o texto do erro é barato; perder `attempts` e `next_attempt_at` põe a
    // linha em laço de 90 s para sempre. Se alguém remover este caminho, isto
    // reprova.
    expect(EF).toMatch(/queued_event_finalize_retry_without_error_text/);
    expect(EF).toMatch(/await call\(null\)/);
  });

  it("o texto que vai para a coluna passa pelo sanitizador, não pelo de log", () => {
    expect(EF).toMatch(/const errorText = sanitizeQueueErrorText\(input\.error\)/);
    // Controle positivo: entregar o texto cru à RPC reprova aqui.
    expect(EF).not.toMatch(/call\(input\.error\)/);
  });

  it("a decisão de retentar olha o texto SANITIZADO, não o cru", () => {
    // Se o sanitizador já devolveu `null`, a primeira chamada foi sem texto e a
    // segunda seria byte-idêntica — retentar o mesmo não é retentar.
    expect(EF).toMatch(/if \(error && errorText !== null\)/);
  });

  it("o log da cerca diz se houve retentativa, porque isso muda o que ele significa", () => {
    // Zero linhas depois de uma retentativa tem leitura OPOSTA à de zero linhas
    // sem ela: provavelmente a primeira chamada gravou e só a resposta se perdeu.
    expect(EF).toMatch(/evt: "queued_event_finalize_fenced"[\s\S]{0,200}retried:/);
  });

  it("a contagem de linhas afetadas é conferida antes de promover dead letter", () => {
    // `UPDATE` que casa zero linhas devolve `error: null` no supabase-js: sem
    // conferir, "a cerca negou" fica indistinguível de "gravei".
    const corpo = EF.slice(EF.indexOf("async function finalizeQueuedEvent"));
    const confere = corpo.indexOf("Number(data ?? 0) < 1");
    const promove = corpo.indexOf("promoteDeadLetterToHandoff");
    expect(confere).toBeGreaterThan(-1);
    expect(promove).toBeGreaterThan(confere);
  });
});

/**
 * O deadline SUAVE, do lado do webhook.
 *
 * O que é EXERCITÁVEL (a pergunta do laço, a marca do erro) mora em
 * `agent-deadline-core.test.ts`. Aqui ficam as três amarras que só existem no
 * `index.ts`: de que relógio o prazo é contado, que o retry silencioso NÃO o
 * engole, e que o motivo do handoff o distingue de um erro de provedor.
 */
const CONDICAO_DO_RETRY = (() => {
  const marco = EF.indexOf('evt: "agent_retry"');
  expect(marco, "o retry silencioso sumiu do webhook").toBeGreaterThan(-1);
  const abre = EF.lastIndexOf("if (", marco);
  expect(abre).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = EF.indexOf("(", abre); i < EF.length; i++) {
    if (EF[i] === "(") depth++;
    else if (EF[i] === ")") {
      depth--;
      if (depth === 0) return EF.slice(abre, i + 1);
    }
  }
  throw new Error("parênteses desbalanceados na condição do retry");
})();

describe("o relógio do prazo é o do PROCESSAMENTO, não o da requisição", () => {
  it("o deadline é perguntado ao núcleo, com processingStartedAt", () => {
    expect(EF).toMatch(
      /agentDeadlineVerdict\(\{\s*startedAt:\s*processingStartedAt/,
    );
    expect(EF).toMatch(/shouldContinue:\s*ingestionSource === "queue"/);
  });

  // O prazo NÃO vale no caminho síncrono, e isso é requisito da fase e não
  // cautela: o síncrono atende os quatro providers legados — com loja real
  // agora, e com o gate assíncrono desligado nas duas pernas —, e aplicá-lo ali
  // mudaria o comportamento deles por efeito colateral. A aritmética confirma
  // que não seria inócuo: `AGENT_SOFT_DEADLINE_MS` (30 s) é MENOR que
  // `WORST_SINGLE_TURN_MS` (31 s), então uma rodada de pior caso consome o
  // orçamento inteiro e a seguinte é sempre recusada.
  it("o prazo é ESCOPADO à fila: o caminho síncrono não recebe predicado", () => {
    expect(
      EF,
      "o prazo voltou a valer no caminho síncrono dos providers legados",
    ).not.toMatch(/shouldContinue:\s*\(\)\s*=>\s*\n?\s*agentDeadlineVerdict/);
    // E a perna do `else` tem de ser AUSÊNCIA — `undefined` é o que faz
    // `mayStartAnotherRound` devolver `true` sem sequer perguntar.
    //
    // Delimitado pela PROPRIEDADE (até a seguinte, `onUsage:`) e ancorado no FIM
    // dela, não por uma janela de N caracteres: a janela aceitaria qualquer
    // `: undefined` que passasse perto — um `budgetMs: undefined` a satisfaria
    // com o prazo reaplicado ao síncrono, que é justamente o que ela deveria
    // reprovar.
    const inicio = EF.indexOf("shouldContinue: ingestionSource");
    const fim = EF.indexOf("onUsage:", inicio);
    expect(inicio, "a propriedade `shouldContinue` mudou de forma").toBeGreaterThan(-1);
    expect(fim, "a propriedade seguinte (`onUsage`) sumiu").toBeGreaterThan(inicio);
    const propriedade = EF.slice(inicio, fim).trimEnd().replace(/,$/, "").trimEnd();
    expect(
      propriedade,
      "a perna do síncrono deixou de ser ausência de predicado",
    ).toMatch(/:\s*undefined$/);
  });

  it("NÃO é `t0`, e o relógio nasce depois da janela de rajada", () => {
    // `t0` é o começo da REQUISIÇÃO: nele cabem resolução de canal, CRM e os 6 s
    // de debounce. Contar o prazo dali gastaria o orçamento antes de o agente
    // existir — e faria o deadline morder rodada que ele não deveria alcançar.
    expect(EF, "o prazo voltou a ser contado de t0").not.toMatch(
      /agentDeadlineVerdict\(\{\s*startedAt:\s*t0\b/,
    );
    const debounce = EF.indexOf("await sleep(DEBOUNCE_WINDOW_MS)");
    const relogio = EF.indexOf("const processingStartedAt = Date.now()");
    expect(debounce, "o debounce sumiu").toBeGreaterThan(-1);
    expect(relogio, "processingStartedAt não é declarado").toBeGreaterThan(-1);
    expect(relogio, "o relógio do prazo subiu para antes do debounce").toBeGreaterThan(debounce);
  });

  it("AI_LOCK_TTL_SECONDS cobre a aritmética declarada, em vez de ser adivinhado", () => {
    // O TTL foi dimensionado contra "~51 s de pior caso do runOnce" — que era o
    // pior caso de UM turno, não do laço. Agora ele responde à soma real:
    // orçamento + pior turno + envio.
    //
    // A soma vale para o caminho da FILA, que é onde o prazo existe. No síncrono
    // o lock continua sendo piso contra lock órfão e nada prova que o turno cabe
    // nele — o que este caso amarra é o valor, não uma garantia de tempo lá.
    const m = EF.match(/AI_LOCK_TTL_SECONDS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(lockTtlSecondsRequired());
  });
});

describe("o retry silencioso NÃO pode engolir o prazo", () => {
  // Sem a exclusão, o `catch` genérico reiniciaria o agente inteiro logo depois
  // de o prazo ter dito para não começar nem mais uma rodada — o deadline
  // anulando a si mesmo no único caso em que ele importa. Hoje isso não dispara
  // por coincidência aritmética (os dois orçamentos valem 30 000, em arquivos
  // diferentes e contados de relógios diferentes), e coincidência não é guarda.
  it("a condição do retry exclui o prazo explicitamente", () => {
    expect(CONDICAO_DO_RETRY, "a exclusão do prazo sumiu do retry").toContain(
      "!agentDeadlineReached",
    );
  });

  it("e continua excluindo o que já excluía — a exclusão é nova, não uma troca", () => {
    expect(CONDICAO_DO_RETRY).toContain("attempt === 0");
    expect(CONDICAO_DO_RETRY).toContain("!mutatingToolUsed");
    expect(CONDICAO_DO_RETRY).toContain("AGENT_RETRY_BUDGET_MS");
  });

  it("controle positivo: sem a exclusão, o caso acima fica vermelho", () => {
    const mutilada = CONDICAO_DO_RETRY.replace(/&&\s*!agentDeadlineReached/, "");
    expect(mutilada, "a cirurgia do controle não achou a exclusão").not.toBe(CONDICAO_DO_RETRY);
    expect(mutilada).not.toContain("!agentDeadlineReached");
  });
});

describe("o motivo do handoff distingue prazo de erro do provedor", () => {
  it("a decisão vem da MARCA do objeto, lida antes de sanitizar", () => {
    const i = EF.indexOf("agentDeadlineReached = isAgentDeadlineError(err)");
    const j = EF.indexOf("agentError = sanitizeProviderError(err)");
    expect(i, "a marca do prazo não é lida no catch do agente").toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i, "a marca é lida depois de sanitizar").toBeLessThan(j);
  });

  it("nunca por comparação com o texto sanitizado", () => {
    // `sanitizeProviderError` devolve `${err.name}: ${err.message}` e ainda passa
    // por redação e `slice(0, 300)`: `=== "agent_deadline"` seria sempre falso, e
    // `includes` amarraria a decisão à forma de um texto que outra regra
    // reescreve.
    expect(EF, "voltou a comparar o texto sanitizado").not.toMatch(
      /agentError\s*===?\s*["'`]agent_deadline/,
    );
    expect(EF, "voltou a casar o prazo por substring").not.toMatch(
      /agentError\s*\.\s*(?:includes|startsWith|indexOf)\(\s*["'`]agent_deadline/,
    );
  });

  it("as duas razões existem, e a gravada é a escolhida", () => {
    expect(EF).toMatch(/agent_deadline:\$\{provider_ai\}/);
    expect(EF).toMatch(/agent_error:\$\{provider_ai\}/);
    expect(EF).toMatch(/handoff_reason:\s*agentHandoffReason/);
  });

  it("CONTROLE POSITIVO: o ramo de erro do agente não grava mais a razão fixa", () => {
    // É a regressão que a emenda nomeia: com `agentError === "agent_deadline"`,
    // o motivo caía SEMPRE em `agent_error` e o prazo ficava invisível
    // exatamente onde se investiga por que a conversa foi para atendimento
    // humano. Se alguém reintroduzir o literal na escrita, isto reprova.
    const ramo = EF.slice(EF.indexOf("    if (agentError) {"));
    const fim = ramo.indexOf('return new Response("ok")');
    expect(fim, "o ramo de erro do agente não foi encontrado").toBeGreaterThan(-1);
    const corpo = ramo.slice(0, fim);
    // A razão gravada é a ESCOLHIDA no próprio ramo, e o identificador é
    // exclusivo dele — `handoffReason` pertence à porta de negação do
    // orçamento, e reusá-lo aqui colapsaria as duas portas para o guardrail que
    // as enumera por texto (`ai-budget-wiring-guard.test.ts`).
    expect(corpo).toContain("const agentHandoffReason = agentDeadlineReached");
    expect(corpo).toContain("handoff_reason: agentHandoffReason");
    expect(corpo, "a razão voltou a ser literal na escrita").not.toMatch(
      /handoff_reason:\s*`agent_error:/,
    );
  });
});

/**
 * O que o CLIENTE lê quando o prazo interrompe o turno.
 *
 * Esta é a única decisão da fase cujo erro chega ao cliente final como
 * afirmação falsa — e o dano tem duas formas, não uma. Depois de uma ferramenta
 * mutante: a rodada 2 executa `create_reservation`, a rodada 3 (a que confirma)
 * é recusada pelo prazo, e o cliente é informado de "instabilidade" enquanto a
 * reserva está `confirmed` no banco — ele não aparece (mesa segurada vazia) ou
 * aparece achando que não tem reserva. SEM ferramenta mutante: nada quebrou e o
 * texto afirma que sim, que é a regra escrita no cabeçalho de `ai-budget-copy.ts`
 * ("não pode afirmar falha técnica: não houve falha nenhuma").
 *
 * Sem este bloco, reverter a correção para o `AGENT_INSTABILITY_TEXT` único
 * mantém a suíte inteira verde — era o estado da branch antes desta rodada.
 */
const RAMO_DE_ERRO_DO_AGENTE = (() => {
  const ramo = EF.slice(EF.indexOf("    if (agentError) {"));
  const fim = ramo.indexOf('return new Response("ok")');
  expect(fim, "o ramo de erro do agente não foi encontrado").toBeGreaterThan(-1);
  return ramo.slice(0, fim);
})();

/** As três pernas, medidas sobre um corpo qualquer — real ou falsificado. */
const pernasDaCopy = (corpo: string) => ({
  instabilidade: /handoffText = AGENT_INSTABILITY_TEXT/.test(corpo),
  aposMutacao: /handoffText = resolveMutationStopText\(lastMutationOutcome\)/.test(corpo),
  paradaLimpa: /handoffText = AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT/.test(corpo),
});

describe("o texto do handoff por prazo não mente para o cliente", () => {
  it("as três pernas existem, e cada uma responde à sua pergunta", () => {
    const pernas = pernasDaCopy(RAMO_DE_ERRO_DO_AGENTE);
    expect(pernas.instabilidade, "sumiu o texto do erro REAL de provedor").toBe(true);
    expect(
      pernas.aposMutacao,
      "o prazo voltou a afirmar falha técnica depois de reserva criada",
    ).toBe(true);
    expect(
      pernas.paradaLimpa,
      "o prazo sem mutação voltou a afirmar falha técnica sobre parada planejada",
    ).toBe(true);
    // E as perguntas na ordem certa: instabilidade é o caso de NÃO ser prazo.
    expect(RAMO_DE_ERRO_DO_AGENTE).toMatch(/if \(!agentDeadlineReached\) \{/);
    expect(RAMO_DE_ERRO_DO_AGENTE).toMatch(/\} else if \(mutatingToolUsed\) \{/);
  });

  it("CONTROLE POSITIVO: a forma anterior — um texto só — ficaria vermelha", () => {
    const falsificado = RAMO_DE_ERRO_DO_AGENTE.replace(
      /let handoffText: string;[\s\S]*?\n {6}\}\n/,
      "      const handoffText = AGENT_INSTABILITY_TEXT;\n",
    );
    expect(
      falsificado,
      "a cirurgia do controle não achou a escolha de texto",
    ).not.toBe(RAMO_DE_ERRO_DO_AGENTE);
    const pernas = pernasDaCopy(falsificado);
    expect(pernas.aposMutacao).toBe(false);
    expect(pernas.paradaLimpa).toBe(false);
  });

  it("o texto ESCOLHIDO é o enviado e o appendado — não um literal ao lado", () => {
    // Enviar um e gravar outro deixaria a thread do operador discordando do que
    // o cliente recebeu, que é o rastro usado para investigar exatamente isto.
    expect(RAMO_DE_ERRO_DO_AGENTE).toContain("sendAutomatic(handoffText)");
    expect(RAMO_DE_ERRO_DO_AGENTE).toContain('"assistant",\n          handoffText,');
  });
});
