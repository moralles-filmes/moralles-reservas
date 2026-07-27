// Parser de valor monetário digitado em formato BR (R$) → centavos.
//
// Compartilhado por src/pages/platform/WhatsappImplementations.tsx (registro
// de pagamento externo da implantação) e src/pages/platform/BillingPlans.tsx
// (preço do catálogo de planos, inclusive `instancia-whatsapp` e
// `implementacao-whatsapp` — o valor que a fase 5a passou a ativar pra
// cobrança real). Extraído pra módulo único porque o bug que motivou a regra
// abaixo (M-11 → Rodada de correção 2) foi corrigido num só arquivo e deixado
// vivo no outro — duplicar heurística de parsing é exatamente o tipo de
// divergência que este arquivo existe pra impedir.

/**
 * Converte string digitada em formato BR pra centavos.
 *
 * O bug que esta função previne: remover todo "." às cegas transforma
 * "750.00" (formato US, hábito de teclado numérico ou cópia de planilha) em
 * "75000" → 7500000 centavos = R$ 75.000,00, cem vezes o valor digitado, sem
 * nenhum aviso. Regra explícita, sem remover "." às cegas:
 *   - Com vírgula: vírgula é decimal, todo "." é milhar
 *     ("1.750,00" → 175000).
 *   - Sem vírgula: o ÚLTIMO "." decide. Exatamente 2 dígitos depois dele →
 *     é decimal ("750.00" → 75000, NÃO 7500000). Qualquer outra contagem →
 *     é milhar ("1.750" → 175000). Pontos ANTES do último (se houver, ex.
 *     "1.750.00") são sempre milhar quando o último é decimal.
 *
 * Retorna NaN se não parsear — o chamador decide a mensagem de erro e se
 * quer permitir zero/negativo (esta função não valida sinal). O eco "Será
 * registrado/salvo: R$ X" abaixo do campo, nos dois formulários que
 * consomem esta função, é a defesa que sobrevive a uma entrada que a
 * heurística de separador não previu: quem preenche lê o valor interpretado
 * ANTES de confirmar, em vez de confiar cego na regra.
 */
export function parseAmountReaisToCents(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return NaN;

  let normalized: string;
  if (trimmed.includes(",")) {
    normalized = trimmed.replace(/\./g, "").replace(",", ".");
  } else {
    const lastDot = trimmed.lastIndexOf(".");
    if (lastDot === -1) {
      normalized = trimmed;
    } else {
      const decimalsLength = trimmed.length - lastDot - 1;
      if (decimalsLength === 2) {
        // Último ponto é decimal — qualquer ponto ANTES dele é milhar.
        const intPart = trimmed.slice(0, lastDot).replace(/\./g, "");
        const decPart = trimmed.slice(lastDot + 1);
        normalized = `${intPart}.${decPart}`;
      } else {
        // Nenhum ponto é decimal — todos são milhar.
        normalized = trimmed.replace(/\./g, "");
      }
    }
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}
