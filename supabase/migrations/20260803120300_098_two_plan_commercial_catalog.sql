-- 098 — Catalogo comercial de dois planos: seed dos novos e retirada dos
-- antigos da vitrine, no MESMO lote.
--
-- Invariante do §24 da spec: "os novos planos nao podem ser publicados enquanto
-- qualquer superficie cliente-facing ainda oferecer contratacao de
-- instancia-whatsapp separadamente" — o cliente veria dois modelos comerciais
-- ao mesmo tempo, com precos que se contradizem. Por isso INSERT e UPDATE
-- moram na MESMA transacao, e a validacao do PART 5 aborta se o resultado
-- deixar os dois modelos ativos.
--
-- HISTORICO PRESERVADO (§A6.1): nenhum plano antigo e apagado, nenhum
-- significado e alterado, nenhuma fatura/assinatura/implementacao e tocada.
-- `active = false` retira da VITRINE; a linha continua existindo e continua
-- significando exatamente o que significava. Uma fatura de 2026 que aponta
-- para instancia-whatsapp segue valendo.
--
-- DEPENDE de 094 (colunas contratuais) e 097 (CHECK de venda de plano com IA).
--
-- ROLLBACK — entregar como MIGRATION (numero 104+, timestamp > 20260803120300),
-- nunca como SQL avulso no Studio: SQL colado la grava schema_migrations com
-- timestamp != filename e trava o proximo `db push` por drift.
--
--   update billing_plans set active = true  where slug in ('sistema-reservas','instancia-whatsapp');
--   update billing_plans set active = false where slug = 'plano-reservas';
--   -- e a lista capturada no snapshot abaixo:
--   update billing_plans set active = true  where slug in (<slugs AI_CREDIT_PACKAGE do snapshot>);
--
-- SNAPSHOT OBRIGATORIO ANTES DE APLICAR — o PART 4 desativa pacotes de IA por
-- CATEGORIA (`category = 'AI_CREDIT_PACKAGE'`), de proposito, para pegar slugs
-- futuros que esta migration nao pode conhecer. A consequencia e que o rollback
-- NAO tem como saber quais linhas ele tocou. Sem o snapshot, a reversao e
-- incompleta e silenciosa:
--   select slug, active, category from billing_plans order by category, slug;
-- (Hoje deve tocar ZERO linhas: a 065 semeia os cinco credito-ia-* ja com
-- active = false e nenhuma migration os ativa. Snapshot mesmo assim — "deve"
-- nao e "prova", e a categoria e aberta a slug novo.)
--
-- Os planos novos nunca sao apagados — faturas emitidas neles ficariam orfas.

begin;

-- =====================================================================
-- PART 1 — Plano 1: Reservas. R$ 449,90/mes. CONTRATAVEL.
-- =====================================================================
-- Substitui `sistema-reservas` NA VITRINE. O slug antigo permanece para
-- historico (§A6.1) e nao e migrado: nao existe assinatura paga hoje.
--
-- included_features = {system}: declaracao EXPLICITA. Pelo contrato do Plano A,
-- plano com array nao vazio NAO herda IA de system — e' por isso que o Plano 1
-- nega `ai` sem precisar de nenhuma regra extra.
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, active, recommended, sort_order, features,
  included_features, included_whatsapp_connections, whatsapp_component_cents
) values (
  'plano-reservas',
  'Plano Reservas',
  'Plataforma completa de reservas, fila de espera e gestão de mesas.',
  44990, 'month', 'SYSTEM_SUBSCRIPTION', 'asaas',
  'recurring', true, false, 10,
  -- `features` e COPY DE MARKETING e nao concede nada. A autorizacao esta em
  -- included_features, logo abaixo, e as duas nunca se confundem.
  '["Reservas online ilimitadas", "Fila de espera e passantes", "Painel operacional e relatórios", "Portal público com cardápio", "Suporte por e-mail"]'::jsonb,
  array['system']::text[], 0, null
) on conflict (slug) do nothing;

