-- Encerramento: a PRIMEIRA confirmacao vence nos TRES campos.
--
-- O DEFEITO QUE ESTA MIGRATION FECHA: na 104, `ended_at` coalesce mas `ended_by`
-- e `end_confirmation_note` sao sobrescritos. Numa repeticao a linha passa a
-- afirmar "encerrada em T1, por B, com a nota X" — quando B nao confirmou em T1.
-- Os tres campos descrevem O MESMO ato; dois deles falando de um ato e o
-- terceiro de outro nao e registro parcial, e registro falso.
--
-- A PORTA DE ENTRADA NAO E CORRIDA. `canTransition` tem curto-circuito de mesmo
-- estado (ENDED -> ENDED passa) e o botao "Confirmar encerramento" e renderizado
-- a partir do `lifecycle_state` EM CACHE do React Query, com
-- `refetchOnWindowFocus: false` global: uma aba parada de outro administrador
-- continua oferecendo o botao depois do primeiro encerramento.
--
-- NADA SE PERDE. `recordInstanceNote` roda em TODA chamada de `confirm_end`,
-- depois da RPC e sem condicao: a segunda confirmacao sobrevive em
-- `whatsapp_instance_notes` com ator, nota e carimbo proprios. Coalescer move a
-- informacao para onde ela pertence — a linha da instancia registra
-- coerentemente a PRIMEIRA confirmacao, o ledger registra todas.
--
-- COALESCER NENHUM SERIA ESTRITAMENTE PIOR: `ended_at = now()` a cada repeticao
-- reescreveria a data em que a plataforma parou de pagar o fornecedor — o fato
-- financeiro do encerramento — por causa de uma aba desatualizada.
--
-- NAO SE RECUSA `ENDED -> ENDED`. A RPC se declara idempotente, e recusar
-- transformaria um retry legitimo (timeout de rede sobre chamada que de fato
-- completou) num 409 confuso sobre operacao que ja deu certo.
--
-- NAO REESCREVE A 104. Migration aplicada nao se reescreve.
--
-- NAO TOCA DADO DE NENHUMA ORGANIZACAO. Substitui uma funcao, reescreve um
-- comentario e reemite ACL. Zero DML.

begin;

-- Corpo IDENTICO ao da 104, exceto pelos dois `coalesce` marcados abaixo.
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
         -- Os TRES campos do ato de encerrar coalescem JUNTOS. Separa-los faria
         -- a linha descrever dois atos ao mesmo tempo.
         ended_at = coalesce(ended_at, now()),
         ended_by = coalesce(ended_by, p_actor),
         end_confirmation_note = coalesce(end_confirmation_note, p_note),
         -- Encerrada nao guarda vinculo de canal: libera o indice unico de
         -- channel_id para uma instancia futura no mesmo canal.
         channel_id = null,
         -- E o que faz o painel parar de anunciar "em curso" numa instancia
         -- encerrada. Mesmo que a 090 faz no ramo CLOSED_NO_REOPEN.
         current_cycle_started_on = null,
         current_cycle_due_on = null,
         -- `updated_by`/`updated_at` NAO coalescem, de proposito: eles descrevem
         -- a ultima escrita na linha, nao o ato de encerrar.
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
  'Marca a instancia ENDED, limpa a projecao de ciclo e FECHA o ciclo OPEN pela regra do vencimento (sem custo -> PENDING_REVIEW). Idempotente: a PRIMEIRA confirmacao vence em ended_at, ended_by e end_confirmation_note — repeticoes ficam no ledger whatsapp_instance_notes. Nao revalida a transicao — isso e da Edge Function.';

-- =====================================================================
-- ACL — CREATE FUNCTION concede EXECUTE a PUBLIC por padrao
-- =====================================================================
-- `create or replace` PRESERVA a ACL existente, entao reemitir e redundante no
-- banco atual. Fica assim mesmo: e idempotente, e mantem esta migration correta
-- num replay onde a funcao ainda nao exista.
revoke all on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  to service_role;

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. ACL (esperado: nenhuma entrada anon= ou authenticated=):
--   select proname, proacl from pg_proc where proname = 'confirm_whatsapp_instance_end';
--
-- 2. search_path fixado (esperado: search_path=public):
--   select proname, proconfig from pg_proc where proname = 'confirm_whatsapp_instance_end';
--
-- 3. Corpo com os tres coalesce (esperado: ended_at, ended_by e
--    end_confirmation_note todos dentro de coalesce):
--   select prosrc from pg_proc where proname = 'confirm_whatsapp_instance_end';
--
-- 4. Reaplicar a migration inteira nao muda nada (idempotencia): rodar de novo
--    e repetir os itens 1 a 3.
--
-- 5. COMPORTAMENTO, nao estrutura — caso END-4 em
--    supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql, com o CONTROLE-5
--    do 06.
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Reaplicar a 104 restaura a versao anterior da funcao. Nenhum dado precisa ser
-- desfeito: esta migration nao escreve linha nenhuma.
