-- Datafy como parceiro — liberação por unidade, onboarding fora de
-- `whatsapp_channels`, claim cercado dos passos que geram custo, colunas de
-- assinatura do canal, índice único do `phone_number_id` e ledger de alertas
-- operacionais.
--
-- Spec: docs/superpowers/specs/2026-10-13-datafy-parceiro-conexao-self-service-design.md (§5.2, §5.3, §7)
-- Plano: docs/superpowers/plans/2026-10-13-datafy-parceiro-conexao-self-service.md (Task 2)
-- Pré-voo: supabase/tests/local-preflight/61-datafy-partner-onboarding.sql e
--          61b-concorrencia-datafy-onboarding.sh (seção no README do harness).
--
-- ORDEM DE DEPLOY: esta migration vai por `supabase db push` ANTES de qualquer
-- Edge Function que leia as tabelas, as colunas ou as RPCs novas.
--
-- O ÍNDICE ÚNICO DE `phone_number_id` FALHA o push se já houver duplicata entre
-- canais `official`/`datafy` (falha visível, não silenciosa). Conferir antes,
-- com a MESMA normalização do índice (valor aparado; vazio, ausente ou JSON
-- null não é âncora e fica fora — sem o filtro, as linhas sem a chave caem
-- todas num grupo NULL e dão falso alarme):
--   select pg_catalog.btrim(credentials->>'phone_number_id', E' \t\r\n') as phone_number_id, count(*)
--     from public.whatsapp_channels
--    where provider in ('official', 'datafy')
--      and pg_catalog.btrim(credentials->>'phone_number_id', E' \t\r\n') <> ''
--    group by 1 having count(*) > 1;
-- tem de voltar vazio.
--
-- SEM COLUNA DE COEXISTENCE, nem no canal nem no onboarding (Fase 0, §4 item
-- 5): o GET da Datafy não traz o campo, e a prova de que o número está no app
-- é o eco (`manual_echo_verified_at`). Coluna sem produtor confiável não nasce.
--
-- Idempotente: `create table/index if not exists`, `add column if not exists`,
-- `create or replace function`, `drop trigger if exists` + `create trigger`, e
-- os `revoke`/`grant` reafirmados.

-- ============================================================================
-- 1. Liberação explícita do admin, por unidade (spec §5.2)
-- ============================================================================
-- "Uma liberação paga um canal": consumida quando a assinatura do canal é
-- confirmada (`subscribe` 200). Escrita só pelo `manage-channels`
-- (service_role); o lojista só vê se a própria unidade está liberada, por ação
-- client-safe.
--
-- `granted_by`, `revoked_by` e `consumed_channel_id` NÃO têm FK, de propósito:
-- com `on delete set null`, apagar o usuário ou o canal faria a FK gravar NULL
-- num lado dos CHECKs de par abaixo e abortar o DELETE inteiro (o conflito
-- FK × CHECK da migration 089); sem `set null`, apagar o canal ficaria
-- bloqueado pelo histórico da liberação. São registro histórico — e por isso
-- o canal consumido é conferido pelo guard NA GRAVAÇÃO (seção 5b), não por FK.
create table if not exists public.whatsapp_official_connection_grants (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  unit_id             uuid        not null references public.units(id) on delete cascade,
  granted_by          uuid        not null,
  granted_at          timestamptz not null default now(),
  revoked_by          uuid,
  revoked_at          timestamptz,
  consumed_channel_id uuid,
  consumed_at         timestamptz,
  constraint whatsapp_official_connection_grants_revoked_pair_chk
    check ((revoked_at is null) = (revoked_by is null)),
  constraint whatsapp_official_connection_grants_consumed_pair_chk
    check ((consumed_at is null) = (consumed_channel_id is null)),
  constraint whatsapp_official_connection_grants_revoked_or_consumed_chk
    check (revoked_at is null or consumed_at is null)
);

comment on table public.whatsapp_official_connection_grants is
  'Liberacao explicita do platform_admin para a unidade conectar UM canal oficial (Datafy parceiro). Consumida na assinatura confirmada. FORCE RLS sem policies: so service_role, via manage-channels.';
comment on column public.whatsapp_official_connection_grants.consumed_channel_id is
  'Canal de whatsapp_channels que consumiu a liberacao. Sem FK (registro historico); o guard exige, ao gravar, um canal existente da MESMA unidade.';

