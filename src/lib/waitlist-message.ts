import { WAITLIST_TEMPLATES, renderWaitlistTemplate } from "@/hooks/useWaitlistTemplates";
import type { WaitlistEntry, WaitlistMessageTemplate } from "@/types/reserva";

/**
 * Monta a mensagem de um evento de fila (template customizado ou padrão).
 * Paridade com as edge functions: `.trim()` + mesmos fallbacks.
 */
export function buildWaitlistMessage(
  entry: WaitlistEntry,
  event: "entered" | "table_ready",
  opts: { templates: WaitlistMessageTemplate[] | undefined; unitName: string | undefined; origin: string },
): string {
  const tpl = opts.templates?.find((t) => t.event === event);
  const defaultBody = WAITLIST_TEMPLATES.find((t) => t.event === event)?.defaultBody ?? "";
  const body = tpl?.customized && tpl.body && tpl.body.trim() ? tpl.body : defaultBody;
  return renderWaitlistTemplate(body, {
    cliente_nome: entry.customer_name,
    unidade_nome: opts.unitName || "nosso restaurante",
    party_size: entry.party_size,
    codigo_fila: entry.code,
    link_status: `${opts.origin}/acompanhar/${entry.id}`,
  });
}
