import type { WhatsAppProvider } from "@/types/reserva";
import { resolveUnitChannelBinding, type OrgChannelInput } from "../../../supabase/functions/_shared/whatsapp-org-provider-core";

/** Migração em curso: só o provider substituído; ids e credenciais nunca chegam aqui. */
export interface OfficialMigration { fromProvider: Exclude<WhatsAppProvider, "datafy"> }

// Record exaustivo: provider novo em `WhatsAppProvider` sem rótulo reprova no `tsc -b`.
const PROVIDER_LABEL: Record<WhatsAppProvider, string> = {
  zapi: "Z-API",
  uazapi: "UazAPI",
  waha: "WAHA",
  official: "API Oficial (Meta)",
  datafy: "Datafy",
};

function isKnownProvider(value: string): value is WhatsAppProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABEL, value);
}

export function migrationProviderLabel(provider: string): string {
  return isKnownProvider(provider) ? PROVIDER_LABEL[provider] : provider;
}

/** `created_at asc nulls last, id asc` — a mesma ordem do pin no SQL. */
function byCreatedAtThenId(a: { id: string; created_at?: string | null }, b: { id: string; created_at?: string | null }) {
  const ta = a.created_at ? Date.parse(a.created_at) : NaN;
  const tb = b.created_at ? Date.parse(b.created_at) : NaN;
  const va = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const vb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  if (va !== vb) return va < vb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Canal que uma liberação nova substituiria, espelhando o pin do servidor
 * (só para rótulo e aviso; quem decide é o trigger):
 * - binding da unidade de provider ≠ `datafy`;
 * - sem binding: a linha legada mais antiga (`is_active` nulo, qualquer status)
 *   de provider ≠ `datafy`;
 * - senão, nenhum. `is_active === false` nunca conta.
 */
export function resolveReplacedChannel<T extends OrgChannelInput & { id: string }>(
  channels: readonly T[] | null | undefined,
): T | null {
  const binding = resolveUnitChannelBinding(channels);
  if (binding) return binding.provider !== "datafy" ? binding : null;
  const legacy = (channels ?? []).filter((c) => !!c?.provider && c.provider !== "datafy"
    && (c.is_active === null || c.is_active === undefined));
  return legacy.length ? [...legacy].sort(byCreatedAtThenId)[0] : null;
}

/**
 * Aceita só `{ fromProvider }` com provider conhecido e diferente de `datafy`
 * (o servidor só prende migração a binding de outro provider); qualquer outra
 * forma vira `null`.
 */
export function projectMigration(value: unknown): OfficialMigration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const from = (value as Record<string, unknown>).fromProvider;
  return typeof from === "string" && isKnownProvider(from) && from !== "datafy" ? { fromProvider: from } : null;
}
