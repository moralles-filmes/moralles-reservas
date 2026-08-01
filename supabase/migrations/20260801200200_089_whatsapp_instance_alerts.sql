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
  organization_id uuid not null references organizations(id) on delete cascade,
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

  -- Sujeito coerente: alerta de organização não aponta instância.
  constraint whatsapp_alerts_subject_chk check (
    (subject_type = 'INSTANCE' and instance_id is not null and subject_id = instance_id)
    or (subject_type = 'ORGANIZATION' and subject_id = organization_id)
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

alter table whatsapp_instance_alerts enable row level security;
alter table whatsapp_instance_alerts force row level security;

drop policy if exists platform_admin_all_whatsapp_instance_alerts on whatsapp_instance_alerts;
create policy platform_admin_all_whatsapp_instance_alerts
  on whatsapp_instance_alerts for all
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
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop table if exists whatsapp_instance_alerts;
