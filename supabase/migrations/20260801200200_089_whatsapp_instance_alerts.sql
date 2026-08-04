-- Ledger de alertas administrativos da instância (Fase 6b).
--
-- INDEPENDENTE DA FILA: billing_notifications_dispatch está OFF nesta fase, e
-- o painel é a superfície viva do alerta. Por isso o ledger carrega o próprio
-- tempo e a própria contagem — verificado no ambiente real que
-- billing_notifications NÃO tem created_at nem contador de tentativa, e hoje
-- não há como detectar uma fila parada. `dispatch_enabled_at_enqueue` existe
-- para que ninguém leia "não recebi e-mail" como "não houve alerta".
--
-- Chave de assunto em DOIS campos e não em instance_id: alerta econômico
-- pertence à ORGANIZAÇÃO, e chavear tudo por instância obrigaria a eleger uma
-- instância arbitrária para representar um desequilíbrio da organização.
--
-- Sem credencial e sem payload de provedor.

begin;

create table if not exists whatsapp_instance_alerts (
  id uuid primary key default gen_random_uuid(),

  subject_type text not null check (subject_type in ('INSTANCE', 'ORGANIZATION')),
  subject_id uuid not null,
  -- `restrict`, igual às duas tabelas irmãs: este é registro de auditoria e a
  -- deleção de uma organização não pode apagá-lo em silêncio. `cascade` aqui
  -- contradizia o `on delete set null` do channel_id logo abaixo, que existe
  -- exatamente para o ledger sobreviver à deleção do que ele descreve.
  --
  -- DIVERGE de billing_customers / organization_entitlement_overrides /
  -- whatsapp_implementations, que usam `cascade` — divergência deliberada.
  -- CONSEQUÊNCIA PARA QUEM VIER DEPOIS: hoje o `restrict` é inerte (o único
  -- DELETE de organizations é o rollback de criação em manage-organizations,
  -- que roda antes de existir linha filha). Uma feature futura de "excluir
  -- organização" (LGPD, encerramento de conta) VAI bater em violação de FK
  -- nestas três tabelas — ela precisa arquivar ou anonimizar antes do DELETE,
  -- e essa é a decisão certa: o histórico de custo não desaparece por tabela.
  organization_id uuid not null references organizations(id) on delete restrict,
  instance_id uuid references whatsapp_instances(id) on delete set null,
  -- Só CHANNEL_WITHOUT_INSTANCE preenche: o painel precisa dizer QUAL canal
  -- está fora do inventário e a resolução por backfill precisa da referência.
  -- `on delete set null` porque o ledger é registro de auditoria e não pode
  -- ser apagado em cascata; a identidade textual sobrevive no dedupe_key.
  channel_id uuid references whatsapp_channels(id) on delete set null,

  -- SEIS tipos, um para cada event_type de EVENT_TYPE_BY_ALERT em
  -- _shared/whatsapp-instance-alerts-core.ts (fonte canônica).
  --
  -- CUSTO DESCONHECIDO NÃO É TIPO: ele é pendência financeira visível no
  -- painel (ciclo em PENDING_REVIEW) e MOTIVO do D-1, não aviso isolado. Criar
  -- um tipo só porque um valor está NULL multiplicaria avisos sem multiplicar
  -- decisão.
  alert_type text not null check (alert_type in (
    'CYCLE_DUE_SOON', 'CYCLE_DUE_TOMORROW', 'END_CONFIRMATION_REQUIRED',
    'DATE_REVIEW_REQUIRED', 'DIVERGENCE', 'ECONOMIC_IMBALANCE'
  )),
  dedupe_key text not null,

  status text not null default 'OPEN'
    check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPERSEDED')),

  first_detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1 check (occurrences >= 1),
  last_reminder_at timestamptz,

  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_note text,

  -- Sem segredo, sem payload do provedor, sem conteúdo de conversa, sem dado
  -- pessoal do cliente final.
  payload jsonb not null default '{}'::jsonb,
  dispatch_enabled_at_enqueue boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Sujeito coerente. O ramo INSTANCE ACEITA `instance_id` nulo — e isso é
  -- exigência da FK logo acima, não folga.
  --
  -- Exigir `instance_id is not null` aqui tornava o `on delete set null`
  -- INEXECUTÁVEL: apagar a instância fazia a FK gravar NULL, o CHECK avaliar
  -- FALSE e o DELETE INTEIRO abortar com check_violation — o oposto exato do
  -- contrato desta tabela, que é sobreviver à deleção do que descreve. Não é
  -- teórico: um CHECK só reprova em FALSE, então a coerção da FK é a única
  -- escrita que consegue produzi-lo aqui.
  --
  -- Relaxar o CHECK SOZINHO abriria um buraco (INSERT de alerta INSTANCE com
  -- instance_id nulo e subject_id arbitrário passaria). O rigor original vive
  -- na trigger `whatsapp_alert_subject_guard` abaixo, que distingue INSERT de
  -- UPDATE — distinção que um CHECK, por construção, não sabe fazer.
  --
  -- O ramo ORGANIZATION exige `instance_id is null` EXPLICITAMENTE. Sem isso a
  -- garantia "alerta de organização não aponta instância" existia só no código
  -- produtor e no comentário — o schema aceitava a linha incoerente, e a guarda
  -- de tenant não a recusaria (ela valida a organização da instância, que
  -- bateria). Invariante afirmado no banco, não na intenção.
  constraint whatsapp_alerts_subject_chk check (
    (subject_type = 'INSTANCE' and (instance_id is null or subject_id = instance_id))
    or (subject_type = 'ORGANIZATION' and instance_id is null and subject_id = organization_id)
  ),

  -- Resolver e reconhecer exigem registro de quando.
  constraint whatsapp_alerts_resolved_chk check (
    status <> 'RESOLVED' or resolved_at is not null
  ),
  constraint whatsapp_alerts_ack_chk check (
    status <> 'ACKNOWLEDGED' or acknowledged_at is not null
  )
);

