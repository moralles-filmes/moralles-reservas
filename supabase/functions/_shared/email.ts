import { jsonLog } from "./security.ts";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export type SendEmailResult =
  | { ok: true; skipped: false; id: string }
  | { ok: false; skipped: true; reason: "no_api_key" | "no_from" | "invalid_email" }
  | { ok: false; skipped: false; error: string };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    jsonLog("warn", { evt: "email_skipped", reason: "no_api_key" });
    return { ok: false, skipped: true, reason: "no_api_key" };
  }

  const from = Deno.env.get("RESEND_FROM_EMAIL");
  if (!from) {
    jsonLog("warn", { evt: "email_skipped", reason: "no_from" });
    return { ok: false, skipped: true, reason: "no_from" };
  }

  if (!EMAIL_REGEX.test(input.to)) {
    jsonLog("warn", { evt: "email_skipped", reason: "invalid_email" });
    return { ok: false, skipped: true, reason: "invalid_email" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      jsonLog("error", { evt: "email_failed", status: res.status, body: body.slice(0, 500) });
      return { ok: false, skipped: false, error: `resend_http_${res.status}` };
    }

    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      return { ok: false, skipped: false, error: "resend_no_id" };
    }

    jsonLog("info", { evt: "email_sent", id: json.id });
    return { ok: true, skipped: false, id: json.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonLog("error", { evt: "email_failed", err: message });
    return { ok: false, skipped: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
