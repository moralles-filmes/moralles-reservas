/**
 * Guardrail ESTÁTICO das escritas CONDICIONAIS de
 * `manage-whatsapp-instances/index.ts`.
 *
 * Um tema, um arquivo: *o predicado que protege uma escrita não pode sumir sem
 * teste vermelho*. É a família de defeito que a frente 6c inteira combate —
 * escrita condicional cujo predicado, se some, some em silêncio.
 *
 * POR QUE TEXTUAL. Os `index.ts` importam `deno.land` / `esm.sh` e chamam
 * `serve()` no carregamento, então o vitest não consegue importá-los (mesma
 * razão registrada em `whatsapp-gate-coupling-guard.test.ts`). Análise estática
 * de texto é o que resta — e é mais do que existia antes.
 *
 * O QUE ISTO NÃO É. Não é "a Edge Function foi exercitada". Os casos CORR-1 e
 * CORR-2 do harness reescrevem o UPDATE à mão em SQL: provam que o CHECK aceita
 * custo e status mudando juntos e que o predicado casa — a metade do banco.
 * Nenhum caso de lá ficaria vermelho se o UPDATE real perdesse o
 * `.eq("status", …)` ou a conferência de zero linhas — e UPDATE do Supabase JS
 * que casa ZERO linhas devolve `error: null`. Este arquivo fecha essa metade, e
 * só ela.
 *
 * ALTERNATIVA DESCARTADA: extrair núcleo puro de `correct_cycle_cost`. O risco é
 * FORMA DE I/O (predicado do PostgREST, conferência do retorno), não decisão —
 * um núcleo puro não sustenta nenhum dos dois e daria a mesma impressão falsa
 * com mais cerimônia.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EF = "supabase/functions/manage-whatsapp-instances/index.ts";
const src = readFileSync(resolve(process.cwd(), EF), "utf8");

/** O corpo de um `if (action === "<nome>")` até o próximo bloco de ação. */
function blocoDaAcao(nome: string): string {
  const inicio = src.indexOf(`action === "${nome}"`);
  expect(inicio, `bloco da ação ${nome} não encontrado`).toBeGreaterThan(-1);
  const resto = src.slice(inicio + 1);
  const proximo = resto.search(/action === "/);
  return proximo === -1 ? resto : resto.slice(0, proximo);
}

describe("correct_cycle_cost — a única porta que muda custo já gravado", () => {
  const bloco = blocoDaAcao("correct_cycle_cost");

  it("o UPDATE carrega o compare-and-set de PENDING_REVIEW", () => {
    // Sem este predicado a correção alcança ciclo CLOSED — que fechou
    // financeiramente concluído e cuja reabertura exigiria política que não
    // existe.
    expect(bloco).toMatch(/\.eq\(\s*["'`]status["'`]\s*,\s*["'`]PENDING_REVIEW["'`]\s*\)/);
  });

  it("confere que alguma linha foi tocada, e não confia em error === null", () => {
    // UPDATE que casa ZERO linhas devolve `error: null`. Sem a conferência,
    // "o predicado negou" é indistinguível de "gravei".
    expect(bloco).toMatch(/\.select\(/);
    expect(bloco).toMatch(/\.length\s*===\s*0/);
  });

  it("recusa com CYCLE_NOT_PENDING_REVIEW quando nada foi tocado", () => {
    expect(bloco).toMatch(/CYCLE_NOT_PENDING_REVIEW/);
  });
});

describe("confirm_cycle_date — o 23505 não é presumido reexecução", () => {
  const bloco = blocoDaAcao("confirm_cycle_date");

  it("desambigua o 23505 consultando o ciclo OPEN, não a cycle_start", () => {
    // Dois índices produzem 23505 e significam coisas opostas. O discriminador
    // EXATO é o ciclo OPEN: "existe linha com esta cycle_start?" é apenas uma
    // aproximação e erra quando coexistem um CLOSED em X e um OPEN em Y —
    // confirmar X acharia a linha de X e gravaria a projeção divergente, que é
    // o dano que este ramo existe para impedir.
    expect(bloco).toMatch(/23505/);
    expect(bloco).toMatch(/\.eq\(\s*["'`]status["'`]\s*,\s*["'`]OPEN["'`]\s*\)/);
    expect(bloco).toMatch(/cycle_start\s*!==\s*cycleStart/);
    // A forma aproximada não pode voltar.
    expect(bloco).not.toMatch(/\.eq\(\s*["'`]cycle_start["'`]\s*,\s*cycleStart\s*\)/);
  });

  it("recusa com OPEN_CYCLE_DATE_MISMATCH a data divergente", () => {
    expect(bloco).toMatch(/OPEN_CYCLE_DATE_MISMATCH/);
  });

  it("não trata o 23505 como sucesso puro e simples", () => {
    // A forma antiga — `if (cycleErr && cycleErr.code !== "23505")` — seguia
    // direto para a projeção com a data nova. Ela não pode voltar.
    expect(bloco).not.toMatch(/cycleErr\.code\s*!==\s*["'`]23505["'`]/);
  });
});

describe("update_instance — a guarda de unidade vale nesta porta também", () => {
  const bloco = blocoDaAcao("update_instance");

  it("chama o MESMO núcleo do registro, não uma segunda regra", () => {
    expect(bloco).toMatch(/checkUnitInstanceConflict\s*\(/);
  });

  it("consulta as instâncias não-ENDED da unidade de destino", () => {
    expect(bloco).toMatch(/\.neq\(\s*["'`]lifecycle_state["'`]\s*,\s*["'`]ENDED["'`]\s*\)/);
  });

  it("exclui a própria instância da consulta de conflito", () => {
    // Sem isto a instância se auto-conflita quando o patch reenvia a unidade em
    // que ela já está.
    expect(bloco).toMatch(/\.neq\(\s*["'`]id["'`]\s*,\s*id\s*\)/);
  });

  it("recusa com UNIT_ALREADY_HAS_INSTANCE e devolve as conflitantes", () => {
    expect(bloco).toMatch(/UNIT_ALREADY_HAS_INSTANCE/);
    expect(bloco).toMatch(/conflicts:/);
  });

  it("falha fechado quando a leitura do conflito falha", () => {
    // Lista vazia por erro de leitura liberaria exatamente o que a guarda barra.
    expect(bloco).toMatch(/ALLOWANCE_UNVERIFIABLE/);
  });

  it("não cobra confirmação para mover instância JÁ ENCERRADA", () => {
    // Instância ENDED não pode produzir "duas vivas na mesma unidade" — a
    // consulta exclui ENDED. Recusá-la diria "a unidade passa a ter duas", que
    // é falso.
    expect(bloco).toMatch(/lifecycle_state\s*!==\s*["'`]ENDED["'`]/);
  });

  it("valida o unit_id como uuid antes de consultar", () => {
    // Sem `parseUuid`, valor malformado cairia na consulta de conflito e viraria
    // 503 — mensagem errada para o que é erro do cliente.
    expect(bloco).toMatch(/parseUuid\s*\(/);
  });
});

describe("a EF importa o núcleo compartilhado, não uma cópia", () => {
  it("importa checkUnitInstanceConflict do registro", () => {
    expect(src).toMatch(/whatsapp-instance-registration-core\.ts/);
  });

  it("o núcleo de allowance NÃO absorveu a pergunta de unidade ocupada", () => {
    // A separação existe porque `whatsapp-connection-allowance-core.ts` é
    // compartilhado com `manage-channels`, que não tem nada a ver com unidade
    // duplicada. Fundir os dois levaria um reasonCode sem sentido para lá.
    const nucleo = readFileSync(
      resolve(process.cwd(), "supabase/functions/_shared/whatsapp-connection-allowance-core.ts"),
      "utf8",
    );
    expect(nucleo).not.toMatch(/UNIT_ALREADY_HAS_INSTANCE/);
  });
});
