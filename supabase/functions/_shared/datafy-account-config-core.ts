/**
 * Núcleo puro da credencial de conta da Datafy (`sk_acct_`).
 *
 * O token de conta alcança TODOS os canais da conta de parceiro da plataforma,
 * então a leitura é deliberadamente mais estrita que a de `stripe-config.ts` /
 * `asaas-config.ts`: aquelas caem para variável de ambiente em QUALQUER erro de
 * leitura, o que mantém credencial velha viva (CLAUDE.md). Aqui não existe
 * segunda fonte — leitura que falha vira `unavailable` e o chamador recusa a
 * operação (503).
 *
 * Valor não-string nunca é coagido com `String(...)`: `String({})` é
 * `"[object Object]"` e `String(["sk_acct_x"])` é `"sk_acct_x"`, e o segundo
 * passaria na checagem de prefixo. Só `typeof` distingue.
 *
 * Vive fora do adapter porque o vitest não importa arquivo com `esm.sh` e
 * globais do runtime da EF; decisão escrita lá só se confere por leitura. Este
 * arquivo não toca o runtime (guarda estática no teste).
 *
 * Também é a régua do cadastro: `manage-platform-secrets` valida o valor
 * enviado com `decideAccountTokenRead`, para que o painel recuse o que a
 * leitura recusaria.
 */

/** Chave em `platform_secrets`. */
export const DATAFY_ACCOUNT_TOKEN_KEY = "datafy_account_token";

/** Prefixo do token de conta de parceiro (o token de canal é `sk_live_`). */
export const DATAFY_ACCOUNT_TOKEN_PREFIX = "sk_acct_";

/** Mesmo TTL dos irmãos: reflete troca feita no painel em até 5 min. */
export const DATAFY_ACCOUNT_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// Prefixo + ao menos um caractere ASCII visível, sem espaço nem controle: o
// token vai num header HTTP, e quebra de linha ali faria o `fetch` lançar.
const TOKEN_SHAPE = new RegExp(`^${DATAFY_ACCOUNT_TOKEN_PREFIX}[\\x21-\\x7e]+$`);

export type DatafyAccountTokenRead =
  | { ok: true; token: string }
  | { ok: false; reason: "missing" | "malformed" | "unavailable" };

export interface DatafyAccountTokenReadInput {
  row: { value: unknown } | null;
  error: unknown;
}

/**
 * Decide o desfecho de UMA leitura de `platform_secrets`.
 *
 * Erro vence a linha: com erro, nunca devolve token, mesmo que a linha pareça
 * válida.
 */
export function decideAccountTokenRead(input: DatafyAccountTokenReadInput): DatafyAccountTokenRead {
  if (input.error !== null && input.error !== undefined) {
    return { ok: false, reason: "unavailable" };
  }
  if (input.row === null || input.row === undefined) {
    return { ok: false, reason: "missing" };
  }

  const value = input.row.value;
  if (typeof value !== "string") return { ok: false, reason: "malformed" };

  const token = value.trim();
  if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: "malformed" };

  return { ok: true, token };
}

export interface DatafyAccountTokenReaderDeps {
  /** Uma leitura de `platform_secrets`; pode lançar (rede, cliente sem env). */
  read: () => Promise<DatafyAccountTokenReadInput>;
  /** Relógio do cache local (só decide reuso em memória, nunca posse). */
  now: () => number;
}

export interface DatafyAccountTokenReader {
  get: () => Promise<DatafyAccountTokenRead>;
  clear: () => void;
}

/**
 * Leitor com cache de 5 min SÓ do sucesso. Falha nunca fica em cache (o token
 * cadastrado logo depois vale na chamada seguinte) e, vencido o TTL, falha de
 * leitura recusa em vez de reaproveitar o token antigo como reserva.
 *
 * `clear()` avança uma geração: leitura que já estava em voo quando o cache foi
 * limpo (rotação no painel) devolve o que leu ao próprio chamador, mas não
 * grava no cache — senão o token anterior à rotação voltaria por mais 5 min.
 */
export function createDatafyAccountTokenReader(deps: DatafyAccountTokenReaderDeps): DatafyAccountTokenReader {
  let cached: { token: string; fetchedAt: number } | null = null;
  let generation = 0;

  return {
    async get(): Promise<DatafyAccountTokenRead> {
      if (cached && deps.now() - cached.fetchedAt < DATAFY_ACCOUNT_TOKEN_CACHE_TTL_MS) {
        return { ok: true, token: cached.token };
      }
      cached = null;
      const startedAt = generation;

      let decision: DatafyAccountTokenRead;
      try {
        decision = decideAccountTokenRead(await deps.read());
      } catch {
        decision = { ok: false, reason: "unavailable" };
      }

      if (decision.ok === true && generation === startedAt) {
        cached = { token: decision.token, fetchedAt: deps.now() };
      }
      return decision;
    },
    clear(): void {
      cached = null;
      generation += 1;
    },
  };
}
