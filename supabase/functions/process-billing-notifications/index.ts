// Worker: envia as notificações de billing pendentes (Resend). Roda a cada 5min
// via pg_cron. Gated pela flag billing_notifications_dispatch (OFF = a fila
// acumula sem enviar). Nunca usa canal WhatsApp da org.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { isFlagEnabled } from "../_shared/platform-flags.ts";
import { sendEmail } from "../_shared/email.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BATCH = 20;

type TemplateData = {
  orgName: string;
  amountBrl: string;
  paymentUrl: string | null;
};

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function wrapHtml(title: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222"><h2>${title}</h2>${body}</div>`;
}

function payLine(url: string | null): string {
  return url ? `Para pagar, acesse: ${url}` : "Acesse o painel para regularizar.";
}

const TEMPLATE_BY_EVENT: Record<
  string,
  (d: TemplateData) => { subject: string; text: string; html: string }
> = {
  payment_pending: (d) => ({
    subject: "Sua mensalidade vence hoje",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} vence hoje. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Sua mensalidade vence hoje", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> vence hoje.`,
      payLine(d.paymentUrl),
    ]),
  }),
  overdue_d1: (d) => ({
    subject: "Pagamento em atraso",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} está em atraso (1 dia). ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Pagamento em atraso", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> está em atraso há 1 dia.`,
      payLine(d.paymentUrl),
    ]),
  }),
  overdue_d3: (d) => ({
    subject: "Pagamento em atraso (3 dias)",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} está em atraso há 3 dias. O acesso será suspenso se não for regularizado. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Pagamento em atraso (3 dias)", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> está em atraso há 3 dias.`,
      `O acesso será suspenso se não for regularizado.`,
      payLine(d.paymentUrl),
    ]),
  }),
  overdue_d5: (d) => ({
    subject: "Último aviso antes da suspensão",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} está em atraso há 5 dias. Sem o pagamento, o acesso será suspenso amanhã. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Último aviso antes da suspensão", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> está em atraso há 5 dias.`,
      `Sem o pagamento, o acesso será <strong>suspenso amanhã</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  suspended: (d) => ({
    subject: "Acesso suspenso por falta de pagamento",
    text: `Olá, ${d.orgName}. O acesso ao sistema foi suspenso por falta de pagamento da mensalidade de ${d.amountBrl}. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Acesso suspenso", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `O acesso ao sistema foi <strong>suspenso</strong> por falta de pagamento da mensalidade de <strong>${d.amountBrl}</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  regularized: (d) => ({
    subject: "Pagamento confirmado — acesso liberado",
    text: `Olá, ${d.orgName}. Recebemos o pagamento da sua mensalidade e o acesso foi liberado. Obrigado!`,
    html: wrapHtml("Acesso liberado", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Recebemos o pagamento da sua mensalidade e o acesso foi <strong>liberado</strong>.`,
      `Obrigado!`,
    ]),
  }),
  // Lembretes da mensalidade da INSTÂNCIA de WhatsApp (Task 18, Fase 5b) —
  // vocabulário próprio, separado do da mensalidade de SISTEMA acima. A razão
  // de existir: "o acesso será suspenso" é verdade pra fatura de sistema e
  // seria mentira pra esta, que só desliga a automação de WhatsApp. Todo
  // parágrafo aqui deixa explícito que o resto do sistema (reservas, agenda,
  // clientes, relatórios) continua funcionando — sem isso o dono do
  // restaurante lê a palavra "suspenso" e entende que o sistema inteiro vai
  // parar. `process-billing-reminders` decide o prefixo `whatsapp_` do
  // event_type; estas 4 entradas cobrem a mesma escada D0/D+1/D+3/D+5 de
  // `REMINDER_OFFSETS` (billing-delinquency-core.ts) — uma escada só, dois
  // vocabulários. Escalada visível igual à irmã de sistema (fix round 1, Task
  // 18): D0/D+1 sem consequência, D+3 já avisa que a automação será
  // suspensa, D+5 é o último aviso — só o VOCABULÁRIO muda (nunca "acesso"),
  // não o formato da escalada. `d.amountBrl`/`payLine(d.paymentUrl)` seguem
  // exatamente o padrão das irmãs de sistema acima (mesmo fix round: um
  // lembrete de cobrança sem valor nem link pra pagar é quase inútil).
  whatsapp_payment_pending: (d) => ({
    subject: "A mensalidade da automação de WhatsApp vence hoje",
    text: `A mensalidade da automação de WhatsApp de ${d.orgName} vence hoje. O restante do sistema não é afetado por esta cobrança. Valor: ${d.amountBrl}. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("A mensalidade da automação de WhatsApp vence hoje", [
      `A mensalidade da automação de WhatsApp de <strong>${d.orgName}</strong> vence hoje.`,
      `O restante do sistema não é afetado por esta cobrança.`,
      `Valor: <strong>${d.amountBrl}</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  whatsapp_overdue_d1: (d) => ({
    subject: "Mensalidade da automação em atraso",
    text: `A mensalidade da automação de WhatsApp de ${d.orgName} está em atraso há 1 dia. O restante do sistema não é afetado por esta cobrança. Valor: ${d.amountBrl}. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Mensalidade da automação em atraso", [
      `A mensalidade da automação de WhatsApp de <strong>${d.orgName}</strong> está em atraso há 1 dia.`,
      `O restante do sistema não é afetado por esta cobrança.`,
      `Valor: <strong>${d.amountBrl}</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  whatsapp_overdue_d3: (d) => ({
    subject: "Mensalidade da automação em atraso (3 dias)",
    text: `A mensalidade da automação de WhatsApp de ${d.orgName} está em atraso há 3 dias. Se não for regularizada, a automação de WhatsApp será suspensa — reservas, agenda, painel e relatórios continuam funcionando normalmente. Valor: ${d.amountBrl}. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Mensalidade da automação em atraso (3 dias)", [
      `A mensalidade da automação de WhatsApp de <strong>${d.orgName}</strong> está em atraso há 3 dias.`,
      `Se não for regularizada, a automação de WhatsApp será <strong>suspensa</strong> — reservas, agenda, painel e relatórios continuam funcionando normalmente.`,
      `Valor: <strong>${d.amountBrl}</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  whatsapp_overdue_d5: (d) => ({
    subject: "Último aviso antes da suspensão da automação de WhatsApp",
    text: `A mensalidade da automação de WhatsApp de ${d.orgName} está em atraso. Amanhã os envios e o atendimento automático pelo WhatsApp serão suspensos. Reservas, agenda, painel e relatórios continuam funcionando normalmente. Valor: ${d.amountBrl}. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Último aviso antes da suspensão da automação de WhatsApp", [
      `A mensalidade da automação de WhatsApp de <strong>${d.orgName}</strong> está em atraso.`,
      `Amanhã os envios e o atendimento automático pelo WhatsApp serão suspensos. <strong>Reservas, agenda, painel e relatórios continuam funcionando normalmente.</strong>`,
      `Valor: <strong>${d.amountBrl}</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  // Produzido por process-whatsapp-enforcement (Task 17), invoiceId sempre
  // null (a suspensão é por estado da assinatura, não por uma fatura
  // específica) — por isso não referenciar d.amountBrl aqui, chega zerado.
  // `payLine(null)` (fix round 1, Task 18: verificado que produz um CTA
  // genérico utilizável, "Acesse o painel para regularizar.") substitui um
  // "regularize a mensalidade" sem nenhum ponteiro de onde.
  whatsapp_suspended: (d) => ({
    subject: "Automação de WhatsApp suspensa",
    text: `A automação de WhatsApp de ${d.orgName} foi suspensa por falta de pagamento. O sistema segue funcionando: reservas, agenda, clientes e relatórios não foram afetados. Regularize a mensalidade para retomar os envios. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Automação de WhatsApp suspensa", [
      `A automação de WhatsApp de <strong>${d.orgName}</strong> foi suspensa por falta de pagamento.`,
      `O sistema segue funcionando: reservas, agenda, clientes e relatórios não foram afetados. Regularize a mensalidade para retomar os envios.`,
      payLine(d.paymentUrl),
    ]),
  }),
  // Mesma origem (Task 17) e mesmo motivo de não usar amountBrl/paymentUrl.
  whatsapp_restored: (d) => ({
    subject: "Automação de WhatsApp reativada",
    text: `Pagamento confirmado. A automação de WhatsApp de ${d.orgName} voltou a funcionar. Mensagens que ficaram pendentes durante a suspensão são reavaliadas antes de sair — as que perderam validade não são enviadas.`,
    html: wrapHtml("Automação de WhatsApp reativada", [
      `Pagamento confirmado. A automação de WhatsApp de <strong>${d.orgName}</strong> voltou a funcionar.`,
      `Mensagens que ficaram pendentes durante a suspensão são reavaliadas antes de sair — as que perderam validade não são enviadas.`,
    ]),
  }),
  // Aviso INTERNO (vai para o admin da plataforma, não para o cliente): a
  // implantação foi paga e entra na fila de execução. Sem esta entrada o
  // dispatcher marcaria a linha como failed/unknown_event_type e o aviso
  // sumiria.
  implementation_paid: (d) => ({
    subject: `Implantação de WhatsApp paga — ${d.orgName}`,
    text: `${d.orgName} pagou a implantação do WhatsApp (${d.amountBrl}). Agende a configuração no painel de implantações.`,
    html: wrapHtml("Implantação de WhatsApp paga", [
      `<strong>${d.orgName}</strong> pagou a implantação do WhatsApp.`,
      `Valor: <strong>${d.amountBrl}</strong>.`,
      `Agende a configuração no painel de implantações.`,
    ]),
  }),
  // Aviso INTERNO (vai para o admin da plataforma, não para o cliente).
  // GENERALIZADO na Task 18 (Fase 5b) — este `event_type` é compartilhado por
  // mais de um gatilho, e o texto não pode presumir qual foi:
  //   1. `asaas-billing-events-apply.ts` (Task 8): duas fontes da escada de
  //      correlação divergiram de organização DENTRO da MESMA passagem
  //      (`resolveCorrelation` devolveu `kind: "conflict"`) — evento em falha
  //      na fila do reconcile, log `evt: asaas_correlation_ambiguity`.
  //   2. `process-whatsapp-enforcement` (Task 17): mais de uma assinatura
  //      `WHATSAPP_SUBSCRIPTION` viva para a mesma organização — nada a ver
  //      com `billing_events` nem com o reconcile do Asaas, log
  //      `evt: whatsapp_ambiguous_subscription`.
  // A versão anterior deste template nomeava "evento de pagamento do Asaas" e
  // mandava o admin olhar `billing_events` — certo para o gatilho 1, errado
  // para o 2 (o admin ia procurar no lugar errado). Por isso o texto agora
  // fala em "evento de cobrança" (cobre os dois) e aponta pro painel da
  // plataforma de forma genérica, nunca por uma tabela específica — evento
  // novo que reusar esta chave continua acertando o texto. Detalhe de QUAL
  // gatilho ocorreu e QUAIS organizações/assinaturas fica só nos logs do
  // `evt` correspondente, nunca no corpo do e-mail (`d.orgName` é só endereço
  // de conveniência — a coluna organization_id de billing_notifications é NOT
  // NULL — não necessariamente quem gerou a ambiguidade).
  // Aviso INTERNO: `manage-billing` cancelou a assinatura NO PROVEDOR e a
  // escrita local falhou logo depois. É a única divergência de cancelamento
  // que o nosso código produz sozinho (as outras nascem de alguém mexer no
  // painel do provedor), e o efeito é assimétrico de propósito: ninguém mais
  // será cobrado, mas o banco segue dizendo que a assinatura está viva — logo
  // o BillingGuard continua liberando acesso. Exige conferência humana, não
  // retry: o provedor já cancelou, repetir não desfaz nada.
  // Qual assinatura e qual erro do Postgres ficam nos logs
  // (`evt: billing_cancel_local_write_failed` e a variante `_by_owner_`),
  // nunca no corpo do e-mail.
  admin_cancel_local_write_failed: (d) => ({
    subject: `[interno] Cancelamento divergente — ${d.orgName}`,
    text: `A assinatura da organização ${d.orgName} foi cancelada no provedor de pagamento, mas o registro local NÃO foi atualizado. O cliente deixou de ser cobrado e o sistema ainda o considera ativo. Concilie manualmente: confira o estado da assinatura no provedor e atualize o registro no painel da plataforma.`,
    html: wrapHtml("Cancelamento divergente", [
      `A assinatura da organização <strong>${d.orgName}</strong> foi cancelada <strong>no provedor de pagamento</strong>, mas o registro local <strong>não</strong> foi atualizado.`,
      `Consequência: o cliente deixou de ser cobrado e o sistema ainda o considera ativo.`,
      `Concilie manualmente — confira o estado da assinatura no provedor e atualize o registro no painel da plataforma.`,
    ]),
  }),
  // Aviso INTERNO (hotfix pré-6b do Risco 7): uma fatura vencida não pôde ser
  // classificada com evidência inequívoca — sem vínculo confiável de plano,
  // com leitura falhando, com assinatura em status terminal, ou com conflito
  // entre `purpose` e categoria. Ela foi RETIDA (`enforcement_hold`) e NÃO
  // escalou; a categoria e o motivo exato ficam nos logs
  // (`evt: invoice_category_needs_review`) e no painel, nunca no e-mail — o
  // texto precisa servir aos quatro motivos sem afirmar qual foi.
  admin_invoice_category_review: (d) => ({
    subject: `[interno] Fatura retida para conferência — ${d.orgName}`,
    text: `Uma fatura vencida da organização ${d.orgName} não pôde ser classificada com evidência suficiente e foi retida para conferência. Nenhum acesso foi suspenso e nenhum aviso foi enviado ao cliente por causa dela. Verifique a fatura no painel da plataforma antes de liberar a retenção.`,
    html: wrapHtml("Fatura retida para conferência", [
      `Uma fatura vencida da organização <strong>${d.orgName}</strong> não pôde ser classificada com evidência suficiente e foi <strong>retida para conferência</strong>.`,
      `Nenhum acesso foi suspenso e nenhum aviso foi enviado ao cliente por causa dela.`,
      `Verifique a fatura no painel da plataforma antes de liberar a retenção.`,
    ]),
  }),
  admin_correlation_ambiguity: (d) => ({
    subject: `[interno] Evento de cobrança precisa de conferência — ${d.orgName}`,
    text: `Um evento de cobrança da organização ${d.orgName} precisa de conferência manual antes de qualquer ação automática. Verifique o painel da plataforma e os logs do evento para os detalhes.`,
    html: wrapHtml("Evento de cobrança precisa de conferência", [
      `Um evento de cobrança da organização <strong>${d.orgName}</strong> precisa de <strong>conferência manual</strong> antes de qualquer ação automática.`,
      `Verifique o painel da plataforma e os logs do evento para os detalhes.`,
    ]),
  }),
  // Aviso INTERNO (Fix round 1, achado Important #2): o carimbo de
  // `billing_events.organization_id` de uma passagem ANTERIOR do aplicador
  // divergiu da resolução da escada NESTA passagem (`comparePreviousStamp`
  // !== MATCH). Cobre os dois sub-casos — corrigido automaticamente (fonte
  // atual mais forte que a anterior, ou fonte anterior desconhecida) ou
  // sinalizado para revisão (escada não resolveu desta vez, ou — hoje
  // inalcançável — fonte anterior conhecida de rank superior). `d.orgName`
  // é só para o admin achar o evento; qual dos dois sub-casos ocorreu está
  // no `evt: asaas_previous_stamp_divergence` dos logs, nunca no e-mail.
  admin_correlation_org_restamped: (d) => ({
    subject: "Evento Asaas com organização recarimbada — conferir",
    text: `Um evento de pagamento do Asaas já tinha uma organização carimbada de uma passagem anterior e a resolução desta passagem divergiu (referência: ${d.orgName}). Confira nos logs (evt: asaas_previous_stamp_divergence) se a correção foi aplicada automaticamente ou se aguarda revisão.`,
    html: wrapHtml("Evento Asaas com organização recarimbada", [
      `Um evento de pagamento do Asaas já tinha uma organização carimbada de uma passagem anterior, e a resolução desta passagem <strong>divergiu</strong>.`,
      `Referência: <strong>${d.orgName}</strong>.`,
      `Confira nos logs (<code>evt: asaas_previous_stamp_divergence</code>) se a correção foi aplicada automaticamente ou se aguarda revisão.`,
    ]),
  }),
  // Aviso INTERNO (vai para o admin da plataforma, não para o cliente —
  // Fase 5b Task 11, process-asaas-invoice-reconcile): a varredura por
  // assinatura achou uma fatura `open` cujo `amount_cents` diverge do `value`
  // atual da cobrança no Asaas. A fatura foi RETIDA (`enforcement_hold`) sem
  // corrigir nenhum dos dois lados — sem esta entrada o dispatcher marcaria a
  // linha como failed/unknown_event_type e o aviso sumiria, deixando a
  // divergência presa sem ninguém saber. `d.amountBrl` é o valor LOCAL (o que
  // `billing_invoices.amount_cents` registra); o valor do provedor só está
  // nos logs (evt: asaas_invoice_reconcile_value_mismatch) — nunca inventar
  // qual dos dois está certo no corpo do e-mail.
  admin_invoice_value_mismatch: (d) => ({
    subject: "Fatura Asaas com valor divergente — requer conferência",
    text: `Uma fatura de ${d.orgName} tem valor divergente entre billing_invoices (${d.amountBrl}) e a cobrança correspondente no Asaas. A fatura foi retida (enforcement_hold) e não entra na régua de inadimplência até revisão manual — confira nos logs (evt: asaas_invoice_reconcile_value_mismatch) antes de liberar.`,
    html: wrapHtml("Fatura Asaas com valor divergente", [
      `Uma fatura de <strong>${d.orgName}</strong> tem valor divergente entre <code>billing_invoices</code> (<strong>${d.amountBrl}</strong>) e a cobrança correspondente no Asaas.`,
      `A fatura foi <strong>retida</strong> (enforcement_hold) e não entra na régua de inadimplência até revisão manual.`,
      `Confira nos logs (<code>evt: asaas_invoice_reconcile_value_mismatch</code>) antes de liberar.`,
    ]),
  }),
  // Aviso INTERNO (Fix round 1, achado 3 — decisão do dono): a varredura por
  // assinatura achou uma cobrança estornada/contestada/cancelada ou de status
  // desconhecido no Asaas, correspondente a uma fatura `open` local. A fatura
  // foi CONGELADA (enforcement_hold='MANUAL_REVIEW') pra tirá-la da régua de
  // inadimplência sem apagar o registro nem marcar como paga sozinha — sem
  // esta entrada o dispatcher marcaria a linha como failed/unknown_event_type
  // e o aviso sumiria. `d.amountBrl` é o valor LOCAL da fatura; o
  // `remoteStatus` (REFUNDED/CHARGEBACK_*/status desconhecido) só está nos
  // logs (evt: asaas_invoice_reconcile_non_collectible_hold) — o e-mail não
  // tenta adivinhar se foi estorno, chargeback ou status novo da API.
  admin_invoice_non_collectible_hold: (d) => ({
    subject: "Fatura Asaas retida — cobrança estornada, contestada ou de status desconhecido",
    text: `Uma fatura de ${d.orgName} (${d.amountBrl}) tem cobrança correspondente no Asaas com status de estorno, chargeback ou desconhecido. A fatura foi retida (enforcement_hold=MANUAL_REVIEW) e não entra na régua de inadimplência — confira nos logs (evt: asaas_invoice_reconcile_non_collectible_hold) para o status exato antes de qualquer ação.`,
    html: wrapHtml("Fatura Asaas retida — revisão manual", [
      `Uma fatura de <strong>${d.orgName}</strong> (<strong>${d.amountBrl}</strong>) tem cobrança correspondente no Asaas com status de <strong>estorno, chargeback ou desconhecido</strong>.`,
      `A fatura foi <strong>retida</strong> (enforcement_hold=MANUAL_REVIEW) e não entra na régua de inadimplência.`,
      `Confira nos logs (<code>evt: asaas_invoice_reconcile_non_collectible_hold</code>) para o status exato antes de qualquer ação.`,
    ]),
  }),

  // ── Fase 6b: calendário e custo da instância Z-API ─────────────────────
  // Destinatário é SEMPRE platform_admin. O lojista não conhece o ciclo da
  // Z-API — para ele esse calendário não existe — e mandar o calendário do
  // FORNECEDOR para o cliente exporia custo interno.
  //
  // Texto deliberadamente genérico: TemplateData não carrega instância nem
  // data, e a spec §10.5 proíbe credencial, token, conteúdo de conversa e dado
  // pessoal no alerta. O detalhe fica no painel, que é a superfície viva
  // enquanto billing_notifications_dispatch está OFF.
  //
  // São SEIS entradas para os seis event_type de EVENT_TYPE_BY_ALERT em
  // _shared/whatsapp-instance-alerts-core.ts, que é a FONTE CANÔNICA. Custo
  // desconhecido NÃO tem entrada própria: ele é pendência exibida no painel
  // (ciclo em PENDING_REVIEW) e motivo do D-1, não aviso isolado.
  admin_zapi_cycle_d7: (d) => ({
    subject: `[interno] Instância Z-API vence em até 7 dias — ${d.orgName}`,
    text: `Uma instância de WhatsApp da organização ${d.orgName} tem cobrança do fornecedor prevista para os próximos 7 dias. Se ela não for mais necessária, cancele no painel da Z-API antes do vencimento — cancelar depois não devolve o ciclo já pago. Detalhes em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Instância Z-API vence em até 7 dias", [
      `Uma instância de WhatsApp da organização <strong>${d.orgName}</strong> tem cobrança do fornecedor prevista para os <strong>próximos 7 dias</strong>.`,
      `Se ela não for mais necessária, cancele no painel da Z-API <strong>antes</strong> do vencimento — cancelar depois não devolve o ciclo já pago.`,
      `Detalhes em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  admin_zapi_cycle_d1_action_required: (d) => ({
    subject: `[interno] Instância Z-API vence amanhã e tem pendência — ${d.orgName}`,
    text: `Uma instância de WhatsApp da organização ${d.orgName} vence amanhã e tem pendência registrada (custo desconhecido, divergência aberta, cancelamento não registrado ou receita indefinida). Verifique em Plataforma → Instâncias de WhatsApp antes do vencimento.`,
    html: wrapHtml("Instância Z-API vence amanhã e tem pendência", [
      `Uma instância de WhatsApp da organização <strong>${d.orgName}</strong> vence <strong>amanhã</strong> e tem pendência registrada.`,
      `Pode ser custo desconhecido, divergência aberta, cancelamento pretendido e não registrado, ou receita indefinida.`,
      `Verifique em <strong>Plataforma → Instâncias de WhatsApp</strong> antes do vencimento.`,
    ]),
  }),
  admin_zapi_end_confirmation_required: (d) => ({
    subject: `[interno] Confirme o encerramento da instância — ${d.orgName}`,
    text: `O prazo de acesso de uma instância cancelada da organização ${d.orgName} terminou. O sistema NÃO encerrou nada sozinho: confirme no painel do fornecedor se a instância realmente deixou de existir e registre a confirmação em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Confirme o encerramento da instância", [
      `O prazo de acesso de uma instância cancelada da organização <strong>${d.orgName}</strong> terminou.`,
      `O sistema <strong>não</strong> encerrou nada sozinho — afirmar um encerramento que o fornecedor não fez já custou caro neste projeto.`,
      `Confirme no painel do fornecedor e registre em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  admin_zapi_divergence: (d) => ({
    subject: `[interno] Divergência no inventário de instâncias — ${d.orgName}`,
    text: `Há divergência entre o inventário de instâncias e o estado registrado dos canais da organização ${d.orgName}. Nenhuma ação automática foi tomada e nenhum envio foi bloqueado. Revise em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Divergência no inventário de instâncias", [
      `Há divergência entre o inventário de instâncias e o estado registrado dos canais da organização <strong>${d.orgName}</strong>.`,
      `<strong>Nenhuma</strong> ação automática foi tomada e <strong>nenhum</strong> envio foi bloqueado.`,
      `Revise em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  // Instância com `cycle_source = UNKNOWN`. O texto NÃO afirma data nenhuma —
  // ele diz justamente que a data falta. Uma ocorrência por mês enquanto a
  // pendência durar, e o D-7 continua suprimido até a confirmação.
  admin_zapi_date_review_required: (d) => ({
    subject: `[interno] Instância sem data de cobrança confirmada — ${d.orgName}`,
    text: `Uma instância de WhatsApp da organização ${d.orgName} está sem data de cobrança confirmada. Enquanto isso, o sistema não emite o aviso de 7 dias para ela — nenhuma data é inventada. Confirme a data e o dia-âncora em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Instância sem data de cobrança confirmada", [
      `Uma instância de WhatsApp da organização <strong>${d.orgName}</strong> está <strong>sem data de cobrança confirmada</strong>.`,
      `Enquanto isso, o sistema <strong>não</strong> emite o aviso de 7 dias para ela — nenhuma data é inventada.`,
      `Confirme a data e o dia-âncora em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  admin_zapi_economic_imbalance: (d) => ({
    subject: `[interno] Custo de instâncias acima da receita — ${d.orgName}`,
    text: `O custo conhecido das instâncias de WhatsApp da organização ${d.orgName} está acima da receita atribuída. Isto é informação administrativa, não erro: cortesia vitalícia aparece assim por definição. Nada foi bloqueado. Avalie em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Custo de instâncias acima da receita", [
      `O custo conhecido das instâncias de WhatsApp da organização <strong>${d.orgName}</strong> está <strong>acima</strong> da receita atribuída.`,
      `Isto é informação administrativa, não erro — cortesia vitalícia aparece assim por definição. <strong>Nada foi bloqueado.</strong>`,
      `Avalie em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
};

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();

  // Gate: OFF = não envia; a fila acumula em 'pending' (seguro).
  if (!(await isFlagEnabled("billing_notifications_dispatch"))) {
    jsonLog("info", { reqId, evt: "billing_notifications_flag_off" });
    return new Response(JSON.stringify({ success: true, skipped: "flag_off" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  jsonLog("info", { reqId, evt: "billing_notifications_start" });

  try {
    const { data: pending, error: pendingErr } = await supabase
      .from("billing_notifications")
      .select("id, organization_id, event_type, recipient, invoice_id")
      .eq("status", "pending")
      .order("sent_at", { ascending: true })
      .limit(BATCH);

    if (pendingErr) {
      jsonLog("error", { reqId, evt: "billing_notifications_query_failed", err: pendingErr.message });
      return new Response(JSON.stringify({ success: false, error: "query_failed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;

    for (const row of pending ?? []) {
      const tmpl = TEMPLATE_BY_EVENT[row.event_type];
      if (!tmpl) {
        // Tipo desconhecido — marca failed pra não repetir eternamente.
        const { error: updErr } = await supabase
          .from("billing_notifications")
          .update({ status: "failed", error: "unknown_event_type" })
          .eq("id", row.id);
        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "billing_notification_status_write_failed",
            id: row.id,
            to: "failed",
            err: updErr.message,
          });
        }
        failed++;
        continue;
      }

      let amountCents = 0;
      let paymentUrl: string | null = null;
      if (row.invoice_id) {
        const { data: inv, error: invErr } = await supabase
          .from("billing_invoices")
          .select("amount_cents, hosted_invoice_url")
          .eq("id", row.invoice_id)
          .maybeSingle();
        if (invErr) {
          jsonLog("warn", {
            reqId,
            evt: "billing_notification_invoice_lookup_failed",
            id: row.id,
            invoice_id: row.invoice_id,
            err: invErr.message,
          });
          continue;
        }
        amountCents = (inv?.amount_cents as number | undefined) ?? 0;
        paymentUrl = (inv?.hosted_invoice_url as string | null | undefined) ?? null;
      }

      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", row.organization_id)
        .maybeSingle();

      if (orgErr) {
        jsonLog("warn", {
          reqId,
          evt: "billing_notification_org_lookup_failed",
          id: row.id,
          org: row.organization_id,
          err: orgErr.message,
        });
        continue;
      }

      const body = tmpl({
        orgName: (org?.name as string | undefined) ?? "cliente",
        amountBrl: formatBrl(amountCents),
        paymentUrl,
      });

      const result = await sendEmail({
        to: row.recipient,
        subject: body.subject,
        text: body.text,
        html: body.html,
      });

      if (result.ok) {
        const { error: updErr } = await supabase
          .from("billing_notifications")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", row.id);
        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "billing_notification_status_write_failed",
            id: row.id,
            to: "sent",
            err: updErr.message,
          });
        }
        sent++;
      } else if (result.skipped && (result.reason === "no_api_key" || result.reason === "no_from")) {
        // Config ausente — não é culpa da linha. Deixa 'pending' e para o lote.
        jsonLog("warn", { reqId, evt: "billing_notifications_no_config", reason: result.reason });
        break;
      } else {
        const err = result.skipped ? result.reason : result.error;
        const { error: updErr } = await supabase
          .from("billing_notifications")
          .update({ status: "failed", error: err })
          .eq("id", row.id);
        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "billing_notification_status_write_failed",
            id: row.id,
            to: "failed",
            err: updErr.message,
          });
        }
        failed++;
      }
    }

    jsonLog("info", { reqId, evt: "billing_notifications_done", sent, failed });
    return new Response(JSON.stringify({ success: true, sent, failed }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_notifications_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
