/**
 * Núcleo PURO da camada global do prompt do agente (spec Entrega B, §4, §5 e §8):
 * validação gêmea do CHECK SQL, renderização dos placeholders e decisão da
 * fonte (banco, cache vencido ou baseline). O I/O fica em `global-prompt.ts`.
 *
 * Constantes com gêmeo no SQL da migration
 * `*_ai_global_prompt_and_settings_value_guard.sql`, presas por
 * `src/lib/global-prompt-sql-twin.test.ts`:
 *   - `GLOBAL_PERSONA_BASELINE` é o seed da versão 1 (`$seed$…$seed$`), byte a
 *     byte, e o fallback do loader quando a leitura falha sem cache (D7);
 *   - `GLOBAL_PROMPT_PLACEHOLDERS` e `GLOBAL_PROMPT_MAX_CHARS` são os CHECKs de
 *     `ai_prompt_versions.body` (`app_private.ai_prompt_body_valid`);
 *   - `STORE_TEXT_LIMITS` e `AGENT_MODES` são o guard de valor de `settings`
 *     (`app_private.unit_setting_value_limit` e o enum de `agent_mode`);
 *   - `CONTROL_CHAR_CLASS` é a classe de controle do corpo e do guard de valor.
 * Mudar um lado sem o outro reprova o teste.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase.
 */

/** Único slot da camada global hoje (CHECK de `ai_prompt_*.slot`). */
export const GLOBAL_PROMPT_SLOT = "global_persona" as const;

/**
 * Únicos `{{…}}` aceitos no corpo, resolvidos por substituição literal pelos
 * mesmos `agentName`/`restaurantName` de hoje. Qualquer outro é recusado ao
 * publicar.
 */
export const GLOBAL_PROMPT_PLACEHOLDERS = ["agent_name", "restaurant_name"] as const;

/** Tamanho máximo do corpo da camada global, em caracteres. */
export const GLOBAL_PROMPT_MAX_CHARS = 4000;

/**
 * Trecho contíguo de `composeAgentSystemPrompt` (de `IDENTIDADE:` até
 * `Evite excesso de emojis. `, com o espaço final), com os placeholders no
 * lugar das interpolações. Renderizado, reproduz o prompt atual byte a byte.
 */
export const GLOBAL_PERSONA_BASELINE =
  `IDENTIDADE: Você se chama {{agent_name}} e atende como parte da equipe do {{restaurant_name}} — fale sempre na primeira pessoa, de forma natural e humana, tratando o cliente por "você". NÃO diga espontaneamente que é um assistente virtual, robô, IA, bot ou sistema automático, e não use linguagem robótica. Só revele que é um atendimento virtual se o cliente perguntar DIRETAMENTE se está falando com um robô/IA/atendente automático — nesse caso seja honesta e responda com naturalidade (ex: "Sou a {{agent_name}}, faço o atendimento virtual do {{restaurant_name}} e quando precisar chamo alguém da equipe"). Ao transferir para um colega (handoff), dizer que vai chamar alguém da equipe NÃO exige revelar que você é virtual. ` +
  `Seja cordial, eficiente e responda sempre em português brasileiro. Respostas curtas e diretas — em geral 3 a 4 linhas; use mais espaço só quando precisar listar horários, opções ou preços. Evite excesso de emojis. `;

/** Valores aceitos em `settings.agent_mode`. */
export const AGENT_MODES = ["reservations", "reservations_faq"] as const;

/**
 * Limite, em caracteres, dos textos livres de `settings` que entram no prompt
 * (spec §4.3). O banco recusa acima disso (`setting_value_invalid`) para todo
 * papel; o núcleo também trunca na renderização para cobrir linha legada.
 */
export const STORE_TEXT_LIMITS = {
  restaurant_menu: 6000,
  restaurant_extra_info: 3000,
  delivery_response: 1500,
  rules_and_conditions: 3000,
  additional_info: 2000,
  ai_context_extra: 3000,
  ai_system_prompt: 4000,
  agent_name: 40,
} as const;

/**
 * Caracteres de controle recusados, além de `\n` e `\t` (inclui `\r`). É o
 * conteúdo da classe `[...]` do SQL, byte a byte. NUL não entra: o Postgres o
 * recusa antes de qualquer função; quem limpa texto em TS acrescenta `\x00`.
 */
export const CONTROL_CHAR_CLASS = "\\x01-\\x08\\x0b-\\x1f\\x7f";

const CONTROL_CHAR_RE = new RegExp(`[\\x00${CONTROL_CHAR_CLASS}]`);
const KNOWN_PLACEHOLDER_RE = new RegExp(`\\{\\{(${GLOBAL_PROMPT_PLACEHOLDERS.join("|")})\\}\\}`, "g");

