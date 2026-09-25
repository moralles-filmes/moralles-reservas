import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOUND_LEASE_TTL_MS,
  INBOUND_ERROR_TEXT_MAX,
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
  it("o lease da migration 113 é exatamente INBOUND_LEASE_TTL_MS", () => {
    const segundos = INBOUND_LEASE_TTL_MS / 1000;
    expect(Number.isInteger(segundos)).toBe(true);
    expect(MIGRATION_113).toContain(`make_interval(secs => ${segundos})`);
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
    expect(EF).toMatch(/call\(sanitizeQueueErrorText\(input\.error\)\)/);
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
