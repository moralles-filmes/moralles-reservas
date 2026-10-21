-- Instagram, Fase 1 (Task 1.3): fila durável de inbound do Direct, ledger por
-- mensagem, diagnóstico da plataforma e os wrappers de pg_cron.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Task 1.3)
-- Pré-voo: supabase/tests/local-preflight/79-instagram-module.sql (README,
--          seção "79 — Módulo Instagram"), casos IG-3.1..IG-3.7 e controles
--          C-IG-3.1..C-IG-3.7. Gêmeo: src/lib/instagram-queue-migration-twin.test.ts.
--
-- ESPELHO DA FILA DO WHATSAPP (111/112/113). O desenho, e o porquê de cada
-- perna, estão nos cabeçalhos daquelas migrations; aqui fica só o que muda:
--   * uma linha por ENTREGA E CONTA: um POST da Meta pode misturar várias
--     contas, e o webhook (Task 2.3) grava uma linha por conta elegível, com o
--     corpo cru inteiro. O worker lê só os itens da própria conta;
--   * dedupe por `(instagram_account_id, body_sha256)`: a Meta reentrega o
--     mesmo corpo por até 36h e não manda id de entrega;
--   * `signature_secret` registra qual segredo assinou (`instagram` ou `meta`);
--   * o ledger por mensagem (`instagram_processed_messages`) mora aqui, e não
--     em `processed_messages`, porque o `mid` é escopado pela conta.
--
-- GÊMEOS DECLARADOS (SQL não importa TypeScript; o teste gêmeo amarra):
--   * o lease de 90 s dos dois claims é `INBOUND_LEASE_TTL_MS = 90_000`;
--   * a purga da fila usa `PURGE_DONE_AFTER_DAYS = 7` e `PURGE_DEAD_AFTER_DAYS = 30`,
--     os três em `supabase/functions/_shared/whatsapp-inbound-queue-core.ts`;
--   * a purga do ledger usa 30 dias, que a Task 4.1 nomeia
--     `INSTAGRAM_PROCESSED_RETENTION_DAYS`.
--
-- Tenant: as duas tabelas carregam `unit_id`, e o guard exige que seja a
-- unidade da CONTA (e congela conta e unidade). Nenhuma RPC aceita
-- `unit_id`: a unidade sai da conta. O diagnóstico é só platform_admin.
--
-- Escrita: o webhook (Task 2.3) INSERE na fila como `service_role` (23505 é a
-- duplicata), por isso a fila concede SELECT e INSERT (só das cinco colunas
-- que o webhook declara) a `service_role`. Todo o
-- resto (claim, finalize, ledger, purga) é RPC SECURITY DEFINER; o ledger
-- concede só SELECT.
--
-- Idempotente: `create table/index if not exists`, `create or replace
-- function`, `drop trigger if exists` + `create`, `revoke`/`grant`
-- reafirmados. Sem URL do projeto e sem segredo: os wrappers leem
-- `project_url` e `internal_api_key` do Vault.

begin;

-- ============================================================================
-- 1. instagram_inbound_events
-- ============================================================================
-- `raw_body` é bytea pelo mesmo motivo da 111 (text recusa \u0000 e a
-- revalidação depende do byte exato).
create table if not exists public.instagram_inbound_events (
  id                   uuid        primary key default gen_random_uuid(),
  instagram_account_id uuid        not null references public.instagram_accounts(id) on delete cascade,
  unit_id              uuid        not null references public.units(id) on delete cascade,
  raw_body             bytea       not null,
  body_sha256          text        not null
    constraint instagram_inbound_events_body_sha256_chk check (body_sha256 ~ '^[0-9a-f]{64}$'),
  signature_secret     text        not null
    constraint instagram_inbound_events_signature_secret_chk check (signature_secret in ('instagram', 'meta')),
  received_at          timestamptz not null default now(),
  status               text        not null default 'received'
    constraint instagram_inbound_events_status_chk
      check (status in ('received', 'processing', 'done', 'dead')),
  attempts             integer     not null default 0
    constraint instagram_inbound_events_attempts_chk check (attempts >= 0),
  next_attempt_at      timestamptz not null default now(),
  claim_id             uuid,
  claimed_until        timestamptz,
  outcome              text
    constraint instagram_inbound_events_outcome_chk check (outcome is null or outcome ~ '^[a-z0-9_]{1,64}$'),
  last_error           text,
  updated_at           timestamptz not null default now(),
  -- O hash é o do PRÓPRIO corpo: o dedupe não pode confiar no que o escritor
  -- declarou (um hash de outro corpo descartaria uma entrega legítima como
  -- duplicata). O CHECK de formato acima fica pela mensagem de erro clara.
  constraint instagram_inbound_events_body_sha256_raw_chk
    check (body_sha256 = pg_catalog.encode(pg_catalog.sha256(raw_body), 'hex')),
  constraint instagram_inbound_events_account_body_key unique (instagram_account_id, body_sha256)
);

