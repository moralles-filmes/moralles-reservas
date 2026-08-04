/**
 * Lógica do formulário de instância que NÃO pode morar no componente (Fase 6c).
 *
 * Duas regras, cada uma com um defeito conhecido atrás:
 *
 * 1. `parseCostReais` — o usuário digita reais, a EF exige inteiro em centavos.
 *    A conversão inline que existia no painel (`.replace(/\./g,"").replace(",",".")`)
 *    lia "99.90" como 9990 reais. E `99.9 * 100` é `9990.000000000001` em JS,
 *    então a conversão é por STRING, não por float.
 *
 * 2. `buildUpdatePatch` — a EF decide o que gravar por `"campo" in body`. Mandar
 *    uma chave significa *escreva isto, inclusive `null`*. Um formulário ingênuo
 *    que enviasse o objeto inteiro APAGARIA o canal de quem só quis corrigir o
 *    identificador.
 */

export type CostReaisParse =
  | { ok: true; unknownCost: true }
  | { ok: true; unknownCost: false; cents: number }
  | { ok: false; message: string };

const COST_INVALID_MESSAGE =
  "Valor inválido. Informe apenas números, no formato 99,90 — ou deixe vazio se o custo for desconhecido.";

/** `9,90` ou `9.90` ou `990`: um separador decimal opcional, 1 ou 2 casas. */
const SIMPLE = /^(\d+)(?:[.,](\d{1,2}))?$/;
/** `1.234,56`: ponto de milhar SÓ quando a vírgula é o decimal. */
const BR_THOUSANDS = /^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/;

/**
 * Reais digitados → centavos inteiros.
 *
 * Vazio é DESCONHECIDO e é estado legítimo desta fase: o administrador registra
 * a instância antes de ter a fatura, e o ciclo fica em `PENDING_REVIEW` até o
 * número existir. Zero é diferente de desconhecido e passa — instância cortesia
 * tem custo zero VERDADEIRO.
 *
 * Ambiguidade é RECUSADA, não adivinhada: "1.234" pode ser mil duzentos e
 * trinta e quatro ou um e vinte e três, e chutar erraria por mil vezes num
 * campo que diz quanto a plataforma paga.
 */
export function parseCostReais(raw: string): CostReaisParse {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true, unknownCost: true };

  const br = BR_THOUSANDS.exec(value);
  if (br) return { ok: true, unknownCost: false, cents: toCents(br[1].replace(/\./g, ""), br[2]) };

  const simple = SIMPLE.exec(value);
  if (simple) return { ok: true, unknownCost: false, cents: toCents(simple[1], simple[2]) };

  return { ok: false, message: COST_INVALID_MESSAGE };
}

/** Inteiro e fração como STRING — nenhum float participa da conta. */
function toCents(intPart: string, fracPart: string | undefined): number {
  const frac = (fracPart ?? "").padEnd(2, "0");
  return Number(intPart) * 100 + Number(frac);
}

export type InstanceLinkFields = {
  unit_id: string | null;
  channel_id: string | null;
  provider_instance_ref: string | null;
  planned_provision_on: string | null;
};

const LINK_FIELDS: (keyof InstanceLinkFields)[] = [
  "unit_id",
  "channel_id",
  "provider_instance_ref",
  "planned_provision_on",
];

/** `""`, `null` e `undefined` são o MESMO valor ausente. */
function norm(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length === 0 ? null : t;
}

/**
 * Só o que MUDOU. Campo intocado não aparece; campo esvaziado aparece como
 * `null` (desvincular é uma intenção, e a EF precisa da chave para executá-la);
 * patch vazio significa que o caller NÃO deve disparar requisição.
 */
export function buildUpdatePatch(
  original: InstanceLinkFields,
  form: InstanceLinkFields,
): Partial<InstanceLinkFields> {
  const patch: Partial<InstanceLinkFields> = {};
  for (const field of LINK_FIELDS) {
    const before = norm(original[field]);
    const after = norm(form[field]);
    if (before !== after) patch[field] = after;
  }
  return patch;
}
