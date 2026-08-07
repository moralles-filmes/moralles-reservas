-- CONTROLE-3 e CONTROLE-4: reintroduzem os defeitos que a 104 corrige.
--
-- Sem eles, "COST-2 passou" e "END-1 passou" nao distinguem *a guarda funciona*
-- de *o teste nao testa nada*. Cada controle quebra a funcao, mostra o caso
-- falhar, e a restauracao e reaplicar a 104.
--
-- Rodar SEM ON_ERROR_STOP: os dois blocos abaixo alteram o schema de
-- proposito.
--
-- Os inserts em `t_res` usam lista de colunas explicita (ord, caso, veredito)
-- pela mesma razao do 05: a tabela ja existe com 5 colunas quando este arquivo
-- roda como parte da sequencia do README (criada pelo 03).

-- ── CONTROLE-3: remover a protecao do custo congelado ────────────────
create or replace function public.set_whatsapp_instance_cost(
  p_instance_id uuid, p_cost_cents integer, p_cost_source text,
  p_cost_note text, p_actor uuid
)
returns table (instance_found boolean, open_cycle_id uuid, cycle_filled boolean)
language plpgsql security definer set search_path = public
as $$
declare v_open record;
begin
  select * into v_open from whatsapp_instance_cycles
   where instance_id = p_instance_id and status = 'OPEN' for update;
  if not found then
    return query select true, null::uuid, false;
    return;
  end if;
  -- DEFEITO REINTRODUZIDO: sem `v_open.provider_cost_cents is null`.
  update whatsapp_instance_cycles
     set provider_cost_cents = p_cost_cents, cost_snapshot_at = now()
   where id = v_open.id;
  return query select true, v_open.id, true;
end;
$$;

do $$
declare v_before int; v_after int;
begin
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000001';
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on,
                                        status, provider_cost_cents, cost_source, cost_snapshot_at)
  values ('cc000000-0000-4000-8000-000000000001',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000001'),
          date '2026-11-04', date '2026-12-04', 'OPEN', 9990, 'PROVIDER_PANEL', now());

  select provider_cost_cents into v_before from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';
  perform set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 12000, 'ESTIMATED', 'x', null);
  select provider_cost_cents into v_after from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';

  insert into t_res (ord, caso, veredito) values (61, 'CONTROLE-3 sem a guarda, o custo congelado E sobrescrito',
    case when v_before = 9990 and v_after = 12000 then 'REPRODUZIU' else 'NAO REPRODUZIU' end);
end $$;

-- ── CONTROLE-4: remover o fecho do ciclo no encerramento ─────────────
create or replace function public.confirm_whatsapp_instance_end(
  p_instance_id uuid, p_note text, p_actor uuid
)
returns table (instance_found boolean, lifecycle_before text,
               closed_cycle_id uuid, closed_cycle_status text)
language plpgsql security definer set search_path = public
as $$
declare v_inst record;
begin
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  -- DEFEITO REINTRODUZIDO (§2.3): marca ENDED e NAO fecha o ciclo aberto.
  update whatsapp_instances
     set lifecycle_state = 'ENDED', ended_at = coalesce(ended_at, now()), updated_at = now()
   where id = p_instance_id;
  return query select true, v_inst.lifecycle_state::text, null::uuid, null::text;
end;
$$;

do $$
declare v_open int;
begin
  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000001', 'x', null);
  select count(*) into v_open from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';

  insert into t_res (ord, caso, veredito) values (62, 'CONTROLE-4 sem o fecho, o ciclo fica OPEN para sempre',
    case when v_open = 1 then 'REPRODUZIU' else 'NAO REPRODUZIU' end);
end $$;
