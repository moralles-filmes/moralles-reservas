/**
 * Núcleo PURO da camada global do prompt do agente (spec Entrega B, §4 e §5).
 *
 * Nesta etapa (plano B2) o arquivo só declara constantes. Cada uma tem um gêmeo
 * no SQL da migration `*_ai_global_prompt_and_settings_value_guard.sql`, preso
 * por `src/lib/global-prompt-sql-twin.test.ts`:
 *   - `GLOBAL_PERSONA_BASELINE` é o seed da versão 1 (`$seed$…$seed$`), byte a
 *     byte, e o fallback do loader quando a leitura falha sem cache (D7);
 *   - `GLOBAL_PROMPT_PLACEHOLDERS` e `GLOBAL_PROMPT_MAX_CHARS` são os CHECKs de
 *     `ai_prompt_versions.body` (`app_private.ai_prompt_body_valid`);
 *   - `STORE_TEXT_LIMITS` e `AGENT_MODES` são o guard de valor de `settings`
 *     (`app_private.unit_setting_value_limit` e o enum de `agent_mode`).
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
