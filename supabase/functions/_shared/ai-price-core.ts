/**
 * Núcleo PURO do preço versionado de IA (Plano D, spec §17.1).
 *
 * ZERO IMPORTS — importável tanto pelas Edge Functions quanto pelo vitest.
 *
 * A LACUNA QUE ESTE ARQUIVO FECHA: `estimateCostUsd` em ai-providers.ts devolve
 * `0` para modelo fora da tabela de preços. Modelo desconhecido NÃO é gratuito;
 * no caminho protegido por orçamento esse zero significa consumo ilimitado sem
 * nunca tocar o teto. Aqui a ignorância tem tipo próprio (`PRICE_UNKNOWN`) e o
 * chamador é obrigado a tratá-la.
 *
 * `usd_to_brl` vive NA LINHA DE PREÇO, não em variável global: a taxa vigente
 * faz parte da vigência, e um câmbio "atual" aplicado a consumo antigo produz
 * custo histórico que muda sozinho. NÃO recalcular eventos históricos.
 */

export interface AiUsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
}

export interface AiModelPrice {
  id: string;
  provider: string;
  model: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
  cacheWriteUsdPerMtok: number;
  /** null = provedor não cobra faixa separada; o token de raciocínio é cobrado como OUTPUT. */
  reasoningUsdPerMtok: number | null;
  usdToBrl: number;
  effectiveFrom: string;
  /** EXCLUSIVO: primeiro instante NÃO coberto. */
  effectiveTo: string | null;
}

/**
 * União discriminada — D5. Sob `strict: false`, estreitar exige
 * `r.kind === "PRICED"` ou early-return; `if (!r.priced) { r.usd }` NÃO estreita.
 */
export type CostResult =
  | { kind: "PRICED"; usd: number; brlCents: number; priceId: string; usdToBrl: number }
  | { kind: "PRICE_UNKNOWN"; provider: string; model: string };

export type UsageClassification =
  | { kind: "USABLE"; usage: AiUsageTokens }
  | { kind: "MISSING" };

const ZERO_USAGE: AiUsageTokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
};

function toMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function nonNegative(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Vigência: `effective_from` INCLUSIVO, `effective_to` EXCLUSIVO — mesma
 * convenção de `provider_access_until` (6b) e de `cycle_end` (§17.3). O nome
 * admitiria duas leituras e a diferença de um instante é a que erra a virada.
 *
 * Entre vigências sobrepostas (erro de cadastro), vence a de `effective_from`
 * mais recente: cadastro novo sobrescreve, e nunca devolvemos linha arbitrária
 * — o problema aqui é o mesmo de `ilike + limit(1)` já registrado no CLAUDE.md.
 */
export function selectEffectivePrice(
  rows: AiModelPrice[],
  provider: string,
  model: string,
  atIso: string,
): AiModelPrice | null {
  const at = toMs(atIso);
  if (!Number.isFinite(at)) return null;

  const candidates = rows.filter((r) => {
    if (r.provider !== provider || r.model !== model) return false;
    const from = toMs(r.effectiveFrom);
    if (!Number.isFinite(from) || from > at) return false;
    if (r.effectiveTo) {
      const to = toMs(r.effectiveTo);
      if (!Number.isFinite(to) || to <= at) return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => toMs(b.effectiveFrom) - toMs(a.effectiveFrom));
  return candidates[0];
}

/**
 * Converte USD em centavos de BRL SEMPRE PARA CIMA.
 *
 * Arredondar para baixo é subcontabilizar: doze chamadas de fração de centavo
 * viram zero e o teto nunca é tocado. `Math.ceil` erra no máximo 1 centavo por
 * chamada, e erra na direção segura.
 */
export function usdToBrlCents(usd: number, usdToBrl: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(usdToBrl) || usd <= 0 || usdToBrl <= 0) return 0;
  return Math.ceil(usd * usdToBrl * 100);
}

export function priceUsage(
  price: AiModelPrice | null,
  usage: AiUsageTokens,
  provider: string,
  model: string,
): CostResult {
  if (!price) return { kind: "PRICE_UNKNOWN", provider, model };

  // Token de raciocínio sem faixa própria é cobrado como OUTPUT. Tratar como
  // grátis seria a mesma falha do modelo desconhecido, um nível abaixo.
  const reasoningRate = price.reasoningUsdPerMtok ?? price.outputUsdPerMtok;

  const usd =
    (usage.input_tokens * price.inputUsdPerMtok) / 1_000_000 +
    (usage.output_tokens * price.outputUsdPerMtok) / 1_000_000 +
    (usage.cache_read_tokens * price.cacheReadUsdPerMtok) / 1_000_000 +
    (usage.cache_creation_tokens * price.cacheWriteUsdPerMtok) / 1_000_000 +
    (usage.reasoning_tokens * reasoningRate) / 1_000_000;

  return {
    kind: "PRICED",
    usd: Number(usd.toFixed(6)),
    brlCents: usdToBrlCents(usd, price.usdToBrl),
    priceId: price.id,
    usdToBrl: price.usdToBrl,
  };
}

/**
 * "O provider devolveu usage suficiente?" — a segunda ignorância do fail-closed.
 *
 * MISSING quando não há NENHUM sinal de consumo de entrada ou saída. Um objeto
 * presente com só `cache_read_tokens` não prova que a chamada foi contabilizada:
 * toda resposta real consome input. Cair para "usage zerado" aqui é exatamente
 * o buraco de `callGeminiWithFallback` com resposta vazia (§17.7.6).
 */
export function classifyUsage(raw: unknown): UsageClassification {
  if (!raw || typeof raw !== "object") return { kind: "MISSING" };
  const r = raw as Record<string, unknown>;
  const input = nonNegative(r.input_tokens);
  const output = nonNegative(r.output_tokens);
  if (input === 0 && output === 0) return { kind: "MISSING" };
  return {
    kind: "USABLE",
    usage: {
      ...ZERO_USAGE,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: nonNegative(r.cache_read_tokens),
      cache_creation_tokens: nonNegative(r.cache_creation_tokens),
      reasoning_tokens: nonNegative(r.reasoning_tokens),
    },
  };
}