-- No máximo UMA liberação ativa (nem revogada, nem consumida) por unidade.
create unique index if not exists whatsapp_official_connection_grants_one_active_idx
  on public.whatsapp_official_connection_grants (unit_id)
  where revoked_at is null and consumed_at is null;

-- FK sem índice dispara o advisor (lint 0001); o parcial acima não cobre.
create index if not exists whatsapp_official_connection_grants_unit_idx
  on public.whatsapp_official_connection_grants (unit_id);
create index if not exists whatsapp_official_connection_grants_org_idx
  on public.whatsapp_official_connection_grants (organization_id);

-- ============================================================================
-- 2. Onboarding self-service, FORA de `whatsapp_channels` (spec §5.3)
-- ============================================================================
-- O canal Datafy existe antes de ter número. Em vez de afrouxar o invariante
-- "canal datafy nunca nasce sem `phone_number_id`" (a âncora de
-- `metaPayloadMatchesChannel`), esse intervalo vive aqui. A linha de
-- `whatsapp_channels` só nasce na confirmação, com `id = reserved_channel_id`.
--
-- `channel_token` e `webhook_secret` são credenciais: a tabela segue a postura
-- de `whatsapp_channels` (FORCE RLS sem policies, sem privilégio para
-- anon/authenticated). Nunca em log, DTO ou resposta. E são CÓPIA DE
-- TRABALHO: a autoritativa nasce em `whatsapp_channels` na confirmação, e
-- onboarding fechado (`completed`/`abandoned`) não pode guardá-las (CHECK).
--
-- O CLAIM (`claim_id`/`claim_step`/`claim_started_at`/`claim_expires_at`/
-- `claim_actor_id`) cerca os POSTs não idempotentes à Datafy. Só as RPCs da
-- seção 6 o escrevem; quem escreve direto na coluna fura a cerca.
create table if not exists public.whatsapp_datafy_onboardings (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  unit_id             uuid        not null references public.units(id) on delete cascade,
  grant_id            uuid                 references public.whatsapp_official_connection_grants(id),
  reserved_channel_id uuid        not null unique default gen_random_uuid(),
  datafy_channel_id   text        unique,
  channel_token       text,
  webhook_secret      text,
  datafy_webhook_id   text,
  state               text        not null default 'open'
    check (state in ('open', 'channel_created', 'webhook_ready', 'connected', 'completed', 'abandoned')),
  claim_id            uuid,
  claim_step          text
    check (claim_step in ('create_channel', 'create_webhook', 'subscribe')),
  claim_started_at    timestamptz,
  claim_expires_at    timestamptz,
  claim_actor_id      uuid,
  uncertain_steps     text[]      not null default '{}',
  last_error          text
    check (last_error ~ '^[A-Z0-9_]{1,64}$'),
  last_link_at        timestamptz,
  completed_at        timestamptz,
  abandoned_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint whatsapp_datafy_onboardings_claim_chk
    check (((claim_id is null) = (claim_started_at is null))
           and ((claim_id is null) = (claim_step is null))
           and ((claim_id is null) = (claim_expires_at is null))),
  -- Ator só existe junto de um claim; é limpo com ele.
  constraint whatsapp_datafy_onboardings_claim_actor_chk
    check (claim_id is not null or claim_actor_id is null),
  constraint whatsapp_datafy_onboardings_uncertain_steps_chk
    check (uncertain_steps <@ array['create_channel', 'create_webhook', 'subscribe']::text[]),
  -- A cópia de trabalho das credenciais não sobrevive ao onboarding.
  constraint whatsapp_datafy_onboardings_closed_no_credentials_chk
    check (state not in ('completed', 'abandoned') or (channel_token is null and webhook_secret is null)),
  -- Depois de `open`, só `abandoned` existe sem canal na Datafy.
  constraint whatsapp_datafy_onboardings_channel_after_open_chk
    check (state in ('open', 'abandoned') or datafy_channel_id is not null)
);

comment on table public.whatsapp_datafy_onboardings is
  'Onboarding self-service de canal Datafy (parceiro): o intervalo em que o canal existe na Datafy mas ainda nao tem phone_number_id. A linha de whatsapp_channels nasce na confirmacao com id = reserved_channel_id. Guarda credenciais: FORCE RLS sem policies, so service_role.';
