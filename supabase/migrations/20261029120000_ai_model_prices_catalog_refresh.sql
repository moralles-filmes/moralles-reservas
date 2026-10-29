-- Precos dos modelos ativos do catalogo de IA (Entrega B, B1.2).
--
-- PROPOSITO: o catalogo unico (`_shared/ai-model-catalog.ts`) ganhou modelos
-- novos. Preco desconhecido falha FECHADO (sem preco nao ha price_id, que e NOT
-- NULL em ai_usage_events), entao modelo ativo sem linha aqui CALA o agente da
-- organizacao que o escolher. Esta migration semeia a vigencia aberta de cada um.
--
-- As linhas de modelos aposentados (claude-haiku-4-5, claude-sonnet-4-6, gpt-4o,
-- gpt-4o-mini, grok-3, deepseek-chat) ficam INTOCADAS: sao o historico que os
-- eventos de uso ja gravados referenciam. `gemini-2.5-flash` e `gemini-2.5-pro`
-- tambem seguem com as linhas da 099 (a defasagem do flash e achado a parte).
--
-- `usd_to_brl` = 5.50 em todas as linhas (convencao da 099; trocar a taxa e
-- decisao do usuario e abre vigencia NOVA, nunca UPDATE). `reasoning_usd_per_mtok`
-- = null em todas: o token de raciocinio e cobrado como OUTPUT, nunca e gratis.
--
-- FONTES (paginas oficiais dos provedores, acessadas em 2026-10-20; sem URL de
-- projeto, sem segredo):
--   gemini-3.8-flash         ai.google.dev/gemini-api/docs/pricing e
--                            .../models/gemini-3.8-flash. O preco DOBRA em
--                            2027-01-01 (0.75/3.75/0.075 -> 1.50/7.50/0.15), por
--                            isso ha duas vigencias contiguas: a primeira fecha
--                            em 2027-01-01 (EXCLUSIVO) e a segunda abre nele.
--   gemini-3.5-flash-lite    ai.google.dev/gemini-api/docs/pricing e
--                            .../models/gemini-3.5-flash-lite
--   claude-haiku-5-5         platform.claude.com/docs/en/models/haiku-5-5/overview
--                            (cache de leitura 0.01 e escrita 0.125, faixa <=100k)
--   claude-sonnet-5-5        platform.claude.com/docs/en/models/sonnet-5-5/overview
--                            (cache de leitura 0.20: o maior entre as duas leituras
--                            da evidencia, conservador)
--   gpt-6-luna               developers.openai.com/api/docs/models/gpt-6-luna
--   gpt-5.6-sol              developers.openai.com/api/docs/models/gpt-5.6-sol
--                            PRECO PROMOCIONAL "pelo menos ate 2026-11-21": o preco
--                            pos-promocao e desconhecido. O passo B6 reconfere
--                            todos os precos NO DIA do `db push`, este em especial.
--   grok-4.20-0309-non-reasoning, grok-4.3
--                            docs.x.ai/developers/models (faixa <=200k)
--   deepseek-flash           api-docs.deepseek.com/quick_start/pricing. Preco de
--                            PICO; fora do pico e a metade. Conservador de proposito.
--
-- Sem credenciais, sem chave de provedor, sem host de projeto.

begin;

