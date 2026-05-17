// Defaults compartilhados das mensagens automáticas da fila de espera.
//
// Source-of-truth do BACKEND para os 3 eventos (`entered`, `table_ready`,
// `feedback`). O hook `src/hooks/useWaitlistTemplates.ts` mantém uma cópia pra
// preview/UI — sincronizar manualmente quando alterar qualquer string aqui.
//
// Variáveis suportadas: {{cliente_nome}}, {{unidade_nome}}, {{party_size}},
// {{codigo_fila}}, {{link_status}}.

export const DEFAULT_ENTERED_BODY =
  "Oi {{cliente_nome}}! Você entrou na fila de espera em {{unidade_nome}}. " +
  "Sua senha é #{{codigo_fila}}. Acompanhe em {{link_status}}";

export const DEFAULT_TABLE_READY_BODY =
  "🔔 {{cliente_nome}}, sua mesa em {{unidade_nome}} está pronta! " +
  "Senha #{{codigo_fila}}. Por favor, dirija-se à recepção.";

export const DEFAULT_FEEDBACK_BODY =
  "Obrigado por escolher {{unidade_nome}}, {{cliente_nome}}! " +
  "Conte pra gente como foi sua experiência: {{link_status}}";

export interface WaitlistTemplateVars {
  cliente_nome: string;
  unidade_nome: string;
  party_size: number | null;
  codigo_fila: number | null;
  link_status: string;
}

export function renderWaitlistTemplate(
  template: string,
  vars: WaitlistTemplateVars,
): string {
  return template
    .replaceAll("{{cliente_nome}}", vars.cliente_nome)
    .replaceAll("{{unidade_nome}}", vars.unidade_nome)
    .replaceAll(
      "{{party_size}}",
      vars.party_size != null ? String(vars.party_size) : "",
    )
    .replaceAll(
      "{{codigo_fila}}",
      vars.codigo_fila != null ? String(vars.codigo_fila) : "",
    )
    .replaceAll("{{link_status}}", vars.link_status);
}

/**
 * Retorna a data de "ontem" no fuso da unidade BR (UTC-3, sem horário de
 * verão — BR não usa DST desde 2019). Robusto pra qualquer hora UTC do dia,
 * sem depender do horário fixo do cron. Formato YYYY-MM-DD.
 *
 * Exemplo: chamado em 2026-05-16T17:00:00Z (= 2026-05-16T14:00 BRT)
 * → retorna "2026-05-15".
 *
 * Edge case noturno: chamado em 2026-05-16T02:00:00Z (= 2026-05-15T23:00 BRT)
 * → retorna "2026-05-14" (ontem em BRT, não em UTC).
 */
export function yesterdayInBRT(): string {
  const now = new Date();
  // Shift de UTC pra BRT (-3h)
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brt.setUTCDate(brt.getUTCDate() - 1);
  return brt.toISOString().slice(0, 10);
}
