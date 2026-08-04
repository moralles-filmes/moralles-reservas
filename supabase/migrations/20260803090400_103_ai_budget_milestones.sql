-- 103 — Ledger dos marcos da franquia de IA (Plano D, spec §18.2).
--
-- POR QUE UM LEDGER E NAO SO A FILA: o UNIQUE de billing_notifications e
-- PARCIAL e NAO deduplica com invoice_id nulo — e nenhum aviso desta fase tem
-- fatura. Enfileirar a cada passada criaria uma linha por dia para o mesmo
-- fato. A CADENCIA VIVE NO LEDGER, NAO NA FILA. Precedente direto:
-- whatsapp_instance_alerts (089).
--
-- DISCIPLINA DE TRES TEMPOS (6b): tocar -> enfileirar -> carimbar. Aqui o
-- INSERT com `on conflict do nothing` E a barreira de persistencia: se ele nao
-- grava, NADA e enfileirado. `notified_at` so e carimbado depois de o
-- enfileiramento confirmar.
--
-- Cada marco dispara NO MAXIMO UMA VEZ POR CICLO.

begin;

create table if not exists ai_budget_milestones (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  cycle_id uuid not null references ai_cycle_budgets(id) on delete restrict,

  -- PERCENTUAL do limite do ciclo, nao valor absoluto: com limit_cents = 10000
  -- os quatro caem exatamente em R$ 70/80/90/100 da spec, e um limite diferente
  -- (plano CUSTOM futuro) mantem a mesma escada em vez de transformar "R$ 70"
  -- em "94% do teto" sem ninguem decidir isso.
  -- Fonte canonica dos event_type: _shared/ai-budget-milestones-core.ts.
  milestone_percent integer not null check (milestone_percent in (70, 80, 90, 100)),

  -- Custo LIQUIDADO no instante do cruzamento. Auditavel depois, e nao
  -- derivavel: settled_cents do ciclo continua subindo.
  settled_cents_at_cross integer not null check (settled_cents_at_cross >= 0),
  limit_cents_at_cross integer not null check (limit_cents_at_cross >= 0),

  crossed_at timestamptz not null default now(),

  -- Distingue "registrei o marco" de "o aviso foi para a fila". Sem esta
  -- separacao, uma falha de enfileiramento seria indistinguivel de sucesso.
  notified_at timestamptz,
  enqueue_attempts integer not null default 0 check (enqueue_attempts >= 0),

  -- "Nao recebi e-mail" nao e "nao houve alerta": billing_notifications_dispatch
  -- nasce OFF nesta fase e a fila acumula de proposito.
  dispatch_enabled_at_enqueue boolean,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A unicidade que faz "no maximo uma vez por ciclo" ser garantia de banco.
  constraint ai_budget_milestones_cycle_uniq unique (cycle_id, milestone_percent)
);

comment on table ai_budget_milestones is
  'Ledger dos marcos 70/80/90/100% da franquia de IA (Plano D). A cadencia vive AQUI, nao na fila: o UNIQUE de billing_notifications e parcial e nao deduplica com invoice_id nulo. FORCE RLS.';

comment on column ai_budget_milestones.milestone_percent is
  'Percentual do limite do ciclo. Fonte canonica dos event_type correspondentes: _shared/ai-budget-milestones-core.ts (EVENT_TYPE_BY_MILESTONE_PERCENT).';

comment on column ai_budget_milestones.notified_at is
  'Carimbado SO depois de o enfileiramento confirmar. NULL com enqueue_attempts > 0 = marco registrado, aviso nao enfileirado — retry sem duplicar registro.';

create index if not exists ai_budget_milestones_org_idx
  on ai_budget_milestones (organization_id, crossed_at desc);

create index if not exists ai_budget_milestones_pending_idx
  on ai_budget_milestones (cycle_id)
  where notified_at is null;

-- Mesma guarda de tenant das tabelas irmas (101): as FKs garantem existencia,
-- nao que cycle_id e organization_id sao a mesma organizacao.
drop trigger if exists ai_budget_milestones_tenant_guard on ai_budget_milestones;
create trigger ai_budget_milestones_tenant_guard
  before insert or update of organization_id, cycle_id on ai_budget_milestones
  for each row execute function public.ai_budget_child_tenant_guard();

-- =====================================================================
-- RLS
-- =====================================================================
alter table ai_budget_milestones enable row level security;
alter table ai_budget_milestones force row level security;

drop policy if exists platform_admin_all_ai_budget_milestones on ai_budget_milestones;
create policy platform_admin_all_ai_budget_milestones
  on ai_budget_milestones for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists ai_budget_milestones_updated_at on ai_budget_milestones;
create trigger ai_budget_milestones_updated_at
  before update on ai_budget_milestones
  for each row execute function update_updated_at();