-- =====================================================================
-- PART 2 — Plano 2: Automacao. R$ 799,90/mes. NASCE INATIVO.
-- =====================================================================
-- PLAN_AUTOMACAO_CHECKOUT = NO-GO: preparado e visivel no painel admin, NAO
-- contratavel e NAO ativavel ate o Plano D provar o teto de R$ 100 contra banco
-- real. O CHECK da 097 (billing_plans_ai_plan_not_sellable_chk) garante que
-- `active = true` aqui e IMPOSSIVEL, nao apenas desaconselhado — este INSERT
-- falharia se tentasse.
--
-- whatsapp_component_cents = 35000: R$ 799,90 - R$ 449,90 = R$ 350,00, o preco
-- incremental contratual da capacidade de automacao (§12). NAO e receita pura da
-- instancia Z-API: a margem consolidada precisa descontar tambem o custo de IA.
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, active, recommended, sort_order, features,
  included_features, included_whatsapp_connections, whatsapp_component_cents
) values (
  'plano-automacao',
  'Plano Automação',
  'Tudo do Plano Reservas mais automação de WhatsApp com agente de IA, confirmações e lembretes.',
  79990, 'month', 'SYSTEM_SUBSCRIPTION', 'asaas',
  'recurring', false, false, 20,
  '["Tudo do Plano Reservas", "1 conexão de WhatsApp", "Agente de IA 24 horas", "Confirmações e lembretes automáticos", "Chat operacional de WhatsApp"]'::jsonb,
  array['system','whatsapp','ai']::text[], 1, 35000
) on conflict (slug) do nothing;

-- =====================================================================
-- PART 3 — Auto-correcao dos campos CONTRATUAIS
-- =====================================================================
-- `on conflict do nothing` acima deixaria valores divergentes de uma execucao
-- parcial anterior intactos — e estes campos decidem AUTORIZACAO e RECEITA, nao
-- aparencia. Forcar aqui e o que torna a migration re-executavel sem deixar o
-- catalogo mentindo sobre o que cada plano concede.
--
-- `is distinct from` mantem o UPDATE em no-op no caso normal (nao suja
-- updated_at a cada re-execucao) e trata NULL corretamente, o que `<>` nao faz.
--
-- `active` NAO entra em nenhum dos dois UPDATEs: quem decide publicacao e o
-- PART 4 (para os antigos) e o INSERT (para os novos). Reafirmar active aqui
-- sobrescreveria uma despublicacao deliberada feita no painel.
update billing_plans
   set amount_cents = 44990,
       category = 'SYSTEM_SUBSCRIPTION',
       included_features = array['system']::text[],
       included_whatsapp_connections = 0,
       whatsapp_component_cents = null,
       updated_at = now()
 where slug = 'plano-reservas'
   and (amount_cents is distinct from 44990
        or category is distinct from 'SYSTEM_SUBSCRIPTION'
        or included_features is distinct from array['system']::text[]
        or included_whatsapp_connections is distinct from 0
        or whatsapp_component_cents is distinct from null);

update billing_plans
   set amount_cents = 79990,
       category = 'SYSTEM_SUBSCRIPTION',
       included_features = array['system','whatsapp','ai']::text[],
       included_whatsapp_connections = 1,
       whatsapp_component_cents = 35000,
       updated_at = now()
 where slug = 'plano-automacao'
   and (amount_cents is distinct from 79990
        or category is distinct from 'SYSTEM_SUBSCRIPTION'
        or included_features is distinct from array['system','whatsapp','ai']::text[]
        or included_whatsapp_connections is distinct from 1
        or whatsapp_component_cents is distinct from 35000);

-- =====================================================================
-- PART 4 — Retirada dos produtos antigos DA VITRINE
-- =====================================================================
-- NAO e delecao. NAO altera significado. NAO toca assinatura, fatura nem
-- implementacao existente. So retira da oferta.
--
-- implementacao-whatsapp NAO entra: continua ATIVO como cobranca unica, e' o
-- produto canonico mantido pelo modelo novo (§A6.1).
-- trial-padrao NAO entra: continua ativo, aplicado automaticamente na criacao
-- da org.
update billing_plans
   set active = false,
       updated_at = now()
 where slug in ('sistema-reservas', 'instancia-whatsapp')
   and active = true;

-- Pacotes de IA por CATEGORIA, nao pelos cinco slugs: um `credito-ia-300`
-- criado no painel amanha seria retirado por esta mesma linha, enquanto uma
-- lista de slugs o deixaria ativo em silencio.
update billing_plans
   set active = false,
       updated_at = now()
 where category = 'AI_CREDIT_PACKAGE'
   and active = true;