comment on column public.whatsapp_datafy_onboardings.channel_token is
  'Copia de trabalho do token do canal Datafy. A autoritativa nasce em whatsapp_channels.credentials na confirmacao; onboarding completed/abandoned nao pode guarda-la (CHECK closed_no_credentials).';
comment on column public.whatsapp_datafy_onboardings.webhook_secret is
  'Copia de trabalho do segredo do webhook Datafy. A autoritativa nasce em whatsapp_channels.webhook_secret na confirmacao; onboarding completed/abandoned nao pode guarda-la (CHECK closed_no_credentials).';
comment on column public.whatsapp_datafy_onboardings.uncertain_steps is
  'Passos cujo POST pode ter acontecido sem resposta. Entram por release uncertain e pela retomada de um claim vencido (o passo do dono morto). So saem por release succeeded, reconciled_absent ou reconciled_present; failed MANTEM. Enquanto um passo estiver aqui, o claim dele devolve must_reconcile = true.';
comment on column public.whatsapp_datafy_onboardings.claim_expires_at is
  'Fim do lease do claim vivo, gravado com o TTL de QUEM o tomou. A vivacidade compara este instante com now(); o TTL do desafiante nao encurta o lease do dono.';
comment on column public.whatsapp_datafy_onboardings.claim_actor_id is
  'Quem segura o claim vivo (p_actor_id da RPC). Limpo no release.';

-- No máximo UM onboarding aberto por unidade. Corrida no `start` vira 23505,
-- que o handler resolve relendo.
create unique index if not exists whatsapp_datafy_onboardings_one_open_idx
  on public.whatsapp_datafy_onboardings (unit_id)
  where state not in ('completed', 'abandoned');

-- "Uma liberação paga um canal": a mesma liberação não alimenta dois
-- onboardings vivos. O abandonado não conta (revogar abandona; reconectar com
-- a mesma liberação abre outro).
create unique index if not exists whatsapp_datafy_onboardings_one_per_grant_idx
  on public.whatsapp_datafy_onboardings (grant_id)
  where grant_id is not null and state <> 'abandoned';

create index if not exists whatsapp_datafy_onboardings_unit_idx
  on public.whatsapp_datafy_onboardings (unit_id);
create index if not exists whatsapp_datafy_onboardings_org_idx
  on public.whatsapp_datafy_onboardings (organization_id);
create index if not exists whatsapp_datafy_onboardings_grant_idx
  on public.whatsapp_datafy_onboardings (grant_id) where grant_id is not null;

-- ============================================================================
-- 3. `whatsapp_channels`: estado da assinatura no provedor e âncora única
-- ============================================================================
-- Gravadas a partir do `getChannel` pós-operação (o efetivo, nunca o pedido).
alter table public.whatsapp_channels
  add column if not exists provider_subscribed_at            timestamptz,
  add column if not exists provider_subscription_canceled_at timestamptz,
  add column if not exists provider_paused_at                timestamptz;

-- `phone_number_id` é a âncora de `metaPayloadMatchesChannel`: dois canais
-- official/datafy com o mesmo número fariam o webhook validar o payload de um
-- no canal do outro. O índice vale ENTRE os dois providers (um `official`
-- legado e um `datafy` novo com o mesmo número colidem) e lê o número como o
-- núcleo lê (`_shared/whatsapp-echo-identity-core.ts`): aparado, e vazio não é
-- âncora. Sem o `btrim`, `"777"` e `" 777\n"` seriam dois números para o banco e
-- o mesmo para o webhook. Valor numérico no JSON (`888`) vira `'888'` pelo
-- `->>` e colide com a string. Ausente e JSON null ficam fora (o `btrim` de
-- NULL é NULL), e os providers não Meta também.
create unique index if not exists whatsapp_channels_meta_phone_number_idx
  on public.whatsapp_channels ((pg_catalog.btrim(credentials->>'phone_number_id', E' \t\r\n')))
  where provider in ('official', 'datafy')
    and pg_catalog.btrim(credentials->>'phone_number_id', E' \t\r\n') <> '';

