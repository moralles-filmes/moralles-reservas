-- Migração de loja em produção para o WhatsApp oficial (Datafy): liberação de
-- migração presa pelo servidor ao binding operacional, autoridade SQL única
-- que a aceita, e ativação retida no finalizador.
--
-- Spec: docs/superpowers/specs/2026-10-16-datafy-migracao-loja-em-producao-design.md (§5.1–§5.3)
-- Plano: docs/superpowers/plans/2026-10-16-datafy-migracao-loja-em-producao.md (Task 1.1)
-- Pré-voo: supabase/tests/local-preflight/65a-datafy-migration-bootstrap.sql e
--          65-datafy-migration-grant.sql (seção no README do harness).
--
-- O QUE MUDA:
--   1. `whatsapp_official_connection_grants.replaces_channel_id`: NULL na
--      liberação comum; na de migração, o id do canal operacional (binding) de
--      outro provider que o canal oficial vai substituir. O servidor decide
--      SEMPRE (trigger BEFORE INSERT, sob lock da unidade e dos canais, com o
--      predicado de binding de `assert_datafy_first_configuration`) e o valor
--      vindo do chamador é sobrescrito. Sem binding no instante da liberação,
--      prende o legado mais antigo de outro provider com `is_active` NULL em
--      qualquer status: um legado fora do ar (QR vencido) segue sendo o canal
--      operacional, e sem o pin a liberação nasceria comum e o próximo eco
--      ativaria a datafy sozinha; ao reconectar, o binding volta a ser ele e a
--      autoridade casa com o pin. Depois do INSERT é imutável. Liberação
--      comum já existente não vira migração (sem backfill): o admin revoga e
--      libera de novo.
--   2. `assert_datafy_first_configuration(uuid)`: além de "sem binding" e
--      "binding datafy", aceita binding de outro provider quando existe
--      liberação da unidade, não revogada, presa a ESSE binding, ainda ativa ou
--      consumida por canal datafy da mesma unidade. Binding trocado depois da
--      liberação a invalida. Mesma assinatura e retorno: as quatro chamadoras
--      (authorize_datafy_mutation, finalize_datafy_channel_subscription,
--      request_whatsapp_channel_activation, activate_whatsapp_channel)
--      continuam valendo sem reescrita.
--   3. `finalize_datafy_channel_subscription(...)`: só pede intenção e ativa na
--      primeira configuração. Com liberação de migração, consome, conclui o
--      onboarding e devolve 'finalized' sem autoridade, intenção nem ativação.
--      Nos demais caminhos (liberação comum e vínculo administrativo com
--      `p_grant_id` nulo) a autoridade roda primeiro — binding de outro
--      provider sem liberação presa continua recusando — e, se ela passar com
--      binding de outro provider, a ativação também fica retida. Sem intenção,
--      o eco nunca ativa; o corte é o `begin_switch` explícito do admin. O
--      resto do corpo é o da 20261014170540.
--
-- ACL: `create or replace` preserva a ACL do OBJETO (não reabre o EXECUTE a
-- PUBLIC; só `drop` + `create` reabriria). Os `revoke`/`grant` das duas funções
-- substituídas são repetidos mesmo assim, com a assinatura completa, para
-- sobreviver a alguém trocar a forma para `drop` + `create`. A trigger function
-- NOVA nasce executável por PUBLIC (grant implícito do CREATE FUNCTION) e pelos
-- default privileges do Supabase, e é revogada aqui; disparar trigger não exige
-- EXECUTE.
--
-- ORDEM DE DEPLOY: `supabase db push` desta migration ANTES do deploy de
-- `manage-channels` que leia `replaces_channel_id`.
--
-- TRANSAÇÃO EXPLÍCITA: o runner pode executar statement por statement; coluna,
-- trigger e as duas funções entram juntas ou não entram.
--
-- Idempotente: `add column if not exists`, `create or replace function`,
-- `drop trigger if exists` + `create trigger`, `comment on` e os
-- `revoke`/`grant` reafirmados.
--
-- ROLLBACK (forward-only, sem DROP destrutivo): a coluna é registro histórico
-- de quais liberações foram de migração e fica. Para desligar a migração, uma
-- migration NOVA repõe por `create or replace` os corpos de
-- `assert_datafy_first_configuration` e `finalize_datafy_channel_subscription`
-- da 20261014170540 e dropa só o trigger de pin; a autoridade volta a recusar
-- binding de outro provider e as liberações presas deixam de autorizar sozinhas.
begin;

-- ============================================================================
-- 1. Coluna: o binding que a liberação de migração substitui
-- ============================================================================
-- Sem FK, pela mesma razão de `consumed_channel_id` (20261014120000, seção 1):
-- registro histórico. Com `on delete set null` a FK coagiria o valor e
-- esbarraria no trigger de imutabilidade (o conflito FK × CHECK da 089); sem
-- `set null`, apagar o canal antigo ficaria bloqueado pelo histórico.
alter table public.whatsapp_official_connection_grants
  add column if not exists replaces_channel_id uuid;