/** Tamanho como o `char_length` do Postgres: code points, não unidades UTF-16. */
export function charLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Gêmea de `app_private.ai_prompt_body_valid`: 1 a 4000 caracteres, algum não
 * branco, só os placeholders conhecidos, sem `<<<`/`>>>` (delimitadores dos
 * dados da loja) e sem controle além de `\n`/`\t`.
 */
export function isValidGlobalPromptBody(body: unknown): body is string {
  if (typeof body !== "string") return false;
  const len = charLength(body);
  if (len < 1 || len > GLOBAL_PROMPT_MAX_CHARS) return false;
  if (!/\S/.test(body)) return false;
  if (/\{\{|\}\}/.test(body.replace(KNOWN_PLACEHOLDER_RE, ""))) return false;
  if (/<<<|>>>/.test(body)) return false;
  return !CONTROL_CHAR_RE.test(body);
}

/**
 * Substituição literal, numa passada só: o valor nunca é reavaliado (um nome
 * com `{{agent_name}}` ou `$&` sai como está). Sem template engine.
 */
export function renderGlobalLayer(body: string, names: { agentName: string; restaurantName: string }): string {
  return body.replace(KNOWN_PLACEHOLDER_RE, (_, key: string) =>
    key === "agent_name" ? names.agentName : names.restaurantName,
  );
}

/** Cache por isolate: invalidação só por TTL (publicar chega em ≤60s). */
export const GLOBAL_PROMPT_CACHE_TTL_MS = 60_000;

/** `global_prompt_version` quando o texto é o embarcado, não uma versão do banco. */
export const GLOBAL_PROMPT_BASELINE_VERSION = "baseline";

/**
 * `db`: conteúdo do banco, lido agora ou há menos de 60s; `stale_cache`: a
 * leitura falhou e valeu o último lido (qualquer idade); `baseline`: falhou sem
 * cache e valeu `GLOBAL_PERSONA_BASELINE`.
 */
export type GlobalPromptSource = "db" | "stale_cache" | "baseline";

export interface GlobalPromptCacheEntry {
  versionId: string;
  body: string;
  fetchedAtMs: number;
}

export type GlobalPromptRead =
  | { ok: true; versionId: unknown; body: unknown }
  | { ok: false; reason: string; code?: string | null };

export interface GlobalPromptResolution {
  body: string;
  /** Id da versão ativa, ou `baseline`. */
  version: string;
  source: GlobalPromptSource;
  /** Estado do cache depois desta resolução. */
  cache: GlobalPromptCacheEntry | null;
  /** Presente nos dois caminhos de falha; nunca carrega o corpo. */
  failure: { reason: string; code: string | null } | null;
}

/** Cache dentro do TTL serve sem ler o banco. Relógio que voltou não serve. */
export function freshCachedGlobalPrompt(
  cache: GlobalPromptCacheEntry | null,
  nowMs: number,
): GlobalPromptResolution | null {
  if (!cache) return null;
  const age = nowMs - cache.fetchedAtMs;
  if (age < 0 || age >= GLOBAL_PROMPT_CACHE_TTL_MS) return null;
  return { body: cache.body, version: cache.versionId, source: "db", cache, failure: null };
}

/**
 * Polaridade D7 — a leitura FALHA ABERTA, por decisão do usuário (2026-10-19):
 *   - leitura OK e corpo válido → usa e põe no cache;
 *   - erro de leitura (inclusive tabela ausente, `42P01`/`PGRST205`, antes do
 *     `db push`) ou corpo inválido → cache de qualquer idade; sem cache,
 *     `GLOBAL_PERSONA_BASELINE`.
 * Por quê: as regras de segurança do agente estão no núcleo e não dependem
 * desta leitura; negar calaria todas as lojas a cada soluço de banco, e seguir
 * sem a camada perderia a persona sem aviso. O chamador emite
 * `ai_global_prompt_read_failed` quando `failure` vem preenchido.
 */
export function resolveGlobalPrompt(
  read: GlobalPromptRead,
  cache: GlobalPromptCacheEntry | null,
  nowMs: number,
): GlobalPromptResolution {
  let failure: { reason: string; code: string | null };
  if (read.ok === false) {
    failure = { reason: read.reason, code: read.code ?? null };
  } else if (typeof read.versionId !== "string" || read.versionId === "") {
    failure = { reason: "invalid_version_id", code: null };
  } else if (!isValidGlobalPromptBody(read.body)) {
    failure = { reason: "invalid_body", code: null };
  } else {
    const fresh = { versionId: read.versionId, body: read.body, fetchedAtMs: nowMs };
    return { body: fresh.body, version: fresh.versionId, source: "db", cache: fresh, failure: null };
  }
  if (cache) return { body: cache.body, version: cache.versionId, source: "stale_cache", cache, failure };
  return {
    body: GLOBAL_PERSONA_BASELINE,
    version: GLOBAL_PROMPT_BASELINE_VERSION,
    source: "baseline",
    cache: null,
    failure,
  };
}