comment on table whatsapp_instance_alerts is
  'Ledger de alertas da instancia (Fase 6b). INDEPENDENTE da fila billing_notifications — registra mesmo com o dispatcher OFF. Sem credencial. FORCE RLS, so platform_admin.';

comment on column whatsapp_instance_alerts.channel_id is
  'Preenchido SO por CHANNEL_WITHOUT_INSTANCE. NULL nos demais tipos.';

comment on column whatsapp_instance_alerts.dispatch_enabled_at_enqueue is
  'Havia envio de e-mail ligado quando o alerta nasceu. Impede ler "nao recebi e-mail" como "nao houve alerta".';

create unique index if not exists whatsapp_alerts_dedupe_idx
  on whatsapp_instance_alerts (subject_type, subject_id, alert_type, dedupe_key);

create index if not exists whatsapp_alerts_open_idx
  on whatsapp_instance_alerts (organization_id, status)
  where status in ('OPEN', 'ACKNOWLEDGED');

create index if not exists whatsapp_alerts_reminder_idx
  on whatsapp_instance_alerts (status, last_reminder_at)
  where status = 'OPEN';

create index if not exists whatsapp_alerts_instance_idx
  on whatsapp_instance_alerts (instance_id)
  where instance_id is not null;

-- =====================================================================
-- Identidade do sujeito — o rigor que o CHECK não consegue expressar
-- =====================================================================
-- `subject_id` é IDENTIDADE HISTÓRICA e imutável: quando a instância é
-- fisicamente excluída, a FK nula `instance_id` e é `subject_id` que continua
-- dizendo de quem era o alerta. O painel marca a linha como "instância
-- removida" lendo exatamente esse par (INSTANCE + instance_id nulo).
--
-- Por que trigger e não CHECK: um CHECK avalia a linha isoladamente e não sabe
-- se ela está nascendo ou sendo coagida pela FK. A regra aqui é diferente nas
-- duas operações — no INSERT a instância PRECISA existir; no UPDATE ela pode
-- desaparecer, mas a identidade não pode ser reescrita.
create or replace function public.whatsapp_alert_subject_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Alerta de instância NASCE apontando instância viva. Idêntico à garantia
    -- que o CHECK dava antes de precisar acomodar a nulagem da FK.
    if new.subject_type = 'INSTANCE'
       and (new.instance_id is null or new.subject_id <> new.instance_id) then
      raise exception 'alerta INSTANCE exige instance_id vivo e subject_id igual a ele'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.subject_id is distinct from old.subject_id then
    raise exception 'subject_id e identidade historica e nao pode ser alterado'
      using errcode = 'check_violation';
  end if;

  if new.subject_type is distinct from old.subject_type then
    raise exception 'subject_type nao pode ser alterado'
      using errcode = 'check_violation';
  end if;

  -- `instance_id` só pode ir a NULL (ação da FK). Reapontar para OUTRA
  -- instância transferiria um registro de custo entre instâncias sem rastro.
  if old.instance_id is not null
     and new.instance_id is not null
     and new.instance_id <> old.instance_id then
    raise exception 'instance_id nao pode ser reapontado para outra instancia'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.whatsapp_alert_subject_guard()
  from public, anon, authenticated;