comment on column public.whatsapp_official_connection_grants.replaces_channel_id is
  'Canal operacional (binding) de outro provider que esta liberacao de migracao substitui. NULL na liberacao comum. Preenchida SEMPRE pelo servidor (trigger whatsapp_official_connection_grants_migration_pin_trg, sob lock da unidade e dos canais); o valor do chamador e sobrescrito e a coluna e imutavel depois do INSERT. Sem FK: registro historico.';

-- ============================================================================
-- 2. Trigger de pin: o servidor decide, nunca o corpo da requisição
-- ============================================================================
-- BEFORE INSERT: trava `units` e depois os canais da unidade ordenados por id,
-- na mesma ordem das autoridades Datafy (unidade → canais → onboarding →
-- liberação), e calcula o binding com EXATAMENTE o predicado de
-- `assert_datafy_first_configuration` — ativo explícito vence; `false` nunca
-- participa; fallback só entre legados NULL + connected, o mais antigo.
-- O nome ordena DEPOIS de `whatsapp_official_connection_grants_guard_trg`
-- (triggers BEFORE da mesma tabela disparam em ordem alfabética), então o guard
-- de unidade × organização roda antes e a unidade existe aqui.
--
-- Sem binding (NULL), prende o legado mais antigo de outro provider com
-- `is_active` NULL em QUALQUER status: fora do ar agora ainda é o canal
-- operacional da loja (ver o comentário no corpo). `false` nunca conta.
--
-- BEFORE UPDATE OF replaces_channel_id: imutável. Revogar e consumir não tocam
-- a coluna e não disparam este trigger.
--
-- Os comentários `-- <pin>`/`-- </pin>` e `-- <fallback-legado>`/
-- `-- </fallback-legado>` NÃO são decoração: os controles positivos (a) e (e)
-- do pré-voo 65 recortam entre eles. Não os remova.
create or replace function public.whatsapp_official_connection_grants_migration_pin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding_id uuid;
  v_binding_provider text;
begin
  if tg_op = 'UPDATE' then
    if new.replaces_channel_id is distinct from old.replaces_channel_id then
      raise exception 'whatsapp_official_connection_grants: replaces_channel_id e imutavel (liberacao %)', old.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  perform 1 from public.units u where u.id = new.unit_id for update;
  perform 1 from public.whatsapp_channels ch where ch.unit_id = new.unit_id order by ch.id for update;

  select ch.id, ch.provider into v_binding_id, v_binding_provider
    from public.whatsapp_channels ch
   where ch.unit_id = new.unit_id
     and (ch.is_active is true or (ch.is_active is null and ch.status = 'connected'))
   order by (ch.is_active is true) desc, ch.created_at asc nulls last, ch.id
   limit 1;

  -- <fallback-legado>
  -- Sem binding agora: o legado de outro provider (`is_active` NULL) que está
  -- fora do ar neste instante (QR vencido, queda) continua sendo o canal
  -- operacional da loja. Prendê-lo faz o finalizador reter a ativação mesmo
  -- com o binding NULL (liberação de migração), e quando o legado reconectar
  -- o binding volta a ser ele e a autoridade casa com o pin. Sem isto, a
  -- liberação nasceria comum e o próximo eco ativaria a datafy: corte não
  -- autorizado de loja em produção. `false` nunca conta; datafy não é legado
  -- a substituir.
  if v_binding_provider is null then
    select ch.id, ch.provider into v_binding_id, v_binding_provider
      from public.whatsapp_channels ch
     where ch.unit_id = new.unit_id
       and ch.provider <> 'datafy'
       and ch.is_active is null
     order by ch.created_at asc nulls last, ch.id
     limit 1;
  end if;
  -- </fallback-legado>

  -- <pin>
  new.replaces_channel_id := case
    when v_binding_provider is not null and v_binding_provider <> 'datafy' then v_binding_id
  end;
  -- </pin>
  return new;
end;
$$;

revoke all on function public.whatsapp_official_connection_grants_migration_pin() from public, anon, authenticated, service_role;

drop trigger if exists whatsapp_official_connection_grants_migration_pin_trg on public.whatsapp_official_connection_grants;
create trigger whatsapp_official_connection_grants_migration_pin_trg
  before insert or update of replaces_channel_id on public.whatsapp_official_connection_grants
  for each row execute function public.whatsapp_official_connection_grants_migration_pin();

