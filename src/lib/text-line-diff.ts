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
 * dependência. Prefixo e sufixo comuns saem antes do LCS (o caso comum é uma
 * edição no meio de um texto igual), e a tabela é plana: o custo cai para o
 * tamanho do trecho que mudou, não do texto inteiro.
 */
export function diffLines(before: string, after: string): LineDiffEntry[] {
  const a = toLines(before);
  const b = toLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: LineDiffEntry[] = [];
  for (let k = 0; k < start; k++) out.push({ kind: "same", text: a[k] });

  const n = endA - start;
  const m = endB - start;
  const width = m + 1;
  // lcs[i * width + j] = tamanho da subsequência comum de a[start+i..endA] e b[start+j..endB].
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out.push({ kind: "same", text: a[start + i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ kind: "remove", text: a[start + i++] });
    } else {
      out.push({ kind: "add", text: b[start + j++] });
    }
  }
  while (i < n) out.push({ kind: "remove", text: a[start + i++] });
  while (j < m) out.push({ kind: "add", text: b[start + j++] });

  for (let k = endA; k < a.length; k++) out.push({ kind: "same", text: a[k] });
  return out;
}
