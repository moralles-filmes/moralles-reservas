-- Ledger de observações da instância (Fase 6c).
--
-- O DEFEITO QUE ESTA TABELA CONSERTA: a 087 declara que `notes`, `cost_note`,
-- `cancellation_reason` e `end_confirmation_note` "registram DECISÃO HUMANA
-- sobre o que a plataforma paga ao fornecedor, e não têm segunda cópia — o
-- painel da Z-API não reconstrói nenhum deles". E `manage-whatsapp-instances`
-- escreve `notes = reason` em register/update/reactivate, SOBRESCREVENDO. Cada
-- ação apagava a justificativa da anterior. A tabela prometia auditoria e
-- entregava último-valor.
--
-- POR QUE NÃO O TRIGGER GENÉRICO `audit_trigger_func()`: seriam quatro linhas
-- e zero mudança na EF, mas ele preenche `organization_id` e `audit_log` tem a
-- policy `unit_member_read_audit`, que libera leitura para MEMBRO da
-- organização. Auditar `whatsapp_instances` ali entregaria
-- `current_monthly_cost_cents` — o que a plataforma paga ao fornecedor — para
-- os membros do próprio cliente. É exatamente o que o FORCE RLS da tabela
-- existe para impedir.
--
-- `notes` CONTINUA sendo escrita: ela vira o resumo ("última observação") e
-- esta tabela vira o histórico. Ambas saem do mesmo `reason`, na mesma
-- operação.
--
-- ADITIVA E INERTE AO WORKER: cria tabela nova e lê `notes` no backfill, sem
-- tocar nenhuma coluna de `whatsapp_instances`.

begin;

