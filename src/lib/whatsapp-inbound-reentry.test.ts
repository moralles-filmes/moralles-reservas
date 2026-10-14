import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOUND_LEASE_TTL_MS,
  INBOUND_ERROR_TEXT_MAX,
  INBOUND_MAX_ATTEMPTS,
  INBOUND_RETRY_DELAYS_MS,
  INBOUND_SWEEP_INTERVAL_MS,
  MAX_PENDING_BACKLOG_AGE_MS,
  WORST_CASE_QUEUED_EVENT_MS,
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
//
// A NORMALIZAÇÃO DE FIM DE LINHA É LOAD-BEARING, e foi medida, não suposta: este
// repo não tem `.gitattributes` e a máquina de desenvolvimento tem
// `core.autocrlf=true`, então um checkout NOVO grava CRLF — 701 dos 722 arquivos
// de texto rastreados estão em CRLF, e os 21 em LF são exatamente os que esta
// frente escreveu. Qualquer assertiva que compare a fonte contra um literal com
// `\n` cru (as deste arquivo que medem a forma do if/else) passa aqui e reprova
// no checkout de quem clonar ou no primeiro `git checkout --` que tocar o
// arquivo. Normalizar NA LEITURA cobre toda assertiva do arquivo, presente e
// futura; consertar literal por literal deixa a próxima nascer frágil de novo.
const lerFonte = (caminhoRelativo: string): string =>
  readFileSync(resolve(__dirname, caminhoRelativo), "utf8").replace(/\r\n/g, "\n");

const EF = lerFonte("../../supabase/functions/webhook-whatsapp/index.ts");

const managementAdmissionAnchors = [
  'if (!isValid) {',
  'await createTemplateEventRuntime(supabase).prepare(payload',
  'const receiptAdmission = await admitAutomationReceipts(',
  'await preparedTemplates.commit()',
  'await finish("template_events_persisted"',
  'const flagCheck = await checkFlagEnabled("whatsapp_async_ingestion")',
  'insert = await persistInboundEvent({',
];
function hasOrderedManagementAdmission(source: string): boolean {
  const positions = managementAdmissionAnchors.map(anchor => source.indexOf(anchor));
  return positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]));
}

describe("gestão WABA na fronteira da fila (acoplamento; handler real é gate separado)", () => {
  it("persiste gestão depois da assinatura inteira e antes de enfileirar o corpo original", () => {
    expect(hasOrderedManagementAdmission(EF)).toBe(true);
    const queue = EF.indexOf('insert = await persistInboundEvent({');
    expect(EF.slice(queue, EF.indexOf('const verdict = decideAckVerdict', queue))).toContain('bodyText,');
  });
  it.each(managementAdmissionAnchors)("recusa fronteira sem a etapa %s", anchor => {
    expect(hasOrderedManagementAdmission(EF.replace(anchor, 'removed_admission_step'))).toBe(false);
  });
  it("recusa commit da gestão antes da admissão dos recibos", () => {
    const admission = managementAdmissionAnchors[2];
    const commit = managementAdmissionAnchors[3];
    const inverted = EF.replace(admission, 'swap_admission_marker').replace(commit, admission).replace('swap_admission_marker', commit);
    expect(hasOrderedManagementAdmission(inverted)).toBe(false);
  });
  it("lote misto com uma única parte de chat também reentra com source original", () => {
    const start = EF.indexOf('const parts = splitMetaWebhookPayload(payload);');
    const end = EF.indexOf('const statusUpdates = parseStatusCallback', start);
    const dispatch = EF.slice(start, end);
    expect(dispatch).toContain('parts.length > 1 || managementPersisted');
    expect(dispatch).toContain('signatureAlreadyVerified: true, source: ingestionSource');
    // Control: old one-part dispatch would leave management in the chat payload.
    expect(dispatch.replace(' || managementPersisted', '')).not.toContain('parts.length > 1 || managementPersisted');
  });
  it("gestão exclusiva termina depois da persistência e antes do gate de ingestão", () => {
    const persisted = EF.indexOf('await preparedTemplates.commit()');
    const finish = EF.indexOf('await finish("template_events_persisted"');
    const gate = EF.indexOf('const flagCheck = await checkFlagEnabled("whatsapp_async_ingestion")');
    expect(persisted).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(persisted);
    expect(finish).toBeLessThan(gate);
  });
});

const MIGRATION_113 = lerFonte(
  "../../supabase/migrations/20260924120200_113_inbound_claim_rpc.sql",
);

