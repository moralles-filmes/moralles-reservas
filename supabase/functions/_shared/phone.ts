// Forma CANÔNICA de armazenamento de telefone brasileiro (fonte única do 9º dígito).
//
// Canônico: SÓ dígitos, sem código de país.
//   - Celular: 11 dígitos (DDD + 9 + 8 dígitos).
//   - Fixo:    10 dígitos (DDD + 8 dígitos).
//
// Regras:
//   1. Remove tudo que não é dígito.
//   2. Tira o código do país (55) SÓ quando vem com 12/13 dígitos. NÃO usar
//      `replace(/^55/, "")` cru — o DDD 55 (RS) existe e seria mutilado.
//   3. Celular sem o 9 (10 díg. e 1º dígito do assinante ∈ {6,7,8,9}) ganha o 9
//      após o DDD → 11 díg. Fixo (2-5) permanece com 10. Outros tamanhos: intocado.
//
// MANTIDO SINCRONIZADO (três cópias) com `canonicalBrPhone` em src/lib/phone.ts
// e a função SQL `normalize_br_phone` (migration 060, trigger customers_canonical_phone_trg).
export function canonicalBrPhone(raw: string): string {
  let digits = (raw ?? "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  if (digits.length === 10 && /[6-9]/.test(digits[2])) {
    digits = digits.slice(0, 2) + "9" + digits.slice(2);
  }
  return digits;
}