-- ============================================================================
-- 4. Ledger de alertas operacionais externos (último envio por unidade/tipo)
-- ============================================================================
-- Gravado pelo worker de health DEPOIS de `delivered: true`. A cadência vive
-- aqui, não numa fila.
create table if not exists public.whatsapp_ops_alerts (
  id             uuid        primary key default gen_random_uuid(),
  unit_id        uuid        not null references public.units(id) on delete cascade,
  alert_type     text        not null
    check (alert_type in ('inbound_dead_letter', 'inbound_backlog_stalled', 'datafy_subscription_failed')),
  last_sent_at   timestamptz not null default now(),
  last_watermark timestamptz,
  constraint whatsapp_ops_alerts_unit_type_key unique (unit_id, alert_type)
);

comment on table public.whatsapp_ops_alerts is
  'Ultimo alerta operacional externo enviado por unidade e tipo (dead-letter, fila parada, assinatura Datafy recusada). Gravado so depois de entrega confirmada. FORCE RLS sem policies: so service_role.';

-- ============================================================================
-- 5. RLS forçada sem policies e ACL de tabela nas três tabelas novas
-- ============================================================================
-- Mesma disciplina de `whatsapp_channels`: sem policy, a separação entre
-- clientes depende do `.eq("unit_id", …)` no código. O `revoke` é a segunda
-- tranca, e inclui `service_role` para tirar TRUNCATE/REFERENCES/TRIGGER que
-- os default privileges do Supabase dão; o CRUD é reconcedido explicitamente.
alter table public.whatsapp_official_connection_grants enable row level security;
alter table public.whatsapp_official_connection_grants force row level security;
alter table public.whatsapp_datafy_onboardings enable row level security;
alter table public.whatsapp_datafy_onboardings force row level security;
alter table public.whatsapp_ops_alerts enable row level security;
alter table public.whatsapp_ops_alerts force row level security;

revoke all on table public.whatsapp_official_connection_grants from public, anon, authenticated, service_role;
revoke all on table public.whatsapp_datafy_onboardings from public, anon, authenticated, service_role;
revoke all on table public.whatsapp_ops_alerts from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.whatsapp_official_connection_grants to service_role;
grant select, insert, update, delete on table public.whatsapp_datafy_onboardings to service_role;
grant select, insert, update, delete on table public.whatsapp_ops_alerts to service_role;

-- ============================================================================
-- 5b. Guardas de tenant (mesma disciplina do touchpoint da 115)
-- ============================================================================
-- SECURITY INVOKER: só o service_role escreve (ele ignora RLS); qualquer outro
-- papel já é barrado pela RLS forçada e pelo `revoke`. `search_path = ''`
-- obriga a qualificar. Disparam só quando uma coluna de escopo muda.
--
-- Os vínculos de tenant são IMUTÁVEIS depois do INSERT: a coerência
-- organização × unidade (× liberação) é checada uma vez e não pode ser
-- desfeita por UPDATE. Mover a linha para outra unidade da MESMA organização
-- passaria na coerência e levaria junto liberação, credenciais e claim.
create or replace function public.whatsapp_official_connection_grants_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_unit_org uuid;
begin
  if tg_op = 'UPDATE'
     and (new.organization_id is distinct from old.organization_id
          or new.unit_id is distinct from old.unit_id) then
    raise exception 'whatsapp_official_connection_grants: organizacao e unidade sao imutaveis (liberacao %)', old.id
      using errcode = 'check_violation';
  end if;

  select u.organization_id into v_unit_org from public.units u where u.id = new.unit_id;

  if v_unit_org is null then
    raise exception 'whatsapp_official_connection_grants: unidade % inexistente', new.unit_id
      using errcode = 'check_violation';
  end if;

  if new.organization_id is distinct from v_unit_org then
    raise exception 'whatsapp_official_connection_grants: organizacao % nao e a da unidade %', new.organization_id, new.unit_id
      using errcode = 'check_violation';
  end if;

  -- Sem FK (ver a seção 1): o canal que consome a liberação é conferido aqui,
  -- quando é gravado — existente e da MESMA unidade.
  if new.consumed_channel_id is not null
     and (tg_op = 'INSERT' or new.consumed_channel_id is distinct from old.consumed_channel_id)
     and not exists (
       select 1 from public.whatsapp_channels ch
        where ch.id = new.consumed_channel_id and ch.unit_id = new.unit_id
     ) then
    raise exception 'whatsapp_official_connection_grants: canal % nao e da unidade %', new.consumed_channel_id, new.unit_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists whatsapp_official_connection_grants_guard_trg on public.whatsapp_official_connection_grants;
