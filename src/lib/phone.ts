// Validação de telefone brasileiro na ORIGEM (formato), pra barrar número
// malformado antes de virar não-entrega de WhatsApp. Separado de formatPhone
// (@/lib/utils), que é só exibição. Validação é frontend-only (ver Fase 3 do
// plano / precedente do e-mail no CLAUDE.md): o backend continua lenient porque
// o agente WhatsApp usa o telefone do próprio remetente.

// DDDs válidos no Brasil (Plano Nacional de Numeração). Fora dessa lista é typo
// (ex.: "01", "00", "20"). Set pra lookup O(1).
const VALID_DDDS = new Set<number>([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24,
  27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46,
  47, 48, 49,
  51, 53, 54, 55,
  61,
  62, 64,
  63,
  65, 66,
  67,
  68,
  69,
  71, 73, 74, 75, 77,
  79,
  81, 87,
  82,
  83,
  84,
  85, 88,
  86, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/** Só dígitos; remove o código de país 55 quando vier com 12/13 dígitos. */
export function normalizeBrPhone(input: string | null | undefined): string {
  let d = (input ?? "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) {
    d = d.slice(2);
  }
  return d;
}

/**
 * Forma CANÔNICA de ARMAZENAMENTO (≠ `normalizeBrPhone`, que não toca no 9):
 * celular sem o 9 (10 díg., 1º dígito do assinante ∈ {6,7,8,9}) ganha o 9 após
 * o DDD → 11 díg. Fixo (2-5) permanece com 10. É o que evita o mesmo cliente
 * virar duplicata salvo em dois formatos.
 *
 * MANTIDO SINCRONIZADO (três cópias) com `canonicalBrPhone` em
 * supabase/functions/_shared/phone.ts e a função SQL `normalize_br_phone`
 * (migration 060, trigger customers_canonical_phone_trg).
 */
export function canonicalBrPhone(input: string | null | undefined): string {
  const d = normalizeBrPhone(input);
  if (d.length === 10 && /[6-9]/.test(d[2])) {
    return d.slice(0, 2) + "9" + d.slice(2);
  }
  return d;
}

export interface PhoneValidation {
  valid: boolean;
  reason?: string;
  /** Dígitos normalizados (sem 55), prontos pra persistir. */
  digits: string;
}

/**
 * Valida um telefone BR aceitando fixo (10 díg.) ou celular (11 díg.). Não
 * over-rejeita fixo (que não recebe WhatsApp) — isso ainda fica visível no
 * painel Entregas; o foco aqui é barrar número claramente inválido.
 */
export function validateBrPhone(
  input: string | null | undefined,
  opts?: { allowEmpty?: boolean },
): PhoneValidation {
  const digits = normalizeBrPhone(input);

  if (!digits) {
    return opts?.allowEmpty
      ? { valid: true, digits: "" }
      : { valid: false, reason: "Informe o WhatsApp com DDD.", digits: "" };
  }

  if (digits.length !== 10 && digits.length !== 11) {
    return { valid: false, reason: "Telefone inválido. Use DDD + número (ex: 11999998888).", digits };
  }

  if (/^(\d)\1+$/.test(digits)) {
    return { valid: false, reason: "Telefone inválido.", digits };
  }

  const ddd = Number(digits.slice(0, 2));
  if (!VALID_DDDS.has(ddd)) {
    return { valid: false, reason: "DDD inválido. Confira o número.", digits };
  }

  const third = digits[2];
  if (digits.length === 11 && third !== "9") {
    return { valid: false, reason: "Celular deve ter o 9 após o DDD.", digits };
  }
  if (digits.length === 10 && !"2345".includes(third)) {
    // 10 díg. que não começa 2–5 é provável celular sem o 9 → pede os 11.
    return { valid: false, reason: "Para celular use 11 dígitos (com o 9 após o DDD).", digits };
  }

  return { valid: true, digits };
}

export function isValidBrPhone(input: string | null | undefined): boolean {
  return validateBrPhone(input).valid;
}