comment on table public.instagram_inbound_events is
  'Fila duravel do webhook do Instagram: uma linha por entrega E conta, corpo cru intacto. Dedupe por (conta, sha256). FORCE RLS sem policies; service_role insere (webhook) e le; o resto e RPC. Retencao: done 7d, dead 30d.';

-- Varredura: devido e não-terminal.
create index if not exists instagram_inbound_events_due_idx
  on public.instagram_inbound_events (next_attempt_at)
  where status in ('received', 'processing');

-- Diagnóstico por unidade (e índice da FK de unidade).
create index if not exists instagram_inbound_events_unit_status_idx
  on public.instagram_inbound_events (unit_id, status, received_at desc);

-- ============================================================================
-- 2. instagram_processed_messages (ledger por mensagem)
-- ============================================================================
-- Sem conteúdo: `mid`, desfecho e `meta` operacional (o worker não grava texto
-- de mensagem aqui). Retenção de 30 dias por `created_at`, exceto linha em voo
-- (lease vivo).
create table if not exists public.instagram_processed_messages (
  id                   uuid        primary key default gen_random_uuid(),
  instagram_account_id uuid        not null references public.instagram_accounts(id) on delete cascade,
  unit_id              uuid        not null references public.units(id) on delete cascade,
  mid                  text        not null
    constraint instagram_processed_messages_mid_chk check (length(mid) between 1 and 512),
  status               text        not null default 'processing'
    constraint instagram_processed_messages_status_chk check (status in ('processing', 'done')),
  claim_id             uuid,
  claimed_until        timestamptz,
  -- Desfecho é CÓDIGO (`echo_own`, `discarded_<motivo>`), nunca texto livre:
  -- o formato estrutural impede que conteúdo de mensagem chegue ao
  -- diagnóstico por aqui. Mesmo CHECK na fila.
  outcome              text
    constraint instagram_processed_messages_outcome_chk check (outcome is null or outcome ~ '^[a-z0-9_]{1,64}$'),
  error                text,
  meta                 jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  constraint instagram_processed_messages_account_mid_key unique (instagram_account_id, mid)
);

comment on table public.instagram_processed_messages is
  'Ledger por mensagem do Direct (mid por conta): claim com lease de 90s, desfecho e meta sem conteudo. Gravado so pelas RPCs service_role. FORCE RLS sem policies. Retencao 30d.';

create index if not exists instagram_processed_messages_unit_completed_idx
  on public.instagram_processed_messages (unit_id, completed_at desc);

-- ============================================================================
-- 3. Guard de tenant das duas tabelas
-- ============================================================================
-- A unidade do registro é a da conta, e conta e unidade não mudam depois.
-- SECURITY INVOKER: quem grava é o `service_role` (webhook, com SELECT em
-- `instagram_accounts`) ou RPC DEFINER dona `postgres`.
create or replace function public.instagram_queue_tenant_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acc_unit uuid;
begin
  if tg_op = 'UPDATE'
     and (new.instagram_account_id is distinct from old.instagram_account_id
          or new.unit_id is distinct from old.unit_id) then
    raise exception '%: conta e unidade sao imutaveis', tg_table_name
      using errcode = 'check_violation';
  end if;

  select a.unit_id into v_acc_unit
    from public.instagram_accounts a where a.id = new.instagram_account_id;

  if v_acc_unit is null then
    raise exception '%: conta % inexistente', tg_table_name, new.instagram_account_id
      using errcode = 'check_violation';
  end if;

  if new.unit_id is distinct from v_acc_unit then
    raise exception '%: unidade do registro nao e a da conta %', tg_table_name, new.instagram_account_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists instagram_inbound_events_tenant_guard_trg on public.instagram_inbound_events;
