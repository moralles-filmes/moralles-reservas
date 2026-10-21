import { normalizeNewlines } from "./text-normalize";

export type LineDiffKind = "same" | "add" | "remove";

export interface LineDiffEntry {
  kind: LineDiffKind;
  text: string;
}

function toLines(text: string): string[] {
  return text === "" ? [] : normalizeNewlines(text).split("\n");
}

/**
 * Diff de linhas (maior subsequência comum) entre `before` e `after`, na ordem
 * do texto. Linha trocada sai como `remove` seguido de `add`. Puro, sem
 * dependência: o texto do prompt tem no máximo alguns milhares de caracteres,
 * então a tabela O(n·m) é barata.
 */
export function diffLines(before: string, after: string): LineDiffEntry[] {
  const a = toLines(before);
  const b = toLines(after);
  // lcs[i][j] = tamanho da subsequência comum de a[i..] e b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "remove", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "remove", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}
