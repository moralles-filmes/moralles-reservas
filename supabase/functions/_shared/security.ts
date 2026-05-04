// Helpers de segurança compartilhados entre Edge Functions.

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function validateWebhookSecret(req: Request): boolean {
  const expected = Deno.env.get("ZAPI_WEBHOOK_SECRET");
  if (!expected) return false;

  // Preferência: header X-Webhook-Secret (provedores que suportam header customizado).
  const headerSecret = req.headers.get("x-webhook-secret") ?? "";
  if (headerSecret && constantTimeEquals(headerSecret, expected)) return true;

  // Fallback: query string ?secret=... — necessário em painéis (ex: Z-API)
  // que não permitem configurar headers customizados no webhook.
  try {
    const url = new URL(req.url);
    const querySecret = url.searchParams.get("secret") ?? "";
    if (querySecret && constantTimeEquals(querySecret, expected)) return true;
  } catch {
    // ignore URL parse errors
  }

  return false;
}

export function requireInternalAuth(req: Request): boolean {
  const expected = Deno.env.get("INTERNAL_API_KEY");
  if (!expected) return false;
  const got = req.headers.get("x-internal-key") ?? "";
  return constantTimeEquals(got, expected);
}

export function sanitizePhone(phone?: string | null): string {
  if (!phone) return "***";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

const SENSITIVE_KEYS = new Set([
  "phone",
  "customer_phone",
  "name",
  "customer_name",
  "email",
  "customer_email",
]);

export function sanitizeLog<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) {
      if (k.includes("phone") && typeof v === "string") {
        out[k] = sanitizePhone(v);
      } else {
        out[k] = "***";
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function genRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function jsonLog(level: "info" | "warn" | "error", payload: Record<string, unknown>) {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), ...payload });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