create trigger whatsapp_official_connection_grants_guard_trg
  before insert or update of organization_id, unit_id, consumed_channel_id on public.whatsapp_official_connection_grants
  for each row execute function public.whatsapp_official_connection_grants_guard();

-- Além de organização × unidade, a liberação referenciada tem de ser da MESMA
-- unidade: onboarding da unidade A não consome a liberação da unidade B. Uma
-- liberação pode ser ANEXADA depois (`grant_id` nulo → valor), mas uma vez
-- gravada não troca nem some.
create or replace function public.whatsapp_datafy_onboardings_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_unit_org uuid;
begin
  if tg_op = 'UPDATE'
     and (new.organization_id is distinct from old.organization_id
          or new.unit_id is distinct from old.unit_id
          or (old.grant_id is not null and new.grant_id is distinct from old.grant_id)) then
    raise exception 'whatsapp_datafy_onboardings: organizacao, unidade e liberacao gravada sao imutaveis (onboarding %)', old.id
      using errcode = 'check_violation';
  end if;

  select u.organization_id into v_unit_org from public.units u where u.id = new.unit_id;

  if v_unit_org is null then
    raise exception 'whatsapp_datafy_onboardings: unidade % inexistente', new.unit_id
      using errcode = 'check_violation';
  end if;

  if new.organization_id is distinct from v_unit_org then
    raise exception 'whatsapp_datafy_onboardings: organizacao % nao e a da unidade %', new.organization_id, new.unit_id
      using errcode = 'check_violation';
  end if;

  if new.grant_id is not null and not exists (
    select 1 from public.whatsapp_official_connection_grants g
     where g.id = new.grant_id and g.unit_id = new.unit_id
  ) then
    raise exception 'whatsapp_datafy_onboardings: liberacao % nao pertence a unidade %', new.grant_id, new.unit_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists whatsapp_datafy_onboardings_guard_trg on public.whatsapp_datafy_onboardings;
create trigger whatsapp_datafy_onboardings_guard_trg
  before insert or update of organization_id, unit_id, grant_id on public.whatsapp_datafy_onboardings
  for each row execute function public.whatsapp_datafy_onboardings_guard();

-- `updated_at` pelo relógio do banco, em toda escrita (RPC ou `manage-channels`).
drop trigger if exists whatsapp_datafy_onboardings_updated_at on public.whatsapp_datafy_onboardings;
create trigger whatsapp_datafy_onboardings_updated_at
  before update on public.whatsapp_datafy_onboardings
  for each row execute function public.update_updated_at();

-- ============================================================================
-- 6. RPC claim_datafy_onboarding_step — cerca dos POSTs não idempotentes
-- ============================================================================
-- Um claim por onboarding (não um por passo). Posse e TTL comparados no SQL:
-- `now()` escreve e `now()` compara; nunca um instante do chamador. O lease
-- vale pelo TTL de QUEM o tomou (`claim_expires_at`): um desafiante com TTL
-- menor não encurta o lease do dono.
--
--   * onboarding de outra unidade        -> 42501 (o EF filtra por `unit_id`;
--     esta é a segunda tranca, não a primeira)
--   * claim vivo                         -> claimed = false, claim_id NULO
--     (devolver a cerca de quem segura deixaria o perdedor liberá-la);
--   * claim vencido                      -> novo claim, must_reconcile = true
--     para QUALQUER passo pedido, e o passo do dono morto entra em
--     `uncertain_steps` (o POST dele pode ter acontecido; a incerteza fica
--     registrada até um release que a resolva, mesmo que quem retoma peça
--     outro passo);
--   * passo em `uncertain_steps`         -> novo claim, must_reconcile = true;
--   * senão                              -> novo claim, must_reconcile = false;
--   * linha completed/abandoned          -> `onboarding_closed` (23514).
--
-- TTL limitado a 30..900 s: abaixo de 30 um clique duplo lento passaria; acima
-- de 900 um chamador prenderia a linha por um quarto de hora.
--
-- `for update` é a exclusão: o segundo chamador concorrente espera o primeiro
-- commitar e relê o claim já gravado. Medido com duas sessões no
-- 61b-concorrencia-datafy-onboarding.sh (sem o lock, os dois levam).
--
-- Os comentários `-- <ttl>` e `-- <takeover-incerto>` (e os de fechamento) NÃO
-- são decoração: os controles positivos do pré-voo recortam entre eles. Não
-- os remova.
create or replace function public.claim_datafy_onboarding_step(
  p_onboarding_id uuid,
  p_unit_id uuid,
  p_step text,
  p_actor_id uuid,
  p_ttl_seconds integer default 120
)
returns table (
  claimed boolean,
  claim_id uuid,
  must_reconcile boolean,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.whatsapp_datafy_onboardings%rowtype;
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 120), 900));
  v_claim uuid;
  v_must_reconcile boolean;
  v_uncertain text[];
