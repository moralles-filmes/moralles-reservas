// Aplicador de I/O dos efeitos de negócio decididos em asaas-billing-events.ts.
//
// Arquivo IRMÃO, não seção do mesmo arquivo: `npm run test -- asaas-billing-events`
// (Task 6, Step 2) provou que o import `https://esm.sh/@supabase/supabase-js` —
// mesmo só de tipo — quebra a resolução do Vite quando vive no MESMO módulo que
// o núcleo puro importado por src/lib/asaas-billing-events.test.ts ("Only URLs
// with a scheme in: file and data are supported by the default ESM loader").
// Mesmo particionamento que existe entre asaas-core.ts (puro) e asaas.ts (I/O)
// — razão de aquele par existir, replicada aqui.
//
// COMPARTILHADO por asaas-webhook e process-asaas-reconcile de propósito: os
// dois chamam `applyAsaasEvent` e não podem divergir na lógica de aplicação.
// NUNCA importado por src/.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ACTIVATING_EVENTS,
  decideEventEffect,
  parseExternalReference,
  type AsaasEffectKind,
  type AsaasPurpose,
} from "./asaas-billing-events.ts";
import { getBillingProvider } from "./billing-provider.ts";
import { asaasValueToCents, parseAsaasAmountCents, type AsaasAmountParse } from "./asaas-core.ts";
import { jsonLog } from "./security.ts";
import {
  resolveBillingRecipient,
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
} from "./billing-notify.ts";
import {
  resolveCorrelation,
  comparePreviousStamp,
  CORRELATION_RANK,
  type CorrelationCandidate,
} from "./billing-correlation-core.ts";
// `checkFlagEnabled`/`checkFlagString` (NÃO `isFlagEnabled`/`getFlagString`):
// uma leitura de flag que FALHA (DB indisponível) tem que virar `failed` (o
// evento fica na fila, o reconcile retenta), nunca "flag desligada" — Fix
// round 1 da Fase 5b. Ver o gate 4.1 e `decideIngestionHold` abaixo.
import { checkFlagEnabled, checkFlagString } from "./platform-flags.ts";

export interface BillingEventRow {
  id: string;
  provider_event_id: string;
  event_type: string;
  data: Record<string, unknown> | null;
  organization_id: string | null;
}

export interface ApplyResult {
  status: "processed" | "failed" | "ignored";
  organizationId: string | null;
  effect: AsaasEffectKind;
  error?: string;
}

/**
 * Opções do CALLER — não do aplicador. Cada chamador tem um orçamento de tempo
 * diferente e é ele quem sabe qual é o seu.
 *
 * `asaasIoBudgetMs`: teto de wall-clock pro I/O com a API do Asaas
 * (`getPayment`). O `asaas-webhook` passa um valor confortavelmente abaixo dos
 * 10s que o Asaas concede pra resposta (§2 de
 * docs/billing-asaas/03-ASAAS-API-VERIFICADO.md), deixando margem pro INSERT e
 * pelas demais escritas; estourar o teto vira `failed` (nunca `processed`), e o
 * reconcile retenta. O `process-asaas-reconcile` roda em cron, sem cliente
 * esperando, e OMITE o campo — mantendo os retries completos do cliente HTTP.
 *
 * NUNCA transformar isso em trabalho de background (`EdgeRuntime.waitUntil`):
 * uma continuação depois da resposta pode ser morta sem deixar ninguém pra
 * marcar a linha, trocando uma falha visível por uma silenciosa. Sob
 * degradação do Asaas a ativação atrasa até o reconcile — ruim, mas muito
 * melhor que interromper a fila de eventos de TODOS os clientes (15 timeouts
 * seguidos), que só se resolve manualmente.
 *
 * `recheckDurableEffect`: quando um evento ATIVADOR chega com a fatura já em
 * `paid`, `decideEventEffect` devolve `noop` e o aplicador retorna `processed`
 * de imediato. Isso é correto e barato no webhook — é assim que o par
 * `PAYMENT_CONFIRMED` + `PAYMENT_RECEIVED` do cartão fica idempotente sem gastar
 * um `getPayment` extra dentro dos 10s. Mas ESCONDE o envenenamento: a fatura
 * vira `paid` ANTES da ativação, então uma falha posterior (categoria do plano,
 * assinatura ambígua, RPC, confirmação da implantação) deixa o evento `failed`
 * com o dinheiro registrado — e todo reprocessamento futuro reencontra `paid` →
 * `noop` → `processed`, sem auto-cura e sem alerta. Com esta opção o aplicador
 * segue adiante nesse caso e refaz os caminhos de confirmação/ativação, que já
 * são idempotentes (UPDATE condicional `.eq('PENDING')` na implantação;
 * advisory lock + UNIQUE parcial na RPC). Custa um `getPayment`, por isso é do
 * CALLER: só quem não tem pressão de latência liga (cron de reconcile,
 * reprocessamento manual do admin). O `noop` por fatura `void` NUNCA é
 * re-checado — aquilo é anomalia que pede conferência humana, não duplicata
 * benigna.
 */
export interface ApplyOptions {
  asaasIoBudgetMs?: number;
  recheckDurableEffect?: boolean;
}

/** Espelha o CHECK de billing_subscriptions.payment_method (migration 20260528000000). */
type PaymentMethod = "card" | "pix" | "boleto";

const PAYMENT_METHOD_BY_BILLING_TYPE: Readonly<Record<string, PaymentMethod>> = {
  CREDIT_CARD: "card",
  PIX: "pix",
  BOLETO: "boleto",
};

/**
 * `billingType` do payload do Asaas → CHECK `card|pix|boleto`. ESTRITO: devolve
 * `null` para `UNDEFINED`/ausente em vez de chutar, porque o valor é lido por
 * humano no painel (`PAYMENT_METHOD_LABEL` em src/pages/platform/BillingDetail.tsx
 * e Billing.tsx) — chute vira informação errada na tela.
 *
 * O fallback `'card'` é aplicado SÓ no caminho de assinatura, onde ele é regra
 * de produto e não palpite: o checkout `RECURRENT` do Asaas recusa os outros
 * métodos (§13 da doc), então `UNDEFINED` ali só pode ter sido cartão. Em
 * cobrança avulsa (recarga de IA via PIX, por ex.) esse fallback seria falso,
 * e a coluna de `billing_invoices` é nullable justamente para isso.
 */
function mapPaymentMethod(billingType: unknown): PaymentMethod | null {
  if (typeof billingType === "string") {
    return PAYMENT_METHOD_BY_BILLING_TYPE[billingType] ?? null;
  }
  return null;
}

