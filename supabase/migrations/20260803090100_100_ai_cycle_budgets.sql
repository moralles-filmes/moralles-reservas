-- 100 — Orcamento de franquia de IA por ciclo (Plano D, spec §17.3).
--
-- A ANCORA DE TUDO. Uma linha por (organizacao, ciclo).
--
-- FRANQUIA, NAO CARTEIRA: o cliente nao compra nada, o teto e interno, e ele
-- nunca ve valores de custo. A Fase 7 original (carteira pre-paga) foi
-- substituida; a Fase 8 (recarga automatica) esta CANCELADA — nao ha o que
-- recarregar numa franquia.
--
-- NAO HA NENHUMA CONTAGEM DE CONVERSA, MENSAGEM OU INTERACAO NESTE SCHEMA.
-- O unico teto e financeiro (§18.1).

begin;

create table if not exists ai_cycle_budgets (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,

  -- INCLUSIVO.
  cycle_start date not null,
  -- EXCLUSIVO: primeiro dia NAO coberto. NAO existe coluna equivalente a
  -- "ultimo dia coberto" — o nome admitia duas leituras e a diferenca de um dia
  -- e a que erra a virada (mesma licao de provider_access_until, 6b).
  cycle_end date not null,

  -- Dia-ancora PERSISTIDO, nunca re-derivado do vencimento atual: sem ele,
  -- ancora 31 degrada para 28 depois do primeiro fevereiro e nunca mais volta.
  cycle_anchor_day integer not null check (cycle_anchor_day between 1 and 31),

  -- CONGELADO NA ABERTURA, nao lido do plano a cada consulta: mudar o teto em
  -- 2027 nao pode reescrever o que foi permitido em 2026. Valor inicial 10000
  -- (R$ 100,00).
  limit_cents integer not null check (limit_cents >= 0),

  -- Custo LIQUIDADO. O disponivel e
  --   limit_cents - settled_cents - SOMA(reserved_cents - consumed_cents das HELD).
  -- O orcamento NUNCA soma reservas nesta coluna: reserva e promessa de gasto, e
  -- misturar as duas torna impossivel distinguir "gastei" de "posso vir a gastar".
  settled_cents integer not null default 0 check (settled_cents >= 0),

  -- Derivavel de settled_cents >= limit_cents, persistido de proposito:
  -- exhausted_at precisa de um MOMENTO, e o momento nao e derivavel depois.
  state text not null default 'OPEN' check (state in ('OPEN', 'EXHAUSTED', 'CLOSED')),
  exhausted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_cycle_budgets_order_chk check (cycle_start < cycle_end),
  -- IMPLICACAO, nao bicondicional. `(state = 'EXHAUSTED') = (exhausted_at is
  -- not null)` obrigaria a APAGAR `exhausted_at` para fechar um ciclo esgotado
  -- (EXHAUSTED -> CLOSED, transicao prevista: o vocabulario admite CLOSED e o
  -- indice parcial `state <> 'CLOSED'` conta com ela), destruindo exatamente o
  -- carimbo que a coluna existe para preservar — e o momento do esgotamento nao
  -- e derivavel depois. O que se exige e so o lado que importa: EXHAUSTED sem
  -- carimbo e proibido.
  constraint ai_cycle_budgets_exhausted_chk
    check (state <> 'EXHAUSTED' or exhausted_at is not null),

  -- Cobre o duplicado EXATO.
  constraint ai_cycle_budgets_org_start_uniq unique (organization_id, cycle_start)
);

comment on table ai_cycle_budgets is
  'Orcamento de franquia de IA por (organizacao, ciclo). [cycle_start, cycle_end) — fim EXCLUSIVO. limit_cents congelado na abertura. settled_cents NAO inclui reserva. FORCE RLS.';

comment on column ai_cycle_budgets.cycle_end is
  'EXCLUSIVO: primeiro dia NAO coberto. A UI escreve "renova em cycle_end".';

comment on column ai_cycle_budgets.limit_cents is
  'Teto do ciclo em centavos de BRL (moeda e contrato fechado: o custo do provedor e USD e a conversao acontece no evento de uso). CONGELADO na abertura.';

comment on column ai_cycle_budgets.settled_cents is
  'Custo LIQUIDADO. NUNCA soma reservas — capacidade comprometida vive em ai_cost_reservations.';

-- UNIQUE(organization_id, cycle_start) NAO cobre sobreposicao PARCIAL. Upgrade
-- no meio do ciclo, reativacao apos inadimplencia e troca de plano sao
-- exatamente os momentos em que um segundo budget nasceria sobrepondo o
-- primeiro — e dois budgets no mesmo intervalo significam TETO DOBRADO sem
-- ninguem decidir isso.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_cycle_budgets_no_overlap_excl'
      and conrelid = 'ai_cycle_budgets'::regclass
  ) then
    alter table ai_cycle_budgets
      add constraint ai_cycle_budgets_no_overlap_excl
      exclude using gist (
        organization_id with =,
        daterange(cycle_start, cycle_end, '[)') with &&
      );
  end if;
end $$;

create index if not exists ai_cycle_budgets_org_window_idx
  on ai_cycle_budgets (organization_id, cycle_start desc);

create index if not exists ai_cycle_budgets_open_idx
  on ai_cycle_budgets (organization_id)
  where state <> 'CLOSED';

-- =====================================================================
-- RLS
-- =====================================================================
alter table ai_cycle_budgets enable row level security;
alter table ai_cycle_budgets force row level security;

drop policy if exists platform_admin_all_ai_cycle_budgets on ai_cycle_budgets;
create policy platform_admin_all_ai_cycle_budgets
  on ai_cycle_budgets for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists ai_cycle_budgets_updated_at on ai_cycle_budgets;
create trigger ai_cycle_budgets_updated_at
  before update on ai_cycle_budgets
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. RLS ligada e forcada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class where relname = 'ai_cycle_budgets';
--
-- 2. TESTE 44 DA SPEC — dois ciclos sobrepostos sao rejeitados (esperado: 23P01):
--   insert into ai_cycle_budgets (organization_id, cycle_start, cycle_end, cycle_anchor_day, limit_cents)
--   values ('<org>', '2026-08-04', '2026-09-04', 4, 10000);
--   insert into ai_cycle_budgets (organization_id, cycle_start, cycle_end, cycle_anchor_day, limit_cents)
--   values ('<org>', '2026-08-20', '2026-09-20', 20, 10000);   -- deve falhar
--
-- 3. Ciclos ADJACENTES sao aceitos (fim exclusivo — esperado: sucesso):
--   insert into ai_cycle_budgets (organization_id, cycle_start, cycle_end, cycle_anchor_day, limit_cents)
--   values ('<org>', '2026-09-04', '2026-10-04', 4, 10000);
--
-- 4. Duas organizacoes com o MESMO intervalo sao aceitas (esperado: sucesso).
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- DEGRAU 3. `drop table` destroi o historico de teto autorizado e as FKs de
-- 101 apontam para ca. Nao executar isolado.
--   drop table if exists ai_cycle_budgets;
