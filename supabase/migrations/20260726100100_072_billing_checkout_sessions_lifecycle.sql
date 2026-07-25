-- Ciclo de vida das sessões de checkout (Fase 5a).
--
-- PROBLEMA: a 067 usa provider_checkout_id como PK e a linha só nasce DEPOIS de
-- o Asaas responder. Sem uma linha reservada ANTES da chamada, dois cliques no
-- mesmo botão abrem duas cobranças reais no Asaas (que não tem
-- Idempotency-Key), e não há como o segundo saber que o primeiro está em voo.
--
-- SOLUÇÃO: PK surrogate + status. O fluxo passa a ser
--   reserva ('creating') → chama o Asaas → 'pending' + url + expires_at
-- com 'failed' no erro. Um UNIQUE parcial sobre (organization_id, plan_id,
-- purpose) restrito aos status vivos é o que serializa os cliques.
--
-- expires_at é DERIVADO, não adivinhado: minutesToExpire (10–1440) é parâmetro
-- nosso na criação do checkout no Asaas.
--
-- AVISO DE SEQUENCIAMENTO: Esta migration e o redeploy de create-billing-checkout
-- sao UM UNICO passo de release. Enquanto o writer antigo estiver em producao,
-- a coluna status nao sera atualizada pelo codigo existente, e a linha fica presa
-- em 'creating'. A consequencia concreta: a segunda contratacao do mesmo
-- (organization_id, plan_id, purpose) falha com 23505 depois de criar uma
-- cobranca real no Asaas. O writer novo (Fase 5a, Task 9) varre status in
-- ('creating','pending') com expires_at < now() OU expires_at IS NULL com
-- created_at > 30 min para limpar linhas orfas. A janela de risco real eh
-- (db push -> function deploy) + 30 min.

begin;

-- 1. PK surrogate. provider_checkout_id vira coluna comum (nullable), porque na
--    reserva o id ainda não existe.
alter table billing_checkout_sessions
  add column if not exists id uuid not null default gen_random_uuid();

do $$
begin
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'billing_checkout_sessions'::regclass
       and c.contype = 'p'
       and array_length(c.conkey, 1) = 1
       and (select attname from pg_attribute
             where attrelid = c.conrelid and attnum = c.conkey[1]) = 'provider_checkout_id'
  ) then
    alter table billing_checkout_sessions drop constraint billing_checkout_sessions_pkey;
    alter table billing_checkout_sessions alter column provider_checkout_id drop not null;
    alter table billing_checkout_sessions add primary key (id);
  end if;
end $$;

-- O id do provedor continua único quando existe — é por ele que o aplicador do
-- webhook correlaciona o pagamento à organização.
create unique index if not exists billing_checkout_sessions_provider_id_idx
  on billing_checkout_sessions (provider_checkout_id)
  where provider_checkout_id is not null;

-- 2. Status + campos do ciclo. O backfill vive DENTRO do guard de criação da
--    coluna: um `update ... set status='used'` solto marcaria como usada, numa
--    segunda execução, uma sessão que está sendo criada naquele instante.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'billing_checkout_sessions'
       and column_name = 'status'
  ) then
    alter table billing_checkout_sessions
      add column status text not null default 'creating';
    -- Toda linha pré-existente veio do fluxo antigo: nasceu já com o checkout
    -- criado no Asaas, e as de sandbox já foram pagas. 'used' é o único valor
    -- que não as faz bloquear uma contratação nova pelo UNIQUE abaixo.
    update billing_checkout_sessions set status = 'used';
  end if;
end $$;

alter table billing_checkout_sessions
  add column if not exists checkout_url text,
  add column if not exists expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'billing_checkout_sessions_status_check'
  ) then
    alter table billing_checkout_sessions
      add constraint billing_checkout_sessions_status_check
      check (status in ('creating', 'pending', 'used', 'expired', 'canceled', 'failed'));
  end if;
end $$;

-- 3. Uma sessão VIVA por produto. Cobre o clique duplo e o "abri em duas abas".
--    Sessão morta (used/expired/canceled/failed) sai do índice e não atrapalha
--    a próxima tentativa.
create unique index if not exists billing_checkout_sessions_active_idx
  on billing_checkout_sessions (organization_id, plan_id, purpose)
  where status in ('creating', 'pending');

comment on column billing_checkout_sessions.status is
  'creating = reservada antes de chamar o provedor; pending = checkout aberto e pagavel; used = pagamento correlacionado; expired/canceled/failed = morta. UNIQUE parcial sobre (org, plan_id, purpose) nos dois primeiros serializa cliques. Linha presa em creating (enquanto writer antigo estiver ativo) bloqueia nova contratacao do produto ate ser varrida.';
comment on column billing_checkout_sessions.expires_at is
  'Derivado do minutesToExpire enviado ao Asaas — nao e palpite. Linha vencida e varrida para expired na proxima tentativa do mesmo produto.';

drop trigger if exists billing_checkout_sessions_updated_at on billing_checkout_sessions;
create trigger billing_checkout_sessions_updated_at
  before update on billing_checkout_sessions
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. PK é o id novo (esperado: 'id'):
--   select a.attname from pg_constraint c
--     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
--    where c.conrelid = 'billing_checkout_sessions'::regclass and c.contype = 'p';
--
-- 2. Nenhuma sessão antiga ficou viva (esperado: 0):
--   select count(*) from billing_checkout_sessions where status in ('creating','pending');
--
-- 3. provider_checkout_id aceita null (esperado: YES):
--   select is_nullable from information_schema.columns
--    where table_name = 'billing_checkout_sessions' and column_name = 'provider_checkout_id';
--
-- 4. Nenhuma sessao presa da janela de deploy (rodar depois do redeploy das EFs;
--    esperado: 0 linhas com mais de 30min):
--   select organization_id, plan_id, purpose, status, expires_at, created_at
--     from billing_checkout_sessions
--    where status in ('creating','pending')
--      and created_at < now() - interval '30 minutes';
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Aditiva. Para voltar ao comportamento antigo basta reverter as Edge Functions
-- (o writer novo é quem usa 'creating'); as colunas ficam. NÃO recriar a PK
-- antiga sem antes garantir provider_checkout_id not null em todas as linhas.
--
-- Mitigacao de emergencia se a janela de deploy travar contratacoes em producao:
--   drop index if exists billing_checkout_sessions_active_idx;
-- (O indice, nao as colunas, eh o que causa o bloqueio pelo UNIQUE parcial.)