// A 114 entra aqui só por causa de UM número: a expressão do `cron.schedule` é a
// gêmea de `INBOUND_SWEEP_INTERVAL_MS`, e o limite de idade do backlog é derivado
// dela. Trocar o agendamento sem trocar a constante deixaria o painel chamando de
// parada uma fila que só está entre dois ciclos.
const MIGRATION_114 = lerFonte(
  "../../supabase/migrations/20260924120300_114_cron_inbound_sweep.sql",
);

// O painel é lido pelo mesmo motivo que a EF: `Automacao.tsx` é uma página inteira
// com hooks de rede, e `DiagnosticsTab` não é exportada — o vitest não a monta. As
// duas amarras que só existem lá (de que RELÓGIO a idade é medida, e que a copy vem
// do núcleo em vez de literal no call site) só têm guarda se alguém ler a fonte.
const PANEL = lerFonte("../pages/gestao/Automacao.tsx");

// `whatsapp-health` também chama `serve()` no carregamento e importa
// `deno.land`: o vitest não a alcança, e as duas armadilhas das contagens
// (tirá-las da amostra de 50 execuções; esquecer o escopo de unidade numa tabela
// FORCE RLS sem policies) só têm guarda se alguém ler a fonte.
const HEALTH_EF = lerFonte("../../supabase/functions/whatsapp-health/index.ts");

describe("as leituras de fonte são imunes a fim de linha", () => {
  // Esta é a guarda de si mesma: sem a normalização de `lerFonte`, num checkout
  // CRLF (o que `core.autocrlf=true` produz, e é o estado de 701 dos 722
  // arquivos rastreados) as asserções que comparam a forma do if/else contra
  // literal com `\n` cru ficam vermelhas. Aqui isso é verificado de frente, em
  // vez de depender de alguém reparar no `.replace` vinte linhas acima.
  //
  // Num checkout já em LF este caso passa trivialmente — e é correto que passe:
  // ele existe para o ambiente em que o defeito EXISTE. Removê-lo por "não testa
  // nada aqui" devolve o defeito ao primeiro clone em máquina Windows.
  it.each([
    ["webhook-whatsapp/index.ts", EF],
    ["migration 113", MIGRATION_113],
    ["migration 114", MIGRATION_114],
    ["whatsapp-health/index.ts", HEALTH_EF],
    ["gestao/Automacao.tsx", PANEL],
  ])("%s é lida sem CR", (_nome, fonte) => {
    expect(fonte.length, "fonte vazia: o caminho do arquivo quebrou").toBeGreaterThan(0);
    expect(fonte).not.toContain("\r");
  });
});

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

/**
 * A perna da REENTREGA só protege se chegar ao gate. O núcleo devolve `sync`
 * para `providerRedelivery: undefined`, então um call site que esquecesse o
 * campo desligaria a fila até para a Datafy — e o mesmo núcleo, com a suíte
 * dele verde, não acusaria nada. A amarra mora no `index.ts`, que nenhum
 * compilador alcança.
 */
