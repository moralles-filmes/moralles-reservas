-- Retenção de fatura para revisão administrativa (Fase 5b).
--
-- POR QUE EXISTE: ao ligar `billing_invoice_ingestion` pela primeira vez, a
-- reconciliação pode encontrar cobrança antiga já vencida há mais de cinco
-- dias. Sem freio, ela entraria direto na escada de inadimplência e suspenderia
-- alguém na primeira varredura, por dívida que nunca foi cobrada de verdade.
--
-- RETENÇÃO É EXCEPCIONAL, NÃO A REGRA. Fatura encontrada tarde por falha
-- temporária de webhook preserva vencimento e tolerância reais — é justamente
-- o caso que a reconciliação existe para consertar, e retê-la converteria o
-- conserto em atraso. Só retém: backfill inicial, cobrança anterior ao go-live
-- da ingestão, ambiguidade de correlação, divergência de valor, e revisão
-- manual pedida por um humano.

begin;

alter table billing_invoices
  add column if not exists ingestion_source text,
  add column if not exists enforcement_hold boolean not null default false,
  add column if not exists enforcement_hold_reason text,
  add column if not exists enforcement_held_at timestamptz,
  add column if not exists enforcement_released_at timestamptz,
  add column if not exists enforcement_released_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'billing_invoices_ingestion_source_chk'
  ) then
    alter table billing_invoices
      add constraint billing_invoices_ingestion_source_chk
      check (ingestion_source is null or ingestion_source in
             ('WEBHOOK', 'RECONCILE', 'BACKFILL', 'MANUAL'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'billing_invoices_hold_reason_chk'
  ) then
    alter table billing_invoices
      add constraint billing_invoices_hold_reason_chk
      check (enforcement_hold_reason is null or enforcement_hold_reason in
             ('INITIAL_BACKFILL', 'PRE_GO_LIVE_INVOICE', 'CORRELATION_AMBIGUITY',
              'VALUE_MISMATCH', 'MANUAL_REVIEW'));
  end if;

  -- Retida obriga motivo e data. Sem isto, uma fatura some da inadimplência
  -- sem nada explicando por quê, e vira cliente que nunca é cobrado.
  if not exists (
    select 1 from pg_constraint where conname = 'billing_invoices_hold_requires_reason_chk'
  ) then
    alter table billing_invoices
      add constraint billing_invoices_hold_requires_reason_chk
      check (
        enforcement_hold = false
        or (enforcement_hold_reason is not null and enforcement_held_at is not null)
      );
  end if;
end $$;

create index if not exists billing_invoices_enforcement_hold_idx
  on billing_invoices (organization_id, enforcement_held_at desc)
  where enforcement_hold = true;

comment on column billing_invoices.enforcement_hold is
  'Fatura retida para revisão administrativa: nenhum worker de inadimplência a considera. Ligada automaticamente só em backfill, cobrança pré-go-live da ingestão, ambiguidade de correlação e divergência de valor. Fatura paid/void/uncollectible nunca entra em hold por atraso.';

comment on column billing_invoices.ingestion_source is
  'De onde a linha veio: WEBHOOK (PAYMENT_CREATED/RECEIVED), RECONCILE (varredura periódica), BACKFILL (varredura sobre cobrança anterior ao go-live da ingestão), MANUAL (fatura criada pelo painel).';

commit;

-- =====================================================================
-- Validação pós-migration (esperado: 6 linhas, e 0 faturas retidas)
-- =====================================================================
--   select column_name from information_schema.columns
--    where table_name = 'billing_invoices'
--      and column_name like 'enforcement%' or column_name = 'ingestion_source';
--
--   select count(*) from billing_invoices where enforcement_hold;
--
-- 3. Excluir um usuário administrativo que liberou retenção NÃO é bloqueado,
--    NÃO apaga a fatura e zera apenas o ator. Rodar em sandbox, dentro da
--    transação abaixo — o `rollback` desfaz tudo:
--
--   begin;
--     update billing_invoices
--        set enforcement_released_at = now(),
--            enforcement_released_by = '<user_id de um platform admin>'
--      where id = '<invoice_id de teste>';
--
--     delete from auth.users where id = '<user_id de um platform admin>';
--     -- esperado: DELETE 1, sem erro de foreign key
--
--     select id, enforcement_released_by, enforcement_released_at
--       from billing_invoices where id = '<invoice_id de teste>';
--     -- esperado: 1 linha (a fatura sobreviveu — nada em cascata),
--     --           enforcement_released_by = null (só o ator sumiu),
--     --           enforcement_released_at preservado (a auditoria continua)
--   rollback;
--
-- Rollback:
--   drop index if exists billing_invoices_enforcement_hold_idx;
--   alter table billing_invoices
--     drop constraint if exists billing_invoices_hold_requires_reason_chk,
--     drop constraint if exists billing_invoices_hold_reason_chk,
--     drop constraint if exists billing_invoices_ingestion_source_chk,
--     drop column if exists enforcement_released_by,
--     drop column if exists enforcement_released_at,
--     drop column if exists enforcement_held_at,
--     drop column if exists enforcement_hold_reason,
--     drop column if exists enforcement_hold,
--     drop column if exists ingestion_source;
