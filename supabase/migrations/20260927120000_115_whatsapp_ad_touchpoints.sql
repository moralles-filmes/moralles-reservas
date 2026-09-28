-- Fase D — touchpoint de anúncio Click-to-WhatsApp (CTWA).
--
-- Uma linha por MENSAGEM que chegou com `referral`, gravada pelo
-- `webhook-whatsapp` (service_role) depois do claim de `processed_messages`.
-- Spec: docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md
--
-- ESCOPO (D1): o touchpoint é da UNIDADE que recebeu o clique (`unit_id` +
-- `channel_id`, lidos do canal da querystring) e aponta para o CLIENTE da
-- organização (`customer_id`). Não há `organization_id`: a visão da organização
-- é `where customer_id = K`, porque `customers` já é da organização. A coerência
-- entre as três FKs é amarrada no banco pelo guard abaixo.
--
-- IMUTÁVEL: o histórico é o dado de atribuição. Nenhum UPDATE é aceito, com UMA
-- exceção obrigatória — a coerção do `on delete set null` de `channel_id`. Sem
-- ela, apagar o canal abortaria o DELETE inteiro (o conflito FK × CHECK da 089).
--
-- RETENÇÃO (D3): sem purga por tempo nesta fase. Anonimizar o cliente
-- (`customers.deleted_at`) apaga os touchpoints dele, por trigger SECURITY
-- DEFINER; exclusão física do cliente ou da unidade, por cascade.
--
-- Os limites dos CHECKs são GÊMEOS DECLARADOS das constantes de
-- `_shared/whatsapp-ad-touchpoint-core.ts`, e a lista de `provider` é gêmea de
-- `PROVIDER_CAPABILITIES[*].adReferral === true`. SQL não importa TypeScript:
-- `src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts` lê este arquivo e
-- reprova divergência. O 65536 da subárvore é a REDE, não a regra: a regra é
-- 16384 bytes no núcleo, porque o `jsonb::text` fica mais longo que o
-- `JSON.stringify`, e recusa do banco viraria reentrega eterna (D8).

create table if not exists whatsapp_ad_touchpoints (
  id                   uuid        primary key default gen_random_uuid(),
  unit_id              uuid        not null references units(id) on delete cascade,
  channel_id           uuid                 references whatsapp_channels(id) on delete set null,
  customer_id          uuid        not null references customers(id) on delete cascade,
  provider             text        not null check (provider in ('official','datafy')),
  provider_message_id  text        not null check (length(btrim(provider_message_id)) between 1 and 512),
  message_type         text        check (message_type is null or length(message_type) between 1 and 32),
  message_at           timestamptz not null,
  received_at          timestamptz not null default now(),
  ctwa_clid            text        check (ctwa_clid   is null or length(ctwa_clid)   between 1 and 512),
  source_type          text        check (source_type is null or length(source_type) between 1 and 64),
  source_id            text        check (source_id   is null or length(source_id)   between 1 and 256),
  referral             jsonb       check (referral is null or octet_length(referral::text) <= 65536)
);

comment on table whatsapp_ad_touchpoints is
  'Fase D: touchpoint de anuncio Click-to-WhatsApp, uma linha por mensagem com referral. Imutavel (trigger). FORCE RLS sem policies: so service_role, via Edge Function. Escopo: unit_id + channel_id do canal, customer_id do cliente da organizacao.';
comment on column whatsapp_ad_touchpoints.ctwa_clid is
  'Identificador pessoal pseudonimizado do clique: a Meta o resolve ate a pessoa. Chave da Fase I (Conversions API). Apagado na anonimizacao do cliente.';
comment on column whatsapp_ad_touchpoints.referral is
  'Subarvore referral CRUA como chegou (ate 16 KiB no nucleo; o CHECK de 64 KiB e rede). Nunca o corpo da mensagem: sem telefone, nome ou texto. Existe porque o envelope da Datafy nao foi medido: se o identificador vier sob outro nome, e aqui que ele sobrevive.';
comment on column whatsapp_ad_touchpoints.provider is
  'So quem declara adReferral. Gemeo declarado de PROVIDER_CAPABILITIES[*].adReferral (teste em src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts).';

-- Um touchpoint por mensagem: mesma chave de `processed_messages`. Reentrega é
-- 23505, tratado como dedupe silencioso no núcleo.
create unique index if not exists whatsapp_ad_touchpoints_message_idx
  on whatsapp_ad_touchpoints (provider, provider_message_id);

-- A consulta da Fase I.
create index if not exists whatsapp_ad_touchpoints_unit_customer_idx
  on whatsapp_ad_touchpoints (unit_id, customer_id, message_at desc);

