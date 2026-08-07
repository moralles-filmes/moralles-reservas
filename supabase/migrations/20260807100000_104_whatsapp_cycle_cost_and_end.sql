-- Custo do ciclo e encerramento — as duas escritas que atravessam duas tabelas.
--
-- O DEFEITO QUE ESTA MIGRATION FECHA (verificacao manual da Fase 6c, §2.2 e
-- §2.3): `set_cost` gravava so em `whatsapp_instances` e nunca alcancava o
-- ciclo aberto; `confirm_end` deixava o ultimo ciclo OPEN para sempre, porque a
-- rolagem da 090 pula `lifecycle_state` fora de ACTIVE/CANCELLATION_REQUESTED.
--
-- POR QUE RPC E NAO DUAS ESCRITAS NA EDGE FUNCTION: PostgREST nao tem
-- transacao. Se a segunda escrita falha, o resultado e exatamente o bug de
-- hoje, em silencio. E ha corrida real com o worker diario — a rolagem toma
-- FOR UPDATE na instancia; escrita fora dessa trava pode preencher um ciclo que
-- o worker esta fechando no mesmo instante. As duas funcoes abaixo tomam A
-- MESMA trava, pelo principio que a 090 ja declara: juntos ou nao acontecem.
--
-- NAO REESCREVE A 090 NEM A 088. Migration aplicada nao se reescreve; o que
-- estiver errado no texto delas e corrigido AQUI, por `comment on column`.
--
-- NAO TOCA DADO DE NENHUMA ORGANIZACAO. Cria funcoes, estende um CHECK e
-- corrige comentarios.

begin;

-- =====================================================================
-- 1. Custo: instancia + ciclo aberto, numa transacao
-- =====================================================================
-- PRINCIPIO DA COMPETENCIA PRESERVADO. O ciclo congela o custo na ABERTURA e
-- representa a competencia que ja comecou — por isso valor JA GRAVADO nunca e
-- sobrescrito aqui. Preencher um NULO nao e reescrever historia: e registrar o
-- que nunca se soube. Custo errado ja gravado tem porta propria e auditada
-- (acao `correct_cycle_cost` do painel, restrita a PENDING_REVIEW).
create or replace function public.set_whatsapp_instance_cost(
  p_instance_id uuid,
  p_cost_cents integer,
  p_cost_source text,
  p_cost_note text,
  p_actor uuid
)
returns table (instance_found boolean, open_cycle_id uuid, cycle_filled boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
  v_open record;
  v_filled boolean := false;
begin
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  if not found then
    return query select false, null::uuid, false;
    return;
  end if;

  update whatsapp_instances
     set current_monthly_cost_cents = p_cost_cents,
         cost_source = p_cost_source,
         -- Carimbo e autoria so existem quando existe numero. Custo
         -- desconhecido com data de atualizacao afirmaria que alguem informou
         -- algo.
         cost_updated_at = case when p_cost_cents is null then null else now() end,
         cost_updated_by = case when p_cost_cents is null then null else p_actor end,
         cost_note = p_cost_note,
         updated_by = p_actor,
         updated_at = now()
   where id = p_instance_id;

  select * into v_open
  from whatsapp_instance_cycles
  where instance_id = p_instance_id and status = 'OPEN'
  for update;

  if not found then
    return query select true, null::uuid, false;
    return;
  end if;

  -- As DUAS condicoes importam. `provider_cost_cents is null` protege o valor
  -- congelado; `p_cost_cents is not null` impede que "passei a nao saber" apague
  -- do ciclo um custo que ja estava la.
  if v_open.provider_cost_cents is null and p_cost_cents is not null then
    update whatsapp_instance_cycles
       set provider_cost_cents = p_cost_cents,
           cost_source = p_cost_source,
           cost_snapshot_at = now()
     where id = v_open.id;
    v_filled := true;
  end if;

  return query select true, v_open.id, v_filled;
end;
$$;

comment on function public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid) is
  'Grava o custo na instancia e PREENCHE o ciclo OPEN quando ele esta sem custo. Nunca sobrescreve valor ja congelado. Transacional, sob FOR UPDATE na instancia — a mesma trava da rolagem 090.';