/** Extrai o id do payment do envelope. Shape não é uniforme entre categorias (§3). */
function extractPaymentId(data: Record<string, unknown> | null): string | null {
  const payment = data?.payment;
  if (typeof payment === "string") return payment;
  if (payment && typeof payment === "object") {
    const id = (payment as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Falha ALTA: devolve `failed` para o evento continuar na fila e o reconcile
 * reprocessar. Nunca vaza `error.message` do Postgres pro chamador — o detalhe
 * vai pro jsonLog.
 */
function failWith(
  organizationId: string | null,
  effect: AsaasEffectKind,
  step: string,
  detail: unknown,
  clientMessage: string,
): ApplyResult {
  jsonLog("error", {
    evt: "asaas_apply_write_failed",
    step,
    organization_id: organizationId,
    effect,
    error: String(detail),
  });
  return { status: "failed", organizationId, effect, error: clientMessage };
}

/**
 * Confirma a implantação paga pelo checkout do Asaas.
 *
 * IDEMPOTENTE por UPDATE condicional em `payment_status = 'PENDING'`: o cartão
 * emite PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED (até ~30 dias), e o
 * reconcile pode reprocessar a mesma linha. Só a execução que de fato mudou a
 * linha enfileira o aviso — `.select("id")` é o que distingue "eu mudei" de
 * "já estava assim".
 *
 * `.eq('PENDING')` e não `.neq('CONFIRMED')`: a matriz origem×pagamento só
 * admite PENDING→CONFIRMED para origin='ASAAS', e um `.neq` também casaria
 * linhas CANCELED ou estornadas.
 *
 * DUAS naturezas, dois tratamentos: o UPDATE é o EFEITO (erro dele volta como
 * `{ok:false}` e o caller degrada o evento pra `failed`, pra ele voltar na fila
 * do reconcile); o aviso é ACESSÓRIO (best-effort, contido no try/catch daqui —
 * falha ao resolver destinatário NUNCA derruba a confirmação financeira, mesma
 * filosofia do enqueue de `regularized`).
 */
async function confirmImplementationPayment(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    checkoutSessionId: string | null;
    invoiceId: string | null;
    paidValueCents: number | null;
    paymentMethod: string | null;
  },
): Promise<{ ok: boolean; error?: unknown }> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    payment_status: "CONFIRMED",
    paid_at: nowIso,
  };
  if (args.invoiceId) patch.billing_invoice_id = args.invoiceId;
  if (args.paidValueCents !== null) patch.amount_cents = args.paidValueCents;
  if (args.paymentMethod) patch.payment_method = args.paymentMethod;

  let query = supabase
    .from("whatsapp_implementations")
    .update(patch)
    .eq("origin", "ASAAS")
    .eq("payment_status", "PENDING");

  // Correlação precisa quando temos o checkout; senão cai na organização, que é
  // suficiente porque só existe UMA implantação aberta por org (UNIQUE parcial).
  query = args.checkoutSessionId
    ? query.eq("provider_checkout_id", args.checkoutSessionId)
    : query.eq("organization_id", args.organizationId);

  const { data: updated, error } = await query.select("id");

  if (error) {
    // NÃO loga aqui: o caller chama `failWith`, que já emite
    // `asaas_apply_write_failed` com `step:"confirm_implementation_payment"`,
    // a org e o detalhe do erro. Duas linhas pro mesmo fato só polui.
    return { ok: false, error };
  }
  if (!updated || updated.length === 0) {
    // Duplicata benigna (2º evento do cartão), re-checagem do reconcile sobre
    // linha já CONFIRMED, ou pagamento de implantação sem linha correspondente.
    // Log em info: não é erro, mas precisa ser visível.
    jsonLog("info", {
      evt: "implementation_confirm_noop",
      organization_id: args.organizationId,
      checkout: args.checkoutSessionId,
    });
    return { ok: true };
  }

  jsonLog("info", {
    evt: "implementation_confirmed",
    organization_id: args.organizationId,
    implementation_id: updated[0].id,
  });

  // O UPDATE acima já commitou — o dinheiro está durável e o pagamento, real.
  // A partir daqui é aviso acessório: qualquer exceção (não só `error` de
  // campo) fica CONTIDA aqui e nunca sobe para o try/catch de applyAsaasEvent,
  // que devolveria `failed` para um evento cujo efeito já foi aplicado de
  // verdade — mentira que o próprio invariante do arquivo proíbe (`processed`
  // ⇔ efeito aplicado; `failed` ⇔ não aplicado).
  try {
    // UMA linha só: o UNIQUE (organization_id, event_type, invoice_id) deduplica,
    // e sendEmail aceita um único `to`. Enfileirar uma por admin faria N-1
    // desaparecerem em 23505 silencioso — por isso `resolvePlatformAdminRecipients`
    // devolve no máximo um (o admin mais antigo com e-mail utilizável) e para de
    // buscar ali mesmo; quem loga a escolha é ela.
    const recipients = await resolvePlatformAdminRecipients(supabase);
    if (recipients.length === 0) return { ok: true };
    await enqueueBillingNotification(supabase, {
      organizationId: args.organizationId,
      eventType: "implementation_paid",
      invoiceId: args.invoiceId,
      recipient: recipients[0],
    });
  } catch (err) {
    jsonLog("error", {
      evt: "implementation_notify_unexpected_error",
      organization_id: args.organizationId,
      error: String(err),
    });
  }

  return { ok: true };
}

/**
 * Avisa a Moralles (não o cliente) de que um evento precisa de conferência
 * humana. Duas chamadas hoje, discriminadas por `args.eventType` (Fix round 1,
 * achado Important #2 generalizou de um único evento fixo para isto):
 * `admin_correlation_ambiguity` — organização divergente ENTRE degraus da
 * escada NA MESMA passagem (`resolveCorrelation` devolveu `kind: "conflict"`);
 * `admin_correlation_org_restamped` — organização divergente entre o carimbo
 * de uma passagem ANTERIOR e a resolução DESTA passagem
 * (`comparePreviousStamp` !== `MATCH`). São famílias diferentes de anomalia —
 * "duas fontes brigando agora" vs. "carimbo histórico corrigido/sinalizado" —
 * por isso `eventType` (e o template correspondente em
 * `TEMPLATE_BY_EVENT`) são distintos, não um único aviso genérico.
 *
 * Best-effort: NUNCA derruba o resultado financeiro que chamou esta função —
 * mesma filosofia de `confirmImplementationPayment`.
 *
 * Usa `resolvePlatformAdminRecipients`, e não `resolveBillingRecipient`, que é
 * org-scoped de propósito: aqui o destinatário é a própria plataforma.
 *
 * `enqueueBillingNotification` exige `organizationId: string` —
 * `billing_notifications.organization_id` é `not null` (migration
 * 20260528000000_billing_module.sql). Quando o evento já chegou com uma
 * organização carimbada em `row.organization_id` (o caso comum: a org
 * resolvida numa passagem anterior e um degrau novo divergindo dela), a
 * notificação usa essa organização como ENDEREÇO de conveniência — o
 * destinatário continua sendo a plataforma, nunca o cliente daquela org, e o
 * `notification_enqueued` no log deixa isso auditável. Quando não há
 * organização nenhuma carimbada, a notificação é PULADA (não dá pra gravar
 * uma linha sem violar o NOT NULL) e o `jsonLog` abaixo é a ÚNICA fonte de
 * verdade sobre quantas vezes isto aconteceu — `invoiceId: null` também não é
 * deduplicado pelo índice parcial, então o log é quem conta.
 */
async function notifyAdminCorrelationAmbiguity(
  supabase: SupabaseClient,
  args: { billingEventId: string; detail: string; organizationId: string | null; eventType: string },
): Promise<void> {
  try {
    const orgId = args.organizationId;
    jsonLog("error", {
      evt: "asaas_correlation_ambiguity",
      billing_event_id: args.billingEventId,
      event_type: args.eventType,
      detail: args.detail,
      organization_id: orgId,
      notification_enqueued: !!orgId,
    });
    // Guard antes do uso — não cast: `enqueueBillingNotification` exige
    // `organizationId: string`, e este `if` é o que estreita `orgId` de
    // `string | null` pra `string` no resto da função.
    if (!orgId) return;
    const recipients = await resolvePlatformAdminRecipients(supabase);
    if (recipients.length === 0) return;
    await enqueueBillingNotification(supabase, {
      organizationId: orgId,
      eventType: args.eventType,
      invoiceId: null,
      recipient: recipients[0],
    });
  } catch (err) {
    jsonLog("warn", { evt: "asaas_correlation_ambiguity_notify_failed", err: String(err) });
  }
}

/** Resultado de `decideIngestionHold` — ver função abaixo. */
type IngestionHoldDecision =
  | { ok: true; hold: boolean; reason: string | null }
  | { ok: false };

/**
 * Decide se a fatura entra retida. RETENÇÃO É EXCEPCIONAL: fatura encontrada
 * tarde por falha temporária de webhook preserva vencimento e tolerância reais
 * — retê-la converteria em atraso justamente o conserto que a reconciliação
 * existe para fazer.
 *
 * Só dois motivos automáticos aqui: backfill declarado pelo caller, e cobrança
 * anterior ao go-live da ingestão. `VALUE_MISMATCH` e `CORRELATION_AMBIGUITY`
 * são retenções de OUTROS pontos do fluxo, não desta função.
 *
 * `ok: false` (Fix round 1) é a leitura de `billing_invoice_ingestion_since`
 * tendo FALHADO (DB indisponível) — `checkFlagString` distingue isso de
 * "flag vazia de verdade". Colapsar os dois em "sem retenção" desligaria a
 * proteção pré-go-live justo na janela em que ela mais importa (cobrança
 * antiga encontrada pela primeira reconciliação). O caller DEVE tratar
 * `ok:false` como falha do evento (`failed`), nunca como "não reter".
 */
async function decideIngestionHold(
  args: { dueDate: string; source: "WEBHOOK" | "RECONCILE" | "BACKFILL" },
): Promise<IngestionHoldDecision> {
  if (args.source === "BACKFILL") return { ok: true, hold: true, reason: "INITIAL_BACKFILL" };

  const since = await checkFlagString("billing_invoice_ingestion_since", "");
  if (since.readFailed) {
    return { ok: false };
  }
  if (since.value && args.dueDate < since.value) {
    return { ok: true, hold: true, reason: "PRE_GO_LIVE_INVOICE" };
  }
  return { ok: true, hold: false, reason: null };
}