-- O predicado casa provider+model e IGNORA a vigencia DE PROPOSITO (mesmo motivo
-- da 099): filtrar por `p.effective_to is null` reabriria o replay, porque FECHAR
-- a vigencia de um modelo (procedimento normal para trocar preco ou cambio) faria
-- a condicao voltar a ser verdadeira, o INSERT recriar a vigencia ja fechada e o
-- EXCLUDE estourar 23P01 — a migration inteira falharia por causa do seed.
--
-- Um unico INSERT ... SELECT avalia o NOT EXISTS contra o snapshot de ANTES do
-- statement. Por isso as DUAS linhas do gemini-3.8-flash entram juntas na
-- primeira aplicacao (nenhuma existia) e as duas saem juntas no replay (ja
-- existem). Nao ha caso em que so uma das duas vigencias seja criada.
insert into ai_model_prices (
  provider, model,
  input_usd_per_mtok, output_usd_per_mtok,
  cache_read_usd_per_mtok, cache_write_usd_per_mtok,
  reasoning_usd_per_mtok, usd_to_brl,
  effective_from, effective_to
)
select v.provider, v.model, v.inp, v.outp, v.cr, v.cw, v.reas, 5.50, v.effective_from, v.effective_to
from (values
  ('gemini',   'gemini-3.8-flash',             0.750000,  3.750000, 0.075000, 0.000000, null::numeric, timestamptz '2026-10-20 00:00:00+00', timestamptz '2027-01-01 00:00:00+00'),
  ('gemini',   'gemini-3.8-flash',             1.500000,  7.500000, 0.150000, 0.000000, null::numeric, timestamptz '2027-01-01 00:00:00+00', null::timestamptz),
  ('gemini',   'gemini-3.5-flash-lite',        0.300000,  2.500000, 0.030000, 0.000000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz),
  ('claude',   'claude-haiku-5-5',             0.100000,  0.500000, 0.010000, 0.125000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz),
  ('claude',   'claude-sonnet-5-5',            2.000000, 10.000000, 0.200000, 2.500000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz),
  ('openai',   'gpt-6-luna',                   0.100000,  0.500000, 0.010000, 0.125000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz),
  ('openai',   'gpt-5.6-sol',                  4.000000, 20.000000, 0.400000, 5.000000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz),
  ('grok',     'grok-4.20-0309-non-reasoning', 1.250000,  2.500000, 0.200000, 0.000000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz),
  ('grok',     'grok-4.3',                     1.250000,  2.500000, 0.200000, 0.000000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz),
  ('deepseek', 'deepseek-flash',               0.300000,  1.200000, 0.006000, 0.000000, null::numeric, timestamptz '2026-10-20 00:00:00+00', null::timestamptz)
) as v(provider, model, inp, outp, cr, cw, reas, effective_from, effective_to)
where not exists (
  select 1 from ai_model_prices p
  where p.provider = v.provider and p.model = v.model
);

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. Dez linhas nos nove modelos novos, nove com vigencia aberta (esperado: 10 e 9):
--   select count(*) as linhas, count(*) filter (where effective_to is null) as abertas
--     from ai_model_prices
--    where model in ('gemini-3.8-flash','gemini-3.5-flash-lite','claude-haiku-5-5',
--                    'claude-sonnet-5-5','gpt-6-luna','gpt-5.6-sol',
--                    'grok-4.20-0309-non-reasoning','grok-4.3','deepseek-flash');
--
-- 2. Cada modelo novo tem exatamente uma vigencia aberta (esperado: 0 linhas):
--   select m from unnest(array['gemini-3.8-flash','gemini-3.5-flash-lite','claude-haiku-5-5',
--                              'claude-sonnet-5-5','gpt-6-luna','gpt-5.6-sol',
--                              'grok-4.20-0309-non-reasoning','grok-4.3','deepseek-flash']) m
--    where (select count(*) from ai_model_prices p where p.model = m and p.effective_to is null) <> 1;
--
-- 3. As duas vigencias do gemini-3.8-flash sao contiguas (esperado: 2 linhas,
--    a primeira com effective_to = a effective_from da segunda):
--   select effective_from, effective_to, input_usd_per_mtok
--     from ai_model_prices where model = 'gemini-3.8-flash' order by effective_from;
--
-- 4. Replay e no-op (esperado: 0 linhas inseridas ao reaplicar o INSERT acima).
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- So antes de existir ai_usage_events apontando para estas linhas (a FK
-- price_id da 101 impede o delete depois). Com uso gravado, feche a vigencia
-- (`effective_to`) em vez de apagar.
--   delete from ai_model_prices
--    where effective_from >= timestamptz '2026-10-20 00:00:00+00'
--      and model in ('gemini-3.8-flash','gemini-3.5-flash-lite','claude-haiku-5-5',
--                    'claude-sonnet-5-5','gpt-6-luna','gpt-5.6-sol',
--                    'grok-4.20-0309-non-reasoning','grok-4.3','deepseek-flash');