create table if not exists whatsapp_instance_notes (
  id uuid primary key default gen_random_uuid(),

  -- IDENTIDADE HISTÓRICA IMUTÁVEL, no padrão de
  -- `whatsapp_instance_alerts.subject_id`: a observação sobrevive à remoção da
  -- instância, e é `instance_ref` que continua dizendo de quem ela era.
  instance_ref uuid not null,

  -- SEM CHECK exigindo `instance_id is not null`. Foi assim que a 089 tornou o
  -- `on delete set null` INEXECUTÁVEL: apagar a instância fazia a FK gravar
  -- NULL, o CHECK avaliar FALSE e o DELETE inteiro abortar com
  -- check_violation — o oposto exato do contrato desta tabela. O rigor de
  -- INSERT vive na trigger abaixo, que distingue INSERT de coerção da FK;
  -- distinção que um CHECK, por construção, não sabe fazer.
  instance_id uuid references whatsapp_instances(id) on delete set null,

  -- `restrict`, igual às três irmãs desta fase: registro de auditoria e a
  -- deleção de uma organização não pode apagá-lo em silêncio. A consequência
  -- para quem vier depois está escrita por extenso na 089.
  organization_id uuid not null references organizations(id) on delete restrict,

  -- SETE valores, um para cada constante de INSTANCE_NOTE_ACTIONS em
  -- _shared/whatsapp-instance-notes-core.ts (fonte canônica). O acoplamento é
  -- verificado nas duas direções por
  -- src/lib/whatsapp-instance-notes-core.test.ts.
  action text not null check (action in (
    'REGISTER', 'UPDATE', 'REACTIVATE', 'SET_COST',
    'CONFIRM_CYCLE_DATE', 'REQUEST_CANCELLATION', 'CONFIRM_END'
  )),

  -- O motivo que o operador digitou. A EF já exige 5 caracteres úteis
  -- (MIN_REASON_LENGTH); o banco recusa só o vazio, porque observação em branco
  -- não é observação.
  note text not null check (btrim(note) <> ''),

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table whatsapp_instance_notes is
  'Ledger APPEND-ONLY de observacoes da instancia (Fase 6c). Conserta a sobrescrita de whatsapp_instances.notes. NAO usa audit_log: la a policy unit_member_read_audit entregaria o custo do fornecedor ao proprio cliente. Sem credencial. FORCE RLS, so platform_admin.';

comment on column whatsapp_instance_notes.instance_ref is
  'Identidade historica IMUTAVEL. Sobrevive a remocao da instancia, quando instance_id vira NULL pela FK.';

comment on column whatsapp_instance_notes.note is
  'Resumo da mesma operacao fica em whatsapp_instances.notes; o historico e aqui. Ambos saem do mesmo reason.';

-- Leitura do painel: histórico de UMA instância, do mais recente ao mais
-- antigo. Chaveado por `instance_ref` e não por `instance_id`, senão o
-- histórico da instância apagada ficaria inalcançável.
create index if not exists whatsapp_instance_notes_ref_idx
  on whatsapp_instance_notes (instance_ref, created_at desc);

-- =====================================================================
-- Append-only e identidade — o rigor que o CHECK não consegue expressar
-- =====================================================================
-- Um CHECK avalia a linha isoladamente e não sabe se ela está NASCENDO ou
-- sendo coagida pela FK. A regra é diferente nas duas operações:
--   INSERT — a instância PRECISA existir e `instance_ref` tem que ser ela.
--   UPDATE — a instância pode desaparecer (a FK nula `instance_id`), mas nada
--            mais pode mudar. Ledger reescrito não é ledger.
create or replace function public.whatsapp_instance_note_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.instance_id is null or new.instance_ref <> new.instance_id then
      raise exception 'observacao nasce apontando instancia viva, com instance_ref igual a ela'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- APPEND-ONLY. A ÚNICA mudança tolerada é `instance_id` indo a NULL, que é
  -- ação da FK, não escrita de ninguém.
  if new.instance_ref is distinct from old.instance_ref
     or new.organization_id is distinct from old.organization_id
     or new.action is distinct from old.action
     or new.note is distinct from old.note
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'observacao e registro append-only e nao pode ser reescrita'
      using errcode = 'check_violation';
  end if;

  if old.instance_id is not null and new.instance_id is not null
     and new.instance_id <> old.instance_id then
    raise exception 'instance_id nao pode ser reapontado para outra instancia'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema `public` é
-- exposto ao PostgREST com a anon key.
revoke all on function public.whatsapp_instance_note_guard()
  from public, anon, authenticated;

drop trigger if exists whatsapp_instance_notes_guard on whatsapp_instance_notes;
create trigger whatsapp_instance_notes_guard
  before insert or update on whatsapp_instance_notes
  for each row execute function public.whatsapp_instance_note_guard();

-- Guarda de tenant: REUSA a função da 088, como a 089 faz. Ela retorna cedo
-- quando `instance_id` é nulo, que é exatamente o estado da linha depois de a
-- instância ser apagada.
drop trigger if exists whatsapp_instance_notes_tenant_guard on whatsapp_instance_notes;
create trigger whatsapp_instance_notes_tenant_guard
  before insert or update of organization_id, instance_id on whatsapp_instance_notes
  for each row execute function public.whatsapp_instance_child_tenant_guard();

-- =====================================================================
-- RLS — padrão das três irmãs desta fase (087, 088, 089)
-- =====================================================================
-- FORCE RLS **mais** a policy de platform_admin. "FORCE RLS sem policies" é o
-- padrão das tabelas de CREDENCIAL (whatsapp_channels, platform_secrets), onde
-- nem o super-admin lê pelo PostgREST — esta tabela não guarda credencial e é
-- irmã dos dois ledgers da fase. `is_platform_admin` já exclui todo membro de
-- organização, que é a leitura que o audit_log não conseguia impedir.
alter table whatsapp_instance_notes enable row level security;
alter table whatsapp_instance_notes force row level security;

drop policy if exists platform_admin_all_whatsapp_instance_notes on whatsapp_instance_notes;
create policy platform_admin_all_whatsapp_instance_notes
  on whatsapp_instance_notes for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

-- =====================================================================
-- Backfill idempotente
-- =====================================================================
-- Cada `notes` não-nulo vira a PRIMEIRA entrada do histórico, com a autoria e a
-- data da criação da instância — que é o que `notes` de fato representava
-- naquele momento. `not exists` guarda a reexecução: a migration é idempotente
-- por design e nada aqui pode duplicar histórico numa segunda passada.
--
-- `action = 'REGISTER'` para todas: não há como saber, do valor sobrescrito,
-- qual ação o gravou por último. Afirmar outra coisa seria inventar histórico —
-- e inventar é pior que o buraco que estamos tapando.
insert into whatsapp_instance_notes
  (instance_ref, instance_id, organization_id, action, note, created_by, created_at)
select i.id, i.id, i.organization_id, 'REGISTER', i.notes, i.created_by, i.created_at
from whatsapp_instances i
where i.notes is not null
  and btrim(i.notes) <> ''
  and not exists (
    select 1 from whatsapp_instance_notes n where n.instance_ref = i.id
  );

commit;

-- =====================================================================
-- Validação pós-migration (rodar no Studio DEPOIS do db push autorizado)
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instance_notes';
--
-- 2. A policy existe (esperado: 1 linha):
--   select policyname from pg_policies
--    where tablename = 'whatsapp_instance_notes';
--
-- 3. As DUAS guardas instaladas (esperado: 2 linhas):
--   select tgname from pg_trigger where tgrelid = 'whatsapp_instance_notes'::regclass
--    and tgname in ('whatsapp_instance_notes_guard',
--                   'whatsapp_instance_notes_tenant_guard');
--
-- 4. Nenhuma coluna de segredo (esperado: 0 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'whatsapp_instance_notes'
--      and column_name ~* 'email|token|secret|credential';
--
-- 5. Backfill cobriu todo `notes` existente (esperado: 0 linhas):
--   select i.id from whatsapp_instances i
--    where i.notes is not null and btrim(i.notes) <> ''
--      and not exists (select 1 from whatsapp_instance_notes n
--                       where n.instance_ref = i.id);
--
-- 6. Reexecutar a migration inteira NÃO duplica (esperado: 0 linhas):
--   select instance_ref, count(*) from whatsapp_instance_notes
--    where action = 'REGISTER' group by 1 having count(*) > 1;
--
-- 7. COMPORTAMENTO, não estrutura — só verificável com banco. Roteiro
--    completo em supabase/tests/whatsapp-instances.integration.md, casos
--    NOTE-A..NOTE-E (inclui o controle positivo: apagar a instância NÃO apaga
--    a observação).
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- `drop table whatsapp_instance_notes` DESTRÓI AUDITORIA OPERACIONAL DE FORMA
-- IRREVERSÍVEL — inclusive o `notes` original, que o backfill copiou para cá e
-- que continua na 087 (esta tabela não apaga nada de lá). Leia a advertência da
-- 088 antes. Ordem inversa:
--   drop trigger if exists whatsapp_instance_notes_tenant_guard on whatsapp_instance_notes;
--   drop trigger if exists whatsapp_instance_notes_guard on whatsapp_instance_notes;
--   drop function if exists public.whatsapp_instance_note_guard();
--   drop table if exists whatsapp_instance_notes;