-- =====================================================================
-- 2. Encerramento: instancia ENDED + fecho do ciclo aberto
-- =====================================================================
-- O CICLO MANTEM `provider_due_on`. O fornecedor cobrou o periodo inteiro;
-- encurtar a data mentiria sobre o custo. Encerrar cedo FECHA o ciclo, nao o
-- reduz.
--
-- A TRANSICAO DE ESTADO NAO E REVALIDADA AQUI. `canTransition` roda na Edge
-- Function; duplicar a maquina de estados em plpgsql criaria a segunda verdade
-- que a Fase 6b existe para impedir.
create or replace function public.confirm_whatsapp_instance_end(
  p_instance_id uuid,
  p_note text,
  p_actor uuid
)
returns table (
  instance_found boolean,
  lifecycle_before text,
  closed_cycle_id uuid,
  closed_cycle_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
  v_open record;
  v_status text;
  v_closed_id uuid := null;
begin
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  if not found then
    return query select false, null::text, null::uuid, null::text;
    return;
  end if;

  update whatsapp_instances
     set lifecycle_state = 'ENDED',
         -- Repeticao NAO reescreve a data da primeira confirmacao.
         ended_at = coalesce(ended_at, now()),
         ended_by = p_actor,
         end_confirmation_note = p_note,
         -- Encerrada nao guarda vinculo de canal: libera o indice unico de
         -- channel_id para uma instancia futura no mesmo canal.
         channel_id = null,
         -- E o que faz o painel parar de anunciar "em curso" numa instancia
         -- encerrada. Mesmo que a 090 faz no ramo CLOSED_NO_REOPEN.
         current_cycle_started_on = null,
         current_cycle_due_on = null,
         updated_by = p_actor,
         updated_at = now()
   where id = p_instance_id;

  select * into v_open
  from whatsapp_instance_cycles
  where instance_id = p_instance_id and status = 'OPEN'
  for update;

  if found then
    -- MESMA regra do vencimento (090): custo desconhecido nao fecha como
    -- financeiramente concluido.
    v_status := case when v_open.provider_cost_cents is null then 'PENDING_REVIEW' else 'CLOSED' end;
    update whatsapp_instance_cycles
       set status = v_status,
           closed_at = now(),
           -- Ha humano identificado aqui, ao contrario da rolagem automatica.
           closed_by = p_actor
     where id = v_open.id
    returning id into v_closed_id;
  end if;

  return query select true, v_inst.lifecycle_state::text, v_closed_id, v_status;
end;
$$;

comment on function public.confirm_whatsapp_instance_end(uuid, text, uuid) is
  'Marca a instancia ENDED, limpa a projecao de ciclo e FECHA o ciclo OPEN pela regra do vencimento (sem custo -> PENDING_REVIEW). Idempotente. Nao revalida a transicao — isso e da Edge Function.';

-- =====================================================================
-- 3. Vocabulario do ledger de observacoes: a OITAVA acao
-- =====================================================================
-- A fonte canonica continua sendo INSTANCE_NOTE_ACTIONS em
-- _shared/whatsapp-instance-notes-core.ts. O acoplamento e verificado nas duas
-- direcoes por src/lib/whatsapp-instance-notes-core.test.ts, que le o CHECK
-- EFETIVO — o desta migration, nao o da 096.
--
-- `drop constraint if exists` antes de `add`: idempotente, e a 096 nao e
-- reescrita.
alter table whatsapp_instance_notes
  drop constraint if exists whatsapp_instance_notes_action_check;

alter table whatsapp_instance_notes
  add constraint whatsapp_instance_notes_action_check check (action in (
    'REGISTER', 'UPDATE', 'REACTIVATE', 'SET_COST',
    'CONFIRM_CYCLE_DATE', 'REQUEST_CANCELLATION', 'CONFIRM_END',
    'CORRECT_CYCLE_COST'
  ));

-- =====================================================================
-- 4. As tres colunas mortas — corrigir a PROMESSA, nao o comportamento
-- =====================================================================
-- A 090 afirma, num comentario inline, que "receita e margem ficam NULL aqui e
-- sao preenchidas pelo worker". E FALSO: o worker calcula a margem EM MEMORIA,
-- para o payload do alerta ECONOMIC_IMBALANCE, e nunca a grava. Os unicos dois
-- produtores desta tabela (o insert de `confirm_cycle_date` e a rolagem 090)
-- nao tocam nenhuma das tres colunas.
--
-- A 090 NAO e reescrita — migration aplicada nao se reescreve. O registro fica
-- aqui, onde o proximo leitor da coluna o encontra.
--
-- Persistir margem ficou FORA DE ESCOPO por decisao: o alerta ja a calcula ao
-- vivo e nao ha consumidor da versao persistida. Quando houver, e quem escrever
-- o produtor que corrige estes comentarios.
comment on column whatsapp_instance_cycles.customer_revenue_cents is
  'NAO E ESCRITA POR NENHUM PRODUTOR (Fase 6b/6c). Nem o insert de confirm_cycle_date nem a rolagem 090 a preenchem. O comentario inline da 090 que promete preenchimento pelo worker e falso.';

comment on column whatsapp_instance_cycles.revenue_source is
  'NAO E ESCRITA POR NENHUM PRODUTOR (Fase 6b/6c). Ver customer_revenue_cents.';

comment on column whatsapp_instance_cycles.gross_margin_cents is
  'NAO E ESCRITA POR NENHUM PRODUTOR (Fase 6b/6c). A margem e calculada EM MEMORIA pelo worker de ciclos, para o payload do alerta ECONOMIC_IMBALANCE, e descartada.';

-- =====================================================================
-- 5. ACL — CREATE FUNCTION concede EXECUTE a PUBLIC por padrao
-- =====================================================================
revoke all on function public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid)
  to service_role;
