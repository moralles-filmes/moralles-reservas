/**
 * Qual provedor de WhatsApp uma organizacao usa DE FATO.
 *
 * `organizations.default_whatsapp_provider` e preferencia administrativa — o
 * que o admin autoriza provisionar. A troca de canal roda por
 * `activate_whatsapp_channel` e NAO reescreve essa coluna, entao ler a
 * preferencia como se fosse realidade mostra "Z-API" para unidade rodando
 * UazAPI. Quem responde "quem esta no ar" e `whatsapp_channels`.
 *
 * A regra de binding aqui replica a de `whatsapp-send.ts` e `webhook-whatsapp`:
 * havendo linha `is_active = true` na unidade, so ela participa; `false` nunca
 * participa; o fallback pelo primeiro `connected` existe apenas entre linhas
 * legadas `NULL`, e somente quando a unidade nao tem nenhuma linha explicita.
 * Divergir daqui faz o painel afirmar um provedor e o envio usar outro.
 */

export interface OrgChannelInput {
  provider: string | null;
  status: string | null;
  is_active: boolean | null;
  created_at?: string | null;
}

export interface OrgUnitInput {
  whatsapp_channels?: readonly OrgChannelInput[] | null;
}

export type OrgWhatsAppProviderSource = "channels" | "default";

export interface OrgWhatsAppProviders {
  /** Nomes dos provedores realmente vinculados, ordenados e sem repeticao. */
  providers: string[];
  /** `channels` = lido do binding real; `default` = nenhum canal, sobrou a preferencia. */
  source: OrgWhatsAppProviderSource;
}

/** Ordena por `created_at` crescente; linha sem data vai para o fim (ordem estavel). */
function byCreatedAtAsc(a: OrgChannelInput, b: OrgChannelInput): number {
  const ta = a.created_at ? Date.parse(a.created_at) : NaN;
  const tb = b.created_at ? Date.parse(b.created_at) : NaN;
  const va = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const vb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  return va - vb;
}

/**
 * A linha que opera a unidade, ou `null` quando nenhuma opera.
 *
 * Canal ativo porem desconectado continua sendo o binding: e ele que voltara a
 * enviar quando reconectar, e nenhum outro pode assumir enquanto ele existir.
 *
 * Devolve a PROPRIA linha recebida (generico so no tipo): quem passa `id`
 * recebe o `id` do binding. Empate de `created_at` mantem a ordem de entrada;
 * para casar com o SQL (`created_at asc nulls last, id`), quem consulta ordena
 * a leitura por `created_at` e depois `id`.
 */
export function resolveUnitChannelBinding<T extends OrgChannelInput>(
  channels: readonly T[] | null | undefined,
): T | null {
  const rows = (channels ?? []).filter((c) => !!c?.provider);
  if (rows.length === 0) return null;

  const explicitActive = rows.filter((c) => c.is_active === true);
  if (explicitActive.length > 0) {
    // O indice parcial `whatsapp_channels_one_active_per_unit_idx` garante uma
    // so; o sort mantem determinismo se a garantia sumir do banco.
    return [...explicitActive].sort(byCreatedAtAsc)[0];
  }

  // `false` e sempre inativo — nunca entra no fallback legado.
  const legacyConnected = rows.filter(
    (c) => c.is_active === null || c.is_active === undefined,
  ).filter((c) => c.status === "connected");
  if (legacyConnected.length === 0) return null;

  return [...legacyConnected].sort(byCreatedAtAsc)[0];
}

/**
 * Provedores em operacao na organizacao (uniao dos bindings das unidades).
 *
 * Sem nenhum binding, devolve a preferencia com `source: "default"` — cabe a
 * quem exibe dizer que aquilo e padrao, nao realidade.
 */
export function resolveOrganizationWhatsAppProviders(input: {
  units?: readonly OrgUnitInput[] | null;
  defaultProvider?: string | null;
}): OrgWhatsAppProviders {
  const providers = new Set<string>();

  for (const unit of input.units ?? []) {
    const binding = resolveUnitChannelBinding(unit?.whatsapp_channels);
    if (binding?.provider) providers.add(binding.provider);
  }

  if (providers.size > 0) {
    return { providers: [...providers].sort(), source: "channels" };
  }

  const fallback = String(input.defaultProvider ?? "").trim();
  return {
    providers: fallback ? [fallback] : [],
    source: "default",
  };
}
