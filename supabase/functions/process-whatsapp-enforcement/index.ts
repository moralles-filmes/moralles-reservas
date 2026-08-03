// Worker: suspende e restaura o SERVIÇO de WhatsApp por inadimplência da
// mensalidade da instância. Roda diariamente via pg_cron.
//
// Suspender = billing_subscriptions.status='unpaid' + suspended_at. O núcleo de
// entitlements já trata `unpaid` como sem acesso, então nada nele muda; e
// `unpaid` não é `canceled`, então resolve_or_activate_subscription continua
// encontrando a linha e não cria uma segunda assinatura (e, no caminho do
// pagamento via Asaas, já restaura suspended_at/restored_at sozinha — este
// worker é a defesa dupla para quando aquele caminho não passa por lá,
// mesmo padrão de process-billing-unblock para invoice.paid).
//
// NUNCA escreve organizations.billing_status — essa coluna representa o acesso
// ao SISTEMA, e a mensalidade da instância não governa o sistema.
// NUNCA escreve em organization_entitlement_overrides — override é ação
// administrativa; worker financeiro não mexe.
//
// GATE DE FLAG (`whatsapp_service_enforcement`): governa só a ESCRITA em
// billing_subscriptions (suspender/restaurar) e as notificações de cliente
// que dependem dela. OFF ou ilegível = calcula tudo, não escreve nada, emite
// `evt:"whatsapp_enforcement_dryrun_worker"` por organização que teria mudado
// de estado. Ambiguidade de assinatura e o skip por override ativo são
// observações de DADO, não a consequência que a flag gateia — ficam sempre
// visíveis, mesmo em dry-run.
//
// QUAL ASSINATURA FINANCIA O WHATSAPP: decisão do núcleo puro
// `_shared/whatsapp-subscription-resolver-core.ts`, o MESMO que
// `_shared/whatsapp-service-gate.ts` usa. As duas queries eram campo-a-campo
// idênticas por disciplina humana — divergir uma sem a outra fazia este worker
// e o gate de envio discordarem sobre quem está inadimplente. A garantia agora
// é estrutural: filtro de categoria e precedência de status vivem no núcleo, e
// um guardrail estático prova que os dois continuam chamando.
//
// AMBIGUIDADE (duplicidade inesperada dentro da MESMA categoria — duas
// assinaturas legadas de WhatsApp, ou dois planos de sistema declarando
// `whatsapp`): não escolhe, não movimenta a organização, avisa o admin da
// plataforma. Mesma política de `resolve_or_activate_subscription`
// (`ambiguous_subscription_category`, migration 073/079). Não confundir com
// TRANSIÇÃO (uma legada + um plano novo coexistindo): essa o núcleo RESOLVE
// deterministicamente e o serviço continua — só fica a pendência
// administrativa de encerrar a legada, registrada em log.
//
// ESCOPO DA SUSPENSÃO: este worker escreve `status='unpaid'` na assinatura que
// o núcleo apontou como fonte. Hoje isso é sempre a assinatura legada de
// categoria `WHATSAPP_SUBSCRIPTION`, porque nenhum plano tem `included_features`
// preenchido (a 094 dá `'{}'` a todas as linhas e os seeds são do Plano B). No
// dia em que existir um Plano 2 vendido, a fonte passa a ser a assinatura de
// SISTEMA e suspendê-la alcança o sistema inteiro, não só o WhatsApp — decidir
// o que fazer nesse caso é trabalho do plano que habilitar a venda, não deste.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import {
  normalizeFinancialState,
  isBillingInvoiceStatus,
  type BillingInvoiceStatus,
} from "../_shared/billing-financial-state-core.ts";
import { resolveWhatsAppGateByOrg, clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";
import { resolveWhatsAppSubscription } from "../_shared/whatsapp-subscription-resolver-core.ts";
import {
  resolveBillingRecipient,
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
} from "../_shared/billing-notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/**
 * Teto de assinaturas por execução. Mesmo raciocínio do `BATCH_LIMIT` do
 * worker irmão `process-asaas-invoice-reconcile/index.ts`: sem `.limit()`
 * (nem `.range()` em loop), o PostgREST trunca silenciosamente em
 * `db-max-rows` (default 1000) — CLAUDE.md § Padrões de código. O resto
 * sobra pra execução de amanhã DE PROPÓSITO (worker diário); atingir o teto
 * é logado explicitamente, nunca um corte silencioso que lê como cobertura
 * completa.
 *
 * `ORDER BY updated_at ASC, id ASC`: sem ordenação, `.limit()` do PostgREST
 * devolve um subconjunto ARBITRÁRIO — acima do teto, o mesmo grupo podia
 * voltar todo dia e o resto nunca ser reconciliado. Assinatura tocada por
 * qualquer escrita (suspensão, restauração, troca de plano) volta pro fim da
 * fila, e a que fica parada por mais tempo entra primeiro. Empate quebrado
 * por `id` pra determinismo total.
 *
 * O teto passou a contar TODAS as assinaturas não canceladas, não só as de
 * categoria `WHATSAPP_SUBSCRIPTION`: o filtro de categoria saiu da query
 * porque devolvia zero linha para uma organização do Plano 2, e quem decide o
 * que é candidato é o núcleo. Consequência a vigiar quando a base crescer:
 * linhas irrelevantes consomem orçamento do lote, e uma organização cujas
 * assinaturas caiam nos dois lados do corte chega ao núcleo incompleta. O
 * `whatsapp_enforcement_subs_capped` abaixo é o sinal de que isso passou a ser
 * possível — atingir o teto deixou de ser só "sobrou pra amanhã".
 */
const BATCH_LIMIT = 200;

// Reusa o event_type já coberto por TEMPLATE_BY_EVENT em
// process-billing-notifications/index.ts — o design da fase (seção de
// avisos) lista "ambiguidade de assinatura por categoria" como um dos
// gatilhos deste MESMO evento (ao lado da divergência de organização entre
// degraus da correlação Asaas), não um evento próprio. Inventar um nome novo
// aqui deixaria a linha `failed/unknown_event_type` para sempre — nenhuma
// task futura vai adicionar template para um nome que o design não previu.
const ADMIN_AMBIGUITY_EVENT_TYPE = "admin_correlation_ambiguity";

// enqueueBillingNotification só deduplica via UNIQUE (organization_id,
// event_type, invoice_id), e esse índice é PARCIAL (invoice_id IS NOT NULL) —
// invoice_id null, o caso aqui, NUNCA casa nele. Sem um freio no produtor,
// uma ambiguidade não resolvida manualmente reenfileiraria um aviso novo TODO
// dia que este worker rodasse, para sempre, sem backoff. Por isso o worker
// checa aqui, antes de enfileirar, se já existe aviso do mesmo tipo para a
// mesma organização ainda pendente ou enviado dentro da janela abaixo.
const ADMIN_AMBIGUITY_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Linha crua de `billing_subscriptions` com o plano embutido. Mesma seleção de
 * campos de `resolveWhatsAppGateByOrg` mais `organization_id`/`updated_at`
 * (este worker varre todas as organizações; o gate resolve uma só).
 *
 * `included_features` pode vir `null` quando a EF roda antes da migration 094;
 * `?? []` a trata como plano LEGADO, que é o que ela é nesse ponto do rollout.
 */
interface SubscriptionPlanRef {
  category: string | null;
  included_features: string[] | null;
}

interface SubscriptionRow {
  id: string;
  organization_id: string;
  status: string;
  canceled_at: string | null;
  suspended_at: string | null;
  billing_plans: SubscriptionPlanRef | SubscriptionPlanRef[] | null;
}

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  // Sem isso, um isolate quente serviria o veredito da invocação anterior —
  // este worker varre MUITAS organizações numa só passagem, e um resultado
  // velho aplicado a quem acabou de pagar é exatamente o bug que o cache por
  // invocação existe para evitar (ver header de whatsapp-service-gate.ts).
  clearWhatsAppGateCache();

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "whatsapp_enforcement_start" });

  try {
    // Flag ilegível é tratada como OFF para efeito de ESCREVER — fail-open
    // pro cliente: um soluço na leitura da flag não pode virar suspensão.
    const flagCheck = await checkFlagEnabled("whatsapp_service_enforcement");
    const apply = flagCheck.enabled && !flagCheck.readFailed;

    // TODAS as candidatas, sem filtro de categoria e sem `.maybeSingle()` —
    // query campo-a-campo equivalente à de `resolveWhatsAppGateByOrg` (mais o
    // escopo de lote deste worker). O filtro `billing_plans.category` saiu
    // porque devolvia ZERO linha para uma organização do Plano 2, que paga o
    // pacote de automação dentro da mensalidade do sistema; quem é candidata é
    // decisão do núcleo compartilhado, não desta query.
    const { data: subsRaw, error: subsErr } = await supabase
      .from("billing_subscriptions")
      .select(
        "id, organization_id, status, canceled_at, suspended_at, updated_at, billing_plans!inner(category, included_features)",
      )
      .neq("status", "canceled")
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(BATCH_LIMIT);

    if (subsErr) {
      jsonLog("error", { reqId, evt: "whatsapp_enforcement_query_failed", err: subsErr.message });
      return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
    }

    const subs = (subsRaw ?? []) as unknown as SubscriptionRow[];
    if (subs.length === BATCH_LIMIT) {
      jsonLog("warn", { reqId, evt: "whatsapp_enforcement_subs_capped", cap: BATCH_LIMIT });
    }

    // Agrupar por organização é o que dá ao núcleo o conjunto COMPLETO de
    // candidatas da organização — é ele quem decide fonte, transição e
    // duplicidade, e ele precisa ver todas as linhas para isso.
    const byOrg = new Map<string, SubscriptionRow[]>();
    for (const s of subs) {
      const list = byOrg.get(s.organization_id) ?? [];
      list.push(s);
      byOrg.set(s.organization_id, list);
    }

    let suspended = 0;
    let restored = 0;
    let skippedOverride = 0;
    let ambiguous = 0;
    let noFundingSource = 0;
    let wouldSuspend = 0;
    let wouldRestore = 0;

    for (const [orgId, orgSubs] of byOrg) {
      const resolution = resolveWhatsAppSubscription({
        subscriptions: orgSubs.map((row) => {
          // PostgREST devolve relação aninhada como objeto OU array — normalizar.
          const plan = Array.isArray(row.billing_plans) ? row.billing_plans[0] : row.billing_plans;
          return {
            id: row.id,
            status: row.status,
            category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
            includedFeatures: plan?.included_features ?? [],
            canceledAt: row.canceled_at,
            suspendedAt: row.suspended_at,
          };
        }),
      });

      // Mesma derivação do gate: duplicidade OU transição. Aqui ela não vira
      // consequência (este worker não provisiona nada) — vira o log que dá ao
      // admin a pendência de encerrar a assinatura legada.
      const subscriptionAmbiguous =
        resolution.kind === "AMBIGUOUS" ||
        (resolution.kind === "RESOLVED" && resolution.provisioningAmbiguous);

      if (resolution.kind === "AMBIGUOUS") {
        ambiguous++;
        jsonLog("warn", {
          reqId,
          evt: "whatsapp_ambiguous_subscription",
          org: orgId,
          reason: resolution.reasonCode,
          count: resolution.candidateIds.length,
        });

        const dedupSince = new Date(Date.now() - ADMIN_AMBIGUITY_DEDUP_WINDOW_MS).toISOString();
        const { data: recentNotice, error: recentErr } = await supabase
          .from("billing_notifications")
          .select("id")
          .eq("organization_id", orgId)
          .eq("event_type", ADMIN_AMBIGUITY_EVENT_TYPE)
          .or(`status.eq.pending,sent_at.gte.${dedupSince}`)
          .limit(1);

        if (recentErr) {
          // Fix round 2 (achado novo #1): a checagem falhou, não achou uma
          // duplicata — "não deu pra confirmar" tem que virar "não achei",
          // nunca "achei". Este é o ÚNICO sinal humano de que a organização
          // tem duas assinaturas de WhatsApp vivas, um estado que o worker se
          // recusa a resolver sozinho e que nada mais corrige. Um e-mail
          // duplicado num dia de soluço no SELECT é barato (e
          // enqueueBillingNotification nunca lança — numa falha sistêmica o
          // INSERT de acompanhamento também vira no-op, sem flood real);
          // deixar o admin sem saber da duplicata enquanto o SELECT falhar é
          // caro. Cai para o enfileiramento abaixo.
          jsonLog("warn", {
            reqId,
            evt: "whatsapp_enforcement_ambiguity_dedup_read_failed",
            org: orgId,
            err: recentErr.message,
          });
        }

        if (!recentErr && (recentNotice?.length ?? 0) > 0) {
          jsonLog("info", {
            reqId,
            evt: "whatsapp_ambiguity_notice_skipped_dedup",
            org: orgId,
          });
        } else {
          const recipients = await resolvePlatformAdminRecipients(supabase);
          for (const recipient of recipients) {
            await enqueueBillingNotification(supabase, {
              organizationId: orgId,
              eventType: ADMIN_AMBIGUITY_EVENT_TYPE,
              invoiceId: null,
              recipient,
            });
          }
        }
        continue;
      }

      if (resolution.kind === "NONE") {
        // Nenhuma assinatura financia WhatsApp nesta organização (ela só tem
        // mensalidade de sistema legada, por exemplo). Antes do resolvedor
        // essas linhas nem chegavam aqui — o filtro de categoria as descartava
        // na query. Contar é o que mantém o resumo legível agora que o lote
        // varre todas as categorias.
        noFundingSource++;
        continue;
      }

      if (subscriptionAmbiguous) {
        // Transição resolvida: o serviço continua pela assinatura escolhida, e
        // fica registrada a obrigação administrativa de encerrar a legada.
        jsonLog("info", {
          reqId,
          evt: "whatsapp_enforcement_transition_pending",
          org: orgId,
          pendency: resolution.adminPendency,
          source: resolution.source,
          chosen: resolution.subscriptionId,
          candidates: resolution.candidateIds.length,
        });
      }

      const sub = {
        id: resolution.subscriptionId,
        status: resolution.status,
        canceled_at: resolution.canceledAt,
      };

      // Fatura em aberto mais antiga desta assinatura, excluindo as retidas —
      // mesmo padrão de whatsapp-service-gate.ts / process-billing-overdue:
      // fatura em revisão administrativa não conta como atraso.
      const { data: inv, error: invErr } = await supabase
        .from("billing_invoices")
        .select("due_date, status")
        .eq("billing_subscription_id", sub.id)
        .eq("status", "open")
        .eq("enforcement_hold", false)
        .not("due_date", "is", null)
        .order("due_date", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (invErr) {
        jsonLog("warn", {
          reqId,
          evt: "whatsapp_enforcement_invoice_read_failed",
          org: orgId,
          sub: sub.id,
          err: invErr.message,
        });
        continue;
      }

      let oldestOpenInvoice: { dueDate: string; status: BillingInvoiceStatus } | null = null;
      if (inv?.due_date) {
        // Defesa em profundidade contra drift de schema — o CHECK do banco já
        // deveria garantir que status='open' é sempre um valor conhecido.
        if (isBillingInvoiceStatus(inv.status)) {
          oldestOpenInvoice = { dueDate: inv.due_date as string, status: inv.status };
        } else {
          jsonLog("warn", {
            reqId,
            evt: "whatsapp_enforcement_invalid_invoice_status",
            org: orgId,
            sub: sub.id,
            status: inv.status,
          });
          continue;
        }
      }

      const financial = normalizeFinancialState({
        now: new Date().toISOString(),
        subscriptionStatus: sub.status,
        canceledAt: sub.canceled_at,
        oldestOpenInvoice,
      });

      if (financial.state === "OVERDUE_BEYOND_GRACE") {
        // Override ativo de whatsapp: reusa o helper de I/O da Task 13 em vez
        // de duplicar a leitura de organization_entitlement_overrides. O gate
        // resolve a assinatura pelo MESMO núcleo chamado acima, então ele não
        // pode discordar desta resolução nem lançar por duplicidade.
        //
        // Escopado a ESTE branch de propósito (fix round 1, achado Important
        // #2): só a decisão de SUSPENDER depende de "há override ativo?". A
        // restauração (branch abaixo) não usa `overrideActive` e não pode
        // ficar refém de um soluço nesta leitura — sem este escopo, um
        // gate.readFailed pontual fazia `continue` ANTES de sequer olhar o
        // estado PAID de quem já pagou, atrasando a restauração por soluço
        // técnico. Fail-open pro cliente vale nos dois sentidos: nunca
        // suspender por engano E nunca atrasar quem já está em dia.
        const gate = await resolveWhatsAppGateByOrg(supabase, orgId);
        if (gate.readFailed) {
          jsonLog("warn", {
            reqId,
            evt: "whatsapp_enforcement_gate_read_failed",
            org: orgId,
            sub: sub.id,
          });
          continue; // não suspende por soluço técnico de leitura.
        }
        const overrideActive = gate.state === "OVERRIDE_ACTIVE";

        if (overrideActive) {
          // Custo patrocinado pela plataforma — precisa ficar visível mesmo
          // quando não há nada a suspender por causa disso.
          skippedOverride++;
          jsonLog("info", {
            reqId,
            evt: "whatsapp_suspension_skipped_override",
            org: orgId,
            sub: sub.id,
          });
          continue;
        }

        if (sub.status !== "active" && sub.status !== "past_due") {
          // Já suspensa (unpaid) ou estado que este worker não movimenta
          // (ex.: paused) — nada a fazer.
          continue;
        }

        if (!apply) {
          wouldSuspend++;
          jsonLog("info", {
            reqId,
            evt: "whatsapp_enforcement_dryrun_worker",
            org: orgId,
            sub: sub.id,
            would_suspend: true,
          });
          continue;
        }

        // Condicional em ["active","past_due"]: aceita tanto quem já passou
        // pela tolerância quanto quem nunca recebeu o webhook de vencimento
        // (nunca virou past_due). O `.select("id")` é o que distingue "eu
        // suspendi agora" de "já estava suspensa" — só quem de fato mudou a
        // linha enfileira o aviso.
        const { data: changed, error: updErr } = await supabase
          .from("billing_subscriptions")
          .update({ status: "unpaid", suspended_at: new Date().toISOString() })
          .eq("id", sub.id)
          .in("status", ["active", "past_due"])
          .select("id");

        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "whatsapp_enforcement_suspend_failed",
            org: orgId,
            sub: sub.id,
            err: updErr.message,
          });
          continue;
        }

        if ((changed?.length ?? 0) > 0) {
          suspended++;
          jsonLog("info", { reqId, evt: "whatsapp_suspended", org: orgId, sub: sub.id });
          const recipient = await resolveBillingRecipient(supabase, orgId);
          if (recipient) {
            await enqueueBillingNotification(supabase, {
              organizationId: orgId,
              eventType: "whatsapp_suspended",
              invoiceId: null,
              recipient,
            });
          }
        }
        continue;
      }

      if (sub.status === "unpaid" && financial.state === "PAID") {
        if (!apply) {
          wouldRestore++;
          jsonLog("info", {
            reqId,
            evt: "whatsapp_enforcement_dryrun_worker",
            org: orgId,
            sub: sub.id,
            would_restore: true,
          });
          continue;
        }

        const { data: restoredRows, error: restoreErr } = await supabase
          .from("billing_subscriptions")
          .update({ status: "active", restored_at: new Date().toISOString(), suspended_at: null })
          .eq("id", sub.id)
          .eq("status", "unpaid")
          .select("id");

        if (restoreErr) {
          jsonLog("error", {
            reqId,
            evt: "whatsapp_enforcement_restore_failed",
            org: orgId,
            sub: sub.id,
            err: restoreErr.message,
          });
          continue;
        }

        if ((restoredRows?.length ?? 0) > 0) {
          restored++;
          jsonLog("info", { reqId, evt: "whatsapp_restored", org: orgId, sub: sub.id });
          const recipient = await resolveBillingRecipient(supabase, orgId);
          if (recipient) {
            await enqueueBillingNotification(supabase, {
              organizationId: orgId,
              eventType: "whatsapp_restored",
              invoiceId: null,
              recipient,
            });
          }
        }
      }
    }

    const summary = {
      dry_run: !apply,
      subscriptions_scanned: subs.length,
      suspended,
      restored,
      would_suspend: wouldSuspend,
      would_restore: wouldRestore,
      skipped_override: skippedOverride,
      ambiguous,
      no_funding_source: noFundingSource,
    };

    jsonLog("info", { reqId, evt: "whatsapp_enforcement_done", ...summary });
    return new Response(
      JSON.stringify({
        success: true,
        ...summary,
        // Marcador de estágio degradado (mesmo padrão de
        // process-asaas-invoice-reconcile): sem ele, uma execução que bateu
        // no teto é indistinguível de uma que varreu tudo.
        ...(subs.length === BATCH_LIMIT ? { subscriptions_capped: true } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    jsonLog("error", { reqId, evt: "whatsapp_enforcement_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