/**
 * Aplica o efeito de negócio de um evento Asaas já persistido.
 *
 * NUNCA lança: todo caminho de erro vira `{status:'failed'}`, porque o webhook
 * precisa responder 200 (a linha já está durável e o reconcile reprocessa) e o
 * reconcile precisa continuar o lote.
 *
 * INVARIANTE: `processed` significa "o efeito foi aplicado de verdade". Toda
 * escrita que é pré-requisito do resultado tem o `error` checado e degrada para
 * `failed` — senão um UPDATE que falhou por timeout tira o evento da fila e
 * deixa o cliente que pagou bloqueado, sem rastro.
 */
export async function applyAsaasEvent(
  supabase: SupabaseClient,
  row: BillingEventRow,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  try {
    const paymentId = extractPaymentId(row.data);

    // 1. Buscar a invoice que já conhecemos deste pagamento, se houver.
    let invoice: {
      id: string;
      status: string;
      organization_id: string;
      billing_subscription_id: string | null;
      amount_cents: number;
    } | null = null;

    if (paymentId) {
      // `error` checado: um erro aqui devolveria `data:null`, que o código
      // abaixo leria como "invoice não existe" e criaria uma segunda linha —
      // exatamente o que a idempotência do 2º evento do cartão depende de não
      // acontecer.
      const { data, error } = await supabase
        .from("billing_invoices")
        .select("id, status, organization_id, billing_subscription_id, amount_cents")
        .eq("provider", "asaas")
        .eq("provider_payment_id", paymentId)
        .maybeSingle();
      if (error) {
        return failWith(
          row.organization_id,
          "unknown",
          "select_invoice",
          error,
          "Falha ao consultar a fatura do evento — ver logs.",
        );
      }
      invoice = data ?? null;
    }

    // 2. Decidir o efeito (puro). ANTECIPADO de propósito para antes do I/O do
    //    Asaas: `decideEventEffect` só depende de `row.event_type` e do status
    //    da invoice, ambos já em mãos aqui. Ter o efeito antes do `getPayment`
    //    é o que permite graduar a severidade de uma falha daquela chamada —
    //    sem isso, todo erro do Asaas teria que ser tratado igual.
    //
    //    NÃO passa status de assinatura — `decideEventEffect` não branchia
    //    nele (removido do input na revisão da Task 5).
    const effect = decideEventEffect({
      eventType: row.event_type,
      invoiceStatus: invoice?.status ?? null,
    });

    // 3. Resolver a organização. Ordem real de precedência: coluna
    //    `organization_id` da própria linha do evento → invoice já conhecida →
    //    externalReference do payment → customer Asaas.
    let organizationId = row.organization_id ?? invoice?.organization_id ?? null;
    let planId: string | null = null;
    // Default deliberado: sem externalReference legível, tratamos como
    // "other" — que NÃO concede acesso. Errar para o lado de não liberar.
    let purpose: AsaasPurpose = "other";
    let externalReferenceRaw: string | null = null;
    let paidValueCents: number | null = null;
    // Resultado TIPADO do parse de `payment.value` (Fix round 1) — usado só
    // por `upsert_open_invoice`. DELIBERADAMENTE separado de `paidValueCents`
    // acima: aquela variável já é consumida pelo caminho `activate_subscription`
    // (verificado e correto — ver `case "activate_subscription"`) e este fix
    // não reescreve código já certo. `paymentAmountParse` existe porque
    // `paidValueCents: number | null` colapsa "ausente" e "inválido" no mesmo
    // `null` sem dizer qual — e é exatamente essa ambiguidade que motivou o
    // achado: sem ela, `upsert_open_invoice` fazia `paidValueCents ?? 0`,
    // tratando "não consegui ler o valor" como "cobrança de R$ 0,00".
    let paymentAmountParse: AsaasAmountParse | null = null;
    // `dueDate` (YYYY-MM-DD) do payload do getPayment — usado só por
    // `upsert_open_invoice` (due_date da fatura e insumo de `decideIngestionHold`),
    // mas extraído aqui ao lado de `paidValueCents` porque os dois vêm do
    // MESMO payload, no mesmo bloco de enriquecimento abaixo.
    let paymentDueDate: string | null = null;
    let paymentMethod: PaymentMethod | null = null;
    let providerSubscriptionId: string | null = null;
    let checkoutSessionId: string | null = null;
    // id INTERNO de billing_subscriptions (não o `sub_…` do provedor, que
    // continua em `providerSubscriptionId`). Alimenta o `billing_subscription_id`
    // que a fatura paga carrega quando a correlação resolve por assinatura.
    let resolvedSubscriptionId: string | null = null;

    // 4. PORTÕES de noop/unknown — ANTES de qualquer I/O com o Asaas.
    //
    //    ~31 dos 40 eventos do catálogo são informativos. Consultar `getPayment`
    //    pra depois descartar o payload inteiro paga um round-trip por evento:
    //    multiplica o consumo da quota (25k req/12h, §10) e — pior — coloca
    //    latência de rede no caminho crítico de eventos que não produzem
    //    efeito nenhum, que é o multiplicador direto do risco de estourar os
    //    10s de resposta.
    //
    //    CUSTO CONHECIDO E ACEITO: linha `noop` sem invoice correlacionada
    //    deixa de ter `organization_id` carimbado (o SELECT do passo 1 é DB
    //    barato e continua resolvendo as demais). Verificado que nenhum
    //    consumidor depende disso — `billing_events.organization_id` não é
    //    lido por src/ nem pelo process-asaas-reconcile; só existe o índice
    //    `billing_events_org_idx`. Consumidor NOVO dessa coluna precisa saber
    //    que ela é esparsa em linhas informativas.
    if (effect.kind === "unknown") {
      // NÃO usa `error`: o webhook grava esse campo em `billing_events.
      // error_message`, e "evento fora do catálogo" é diagnóstico, não erro —
      // carimbá-lo ali faria uma linha saudável parecer quebrada pro operador.
      // Inalcançável pelo webhook (os catálogos batem), mas alcançável pelo
      // reconcile. O motivo vai pro log.
      jsonLog("info", {
        evt: "asaas_apply_unknown_effect",
        billing_event_id: row.id,
        event_type: row.event_type,
        reason: effect.reason,
      });
      return { status: "ignored", organizationId, effect: effect.kind };
    }

    // 4.1. Gate de flag do `upsert_open_invoice`, MOVIDO pra antes do
    //      `getPayment` (Fase 5b). `PAYMENT_CREATED` dispara em TODA
    //      cobrança — é o evento mais frequente do catálogo — e desde que ele
    //      deixou de classificar como `noop` (obrigação 4 do JSDoc de
    //      `decideEventEffect`), o portão de "noop" logo abaixo não o
    //      intercepta mais. Sem ESTE gate aqui, desligar a flag deixaria de
    //      ser grátis: cada `PAYMENT_CREATED` pagaria um `getPayment` completo
    //      só para o `case` do switch descartá-lo depois — exatamente o custo
    //      que o comentário acima descreve, reintroduzido pela porta dos
    //      fundos. Com a flag OFF (default até o go-live), este `return`
    //      reproduz OS MESMOS `status`/`organizationId`/`effect` que o antigo
    //      `noop` de `PAYMENT_CREATED` devolvia.
    //
    //      `checkFlagEnabled` (Fix round 1), NÃO `isFlagEnabled`: uma leitura
    //      que FALHA (DB fora do ar) devolve `enabled:false` de qualquer jeito
    //      em `isFlagEnabled` — indistinguível de "flag OFF de verdade". Com a
    //      ingestão LIGADA, isso faria um soluço transitório do banco virar
    //      `processed` (sai da fila) sem nunca ter criado a fatura, e nada
    //      revisita `processed` depois — é o buraco que esta fase existe pra
    //      fechar. Falha de leitura tem que virar `failed`: o evento fica na
    //      fila e o `process-asaas-reconcile` tenta de novo.
    if (effect.kind === "upsert_open_invoice") {
      const ingestionCheck = await checkFlagEnabled("billing_invoice_ingestion");
      if (ingestionCheck.readFailed) {
        return failWith(
          organizationId,
          effect.kind,
          "upsert_open_invoice_flag_read_failed",
          "falha ao ler a flag billing_invoice_ingestion",
          "Falha ao verificar configuração de cobrança — ver logs.",
        );
      }
      if (!ingestionCheck.enabled) {
        jsonLog("info", { evt: "asaas_invoice_ingestion_disabled", billing_event_id: row.id });
        return { status: "processed", organizationId, effect: effect.kind };
      }
    }
    // `noop` de evento ATIVADOR sobre fatura já `paid` é o único que pode estar
    // escondendo efeito durável não aplicado (a fatura é escrita ANTES da
    // ativação, de propósito — o dinheiro primeiro). `void` fica de fora: é
    // anomalia pra conferência humana, reprocessar seria pior. Informativo
    // (`PAYMENT_CREATED` & cia.) e `PAYMENT_OVERDUE` também ficam de fora — não
    // há efeito de ativação por trás deles.
    const noopOverPaidInvoice =
      effect.kind === "noop" &&
      ACTIVATING_EVENTS.has(row.event_type) &&
      invoice?.status === "paid";
    const rechecking = noopOverPaidInvoice && opts.recheckDurableEffect === true;

    if (effect.kind === "noop" && !rechecking) {
      if (noopOverPaidInvoice) {
        // Caminho por onde um pagamento sem efeito escapa quando o caller não
        // pede re-checagem (webhook). Mudo até aqui — logar é o que permite
        // enxergar a duplicata benigna do cartão E o evento envenenado.
        jsonLog("info", {
          evt: "asaas_paid_invoice_noop",
          billing_event_id: row.id,
          event_type: row.event_type,
        });
      }
      return { status: "processed", organizationId, effect: effect.kind };
    }

    // Efeito EXECUTADO daqui pra baixo. Na re-checagem seguimos o roteiro de
    // ativação (idempotente ponta a ponta) apesar de `decideEventEffect` ter
    // dito `noop` — e é este valor, não `effect.kind`, que vai pros logs e pro
    // `ApplyResult`, porque é o que de fato foi tentado.
    const effectKind: AsaasEffectKind = rechecking ? "activate_subscription" : effect.kind;

    // Escada de correlação (Task 8): cada degrau abaixo empurra um candidato
    // num array; quem decide organização/assinatura/plano/purpose é
    // `resolveCorrelation`, chamado depois que todos os degraus alcançáveis
    // nesta passagem já contribuíram — nunca mais uma atribuição direta `??`
    // isolada por degrau.
    const candidates: CorrelationCandidate[] = [];

    // Degrau 1 — a fatura já conhecida deste pagamento (carregada no passo 1
    // da função). Traz tudo e é a fonte mais forte.
    if (invoice) {
      candidates.push({
        source: "known_invoice",
        organizationId: invoice.organization_id,
        subscriptionId: invoice.billing_subscription_id,
        planId: null,
        purpose: null,
      });
    }

    // 5. Enriquecer com o payload do Asaas — só para efeitos que de fato
    //    produzem escrita.
    if (paymentId) {
      const provider = getBillingProvider("asaas");
      // `asaasIoBudgetMs` corta tentativa/retry/sleep de rate limit lá no
      // cliente HTTP (asaas.ts). Estourar volta como `{ok:false}` — mesmo
      // shape de "Asaas indisponível" — e o branch abaixo já degrada pra
      // `failed`, que é o que mantém o evento na fila do reconcile.
      const res = await provider.getPayment(
        paymentId,
        opts.asaasIoBudgetMs !== undefined ? { budgetMs: opts.asaasIoBudgetMs } : undefined,
      );
      if (res.ok && res.data) {
        if (typeof res.data.externalReference === "string") {
          externalReferenceRaw = res.data.externalReference;
        }
        const parsed = parseExternalReference(res.data.externalReference);
        if (parsed) {
          // Degrau 3 — externalReference presente na cobrança direta (ausente
          // no checkout hospedado — ver Degrau 4 abaixo).
          candidates.push({
            source: "external_reference",
            organizationId: parsed.orgId,
            subscriptionId: null,
            planId: parsed.planId,
            purpose: parsed.purpose,
          });
        }

        paymentMethod = mapPaymentMethod(res.data.billingType);

        // §13.6: cobrança gerada por assinatura traz `subscription: "sub_…"`;
        // cobrança avulsa OMITE o campo (não vem `null`). Daí o typeof guard.
        const subRef = res.data.subscription;
        if (typeof subRef === "string" && subRef) {
          providerSubscriptionId = subRef;
        }

        // Degrau 2 — assinatura do provedor. É o ÚNICO elo que a renovação do
        // mês 2+ carrega: ela nasce da assinatura, sem externalReference (o
        // Asaas não propaga — §13.8), sem checkoutSession, e com um `customer`
        // que pode ser o que o pagador criou na página hospedada. Sem este
        // degrau, nenhuma renovação é processada.
        if (providerSubscriptionId) {
          const { data: sub, error: subErr } = await supabase
            .from("billing_subscriptions")
            .select("id, organization_id, billing_plan_id")
            .eq("provider", "asaas")
            .eq("provider_subscription_id", providerSubscriptionId)
            .maybeSingle();
          if (subErr) {
            return failWith(
              row.organization_id,
              "unknown",
              "select_subscription_by_provider_id",
              subErr,
              "Falha ao correlacionar a assinatura do evento — ver logs.",
            );
          }
          if (sub) {
            candidates.push({
              source: "provider_subscription",
              organizationId: sub.organization_id as string,
              subscriptionId: sub.id as string,
              planId: sub.billing_plan_id as string,
              // Cobrança nascida de assinatura é sempre mensalidade. O
              // `purpose` do checkout original não sobrevive à renovação, e
              // sem isto o evento cairia no default `other` e não ativaria
              // ninguém.
              purpose: "subscription",
            });
          } else {
            // Assinatura desconhecida: não é erro de leitura, é cobrança de
            // uma assinatura que este banco não conhece. Loga e segue para os
            // degraus seguintes — o reconcile pode resolver depois.
            jsonLog("warn", {
              evt: "asaas_unknown_provider_subscription",
              billing_event_id: row.id,
              provider_subscription_id: providerSubscriptionId,
            });
          }
        }

        // getPayment devolve payload CRU do Asaas: `value` é em REAIS.
        // Comparar com amount_cents sem converter é bug de 100x.
        // `asaasValueToCents` LANÇA em NaN/negativo e `typeof === "number"`
        // deixa NaN passar — sem este guard, um `value` corrompido derrubaria
        // o evento inteiro no catch genérico.
        const rawValue = res.data.value;
        if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue >= 0) {
          paidValueCents = asaasValueToCents(rawValue);
        } else {
          // Campo AUSENTE também loga: num PAYMENT_RECEIVED, `value` não vir é
          // anomalia de payload tão relevante quanto um NaN, e o silêncio
          // esconderia a causa do `missing_payment_value` logo adiante.
          jsonLog("warn", {
            evt: "asaas_payment_value_invalid",
            payment_id: paymentId,
            raw_value: rawValue === undefined ? "ausente" : String(rawValue),
          });
        }

        // Mesmo `rawValue`, resultado TIPADO (Fix round 1) — só pra
        // `upsert_open_invoice`. `parseAsaasAmountCents` distingue "ausente" de
        // "inválido" (o log acima não distinguia) e devolve zero explícito como
        // resultado válido em vez de colapsá-lo com "não sei". Ver o `case`
        // abaixo pra onde isso é consumido.
        paymentAmountParse = parseAsaasAmountCents(rawValue);

        // `dueDate` alimenta `billing_invoices.due_date` (efeito
        // `upsert_open_invoice`) e `decideIngestionHold`. Mesmo tratamento do
        // `value` acima: ausente/tipo errado loga e segue — não é fatal para
        // efeitos que não precisam dele.
        const rawDueDate = res.data.dueDate;
        if (typeof rawDueDate === "string" && rawDueDate) {
          paymentDueDate = rawDueDate;
        } else {
          jsonLog("warn", {
            evt: "asaas_payment_due_date_invalid",
            payment_id: paymentId,
            raw_due_date: rawDueDate === undefined ? "ausente" : String(rawDueDate),
          });
        }

        if (!organizationId) {
          const customerRef = res.data.customer;
          if (typeof customerRef === "string" && customerRef) {
            const { data: cust, error: custErr } = await supabase
              .from("billing_customers")
              .select("organization_id")
              .eq("asaas_customer_id", customerRef)
              .maybeSingle();
            if (custErr) {
              return failWith(
                null,
                "unknown",
                "select_customer_by_asaas_id",
                custErr,
                "Falha ao correlacionar o cliente do evento — ver logs.",
              );
            }
            // Degrau 5 — cliente do provedor. Resolve só a organização; no
            // checkout hospedado o pagador gera um cliente NOVO, então nem
            // sempre resolve.
            if (cust?.organization_id) {
              candidates.push({
                source: "billing_customer",
                organizationId: cust.organization_id as string,
                subscriptionId: null,
                planId: null,
                purpose: null,
              });
            }
          }
        }

        // Terceiro fallback: checkout hospedado. Verificado ao vivo (§13.7) que o
        // Asaas NÃO propaga o externalReference do checkout para a assinatura NEM
        // para a cobrança (ambas nascem com externalReference=null), e o pagador
        // digita os dados na página gerando um customer NOVO — então nem o
        // externalReference (acima) nem o customer resolvem a org. O elo que
        // sobrevive é o `checkoutSession` (id do checkout que a
        // create-billing-checkout criou), presente na cobrança E na assinatura.
        // Mapeamos esse id → org na criação (billing_checkout_sessions) e
        // reidratamos org+plano+purpose aqui como Degrau 4.
        //
        // ESCOPO 4a (1ª cobrança/ativação): a renovação do mês 2+ NÃO carrega
        // checkoutSession (a cobrança nasce da assinatura, não do checkout) — a
        // correlação dela é pelo Degrau 2 (provider_subscription) acima.
        const checkoutRef = res.data.checkoutSession;
        if (typeof checkoutRef === "string" && checkoutRef) {
          checkoutSessionId = checkoutRef;
        }

        // A condição NÃO é `!organizationId` — e isso é o ponto. No checkout
        // hospedado esta é a ÚNICA fonte de `purpose` e `planId` (o payment vem
        // sem externalReference), e no REPROCESSAMENTO a org já chega carimbada:
        // o asaas-webhook grava `billing_events.organization_id` mesmo quando o
        // evento sai `failed`, e o process-asaas-reconcile repassa esse valor.
        // Gatear por `!organizationId` fazia a segunda passagem pular a
        // reidratação, terminar com purpose "other" + planId null e sair
        // `processed` sem ativar nada — e ainda registrar a fatura sem vínculo
        // de plano, que é o que faz `isSystemInvoice` (billing-category.ts) cair
        // no caminho de compatibilidade e devolver `true` para uma cobrança de
        // implantação.
        //
        // [Fix round 1, achado Minor] O resto da condição original virou
        // TAUTOLOGIA depois da escada de correlação (Task 8): `planId` e
        // `purpose` neste ponto do fluxo são SEMPRE os valores PRÉ-escada —
        // `null` e `"other"` — porque este trecho não os atribui mais direto
        // (só empurra candidato pra `resolveCorrelation`, que decide bem mais
        // abaixo). `!planId` e `purpose === "other"` são portanto sempre
        // verdadeiros aqui, o que torna o `||` inteiro sempre verdadeiro
        // independente de `organizationId`. O gate não estreita mais nada: a
        // reidratação é INCONDICIONAL para todo evento com `checkoutSessionId`.
        // Isso é inofensivo — mais um candidato (Degrau 4) pra escada, cobertura
        // de conflito mais ampla — mas fingir que ainda discrimina seria pior
        // que admitir que não discrimina.
        if (checkoutSessionId) {
          const { data: sess, error: sessErr } = await supabase
            .from("billing_checkout_sessions")
            .select("organization_id, external_reference")
            .eq("provider_checkout_id", checkoutSessionId)
            .maybeSingle();
          if (sessErr) {
            // Passa a org JÁ resolvida (não `null`): o caller carimba
            // `billing_events.organization_id` com este valor, e devolver null
            // apagaria uma correlação que já tínhamos.
            return failWith(
              organizationId,
              "unknown",
              "select_checkout_session",
              sessErr,
              "Falha ao correlacionar o checkout do evento — ver logs.",
            );
          }
          if (sess) {
            // Reidrata plano+purpose porque no checkout hospedado o payment
            // vem SEM externalReference — sem isso planId fica null e purpose
            // "other", o gate purpose!=="subscription" dá break antes de
            // ativar e o INSERT de assinatura não teria billing_plan_id.
            // `externalReferenceRaw` não é campo de `CorrelationCandidate` —
            // segue como atribuição direta, preservando o valor mais forte já
            // capturado acima.
            externalReferenceRaw = externalReferenceRaw ?? sess.external_reference;
            const parsedSess = parseExternalReference(sess.external_reference);
            // Degrau 4 — sessão de checkout. Divergência de organização entre
            // este degrau e os demais não é mais um log isolado: vira
            // `conflict` em `resolveCorrelation`, tratado logo abaixo.
            candidates.push({
              source: "checkout_session",
              organizationId: (sess.organization_id as string | null) ?? null,
              subscriptionId: null,
              planId: parsedSess?.planId ?? null,
              purpose: parsedSess?.purpose ?? null,
            });
          }
        }
      } else if (effectKind === "activate_subscription") {
        // Indisponibilidade do Asaas (rede, 5xx, token expirado) NÃO pode virar
        // `processed`. Sem o payload, `purpose` fica no default "other",
        // `paidValueCents` e `planId` ficam `null` — e o `purpose !==
        // "subscription"` mais abaixo daria `break` ANTES de ativar a
        // assinatura e antes de tocar `organizations.billing_status`. O evento
        // sairia da fila com o cliente pago e bloqueado, sem rastro.
        //
        // Sem invoice prévia é pior: o INSERT gravaria `amount_cents` errado e
        // `purpose:'other'` sob o UNIQUE (provider, provider_payment_id), e
        // qualquer reprocessamento futuro reencontraria `status='paid'` →
        // `noop` → `processed`. Envenenamento permanente, sem auto-cura.
        //
        // Falha SÓ neste efeito: só a ativação depende do payload. Derrubar
        // também um `PAYMENT_CREATED` informativo (ou um `PAYMENT_OVERDUE`,
        // que não lê nada do payment) transformaria ruído em `failed` e
        // inflaria a fila do reconcile à toa.
        return failWith(
          organizationId,
          effectKind,
          "get_payment",
          res.error ?? "getPayment devolveu ok sem data",
          "Falha ao consultar o pagamento no Asaas — ver logs.",
        );
      }
    }

    // 5.5. Decidir a correlação com o núcleo puro, agora que todos os degraus
    //      alcançáveis nesta passagem já empurraram seus candidatos.
    const correlation = resolveCorrelation(candidates);

    if (correlation.kind === "conflict") {
      // Divergência de ORGANIZAÇÃO entre degraus. Escrever no tenant errado é
      // pior que atrasar um pagamento: o evento fica na fila, o reconcile
      // retenta, e um humano resolve.
      await notifyAdminCorrelationAmbiguity(supabase, {
        billingEventId: row.id,
        detail: correlation.sources.map((s) => `${s.source}=${s.organizationId}`).join(" / "),
        organizationId: row.organization_id,
        eventType: "admin_correlation_ambiguity",
      });
      return failWith(
        row.organization_id,
        effectKind,
        "organization_divergence",
        correlation.sources.map((s) => `${s.source}:${s.organizationId}`).join(","),
        "Evento correlacionado a organizações divergentes — requer conferência.",
      );
    }

    // 5.6. Detector de carimbo divergente (Fix round 1, achado Important #2).
    //
    // `organizationId` foi semeado (passo 3) de `row.organization_id ??
    // invoice?.organization_id`, mas só a invoice virou candidato (Degrau 1) —
    // o carimbo BRUTO de `row.organization_id` nunca participa da escada. Numa
    // REPROCESSAGEM em que o evento já tinha carimbo da org X (gravado pelo
    // UPDATE de uma passagem anterior — `asaas-webhook` sempre insere com
    // `organization_id: null`, é o aplicador que resolve e o caller que
    // carimba de volta) e a escada resolve org Y nesta passagem, sobrescrever
    // `organizationId` sem levantar nada trocaria de tenant em silêncio.
    //
    // `comparePreviousStamp` é a fonte única desta regra (testada em
    // src/lib/billing-correlation-core.test.ts — o único CI que alcança esta
    // camada). O carimbo NUNCA vira candidato nem desempata `conflict` (que já
    // retornou acima); ele só DETECTA divergência depois que a escada decidiu.
    // `previousSource` fica sempre `undefined` — não persistimos qual degrau
    // produziu o carimbo anterior (ver JSDoc do helper).
    const previousStamp = comparePreviousStamp(row.organization_id, correlation);

    if (previousStamp.status !== "MATCH") {
      // `winningSource`/`winningRank` só existem quando a escada resolveu
      // ALGUMA organização nesta passagem — em `unresolved` ficam `null`.
      const winningSource = correlation.kind === "resolved" ? correlation.via[0] : null;
      // Log RICO e dedicado (distinto do `asaas_correlation_ambiguity` interno
      // de `notifyAdminCorrelationAmbiguity`, que só registra a tentativa de
      // aviso): carrega só ids/enums/ranks — nenhum token, segredo, payload
      // financeiro completo ou dado pessoal.
      jsonLog("error", {
        evt: "asaas_previous_stamp_divergence",
        billing_event_id: row.id,
        provider_event_id: row.provider_event_id,
        previous_organization_id: previousStamp.previousOrganizationId,
        resolved_organization_id: previousStamp.resolvedOrganizationId ?? null,
        // Sempre `null` hoje — ver JSDoc de `comparePreviousStamp`.
        previous_source: null,
        winning_source: winningSource,
        winning_rank: winningSource ? CORRELATION_RANK[winningSource] : null,
        purpose: correlation.kind === "resolved" ? correlation.purpose : null,
        subscription_id: correlation.kind === "resolved" ? correlation.subscriptionId : null,
        comparison_status: previousStamp.status,
      });

      await notifyAdminCorrelationAmbiguity(supabase, {
        billingEventId: row.id,
        detail: `carimbo_anterior=${previousStamp.previousOrganizationId} resolvido_agora=${previousStamp.resolvedOrganizationId ?? "nenhum"} status=${previousStamp.status}`,
        organizationId: row.organization_id,
        eventType: "admin_correlation_org_restamped",
      });
    }

    // Aplica o resultado da escada quando ela resolveu E o detector de
    // carimbo não pediu revisão. `DIVERGENT_REQUIRES_REVIEW` cobre dois
    // sub-casos: `unresolved` (o `if` abaixo já não entraria de qualquer
    // forma, já que `correlation.kind !== "resolved"`) e — hoje inalcançável,
    // porque `previousSource` nunca chega preenchido — `resolved` com carimbo
    // anterior de rank superior. O `&&` extra é o que mantém este segundo
    // sub-caso seguro no dia em que a fonte anterior passar a ser persistida:
    // sem ele, o código aplicaria a resolução mais fraca sozinho assim que
    // `previousSource` deixasse de ser sempre `undefined`.
    if (correlation.kind === "resolved" && previousStamp.status !== "DIVERGENT_REQUIRES_REVIEW") {
      organizationId = correlation.organizationId;
      resolvedSubscriptionId = correlation.subscriptionId;
      planId = correlation.planId;
      if (correlation.purpose) purpose = correlation.purpose;

      if (correlation.softDivergence.length > 0) {
        // Plano ou propósito discordando entre degraus NÃO é fatal — o degrau
        // superior vence. Mas é anomalia que precisa aparecer: um plano
        // trocado entre a criação da sessão e o pagamento é legítimo; dois
        // planos aleatoriamente diferentes não são.
        jsonLog("warn", {
          evt: "asaas_correlation_soft_divergence",
          billing_event_id: row.id,
          sources: correlation.softDivergence,
          resolved_plan: planId,
          resolved_purpose: purpose,
        });
      }
    }
    // `correlation.kind === "unresolved"` (ou `resolved` bloqueado por
    // `DIVERGENT_REQUIRES_REVIEW`) não faz nada aqui: organizationId/planId/
    // purpose mantêm os valores PRÉ-escada (row.organization_id ??
    // invoice?.organization_id, e os defaults null/"other") — o carimbo NÃO É
    // APAGADO, só não é reafirmado por uma escada que não conseguiu confirmá-lo
    // com a mesma força desta vez. Mesmo comportamento de fallback que o
    // código já tinha para `unresolved` antes deste fix.

    // 6. Categoria do plano do PAGAMENTO e a assinatura correspondente.
    //
    // O código antigo perguntava "qual é a assinatura desta organização?" com
    // maybeSingle(). A partir da Fase 5a uma org pode ter DUAS (sistema R$449 +
    // instância R$149) e aquela pergunta não tem resposta única — devolvia
    // PGRST116 e o pagamento falhava. A pergunta certa é "qual é a assinatura
    // desta organização NA CATEGORIA deste plano?".
    let planCategory: string | null = null;
    if (planId) {
      const { data: planRow, error: planErr } = await supabase
        .from("billing_plans")
        .select("category")
        .eq("id", planId)
        .maybeSingle();
      if (planErr) {
        return failWith(
          organizationId,
          effectKind,
          "select_plan_category",
          planErr,
          "Falha ao consultar a categoria do plano — ver logs.",
        );
      }
      planCategory = (planRow?.category as string | undefined) ?? null;
    }

    // Só serve para carimbar billing_subscription_id na fatura. A ativação em si
    // é feita pela RPC mais abaixo, que é quem tem o lock.
    let subscription: { id: string; status: string } | null = null;
    if (organizationId && planCategory) {
      // `.select()` de lista (não maybeSingle): ambiguidade aqui precisa ser
      // detectada, não convertida em null. Duas assinaturas vivas na mesma
      // categoria é estado inválido, e escolher uma em silêncio carimbaria a
      // fatura na assinatura errada.
      const { data, error } = await supabase
        .from("billing_subscriptions")
        .select("id, status, billing_plans!inner(category)")
        .eq("organization_id", organizationId)
        .neq("status", "canceled")
        .eq("billing_plans.category", planCategory);
      if (error) {
        return failWith(
          organizationId,
          "unknown",
          "select_subscription_by_category",
          error,
          "Falha ao consultar a assinatura da organização — ver logs.",
        );
      }
      if ((data ?? []).length > 1) {
        return failWith(
          organizationId,
          effectKind,
          "ambiguous_subscription_category",
          `org ${organizationId} tem ${data!.length} assinaturas vivas na categoria ${planCategory}`,
          "Organização com mais de uma assinatura ativa na mesma categoria — ver logs.",
        );
      }
      const row = (data ?? [])[0] as { id: string; status: string } | undefined;
      subscription = row ? { id: row.id, status: row.status } : null;
    }

    // 7. Último portão. Fica AQUI, e não junto da decisão do passo 2, para que
    //    `organizationId` já tenha passado por toda a cadeia de resolução
    //    (invoice → externalReference → customer) antes de desistir.
    if (!organizationId) {
      return {
        status: "failed",
        organizationId: null,
        effect: effectKind,
        error: "Não foi possível correlacionar o evento a uma organização.",
      };
    }

    // 8. Executar. Transições por UPDATE CONDICIONAL — o `.neq`/`.eq` no status
    //    anterior é o que garante idempotência sob concorrência (webhook e
    //    reconcile podem tocar a mesma linha).
    switch (effectKind) {
      case "activate_subscription": {
        // Sem `payment.id` no envelope, TUDO abaixo vira no-op silencioso:
        // `invoice` é null e o `else if (paymentId)` não dispara, então o
        // dinheiro não é registrado; `purpose` fica no default "other" e o
        // `break` mais abaixo pula a ativação. O evento sairia daqui como
        // `processed`, fora da fila do reconcile, com o cliente pago e sem
        // acesso — e sem invoice paga nenhum reprocessamento futuro se
        // corrigiria. `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` SEMPRE trazem o
        // `payment` (§3), então isto é payload anômalo: falha ALTO pra linha
        // continuar na fila. Guard só neste efeito — `mark_invoice_overdue` sem
        // invoice correlacionada é no-op POR CONTRATO (obrigação 3 do JSDoc de
        // decideEventEffect), não anomalia.
        //
        // ⚠️ NÃO É CÓDIGO MORTO, apesar de inalcançável pelo asaas-webhook: por
        // aquele caminho, sem `paymentId` não há invoice nem payload, então o
        // `!organizationId` do passo 7 já retornou `failed` antes de chegar
        // aqui. Quem mantém este guard vivo é o caller reconcile, que passa
        // `row.organization_id` JÁ preenchido (carimbado pelo webhook na
        // primeira passagem) e portanto atravessa aquele portão.
        if (!paymentId) {
          return failWith(
            organizationId,
            effectKind,
            "missing_payment_id",
            `evento ${row.event_type} sem 'payment.id' no envelope`,
            "Evento de pagamento sem identificador da cobrança — ver logs.",
          );
        }

        // OBRIGAÇÃO 1 do contrato (JSDoc de decideEventEffect): registrar o
        // dinheiro SEMPRE — inclusive criando a linha quando ela não existe.
        // A idempotência do 2º evento do cartão (CONFIRMED e depois RECEIVED,
        // até ~30 dias) depende INTEIRAMENTE desta escrita: sem ela o segundo
        // evento reencontra a invoice não-paga e ativa de novo. Por isso o
        // `error` derruba o evento para `failed` em vez de seguir.
        if (invoice) {
          const { error: updErr } = await supabase
            .from("billing_invoices")
            .update({ status: "paid", paid_at: new Date().toISOString() })
            .eq("id", invoice.id)
            .neq("status", "paid");
          if (updErr) {
            return failWith(
              organizationId,
              effectKind,
              "update_invoice_paid",
              updErr,
              "Falha ao registrar o pagamento da fatura — ver logs.",
            );
          }

          if (paidValueCents !== null && paidValueCents !== invoice.amount_cents) {
            jsonLog("error", {
              evt: "asaas_amount_divergence",
              invoice_id: invoice.id,
              expected_cents: invoice.amount_cents,
              paid_cents: paidValueCents,
            });
          }
        } else {
          // `paymentId` é não-nulo aqui — garantido pelo guard no topo do case.
          // Sem linha prévia — caso normal de renovação, porque PAYMENT_CREATED
          // é informativo e não cria invoice. `provider_payment_id` tem UNIQUE
          // parcial, então uma corrida entre webhook e reconcile vira 23505 e
          // não linha duplicada.
          //
          // Sem valor legível NÃO se insere: `status:'paid'` é terminal para
          // `decideEventEffect`, então uma fatura de R$ 0,00 nunca seria
          // revisitada e o valor nunca seria corrigido. Registrar zero é pior
          // que não registrar — `failed` mantém o evento na fila e o reconcile
          // retenta quando o payload voltar íntegro. (Diferente da DIVERGÊNCIA
          // de valor com invoice existente logo acima, que só loga de
          // propósito: lá o valor conhecido é o nosso, não um chute.)
          if (paidValueCents === null) {
            return failWith(
              organizationId,
              effectKind,
              "missing_payment_value",
              `payment ${paymentId} sem 'value' numérico utilizável`,
              "Pagamento sem valor legível para registrar a fatura — ver logs.",
            );
          }

          const { error: insertErr } = await supabase.from("billing_invoices").insert({
            organization_id: organizationId,
            billing_subscription_id: subscription?.id ?? null,
            provider: "asaas",
            provider_payment_id: paymentId,
            purpose,
            external_reference: externalReferenceRaw,
            status: "paid",
            amount_cents: paidValueCents,
            // Coluna tem default 'brl' minúsculo — gravar "BRL" criaria duas
            // grafias pra mesma moeda.
            currency: "brl",
            payment_method: paymentMethod,
            paid_at: new Date().toISOString(),
          });
          // 23505 = corrida ganha pelo irmão; a linha existe e está paga.
          if (insertErr && insertErr.code !== "23505") {
            return failWith(
              organizationId,
              effectKind,
              "insert_invoice_paid",
              insertErr,
              "Falha ao registrar a fatura paga — ver logs.",
            );
          }
        }

        // Id da fatura deste pagamento, resolvido nos DOIS ramos: o UPDATE não
        // devolve id, e o INSERT pode ter virado 23505 numa corrida com o
        // reconcile. Um SELECT pelo UNIQUE (provider, provider_payment_id)
        // responde nos dois casos.
        let settledInvoiceId: string | null = invoice?.id ?? null;
        if (!settledInvoiceId) {
          const { data: inv } = await supabase
            .from("billing_invoices")
            .select("id")
            .eq("provider", "asaas")
            .eq("provider_payment_id", paymentId)
            .maybeSingle();
          settledInvoiceId = (inv?.id as string | undefined) ?? null;
        }

        // Sessão de checkout consumida — vale para QUALQUER purpose. Sem isto a
        // linha fica 'pending' para sempre e o UNIQUE parcial de sessão ativa
        // barra a próxima contratação do mesmo produto.
        if (checkoutSessionId) {
          const { error: sessErr } = await supabase
            .from("billing_checkout_sessions")
            .update({ status: "used" })
            .eq("provider_checkout_id", checkoutSessionId)
            .neq("status", "used");
          if (sessErr) {
            // Cosmético para o acesso — loga e segue, como o backfill do
            // provider_subscription_id.
            jsonLog("warn", {
              evt: "checkout_session_mark_used_failed",
              checkout: checkoutSessionId,
              error: String(sessErr),
            });
          }
        }

        if (purpose === "implementation") {
          // Falha do UPDATE aqui é PRÉ-REQUISITO do resultado, não acessório: o
          // dinheiro (R$ 750) já está durável e a implantação ficaria em
          // `PENDING` para sempre, sem action administrativa que corrija
          // (`set_operational_status` não escreve `payment_status`; `cancel` é o
          // único destino manual). Degrada pra `failed` — o UPDATE é idempotente
          // por `.eq('payment_status','PENDING')`, então reprocessar é seguro.
          // Só o AVISO continua best-effort, contido dentro da própria função.
          //
          // Depende do `recheckDurableEffect`: sem ele o retry reencontraria a
          // fatura `paid` → `noop` → `processed` e este `failed` nunca se
          // resolveria. Os dois consertos são um só.
          const confirmed = await confirmImplementationPayment(supabase, {
            organizationId,
            checkoutSessionId,
            invoiceId: settledInvoiceId,
            paidValueCents,
            paymentMethod,
          });
          if (!confirmed.ok) {
            return failWith(
              organizationId,
              effectKind,
              "confirm_implementation_payment",
              confirmed.error,
              "Falha ao confirmar a implantação paga — ver logs.",
            );
          }
        }

        // OBRIGAÇÃO 2 do contrato: conceder acesso SOMENTE quando o pagamento
        // for de assinatura do sistema. Um pacote de IA ou uma taxa de
        // implantação registram dinheiro mas NÃO liberam o sistema — senão uma
        // org inadimplente compraria R$ 50 de crédito e voltaria a ter acesso.
        if (purpose !== "subscription") {
          break;
        }

        // A criação/ativação é da RPC, não daqui: ela roda sob
        // pg_advisory_xact_lock por (org, categoria), que é o que impede duas
        // assinaturas de planos DIFERENTES da mesma categoria nascerem em
        // paralelo — corrida que nenhuma UNIQUE consegue expressar. A RPC
        // também faz o backfill do provider_subscription_id.
        if (!planId) {
          return failWith(
            organizationId,
            effectKind,
            "missing_plan_id",
            `externalReference sem plano (raw=${externalReferenceRaw ?? "ausente"})`,
            "Pagamento de assinatura sem plano identificável — ver logs.",
          );
        }

        const { data: rpcData, error: rpcErr } = await supabase.rpc(
          "resolve_or_activate_subscription",
          {
            p_org: organizationId,
            p_plan_id: planId,
            p_provider_subscription_id: providerSubscriptionId,
            // Coluna NOT NULL. O fallback 'card' é regra de produto (o checkout
            // RECURRENT do Asaas só aceita cartão), não chute.
            p_payment_method: paymentMethod ?? "card",
          },
        );
        if (rpcErr) {
          // Inclui ambiguous_subscription_category, plan_not_found e
          // missing_billing_customer. Todos são falha ALTA: o evento continua na
          // fila e o reconcile reprocessa depois que um humano resolver.
          return failWith(
            organizationId,
            effectKind,
            "resolve_or_activate_subscription",
            rpcErr,
            "Falha ao ativar a assinatura da organização — ver logs.",
          );
        }

        const activated = rpcData as
          | {
              action?: string;
              subscription_id?: string;
              category?: string;
              plan_changed?: { from: string; to: string } | null;
              provider_changed?: { from: string; to: string } | null;
            }
          | null;

        jsonLog("info", {
          evt: "asaas_subscription_resolved",
          organization_id: organizationId,
          action: activated?.action ?? null,
          category: activated?.category ?? null,
          plan_changed: activated?.plan_changed ?? null,
          provider_changed: activated?.provider_changed ?? null,
        });

        // ── INVARIANTE DA FASE 5a ────────────────────────────────────────────
        // SÓ assinatura de categoria SYSTEM_SUBSCRIPTION escreve em
        // organizations.billing_status. Sem este gate, pagar os R$149 da
        // instância reativaria uma organização cujo SISTEMA está inadimplente —
        // e carimbaria restored_at + aviso "voltou" por uma dívida que continua
        // aberta.
        if (activated?.category !== "SYSTEM_SUBSCRIPTION") {
          jsonLog("info", {
            evt: "asaas_activation_scoped_to_service",
            organization_id: organizationId,
            category: activated?.category ?? null,
          });
          break;
        }

        // Espelha em organizations, que é a coluna autoritativa do
        // BillingGuard e dos guards server-side. É o último passo de propósito:
        // só liberamos acesso depois que assinatura e fatura ficaram duráveis.
        //
        // Regularização (Fase 4b): se a org estava em atraso, carimba restored_at
        // e enfileira o aviso "regularized". Ler o status ANTES do update.
        const { data: prevOrg, error: prevOrgErr } = await supabase
          .from("organizations")
          .select("billing_status")
          .eq("id", organizationId)
          .maybeSingle();
        if (prevOrgErr) {
          jsonLog("warn", {
            evt: "regularize_prevorg_read_failed",
            organization_id: organizationId,
            err: prevOrgErr.message,
          });
        }
        const wasDelinquent =
          prevOrg?.billing_status === "grace_period" ||
          prevOrg?.billing_status === "blocked" ||
          prevOrg?.billing_status === "past_due";

        const orgUpdate: Record<string, unknown> = {
          billing_status: "active",
          blocked_at: null,
          blocked_reason: null,
        };
        if (wasDelinquent) orgUpdate.restored_at = new Date().toISOString();

        const { error: orgErr } = await supabase
          .from("organizations")
          .update(orgUpdate)
          .eq("id", organizationId);
        if (orgErr) {
          return failWith(
            organizationId,
            effectKind,
            "update_organization_active",
            orgErr,
            "Falha ao liberar o acesso da organização — ver logs.",
          );
        }

        if (wasDelinquent) {
          const recipient = await resolveBillingRecipient(supabase, organizationId);
          if (recipient) {
            await enqueueBillingNotification(supabase, {
              organizationId,
              eventType: "regularized",
              invoiceId: invoice?.id ?? null,
              recipient,
            });
          }
        }
        break;
      }

      case "mark_invoice_overdue": {
        if (invoice) {
          const { error: updErr } = await supabase
            .from("billing_invoices")
            .update({ status: "open" })
            .eq("id", invoice.id)
            .not("status", "in", "(paid,void)");
          if (updErr) {
            return failWith(
              organizationId,
              effectKind,
              "update_invoice_overdue",
              updErr,
              "Falha ao marcar a fatura como vencida — ver logs.",
            );
          }
        }
        break;
      }

      case "record_refund": {
        if (invoice) {
          const { error: updErr } = await supabase
            .from("billing_invoices")
            .update({ status: "void" })
            .eq("id", invoice.id)
            .neq("status", "void");
          if (updErr) {
            return failWith(
              organizationId,
              effectKind,
              "update_invoice_void",
              updErr,
              "Falha ao registrar o estorno da fatura — ver logs.",
            );
          }
        }
        // Estorno não é erro — é fato de negócio que o operador precisa ver.
        jsonLog("info", {
          evt: "asaas_refund_recorded",
          organization_id: organizationId,
          event_type: row.event_type,
          purpose,
        });
        break;
      }

      case "upsert_open_invoice": {
        // Gate de flag já resolvido no passo 4.1, ANTES do `getPayment` —
        // chegar aqui significa `billing_invoice_ingestion` estava ligada
        // quando a checagem rodou (TTL de cache de 5min, não pode ter virado
        // no meio desta invocação). Repetir o check aqui seria só um segundo
        // round-trip inútil ao cache/DB da flag.

        // `organizationId` já é garantidamente não-nulo aqui — o portão do
        // passo 7 (acima, antes deste switch) já retornou `failed` para todo
        // efeito, inclusive este, quando a organização não resolveu. Um
        // segundo guard aqui seria código morto.
        if (!paymentId) {
          return failWith(
            organizationId,
            effectKind,
            "upsert_open_invoice_no_payment_id",
            `evento ${row.event_type} sem 'payment.id'`,
            "Evento de cobrança sem identificador — ver logs.",
          );
        }

        // Repete o padrão de validação de `paidValueCents`: campo ausente é
        // anomalia de payload e loga (já feito na extração acima) — aqui é
        // fatal porque `due_date` é NOT NULL de fato para este efeito (é o que
        // `decideIngestionHold` e o worker de inadimplência usam).
        if (!paymentDueDate) {
          return failWith(
            organizationId,
            effectKind,
            "upsert_open_invoice_no_due_date",
            `cobrança ${paymentId} sem dueDate`,
            "Cobrança sem data de vencimento — ver logs.",
          );
        }

        // Achado Important #2 (Fix round 1): valor financeiro DESCONHECIDO
        // bloqueia o evento, nunca vira R$ 0,00 — R$ 0,00 tem significado
        // financeiro próprio (ex.: cortesia) e não é um fallback técnico pra
        // "não consegui ler". `paymentAmountParse` (calculado junto de
        // `paidValueCents` no bloco de enriquecimento acima) já distingue
        // "ausente" de "inválido"; NENHUM `?? 0`/`|| 0` neste campo.
        //
        // Dois `if` separados (null → depois `.ok === false`), NÃO
        // `!paymentAmountParse.ok` combinado nem `?.code`: sob
        // `strictNullChecks:false` (tsconfig.json deste repo — arquivo Deno,
        // fora do `tsc -b`, mas escrito pra tipar corretamente se algum dia
        // entrar), a negação de um discriminante boolean (`!x.ok`) NÃO
        // estreita a união dentro do próprio `if`, e acesso via `?.` a um
        // campo que só existe num dos ramos é erro independente de
        // estreitamento. `x.ok === false` estreita corretamente; verificado.
        if (!paymentAmountParse) {
          return failWith(
            organizationId,
            effectKind,
            "upsert_open_invoice_bad_amount",
            `provider_event_id=${row.provider_event_id} payment_id=${paymentId} ` +
              `provider_subscription_id=${providerSubscriptionId ?? "null"} ` +
              `organization_id=${organizationId ?? "null"} purpose=${purpose} ` +
              `event_type=${row.event_type} missing_or_invalid_field=value code=MISSING_PAYMENT_AMOUNT`,
            "Cobrança sem valor legível para registrar a fatura — ver logs.",
          );
        }
        if (paymentAmountParse.ok === false) {
          // `detail` é STRING, não objeto — `failWith` faz `String(detail)` pro
          // log (um objeto viraria "[object Object]" e perderia tudo). Campos
          // exigidos pelo achado: evento do provedor, pagamento, assinatura do
          // provedor, organização, purpose, tipo do evento, campo problemático
          // e a classificação. Nenhuma chave/token/payload aqui.
          return failWith(
            organizationId,
            effectKind,
            "upsert_open_invoice_bad_amount",
            `provider_event_id=${row.provider_event_id} payment_id=${paymentId} ` +
              `provider_subscription_id=${providerSubscriptionId ?? "null"} ` +
              `organization_id=${organizationId ?? "null"} purpose=${purpose} ` +
              `event_type=${row.event_type} missing_or_invalid_field=value code=${paymentAmountParse.code}`,
            "Cobrança sem valor legível para registrar a fatura — ver logs.",
          );
        }
        // `paymentAmountParse` é `{ok:true, cents}` daqui pra baixo.

        const hold = await decideIngestionHold({ dueDate: paymentDueDate, source: "WEBHOOK" });
        if (!hold.ok) {
          return failWith(
            organizationId,
            effectKind,
            "upsert_open_invoice_hold_flag_read_failed",
            `cobrança ${paymentId}: falha ao ler billing_invoice_ingestion_since`,
            "Falha ao verificar configuração de cobrança — ver logs.",
          );
        }

        // `billing_subscription_id` vem de `resolvedSubscriptionId` — o id
        // INTERNO produzido pela escada de correlação (Task 8), não de
        // `subscription?.id` (que é resolvido mais abaixo só para o path de
        // ativação) nem de `providerSubscriptionId` (o `sub_…` do Asaas).
        const { error: insErr } = await supabase.from("billing_invoices").insert({
          organization_id: organizationId,
          billing_subscription_id: resolvedSubscriptionId,
          provider: "asaas",
          provider_payment_id: paymentId,
          status: "open",
          amount_cents: paymentAmountParse.cents,
          payment_method: paymentMethod,
          due_date: paymentDueDate,
          purpose,
          external_reference: externalReferenceRaw,
          ingestion_source: "WEBHOOK",
          enforcement_hold: hold.hold,
          enforcement_hold_reason: hold.reason,
          enforcement_held_at: hold.hold ? new Date().toISOString() : null,
        });
        // 23505 = a UNIQUE (provider, provider_payment_id) pegou: webhook e
        // reconcile encontraram o mesmo pagamento primeiro, ou o próprio
        // PAYMENT_CREATED chegou duas vezes (Asaas entrega ao menos uma vez).
        // Caminho feliz da idempotência, não erro.
        if (insErr && insErr.code !== "23505") {
          return failWith(
            organizationId,
            effectKind,
            "insert_open_invoice",
            insErr,
            "Falha ao registrar a cobrança — ver logs.",
          );
        }
        break;
      }
    }

    return { status: "processed", organizationId, effect: effectKind };
  } catch (err) {
    jsonLog("error", {
      evt: "asaas_apply_unexpected_error",
      billing_event_id: row.id,
      event_type: row.event_type,
      error: String(err),
    });
    return {
      status: "failed",
      organizationId: row.organization_id,
      effect: "unknown",
      error: "Falha ao aplicar efeito do evento — ver logs.",
    };
  }
}
