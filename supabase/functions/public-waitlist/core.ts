import { canonicalBrPhone } from "../_shared/phone.ts";
import { validateBrPhone } from "../_shared/public-br-phone.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIORITIES = ["normal", "senior", "pregnant", "disabled", "other"] as const;

export interface PublicWaitlistInput {
  unitId: string;
  name: string;
  phone: string;
  partySize: number;
  notes: string | null;
  priority: typeof PRIORITIES[number];
  marketingOptIn: boolean;
}

export type PublicWaitlistResult =
  | { status: 400 | 403 | 429 | 503; body: { success: false; reason: string; message: string } }
  | { status: 200; body: { success: true; code: number; warning?: "registration_incomplete" | "consent_not_recorded" } };

export interface PublicWaitlistDeps {
  publicUnit: (unitId: string) => Promise<{ organizationId: string; billingStatus: string | null } | null>;
  rateLimit: (unitId: string) => Promise<boolean>;
  enter: (input: PublicWaitlistInput) => Promise<{ id: string; code: number } | null>;
  customer: (input: PublicWaitlistInput, organizationId: string) => Promise<string>;
  link: (waitlistId: string, unitId: string, customerId: string) => Promise<boolean>;
  consent: (unitId: string, customerId: string, waitlistId: string) => Promise<boolean>;
  onFailure: (failure: {
    stage: "customer" | "customer_link" | "consent";
    reason: "dependency_error";
    unitId: string;
    waitlistId: string;
    marketingOptIn: boolean;
  }) => void;
}

function rejected(status: 400 | 403 | 429 | 503, reason: string, message: string): PublicWaitlistResult {
  return { status, body: { success: false, reason, message } };
}

export function parsePublicWaitlistInput(raw: unknown): PublicWaitlistInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.unit_id !== "string" || !UUID.test(b.unit_id)) return null;
  if (typeof b.customer_name !== "string" || b.customer_name.trim().length < 2 || b.customer_name.trim().length > 120) return null;
  if (typeof b.customer_phone !== "string") return null;
  if (!validateBrPhone(b.customer_phone)) return null;
  const phone = canonicalBrPhone(b.customer_phone);
  if (!Number.isInteger(b.party_size) || (b.party_size as number) < 1 || (b.party_size as number) > 20) return null;
  if (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 1000)) return null;
  const priority = b.priority_category ?? "normal";
  if (typeof priority !== "string" || !PRIORITIES.includes(priority as typeof PRIORITIES[number])) return null;
  return {
    unitId: b.unit_id,
    name: b.customer_name.trim(),
    phone,
    partySize: b.party_size as number,
    notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
    priority: priority as typeof PRIORITIES[number],
    marketingOptIn: b.marketing_opt_in === true,
  };
}

/** The entry is committed by its RPC. Later failures never invite an entry retry. */
export async function submitPublicWaitlist(raw: unknown, deps: PublicWaitlistDeps): Promise<PublicWaitlistResult> {
  const input = parsePublicWaitlistInput(raw);
  if (!input) return rejected(400, "invalid_input", "Confira os dados da fila e tente novamente.");

  let unit: Awaited<ReturnType<PublicWaitlistDeps["publicUnit"]>>;
  try { unit = await deps.publicUnit(input.unitId); }
  catch { return rejected(503, "dependency_unavailable", "Não foi possível conferir a unidade agora."); }
  if (!unit) return rejected(403, "unit_unavailable", "Esta unidade não está aceitando entradas na fila.");
  if (unit.billingStatus === "blocked" || unit.billingStatus === "suspended") {
    return rejected(403, "unit_unavailable", "Esta unidade não está aceitando entradas na fila.");
  }

  let allowed: boolean;
  try { allowed = await deps.rateLimit(input.unitId); }
  catch { return rejected(503, "dependency_unavailable", "Não foi possível conferir o limite de tentativas agora."); }
  if (allowed !== true) return rejected(429, "rate_limited", "Muitas tentativas. Aguarde um instante e tente novamente.");

  let entry: Awaited<ReturnType<PublicWaitlistDeps["enter"]>>;
  try { entry = await deps.enter(input); }
  catch {
    return rejected(503, "entry_unavailable", "Não foi possível confirmar a entrada na fila. Confira com o restaurante antes de tentar novamente.");
  }
  if (!entry || !UUID.test(entry.id) || !Number.isInteger(entry.code)) {
    return rejected(503, "entry_unavailable", "Não foi possível confirmar a entrada na fila. Confira com o restaurante antes de tentar novamente.");
  }

  let customerId: string;
  try { customerId = await deps.customer(input, unit.organizationId); }
  catch {
    deps.onFailure({ stage: "customer", reason: "dependency_error", unitId: input.unitId, waitlistId: entry.id, marketingOptIn: input.marketingOptIn });
    return { status: 200, body: { success: true, code: entry.code, warning: "registration_incomplete" } };
  }
  let linked: boolean;
  try { linked = await deps.link(entry.id, input.unitId, customerId); }
  catch { linked = false; }
  if (linked !== true) {
    deps.onFailure({ stage: "customer_link", reason: "dependency_error", unitId: input.unitId, waitlistId: entry.id, marketingOptIn: input.marketingOptIn });
    return { status: 200, body: { success: true, code: entry.code, warning: "registration_incomplete" } };
  }

  if (input.marketingOptIn) {
    let recorded: boolean;
    try { recorded = await deps.consent(input.unitId, customerId, entry.id); }
    catch { recorded = false; }
    if (recorded !== true) {
      deps.onFailure({ stage: "consent", reason: "dependency_error", unitId: input.unitId, waitlistId: entry.id, marketingOptIn: input.marketingOptIn });
      return { status: 200, body: { success: true, code: entry.code, warning: "consent_not_recorded" } };
    }
  }
  return { status: 200, body: { success: true, code: entry.code } };
}
