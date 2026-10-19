import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsApp } from "../_shared/whatsapp-send.ts";
import { isLegacyAutomationSuppressed } from "../_shared/whatsapp-legacy-automation-post.ts";
import { clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";
import { clearChannelConnectivityCache } from "../_shared/whatsapp-send.ts";
import { sendEmail } from "../_shared/email.ts";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";
import { appendOutboundToConversation } from "../_shared/conversation-log.ts";
import { selectReservationAutomationRoute, automationUuid, decodeAutomationDispatch,
  decodeOutboxAutomationObservation, type OutboxAutomationObservation } from "../_shared/whatsapp-automation-producer-routing.ts";
import type { DispatchResult } from "../_shared/whatsapp-automation-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-key",
};

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function normalizeInstagram(raw: string): { url: string; label: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    const m = trimmed.match(/instagram\.com\/([^/?#]+)/i);
    return { url: trimmed, label: m ? `@${m[1]}` : trimmed };
  }
  const handle = trimmed.replace(/^@/, "").replace(/\/$/, "");
  return { url: `https://instagram.com/${handle}`, label: `@${handle}` };
}

function normalizeWebsite(raw: string): { url: string; label: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const label = trimmed.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return { url, label };
}

type EmailParams = {
  customerName: string;
  unitName: string;
  date: string;
  time: string;
  partySize: number;
  reservationCode: string;
  address: string;
  phone: string;
  instagram: string;
  website: string;
  discountPercent: number | null;
};

function buildEmailHtml(params: EmailParams): string {
  const { customerName, unitName, date, time, partySize, reservationCode, discountPercent } = params;
  const address = params.address.trim();
  const phone = params.phone.trim();
  const ig = normalizeInstagram(params.instagram);
  const site = normalizeWebsite(params.website);
  const hasContact = !!(address || phone || ig || site);
  const discountRow =
    discountPercent && discountPercent > 0
      ? `<tr>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:14px;color:#7a6f60;">Desconto</td>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:15px;font-weight:600;color:#15803d;">${discountPercent}% off</td>
                  </tr>`
      : "";

  const contactBlock = hasContact
    ? `<div style="margin:24px 0 0;padding:20px;background:#faf5ed;border-radius:8px;">
                  <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#7c2d12;text-transform:uppercase;letter-spacing:0.04em;">Localização e contato</p>
                  ${address ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#2a2520;">📍 ${escapeHtml(address)}<br><a href="${escapeHtml(mapsUrl(address))}" style="color:#7c2d12;font-size:13px;text-decoration:underline;">Ver no Google Maps</a></p>` : ""}
                  ${phone ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#2a2520;">📞 <a href="tel:${escapeHtml(phone.replace(/\D/g, ""))}" style="color:#2a2520;text-decoration:none;">${escapeHtml(phone)}</a></p>` : ""}
                  ${ig ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#2a2520;">📷 <a href="${escapeHtml(ig.url)}" style="color:#7c2d12;text-decoration:underline;">${escapeHtml(ig.label)}</a></p>` : ""}
                  ${site ? `<p style="margin:0;font-size:14px;line-height:1.5;color:#2a2520;">🔗 <a href="${escapeHtml(site.url)}" style="color:#7c2d12;text-decoration:underline;">${escapeHtml(site.label)}</a></p>` : ""}
                </div>`
    : "";
  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f5f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#2a2520;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ea;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
            <tr>
              <td style="background:#7c2d12;padding:24px 32px;">
                <h1 style="margin:0;color:#fffaf0;font-size:20px;font-weight:600;letter-spacing:-0.01em;">Reserva confirmada</h1>
                <p style="margin:4px 0 0;color:#fde9d9;font-size:14px;">${escapeHtml(unitName)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">Olá <strong>${escapeHtml(customerName)}</strong>, sua reserva está confirmada.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;border-collapse:collapse;">
                  <tr>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:14px;color:#7a6f60;width:120px;">Data</td>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:15px;font-weight:500;">${escapeHtml(date)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:14px;color:#7a6f60;">Horário</td>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:15px;font-weight:500;">${escapeHtml(time)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:14px;color:#7a6f60;">Pessoas</td>
                    <td style="padding:12px 0;border-bottom:1px solid #ede5d8;font-size:15px;font-weight:500;">${partySize}</td>
                  </tr>
                  ${discountRow}
                  <tr>
                    <td style="padding:12px 0;font-size:14px;color:#7a6f60;">Código</td>
                    <td style="padding:12px 0;font-size:15px;font-weight:600;font-family:'SF Mono',Menlo,monospace;">#${escapeHtml(reservationCode)}</td>
                  </tr>
                </table>
                ${contactBlock}
                <p style="margin:24px 0 0;font-size:14px;line-height:1.5;color:#7a6f60;">Para alterar ou cancelar, responda a confirmação no WhatsApp ou entre em contato com o restaurante usando o código acima.</p>
              </td>
            </tr>
            <tr>
              <td style="background:#faf5ed;padding:16px 32px;text-align:center;font-size:12px;color:#9b8f7f;">
                Este e-mail foi enviado automaticamente. Não é necessário respondê-lo.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildEmailText(params: EmailParams): string {
  const lines = [
    `Reserva confirmada — ${params.unitName}`,
    "",
    `Olá ${params.customerName}, sua reserva está confirmada.`,
    "",
    `Data: ${params.date}`,
    `Horário: ${params.time}`,
    `Pessoas: ${params.partySize}`,
  ];
  if (params.discountPercent && params.discountPercent > 0) {
    lines.push(`Desconto: ${params.discountPercent}% off`);
  }
  lines.push(`Código: #${params.reservationCode}`);

  const address = params.address.trim();
  const phone = params.phone.trim();
  const ig = normalizeInstagram(params.instagram);
  const site = normalizeWebsite(params.website);

  if (address || phone || ig || site) {
    lines.push("", "Localização e contato:");
    if (address) lines.push(`Endereço: ${address}`, `Mapa: ${mapsUrl(address)}`);
    if (phone) lines.push(`Telefone: ${phone}`);
    if (ig) lines.push(`Instagram: ${ig.url}`);
    if (site) lines.push(`Site: ${site.url}`);
  }

  lines.push(
    "",
    "Para alterar ou cancelar, responda a confirmação no WhatsApp ou entre em contato com o restaurante usando o código acima."
  );

  return lines.join("\n");
}

async function recordNotification(
  reservationId: string,
  unitId: string,
  kind: string,
  status: "sent" | "failed",
  error?: string,
  providerMessageId?: string | null,
  whatsappProvider?: string | null,
  whatsappChannelId?: string | null,
) {
  const sentAt = new Date().toISOString();
  // provider_message_id correlaciona o callback de status (entregue/lido).
  const { error: insertErr } = await supabase
    .from("notifications_sent")
    .insert({
      reservation_id: reservationId,
      unit_id: unitId,
      kind,
      status,
      error: error ?? null,
      provider_message_id: providerMessageId ?? null,
      whatsapp_provider: whatsappProvider ?? null,
      whatsapp_channel_id: whatsappChannelId ?? null,
      sent_at: sentAt,
    });
  if (!insertErr) return;

  // 23505 = unique(reservation_id, kind). Acontece em retry do Database Webhook:
  // se a 1ª tentativa gravou 'failed' e a atual deu certo, ANTES a linha ficava
  // travada em 'failed'. Agora ATUALIZA (e reseta o rastreio de entrega pro novo
  // messageId).
  if ((insertErr as { code?: string }).code === "23505") {
    const { error: updErr } = await supabase
      .from("notifications_sent")
      .update({
        status,
        error: error ?? null,
        provider_message_id: providerMessageId ?? null,
        whatsapp_provider: whatsappProvider ?? null,
        whatsapp_channel_id: whatsappChannelId ?? null,
        sent_at: sentAt,
        delivered_at: null,
        read_at: null,
        failed_at: null,
      })
      .eq("reservation_id", reservationId)
      .eq("kind", kind);
    if (updErr) {
      jsonLog("warn", { evt: "notifications_sent_update_failed", kind, err: updErr.message });
    }
    return;
  }

  jsonLog("warn", { evt: "notifications_sent_insert_failed", kind, err: insertErr.message });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Cache do gate é por invocação — zera aqui, mesmo padrão do unitCache dos
  // workers, senão um isolate quente serve estado de suspensão velho.
  clearWhatsAppGateCache();
  clearChannelConnectivityCache();

  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const record = body.record ?? body;
    // Reenvio só-WhatsApp (painel "Entregas" via resend-notification): pula o
    // e-mail pra não duplicar (a confirmação já foi enviada uma vez).
    const resendWhatsappOnly = body.resend_whatsapp_only === true;

    // Defesa em profundidade: se o caller informar unit_id, exige pareamento.
    // Trigger do banco (database webhook) sempre envia o record completo, então
    // record.unit_id é confiável quando vem de lá. Quando ausente, fica
    // como antes (escopo único pelo id).
    const expectedUnitId: string | null =
      typeof record.unit_id === "string" ? record.unit_id : null;

    let query = supabase
      .from("reservations")
      .select("*, customer:customers(*), unit:units(name, phone, instagram, website, address)")
      .eq("id", record.id);

    if (expectedUnitId) {
      query = query.eq("unit_id", expectedUnitId);
    }

    const { data: reserva, error } = await query.single();

    if (error || !reserva) {
      jsonLog("error", { evt: "reservation_not_found", id: record.id, err: String(error) });
      return new Response(JSON.stringify({ error: "Reserva não encontrada" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { customer, date, time, party_size, reservation_code, unit_id, unit, applied_discount_percent } = reserva;
    const dateBR = formatDate(date);
    const discountPercent: number | null =
      typeof applied_discount_percent === "number" && applied_discount_percent > 0
        ? applied_discount_percent
        : null;

    const { data: settingsRows } = unit_id
      ? await supabase
          .from("settings")
          .select("key, value")
          .eq("unit_id", unit_id)
          .in("key", [
            "restaurant_name",
            "restaurant_address",
            "restaurant_phone",
            "restaurant_instagram",
            "restaurant_website",
          ])
      : { data: null };

    const settingsMap = new Map<string, unknown>(
      (settingsRows ?? []).map((row) => [row.key as string, row.value])
    );
    const unitName =
      trimOrEmpty(settingsMap.get("restaurant_name")) || (unit?.name ?? "Restaurante");
    // Migration 050 moveu telefone/instagram/website/endereço pra colunas em
    // `units`. Lemos as colunas primeiro; settings vira fallback durante a
    // janela de transição (e pode ser removido em migration futura).
    const unitAddressFull =
      unit?.address && typeof unit.address === "object"
        ? trimOrEmpty((unit.address as { full?: string }).full)
        : "";
    const restaurantAddress =
      unitAddressFull || trimOrEmpty(settingsMap.get("restaurant_address"));
    const restaurantPhone =
      trimOrEmpty(unit?.phone) || trimOrEmpty(settingsMap.get("restaurant_phone"));
    const restaurantInstagram =
      trimOrEmpty(unit?.instagram) || trimOrEmpty(settingsMap.get("restaurant_instagram"));
    const restaurantWebsite =
      trimOrEmpty(unit?.website) || trimOrEmpty(settingsMap.get("restaurant_website"));

    const discountLine = discountPercent
      ? `💸 Desconto: ${discountPercent}% off\n`
      : "";

    const message =
      `✅ *Reserva Confirmada!*\n\n` +
      `Olá ${customer.name}, sua reserva está confirmada.\n\n` +
      `📅 Data: ${dateBR}\n` +
      `⏰ Horário: ${time}\n` +
      `👥 Pessoas: ${party_size}\n` +
      discountLine +
      `🔑 Código: #${reservation_code}\n\n` +
      `Para alterar ou cancelar, é só responder aqui. Até logo! 😊`;

    const emailParams: EmailParams = {
      customerName: customer.name,
      unitName,
      date: dateBR,
      time,
      partySize: party_size,
      reservationCode: reservation_code,
      address: restaurantAddress,
      phone: restaurantPhone,
      instagram: restaurantInstagram,
      website: restaurantWebsite,
      discountPercent,
    };

    const route = await selectReservationAutomationRoute(async (table, columns, predicates, cardinality) => {
      let query = supabase.from(table).select(columns);
      for (const [column, value] of predicates) query = query.eq(column, value);
      const result = await (cardinality === 'single' ? query.maybeSingle() : query);
      if (result.error) throw result.error;
      return result.data;
    }, { kind: 'confirmation', unitId: unit_id, reservationId: reserva.id });
    const managed = route.path !== 'legacy';
    const outboxId = body.outbox_id;
    let initialToken: string | null = null;
    let scheduled: DispatchResult | null = null;
    let automation: OutboxAutomationObservation | null = null;
    const noEffects = (reason: string) => new Response(JSON.stringify({ success: false,
      whatsapp: { sent: false, skipped: true, local_success: false }, email: { sent: false, skipped: true }, reason }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    async function scheduledRequest(payload: Record<string, unknown>): Promise<DispatchResult | null> {
      try {
        const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-scheduled-whatsapp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': Deno.env.get('INTERNAL_API_KEY') ?? '' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000),
        });
        return response.ok ? decodeAutomationDispatch(await response.json()) : null;
      } catch { return null; }
    }
    if (resendWhatsappOnly) {
      if (managed) {
        if (route.path === 'managed' && route.existingJobId)
          scheduled = await scheduledRequest({ action: 'dispatch_existing', job_id: route.existingJobId });
      } else {
        // Retry provenance differs from acceptance: failed confirmation can be retried.
        const receipt = await supabase.from('notifications_sent').select('id,unit_id,reservation_id,kind,status')
          .eq('unit_id', unit_id).eq('reservation_id', reserva.id).eq('kind', 'confirmation').maybeSingle();
        if (receipt.error || !receipt.data || !automationUuid(receipt.data.id) || receipt.data.unit_id !== unit_id
          || receipt.data.reservation_id !== reserva.id || receipt.data.kind !== 'confirmation'
          || !['sent','failed','skipped','delivered','read'].includes(receipt.data.status)) return noEffects('provenance_refused');
      }
    } else if (managed && outboxId !== undefined) {
      if (!automationUuid(outboxId)) return noEffects('provenance_refused');
      const actual = await supabase.from('notification_outbox')
        .select('id,reservation_id,unit_id,kind,status,automation_job_id,automation_initial_token').eq('id', outboxId).maybeSingle();
      if (actual.error || !actual.data || actual.data.id !== outboxId || actual.data.reservation_id !== reserva.id
        || actual.data.unit_id !== unit_id || actual.data.kind !== 'confirmation' || actual.data.status !== 'processing')
        return noEffects('provenance_refused');
      if (actual.data.automation_initial_token !== null) return noEffects('automation_initial_unfinished');
      if (route.path === 'dependency') {
        const deferred = await supabase.rpc('defer_notification_outbox_automation_dependency', { p_id: outboxId });
        return noEffects(!deferred.error && deferred.data === true ? 'automation_dependency_unavailable' : 'automation_defer_failed');
      }
      const claimed = await supabase.rpc('claim_notification_outbox_initial', { p_id: outboxId });
      if (claimed.error || !automationUuid(claimed.data)) return noEffects('automation_initial_unclaimed');
      initialToken = claimed.data;
      // Existing ledger allows one email-only opportunity, without dispatch or repair.
      const jobId = route.existingJobId;
      if (jobId) {
        const pinned = await supabase.rpc('delegate_notification_outbox_automation', { p_id: outboxId, p_job_id: jobId });
        if (pinned.error || pinned.data !== true) jsonLog('warn', { evt: 'confirmation_automation_dependency' });
      } else {
        scheduled = await scheduledRequest({ action: 'enqueue', kind: 'confirmation', resource_id: reserva.id, unit_id, outbox_id: outboxId });
        if (scheduled?.jobId) {
          const pinned = await supabase.rpc('delegate_notification_outbox_automation', { p_id: outboxId, p_job_id: scheduled.jobId });
          scheduled = !pinned.error && pinned.data === true
            ? await scheduledRequest({ action: 'dispatch_existing', job_id: scheduled.jobId }) : null;
        }
      }
    }
    const scheduledWhatsapp = () => ({ kind: 'whatsapp' as const,
      ok: scheduled?.state === 'accepted' || scheduled?.state === 'reconciled', skipped: true,
      reason: 'automation_managed' });

    // A seleção do canal é centralizada em sendWhatsApp: quando há `is_active`,
    // ela vence; sem projeção explícita, o fallback aceita só legado NULL.
    // Pré-selecionar aqui poderia passar um canal preservado/inativo no cutover.
    const whatsappPromise = managed ? Promise.resolve(scheduledWhatsapp()) : unit_id
      ? sendWhatsApp(customer.phone, message, {
          unit_id,
          legacyAutomation: { kind: 'confirmation', resourceId: reserva.id, origin: 'send-confirmation' },
        }).then(
          (res) => ({
            kind: "whatsapp" as const,
            ok: res.ok,
            skipped: false as const,
            error: res.ok ? undefined : (res.error ?? `status_${res.status ?? "unknown"}`),
            providerMessageId: res.providerMessageId,
            whatsappProvider: res.provider,
            whatsappChannelId: res.channelId,
          }),
          (err) => ({ kind: "whatsapp" as const, ok: false, skipped: false as const, error: String(err), providerMessageId: undefined })
        )
      : Promise.resolve({ kind: "whatsapp" as const, ok: false, skipped: true as const, reason: "no_channel" });

    const emailPromise = customer.email && !resendWhatsappOnly
      ? sendEmail({
          to: customer.email,
          subject: `Reserva confirmada — ${dateBR} às ${time}`,
          html: buildEmailHtml(emailParams),
          text: buildEmailText(emailParams),
        }).then((res) => ({ kind: "email" as const, ...res }))
      : Promise.resolve({ kind: "email" as const, ok: false, skipped: true as const, reason: "no_email" });

    const [initialWhatsappResult, emailResult] = await Promise.all([whatsappPromise, emailPromise]);
    let whatsappResult = initialWhatsappResult;
    let whatsappHistoryPersisted = managed ? scheduled?.state === 'reconciled' : true;

    if (whatsappResult.skipped) {
      jsonLog("info", {
        evt: "confirmation_whatsapp",
        status: "skipped",
        reason: (whatsappResult as { reason: string }).reason,
        reservation_id: record.id,
      });
    } else if (whatsappResult.ok) {
      jsonLog("info", { evt: "confirmation_whatsapp", status: "sent", reservation_id: record.id });
      await recordNotification(
        record.id,
        unit_id,
        "confirmation",
        "sent",
        undefined,
        (whatsappResult as { providerMessageId?: string }).providerMessageId ?? null,
        (whatsappResult as { whatsappProvider?: string }).whatsappProvider ?? null,
        (whatsappResult as { whatsappChannelId?: string }).whatsappChannelId ?? null,
      );
      if (unit_id) {
        const conversationLog = await appendOutboundToConversation({
          supabase,
          unitId: unit_id,
          customerId: customer?.id ?? null,
          phone: customer?.phone ?? null,
          content: message,
          kind: "confirmation",
          eventId: (whatsappResult as { providerMessageId?: string }).providerMessageId
            ? `wa-out:${(whatsappResult as { whatsappProvider?: string }).whatsappProvider ?? "unknown"}:${(whatsappResult as { providerMessageId?: string }).providerMessageId}`
            : undefined,
        });
        whatsappHistoryPersisted = conversationLog.persisted;
      }
    } else {
      jsonLog("warn", {
        evt: "confirmation_whatsapp",
        status: "failed",
        reservation_id: record.id,
        err: (whatsappResult as { error?: string }).error,
      });
      if (!isLegacyAutomationSuppressed({ error: (whatsappResult as { error?: string }).error }))
        await recordNotification(record.id, unit_id, "confirmation", "failed", (whatsappResult as { error?: string }).error);
    }

    if (emailResult.skipped) {
      jsonLog("info", {
        evt: "confirmation_email",
        status: "skipped",
        reason: (emailResult as { reason: string }).reason,
        reservation_id: record.id,
      });
    } else if (emailResult.ok) {
      jsonLog("info", {
        evt: "confirmation_email",
        status: "sent",
        reservation_id: record.id,
        provider_id: (emailResult as { id: string }).id,
      });
      await recordNotification(record.id, unit_id, "confirmation_email", "sent");
    } else {
      jsonLog("warn", {
        evt: "confirmation_email",
        status: "failed",
        reservation_id: record.id,
        err: (emailResult as { error?: string }).error,
      });
      await recordNotification(record.id, unit_id, "confirmation_email", "failed", (emailResult as { error?: string }).error);
    }

    const anySent = whatsappResult.ok || emailResult.ok;
    if (!managed && anySent) {
      await supabase.from("reservations").update({ status: "confirmed" }).eq("id", record.id);
    } else if (managed && emailResult.ok && !resendWhatsappOnly) {
      const promoted = await supabase.from('reservations').update({ status: 'confirmed' })
        .eq('id', reserva.id).eq('unit_id', unit_id).eq('status', 'pending').select('id,unit_id,status');
      const actualPromotion = !promoted.error && promoted.data?.length === 1 && promoted.data[0].id === reserva.id
        && promoted.data[0].unit_id === unit_id && promoted.data[0].status === 'confirmed';
      if (initialToken && actualPromotion && scheduled?.state === 'blocked' && scheduled.pinPhase === 'bound'
        && scheduled.reason === 'reservation_pending') {
        const proof = await supabase.from('whatsapp_automation_jobs').select('id,unit_id,reservation_id,kind,attempts,posting_started_at,provider_message_id')
          .eq('id', scheduled.jobId).eq('unit_id', unit_id).eq('reservation_id', reserva.id).eq('kind', 'confirmation').maybeSingle();
        if (!proof.error && proof.data?.id === scheduled.jobId && proof.data.unit_id === unit_id
          && proof.data.reservation_id === reserva.id && proof.data.kind === 'confirmation' && proof.data.attempts === 0
          && proof.data.posting_started_at === null && proof.data.provider_message_id === null) {
          scheduled = await scheduledRequest({ action: 'dispatch_existing', job_id: scheduled.jobId });
          whatsappResult = scheduledWhatsapp();
          whatsappHistoryPersisted = scheduled?.state === 'reconciled';
        }
      }
    }
    if (initialToken) {
      const finished = await supabase.rpc('finish_notification_outbox_initial', { p_id: outboxId, p_token: initialToken });
      if (finished.error || finished.data !== true) jsonLog('warn', { evt: 'confirmation_automation_finish_deferred' });
      const observed = await supabase.rpc('poll_notification_outbox_automation', { p_id: outboxId });
      automation = observed.error ? null : decodeOutboxAutomationObservation(observed.data);
      if (!automation) jsonLog('warn', { evt: 'confirmation_automation_observation_failed' });
      if (automation?.disposition === 'accepted') {
        whatsappResult = { ...scheduledWhatsapp(), ok: true };
        whatsappHistoryPersisted = automation.ledger_state === 'reconciled';
      }
    }

    return new Response(
      JSON.stringify({
        success: whatsappResult.ok || emailResult.ok,
        ...(automation ? { automation } : {}),
        whatsapp: {
          sent: whatsappResult.ok,
          skipped: whatsappResult.skipped,
          local_success: whatsappResult.ok ? whatsappHistoryPersisted : false,
          warning: whatsappResult.ok && !whatsappHistoryPersisted ? "CONVERSATION_RECONCILIATION_REQUIRED" : undefined,
        },
        email: { sent: emailResult.ok, skipped: emailResult.skipped },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    jsonLog("error", { evt: "send_confirmation_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
