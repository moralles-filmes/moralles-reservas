-- Migration: Giftback hardening (auditoria 2026-05-17, bugs B4 + B5 + B17).
--
-- 1. UNIQUE PARTIAL em vouchers (unit_id, rule_id, customer_id) WHERE
--    status='active' — defense-in-depth contra race em re-entrada de webhook
--    (B4). Webhook-whatsapp já checa explicitamente antes do insert, mas dois
--    handlers concorrentes (reprocessing_stuck_message) podem passar o dedupe
--    e duplicar voucher pro mesmo cliente+regra. Constraint protege.
--
-- 2. CHECK que `min_rating` é NOT NULL quando `trigger_type='after_rating'`
--    (B5). UI sempre seta default=4, mas regras criadas via SQL/seed sem
--    min_rating fazem o webhook emitir voucher pra QUALQUER nota (1 a 5) —
--    inclusive cliente que avaliou mal. Backfill define 4★ pros NULL legados.
--
-- 3. B17 (reuso de code após used/expired): mantemos PARTIAL atual. Espaço
--    32^8 ≈ 1T torna colisão de code reciclado astronomicamente rara, e
--    `useFindVoucherByCode` filtra status='active' + unit_id — sem ambiguidade
--    pro operador. Decisão documentada aqui pra evitar revisita.

begin;

-- ─── 1. UNIQUE PARTIAL (unit_id, rule_id, customer_id) ────────────────────────
-- Apenas onde rule_id IS NOT NULL (vouchers manuais avulsos não têm regra).

-- Sanity: não deveria existir duplicata hoje (webhook já dedupa), mas se
-- existir por incidente histórico, cancela as cópias antigas mantendo o mais
-- recente. Mais barato do que falhar a migration.
update vouchers v
  set status = 'cancelled',
      notes = coalesce(notes || E'\n', '') || '[migration] cancelado em hardening — duplicata pre-existente'
  where status = 'active'
    and rule_id is not null
    and exists (
      select 1 from vouchers v2
       where v2.unit_id = v.unit_id
         and v2.rule_id = v.rule_id
         and v2.customer_id = v.customer_id
         and v2.status = 'active'
         and v2.issued_at > v.issued_at
    );

create unique index if not exists vouchers_unit_rule_customer_active_idx
  on vouchers (unit_id, rule_id, customer_id)
  where status = 'active' and rule_id is not null;

comment on index vouchers_unit_rule_customer_active_idx is
  'Defense contra duplicar voucher pro mesmo (rule, customer) ativo. webhook-whatsapp já checa antes do insert; este índice protege contra race em reprocessamento.';

-- ─── 2. min_rating obrigatório para trigger_type=after_rating ────────────────

-- Backfill: regras after_rating sem min_rating viram nota mínima 4.
update voucher_rules
  set min_rating = 4
  where trigger_type = 'after_rating'
    and min_rating is null;

-- CHECK: nova regra após o backfill exige min_rating quando after_rating.
alter table voucher_rules
  drop constraint if exists voucher_rules_min_rating_when_after_rating;

alter table voucher_rules
  add constraint voucher_rules_min_rating_when_after_rating
  check (trigger_type <> 'after_rating' or min_rating is not null);

-- ─── 3. Advisory lock wrapper para process-voucher-triggers (B12) ─────────────
-- pg_try_advisory_lock não é exposto via PostgREST por padrão. Wrappers em
-- public delegam para o lock nativo. Lock por (rule, customer) ativo já
-- existe via UNIQUE PARTIAL, mas advisory lock evita 2 cron runs concorrentes
-- duplicarem trabalho (cron + chamada manual de debug em paralelo).

create or replace function public.try_giftback_lock()
returns boolean
language sql
security definer
set search_path = public
as $$
  select pg_try_advisory_lock(0x7657c00::bigint);
$$;

create or replace function public.release_giftback_lock()
returns boolean
language sql
security definer
set search_path = public
as $$
  select pg_advisory_unlock(0x7657c00::bigint);
$$;

revoke all on function public.try_giftback_lock() from public, anon, authenticated;
revoke all on function public.release_giftback_lock() from public, anon, authenticated;
grant execute on function public.try_giftback_lock() to service_role;
grant execute on function public.release_giftback_lock() to service_role;

commit;