-- O DELETE da anonimização.
create index if not exists whatsapp_ad_touchpoints_customer_idx
  on whatsapp_ad_touchpoints (customer_id);

-- FK channel_id sem índice dispara o advisor (lint 0001, unindexed foreign keys).
create index if not exists whatsapp_ad_touchpoints_channel_idx
  on whatsapp_ad_touchpoints (channel_id) where channel_id is not null;

alter table whatsapp_ad_touchpoints enable row level security;
alter table whatsapp_ad_touchpoints force row level security;
-- Segunda tranca além da RLS forçada, como em 20260817170753_whatsapp_multiprovider_uazapi.sql: a tabela guarda identificador pessoal pseudonimizado.
revoke all on table whatsapp_ad_touchpoints from anon, authenticated;
-- Sem policies: só service_role, via Edge Function. Mesma disciplina de
-- whatsapp_channels, processed_messages e whatsapp_inbound_events: a separação
-- entre clientes depende do `.eq(...)` no código e, aqui, do guard abaixo.

-- ─── Guarda da linha ────────────────────────────────────────────────────────
-- SECURITY INVOKER: só o service_role escreve (ele ignora RLS); qualquer outro
-- papel já é barrado pela RLS forçada. `search_path = ''` obriga a qualificar.
--
-- Os comentários `-- <marcador>` / `-- </marcador>` NÃO são decoração: os
-- controles positivos do pré-voo (supabase/tests/local-preflight/
-- 23-controles-115.sql) sabotam o corpo por delta mínimo sobre
-- `pg_get_functiondef`, recortando entre eles. Não os remova.
create or replace function public.whatsapp_ad_touchpoints_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_unit_org     uuid;
  v_cust_org     uuid;
  v_cust_deleted timestamptz;
begin
  -- <guarda-update>
  if tg_op = 'UPDATE' then
    -- <excecao-set-null>
    -- Única exceção: a coerção do `on delete set null` de channel_id — não nulo
    -- para nulo, com TODAS as outras colunas iguais. Sem ela, apagar o canal
    -- aborta o DELETE inteiro (conflito FK × CHECK da migration 089).
    if old.channel_id is not null
       and new.channel_id is null
       and (to_jsonb(new) - 'channel_id') = (to_jsonb(old) - 'channel_id') then
      return new;
    end if;
    -- </excecao-set-null>
    raise exception 'whatsapp_ad_touchpoints e imutavel: touchpoint nunca e reescrito (id %)', old.id
      using errcode = 'check_violation';
  end if;
  -- </guarda-update>

  -- `for share` serializa esta leitura contra o `NO KEY UPDATE` implícito do
  -- `UPDATE customers set deleted_at = ...` de anonymize_customer: quem
  -- espera relê o valor committed mais recente em READ COMMITTED. Sem o lock,
  -- um INSERT concorrente com a anonimização podia ler deleted_at nulo antes
  -- de a purga rodar, e o ctwa_clid sobrevivia pra sempre (sem purga por
  -- tempo, D3).
  select c.organization_id, c.deleted_at into v_cust_org, v_cust_deleted
    from public.customers c where c.id = new.customer_id for share;

  -- <coerencia-tenant>
  if new.channel_id is not null and not exists (
    select 1 from public.whatsapp_channels ch
     where ch.id = new.channel_id and ch.unit_id = new.unit_id
  ) then
    raise exception 'whatsapp_ad_touchpoints: canal % nao pertence a unidade %', new.channel_id, new.unit_id
      using errcode = 'check_violation';
  end if;

  select u.organization_id into v_unit_org from public.units u where u.id = new.unit_id;

  if v_unit_org is null then
    raise exception 'whatsapp_ad_touchpoints: unidade % sem organizacao', new.unit_id
      using errcode = 'check_violation';
  end if;

  if v_cust_org is distinct from v_unit_org then
    raise exception 'whatsapp_ad_touchpoints: cliente % nao pertence a organizacao da unidade %', new.customer_id, new.unit_id
      using errcode = 'check_violation';
  end if;
  -- </coerencia-tenant>

  -- <cliente-vivo>
  -- Sem isto, uma anonimização que rodasse ENTRE o resolveOrCreateCustomer e
  -- o INSERT deixaria um ctwa_clid preso a um cliente já anonimizado; o `for
  -- share` acima continua fechando essa corrida. O SQLSTATE é DEDICADO porque
  -- o núcleo o classifica como `customer_not_alive` (loga e segue, sem
  -- reentrega): recusa persistente não pode virar reentrega eterna, e um soft
  -- delete direto que não troca o telefone faria o resolveOrCreateCustomer
  -- devolver sempre o mesmo cliente. Gêmeo de CUSTOMER_NOT_ALIVE_SQLSTATE no
  -- núcleo (_shared/whatsapp-ad-touchpoint-core.ts).
  if v_cust_deleted is not null then
    raise exception 'whatsapp_ad_touchpoints: cliente % anonimizado', new.customer_id
      using errcode = 'P0A15';
  end if;
  -- </cliente-vivo>

  return new;