-- ============================================================================
-- 3. Autoridade SQL única: primeira configuração OU migração liberada
-- ============================================================================
-- Chamadores transacionais tomam unit → canais ordenados antes de decidir.
-- Mesmo provider é permitido; false nunca faz parte do fallback legado.
-- Binding de outro provider só passa com liberação presa a ELE (pin do
-- servidor), não revogada, ativa ou consumida por canal datafy da unidade:
-- consumo por canal de outro provider não é migração para o oficial.
-- Limite aceito (spec §5.2): a checagem não amarra o canal ALVO; outra linha
-- datafy exigiria onboarding e liberação próprios, e a ativação já exige
-- assinatura confirmada e prova de eco.
create or replace function public.assert_datafy_first_configuration(p_unit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_binding_id uuid; v_provider text;
begin
  perform 1 from public.units where id=p_unit_id for update;
  perform 1 from public.whatsapp_channels where unit_id=p_unit_id order by id for update;
  select id,provider into v_binding_id,v_provider from public.whatsapp_channels where unit_id=p_unit_id
    and (is_active is true or (is_active is null and status='connected'))
    order by (is_active is true) desc,created_at asc nulls last,id limit 1;
  if v_provider is null or v_provider='datafy' then
    return;
  end if;
  if exists(select 1 from public.whatsapp_official_connection_grants g
    where g.unit_id=p_unit_id
      and g.revoked_at is null
      and g.replaces_channel_id=v_binding_id
      and (g.consumed_channel_id is null or exists(select 1 from public.whatsapp_channels c
        where c.id=g.consumed_channel_id and c.unit_id=p_unit_id and c.provider='datafy'))) then
    return;
  end if;
  raise exception 'datafy_migration_not_supported' using errcode='23514';
end $$;
revoke all on function public.assert_datafy_first_configuration(uuid) from public,anon,authenticated,service_role;

-- ============================================================================
-- 4. Finalizador: ativação retida com liberação de migração
-- ============================================================================
-- Corpo da 20261014170540; muda SÓ o bloco final de ativação, que retém a
-- ativação por DUAS condições, ambas necessárias:
--   * liberação de migração usada (`g.replaces_channel_id` preenchido): sem
--     autoridade, intenção nem ativação, mesmo que o binding tenha sumido ou
--     virado datafy antes do finalizador (a liberação de migração nunca ativa
--     sozinha), e mesmo que o binding tenha TROCADO — o subscribe já foi pago
--     com a autoridade conferida em `authorize_datafy_mutation`, então o fato
--     é registrado (consumo + onboarding concluído) em vez de recusado para
--     sempre; o corte posterior recusa até nova liberação;
--   * binding atual de outro provider, depois da autoridade: cobre o vínculo
--     administrativo (`p_grant_id` nulo, `configure_webhook`), que não tem
--     liberação para inspecionar e passaria pela autoridade graças à liberação
--     de migração consumida pelo canal.
-- A autoridade continua rodando antes da decisão nos caminhos sem liberação de
-- migração: binding de outro provider sem liberação presa recusa (sem sucesso
-- silencioso).
--
-- Os comentários `-- <ativacao-retida>` / `-- </ativacao-retida>` NÃO são
-- decoração: os controles positivos (b) e (d) do pré-voo 65 recortam entre
-- eles.
--
-- A leitura de pin seguida de UPDATE/RPCs separados permitiria relink entre
-- consumo e ativação. Mesma ordem de locks da autoridade de cutover: unit →
-- channels ordenados → onboarding → grant. Falha faz rollback de todo finisher.
create or replace function public.finalize_datafy_channel_subscription(
  p_channel_id uuid,p_unit_id uuid,p_actor_id uuid,p_claim_id uuid,p_onboarding_id uuid,
  p_grant_id uuid,p_external_id text,p_revision bigint,p_request_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_channels%rowtype; o public.whatsapp_datafy_onboardings%rowtype;
  g public.whatsapp_official_connection_grants%rowtype; v_binding_provider text;
begin
  perform 1 from public.units where id=p_unit_id for update;
  perform 1 from public.whatsapp_channels where unit_id=p_unit_id order by id for update;
  select * into c from public.whatsapp_channels where id=p_channel_id;
  if not found or c.unit_id is distinct from p_unit_id or c.provider<>'datafy' then
    raise exception 'datafy_finalize_forbidden' using errcode='42501';
  end if;
  if p_claim_id is null or c.external_instance_id is distinct from p_external_id or c.template_credential_revision is distinct from p_revision then
    raise exception 'stale_datafy_finalize_claim' using errcode='40001';
  end if;
  if p_onboarding_id is not null then
    select * into o from public.whatsapp_datafy_onboardings where id=p_onboarding_id for update;
    if not found or o.unit_id is distinct from p_unit_id or o.reserved_channel_id is distinct from p_channel_id
      or o.datafy_channel_id is distinct from p_external_id or o.claim_id is distinct from p_claim_id
      or o.claim_step is distinct from 'subscribe' or o.claim_actor_id is distinct from p_actor_id then
      raise exception 'stale_datafy_finalize_claim' using errcode='40001';
    end if;
  elsif c.datafy_subscription_claim_id is distinct from p_claim_id or c.datafy_subscription_claim_actor_id is distinct from p_actor_id
    or c.datafy_subscription_operation is null or c.datafy_subscription_operation not in ('subscribe','configure_webhook') then
    raise exception 'stale_datafy_finalize_claim' using errcode='40001';
  end if;
  if c.provider_subscribed_at is null then return 'subscription_not_confirmed'; end if;
  if p_grant_id is null then
    -- Somente o link administrativo de canal JÁ assinado dispensa nova liberação;
    -- um claim de subscribe nunca ganha esse caminho sem custo autorizado.
    if p_onboarding_id is not null or c.datafy_subscription_operation is distinct from 'configure_webhook'
      or not exists(select 1 from public.platform_admins where user_id=p_actor_id) then
      raise exception 'datafy_finalize_grant_required' using errcode='42501';
    end if;
  else
    select * into g from public.whatsapp_official_connection_grants where id=p_grant_id for update;
    if not found or g.unit_id is distinct from p_unit_id then raise exception 'datafy_finalize_forbidden' using errcode='42501'; end if;
    if g.revoked_at is not null or (g.consumed_channel_id is not null and g.consumed_channel_id<>p_channel_id) then
      return 'grant_revoked';
    end if;
    if g.consumed_at is null then
      update public.whatsapp_official_connection_grants set consumed_channel_id=p_channel_id,consumed_at=pg_catalog.now() where id=g.id;
    end if;
  end if;
  -- <ativacao-retida>
  -- Liberação de migração usada: nem autoridade, nem intenção, nem ativação.
  -- Demais caminhos (liberação comum e vínculo administrativo sem liberação):
  -- a autoridade roda primeiro e recusa binding de outro provider sem
  -- liberação presa; se passar com binding de outro provider (migração
  -- liberada), a ativação também fica retida. Só primeira configuração
  -- (binding ausente ou datafy) pede intenção e ativa.
  if c.provider_subscription_canceled_at is null and c.provider_paused_at is null and c.is_active is distinct from true
     and (p_grant_id is null or g.replaces_channel_id is null) then
    perform public.assert_datafy_first_configuration(p_unit_id);
    select ch.provider into v_binding_provider from public.whatsapp_channels ch where ch.unit_id=p_unit_id
      and (ch.is_active is true or (ch.is_active is null and ch.status='connected'))
      order by (ch.is_active is true) desc,ch.created_at asc nulls last,ch.id limit 1;
    if v_binding_provider is null or v_binding_provider='datafy' then
      if c.activation_requested_at is null then
        perform public.request_whatsapp_channel_activation(p_unit_id,p_channel_id,p_actor_id,p_request_id);
      end if;
      if c.manual_echo_verified_at is not null and c.status='connected' then
        perform public.activate_whatsapp_channel(p_unit_id,p_channel_id,p_actor_id,p_request_id);
      end if;
    end if;
  end if;
  -- </ativacao-retida>
  if p_onboarding_id is not null and o.state not in ('completed','abandoned') then
    update public.whatsapp_datafy_onboardings set state='completed',completed_at=pg_catalog.now(),channel_token=null,webhook_secret=null where id=o.id;
  end if;
  return 'finalized';
end $$;
revoke all on function public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text) to service_role;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Coluna e trigger (esperado: 1 linha uuid/nullable; 1 trigger, depois do guard):
--   select attname, format_type(atttypid, atttypmod), attnotnull from pg_attribute
--    where attrelid = 'public.whatsapp_official_connection_grants'::regclass and attname = 'replaces_channel_id';
--   select tgname from pg_trigger where tgrelid = 'public.whatsapp_official_connection_grants'::regclass
--    and not tgisinternal order by tgname;
-- 2. ACL por papel anon, authenticated, service_role (esperado: f,f,f / f,f,f / f,f,t):
--   select has_function_privilege(r, 'public.whatsapp_official_connection_grants_migration_pin()', 'execute')
--     from unnest(array['anon','authenticated','service_role']) r;
--   select has_function_privilege(r, 'public.assert_datafy_first_configuration(uuid)', 'execute')
--     from unnest(array['anon','authenticated','service_role']) r;
--   select has_function_privilege(r, 'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)', 'execute')
--     from unnest(array['anon','authenticated','service_role']) r;
-- 3. Nenhuma liberação existente virou migração (esperado: 0 imediatamente após o push):
--   select count(*) from public.whatsapp_official_connection_grants where replaces_channel_id is not null;