create trigger instagram_inbound_events_tenant_guard_trg
  before insert or update of instagram_account_id, unit_id on public.instagram_inbound_events
  for each row execute function public.instagram_queue_tenant_guard();

drop trigger if exists instagram_processed_messages_tenant_guard_trg on public.instagram_processed_messages;
create trigger instagram_processed_messages_tenant_guard_trg
  before insert or update of instagram_account_id, unit_id on public.instagram_processed_messages
  for each row execute function public.instagram_queue_tenant_guard();

-- ============================================================================
-- 4. RLS e ACL de tabela
-- ============================================================================
-- O `revoke` inclui `service_role` para tirar o que os default privileges do
-- Supabase dão (UPDATE/DELETE/TRUNCATE etc.).
alter table public.instagram_inbound_events enable row level security;
alter table public.instagram_inbound_events force row level security;
alter table public.instagram_processed_messages enable row level security;
alter table public.instagram_processed_messages force row level security;

revoke all on table public.instagram_inbound_events from public, anon, authenticated, service_role;
-- INSERT por COLUNA: o webhook só declara conta, unidade, corpo, hash e
-- segredo. Estado, tentativas, claim, desfecho e instantes nascem do default e
-- só mudam pelas RPCs; um INSERT que traga `status`/`claim_id`/`attempts`/
-- `outcome`/`received_at` é recusado com 42501.
grant select on table public.instagram_inbound_events to service_role;
grant insert (instagram_account_id, unit_id, raw_body, body_sha256, signature_secret)
  on table public.instagram_inbound_events to service_role;

revoke all on table public.instagram_processed_messages from public, anon, authenticated, service_role;
grant select on table public.instagram_processed_messages to service_role;

-- ============================================================================
-- 5. Fila: claim, finalize, seleção e purga (espelho da 113)
-- ============================================================================

-- Claim por id. Zero linhas = não reivindicável (lease vivo, terminal ou
-- apagada). Só o takeover de lease vencido gasta tentativa. Ignora
-- `next_attempt_at` de propósito (caminho rápido); a seleção é que respeita.
create or replace function public.claim_instagram_inbound_event(p_event_id uuid)
returns table (
  id                   uuid,
  instagram_account_id uuid,
  unit_id              uuid,
  raw_body             bytea,
  attempts             integer,
  claim_id             uuid
)
language sql
security definer
set search_path = ''
as $$
  update public.instagram_inbound_events e
     set status        = 'processing',
         claim_id      = gen_random_uuid(),
         claimed_until = now() + make_interval(secs => 90),
         attempts      = case when e.status = 'processing'
                              then e.attempts + 1
                              else e.attempts
                         end,
         updated_at    = now()
   where e.id = p_event_id
     and (e.status = 'received'
          or (e.status = 'processing' and e.claimed_until < now()))
  returning e.id, e.instagram_account_id, e.unit_id, e.raw_body, e.attempts, e.claim_id;
$$;

-- Finalização cercada pelo claim: sem `claim_id = p_claim_id` o perdedor de
-- um takeover escreve por cima do vencedor. Devolve as linhas afetadas, e o
-- caller confere. `last_error` preserva o anterior quando não há erro novo.
-- MAIS ESTRITA QUE A 113 DE PROPÓSITO: só aceita status de saída (`received`
-- para retentar, `done`, `dead`). `processing` aqui zeraria o lease junto e
-- deixaria a linha `processing` sem `claimed_until`, que nem o takeover nem a
-- seleção alcançam; status desconhecido também devolve 0, sem tocar a linha.
create or replace function public.finalize_instagram_inbound_event(
  p_event_id            uuid,
  p_claim_id            uuid,
  p_status              text,
  p_outcome             text,
  p_error               text,
  p_retry_delay_seconds integer
)
returns integer
language sql
security definer
set search_path = ''
as $$
  with fenced as (
    update public.instagram_inbound_events e
       set status          = p_status,
           outcome         = p_outcome,
           last_error      = coalesce(left(p_error, 500), e.last_error),
           attempts        = case
                               when p_status in ('received', 'dead') then e.attempts + 1
                               else e.attempts
                             end,
           next_attempt_at = case
                               when p_retry_delay_seconds is null then now()
                               else now() + make_interval(secs => p_retry_delay_seconds)
                             end,
           claim_id        = null,
           claimed_until   = null,
           updated_at      = now()
     where e.id = p_event_id
       and e.claim_id = p_claim_id
       and p_status in ('received', 'done', 'dead')
    returning 1
  )
  select count(*)::integer from fenced;
