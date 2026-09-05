// Helper compartilhado para resolver (lookup-or-create) o customer numa reserva.
//
// Regras de merge — combinadas com a feature "deduplica por telefone":
//   1. Lookup por (organization_id, phone). UNIQUE constraint já garante 1:1.
//   2. Se EXISTE:
//        - NUNCA sobrescreve o nome cadastrado (preserva o nome original).
//        - Faz APPEND no array `emails` se vier e-mail novo (dedup case-insensitive).
//        - Preenche birthday só se hoje é null.
//   3. Se NÃO existe: insere customer novo com name/phone/email/birthday.
//
// Usado por:
//   - supabase/functions/create-reservation/index.ts
//   - supabase/functions/webhook-whatsapp/index.ts (tool createReservation)

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canonicalBrPhone } from "./phone.ts";

export interface ResolveCustomerInput {
  organizationId: string;
  phone: string;              // qualquer formato — normalizado p/ canônico aqui dentro
  name: string;
  email?: string | null;
  birthday?: string | null;   // YYYY-MM-DD
}

export interface ResolvedCustomer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  emails: string[];
  birthday: string | null;
}

const normalizeEmail = (e?: string | null): string | null => {
  if (!e) return null;
  const t = e.trim().toLowerCase();
  return t.length > 0 ? t : null;
};

export async function resolveOrCreateCustomer(
  supabase: SupabaseClient,
  input: ResolveCustomerInput,
): Promise<ResolvedCustomer> {
  const normEmail = normalizeEmail(input.email);
  // Canoniza o telefone (9º dígito) ANTES do lookup — senão o mesmo cliente em
  // dois formatos (com/sem 9) não casa e vira duplicata. Backstop no banco:
  // trigger customers_canonical_phone_trg força o canônico em qualquer write.
  const normPhone = canonicalBrPhone(input.phone);

  const { data: existing, error: lookupErr } = await supabase
    .from("customers")
    .select("id, name, phone, email, emails, birthday")
    .eq("organization_id", input.organizationId)
    .eq("phone", normPhone)
    .maybeSingle();

  if (lookupErr) throw lookupErr;

  if (existing) {
    // PRESERVA nome. Append email novo (dedup case-insensitive). Birthday só se null.
    const currentEmails: string[] = Array.isArray(existing.emails) ? existing.emails : [];
    let emailsNext = currentEmails;
    if (normEmail && !currentEmails.some((e) => e.toLowerCase() === normEmail)) {
      emailsNext = [...currentEmails, normEmail];
    }

    const updates: Record<string, unknown> = {};
    if (emailsNext !== currentEmails) updates.emails = emailsNext;
    if (input.birthday && !existing.birthday) updates.birthday = input.birthday;

    if (Object.keys(updates).length === 0) {
      return {
        id: existing.id,
        name: existing.name,
        phone: existing.phone,
        email: existing.email,
        emails: currentEmails,
        birthday: existing.birthday,
      };
    }

    const { data: updated, error: updErr } = await supabase
      .from("customers")
      .update(updates)
      .eq("id", existing.id)
      .select("id, name, phone, email, emails, birthday")
      .single();
    if (updErr) throw updErr;
    return {
      id: updated.id,
      name: updated.name,
      phone: updated.phone,
      email: updated.email,
      emails: Array.isArray(updated.emails) ? updated.emails : [],
      birthday: updated.birthday,
    };
  }

  // Novo customer
  const { data: created, error: insErr } = await supabase
    .from("customers")
    .insert({
      organization_id: input.organizationId,
      phone: normPhone,
      name: input.name.trim(),
      email: normEmail,                            // trigger replica em emails[0]
      emails: normEmail ? [normEmail] : [],
      birthday: input.birthday ?? null,
    })
    .select("id, name, phone, email, emails, birthday")
    .single();
  if (insErr?.code === "23505") {
    // Dois webhooks do mesmo telefone podem chegar juntos (inclusive no mesmo
    // lote Meta). O UNIQUE escolhe o vencedor; o perdedor relê a linha
    // canônica em vez de transformar uma corrida esperada em mensagem perdida.
    const { data: winner, error: winnerErr } = await supabase
      .from("customers")
      .select("id, name, phone, email, emails, birthday")
      .eq("organization_id", input.organizationId)
      .eq("phone", normPhone)
      .single();
    if (winnerErr) throw winnerErr;
    return {
      id: winner.id,
      name: winner.name,
      phone: winner.phone,
      email: winner.email,
      emails: Array.isArray(winner.emails) ? winner.emails : [],
      birthday: winner.birthday,
    };
  }
  if (insErr) throw insErr;
  return {
    id: created.id,
    name: created.name,
    phone: created.phone,
    email: created.email,
    emails: Array.isArray(created.emails) ? created.emails : [],
    birthday: created.birthday,
  };
}
