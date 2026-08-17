-- Hardening de funções apontadas pelo Security Advisor.
--
-- Escopo deliberadamente estreito:
--   * quatro trigger functions SECURITY DEFINER nunca devem ser RPCs;
--   * cinco funções recebem search_path imutável;
--   * normalize_br_phone é pura e passa a SECURITY INVOKER.
--
-- RPCs públicas e helpers de RLS não são tocados: eles têm grants deliberados
-- e são auditados pela allowlist em scripts/function-acl-allowlist.json.

begin;

-- Trigger functions não têm caller RPC legítimo. O nome não segue sempre o
-- prefixo trigger_ coberto pela migration 084, então os revokes são explícitos.
revoke all on function public.billing_plans_block_category_change()
  from public, anon, authenticated;
revoke all on function public.dispatch_waitlist_entered()
  from public, anon, authenticated;
revoke all on function public.enforce_operador_no_cancel()
  from public, anon, authenticated;
revoke all on function public.enqueue_confirmation_notification()
  from public, anon, authenticated;

-- Funções de trigger simples não precisam resolver objetos do schema público.
alter function public.set_waitlist_priority_from_category()
  set search_path = pg_catalog;
alter function public.set_waitlist_seated_at()
  set search_path = pg_catalog;
alter function public.validate_waitlist_status_transition()
  set search_path = pg_catalog;

-- Este trigger chama a normalizadora pelo nome qualificado public.normalize_br_phone.
alter function public.customers_force_canonical_phone()
  set search_path = public, pg_catalog;

-- Normalização é pura; SECURITY INVOKER mantém o uso pelo trigger sob anon sem
-- elevar privilégios e elimina a superfície SECURITY DEFINER desnecessária.
alter function public.normalize_br_phone(text)
  security invoker
  set search_path = pg_catalog;

commit;