$$;

-- Seleção das devidas: somente leitura, só ids (o corpo é PII e o claim o
-- entrega a quem processa), ordenada por `updated_at` (a envenenada cede a vez).
create or replace function public.select_due_instagram_inbound_events(p_limit integer default 20)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
    from public.instagram_inbound_events e
   where e.next_attempt_at <= now()
     and (e.status = 'received'
          or (e.status = 'processing' and e.claimed_until < now()))
   order by e.updated_at
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

-- Purga: `done` em 7 dias, `dead` em 30. Só alcança estado terminal: linha
-- viva nunca é apagada. Roda no job de pg_cron `instagram-inbound-purge`
-- (migration 20261020120500), não na varredura do worker.
create or replace function public.purge_instagram_inbound_events()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.instagram_inbound_events
     where (status = 'done' and received_at < now() - interval '7 days')
        or (status = 'dead' and received_at < now() - interval '30 days')
    returning 1
  ) select count(*)::integer from gone;
$$;

-- ============================================================================
-- 6. Ledger por mensagem
-- ============================================================================

-- Claim do `mid`. Primeira vez: insere `processing` com lease e devolve o
-- claim. Já `done`, ou em voo dentro do lease: devolve NULL. `processing` com
-- lease vencido (worker morreu): devolve um claim NOVO. A unidade sai da conta.
create or replace function public.claim_instagram_message(p_account_id uuid, p_mid text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_unit  uuid;
  v_claim uuid;
begin
  if p_account_id is null or p_mid is null or length(p_mid) not between 1 and 512 then
    raise exception 'invalid_instagram_message_argument' using errcode = '22023';
  end if;

  select a.unit_id into v_unit from public.instagram_accounts a where a.id = p_account_id;
  if v_unit is null then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;

  insert into public.instagram_processed_messages as m
    (instagram_account_id, unit_id, mid, status, claim_id, claimed_until)
  values
    (p_account_id, v_unit, p_mid, 'processing', gen_random_uuid(), now() + make_interval(secs => 90))
  on conflict (instagram_account_id, mid) do update
     set claim_id      = excluded.claim_id,
         claimed_until = now() + make_interval(secs => 90)
   where m.status = 'processing'
     and m.claimed_until < now()
  returning m.claim_id into v_claim;

  return v_claim;
end;
$$;

-- Conclusão cercada pelo claim: só quem tem o claim vigente fecha a linha.
-- `false` = a cerca negou (claim antigo, já `done` ou inexistente).
create or replace function public.complete_instagram_message(
  p_account_id uuid,
  p_mid        text,
  p_claim_id   uuid,
  p_outcome    text,
  p_error      text,
  p_meta       jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.instagram_processed_messages m
     set status        = 'done',
         outcome       = p_outcome,
         error         = left(p_error, 500),
         meta          = coalesce(p_meta, '{}'::jsonb),
         completed_at  = now(),
         claim_id      = null,
         claimed_until = null
   where m.instagram_account_id = p_account_id
     and m.mid = p_mid
     and m.claim_id = p_claim_id
     and m.status = 'processing';
  return found;
end;
$$;

-- Eco ou descarte: nasce `done`, sem claim. Repetir, ou registrar sobre uma
-- mensagem já vista, não muda nada.
create or replace function public.record_instagram_message_outcome(
  p_account_id uuid,
  p_mid        text,
  p_outcome    text,
  p_meta       jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_unit uuid;
begin
  if p_account_id is null or p_mid is null or length(p_mid) not between 1 and 512 then
    raise exception 'invalid_instagram_message_argument' using errcode = '22023';
  end if;

  select a.unit_id into v_unit from public.instagram_accounts a where a.id = p_account_id;
  if v_unit is null then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;

  insert into public.instagram_processed_messages
    (instagram_account_id, unit_id, mid, status, outcome, meta, completed_at)
  values
    (p_account_id, v_unit, p_mid, 'done', p_outcome, coalesce(p_meta, '{}'::jsonb), now())
  on conflict (instagram_account_id, mid) do nothing;
end;
$$;

-- Retenção do ledger: 30 dias por `created_at`. `processing` com lease
-- vencido dessa idade é abandono e sai; com lease VIVO é um turno em curso e
-- fica (apagá-lo deixaria o mesmo `mid` ser reivindicado de novo enquanto o
-- primeiro turno ainda responde).
create or replace function public.purge_instagram_processed_messages()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.instagram_processed_messages
     where created_at < now() - interval '30 days'
       and (status = 'done' or claimed_until < now())
    returning 1
  ) select count(*)::integer from gone;
$$;

-- ============================================================================
-- 7. Diagnóstico (authenticated, só platform_admin)
-- ============================================================================
-- Qualquer outro caller (membro, sem `sub`) recebe o mesmo 42501. Só
-- contagens e instantes, nunca corpo, erro, `mid` ou meta. `outcomes_24h`
-- soma os desfechos da fila (finalizados nas últimas 24h) e os do ledger
-- (concluídos nas últimas 24h); os nomes não colidem (`discarded_*`/`queue_*`
-- de evento, `echo_*`/turno de mensagem).
create or replace function public.get_instagram_diagnostics(p_unit_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null or not app_private.is_platform_admin(v_uid) then
    raise exception 'instagram_diagnostics_forbidden' using errcode = '42501';
  end if;
  if p_unit_id is null then
    raise exception 'invalid_instagram_diagnostics_argument' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'last_event_at', (select max(e.received_at) from public.instagram_inbound_events e
                       where e.unit_id = p_unit_id),
    'queue', jsonb_build_object(
      'received',   (select count(*) from public.instagram_inbound_events e
                      where e.unit_id = p_unit_id and e.status = 'received'),
      'processing', (select count(*) from public.instagram_inbound_events e
                      where e.unit_id = p_unit_id and e.status = 'processing'),
      'done_24h',   (select count(*) from public.instagram_inbound_events e
                      where e.unit_id = p_unit_id and e.status = 'done'
                        and e.updated_at >= now() - interval '24 hours'),
      'dead',       (select count(*) from public.instagram_inbound_events e
                      where e.unit_id = p_unit_id and e.status = 'dead')
    ),
    'oldest_pending_received_at', (select min(e.received_at) from public.instagram_inbound_events e
                                    where e.unit_id = p_unit_id and e.status in ('received', 'processing')),
    'outcomes_24h', coalesce((
      select jsonb_object_agg(o.outcome, o.n)
        from (
          select x.outcome, sum(x.n)::integer as n
            from (
              select e.outcome, count(*) as n
                from public.instagram_inbound_events e
               where e.unit_id = p_unit_id
                 and e.status in ('done', 'dead')
                 and e.outcome is not null
                 and e.updated_at >= now() - interval '24 hours'
               group by e.outcome
              union all
              select m.outcome, count(*) as n
                from public.instagram_processed_messages m
               where m.unit_id = p_unit_id
                 and m.status = 'done'
                 and m.outcome is not null
                 and m.completed_at >= now() - interval '24 hours'
               group by m.outcome
            ) x
           group by x.outcome
        ) o
    ), '{}'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- ============================================================================
-- 8. Wrappers de pg_cron (padrão da 112)
-- ============================================================================
-- Só criam as funções; o agendamento é de outra task. Leem `internal_api_key`
-- e `project_url` do Vault, fail-closed: faltando qualquer um, avisam e
-- voltam sem POST. Nenhuma URL embutida; header montado do Vault.
-- Guardrail: scripts/migration-static-guard.test.ts.
create or replace function public.trigger_instagram_inbound_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_url text;
begin
  select ds.decrypted_secret into v_key
    from vault.decrypted_secrets ds where ds.name = 'internal_api_key' limit 1;
  select ds.decrypted_secret into v_url
    from vault.decrypted_secrets ds where ds.name = 'project_url' limit 1;

  if v_key is null or v_key = '' then
    raise notice '[instagram-inbound-sweep] internal_api_key ausente no Vault — skip';
    return;
  end if;
  if v_url is null or v_url = '' then
    raise notice '[instagram-inbound-sweep] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := v_url || '/functions/v1/process-instagram-inbound?sweep=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

create or replace function public.trigger_instagram_token_refresh()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_url text;
begin
  select ds.decrypted_secret into v_key
    from vault.decrypted_secrets ds where ds.name = 'internal_api_key' limit 1;
  select ds.decrypted_secret into v_url
    from vault.decrypted_secrets ds where ds.name = 'project_url' limit 1;

  if v_key is null or v_key = '' then
    raise notice '[instagram-token-refresh] internal_api_key ausente no Vault — skip';
    return;
  end if;
  if v_url is null or v_url = '' then
    raise notice '[instagram-token-refresh] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := v_url || '/functions/v1/process-instagram-token-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- ============================================================================
-- 9. ACL das funções (assinatura completa)
-- ============================================================================
revoke all on function public.claim_instagram_inbound_event(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_instagram_inbound_event(uuid) to service_role;
revoke all on function public.finalize_instagram_inbound_event(uuid, uuid, text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.finalize_instagram_inbound_event(uuid, uuid, text, text, text, integer) to service_role;
revoke all on function public.select_due_instagram_inbound_events(integer) from public, anon, authenticated, service_role;
grant execute on function public.select_due_instagram_inbound_events(integer) to service_role;
revoke all on function public.purge_instagram_inbound_events() from public, anon, authenticated, service_role;
grant execute on function public.purge_instagram_inbound_events() to service_role;

revoke all on function public.claim_instagram_message(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_instagram_message(uuid, text) to service_role;
revoke all on function public.complete_instagram_message(uuid, text, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.complete_instagram_message(uuid, text, uuid, text, text, jsonb) to service_role;
revoke all on function public.record_instagram_message_outcome(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_instagram_message_outcome(uuid, text, text, jsonb) to service_role;
revoke all on function public.purge_instagram_processed_messages() from public, anon, authenticated, service_role;
grant execute on function public.purge_instagram_processed_messages() to service_role;

revoke all on function public.get_instagram_diagnostics(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_instagram_diagnostics(uuid) to authenticated;

-- Wrappers: só o dono (pg_cron roda como postgres). Trigger function: ninguém.
revoke all on function public.trigger_instagram_inbound_sweep() from public, anon, authenticated, service_role;
revoke all on function public.trigger_instagram_token_refresh() from public, anon, authenticated, service_role;
revoke all on function public.instagram_queue_tenant_guard() from public, anon, authenticated, service_role;

commit;

-- Validação pós-migration (somente leitura):
--   select proname, proacl from pg_proc where proname like '%instagram%';
--   select relname, relrowsecurity, relforcerowsecurity, relacl from pg_class
--    where relname in ('instagram_inbound_events', 'instagram_processed_messages');
--   select count(*) from pg_policies
--    where tablename in ('instagram_inbound_events', 'instagram_processed_messages');  -- 0
--   select name from vault.decrypted_secrets where name in ('internal_api_key', 'project_url');  -- 2
--
-- ROLLBACK (só antes de o webhook e o worker gravarem; apaga a fila e o ledger):
--   drop function if exists public.trigger_instagram_token_refresh();
--   drop function if exists public.trigger_instagram_inbound_sweep();
--   drop function if exists public.get_instagram_diagnostics(uuid);
--   drop function if exists public.purge_instagram_processed_messages();
--   drop function if exists public.record_instagram_message_outcome(uuid, text, text, jsonb);
--   drop function if exists public.complete_instagram_message(uuid, text, uuid, text, text, jsonb);
--   drop function if exists public.claim_instagram_message(uuid, text);
--   drop function if exists public.purge_instagram_inbound_events();
--   drop function if exists public.select_due_instagram_inbound_events(integer);
--   drop function if exists public.finalize_instagram_inbound_event(uuid, uuid, text, text, text, integer);
--   drop function if exists public.claim_instagram_inbound_event(uuid);
--   drop table if exists public.instagram_processed_messages;
--   drop table if exists public.instagram_inbound_events;
--   drop function if exists public.instagram_queue_tenant_guard();