describe("a reentrega declarada do provider chega ao gate de ingestão", () => {
  /** Tira só linhas INTEIRAS de comentário — mesma régua de `corpoTs`. */
  const semLinhasDeComentario = (fonte: string): string =>
    fonte
      .split("\n")
      .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
      .join("\n");

  /** O objeto de argumentos da chamada do gate, sem linhas de comentário. */
  const argumentosDoGate = (fonte: string): string => {
    const inicio = fonte.indexOf("decideIngestionMode({");
    if (inicio < 0) return "";
    const fim = fonte.indexOf("});", inicio);
    if (fim <= inicio) return "";
    return semLinhasDeComentario(fonte.slice(inicio, fim));
  };

  /**
   * Toda chamada, inclusive `decideIngestionMode(entrada)` sem objeto literal —
   * a forma que escaparia de `argumentosDoGate`. O import não tem parêntese e as
   * menções da documentação vêm entre crases, sem parêntese.
   */
  const chamadasDoGate = (fonte: string): number =>
    (semLinhasDeComentario(fonte).match(/\bdecideIngestionMode\s*\(/g) ?? []).length;

  /** Lida do registry pelo provider do PRÓPRIO canal, não digitada no call site. */
  const passaReentrega = (argumentos: string) =>
    /providerRedelivery:\s*PROVIDER_CAPABILITIES\[provider\]\??\.inboundRedelivery\b/.test(argumentos);

  /** Import na COLUNA ZERO: um import comentado não satisfaz a guarda. */
  const IMPORT_DO_REGISTRY =
    /^import\s*\{[^}]*\bPROVIDER_CAPABILITIES\b[^}]*\}\s*from\s*"\.\.\/_shared\/whatsapp-provider-core\.ts"/m;

  const ARGUMENTOS = argumentosDoGate(EF);

  it("há UM call site do gate, para nenhum escapar a esta guarda", () => {
    expect(chamadasDoGate(EF)).toBe(1);
  });

  it("CONTROLE POSITIVO: uma segunda chamada, mesmo sem objeto literal, reprova a contagem", () => {
    expect(chamadasDoGate(`${EF}\ndecideIngestionMode(x);\n`)).not.toBe(1);
  });

  it("o call site passa providerRedelivery lido do registry", () => {
    expect(ARGUMENTOS, "a chamada de decideIngestionMode não foi encontrada").not.toBe("");
    expect(
      passaReentrega(ARGUMENTOS),
      "o gate voltou a ser chamado sem a reentrega do provider: o núcleo trata a "
        + "ausência como `sync` e a fila morre para todo provider, Datafy inclusive",
    ).toBe(true);
  });

  it("PROVIDER_CAPABILITIES é importado do núcleo", () => {
    // Sem tsc nem `deno check` sobre esta EF no CI: o identificador sem import só
    // apareceria como ReferenceError em produção, no primeiro inbound.
    expect(EF).toMatch(IMPORT_DO_REGISTRY);
  });

  it("CONTROLE POSITIVO: import comentado não satisfaz a guarda", () => {
    const comentado = EF.replace(/^import \{ PROVIDER_CAPABILITIES \}/m, "// import { PROVIDER_CAPABILITIES }");
    expect(comentado, "a cirurgia do controle não achou o import").not.toBe(EF);
    expect(comentado).not.toMatch(IMPORT_DO_REGISTRY);
  });

  it("CONTROLE POSITIVO: linha da reentrega comentada na EF reprova o pipeline inteiro", () => {
    // Cirurgia sobre a FONTE, não sobre o recorte: exercita `argumentosDoGate`
    // (que tira comentários) e `passaReentrega` juntos, como o caso real.
    const comentada = EF.replace(/^(\s*)(providerRedelivery:)/m, "$1// $2");
    expect(comentada, "a cirurgia do controle não achou a perna").not.toBe(EF);
    const argumentos = argumentosDoGate(comentada);
    expect(argumentos, "a chamada tinha de continuar sendo encontrada").not.toBe("");
    expect(passaReentrega(argumentos)).toBe(false);
  });

  it("CONTROLE POSITIVO: recorte sem providerRedelivery fica vermelho", () => {
    const semReentrega = ARGUMENTOS.replace(/\n\s*providerRedelivery:[^\n]*/, "");
    expect(semReentrega, "a cirurgia do controle não achou a perna").not.toBe(ARGUMENTOS);
    expect(passaReentrega(semReentrega)).toBe(false);
  });

  it("CONTROLE POSITIVO: reentrega digitada no call site também fica vermelha", () => {
    const digitada = ARGUMENTOS.replace(
      /providerRedelivery:[^\n]*/,
      'providerRedelivery: "documented",',
    );
    expect(digitada, "a cirurgia do controle não achou a perna").not.toBe(ARGUMENTOS);
    expect(passaReentrega(digitada)).toBe(false);
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

  it("o intervalo do cron é exatamente INBOUND_SWEEP_INTERVAL_MS", () => {
    // O SEGUNDO gêmeo desta fase, e ele é load-bearing por um caminho indireto:
    // `MAX_PENDING_BACKLOG_AGE_MS` soma um intervalo de cron por claim, então
    // trocar o agendamento para de cinco em cinco minutos sem trocar a constante
    // faria o painel chamar de PARADA uma fila que está só entre dois ciclos — o
    // alarme falso que ensina o operador a ignorar o número.
    //
    // Montado por interpolação, e não escrito como literal, porque a expressão
    // cron contém a sequência que fecharia um comentário de bloco — é a mesma
    // razão pela qual ela não aparece escrita no núcleo.
    //
    // ESCOPADO À CHAMADA DE `cron.schedule`, não ao arquivo. Medido, não suposto: o
    // bloco "Validação pós-migration" no fim da 114 REPETE a expressão dentro de um
    // comentário, e uma asserção sobre o arquivo inteiro ficava VERDE com o
    // agendamento trocado para cinco minutos. O controle positivo passou verde e
    // foi assim que se soube.
    const AGENDAMENTO = (() => {
      const inicio = MIGRATION_114.indexOf("select cron.schedule(");
      expect(inicio, "a chamada de cron.schedule não foi encontrada").toBeGreaterThan(-1);
      const fim = MIGRATION_114.indexOf(");", inicio);
      expect(fim).toBeGreaterThan(inicio);
      return MIGRATION_114.slice(inicio, fim);
    })();
    const minutos = INBOUND_SWEEP_INTERVAL_MS / 60_000;
    expect(Number.isInteger(minutos)).toBe(true);
    expect(
      AGENDAMENTO,
      "o agendamento da varredura divergiu de INBOUND_SWEEP_INTERVAL_MS: o limite de "
        + "idade do backlog soma um intervalo de cron por claim, então o painel passa "
        + "a chamar de PARADA uma fila que está só entre dois ciclos",
    ).toContain(`'*${"/"}${minutos} * * * *'`);
  });

  it("o intervalo é usado pelo limite de idade, não é constante decorativa", () => {
    // Sem este caso, `INBOUND_SWEEP_INTERVAL_MS` poderia ser um export que
    // ninguém consome — e o pino acima ficaria prendendo um número sem efeito.
    // Mede a DERIVAÇÃO: trocar o intervalo tem de mover o limite.
    const semCron =
      INBOUND_RETRY_DELAYS_MS.reduce((soma, ms) => soma + ms, 0)
      + (INBOUND_MAX_ATTEMPTS + 1) * WORST_CASE_QUEUED_EVENT_MS;
    expect(MAX_PENDING_BACKLOG_AGE_MS - semCron).toBe(
      (INBOUND_MAX_ATTEMPTS + 1) * INBOUND_SWEEP_INTERVAL_MS,
    );
  });

  it("o backstop de last_error é MAIOR que o limite do adapter, não igual", () => {
    // Iguais convidariam a "unificar" e apagar a distinção entre o limite real
    // (que também remove o que o Postgres recusa) e a rede de segurança.
    const m = MIGRATION_113.match(/left\(p_error,\s*(\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(INBOUND_ERROR_TEXT_MAX);
  });
});

describe("`last_error` preserva evidência: erro nulo não apaga o que se sabia", () => {
  const CORPO_DA_FINALIZACAO = corpoSql(
    MIGRATION_113,
    "create or replace function public.finalize_whatsapp_inbound_event",
  );

  /** A finalização preserva o erro anterior quando não tem um novo a relatar. */
  const preserva = (corpo: string) =>
    /last_error\s*=\s*coalesce\(left\(p_error,\s*\d+\),\s*e\.last_error\)/.test(corpo);

  it("a finalização usa coalesce, não sobrescrita cega", () => {
    expect(CORPO_DA_FINALIZACAO, "finalize_whatsapp_inbound_event não foi encontrada")
      .not.toBe("");
    expect(
      preserva(CORPO_DA_FINALIZACAO),
      "`last_error = left(p_error, N)` cru: DOIS caminhos passam `p_error` nulo "
        + "(a promoção a `dead` sem veredito, e a retentativa da finalização sem o "
        + "texto do erro) e os dois APAGAM a evidência. No caminho misto — uma "
        + "tentativa respondeu http_500 e as seguintes morreram por wall clock — a "
        + "linha que dura 30 dias justamente para não depender de log fica muda",
    ).toBe(true);
  });

  it("os dois chamadores que passam erro NULO continuam existindo", () => {
    // A guarda acima só tem valor enquanto houver quem passe nulo. Se os dois
    // caminhos desaparecerem, o `coalesce` vira decoração e alguém o remove com
    // razão — então o teste tem de reprovar aqui, não ficar verde por vacuidade.
    expect(EF, "a promoção a dead sem veredito deixou de passar erro nulo")
      .toMatch(/error: null,\s*\n\s*exhaustedBeforeProcessing: true,/);
    expect(EF, "a retentativa da finalização sem texto do erro desapareceu")
      .toContain("await call(null)");
  });

  it("CONTROLE POSITIVO: sobrescrita cega fica vermelha", () => {
    const cega = CORPO_DA_FINALIZACAO.replace(
      /last_error\s*=\s*coalesce\(left\(p_error,\s*(\d+)\),\s*e\.last_error\)/,
      "last_error      = left(p_error, $1)",
    );
    expect(cega, "a cirurgia do controle não achou o coalesce")
      .not.toBe(CORPO_DA_FINALIZACAO);
    expect(preserva(cega)).toBe(false);
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

  /** O predicado de estado da promoção, como ele aparece na fonte. */
  const PREDICADO = '.in("status", ["ai_active", "resolved"])';

  /**
   * As três amarras da promoção, medidas sobre um corpo real ou falsificado.
   *
   * `confereRetorno` olha o `.select` que vem LOGO DEPOIS do predicado, e não
   * um `.select("id")` qualquer: este corpo tem outros dois (o cliente e a
   * conversa), e um predicado solto ficaria verde por causa deles.
   *
   * `incluiResolved` é amarra SEPARADA de `temPredicado` de propósito: o defeito
   * que ela guarda não é "escrever sem predicado", é "escrever com o predicado
   * estreito demais". Medi-los juntos deixaria o segundo passar às custas do
   * primeiro.
   *
   * Por isso `temPredicado` aceita as DUAS formas (`.eq` e `.in`): estreitar para
   * `.eq("status", "ai_active")` continua sendo um predicado de estado, e só
   * `incluiResolved` deve cair. Se `temPredicado` só reconhecesse `.in`, a
   * cirurgia do estreitamento derrubaria as três amarras de uma vez e o controle
   * positivo ficaria verde por ter quebrado a coisa errada — o modo clássico de
   * um controle não provar nada. Medido: este corpo não tem nenhum outro
   * `.eq("status"`/`.in("status"`, então a busca não casa por acidente.
   */
  const amarras = (corpo: string) => {
    const marca = corpo.match(/\.(?:eq|in)\("status",/)?.index ?? -1;
    const depoisDoPredicado = marca >= 0 ? corpo.slice(marca, marca + 200) : "";
    return {
      temPredicado: marca >= 0,
      incluiResolved: corpo.includes(PREDICADO),
      confereRetorno: /\.select\("id"\)/.test(depoisDoPredicado)
        && /promovidas\.length === 0/.test(corpo),
    };
  };

  it("promove SÓ o que nenhuma pessoa detém", () => {
    expect(PROMOVE, "promoteDeadLetterToHandoff não foi encontrada").not.toBe("");
    const { temPredicado } = amarras(PROMOVE);
    expect(
      temPredicado,
      "a promoção voltou a escrever sem predicado de estado: atendente em "
        + "`human_active` volta para a fila, `handoff_at` (relógio do auto-resolve "
        + "de 12 h) é zerado e o `handoff_reason` anterior é apagado",
    ).toBe(true);
  });

  it("`resolved` ENTRA na promoção — senão a dead letter fica invisível ao lojista", () => {
    // `resolved` é estado FÓSSIL, não "humano atendendo": o botão Resolver não o
    // grava mais e o próprio pipeline o promove a `ai_active` na inbound seguinte
    // — promoção que a dead letter, por definição, nunca alcança. Omiti-lo fazia
    // o UPDATE casar ZERO linhas, a conversa continuar com badge "Resolvida", e
    // `useAwaitingHumanCount` (que conta só `awaiting_human`) não mostrar nada:
    // sobrava a contagem do diagnóstico, que é platform-admin-only. Reprovava o
    // critério de aceite §14.8 para conversa que É resolvível.
    expect(
      amarras(PROMOVE).incluiResolved,
      "o predicado deixou de aceitar `resolved`: dead letter em conversa fóssil "
        + "volta a ser invisível para o lojista",
    ).toBe(true);
  });

  it("confere o retorno, porque UPDATE que casa zero linhas não é erro", () => {
    const { confereRetorno } = amarras(PROMOVE);
    expect(
      confereRetorno,
      "sem conferir as linhas afetadas, 'não promovi porque a conversa já era de "
        + "uma pessoa' fica indistinguível de 'promovi' — e o log afirmaria a segunda",
    ).toBe(true);
    // Zero linhas aqui é o caso comum e DESEJADO, então tem evento próprio e
    // não entra no caminho de erro. O NOME é derivado do predicado: com
    // `ai_active` e `resolved` promovidos, o complemento é `human_active` ou
    // `awaiting_human` — "já está com uma pessoa", que é o que o nome afirma.
    // `human_already_active` cobriria só o primeiro e mentiria sobre o segundo.
    expect(PROMOVE).toMatch(/evt: "inbound_dead_letter_already_with_human"/);
    expect(
      PROMOVE,
      "o nome antigo afirmava atendimento ativo sobre conversa que ninguém atende",
    ).not.toMatch(/inbound_dead_letter_human_already_active/);
  });

  it("CONTROLE POSITIVO: sem o predicado de estado, o caso acima fica vermelho", () => {
    const semPredicado = PROMOVE.replace(
      /\s*\.in\("status", \["ai_active", "resolved"\]\)/,
      "",
    );
    expect(semPredicado, "a cirurgia do controle não achou o predicado").not.toBe(PROMOVE);
    expect(amarras(semPredicado).temPredicado).toBe(false);
  });

  it("CONTROLE POSITIVO: estreitar o predicado para só `ai_active` fica vermelho", () => {
    // A forma exata do defeito que o G1 corrigiu — e a que alguém reintroduz ao
    // "simplificar" o `.in` de um item só de volta para `.eq`.
    const soIaAtiva = PROMOVE.replace(PREDICADO, '.eq("status", "ai_active")');
    expect(soIaAtiva, "a cirurgia do controle não achou o predicado").not.toBe(PROMOVE);
    expect(amarras(soIaAtiva).incluiResolved).toBe(false);
    // E o controle é PRECISO: derruba SÓ esta amarra. As vizinhas sobrevivem
    // porque o estreitamento não remove o predicado nem a conferência — é isso
    // que faz o vermelho apontar para o defeito certo.
    expect(amarras(soIaAtiva).temPredicado, "não era este o alvo").toBe(true);
    expect(amarras(soIaAtiva).confereRetorno, "não era este o alvo").toBe(true);
  });

  it("CONTROLE POSITIVO: sem a conferência do retorno, o caso acima fica vermelho", () => {
    // Cirurgia MÍNIMA: tira só o `.select` do `update`, preservando o predicado
    // e os outros dois `.select("id")` do corpo. É essa precisão que impede o
    // controle de ficar verde derrubando a amarra errada.
    const semConferencia = PROMOVE.replace(
      /(\.in\("status", \["ai_active", "resolved"\]\))\s*\.select\("id"\)/,
      "$1",
    );
    expect(semConferencia, "a cirurgia do controle não achou a conferência").not.toBe(PROMOVE);
    expect(amarras(semConferencia).temPredicado, "o predicado tinha de sobreviver").toBe(true);
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
    // TRÊS: as duas contagens de estado terminal mais o backlog não-terminal. O
    // número é asserido de propósito — consulta nova nesta tabela que escape ao
    // laço abaixo escaparia também à única barreira de tenant que existe aqui.
    expect(consultas.length, "esperadas as três consultas da fila").toBe(3);
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
    // A do backlog é medida no bloco dele, sobre o recorte do payload. Aqui, um
    // `/pendingError\s*\?\s*null/` solto ficava VERDE com o `?? 0` reintroduzido
    // na contagem: a linha de `oldest_received_at` satisfazia o padrão sozinha.
    // Medido, não suposto — o controle positivo passou verde e foi assim que se
    // soube.
  });
});

/**
 * O BACKLOG — o número que responde "o pipeline está andando?".
 *
 * As duas contagens acima são de estados TERMINAIS, e a de `dead` responde com a
 * verdade mais enganosa disponível: quem promove uma linha a `dead` é a VARREDURA,
 * incrementando `attempts` (takeover do claim e finalização, migration 113 — não há
 * terceiro escritor). Varredura parada nunca alcança `dead`, então `dead_letter: 0`
 * é verdade e é inútil, com a fila enchendo e cada cliente daquele canal sem
 * resposta.
 *
 * Sem este bloco, apagar a consulta do backlog — ou, pior, fazê-la de um jeito que
 * SEMPRE devolve idade desconhecida — devolve a fase ao estado em que o painel não
 * consegue responder a pergunta, com a suíte verde.
 */
describe("o backlog: idade crua do banco, sem relógio do Deno no predicado", () => {
  /** Só a consulta do backlog, sem comentário nenhum ao redor. */
  const CONSULTA_DO_BACKLOG = (() => {
    const inicio = HEALTH_EF.indexOf("const { data: pendingRows");
    expect(inicio, "a consulta do backlog não foi encontrada").toBeGreaterThan(-1);
    const fim = HEALTH_EF.indexOf(".limit(1);", inicio);
    expect(fim, "a consulta do backlog mudou de forma").toBeGreaterThan(inicio);
    return HEALTH_EF.slice(inicio, fim + ".limit(1);".length);
  })();

  /** O bloco do payload, recortado da chave `pending:` até fechar. */
  const PAYLOAD_DO_BACKLOG = (() => {
    const inicio = HEALTH_EF.indexOf("      pending: {");
    expect(inicio, "o bloco `pending` do payload não foi encontrado").toBeGreaterThan(-1);
    const fim = HEALTH_EF.indexOf("\n      },", inicio);
    expect(fim).toBeGreaterThan(inicio);
    return HEALTH_EF.slice(inicio, fim);
  })();

  /** As amarras, medidas sobre um corpo qualquer — real ou falsificado. */
  const amarras = (consulta: string, payload: string) => ({
    // `count: "exact"` SEM `head: true`. Com `head`, o PostgREST não devolve corpo:
    // `pendingRows` viria vazio, `oldest_received_at` seria SEMPRE null, o veredito
    // cairia sempre em "idade desconhecida" e o sinal morreria em silêncio — com a
    // contagem ainda certa, que é o que faria ninguém notar.
    trazALinha: /count: "exact" \}/.test(consulta) && !/head: true/.test(consulta),
    // Estado, e só estado: nenhum instante do Deno atravessa para o predicado.
    filtraPorEstado: /\.in\("status", \["received", "processing"\]\)/.test(consulta),
    semRelogioDoDeno: !/Date\.now\(\)|new Date\(/.test(consulta),
    // A mais antiga, não uma qualquer.
    pegaAMaisAntiga: /\.order\("received_at", \{ ascending: true \}\)/.test(consulta),
    // Sem janela: linha não-terminal não é purgada, então qualquer `window_days`
    // anexado a este número seria afirmação falsa.
    semJanela: !/window_days/.test(payload),
    entregaAIdadeCrua: /oldest_received_at:/.test(payload),
    // `count: null` é "não consegui contar", nunca zero — e a âncora é a CHAVE
    // `count:`, não `pendingError` solto. Medido: um padrão sem a chave ficava
    // verde com o `?? 0` reintroduzido, porque a linha de `oldest_received_at`
    // logo abaixo também menciona `pendingError ? null`.
    contagemNulaPreservada: /count: pendingError \? null :/.test(payload),
    // E a data acompanha: devolvê-la com `?? null` cru sobre leitura falha daria
    // "fila vazia" por outra porta. As duas são a MESMA leitura.
    dataNulaPreservada: /oldest_received_at: pendingError/.test(payload),
  });

  const REAIS = amarras(CONSULTA_DO_BACKLOG, PAYLOAD_DO_BACKLOG);

  it("traz a linha mais antiga junto da contagem, no MESMO instantâneo", () => {
    // Uma consulta só: contagem e mais-antiga não podem se contradizer (contar 5 e
    // não achar data, ou contar 0 com data na mão).
    expect(
      REAIS.trazALinha,
      "`head: true` na consulta do backlog: a contagem continua certa e a idade "
        + "fica SEMPRE desconhecida — o sinal morre sem nada ficar vermelho",
    ).toBe(true);
    expect(REAIS.pegaAMaisAntiga).toBe(true);
  });

  it("o predicado é de ESTADO — nenhum instante do Deno entra nele", () => {
    // O relógio desta fase é UM, o do banco (cabeçalho da 113). Um
    // `.lt("claimed_until", new Date(...).toISOString())` compararia um valor
    // escrito por `now()` do Postgres contra o relógio do Deno, com margem de 90 s
    // — e a resposta decide QUEM É O DONO de uma linha.
    expect(REAIS.filtraPorEstado).toBe(true);
    expect(
      REAIS.semRelogioDoDeno,
      "voltou a montar instante no Deno para filtrar a fila: idade é para EXIBIR, "
        + "calculada a partir do `received_at` cru, nunca predicado aqui",
    ).toBe(true);
  });

  it("o número do backlog NÃO carrega janela, porque não existe janela", () => {
    expect(
      REAIS.semJanela,
      "`window_days` no backlog: linha não-terminal não é purgada "
        + "(`purge_whatsapp_inbound_events` só alcança `done` e `dead`), então o "
        + "número é o estado AGORA e qualquer janela anexada a ele mente",
    ).toBe(true);
    expect(REAIS.entregaAIdadeCrua).toBe(true);
  });

  it("`count: null` é 'não consegui contar', nunca zero — nas DUAS saídas", () => {
    expect(
      REAIS.contagemNulaPreservada,
      "o backlog voltou a afirmar zero quando a leitura falhou: `dead_letter: 0` já "
        + "é a resposta enganosa desta tela, e um segundo zero falso ao lado dela "
        + "fecharia a última porta que sobrou",
    ).toBe(true);
    expect(REAIS.dataNulaPreservada).toBe(true);
  });

  it("CONTROLE POSITIVO: `?? 0` na contagem do backlog fica vermelho", () => {
    // É a forma exata do defeito, e é o controle que já pegou uma asserção vácua
    // deste mesmo arquivo: um padrão ancorado em `pendingError` sem a chave
    // `count:` ficava verde porque a linha de `oldest_received_at` o satisfazia.
    const cego = PAYLOAD_DO_BACKLOG.replace(
      "count: pendingError ? null : (pendingCount ?? 0),",
      "count: pendingCount ?? 0,",
    );
    expect(cego, "a cirurgia do controle não achou a contagem").not.toBe(PAYLOAD_DO_BACKLOG);
    expect(amarras(CONSULTA_DO_BACKLOG, cego).contagemNulaPreservada).toBe(false);
    // Precisão: derruba SÓ esta amarra.
    expect(amarras(CONSULTA_DO_BACKLOG, cego).dataNulaPreservada, "não era o alvo").toBe(true);
    expect(amarras(CONSULTA_DO_BACKLOG, cego).semJanela, "não era o alvo").toBe(true);
  });

  it("CONTROLE POSITIVO: `head: true` fica vermelho", () => {
    const comHead = CONSULTA_DO_BACKLOG.replace('count: "exact" }', 'count: "exact", head: true }');
    expect(comHead, "a cirurgia do controle não achou o count").not.toBe(CONSULTA_DO_BACKLOG);
    expect(amarras(comHead, PAYLOAD_DO_BACKLOG).trazALinha).toBe(false);
    // E derruba SÓ esta amarra — é isso que faz o vermelho apontar para o defeito
    // certo em vez de quebrar a coisa errada.
    expect(amarras(comHead, PAYLOAD_DO_BACKLOG).filtraPorEstado, "não era o alvo").toBe(true);
    expect(amarras(comHead, PAYLOAD_DO_BACKLOG).semJanela, "não era o alvo").toBe(true);
  });

  it("CONTROLE POSITIVO: filtrar por instante do Deno fica vermelho", () => {
    const comRelogio = CONSULTA_DO_BACKLOG.replace(
      ".limit(1);",
      '.lt("claimed_until", new Date(Date.now() - 90_000).toISOString())\n      .limit(1);',
    );
    expect(comRelogio, "a cirurgia do controle não achou o limit").not.toBe(CONSULTA_DO_BACKLOG);
    expect(amarras(comRelogio, PAYLOAD_DO_BACKLOG).semRelogioDoDeno).toBe(false);
    expect(amarras(comRelogio, PAYLOAD_DO_BACKLOG).filtraPorEstado, "não era o alvo").toBe(true);
  });

  it("CONTROLE POSITIVO: anexar `window_days` ao backlog fica vermelho", () => {
    const comJanela = PAYLOAD_DO_BACKLOG.replace(
      "        count:",
      "        window_days: PURGE_DONE_AFTER_DAYS,\n        count:",
    );
    expect(comJanela, "a cirurgia do controle não achou o count do payload")
      .not.toBe(PAYLOAD_DO_BACKLOG);
    expect(amarras(CONSULTA_DO_BACKLOG, comJanela).semJanela).toBe(false);
    expect(
      amarras(CONSULTA_DO_BACKLOG, comJanela).entregaAIdadeCrua,
      "não era o alvo",
    ).toBe(true);
  });
});

describe("o painel mede a idade contra o relógio do SERVIDOR, e a copy vem do núcleo", () => {
  it("a idade é medida contra `generated_at`, nunca contra o relógio do navegador", () => {
    // `received_at` vem do relógio do BANCO. Medir contra o do NAVEGADOR deixaria
    // um viewer com hora errada inventando horas de backlog — ou escondendo as que
    // existem. `generated_at` põe a comparação servidor-contra-servidor, e a
    // defasagem que resta desloca uma idade de horas em milissegundos.
    expect(
      PANEL,
      "o painel voltou a medir a idade do backlog pelo relógio do navegador",
    ).toContain("describeInboundBacklog(inbound_queue.pending, generated_at)");
  });

  it("a copy NÃO é literal no call site — ela mora no núcleo testado", () => {
    // Invariante deste repo: copy que afirma consequência diz QUAL, e mora em
    // função pura em `src/`. Literal aqui poria a frase fora do alcance do teste
    // que confere se ela nomeia as DUAS causas.
    expect(PANEL, "a frase de parada foi inlinada no painel").not.toContain(
      "não está drenando",
    );
    expect(PANEL, "o ponteiro de investigação foi inlinado no painel").not.toContain(
      "net._http_response",
    );
    expect(PANEL).toMatch(/\{backlog\.detail\}/);
  });

  it("`pending` ausente ESCONDE o tile, nunca renderiza zero", () => {
    // A EF é deployada à mão e as duas contagens de estado terminal foram ao ar
    // antes deste campo: uma resposta pode ter o bloco e não ter `pending`.
    // Renderizar 0 ali afirmaria fila vazia sobre uma EF que nem sabe responder.
    expect(PANEL).toContain("{inbound_queue.pending && (");
  });

  it("o backlog é renderizado ANTES das duas contagens acumuladas", () => {
    // Hierarquia é parte da correção: é o único número aqui que responde "o
    // pipeline está andando?", e `dead_letter: 0` é a resposta enganosa que o
    // operador leria primeiro se a ordem se invertesse.
    const backlog = PANEL.indexOf("{inbound_queue.pending && (");
    const dead = PANEL.indexOf("Dead letter (últimos");
    expect(backlog).toBeGreaterThan(-1);
    expect(dead).toBeGreaterThan(-1);
    expect(backlog).toBeLessThan(dead);
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
  // agora, e fora da fila pela capability de reentrega (`unmeasured`), não só
  // por chave desligada —, e aplicá-lo ali mudaria o comportamento deles por
  // efeito colateral. A aritmética confirma
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
