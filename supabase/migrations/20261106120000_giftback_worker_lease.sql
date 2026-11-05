-- Trava do process-voucher-triggers por lease com validade (troca do advisory lock).
--
-- Plano: .tasks/vouchers-fatura-brt (Fase 1, PRE-3). Pré-voo 84.
--
-- Por que sair do advisory lock da 20260517110000: `pg_try_advisory_lock` é de
-- SESSÃO e o PostgREST atende cada RPC por uma conexão qualquer do pool. O
-- `release_giftback_lock` pode cair noutra conexão (unlock devolve false) e o
-- lock segue preso na primeira até ela morrer; enquanto isso toda execução
-- responde `already_running` sem erro visível. A EF morta no meio (limite de
-- wall-clock) também deixava o lock preso.
--
-- O lease é uma linha com dono (`holder`, uuid da invocação) e validade
-- (`lease_until`). Adquirir só vence se a linha não existe, se venceu ou se o
-- dono é o mesmo; soltar só vale para o dono. `on conflict do update ... where`
-- trava a linha em conflito e reavalia o WHERE sobre a versão mais nova, então
-- duas aquisições simultâneas não vencem as duas. Relógio: `clock_timestamp()`
-- do banco, nunca o da EF.
--
-- Acesso: FORCE RLS sem policy (padrão das tabelas de fila/ledger). Só as duas
-- funções SECURITY DEFINER abaixo tocam a linha, e isso depende do dono ter
-- BYPASSRLS (medido no pré-voo 84, controle LEASE-CP2).
--
-- Expand: `try_giftback_lock`/`release_giftback_lock` ficam até a EF nova estar
-- em produção; o drop vai numa migration posterior (contract).
--
-- ROLLBACK: redeploy da EF anterior (volta ao advisory lock) e
--   drop function if exists public.acquire_giftback_lease(uuid, integer);
--   drop function if exists public.release_giftback_lease(uuid);
--   drop table if exists app_private.giftback_worker_lease;

begin;

create table if not exists app_private.giftback_worker_lease (
  id smallint primary key check (id = 1),
  holder uuid not null,
  lease_until timestamptz not null,
  acquired_at timestamptz not null
);

alter table app_private.giftback_worker_lease enable row level security;
alter table app_private.giftback_worker_lease force row level security;
revoke all on table app_private.giftback_worker_lease from public, anon, authenticated, service_role;

create or replace function public.acquire_giftback_lease(p_holder uuid, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if p_holder is null or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 3600 then
    raise exception 'giftback_lease_invalid_args' using errcode = '22023';
  end if;

  insert into app_private.giftback_worker_lease as l (id, holder, lease_until, acquired_at)
  values (1, p_holder, clock_timestamp() + make_interval(secs => p_ttl_seconds), clock_timestamp())
  on conflict (id) do update
    set holder = excluded.holder,
        lease_until = excluded.lease_until,
        acquired_at = excluded.acquired_at
    where l.lease_until <= clock_timestamp() or l.holder = excluded.holder
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_giftback_lease(p_holder uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  update app_private.giftback_worker_lease
     set lease_until = clock_timestamp()
   where id = 1 and holder = p_holder and lease_until > clock_timestamp()
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

revoke all on function public.acquire_giftback_lease(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_giftback_lease(uuid) from public, anon, authenticated;
grant execute on function public.acquire_giftback_lease(uuid, integer) to service_role;
grant execute on function public.release_giftback_lease(uuid) to service_role;

commit;
