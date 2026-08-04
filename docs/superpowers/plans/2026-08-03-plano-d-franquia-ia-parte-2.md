# Plano D — Parte 2 (Tasks 4 a 6: modelo de dados)

> Continuação de `2026-08-03-plano-d-franquia-ia.md`. **As Global Constraints daquele arquivo valem integralmente aqui.**

---

## Task 4: Migrations de schema (099, 100, 101)

**Files:**
- Create: `supabase/migrations/20260803090000_099_ai_model_prices.sql`
- Create: `supabase/migrations/20260803090100_100_ai_cycle_budgets.sql`
- Create: `supabase/migrations/20260803090200_101_ai_usage_and_reservations.sql`
- Test: `src/lib/ai-budget-migrations-guard.test.ts`

**Interfaces:**
- Consumes: `organizations`, `units`, `is_platform_admin(uuid)`, `update_updated_at()` (todos já existentes).
- Produces: tabelas `ai_model_prices`, `ai_cycle_budgets`, `ai_cost_reservations`, `ai_usage_events`. Nomes de coluna consumidos pelas RPCs da Task 5 e pelo adapter da Task 11.

**Contexto obrigatório para o implementador:**

- Migrations são **idempotentes por design** e **nunca aplicadas nesta frente** (`db push` é proibido — ver Global Constraints).
- `CREATE FUNCTION` concede `EXECUTE` a `PUBLIC` por padrão e o schema `public` é exposto ao PostgREST com a anon key: **toda função nova revoga explicitamente** antes de conceder.
- Nome de constraint é único **por tabela**, não por banco: checar `conname` **junto de** `conrelid` (padrão da 094).
- Nenhuma migration embute URL do projeto Supabase nem segredo — `scripts/migration-static-guard.test.ts` reprova o CI.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/ai-budget-migrations-guard.test.ts`:

```ts
/**
 * Guardrail ESTÁTICO das migrations do Plano D.
 *
 * Não substitui a prova contra banco real (testes 42 e 44 da spec continuam
 * PENDENTES — ver docs/billing-asaas/PLANO-D-PENDENCIAS.md). O que ele prova é
 * que as garantias ESTÃO ESCRITAS: FORCE RLS, policy de platform_admin, fim
 * exclusivo, price_id NOT NULL, não sobreposição de ciclos, e ausência de
 * segredo. Uma migration que perca qualquer uma dessas linhas cai aqui, e não
 * só num code review.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

function read(nameFragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(nameFragment));
  if (!file) throw new Error(`migration não encontrada: ${nameFragment}`);
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

const prices = read("099_ai_model_prices");
const budgets = read("100_ai_cycle_budgets");
const usage = read("101_ai_usage_and_reservations");
const all = [prices, budgets, usage];

const TABLES = ["ai_model_prices", "ai_cycle_budgets", "ai_cost_reservations", "ai_usage_events"];

describe("faixa de migration reservada ao Plano D", () => {
  it("usa apenas os números 099 a 103", () => {
    const mine = readdirSync(MIGRATIONS).filter((f) => /_(099|100|101|102|103)_ai_/.test(f));
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const f of mine) expect(f).toMatch(/_(099|100|101|102|103)_/);
  });
});

describe("RLS das quatro tabelas", () => {
  const joined = all.join("\n");
  for (const t of TABLES) {
    it(`${t}: RLS habilitada E forçada`, () => {
      expect(joined).toContain(`alter table ${t} enable row level security`);
      expect(joined).toContain(`alter table ${t} force row level security`);
    });

    it(`${t}: tem policy platform_admin e NENHUMA policy para anon`, () => {
      expect(joined).toContain(`platform_admin_all_${t}`);
      // O lojista nunca lê custo. Uma policy `to anon`/`to authenticated` sem
      // is_platform_admin nestas tabelas é regressão de vazamento financeiro.
      const block = joined.slice(joined.indexOf(`create table if not exists ${t}`));
      const upToNext = block.slice(0, block.indexOf("commit;") + 1);
      expect(upToNext).not.toMatch(/create policy[^;]*to anon/i);
    });
  }
});

describe("ai_model_prices", () => {
  it("a taxa de câmbio vive NA LINHA de preço, não em variável global", () => {
    expect(prices).toMatch(/usd_to_brl\s+numeric\(12,6\)\s+not null/);
  });

  it("vigência fechada por effective_from/effective_to", () => {
    expect(prices).toContain("effective_from");
    expect(prices).toContain("effective_to");
  });

  it("impede vigências sobrepostas para o mesmo provider+model", () => {
    expect(prices).toMatch(/exclude\s+using\s+gist/i);
    expect(prices).toContain("btree_gist");
  });

  it("semeia o modelo de fallback do Gemini — ele custa múltiplas vezes o Flash", () => {
    expect(prices).toContain("gemini-2.5-pro");
    expect(prices).toContain("gemini-2.5-flash");
  });

  it("semeia os cinco provedores", () => {
    for (const p of ["claude", "openai", "gemini", "grok", "deepseek"]) {
      expect(prices).toContain(`'${p}'`);
    }
  });
});

describe("ai_cycle_budgets", () => {
  it("o fim do ciclo é EXCLUSIVO e está documentado como tal", () => {
    expect(budgets).toMatch(/cycle_end[\s\S]{0,400}EXCLUSIVO/i);
  });

  it("limite congelado na abertura e não relido do plano", () => {
    expect(budgets).toMatch(/limit_cents[\s\S]{0,600}congelad/i);
  });

  it("settled_cents nunca é negativo", () => {
    expect(budgets).toMatch(/settled_cents[\s\S]{0,200}check\s*\(settled_cents\s*>=\s*0\)/i);
  });

  it("um ciclo por (organização, início) — duplicado exato barrado", () => {
    expect(budgets).toMatch(/unique[\s\S]{0,120}organization_id[\s\S]{0,60}cycle_start/i);
  });

  it("ciclos da mesma organização não se sobrepõem — EXCLUDE, não só UNIQUE", () => {
    // UNIQUE(org, cycle_start) NÃO cobre sobreposição parcial: dois budgets no
    // mesmo intervalo significam teto DOBRADO sem ninguém decidir isso.
    expect(budgets).toMatch(/exclude\s+using\s+gist[\s\S]{0,200}daterange/i);
  });

  it("cycle_start é sempre anterior a cycle_end", () => {
    expect(budgets).toMatch(/check\s*\(\s*cycle_start\s*<\s*cycle_end\s*\)/i);
  });

  it("persiste o dia-âncora — nunca re-derivado do vencimento atual", () => {
    expect(budgets).toContain("cycle_anchor_day");
  });

  it("o estado carrega o MOMENTO do esgotamento, que não é derivável depois", () => {
    expect(budgets).toContain("exhausted_at");
    expect(budgets).toMatch(/state[\s\S]{0,200}'OPEN'[\s\S]{0,60}'EXHAUSTED'[\s\S]{0,60}'CLOSED'/);
  });
});

describe("ai_usage_events", () => {
  it("price_id é NOT NULL — evento financeiro só existe com preço conhecido", () => {
    expect(usage).toMatch(/price_id\s+uuid\s+not null\s+references\s+ai_model_prices/i);
  });

  it("aponta para o ORÇAMENTO do ciclo, não para um par de datas soltas", () => {
    expect(usage).toMatch(/cycle_id\s+uuid\s+not null\s+references\s+ai_cycle_budgets/i);
  });

  it("carrega a taxa efetivamente usada — consumo histórico não muda sozinho", () => {
    expect(usage).toMatch(/usd_to_brl\s+numeric/);
  });

  it("vocabulário fechado de usage_state, com os quatro estados", () => {
    for (const s of ["SETTLED", "USAGE_REVIEW_REQUIRED", "FAILED_BEFORE_PROVIDER", "PROVIDER_FAILED"]) {
      expect(usage).toContain(`'${s}'`);
    }
  });

  it("zero só é afirmação legítima em FAILED_BEFORE_PROVIDER e PROVIDER_FAILED", () => {
    expect(usage).toMatch(/check[\s\S]{0,400}FAILED_BEFORE_PROVIDER[\s\S]{0,200}cost_brl_cents\s*=\s*0/i);
  });

  it("idempotência por (organização, chave) — reexecução não debita duas vezes", () => {
    expect(usage).toMatch(/unique[\s\S]{0,120}organization_id[\s\S]{0,60}idempotency_key/i);
  });

  it("guarda turn_id, request_id e call_id — reserva por turno, consolidação por chamada", () => {
    for (const c of ["turn_id", "request_id", "call_id"]) expect(usage).toContain(c);
  });
});

describe("ai_cost_reservations", () => {
  it("os três valores são não negativos", () => {
    for (const c of ["reserved_cents", "consumed_cents", "released_cents"]) {
      expect(usage).toMatch(new RegExp(`${c}[\\s\\S]{0,200}check\\s*\\(${c}\\s*>=\\s*0\\)`, "i"));
    }
  });

  it("expires_at é obrigatório — reserva órfã de crash não come o teto para sempre", () => {
    expect(usage).toMatch(/expires_at\s+timestamptz\s+not null/i);
  });

  it("estados terminais são carimbados por finalized_at, não só a liquidação", () => {
    expect(usage).toContain("finalized_at");
    expect(usage).toMatch(/status[\s\S]{0,200}'HELD'[\s\S]{0,120}'SETTLED'[\s\S]{0,60}'RELEASED'[\s\S]{0,60}'EXPIRED'/);
  });

  it("reserva com usage pendente SAI do caminho de expiração automática", () => {
    // Sem esta coluna o TTL de recuperação de crash vira porta de saída para
    // consumo não contabilizado: bastaria toda resposta vazia esperar 5 minutos.
    expect(usage).toContain("usage_review_required");
  });

  it("uma reserva por (organização, chave de idempotência)", () => {
    expect(usage).toMatch(/unique[\s\S]{0,160}organization_id[\s\S]{0,80}idempotency_key/i);
  });
});

describe("nenhuma migration do Plano D embute segredo ou host", () => {
  it("sem chave, token, JWT ou URL de projeto", () => {
    for (const src of all) {
      expect(src).not.toMatch(/sk-|sk-ant-|xai-|re_|AIza|eyJ[A-Za-z0-9_-]{10}/);
      expect(src).not.toMatch(/service_role_key|SERVICE_ROLE_KEY/);
      expect(src).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    }
  });

  it("controle positivo: o detector realmente pega o padrão", () => {
    expect("Authorization: Bearer eyJhbGciOiJIUzI1").toMatch(/eyJ[A-Za-z0-9_-]{10}/);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-migrations-guard.test.ts`
Expected: FAIL — `migration não encontrada: 099_ai_model_prices`.

- [ ] **Step 3: Escrever a migration 099**

Criar `supabase/migrations/20260803090000_099_ai_model_prices.sql`:

```sql
-- 099 — Precos versionados de modelo de IA (Plano D, spec §17.1).
--
-- POR QUE ESTA TABELA EXISTE: `estimateCostUsd` devolve 0 para modelo fora de
-- PRICING_USD_PER_MTOK. Modelo desconhecido NAO e gratuito — no caminho
-- protegido por orcamento esse zero significa consumo ilimitado sem nunca tocar
-- o teto. Com a tabela, a ausencia de preco vira PRICE_UNKNOWN e falha FECHADO.
--
-- `usd_to_brl` fica NA LINHA e nao em variavel global: a taxa vigente faz parte
-- da vigencia. Um cambio "atual" aplicado a consumo antigo produziria custo
-- historico que muda sozinho. NAO recalcular consumo historico quando preco ou
-- cambio mudarem — abrir vigencia NOVA.
--
-- Sem credenciais, sem chave de provedor, sem host de projeto.

begin;

-- Necessario para o EXCLUDE abaixo (operador `=` de btree dentro de indice
-- gist). Extensao padrao do Supabase, criacao idempotente.
create extension if not exists btree_gist;

create table if not exists ai_model_prices (
  id uuid primary key default gen_random_uuid(),

  provider text not null,
  -- Modelo EXATO resolvido pelo runtime (resolveModel), nunca familia.
  model text not null,

  input_usd_per_mtok numeric(12,6) not null check (input_usd_per_mtok >= 0),
  output_usd_per_mtok numeric(12,6) not null check (output_usd_per_mtok >= 0),
  cache_read_usd_per_mtok numeric(12,6) not null default 0 check (cache_read_usd_per_mtok >= 0),
  cache_write_usd_per_mtok numeric(12,6) not null default 0 check (cache_write_usd_per_mtok >= 0),
  -- NULL = o provedor nao cobra faixa separada; o token de raciocinio e cobrado
  -- como OUTPUT (ai-price-core.ts). NULL nunca significa gratis.
  reasoning_usd_per_mtok numeric(12,6) check (reasoning_usd_per_mtok is null or reasoning_usd_per_mtok >= 0),

  usd_to_brl numeric(12,6) not null check (usd_to_brl > 0),

  -- INCLUSIVO.
  effective_from timestamptz not null,
  -- EXCLUSIVO: primeiro instante NAO coberto. NULL = vigencia aberta.
  effective_to timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  constraint ai_model_prices_period_chk
    check (effective_to is null or effective_to > effective_from)
);

comment on table ai_model_prices is
  'Precos versionados por provider+model (Plano D). A taxa usd_to_brl vive NA LINHA: consumo historico nunca e recalculado. FORCE RLS — o lojista nunca le custo.';

comment on column ai_model_prices.effective_to is
  'EXCLUSIVO: primeiro instante NAO coberto. NULL = vigencia aberta.';

comment on column ai_model_prices.reasoning_usd_per_mtok is
  'NULL = provedor sem faixa separada; o token de raciocinio e cobrado como OUTPUT. NULL nunca e gratuidade.';

-- Duas vigencias sobrepostas para o mesmo modelo tornariam o preco de uma
-- chamada NAO DETERMINISTICO — o mesmo defeito de `ilike + limit(1)` ja
-- registrado no CLAUDE.md, num campo financeiro.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_model_prices_no_overlap_excl'
      and conrelid = 'ai_model_prices'::regclass
  ) then
    alter table ai_model_prices
      add constraint ai_model_prices_no_overlap_excl
      exclude using gist (
        provider with =,
        model with =,
        tstzrange(effective_from, effective_to, '[)') with &&
      );
  end if;
end $$;

create index if not exists ai_model_prices_lookup_idx
  on ai_model_prices (provider, model, effective_from desc);

-- =====================================================================
-- RLS — FORCE, sem policy para anon/authenticated comum
-- =====================================================================
alter table ai_model_prices enable row level security;
alter table ai_model_prices force row level security;

drop policy if exists platform_admin_all_ai_model_prices on ai_model_prices;
create policy platform_admin_all_ai_model_prices
  on ai_model_prices for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

-- =====================================================================
-- Seed dos precos vigentes
-- =====================================================================
-- Espelha PRICING_USD_PER_MTOK de _shared/ai-providers.ts NA DATA DESTA
-- MIGRATION, mais `gemini-2.5-pro`, que esta em KNOWN_MODELS e e o FALLBACK do
-- Gemini mas NAO tinha entrada de preco — exatamente o buraco que o fail-closed
-- fecharia interrompendo a IA da organizacao no primeiro fallback.
--
-- usd_to_brl = 5.50: taxa conservadora congelada nesta vigencia. Atualizar
-- cambio = abrir vigencia NOVA (fechar effective_to da atual), nunca UPDATE.
insert into ai_model_prices (
  provider, model,
  input_usd_per_mtok, output_usd_per_mtok,
  cache_read_usd_per_mtok, cache_write_usd_per_mtok,
  reasoning_usd_per_mtok, usd_to_brl, effective_from
)
select v.provider, v.model, v.inp, v.outp, v.cr, v.cw, v.reas, 5.50, timestamptz '2026-01-01 00:00:00+00'
from (values
  ('claude',   'claude-haiku-4-5',  1.000000,  5.000000, 0.100000, 1.250000, null::numeric),
  ('claude',   'claude-sonnet-4-6', 3.000000, 15.000000, 0.300000, 3.750000, null::numeric),
  ('openai',   'gpt-4o',            2.500000, 10.000000, 1.250000, 0.000000, null::numeric),
  ('openai',   'gpt-4o-mini',       0.150000,  0.600000, 0.075000, 0.000000, null::numeric),
  ('gemini',   'gemini-2.5-flash',  0.150000,  0.600000, 0.037500, 0.000000, null::numeric),
  ('gemini',   'gemini-2.5-pro',    1.250000, 10.000000, 0.312500, 0.000000, null::numeric),
  ('grok',     'grok-3',            3.000000, 15.000000, 0.000000, 0.000000, null::numeric),
  ('deepseek', 'deepseek-chat',     0.270000,  1.100000, 0.070000, 0.000000, null::numeric)
) as v(provider, model, inp, outp, cr, cw, reas)
where not exists (
  select 1 from ai_model_prices p
  where p.provider = v.provider and p.model = v.model and p.effective_to is null
);

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. RLS ligada e forcada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class where relname = 'ai_model_prices';
--
-- 2. Oito precos vigentes (esperado: 8):
--   select count(*) from ai_model_prices where effective_to is null;
--
-- 3. Sobreposicao rejeitada (esperado: erro 23P01):
--   insert into ai_model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok, usd_to_brl, effective_from)
--   values ('gemini','gemini-2.5-flash',1,1,5.5, now());
--
-- 4. Todo modelo de KNOWN_MODELS tem preco (esperado: 0 linhas):
--   select m from unnest(array['claude-haiku-4-5','claude-sonnet-4-6','gpt-4o','gpt-4o-mini',
--                              'gemini-2.5-flash','gemini-2.5-pro','grok-3','deepseek-chat']) m
--    where not exists (select 1 from ai_model_prices p where p.model = m and p.effective_to is null);
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- DEGRAU 4 da sequencia (103 -> 102 -> 101 -> 100 -> 099). `drop table` aqui
-- destroi o historico de preco que os eventos de uso referenciam — a 101 tem FK
-- para ca. Nao executar isolado.
--   drop table if exists ai_model_prices;
--   -- btree_gist NAO e removida: outras features podem passar a depender dela.
```

- [ ] **Step 4: Escrever a migration 100**

Criar `supabase/migrations/20260803090100_100_ai_cycle_budgets.sql`:

```sql
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
  constraint ai_cycle_budgets_exhausted_chk
    check ((state = 'EXHAUSTED') = (exhausted_at is not null)),

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
```

- [ ] **Step 5: Escrever a migration 101**

Criar `supabase/migrations/20260803090200_101_ai_usage_and_reservations.sql`:

```sql
-- 101 — Reservas de turno e eventos de uso de IA (Plano D, spec §17.2 e §17.4).
--
-- DUAS TABELAS NO MESMO ARQUIVO porque so fazem sentido juntas: a reserva e a
-- fonte OPERACIONAL do turno (permite revalidar por chamada sem consultar o
-- ledger inteiro), e o evento e a fonte de VERDADE do ciclo.
--
-- FAIL-CLOSED NAS DUAS IGNORANCIAS:
--   - preco desconhecido  -> nao ha evento (price_id e NOT NULL) e nao ha chamada;
--   - usage desconhecido  -> evento em USAGE_REVIEW_REQUIRED com estimativa
--                            conservadora COMPROMETIDA, e a reserva sai do
--                            caminho de expiracao automatica.
-- Sao falhas diferentes com a mesma consequencia: nao e possivel afirmar quanto
-- custou, logo nao e possivel afirmar que cabe no teto.

begin;

-- =====================================================================
-- Reservas — a reserva pertence ao TURNO; cada chamada apropria parte dela
-- =====================================================================
create table if not exists ai_cost_reservations (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  cycle_id uuid not null references ai_cycle_budgets(id) on delete restrict,

  -- Agrupa as ate 12 chamadas internas de um turno (MAX_ITERATIONS).
  turn_id text not null,

  reserved_cents integer not null check (reserved_cents >= 0),
  -- Acompanha o gasto DENTRO do turno. NUNCA diminui. Quando ultrapassa
  -- reserved_cents e overage OBSERVAVEL (incidente), nunca margem aceita.
  consumed_cents integer not null default 0 check (consumed_cents >= 0),
  released_cents integer not null default 0 check (released_cents >= 0),

  -- SETTLED / RELEASED / EXPIRED sao TERMINAIS: reserva finalizada nao volta a ativa.
  status text not null default 'HELD' check (status in ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED')),

  -- TRUE tira esta reserva da varredura de expiracao (§17.2.2). Sem isso, o TTL
  -- de recuperacao de crash vira PORTA DE SAIDA para consumo nao contabilizado:
  -- bastaria toda resposta vazia esperar cinco minutos para o custo desaparecer.
  -- A resolucao e administrativa ou por reconcile seguro — nunca por decurso de prazo.
  usage_review_required boolean not null default false,

  idempotency_key text not null,

  created_at timestamptz not null default now(),
  -- OBRIGATORIO: reserva nao liquidada nem liberada (crash, timeout, deploy no
  -- meio do turno) consumiria teto para sempre.
  expires_at timestamptz not null,
  -- finalized_at, e nao settled_at: os TRES estados terminais precisam de
  -- carimbo. Uma reserva EXPIRED sem data e indistinguivel de uma nunca varrida.
  finalized_at timestamptz,

  constraint ai_cost_reservations_idem_uniq unique (organization_id, idempotency_key),
  constraint ai_cost_reservations_terminal_chk
    check ((status = 'HELD') = (finalized_at is null))
);

comment on table ai_cost_reservations is
  'Reserva de capacidade por TURNO (Plano D). Reserva e capacidade COMPROMETIDA, nao gasto. usage_review_required tira a linha da varredura de expiracao. FORCE RLS.';

comment on column ai_cost_reservations.consumed_cents is
  'Gasto apropriado DENTRO do turno, chamada a chamada. Nunca diminui. Acima de reserved_cents e overage observavel (incidente), nunca franquia adicional.';

comment on column ai_cost_reservations.usage_review_required is
  'TRUE = existe chamada cujo custo nao pode ser determinado. A linha SAI da expiracao automatica e entra em fila de reconciliacao administrativa.';

create index if not exists ai_cost_reservations_held_idx
  on ai_cost_reservations (organization_id, cycle_id)
  where status = 'HELD';

-- Varredura de expiradas: so as HELD sem revisao pendente entram.
create index if not exists ai_cost_reservations_expiry_idx
  on ai_cost_reservations (expires_at)
  where status = 'HELD' and usage_review_required = false;

create index if not exists ai_cost_reservations_review_idx
  on ai_cost_reservations (organization_id, cycle_id)
  where usage_review_required = true;

create index if not exists ai_cost_reservations_turn_idx
  on ai_cost_reservations (organization_id, turn_id);

-- =====================================================================
-- Eventos de uso — a fonte de verdade do ciclo
-- =====================================================================
create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  -- Aponta para o ORCAMENTO, nao para um par de datas soltas: evita que dois
  -- eventos do mesmo ciclo discordem sobre onde o ciclo comeca.
  cycle_id uuid not null references ai_cycle_budgets(id) on delete restrict,
  unit_id uuid references units(id) on delete set null,
  reservation_id uuid references ai_cost_reservations(id) on delete set null,
  conversation_id uuid,

  turn_id text not null,
  request_id text not null,
  -- Identidade PROPRIA de cada chamada dentro do turno. A segunda chamada do
  -- fallback do Gemini tem call_id proprio: sao duas chamadas financeiras.
  call_id text not null,

  provider text not null,
  -- Modelo EXATO resolvido para ESTA chamada. Pro custa multiplas vezes Flash;
  -- gravar o modelo inicial num evento de fallback e subcontabilizacao direta.
  model text not null,

  -- NOT NULL: um evento de uso financeiro so pode existir quando o sistema
  -- conhece provider, modelo, preco, vigencia e custo calculavel. O fail-closed
  -- impede a chamada antes disso. E a "versao de preco usada", auditavel mesmo
  -- depois de a vigencia fechar.
  price_id uuid not null references ai_model_prices(id) on delete restrict,

  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  reasoning_tokens integer not null default 0 check (reasoning_tokens >= 0),

  cost_usd numeric(12,6) not null check (cost_usd >= 0),
  -- Taxa EFETIVAMENTE usada. NAO recalcular eventos historicos quando o cambio mudar.
  usd_to_brl numeric(12,6) not null check (usd_to_brl > 0),
  cost_brl_cents integer not null check (cost_brl_cents >= 0),

  usage_state text not null default 'SETTLED'
    check (usage_state in ('SETTLED', 'USAGE_REVIEW_REQUIRED', 'FAILED_BEFORE_PROVIDER', 'PROVIDER_FAILED')),

  -- Preenchido pela reconciliacao administrativa de USAGE_REVIEW_REQUIRED.
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_note text,

  idempotency_key text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- E o UNIQUE que protege a idempotencia: reexecucao com a mesma chave NAO
  -- debita de novo.
  constraint ai_usage_events_idem_uniq unique (organization_id, idempotency_key),

  -- ZERO SO E AFIRMACAO LEGITIMA onde se sabe que nada foi consumido.
  -- FAILED_BEFORE_PROVIDER: negada antes de qualquer I/O externo.
  -- PROVIDER_FAILED: provedor falhou sem consumo apuravel.
  -- USAGE_REVIEW_REQUIRED e o oposto: a chamada OCORREU e o custo e
  -- indeterminado — o valor gravado e estimativa conservadora COMPROMETIDA,
  -- e por isso tem de ser maior que zero.
  constraint ai_usage_events_zero_chk check (
    case usage_state
      when 'FAILED_BEFORE_PROVIDER' then cost_brl_cents = 0 and cost_usd = 0
      when 'PROVIDER_FAILED' then cost_brl_cents = 0 and cost_usd = 0
      when 'USAGE_REVIEW_REQUIRED' then cost_brl_cents > 0
      else true
    end
  ),

  constraint ai_usage_events_resolution_chk check (
    resolved_at is null or usage_state <> 'USAGE_REVIEW_REQUIRED'
  )
);

comment on table ai_usage_events is
  'Ledger de consumo de IA (Plano D). price_id NOT NULL: evento financeiro so existe com preco conhecido. Sem payload do provedor, sem credencial. FORCE RLS.';

comment on column ai_usage_events.call_id is
  'Identidade da CHAMADA dentro do turno. A segunda chamada do fallback do Gemini tem call_id proprio — sao duas chamadas financeiras.';

comment on column ai_usage_events.usage_state is
  'SETTLED = custo real conhecido. USAGE_REVIEW_REQUIRED = chamada ocorreu, custo indeterminado (valor = estimativa conservadora comprometida). FAILED_BEFORE_PROVIDER e PROVIDER_FAILED = zero VERDADEIRO.';

create index if not exists ai_usage_events_cycle_idx
  on ai_usage_events (cycle_id, created_at desc);

create index if not exists ai_usage_events_org_idx
  on ai_usage_events (organization_id, created_at desc);

create index if not exists ai_usage_events_review_idx
  on ai_usage_events (organization_id, cycle_id)
  where usage_state = 'USAGE_REVIEW_REQUIRED' and resolved_at is null;

create index if not exists ai_usage_events_model_idx
  on ai_usage_events (cycle_id, provider, model);

-- Uma call_id nao liquida duas vezes (invariante §17.4). O UNIQUE de
-- idempotency_key ja protege, e este indice torna a garantia explicita para o
-- caso de a chave passar a ser derivada de outra coisa no futuro.
create unique index if not exists ai_usage_events_call_uniq
  on ai_usage_events (organization_id, turn_id, call_id);

-- =====================================================================
-- Guarda de tenant — mesmo padrao de whatsapp_instance_child_tenant_guard (088)
-- =====================================================================
-- As FKs garantem que cycle_id e organization_id existem, NAO que sao a mesma
-- organizacao. Esta trigger existe para que um bug futuro num produtor nao
-- consiga atribuir CUSTO a organizacao errada em silencio.
create or replace function public.ai_budget_child_tenant_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_org uuid;
begin
  if new.cycle_id is null then
    return new;
  end if;

  select organization_id into v_cycle_org from ai_cycle_budgets where id = new.cycle_id;

  if v_cycle_org is null or v_cycle_org <> new.organization_id then
    raise exception 'cycle_id pertence a outra organizacao'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.ai_budget_child_tenant_guard()
  from public, anon, authenticated;

drop trigger if exists ai_cost_reservations_tenant_guard on ai_cost_reservations;
create trigger ai_cost_reservations_tenant_guard
  before insert or update of organization_id, cycle_id on ai_cost_reservations
  for each row execute function public.ai_budget_child_tenant_guard();

drop trigger if exists ai_usage_events_tenant_guard on ai_usage_events;
create trigger ai_usage_events_tenant_guard
  before insert or update of organization_id, cycle_id on ai_usage_events
  for each row execute function public.ai_budget_child_tenant_guard();

-- =====================================================================
-- RLS
-- =====================================================================
alter table ai_cost_reservations enable row level security;
alter table ai_cost_reservations force row level security;

drop policy if exists platform_admin_all_ai_cost_reservations on ai_cost_reservations;
create policy platform_admin_all_ai_cost_reservations
  on ai_cost_reservations for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

alter table ai_usage_events enable row level security;
alter table ai_usage_events force row level security;

drop policy if exists platform_admin_all_ai_usage_events on ai_usage_events;
create policy platform_admin_all_ai_usage_events
  on ai_usage_events for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists ai_usage_events_updated_at on ai_usage_events;
create trigger ai_usage_events_updated_at
  before update on ai_usage_events
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. RLS ligada e forcada nas duas (esperado: t,t em cada):
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname in ('ai_cost_reservations','ai_usage_events');
--
-- 2. price_id e NOT NULL (esperado: NO):
--   select is_nullable from information_schema.columns
--    where table_name='ai_usage_events' and column_name='price_id';
--
-- 3. Zero proibido em USAGE_REVIEW_REQUIRED (esperado: erro 23514):
--   insert into ai_usage_events (...) values (..., 'USAGE_REVIEW_REQUIRED', ..., 0, 0);
--
-- 4. Guarda de tenant instalada (esperado: 2 linhas):
--   select tgname from pg_trigger where tgname in
--     ('ai_cost_reservations_tenant_guard','ai_usage_events_tenant_guard');
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- DEGRAU 2. `drop table` destroi o ledger financeiro. Nao executar isolado.
--   drop trigger if exists ai_usage_events_tenant_guard on ai_usage_events;
--   drop trigger if exists ai_cost_reservations_tenant_guard on ai_cost_reservations;
--   drop function if exists public.ai_budget_child_tenant_guard();
--   drop table if exists ai_usage_events;
--   drop table if exists ai_cost_reservations;
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/ai-budget-migrations-guard.test.ts src/lib/migration-static-guard.test.ts 2>/dev/null || npx vitest run src/lib/ai-budget-migrations-guard.test.ts scripts/migration-static-guard.test.ts`
Expected: PASS nos dois arquivos — o guardrail novo e o guardrail estático legado (que varre TODAS as migrations e reprovaria URL de projeto ou segredo literal).

- [ ] **Step 7: Rodar a suíte inteira e commitar**

```bash
npm run test
npm run typecheck
git add supabase/migrations/20260803090000_099_ai_model_prices.sql supabase/migrations/20260803090100_100_ai_cycle_budgets.sql supabase/migrations/20260803090200_101_ai_usage_and_reservations.sql src/lib/ai-budget-migrations-guard.test.ts
git commit -m "feat(plano-d): schema de precos versionados, orcamento de ciclo, reservas e ledger de uso"
```

---

## Task 5: RPCs transacionais (migration 102)

**Files:**
- Create: `supabase/migrations/20260803090300_102_ai_budget_rpcs.sql`
- Modify: `src/lib/ai-budget-migrations-guard.test.ts` (adicionar o bloco de RPCs)

**Interfaces:**
- Consumes: as quatro tabelas da Task 4.
- Produces (assinaturas consumidas pelo adapter da Task 11):
  - `open_ai_cycle_budget(p_organization_id uuid, p_cycle_start date, p_cycle_end date, p_anchor_day integer, p_limit_cents integer)` → `table(id uuid, limit_cents integer, settled_cents integer, state text, cycle_start date, cycle_end date, cycle_anchor_day integer)`
  - `reserve_ai_budget(p_organization_id uuid, p_cycle_id uuid, p_turn_id text, p_idempotency_key text, p_estimate_cents integer, p_ttl_seconds integer)` → `table(decision text, reason_code text, reservation_id uuid, reserved_cents integer, consumed_cents integer, available_cents integer)`
  - `extend_ai_reservation(p_organization_id uuid, p_reservation_id uuid, p_additional_cents integer)` → mesma forma de `reserve_ai_budget`
  - `record_ai_call_usage(p_organization_id uuid, p_cycle_id uuid, p_reservation_id uuid, p_unit_id uuid, p_conversation_id uuid, p_turn_id text, p_request_id text, p_call_id text, p_provider text, p_model text, p_price_id uuid, p_input_tokens integer, p_output_tokens integer, p_cache_read_tokens integer, p_cache_write_tokens integer, p_reasoning_tokens integer, p_cost_usd numeric, p_usd_to_brl numeric, p_cost_brl_cents integer, p_usage_state text, p_idempotency_key text)` → `table(applied boolean, reserved_cents integer, consumed_cents integer, usage_review_required boolean)`
  - `finalize_ai_reservation(p_organization_id uuid, p_reservation_id uuid, p_final_status text)` → `table(finalized boolean, settled_cents integer, limit_cents integer, state text)`

**Contexto obrigatório para o implementador:**

- **O lock NÃO é a garantia — ele economiza trabalho.** As garantias reais são os `UNIQUE`/`EXCLUDE` da Task 4. Mesmo assim `select ... for update` na linha do orçamento é obrigatório: sem ele, duas invocações concorrentes leem o mesmo `available` e ambas reservam contra ele — o modo clássico de furar um teto "que está implementado".
- **Advisory lock é proibido aqui.** É session-scoped e não sobrevive ao pooling transaction-mode do PgBouncer (lição da migration 056 / lock de conversa).
- A varredura de expiradas roda **dentro** de `reserve_ai_budget`, sob o mesmo lock — não há worker novo nem cron novo nesta frente.

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar ao fim de `src/lib/ai-budget-migrations-guard.test.ts`:

```ts
const rpcs = read("102_ai_budget_rpcs");

const RPC_NAMES = [
  "open_ai_cycle_budget",
  "reserve_ai_budget",
  "extend_ai_reservation",
  "record_ai_call_usage",
  "finalize_ai_reservation",
];

describe("RPCs do orçamento (102)", () => {
  for (const fn of RPC_NAMES) {
    it(`${fn}: existe, é SECURITY DEFINER e fixa o search_path`, () => {
      const i = rpcs.indexOf(`function public.${fn}(`);
      expect(i, `${fn} não encontrada`).toBeGreaterThan(-1);
      const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
      expect(body).toContain("security definer");
      expect(body).toMatch(/set search_path\s*=/);
    });

    it(`${fn}: revoga PUBLIC/anon/authenticated e concede só a service_role`, () => {
      // CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
      // exposto ao PostgREST com a anon key.
      expect(rpcs).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`));
      expect(rpcs).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to service_role`));
      expect(rpcs).not.toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]*to (anon|authenticated)`));
    });
  }

  it("o orçamento é lido sob lock de linha — não advisory lock", () => {
    expect(rpcs).toMatch(/from ai_cycle_budgets[\s\S]{0,200}for update/i);
    expect(rpcs).not.toMatch(/pg_try_advisory_lock/);
  });

  it("a fórmula do disponível separa liquidado de comprometido", () => {
    expect(rpcs).toMatch(/reserved_cents\s*-\s*consumed_cents/);
    expect(rpcs).toMatch(/limit_cents\s*-\s*[\s\S]{0,80}settled_cents/);
  });

  it("a varredura de expiradas NUNCA toca reserva com usage pendente", () => {
    expect(rpcs).toMatch(/usage_review_required\s*=\s*false/);
  });

  it("reserva expirada não autoriza chamada e reserva terminal não volta a ativa", () => {
    expect(rpcs).toMatch(/status\s*=\s*'HELD'/);
    expect(rpcs).toContain("'EXPIRED'");
  });

  it("record_ai_call_usage é idempotente por chave", () => {
    expect(rpcs).toMatch(/on conflict[\s\S]{0,120}do nothing/i);
    expect(rpcs).toContain("applied");
  });

  it("usage indeterminado marca a reserva e não libera nada automaticamente", () => {
    expect(rpcs).toMatch(/USAGE_REVIEW_REQUIRED[\s\S]{0,400}usage_review_required\s*=\s*true/i);
  });

  it("o esgotamento carimba o momento — não é só um estado derivado", () => {
    expect(rpcs).toMatch(/state\s*=\s*'EXHAUSTED'[\s\S]{0,160}exhausted_at/);
  });

  it("nenhuma RPC conta conversa, mensagem ou interação", () => {
    expect(rpcs).not.toMatch(/count\(\*\)[\s\S]{0,80}from conversations/i);
    expect(rpcs).not.toMatch(/message_count|conversation_count|interaction_count/i);
  });

  it("controle positivo: o detector de grant realmente funciona", () => {
    expect("grant execute on function public.reserve_ai_budget(uuid) to anon").toMatch(
      /grant execute on function public\.reserve_ai_budget[^;]*to (anon|authenticated)/,
    );
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-migrations-guard.test.ts`
Expected: FAIL — `migration não encontrada: 102_ai_budget_rpcs`.

- [ ] **Step 3: Escrever a migration 102**

Criar `supabase/migrations/20260803090300_102_ai_budget_rpcs.sql`:

```sql
-- 102 — RPCs transacionais do orcamento de franquia de IA (Plano D, §17.5-17.6).
--
-- O PASSO 1 DO CICLO E ATOMICO E E ONDE O TETO E APLICADO. Verificar depois da
-- chamada nao e protecao: e deteccao.
--
-- O LOCK NAO E A GARANTIA. `select ... for update` na linha do orcamento
-- serializa as concorrentes e economiza trabalho; a correcao vem dos UNIQUE e
-- do EXCLUDE das migrations 100/101. Advisory lock NAO e usado de proposito:
-- e session-scoped e nao sobrevive ao pooling transaction-mode do PgBouncer
-- (licao da migration 056, lock de conversa por TTL em coluna).
--
-- NENHUMA FUNCAO AQUI CONTA CONVERSA, MENSAGEM OU INTERACAO. O unico teto e
-- financeiro (§18.1).
--
-- Sem segredo, sem host de projeto, sem header de autenticacao.

begin;

-- =====================================================================
-- 1. Abertura idempotente do ciclo
-- =====================================================================
-- Chamada no inicio do turno. Reexecucao devolve a linha existente — a
-- reativacao apos inadimplencia e a troca de plano sao exatamente os momentos
-- em que um segundo budget nasceria sobrepondo o primeiro, e o EXCLUDE da 100
-- e quem impede isso. Aqui a excecao 23P01 e traduzida em "devolva o ciclo que
-- ja cobre hoje" em vez de estourar no caller.
create or replace function public.open_ai_cycle_budget(
  p_organization_id uuid,
  p_cycle_start date,
  p_cycle_end date,
  p_anchor_day integer,
  p_limit_cents integer
)
returns table (
  id uuid,
  limit_cents integer,
  settled_cents integer,
  state text,
  cycle_start date,
  cycle_end date,
  cycle_anchor_day integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row ai_cycle_budgets%rowtype;
begin
  select * into v_row
  from ai_cycle_budgets b
  where b.organization_id = p_organization_id
    and b.cycle_start <= p_cycle_start
    and b.cycle_end > p_cycle_start;

  if found then
    return query select v_row.id, v_row.limit_cents, v_row.settled_cents, v_row.state,
                        v_row.cycle_start, v_row.cycle_end, v_row.cycle_anchor_day;
    return;
  end if;

  begin
    insert into ai_cycle_budgets (
      organization_id, cycle_start, cycle_end, cycle_anchor_day, limit_cents
    ) values (
      p_organization_id, p_cycle_start, p_cycle_end, p_anchor_day, p_limit_cents
    )
    returning * into v_row;
  exception
    -- 23505 = duplicado exato; 23P01 = sobreposicao. Nos dois casos outra
    -- invocacao ganhou a corrida: releia e devolva o ciclo dela. Criar um
    -- segundo budget seria TETO DOBRADO sem ninguem decidir isso.
    when unique_violation or exclusion_violation then
      select * into v_row
      from ai_cycle_budgets b
      where b.organization_id = p_organization_id
        and b.cycle_start <= p_cycle_start
        and b.cycle_end > p_cycle_start;
      if not found then
        raise;
      end if;
  end;

  return query select v_row.id, v_row.limit_cents, v_row.settled_cents, v_row.state,
                      v_row.cycle_start, v_row.cycle_end, v_row.cycle_anchor_day;
end;
$$;

comment on function public.open_ai_cycle_budget(uuid, date, date, integer, integer) is
  'Abre (ou devolve) o orcamento do ciclo que cobre p_cycle_start. Idempotente. limit_cents e CONGELADO na abertura. A aritmetica de ancora vem do nucleo puro ai-budget-core.ts — nao e reimplementada aqui.';

-- =====================================================================
-- 2. Reserva do turno — leitura e criacao ATOMICAS
-- =====================================================================
create or replace function public.reserve_ai_budget(
  p_organization_id uuid,
  p_cycle_id uuid,
  p_turn_id text,
  p_idempotency_key text,
  p_estimate_cents integer,
  p_ttl_seconds integer
)
returns table (
  decision text,
  reason_code text,
  reservation_id uuid,
  reserved_cents integer,
  consumed_cents integer,
  available_cents integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_budget ai_cycle_budgets%rowtype;
  v_res ai_cost_reservations%rowtype;
  v_committed integer;
  v_available integer;
  v_review boolean;
begin
  -- Serializa as concorrentes da MESMA organizacao. Sem isto, duas invocacoes
  -- leem o mesmo available e ambas reservam contra ele.
  select * into v_budget
  from ai_cycle_budgets
  where id = p_cycle_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select 'ERROR'::text, 'cycle_not_found'::text, null::uuid, 0, 0, 0;
    return;
  end if;

  -- Reexecucao com a mesma chave NAO cria segunda reserva nem debita de novo.
  select * into v_res
  from ai_cost_reservations
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if found then
    if v_res.status <> 'HELD' then
      -- Reserva finalizada nao volta a ativa: SETTLED/RELEASED/EXPIRED sao terminais.
      return query select 'ERROR'::text, 'reservation_finalized'::text,
                          v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0;
      return;
    end if;
    return query select 'ALLOW'::text, null::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0;
    return;
  end if;

  -- Varredura de expiradas, sob o mesmo lock. NUNCA toca reserva com usage
  -- pendente: o TTL de recuperacao de crash nao pode virar porta de saida para
  -- consumo nao contabilizado (§17.2.2).
  update ai_cost_reservations
     set status = 'EXPIRED',
         released_cents = greatest(reserved_cents - consumed_cents, 0),
         finalized_at = now()
   where organization_id = p_organization_id
     and cycle_id = p_cycle_id
     and status = 'HELD'
     and usage_review_required = false
     and expires_at <= now();

  -- Consumo anterior cujo custo nao pode ser determinado bloqueia chamada nova.
  -- Escopado ao CICLO: o valor comprometido ja foi apropriado neste ciclo, e um
  -- bloqueio perpetuo entre ciclos seria alerta eterno — o outro extremo que a
  -- §17.2.2 tambem proibe. A resolucao continua administrativa.
  select exists (
    select 1 from ai_usage_events e
    where e.organization_id = p_organization_id
      and e.cycle_id = p_cycle_id
      and e.usage_state = 'USAGE_REVIEW_REQUIRED'
      and e.resolved_at is null
  ) into v_review;

  if v_review then
    return query select 'DENY_USAGE_UNRESOLVED'::text, 'prior_usage_unresolved'::text,
                        null::uuid, 0, 0, 0;
    return;
  end if;

  -- Capacidade COMPROMETIDA = restante das HELD, nunca o valor original: a parte
  -- ja consumida migra para settled na liquidacao, e conta-la duas vezes
  -- bloquearia organizacoes que ainda tem saldo.
  select coalesce(sum(greatest(reserved_cents - consumed_cents, 0)), 0)
    into v_committed
    from ai_cost_reservations
   where organization_id = p_organization_id
     and cycle_id = p_cycle_id
     and status = 'HELD';

  v_available := greatest(v_budget.limit_cents - v_budget.settled_cents - v_committed, 0);

  if p_estimate_cents > v_available then
    return query select 'DENY_BUDGET'::text, 'insufficient_available'::text,
                        null::uuid, 0, 0, v_available;
    return;
  end if;

  insert into ai_cost_reservations (
    organization_id, cycle_id, turn_id, reserved_cents, idempotency_key, expires_at
  ) values (
    p_organization_id, p_cycle_id, p_turn_id, p_estimate_cents, p_idempotency_key,
    now() + make_interval(secs => greatest(p_ttl_seconds, 30))
  )
  returning * into v_res;

  return query select 'ALLOW'::text, null::text,
                      v_res.id, v_res.reserved_cents, v_res.consumed_cents, v_available;
end;
$$;

comment on function public.reserve_ai_budget(uuid, uuid, text, text, integer, integer) is
  'Reserva ATOMICA de capacidade para um TURNO. Le e cria sob lock de linha do orcamento. Expira HELD vencidas (nunca as com usage pendente). Idempotente por (organization_id, idempotency_key).';

-- =====================================================================
-- 3. Extensao da reserva — o turno longo nao e punido se o ciclo tem saldo
-- =====================================================================
-- Reservar as 12 iteracoes de uma vez bloquearia organizacoes com saldo real
-- por um pior caso que quase nunca ocorre. A reserva nasce cobrindo duas
-- chamadas e cresce sob o MESMO lock quando o turno se estende.
create or replace function public.extend_ai_reservation(
  p_organization_id uuid,
  p_reservation_id uuid,
  p_additional_cents integer
)
returns table (
  decision text,
  reason_code text,
  reservation_id uuid,
  reserved_cents integer,
  consumed_cents integer,
  available_cents integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res ai_cost_reservations%rowtype;
  v_budget ai_cycle_budgets%rowtype;
  v_committed integer;
  v_available integer;
begin
  select * into v_res
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id;

  if not found then
    return query select 'ERROR'::text, 'reservation_not_found'::text, null::uuid, 0, 0, 0;
    return;
  end if;

  if v_res.status <> 'HELD' then
    return query select 'ERROR'::text, 'reservation_finalized'::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0;
    return;
  end if;

  -- Reserva expirada NAO autoriza chamada, mesmo antes da varredura passar.
  if v_res.expires_at <= now() and v_res.usage_review_required = false then
    update ai_cost_reservations
       set status = 'EXPIRED',
           released_cents = greatest(reserved_cents - consumed_cents, 0),
           finalized_at = now()
     where id = v_res.id;
    return query select 'ERROR'::text, 'reservation_expired'::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0;
    return;
  end if;

  select * into v_budget
  from ai_cycle_budgets
  where id = v_res.cycle_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select 'ERROR'::text, 'cycle_not_found'::text, v_res.id,
                        v_res.reserved_cents, v_res.consumed_cents, 0;
    return;
  end if;

  select coalesce(sum(greatest(reserved_cents - consumed_cents, 0)), 0)
    into v_committed
    from ai_cost_reservations
   where organization_id = p_organization_id
     and cycle_id = v_res.cycle_id
     and status = 'HELD';

  v_available := greatest(v_budget.limit_cents - v_budget.settled_cents - v_committed, 0);

  if p_additional_cents > v_available then
    return query select 'DENY_BUDGET'::text, 'insufficient_available'::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, v_available;
    return;
  end if;

  update ai_cost_reservations
     set reserved_cents = reserved_cents + greatest(p_additional_cents, 0)
   where id = v_res.id
  returning * into v_res;

  return query select 'ALLOW'::text, null::text,
                      v_res.id, v_res.reserved_cents, v_res.consumed_cents,
                      greatest(v_available - p_additional_cents, 0);
end;
$$;

comment on function public.extend_ai_reservation(uuid, uuid, integer) is
  'Amplia a reserva do turno sob o MESMO lock do orcamento. DENY_BUDGET quando o ciclo nao comporta. Reserva expirada ou terminal nunca e ampliada.';

-- =====================================================================
-- 4. Apropriacao do custo real de UMA chamada
-- =====================================================================
-- O consumo de cada chamada e apropriado ANTES da proxima autorizacao — sem
-- isso, a 2a chamada decide com o saldo de antes da 1a.
create or replace function public.record_ai_call_usage(
  p_organization_id uuid,
  p_cycle_id uuid,
  p_reservation_id uuid,
  p_unit_id uuid,
  p_conversation_id uuid,
  p_turn_id text,
  p_request_id text,
  p_call_id text,
  p_provider text,
  p_model text,
  p_price_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cache_read_tokens integer,
  p_cache_write_tokens integer,
  p_reasoning_tokens integer,
  p_cost_usd numeric,
  p_usd_to_brl numeric,
  p_cost_brl_cents integer,
  p_usage_state text,
  p_idempotency_key text
)
returns table (
  applied boolean,
  reserved_cents integer,
  consumed_cents integer,
  usage_review_required boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_res ai_cost_reservations%rowtype;
begin
  insert into ai_usage_events (
    organization_id, cycle_id, reservation_id, unit_id, conversation_id,
    turn_id, request_id, call_id, provider, model, price_id,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
    cost_usd, usd_to_brl, cost_brl_cents, usage_state, idempotency_key
  ) values (
    p_organization_id, p_cycle_id, p_reservation_id, p_unit_id, p_conversation_id,
    p_turn_id, p_request_id, p_call_id, p_provider, p_model, p_price_id,
    greatest(p_input_tokens, 0), greatest(p_output_tokens, 0), greatest(p_cache_read_tokens, 0),
    greatest(p_cache_write_tokens, 0), greatest(p_reasoning_tokens, 0),
    greatest(p_cost_usd, 0), p_usd_to_brl, greatest(p_cost_brl_cents, 0),
    p_usage_state, p_idempotency_key
  )
  -- UMA call_id nao liquida duas vezes. Reexecucao com a mesma chave devolve
  -- applied=false e NAO avanca consumed_cents.
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_event_id;

  select * into v_res
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select (v_event_id is not null), 0, 0, false;
    return;
  end if;

  if v_event_id is not null then
    update ai_cost_reservations
       set consumed_cents = consumed_cents + greatest(p_cost_brl_cents, 0),
           -- A chamada OCORREU e o custo e indeterminado: a linha sai da
           -- varredura de expiracao e entra em fila de reconciliacao. Nunca
           -- resolvida por decurso de prazo.
           usage_review_required = usage_review_required
             or (p_usage_state = 'USAGE_REVIEW_REQUIRED')
     where id = v_res.id
    returning * into v_res;
  end if;

  return query select (v_event_id is not null), v_res.reserved_cents,
                      v_res.consumed_cents, v_res.usage_review_required;
end;
$$;

comment on function public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text) is
  'Grava UM evento de uso e avanca consumed_cents da reserva, de forma atomica e idempotente por (organization_id, idempotency_key). usage_state USAGE_REVIEW_REQUIRED marca a reserva e a tira da expiracao automatica.';

-- =====================================================================
-- 5. Finalizacao da reserva
-- =====================================================================
-- SETTLED e RELEASED compartilham a contabilidade: o consumido migra para
-- settled_cents do ciclo e a diferenca volta ao disponivel. O que muda e o
-- NOME do desfecho — liquidacao normal do turno versus liberacao por falha.
create or replace function public.finalize_ai_reservation(
  p_organization_id uuid,
  p_reservation_id uuid,
  p_final_status text
)
returns table (
  finalized boolean,
  settled_cents integer,
  limit_cents integer,
  state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res ai_cost_reservations%rowtype;
  v_budget ai_cycle_budgets%rowtype;
  v_new_settled integer;
  v_state text;
begin
  if p_final_status not in ('SETTLED', 'RELEASED') then
    return query select false, 0, 0, 'INVALID_STATUS'::text;
    return;
  end if;

  select * into v_res
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select false, 0, 0, 'RESERVATION_NOT_FOUND'::text;
    return;
  end if;

  select * into v_budget
  from ai_cycle_budgets
  where id = v_res.cycle_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select false, 0, 0, 'CYCLE_NOT_FOUND'::text;
    return;
  end if;

  -- Ja finalizada: idempotente, devolve o estado atual sem debitar de novo.
  if v_res.status <> 'HELD' then
    return query select false, v_budget.settled_cents, v_budget.limit_cents, v_budget.state;
    return;
  end if;

  v_new_settled := v_budget.settled_cents + greatest(v_res.consumed_cents, 0);
  v_state := case when v_new_settled >= v_budget.limit_cents then 'EXHAUSTED' else v_budget.state end;

  update ai_cycle_budgets
     set settled_cents = v_new_settled,
         state = v_state,
         -- O momento do esgotamento nao e derivavel depois. Carimbado uma vez.
         exhausted_at = case
           when v_state = 'EXHAUSTED' and exhausted_at is null then now()
           else exhausted_at
         end,
         updated_at = now()
   where id = v_budget.id;

  update ai_cost_reservations
     set status = p_final_status,
         released_cents = greatest(reserved_cents - consumed_cents, 0),
         finalized_at = now()
   where id = v_res.id;

  return query select true, v_new_settled, v_budget.limit_cents, v_state;
end;
$$;

comment on function public.finalize_ai_reservation(uuid, uuid, text) is
  'Liquida (SETTLED) ou libera (RELEASED) a reserva: move o consumido para settled_cents e devolve a diferenca ao disponivel. Idempotente — reserva terminal nao e reprocessada.';

-- =====================================================================
-- ACL — CREATE FUNCTION concede EXECUTE a PUBLIC por padrao e o schema public
-- e exposto ao PostgREST com a anon key. Revogar PUBLIC **e** os grants diretos.
-- =====================================================================
revoke all on function public.open_ai_cycle_budget(uuid, date, date, integer, integer)
  from public, anon, authenticated;
revoke all on function public.reserve_ai_budget(uuid, uuid, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.extend_ai_reservation(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_ai_reservation(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.open_ai_cycle_budget(uuid, date, date, integer, integer)
  to service_role;
grant execute on function public.reserve_ai_budget(uuid, uuid, text, text, integer, integer)
  to service_role;
grant execute on function public.extend_ai_reservation(uuid, uuid, integer)
  to service_role;
grant execute on function public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text)
  to service_role;
grant execute on function public.finalize_ai_reservation(uuid, uuid, text)
  to service_role;

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. ACL das cinco (esperado: nenhuma com anon= ou authenticated=):
--   select proname, proacl from pg_proc
--    where proname in ('open_ai_cycle_budget','reserve_ai_budget','extend_ai_reservation',
--                      'record_ai_call_usage','finalize_ai_reservation');
--
-- 2. search_path fixado nas cinco:
--   select proname, proconfig from pg_proc where proname like '%ai_%budget%' or proname like '%ai_call%';
--
-- 3. TESTE 42 DA SPEC — duas reservas concorrentes NAO usam o mesmo saldo.
--    Em DUAS sessoes psql simultaneas, com o ciclo em limit=10000 e settled=0:
--      A: begin; select * from reserve_ai_budget('<org>','<cyc>','tA','kA',6000,300);
--      B: begin; select * from reserve_ai_budget('<org>','<cyc>','tB','kB',6000,300);
--      A: commit;  B: commit;
--    Esperado: uma ALLOW e uma DENY_BUDGET. B fica bloqueada ate o commit de A.
--
-- 4. Idempotencia: chamar reserve_ai_budget duas vezes com a mesma
--    idempotency_key devolve o MESMO reservation_id e nao cria segunda linha.
--
-- 5. Reserva expirada nao autoriza:
--    reserve com ttl=30, esperar 31s, chamar extend -> reservation_expired.
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- DEGRAU 1 (o primeiro a desfazer). Nao destroi dado.
--   drop function if exists public.finalize_ai_reservation(uuid, uuid, text);
--   drop function if exists public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text);
--   drop function if exists public.extend_ai_reservation(uuid, uuid, integer);
--   drop function if exists public.reserve_ai_budget(uuid, uuid, text, text, integer, integer);
--   drop function if exists public.open_ai_cycle_budget(uuid, date, date, integer, integer);
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/ai-budget-migrations-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirmar que o ACL allowlist NÃO muda**

Run: `git diff --stat scripts/function-acl-allowlist.json`
Expected: sem saída. **Nenhuma RPC deste plano é executável por `anon`/`authenticated`** — só `service_role`. Uma entrada nova ali seria decisão de segurança, não conveniência.

- [ ] **Step 6: Rodar a suíte e commitar**

```bash
npm run test
npm run typecheck
git add supabase/migrations/20260803090300_102_ai_budget_rpcs.sql src/lib/ai-budget-migrations-guard.test.ts
git commit -m "feat(plano-d): RPCs transacionais de reserva, apropriacao e liquidacao do orcamento"
```

---

## Task 6: Ledger dos marcos (migration 103)

**Files:**
- Create: `supabase/migrations/20260803090400_103_ai_budget_milestones.sql`
- Modify: `src/lib/ai-budget-migrations-guard.test.ts`

**Interfaces:**
- Consumes: `ai_cycle_budgets`.
- Produces: tabela `ai_budget_milestones` com `(cycle_id, milestone_percent)` UNIQUE, colunas `notified_at`, `enqueue_attempts`, `dispatch_enabled_at_enqueue`.

**Contexto obrigatório para o implementador:**

- O UNIQUE de `billing_notifications` é **parcial** e **não deduplica com `invoice_id` nulo** — e nenhum aviso desta fase tem fatura. **A cadência vive no ledger, não na fila.**
- Disciplina de três tempos da 6b: **tocar (barreira de persistência) → enfileirar → carimbar**. Aqui o INSERT com `on conflict do nothing` **é** a barreira: se ele não grava, nada é enfileirado.

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `src/lib/ai-budget-migrations-guard.test.ts`:

```ts
const milestones = read("103_ai_budget_milestones");

describe("ledger dos marcos (103)", () => {
  it("RLS habilitada, forçada e só platform_admin", () => {
    expect(milestones).toContain("alter table ai_budget_milestones enable row level security");
    expect(milestones).toContain("alter table ai_budget_milestones force row level security");
    expect(milestones).toContain("platform_admin_all_ai_budget_milestones");
  });

  it("cada marco dispara no máximo uma vez por ciclo — UNIQUE (cycle_id, milestone_percent)", () => {
    expect(milestones).toMatch(/unique\s*\(\s*cycle_id\s*,\s*milestone_percent\s*\)/i);
  });

  it("o vocabulário de marco é fechado nos quatro percentuais", () => {
    expect(milestones).toMatch(/milestone_percent[\s\S]{0,200}in\s*\(\s*70\s*,\s*80\s*,\s*90\s*,\s*100\s*\)/i);
  });

  it("distingue 'registrei o marco' de 'o aviso foi enfileirado'", () => {
    // Sem notified_at separado, uma falha de enfileiramento seria indistinguível
    // de sucesso e o aviso morreria em silêncio.
    expect(milestones).toContain("notified_at");
    expect(milestones).toContain("enqueue_attempts");
  });

  it("registra se o dispatch estava ligado — 'não recebi e-mail' não é 'não houve alerta'", () => {
    expect(milestones).toContain("dispatch_enabled_at_enqueue");
  });

  it("guarda o custo liquidado no momento do marco — auditável depois", () => {
    expect(milestones).toContain("settled_cents_at_cross");
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-migrations-guard.test.ts`
Expected: FAIL — `migration não encontrada: 103_ai_budget_milestones`.

- [ ] **Step 3: Escrever a migration 103**

Criar `supabase/migrations/20260803090400_103_ai_budget_milestones.sql`:

```sql
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
-- =====================================================================
-- Rollback
-- =====================================================================
-- Executar ANTES da 101 (a trigger usa ai_budget_child_tenant_guard).
--   drop table if exists ai_budget_milestones;
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/ai-budget-migrations-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Rodar a suíte e commitar**

```bash
npm run test
npm run typecheck
git add supabase/migrations/20260803090400_103_ai_budget_milestones.sql src/lib/ai-budget-migrations-guard.test.ts
git commit -m "feat(plano-d): ledger dos marcos da franquia com cadencia fora da fila"
```

---

*(As tarefas 7 a 13 seguem em `2026-08-03-plano-d-franquia-ia-parte-3.md`.)*
