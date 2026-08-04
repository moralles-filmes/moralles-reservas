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
--
-- `with schema extensions` NAO e cosmetico: sem a clausula, a extensao instala
-- ~100 funcoes de suporte em `public` com EXECUTE para PUBLIC, e a auditoria de
-- ACL do projeto (`audit_function_acl()`, job `acl-com-banco`) varre `public`
-- SEM filtrar por extensao — o guardrail passaria a reprovar com dezenas de
-- violacoes que ninguem introduziu, e guardrail ruidoso acaba ignorado.
-- Seguro nos dois sentidos: `if not exists` ignora a clausula se a extensao ja
-- estiver instalada em qualquer schema. O schema `extensions` e criado pela
-- plataforma Supabase (e onde vivem pgcrypto/pg_net); se esta migration falhar
-- com "schema extensions does not exist", e ele que falta, nao a extensao.
--
-- E O REVERSO DESSA MESMA SEGURANCA: se `btree_gist` JA estiver instalada em
-- `public` no ambiente real, esta linha e no-op e a auditoria de ACL continua
-- suja — a migration nao conserta o que ja esta la. Conferir com
-- `select extnamespace::regnamespace from pg_extension where extname='btree_gist'`;
-- mover exige `alter extension btree_gist set schema extensions`, em migration
-- propria e com o job `acl-com-banco` rodado depois.
--
-- A localizacao NAO afeta o EXCLUDE: o opclass default de um tipo e resolvido
-- por (tipo, access method) em `pg_opclass`, sem consultar o search_path, e os
-- operadores `=`/`&&` usados abaixo sao de `pg_catalog`.
create extension if not exists btree_gist with schema extensions;

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
-- O predicado casa provider+model e IGNORA a vigencia DE PROPOSITO. Filtrar por
-- `p.effective_to is null` parecia mais preciso e reabria o replay: bastava
-- alguem FECHAR a vigencia de um modelo (que e o procedimento normal para
-- atualizar preco ou cambio) para a condicao voltar a ser verdadeira, o INSERT
-- recriar `[2026-01-01, inf)` e o EXCLUDE estourar 23P01 — a migration inteira
-- falharia por causa do seed.
where not exists (
  select 1 from ai_model_prices p
  where p.provider = v.provider and p.model = v.model
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