begin
  if p_step is null or p_step not in ('create_channel', 'create_webhook', 'subscribe') then
    raise exception 'invalid_onboarding_step' using errcode = '22023';
  end if;

  select o.* into v_row
    from public.whatsapp_datafy_onboardings o
   where o.id = p_onboarding_id
   for update;

  if not found then
    raise exception 'onboarding_not_found' using errcode = 'P0002';
  end if;

  if v_row.unit_id is distinct from p_unit_id then
    raise exception 'onboarding_unit_mismatch' using errcode = '42501';
  end if;

  if v_row.state in ('completed', 'abandoned') then
    raise exception 'onboarding_closed' using errcode = 'check_violation';
  end if;

  if v_row.claim_id is not null
     -- <ttl>
     and v_row.claim_expires_at > pg_catalog.now()
     -- </ttl>
  then
    return query select false, null::uuid, false, v_row.state;
    return;
  end if;

  -- Aqui um claim ainda presente só pode estar vencido.
  v_uncertain := v_row.uncertain_steps;
  -- <takeover-incerto>
  if v_row.claim_id is not null and not (v_row.claim_step = any(v_uncertain)) then
    v_uncertain := pg_catalog.array_append(v_uncertain, v_row.claim_step);
  end if;
  -- </takeover-incerto>
  v_must_reconcile := v_row.claim_id is not null or p_step = any(v_uncertain);
  v_claim := pg_catalog.gen_random_uuid();

  update public.whatsapp_datafy_onboardings o
     set claim_id = v_claim,
         claim_step = p_step,
         claim_started_at = pg_catalog.now(),
         claim_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => v_ttl),
         claim_actor_id = p_actor_id,
         uncertain_steps = v_uncertain
   where o.id = p_onboarding_id;

  return query select true, v_claim, v_must_reconcile, v_row.state;
end;
$$;

-- ============================================================================
-- 7. RPC release_datafy_onboarding_step — fecha o claim com o desfecho
-- ============================================================================
-- Cerca: `claim_id` E `claim_step` têm de bater, senão 40001
-- (`stale_onboarding_claim`) — o dono antigo de um claim retomado não escreve
-- por cima do novo. `p_claim_id` nulo é recusado explicitamente: numa linha sem
-- claim, `null is distinct from null` é falso e a cerca passaria. Onboarding de
-- outra unidade: 42501, antes da cerca.
--
-- `uncertain_steps`:
--   * `uncertain`                                  -> acrescenta o passo (sem duplicar);
--   * `failed`                                     -> MANTÉM como está: falhar a
--     reconciliação (ambígua, recusada) não prova que o POST anterior não
--     aconteceu, e tirar o passo daqui liberaria o próximo claim para postar às
--     cegas;
--   * `succeeded`, `reconciled_absent`, `reconciled_present` -> retiram o passo.
-- `last_error` recebe `p_error_code` (nulo limpa).
--
-- O release vale mesmo com o claim vencido, se ninguém o retomou: o dono é o
-- único que agiu, e o desfecho dele é a verdade.
--
-- Os comentários `-- <failed-mantem>` / `-- </failed-mantem>` NÃO são
-- decoração: o controle positivo C6b-CTRL do pré-voo recorta entre eles.
create or replace function public.release_datafy_onboarding_step(
  p_onboarding_id uuid,
  p_unit_id uuid,
  p_claim_id uuid,
  p_step text,
  p_outcome text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit_id uuid;
  v_claim_id uuid;
  v_claim_step text;
begin
  if p_outcome is null
     or p_outcome not in ('succeeded', 'failed', 'uncertain', 'reconciled_absent', 'reconciled_present') then
    raise exception 'invalid_onboarding_outcome' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,64}$' then
    raise exception 'invalid_onboarding_error_code' using errcode = '22023';
  end if;

  select o.unit_id, o.claim_id, o.claim_step into v_unit_id, v_claim_id, v_claim_step
    from public.whatsapp_datafy_onboardings o
   where o.id = p_onboarding_id
   for update;

  if not found then
    raise exception 'onboarding_not_found' using errcode = 'P0002';
  end if;

  if v_unit_id is distinct from p_unit_id then
    raise exception 'onboarding_unit_mismatch' using errcode = '42501';
  end if;

  if p_claim_id is null
     or v_claim_id is distinct from p_claim_id
     or v_claim_step is distinct from p_step then
    raise exception 'stale_onboarding_claim' using errcode = '40001';
  end if;

  update public.whatsapp_datafy_onboardings o
     set uncertain_steps = case
           when p_outcome = 'uncertain' then
             case when p_step = any(o.uncertain_steps) then o.uncertain_steps
                  else pg_catalog.array_append(o.uncertain_steps, p_step) end
           -- <failed-mantem>
           when p_outcome = 'failed' then o.uncertain_steps
           -- </failed-mantem>
           else pg_catalog.array_remove(o.uncertain_steps, p_step)
         end,
         last_error = p_error_code,
         claim_id = null,
         claim_step = null,
         claim_started_at = null,
         claim_expires_at = null,
         claim_actor_id = null
   where o.id = p_onboarding_id;

  return true;