-- =====================================================================
-- TOQUE ATOMICO — consome uma tentativa de enfileiramento
-- =====================================================================
-- PRIMEIRO dos tres tempos (toca -> enfileira -> carimba). Este UPDATE NAO
-- registra envio: ele prova que a linha e gravavel e consome o slot ANTES de
-- qualquer coisa entrar na fila. Contar depois de enfileirar deixa o contador
-- parado exatamente quando a escrita falha, e como o UNIQUE de
-- billing_notifications e PARCIAL (nao deduplica com invoice_id nulo, o caso de
-- todo aviso de marco), cada passada enfileiraria um aviso identico sem o teto
-- jamais ser alcancado.
--
-- POR QUE UMA FUNCAO, e nao um UPDATE do cliente: `enqueue_attempts + 1` tem de
-- ser avaliado NO SERVIDOR. Ler o valor, somar no cliente e gravar e
-- read-modify-write: dois turnos concorrentes da mesma organizacao cruzando o
-- mesmo marco leem 0, ambos gravam 1, ambos enfileiram — duas linhas pending
-- sem dedupe e um slot consumido a menos que o real.
--
-- As duas condicoes do WHERE sao a autoridade sobre repeticao: `notified_at is
-- null` (aviso ainda nao saiu) e o teto. O cliente pode checa-las antes para
-- evitar I/O, mas quem decide e esta linha, sob a atomicidade do UPDATE.
create or replace function public.touch_ai_budget_milestone(
  p_organization_id uuid,
  p_milestone_id uuid,
  p_max_attempts integer
)
returns table (
  touched boolean,
  attempts integer,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row ai_budget_milestones%rowtype;
begin
  -- ALIAS `m` no lado DIREITO do SET: `enqueue_attempts` nao e OUT param DESTA
  -- funcao (o retorno chama-se `attempts`), e essa e a UNICA razao de a forma
  -- crua funcionar. Renomear a coluna de saida para `enqueue_attempts` — o nome
  -- mais natural que ela poderia ter — tornaria esta linha 42702 na PRIMEIRA
  -- chamada real, com a migration aplicada limpa. Mesma doutrina do cabecalho
  -- da 102: qualifica-se toda coluna que POSSA vir a ser homonima.
  update ai_budget_milestones m
     set enqueue_attempts = m.enqueue_attempts + 1
   where id = p_milestone_id
     and organization_id = p_organization_id
     and notified_at is null
     and enqueue_attempts < greatest(p_max_attempts, 1)
  returning * into v_row;

  if found then
    return query select true, v_row.enqueue_attempts, null::text;
    return;
  end if;

  -- Nao casou nenhuma linha. Descobre POR QUE em vez de devolver um "falhou"
  -- generico: tenant errado, aviso ja enviado e teto estourado exigem log
  -- diferente, e um UPDATE que casa zero linhas nao distingue os tres sozinho.
  select * into v_row
  from ai_budget_milestones
  where id = p_milestone_id and organization_id = p_organization_id;

  if not found then
    return query select false, 0, 'not_found'::text;
  elsif v_row.notified_at is not null then
    return query select false, v_row.enqueue_attempts, 'already_notified'::text;
  else
    return query select false, v_row.enqueue_attempts, 'attempts_exhausted'::text;
  end if;
end;
$$;

comment on function public.touch_ai_budget_milestone(uuid, uuid, integer) is
  'Consome ATOMICAMENTE uma tentativa de enfileiramento do marco (primeiro dos tres tempos). Nao registra envio. Recusa quando o aviso ja saiu (notified_at) ou o teto de tentativas foi atingido, e diz qual dos dois.';

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrao e o schema public e
-- exposto ao PostgREST com a anon key. Revogar PUBLIC **e** os grants diretos.
revoke all on function public.touch_ai_budget_milestone(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.touch_ai_budget_milestone(uuid, uuid, integer)
  to service_role;

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. RLS ligada e forcada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class where relname = 'ai_budget_milestones';
--
-- 2. Segundo INSERT do mesmo marco no mesmo ciclo e rejeitado (esperado: 23505):
--   insert into ai_budget_milestones (organization_id, cycle_id, milestone_percent,
--                                     settled_cents_at_cross, limit_cents_at_cross)
--   values ('<org>','<cyc>',70,7000,10000);   -- duas vezes
--
-- 3. Percentual fora do vocabulario e rejeitado (esperado: 23514):
--   ... milestone_percent = 75
--
-- 4. TOQUE ATOMICO — o incremento e do servidor, nao do cliente.
--    Em DUAS sessoes psql simultaneas, com o marco em enqueue_attempts = 0:
--      A: begin; select * from touch_ai_budget_milestone('<org>','<marco>',5);
--      B: begin; select * from touch_ai_budget_milestone('<org>','<marco>',5);
--      A: commit;  B: commit;
--    Esperado: attempts = 1 e 2 (nunca 1 e 1). B bloqueia ate o commit de A.
--
-- 5. O toque recusa e DIZ por que:
--      com notified_at preenchido -> touched=false, reason='already_notified'
--      com enqueue_attempts = 5   -> touched=false, reason='attempts_exhausted'
--      com organization_id de outro tenant -> touched=false, reason='not_found'
--
-- 6. ACL (esperado: nenhuma linha com anon= ou authenticated=):
--   select proname, proacl from pg_proc where proname = 'touch_ai_budget_milestone';
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Executar ANTES da 101 (a trigger usa ai_budget_child_tenant_guard).
--   drop function if exists public.touch_ai_budget_milestone(uuid, uuid, integer);
--   drop table if exists ai_budget_milestones;
