-- Instagram, Fase 1 (Task 1.5): `reservations.source` passa a aceitar
-- 'instagram', a origem da reserva feita pelo agente no Direct.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Task 1.5 e a decisão D6)
-- Pré-voo: supabase/tests/local-preflight/79a-instagram-bootstrap.sql (seção
--          3c) e 79-instagram-module.sql (README, seção "79 — Módulo
--          Instagram"), casos IG-5.1..IG-5.2 e controles C-IG-5.x.
--
-- O CHECK nasceu inline na 022 (20260506181440), então tem o nome automático
-- `reservations_source_check`. Ele é derrubado e recriado POR NOME com a lista
-- nova; um ADD sem o DROP somaria um segundo CHECK ao antigo e o antigo
-- continuaria recusando 'instagram'. Entra NOT VALID e é validado em seguida
-- (as linhas existentes são 'web'/'whatsapp', contidas na lista nova).
--
-- D6 — CONFIRMAÇÃO DA RESERVA DO INSTAGRAM PELO WHATSAPP. O trigger
-- `enqueue_confirmation_notification` (028, `enqueue_confirmation_after_insert`)
-- NÃO MUDA: ele continua pulando só 'whatsapp' (o agente do WhatsApp confirma
-- na conversa). A reserva 'instagram' enfileira a `confirmation` em
-- `notification_outbox` como a 'web'. Isso vale na ROTA LEGADA do outbox. A
-- ROTA GERENCIADA de automação ainda recusa `source='instagram'` (fail-closed,
-- nada é enviado): `captureExpected` em
-- `_shared/whatsapp-automation-resources.ts:168-170` só aceita web/whatsapp, e
-- `app_private.whatsapp_automation_post_inner` (20261019193132:1006) devolve
-- `snapshot_invalid`. Lacuna registrada no plano, pendente de decisão do dono
-- antes do grant do piloto (Bloco 6); esta migration não a resolve.
-- Prova do lado do trigger: IG-5.1 (a reserva 'instagram' enfileira a
-- confirmação) e C-IG-5.1 (com o filtro `not in ('whatsapp','instagram')` o
-- IG-5.1 reprova).
--
-- `reservations` é tabela quente de produção: o DROP/ADD pede ACCESS
-- EXCLUSIVE. Com `lock_timeout` a migration desiste em 5 s em vez de ficar na
-- fila atrás de uma leitura longa e travar toda escrita de reserva atrás dela.
-- Desistiu: nada muda (a transação inteira volta) e basta repetir o push.
-- Numa transação só, o NOT VALID + VALIDATE NÃO encurta o ACCESS EXCLUSIVE:
-- o lock do DROP/ADD fica até o COMMIT e o VALIDATE varre a tabela debaixo
-- dele. O par fica para seguir o padrão do plano (e deixar explícito que as
-- linhas existentes foram conferidas); a tabela é pequena e o `lock_timeout`
-- limita a espera na fila. Separar o VALIDATE numa segunda transação só vale
-- reavaliar se a tabela crescer muito.
--
-- Antes do COMMIT, uma guarda exige exatamente UM CHECK sobre `source`, e
-- validado; outro CHECK de origem com outro nome (drift) aborta a migration
-- inteira com `reservations_source_check_drift` (P0001), sem mudar nada.
--
-- Idempotente: reaplicar derruba e recria o mesmo CHECK. Sem função nova,
-- sem grant, sem URL do projeto e sem segredo.

begin;
set local lock_timeout = '5s';

alter table public.reservations
  drop constraint if exists reservations_source_check;
alter table public.reservations
  add constraint reservations_source_check
  check (source in ('web', 'whatsapp', 'instagram')) not valid;
alter table public.reservations
  validate constraint reservations_source_check;

do $$
declare
  v_total integer;
  v_ok    integer;
begin
  select count(*),
         count(*) filter (where c.conname = 'reservations_source_check' and c.convalidated)
    into v_total, v_ok
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.reservations'::regclass
     and c.contype = 'c'
     and pg_catalog.pg_get_constraintdef(c.oid) ~ '\msource\M';
  if v_total <> 1 or v_ok <> 1 then
    raise exception 'reservations_source_check_drift'
      using errcode = 'P0001',
            detail = format('esperado 1 CHECK de source (reservations_source_check, validado); encontrados %s, validos com o nome %s', v_total, v_ok);
  end if;
end;
$$;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Um CHECK de origem, validado, com a lista nova (esperado: 1 linha,
--    convalidated = true):
--   select conname, convalidated, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.reservations'::regclass and contype = 'c'
--      and pg_get_constraintdef(oid) like '%source%';
--
-- 2. O trigger de confirmação continua o da 028 (esperado: o corpo filtra só
--    'whatsapp'):
--   select prosrc from pg_proc
--    where oid = 'public.enqueue_confirmation_notification()'::regprocedure;
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Só depois de confirmar que não há reserva 'instagram' (senão o VALIDATE
-- falha):
--   begin; set local lock_timeout = '5s';
--   alter table public.reservations drop constraint if exists reservations_source_check;
--   alter table public.reservations add constraint reservations_source_check
--     check (source in ('web', 'whatsapp')) not valid;
--   alter table public.reservations validate constraint reservations_source_check;
--   commit;
