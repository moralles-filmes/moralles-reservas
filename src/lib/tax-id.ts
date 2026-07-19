// Validação e formatação de CPF/CNPJ para a UI. O núcleo (normalizeTaxId,
// isValidTaxId) é IDÊNTICO a supabase/functions/_shared/tax-id.ts — a sincronia
// é verificada por teste em ./tax-id.test.ts, não por convenção.
//
// A máscara (formatTaxId) e o resultado estruturado (validateTaxId) são
// frontend-only: o backend só precisa do booleano.

export function normalizeTaxId(input: string | null | undefined): string {
  return (input ?? "").replace(/\D/g, "");
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

export function isValidTaxId(input: string | null | undefined): boolean {
  const d = normalizeTaxId(input);
  if (d.length === 11) return validCpf(d);
  if (d.length === 14) return validCnpj(d);
  return false;
}

/** Máscara por tamanho. Entrada parcial volta intocada (digitação em progresso). */
export function formatTaxId(input: string | null | undefined): string {
  const d = normalizeTaxId(input);
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return d;
}

export interface TaxIdValidation {
  valid: boolean;
  reason?: string;
  /** Dígitos normalizados, prontos pra persistir. */
  digits: string;
}

export function validateTaxId(
  input: string | null | undefined,
  opts?: { allowEmpty?: boolean },
): TaxIdValidation {
  const digits = normalizeTaxId(input);
  if (!digits) {
    return opts?.allowEmpty
      ? { valid: true, digits: "" }
      : { valid: false, reason: "CPF/CNPJ é obrigatório.", digits: "" };
  }
  if (digits.length !== 11 && digits.length !== 14) {
    return { valid: false, reason: "CPF/CNPJ inválido — informe 11 ou 14 dígitos.", digits };
  }
  if (!isValidTaxId(digits)) {
    return { valid: false, reason: "CPF/CNPJ inválido — verifique os dígitos.", digits };
  }
  return { valid: true, digits };
}