drop trigger if exists whatsapp_instance_alerts_subject_guard on whatsapp_instance_alerts;
create trigger whatsapp_instance_alerts_subject_guard
  before insert or update on whatsapp_instance_alerts
  for each row execute function public.whatsapp_alert_subject_guard();

-- =====================================================================
-- Guarda de tenant — reusa whatsapp_instance_child_tenant_guard (088)
-- =====================================================================
-- `whatsapp_alerts_subject_chk` garante que subject_id casa com instance_id
-- OU com organization_id, mas NÃO que a organização da instância referenciada
-- é a mesma da coluna organization_id desta linha. A trigger fecha isso.
-- Alerta de ORGANIZAÇÃO tem instance_id nulo e passa direto.
drop trigger if exists whatsapp_instance_alerts_tenant_guard on whatsapp_instance_alerts;
create trigger whatsapp_instance_alerts_tenant_guard
  before insert or update of organization_id, instance_id on whatsapp_instance_alerts
  for each row execute function public.whatsapp_instance_child_tenant_guard();

alter table whatsapp_instance_alerts enable row level security;
alter table whatsapp_instance_alerts force row level security;

drop policy if exists platform_admin_all_whatsapp_instance_alerts on whatsapp_instance_alerts;
create policy platform_admin_all_whatsapp_instance_alerts
  on whatsapp_instance_alerts for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_instance_alerts_updated_at on whatsapp_instance_alerts;
create trigger whatsapp_instance_alerts_updated_at
  before update on whatsapp_instance_alerts
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instance_alerts';
--
-- 2. Índice de dedupe presente (esperado: 1 linha):
--   select indexname from pg_indexes where tablename = 'whatsapp_instance_alerts'
--    and indexname = 'whatsapp_alerts_dedupe_idx';
--
-- 3. Nenhuma coluna de e-mail/destinatário duplicada (esperado: 0 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'whatsapp_instance_alerts'
--      and column_name ~* 'email|recipient|token|secret';
--
-- 4. As DUAS guardas instaladas (esperado: 2 linhas):
--   select tgname from pg_trigger where tgrelid = 'whatsapp_instance_alerts'::regclass
--    and tgname in ('whatsapp_instance_alerts_subject_guard',
--                   'whatsapp_instance_alerts_tenant_guard');
--
-- 5. Exclusão de instância PRESERVA o alerta (comportamento, não estrutura —
--    só verificável com banco; roteiro completo em
--    supabase/tests/whatsapp-instances.integration.md, casos FK-A..FK-E).
--
-- =====================================================================
-- Rollback — LEIA A ADVERTÊNCIA DA 088 ANTES
-- =====================================================================
-- `drop table whatsapp_instance_alerts` DESTRÓI AUDITORIA OPERACIONAL DE FORMA
-- IRREVERSÍVEL. A sequência completa e a alternativa não-destrutiva estão na
-- 088, que é o único lugar onde a ordem inversa inteira está publicada.
--   drop trigger if exists whatsapp_instance_alerts_subject_guard on whatsapp_instance_alerts;
--   drop function if exists public.whatsapp_alert_subject_guard();
--   drop table if exists whatsapp_instance_alerts;
