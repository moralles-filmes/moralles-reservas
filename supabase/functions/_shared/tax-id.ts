// Validação de CPF/CNPJ (dígito verificador). Módulo PURO — zero imports, zero
// `Deno.*` — para ser importável pelo vitest a partir de src/ (padrão asaas-core).
//
// Existe porque o Asaas exige `cpfCnpj` para criar cliente (§9 do doc 03) e
// rejeitar cedo com mensagem clara é melhor que levar 400 genérico no meio de
// um checkout.
//
// MANTIDO SINCRONIZADO com src/lib/tax-id.ts. A sincronia é verificada por
// teste em src/lib/tax-id.test.ts ("sincronia entre ..."), não por convenção —
// diferente do precedente de phone.ts.

export function normalizeTaxId(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

function isRepeated(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

function validCpf(d: string): boolean {
  if (d.length !== 11 || isRepeated(d)) return false;
  for (const [len, factor] of [[9, 10], [10, 11]] as const) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (factor - i);
    const rest = (sum * 10) % 11;
    const check = rest === 10 || rest === 11 ? 0 : rest;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

function validCnpj(d: string): boolean {
  if (d.length !== 14 || isRepeated(d)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const len of [12, 13]) {
    const slice = weights.slice(13 - len);
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * slice[i];
    const rest = sum % 11;
    const check = rest < 2 ? 0 : 11 - rest;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

export function isValidTaxId(raw: string): boolean {
  const d = normalizeTaxId(raw);
  if (d.length === 11) return validCpf(d);
  if (d.length === 14) return validCnpj(d);
  return false;
}