end;
$$;

-- ============================================================================
-- 8. ACL das funções
-- ============================================================================
-- `CREATE FUNCTION` concede EXECUTE a PUBLIC, e os default privileges do
-- Supabase a anon/authenticated/service_role. As RPCs: só service_role
-- (manage-channels). As trigger functions: nenhum grant explícito; o revoke
-- fecha PUBLIC/anon/authenticated (chamada direta pelo PostgREST), e o
-- EXECUTE que o service_role herda dos default privileges é inofensivo —
-- disparar não exige EXECUTE, e trigger function não é chamável fora de
-- trigger.
revoke all on function public.claim_datafy_onboarding_step(uuid, uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_datafy_onboarding_step(uuid, uuid, text, uuid, integer) to service_role;
revoke all on function public.release_datafy_onboarding_step(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.release_datafy_onboarding_step(uuid, uuid, uuid, text, text, text) to service_role;
revoke all on function public.whatsapp_official_connection_grants_guard() from public, anon, authenticated;
revoke all on function public.whatsapp_datafy_onboardings_guard() from public, anon, authenticated;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS forçada e sem policies nas três tabelas (esperado: 3 linhas t, t; depois 0):
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname in ('whatsapp_official_connection_grants','whatsapp_datafy_onboardings','whatsapp_ops_alerts');
--   select count(*) from pg_policies
--    where tablename in ('whatsapp_official_connection_grants','whatsapp_datafy_onboardings','whatsapp_ops_alerts');
-- 2. RPCs só para service_role (esperado: f, f, t, f, f, t):
--   select has_function_privilege('anon', 'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)', 'execute'),
--          has_function_privilege('service_role', 'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)', 'execute'),
--          has_function_privilege('anon', 'public.release_datafy_onboarding_step(uuid,uuid,uuid,text,text,text)', 'execute'),
--          has_function_privilege('authenticated', 'public.release_datafy_onboarding_step(uuid,uuid,uuid,text,text,text)', 'execute'),
--          has_function_privilege('service_role', 'public.release_datafy_onboarding_step(uuid,uuid,uuid,text,text,text)', 'execute');
-- 3. Índice único da âncora presente, com o btrim (esperado: 1 linha):
--   select indexdef from pg_indexes where indexname = 'whatsapp_channels_meta_phone_number_idx';
--
-- Rollback:
--   drop function if exists public.release_datafy_onboarding_step(uuid, uuid, uuid, text, text, text);
--   drop function if exists public.claim_datafy_onboarding_step(uuid, uuid, text, uuid, integer);
--   drop table if exists public.whatsapp_ops_alerts;
--   drop table if exists public.whatsapp_datafy_onboardings;
--   drop table if exists public.whatsapp_official_connection_grants;
--   drop function if exists public.whatsapp_datafy_onboardings_guard();
--   drop function if exists public.whatsapp_official_connection_grants_guard();
--   drop index if exists public.whatsapp_channels_meta_phone_number_idx;
--   alter table public.whatsapp_channels
--     drop column if exists provider_subscribed_at,
--     drop column if exists provider_subscription_canceled_at,
--     drop column if exists provider_paused_at;
