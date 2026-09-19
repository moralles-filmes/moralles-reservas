// scripts/advisor-divergence-core.ts
//
// NÚCLEO PURO da regra 6 de scripts/audit-function-acl.ts (o "equivalente-advisor").
// Zero I/O, zero import remoto — só comparação de listas de assinaturas.
//
// POR QUÊ ESTE ARQUIVO EXISTE SEPARADO DE audit-function-acl.ts: aquele script
// importa "https://esm.sh/@supabase/supabase-js@2" para falar com o Postgres.
// `tsc -b` RESOLVE um `import type` mesmo que ele seja apagado na emissão —
// não só faz parse —, então um especificador de URL estoura TS2307 assim que
// QUALQUER arquivo alcançável a partir de `src/` importar (direta ou
// transitivamente) o arquivo que contém aquele import. Isso já custou uma
// rodada de correção na Task 1 desta mesma frente (ver progress.md). Este
// arquivo pode ser importado por um teste em `src/` no futuro sem acionar
// aquele TS2307 justamente porque ele não tem import nenhum de rede.
//
// O QUE ESTA CAMADA RESPONDE: dado o inventário de assinaturas que o
// ALLOWLIST declara para cada lint do advisor (0028 = anon, 0029 =
// authenticated — ver function-acl-allowlist.json `_expected_advisor`) e o
// inventário de assinaturas que o BANCO realmente produz (via
// audit_function_acl(), regra 6 de audit-function-acl.ts), a divergência
// entre os dois — nomeando CADA assinatura que entrou e CADA que saiu, nunca
// só a contagem. Uma contagem que bate pode esconder uma assinatura nova que
// substituiu uma removida (mesmo total, superfície diferente).

/** Assinaturas (`nome(args)`) sob um lint, num dos dois lados da comparação. */
export interface LintInventory {
  "0028": string[];
  "0029": string[];
}

/** O que mudou para UM lint: quem passou a aparecer, quem deixou de aparecer. */
export interface LintDivergence {
  /** Presente no lado OBSERVADO (banco) e ausente do ESPERADO (allowlist). */
  entered: string[];
  /** Presente no ESPERADO (allowlist) e ausente do OBSERVADO (banco). */
  left: string[];
}

export interface AdvisorDivergence {
  "0028": LintDivergence;
  "0029": LintDivergence;
  /** true quando as quatro listas (entered/left × 0028/0029) estão vazias. */
  clean: boolean;
}

/** Bloco `_expected_advisor` da allowlist — só contagem, não assinatura. */
export interface ExpectedAdvisorCounts {
  "0028": number;
  "0029": number;
  total: number;
}

/**
 * Diferença de conjunto entre duas listas de assinaturas, para UM lint.
 * Determinística: `entered`/`left` sempre saem ordenadas, para a saída (e o
 * teste) não depender da ordem de iteração de `Map`/`Set`.
 */
export function diffLintInventory(expected: string[], observed: string[]): LintDivergence {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const entered = observed.filter((sig) => !expectedSet.has(sig)).sort();
  const left = expected.filter((sig) => !observedSet.has(sig)).sort();
  return { entered, left };
}

/** Aplica `diffLintInventory` aos dois lints e resume se há alguma divergência. */
export function computeAdvisorDivergence(
  expected: LintInventory,
  observed: LintInventory,
): AdvisorDivergence {
  const d0028 = diffLintInventory(expected["0028"], observed["0028"]);
  const d0029 = diffLintInventory(expected["0029"], observed["0029"]);
  const clean =
    d0028.entered.length === 0 &&
    d0028.left.length === 0 &&
    d0029.entered.length === 0 &&
    d0029.left.length === 0;
  return { "0028": d0028, "0029": d0029, clean };
}

/**
 * Confere o inventário OBSERVADO (contagem, não lista) contra o bloco
 * `_expected_advisor` da allowlist. Existe como checagem redundante e barata:
 * se `computeAdvisorDivergence` já prova que as listas de assinatura batem,
 * as contagens batem por construção — mas se o bloco `_expected_advisor`
 * ficar desatualizado em relação às entradas da própria allowlist (o que o
 * teste estático já impede em CI, mas este script roda contra produção, fora
 * do CI), esta função nomeia o número que diverge em vez de deixar o defeito
 * silencioso.
 */
export function countsMatchExpected(
  observed: LintInventory,
  expected: ExpectedAdvisorCounts,
): boolean {
  const total0028 = observed["0028"].length;
  const total0029 = observed["0029"].length;
  return (
    total0028 === expected["0028"] &&
    total0029 === expected["0029"] &&
    total0028 + total0029 === expected.total
  );
}
