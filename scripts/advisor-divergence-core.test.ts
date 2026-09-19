/**
 * Testes do núcleo puro scripts/advisor-divergence-core.ts.
 *
 * Este arquivo prova a regra 6 do audit-function-acl.ts (divergência entre o
 * que a allowlist declara para os lints 0028/0029 e o que o banco realmente
 * produz) SEM banco — é a parte da Task 6 que fica verificável em CI, porque
 * o Step 6 do brief (rodar o guardrail contra produção com a service role
 * key) é checkpoint do usuário, não deste dispatch (ver progress.md Ruling 8
 * e Ruling 22).
 */
import { describe, expect, it } from "vitest";
import {
  computeAdvisorDivergence,
  countsMatchExpected,
  diffLintInventory,
  type LintInventory,
} from "./advisor-divergence-core";

describe("diffLintInventory", () => {
  it("sem diferença: entered e left vazios", () => {
    const d = diffLintInventory(["a(uuid)", "b(text)"], ["a(uuid)", "b(text)"]);
    expect(d).toEqual({ entered: [], left: [] });
  });

  it("assinatura nova no banco (não declarada na allowlist) aparece em entered", () => {
    const d = diffLintInventory(["a(uuid)"], ["a(uuid)", "nova(text)"]);
    expect(d.entered).toEqual(["nova(text)"]);
    expect(d.left).toEqual([]);
  });

  it("assinatura que a allowlist ainda declara mas o banco não produz mais aparece em left", () => {
    const d = diffLintInventory(["a(uuid)", "sumida(uuid)"], ["a(uuid)"]);
    expect(d.entered).toEqual([]);
    expect(d.left).toEqual(["sumida(uuid)"]);
  });

  it("saída é ordenada — não depende da ordem de entrada", () => {
    const d = diffLintInventory([], ["z(text)", "a(text)", "m(text)"]);
    expect(d.entered).toEqual(["a(text)", "m(text)", "z(text)"]);
  });

  it(
    "CONTROLE POSITIVO: troca de uma assinatura por outra com a MESMA contagem " +
      "não é invisível — entra em entered E em left ao mesmo tempo",
    () => {
      // Este é o caso que uma checagem só de contagem (`observed.length ===
      // expected.length`) deixaria passar batido: o total não mudou, mas a
      // superfície exposta é outra função. Reintroduzido deliberadamente aqui
      // para provar que diffLintInventory NÃO tem esse ponto cego.
      const expected = ["antiga(uuid)"];
      const observedComSubstituicao = ["substituta(uuid)"];
      const d = diffLintInventory(expected, observedComSubstituicao);
      expect(d.entered).toEqual(["substituta(uuid)"]);
      expect(d.left).toEqual(["antiga(uuid)"]);
    },
  );
});

describe("computeAdvisorDivergence", () => {
  it("clean=true quando os dois lints batem exatamente", () => {
    const expected: LintInventory = { "0028": ["a(uuid)"], "0029": ["a(uuid)", "b(uuid)"] };
    const observed: LintInventory = { "0028": ["a(uuid)"], "0029": ["a(uuid)", "b(uuid)"] };
    const result = computeAdvisorDivergence(expected, observed);
    expect(result.clean).toBe(true);
    expect(result["0028"]).toEqual({ entered: [], left: [] });
    expect(result["0029"]).toEqual({ entered: [], left: [] });
  });

  it("clean=false quando só o 0028 diverge — 0029 continua limpo e reportado como tal", () => {
    const expected: LintInventory = { "0028": ["a(uuid)"], "0029": ["x(uuid)"] };
    const observed: LintInventory = { "0028": ["a(uuid)", "b(uuid)"], "0029": ["x(uuid)"] };
    const result = computeAdvisorDivergence(expected, observed);
    expect(result.clean).toBe(false);
    expect(result["0028"].entered).toEqual(["b(uuid)"]);
    expect(result["0029"]).toEqual({ entered: [], left: [] });
  });

  it(
    "CONTROLE POSITIVO: reintroduzir uma assinatura que a allowlist NÃO " +
      "declara mais faz clean cair para false, nomeando-a em entered",
    () => {
      // Simula o cenário real que a Task 6 fecha: is_unit_member(uuid,uuid)
      // era exposta antes da 106 e não devia mais aparecer depois. Se o banco
      // (observado) ainda a produzisse — migration não aplicada, ou
      // regressão futura — isto tem que reprovar nomeando a função, não só
      // dizer "23 virou 24".
      const expected: LintInventory = { "0028": [], "0029": ["is_platform_admin(uuid)"] };
      const observedComRegressao: LintInventory = {
        "0028": ["is_unit_member(uuid, uuid)"],
        "0029": ["is_platform_admin(uuid)", "is_unit_member(uuid, uuid)"],
      };
      const result = computeAdvisorDivergence(expected, observedComRegressao);
      expect(result.clean).toBe(false);
      expect(result["0028"].entered).toEqual(["is_unit_member(uuid, uuid)"]);
      expect(result["0029"].entered).toEqual(["is_unit_member(uuid, uuid)"]);
    },
  );
});

describe("countsMatchExpected", () => {
  it("bate quando as três contagens conferem", () => {
    const observed: LintInventory = { "0028": ["a", "b"], "0029": ["a", "b", "c"] };
    expect(countsMatchExpected(observed, { "0028": 2, "0029": 3, total: 5 })).toBe(true);
  });

  it("CONTROLE POSITIVO: bloco _expected_advisor desatualizado reprova, não passa em silêncio", () => {
    const observed: LintInventory = { "0028": ["a", "b"], "0029": ["a", "b", "c"] };
    // total gravado (23, por exemplo) não bate mais com 2+3=5 do observado.
    expect(countsMatchExpected(observed, { "0028": 2, "0029": 3, total: 23 })).toBe(false);
    // Contagem por lint errada mesmo com o total "acertando por acaso" (9+3=12≠5
    // de qualquer forma, mas o ponto é que CADA campo é conferido, não só o total).
    expect(countsMatchExpected(observed, { "0028": 9, "0029": 3, total: 5 })).toBe(false);
  });
});
