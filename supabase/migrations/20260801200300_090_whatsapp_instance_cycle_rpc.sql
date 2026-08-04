-- Rolagem de ciclo: UMA operação transacional e idempotente (Fase 6b §7.1).
--
-- Fechar o ciclo vencido, abrir o próximo e projetar na instância acontecem
-- juntos ou não acontecem. NUNCA pode existir estado intermediário persistido
-- em que o anterior fechou e o próximo não nasceu, ou em que a projeção da
-- instância aponta para datas diferentes do ciclo OPEN.
--
-- A ARITMÉTICA DE CALENDÁRIO NÃO MORA AQUI: `p_next_due_on` chega pronto do
-- núcleo puro (nextDueFromAnchor), testado em vitest com os dez casos de §6.4.
-- Reimplementar o clamp em plpgsql criaria uma segunda verdade sobre a âncora
-- — exatamente o que §6.3 proíbe.
--
-- O LOCK NÃO É A GARANTIA. Advisory lock é session-scoped e não sobrevive de
-- forma confiável ao pooling transaction-mode do PgBouncer (foi por isso que o
-- lock de conversa usa TTL em coluna, migration 056). A correção vem da
-- transação + UNIQUE (instance_id, cycle_start) + UNIQUE (instance_id) WHERE
-- status='OPEN'. O lock economiza trabalho; ele não é o invariante.

begin;

create or replace function public.roll_whatsapp_instance_cycle(
  p_instance_id uuid,
  p_today date,
  p_next_due_on date
)
returns table (action text, closed_cycle_id uuid, opened_cycle_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
  v_open record;
  v_closed_id uuid;
  v_opened_id uuid;
  v_status text;
begin
  -- FOR UPDATE serializa duas execuções simultâneas na mesma instância mesmo
  -- sem o advisory lock.
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  if not found then
    return query select 'INSTANCE_NOT_FOUND'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_inst.lifecycle_state not in ('ACTIVE', 'CANCELLATION_REQUESTED') then
    return query select 'SKIPPED_LIFECYCLE'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_open
  from whatsapp_instance_cycles
  where instance_id = p_instance_id and status = 'OPEN'
  for update;

  if not found then
    return query select 'NO_OPEN_CYCLE'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Fim EXCLUSIVO: `>=` e não `>`. Com `>` a rolagem sairia um dia atrasada.
  if p_today < v_open.provider_due_on then
    return query select 'NOT_DUE'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Custo desconhecido não fecha como financeiramente concluído.
  v_status := case when v_open.provider_cost_cents is null then 'PENDING_REVIEW' else 'CLOSED' end;

  update whatsapp_instance_cycles
     set status = v_status, closed_at = now()
   where id = v_open.id
  returning id into v_closed_id;

  -- Instância em cancelamento NÃO abre ciclo novo além de provider_access_until.
  if v_inst.lifecycle_state = 'CANCELLATION_REQUESTED'
     and v_inst.provider_access_until is not null
     and v_open.provider_due_on >= v_inst.provider_access_until then
    update whatsapp_instances
       set current_cycle_started_on = null,
           current_cycle_due_on = null,
           updated_at = now()
     where id = p_instance_id;
    return query select 'CLOSED_NO_REOPEN'::text, v_closed_id, null::uuid;
    return;
  end if;

  -- Custo congelado na ABERTURA: o custo vigente quando a competência começa.
  -- Receita e margem ficam NULL aqui e são preenchidas pelo worker, que é quem
  -- conhece assinatura e override — plpgsql não replica a política de §7.3.
  insert into whatsapp_instance_cycles (
    instance_id, organization_id, cycle_start, provider_due_on, status,
    provider_cost_cents, cost_source, cost_snapshot_at
  ) values (
    p_instance_id, v_inst.organization_id, v_open.provider_due_on, p_next_due_on, 'OPEN',
    v_inst.current_monthly_cost_cents, v_inst.cost_source,
    case when v_inst.current_monthly_cost_cents is null then null else now() end
  )
  on conflict (instance_id, cycle_start) do nothing
  returning id into v_opened_id;

  if v_opened_id is null then
    -- Reexecução: o ciclo já existia. Idempotente, não é erro.
    select id into v_opened_id from whatsapp_instance_cycles
     where instance_id = p_instance_id and cycle_start = v_open.provider_due_on;
  end if;

  update whatsapp_instances
     set current_cycle_started_on = v_open.provider_due_on,
         current_cycle_due_on = p_next_due_on,
         cycle_source = 'SYSTEM_ROLLED',
         updated_at = now()
   where id = p_instance_id;

  return query select 'ROLLED'::text, v_closed_id, v_opened_id;
end;
$$;

comment on function public.roll_whatsapp_instance_cycle(uuid, date, date) is
  'Fecha o ciclo vencido, abre o proximo e projeta na instancia — tudo numa transacao. Idempotente. p_next_due_on vem do nucleo puro; a aritmetica de calendario NAO e reimplementada aqui.';

-- Advisory lock do worker, mesmo padrão do giftback, com chave PRÓPRIA.
-- Falha aberta é aceitável: a garantia real está nos UNIQUE.
create or replace function public.try_whatsapp_instance_cycles_lock()
returns boolean
language sql
security definer
set search_path = public, pg_catalog
as $$
  select pg_try_advisory_lock(hashtext('whatsapp_instance_cycles_worker'));
$$;

create or replace function public.release_whatsapp_instance_cycles_lock()
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  select pg_advisory_unlock(hashtext('whatsapp_instance_cycles_worker'));
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key. Revogar PUBLIC **e** os grants diretos.
revoke all on function public.roll_whatsapp_instance_cycle(uuid, date, date) from public, anon, authenticated;
revoke all on function public.try_whatsapp_instance_cycles_lock() from public, anon, authenticated;
revoke all on function public.release_whatsapp_instance_cycles_lock() from public, anon, authenticated;

grant execute on function public.roll_whatsapp_instance_cycle(uuid, date, date) to service_role;
grant execute on function public.try_whatsapp_instance_cycles_lock() to service_role;
grant execute on function public.release_whatsapp_instance_cycles_lock() to service_role;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL das três funções (esperado: nenhuma com anon= ou authenticated=):
--   select proname, proacl from pg_proc
--    where proname in ('roll_whatsapp_instance_cycle',
--                      'try_whatsapp_instance_cycles_lock',
--                      'release_whatsapp_instance_cycles_lock');
--
-- 2. search_path fixado nas três (esperado: search_path=... em cada uma):
--   select proname, proconfig from pg_proc
--    where proname like '%whatsapp_instance_cycle%';
--
-- 3. Idempotência: chamar duas vezes com a mesma entrada não duplica ciclo
--    (esperado: a 2a devolve NOT_DUE ou o mesmo opened_cycle_id):
--   select * from roll_whatsapp_instance_cycle('<instancia>', current_date, '<proxima>');
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Estes três drops são o DEGRAU 2 da sequência. A ordem inversa completa da
-- fase (092 → 090 → 089 → 088 → 087), com a advertência sobre o que o
-- `drop table` destrói, está publicada na 088 — único lugar onde ela vive
-- inteira. Não executar este bloco isolado sem ler lá.
--   drop function if exists public.roll_whatsapp_instance_cycle(uuid, date, date);
--   drop function if exists public.try_whatsapp_instance_cycles_lock();
--   drop function if exists public.release_whatsapp_instance_cycles_lock();