-- =====================================================================
-- PART 5 — Validacao da pos-condicao (aborta a transacao inteira)
-- =====================================================================
-- Precedente: a 066 ja falha explicitamente quando o catalogo nao fica no
-- estado esperado. Aqui o motivo e mais forte: publicar os planos novos com um
-- produto antigo ainda ativo produz DOIS MODELOS COMERCIAIS SIMULTANEOS na
-- tela do cliente — exatamente o que o §24 proibe.
do $$
declare
  v_offenders text;
begin
  select string_agg(slug, ', ' order by slug)
    into v_offenders
    from billing_plans
   where active = true
     and slug <> 'plano-reservas'
     -- Categorias que competem com o modelo de dois planos. Nao inclui
     -- WHATSAPP_IMPLEMENTATION (cobranca unica mantida) nem TRIAL.
     and category in ('SYSTEM_SUBSCRIPTION', 'WHATSAPP_SUBSCRIPTION', 'AI_CREDIT_PACKAGE');

  if v_offenders is not null then
    raise exception
      'Catalogo comercial inconsistente: plano(s) ativo(s) fora do modelo de dois planos: %',
      v_offenders
      using hint =
        'Entre assinatura de sistema, instancia de WhatsApp e pacote de IA, so plano-reservas '
        'pode ficar ativo. Desative os listados (active = false) e reaplique. '
        'implementacao-whatsapp e trial-padrao continuam ativos de proposito.';
  end if;

  -- O erro OPOSTO, igualmente grave e muito mais silencioso: se plano-reservas
  -- nao ficou ativo, a vitrine de assinatura fica VAZIA e ninguem consegue
  -- contratar nada — sem nenhum erro aparecer.
  if not exists (
    select 1 from billing_plans where slug = 'plano-reservas' and active = true
  ) then
    raise exception
      'plano-reservas nao ficou ativo: a vitrine de assinatura ficaria vazia.'
      using hint = 'Verifique se o INSERT do PART 1 foi no-op por conflito com uma linha inativa.';
  end if;

  -- Terceiro erro, o mais dificil de ver: plano-reservas ATIVO mas roteando
  -- para o provedor errado. O PART 3 auto-corrige os campos que decidem
  -- AUTORIZACAO e RECEITA, e NAO toca provider/billing_type/interval — entao
  -- uma linha pre-existente com esses campos divergentes (criadas a mao pelo
  -- painel: manage-billing PLAN_WRITABLE_COLUMNS aceita os tres) sobrevive ao
  -- INSERT no-op e a correcao, e fica ativa apontando para o caminho legado
  -- Stripe, que escreve organizations.billing_status sem checar categoria.
  -- Precondicao improvavel — o slug e novo — mas afirmar e barato e transforma
  -- "improvavel" em demonstravel.
  if not exists (
    select 1 from billing_plans
     where slug = 'plano-reservas'
       and active = true
       and provider = 'asaas'
       and billing_type = 'recurring'
       and "interval" = 'month'
  ) then
    raise exception
      'plano-reservas ativo com provider/billing_type/interval fora do contrato comercial.'
      using hint =
        'Esperado provider=asaas, billing_type=recurring, interval=month. Uma linha pre-existente '
        'com valores divergentes nao e corrigida pelo PART 3. Ajuste a linha e reaplique.';
  end if;
end $$;

commit;

-- =====================================================================
-- Validacao pos-migration (rodar manualmente apos `supabase db push`)
-- =====================================================================
-- Esperado: plano-reservas ativo; plano-automacao inativo com componente 35000;
-- sistema-reservas, instancia-whatsapp e os credito-ia inativos;
-- implementacao-whatsapp e trial-padrao ativos.
--
--   select slug, amount_cents, category, active, provider, billing_type, "interval",
--          included_features, included_whatsapp_connections, whatsapp_component_cents
--     from billing_plans
--    order by active desc, sort_order;
--
-- E a prova de que o CHECK da 097 esta valendo (deve FALHAR com 23514):
--   update billing_plans set active = true where slug = 'plano-automacao';
