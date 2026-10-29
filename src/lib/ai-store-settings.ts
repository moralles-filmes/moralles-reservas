/**
 * Chaves de `settings` que a Gestão grava na tela "Atendimento por IA"
 * (`/g/:unitSlug/atendimento-ia`). São da classe `manager` em
 * `app_private.unit_setting_write_class`: owner e gerente gravam. As demais
 * chaves do agente (`ai_config`, `ai_system_prompt`, `ai_context_extra`,
 * `agent_mode`, `agent_name`) continuam só da plataforma.
 *
 * Sem import do client Supabase: `scripts/settings-write-acl.test.ts` importa
 * esta constante e compara com o classificador SQL.
 */
export const AI_STORE_SETTING_KEYS = [
  "restaurant_menu",
  "delivery_response",
  "restaurant_extra_info",
] as const;

export type AiStoreSettingKey = (typeof AI_STORE_SETTING_KEYS)[number];
