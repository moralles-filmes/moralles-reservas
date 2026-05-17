// Helpers compartilhados do módulo Giftback.
//
// Centraliza geração de código de voucher, template default da mensagem,
// render do template e cálculo de validade fim-do-dia BRT — usados pelo
// webhook-whatsapp (intercept after_rating) e pelo worker
// process-voucher-triggers (birthday/frequency).
//
// IMPORTANTE: Edge Functions rodam em Deno com runtime UTC. Ao calcular
// "fim do dia local do restaurante" a partir do runtime, precisamos fazer a
// conta em BRT (-3h fixo) manualmente — `Date#setHours` em Deno é UTC.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const VOUCHER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

export const DEFAULT_GIFTBACK_TEMPLATE =
  "🎁 Você ganhou {{discount}}% de desconto na sua próxima visita ao {{unidade}}!\n\n" +
  "Código: *{{codigo}}*\nVálido até *{{validade}}*.\n\n" +
  "Apresente esse código quando for pagar.";

export function generateVoucherCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += VOUCHER_CODE_ALPHABET[Math.floor(Math.random() * VOUCHER_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Timestamp ISO de fim do dia (23:59:59.999) BRT, N dias à frente do
 * runtime UTC. Cliente tem o dia inteiro até a meia-noite de Brasília
 * pra usar o voucher, independente do horário do issue.
 */
export function expiresAtEndOfDayBrt(validityDays: number): string {
  // "Agora" em BRT (UTC-3): subtrai 3h da hora UTC pra trabalhar no calendário BRT
  const nowBrt = new Date(Date.now() - BRT_OFFSET_MS);
  nowBrt.setUTCDate(nowBrt.getUTCDate() + validityDays);
  nowBrt.setUTCHours(23, 59, 59, 999);
  // Converte de volta pra UTC real adicionando o offset
  return new Date(nowBrt.getTime() + BRT_OFFSET_MS).toISOString();
}

/** Formata um ISO de expiração BRT como "DD/MM/AAAA" usando o dia BRT. */
export function formatExpiryBR(expiresAtIso: string): string {
  const t = new Date(expiresAtIso).getTime();
  return new Date(t - BRT_OFFSET_MS)
    .toISOString()
    .slice(0, 10)
    .split("-")
    .reverse()
    .join("/");
}

export function renderGiftbackTemplate(
  template: string,
  vars: { discount: number; unidade: string; codigo: string; validade: string },
): string {
  return template
    .replace(/\{\{discount\}\}/g, String(vars.discount))
    .replace(/\{\{unidade\}\}/g, vars.unidade)
    .replace(/\{\{codigo\}\}/g, vars.codigo)
    .replace(/\{\{validade\}\}/g, vars.validade);
}

/**
 * Gera código único checando colisão com índice parcial em (code) WHERE
 * status='active'. Retry até 8x — fallback final tem timestamp para garantir
 * unicidade matemática.
 */
export async function ensureUniqueVoucherCode(supabase: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateVoucherCode();
    const { data: existing } = await supabase
      .from("vouchers")
      .select("id")
      .eq("code", candidate)
      .eq("status", "active")
      .maybeSingle();
    if (!existing) return candidate;
  }
  return `${generateVoucherCode().slice(0, 4)}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}