grant execute on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  to service_role;

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. ACL das duas funcoes (esperado: nenhuma com anon= ou authenticated=):
--   select proname, proacl from pg_proc
--    where proname in ('set_whatsapp_instance_cost', 'confirm_whatsapp_instance_end');
--
-- 2. search_path fixado nas duas (esperado: search_path=public em cada uma):
--   select proname, proconfig from pg_proc
--    where proname in ('set_whatsapp_instance_cost', 'confirm_whatsapp_instance_end');
--
-- 3. CHECK estendido (esperado: a expressao contem CORRECT_CYCLE_COST):
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'whatsapp_instance_notes_action_check';
--
-- 4. Reaplicar a migration inteira nao muda nada (idempotencia): rodar de novo
--    e repetir os itens 1 a 3.
--
-- 5. COMPORTAMENTO, nao estrutura — casos COST-1..4, END-1..3 e CORR-1..2 em
--    supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql, com os controles
--    positivos do 06.
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- As duas funcoes podem ser dropadas sem perda de dado. O CHECK volta a lista
-- de sete SOMENTE se nenhuma linha CORRECT_CYCLE_COST existir — conferir antes,
-- senao o `add constraint` falha e o rollback aborta pela metade.
--   select count(*) from whatsapp_instance_notes where action = 'CORRECT_CYCLE_COST';
--   drop function if exists public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid);
--   drop function if exists public.confirm_whatsapp_instance_end(uuid, text, uuid);
--   alter table whatsapp_instance_notes drop constraint if exists whatsapp_instance_notes_action_check;
--   alter table whatsapp_instance_notes add constraint whatsapp_instance_notes_action_check
--     check (action in ('REGISTER','UPDATE','REACTIVATE','SET_COST',
--                       'CONFIRM_CYCLE_DATE','REQUEST_CANCELLATION','CONFIRM_END'));