end;
$$;

drop trigger if exists whatsapp_ad_touchpoints_guard_trg on whatsapp_ad_touchpoints;
create trigger whatsapp_ad_touchpoints_guard_trg
  before insert or update on whatsapp_ad_touchpoints
  for each row execute function public.whatsapp_ad_touchpoints_guard();

-- ─── Anonimização LGPD ──────────────────────────────────────────────────────
-- `anonymize_customer` faz SOFT delete (`deleted_at = now()`), então o cascade
-- da FK não dispara. Trigger em `customers`, e não uma linha a mais na RPC:
-- cobre QUALQUER caminho que marque `deleted_at` e não reescreve o corpo de uma
-- SECURITY DEFINER com três versões de histórico.
--
-- TEM de ser SECURITY DEFINER: a tabela é FORCE RLS sem policies, e um DELETE
-- rodado como `authenticated` (um membro fazendo soft delete pelo PostgREST)
-- apagaria ZERO linhas em silêncio — o ctwa_clid do cliente anonimizado
-- sobreviveria —, ou, com o `revoke` de tabela acima, estouraria 42501 e
-- derrubaria o próprio soft delete. As duas são o defeito. Como dono
-- (`postgres`, rolbypassrls = true, medido em produção) o DELETE alcança as
-- linhas. Controle positivo C-115-4 no pré-voo.
create or replace function public.purge_ad_touchpoints_on_customer_anonymize()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.whatsapp_ad_touchpoints where customer_id = new.id;
  return null;
end;
$$;

drop trigger if exists customers_purge_ad_touchpoints_trg on public.customers;
create trigger customers_purge_ad_touchpoints_trg
  after update of deleted_at on public.customers
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.purge_ad_touchpoints_on_customer_anonymize();

-- ─── ACL ────────────────────────────────────────────────────────────────────
-- `CREATE FUNCTION` concede EXECUTE a PUBLIC. Trigger function não precisa de
-- EXECUTE de ninguém para disparar; revogar fecha a chamada direta pelo
-- PostgREST. Nenhuma das duas é concedida: nenhuma entra na allowlist de ACL.
revoke all on function public.whatsapp_ad_touchpoints_guard() from public, anon, authenticated;
revoke all on function public.purge_ad_touchpoints_on_customer_anonymize() from public, anon, authenticated;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS forçada e sem policies (esperado: t, t, 0):
--   select relrowsecurity, relforcerowsecurity from pg_class where relname = 'whatsapp_ad_touchpoints';
--   select count(*) from pg_policies where tablename = 'whatsapp_ad_touchpoints';
-- 2. Nenhuma das funções executável por anon/authenticated (esperado: f, f, f, f):
--   select has_function_privilege('anon', 'public.whatsapp_ad_touchpoints_guard()', 'execute'),
--          has_function_privilege('authenticated', 'public.whatsapp_ad_touchpoints_guard()', 'execute'),
--          has_function_privilege('anon', 'public.purge_ad_touchpoints_on_customer_anonymize()', 'execute'),
--          has_function_privilege('authenticated', 'public.purge_ad_touchpoints_on_customer_anonymize()', 'execute');
-- 3. Triggers presentes (esperado: 2 linhas):
--   select tgname from pg_trigger where not tgisinternal
--    and tgname in ('whatsapp_ad_touchpoints_guard_trg', 'customers_purge_ad_touchpoints_trg');
-- 4. Tabela sem privilégio para anon/authenticated (esperado: 8 linhas, todas f):
--   select r, p, has_table_privilege(r, 'public.whatsapp_ad_touchpoints', p)
--     from unnest(array['anon', 'authenticated']) r,
--          unnest(array['select', 'insert', 'update', 'delete']) p;
--
-- Rollback:
--   drop trigger if exists customers_purge_ad_touchpoints_trg on public.customers;
--   drop table if exists whatsapp_ad_touchpoints;
--   drop function if exists public.purge_ad_touchpoints_on_customer_anonymize();
--   drop function if exists public.whatsapp_ad_touchpoints_guard();
