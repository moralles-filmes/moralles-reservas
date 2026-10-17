-- Instancias de WhatsApp: exclusao de instancia ENCERRADA e SEM CUSTO.
--
-- Spec: docs/superpowers/specs/2026-10-15-instancias-encerradas-aba-e-exclusao-design.md
--
-- Duas mudancas, uma transacao:
--   1. o ledger `whatsapp_instance_notes` ganha a NONA acao, `DELETE`. Fonte
--      canonica: INSTANCE_NOTE_ACTIONS em _shared/whatsapp-instance-notes-core.ts;
--      src/lib/whatsapp-instance-notes-core.test.ts le o CHECK EFETIVO (o do
--      ultimo arquivo que o redefine) e confere as duas direcoes.
--   2. a RPC `delete_whatsapp_instance_without_cost`, UNICA porta que apaga uma
--      instancia. Apagar com custo destruiria a margem historica: os ciclos
--      saem em cascata (088). Por isso a regra mora AQUI, sob lock, e nao na
--      Edge Function nem na tela.
--
-- Regra: so apaga instancia ENCERRADA que NUNCA teve custo (nem atual, nem em
-- ciclo, nem no historico da instancia em `audit_log`: `set_cost` aceita
-- "desconhecido" em qualquer estado, entao anular o custo e apagar esconderia
-- custo real) e SEM alerta aberto (um alerta de divergencia aberto, como
-- ALIVE_AFTER_END, e o unico sinal de que o fornecedor ainda cobra; e alerta
-- aberto de instancia apagada ficaria orfao contando como aberto para sempre).
-- O ator e obrigatorio.
--
-- O que sobrevive a exclusao: as notas e os alertas ficam com `instance_id`
-- nulo por `on delete set null` (096/089) e guardam `instance_ref`/`subject_id`;
-- o trigger de auditoria da 087 grava a linha apagada em `audit_log`. Os ciclos
-- nao tem trigger de auditoria: a RPC grava um retrato de cada um em
-- `audit_log` (table_name = 'whatsapp_instance_cycles') antes do delete. Esses
-- registros ficam invisiveis ao cliente (a policy de membro e por lista).
--
-- ORDEM DE APLICACAO: esta migration ANTES do deploy de
-- `manage-whatsapp-instances`. Sem ela a acao `delete_instance` responde 500;
-- `list_instances` nao depende dela.

begin;

alter table whatsapp_instance_notes
  drop constraint if exists whatsapp_instance_notes_action_check;

alter table whatsapp_instance_notes
  add constraint whatsapp_instance_notes_action_check check (action in (
    'REGISTER', 'UPDATE', 'REACTIVATE', 'SET_COST',
    'CONFIRM_CYCLE_DATE', 'REQUEST_CANCELLATION', 'CONFIRM_END',
    'CORRECT_CYCLE_COST', 'DELETE'
  ));

create or replace function public.delete_whatsapp_instance_without_cost(
  p_instance_id uuid,
  p_note text,
  p_actor uuid
)
returns table (outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
begin
  -- O motivo vai para o ledger, que recusa nota vazia; recusar aqui antes de
  -- qualquer lock deixa o erro dizer o que de fato faltou.
  if p_note is null or btrim(p_note) = '' then
    raise exception 'motivo obrigatorio para apagar instancia'
      using errcode = 'check_violation';
  end if;

  -- O ator vai para a nota e para o retrato dos ciclos; sem ele a exclusao nao
  -- teria autoria. A Edge Function sempre passa o id do JWT.
  if p_actor is null then
    raise exception 'ator obrigatorio para apagar instancia'
      using errcode = 'check_violation';
  end if;

  select id, organization_id, unit_id, lifecycle_state, current_monthly_cost_cents
    into v_inst
    from whatsapp_instances
   where id = p_instance_id
   for update;
  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  -- Mesma ordem de lock de confirm_whatsapp_instance_end: instancia -> ciclos.
  -- Travar os ciclos impede que um custo gravado em paralelo num ciclo escape
  -- da conferencia abaixo.
  perform 1 from whatsapp_instance_cycles where instance_id = p_instance_id for update;

  if v_inst.lifecycle_state <> 'ENDED' then
    return query select 'not_ended'::text;
    return;
  end if;

  if v_inst.current_monthly_cost_cents is not null
     or exists (
       select 1 from whatsapp_instance_cycles
        where instance_id = p_instance_id
          and provider_cost_cents is not null
     ) then
    return query select 'has_cost'::text;
    return;
  end if;

  -- Custo que ja existiu e foi anulado depois ainda e custo: o trigger da 087
  -- guarda cada versao da linha em audit_log (record_id e o id em texto).
  if exists (
    select 1 from audit_log
     where table_name = 'whatsapp_instances'
       and record_id = p_instance_id::text
       and ((old_values->>'current_monthly_cost_cents') is not null
            or (new_values->>'current_monthly_cost_cents') is not null)
  ) then
    return query select 'has_cost'::text;
    return;
  end if;

  if exists (
    select 1 from whatsapp_instance_alerts
     where instance_id = p_instance_id
       and status in ('OPEN', 'ACKNOWLEDGED')
  ) then
    return query select 'open_alerts'::text;
    return;
  end if;

  -- Os ciclos saem em cascata e nao tem trigger de auditoria: sem este retrato
  -- sumiriam sem rastro.
  insert into audit_log
    (table_name, record_id, action, old_values, actor_id, unit_id, organization_id)
  select 'whatsapp_instance_cycles', c.id::text, 'DELETE', to_jsonb(c), p_actor,
         v_inst.unit_id, c.organization_id
    from whatsapp_instance_cycles c
   where c.instance_id = p_instance_id;

  -- A nota nasce ANTES do delete, apontando a instancia viva (a trigger da
  -- 096 exige); o delete a deixa com instance_id nulo e instance_ref intacto.
  insert into whatsapp_instance_notes
    (instance_ref, instance_id, organization_id, action, note, created_by)
  values
    (p_instance_id, p_instance_id, v_inst.organization_id, 'DELETE', p_note, p_actor);

  delete from whatsapp_instances where id = p_instance_id;

  return query select 'deleted'::text;
end;
$$;

comment on function public.delete_whatsapp_instance_without_cost(uuid, text, uuid) is
  'Unica porta de exclusao de instancia: so ENDED, sem custo (atual, em ciclo ou no historico em audit_log) e sem alerta aberto; ator obrigatorio. Trava instancia e ciclos, grava retrato dos ciclos em audit_log e nota DELETE, e apaga; ciclos saem em cascata, notas e alertas ficam com instance_id nulo. Devolve deleted | not_found | not_ended | has_cost | open_alerts.';

revoke all on function public.delete_whatsapp_instance_without_cost(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.delete_whatsapp_instance_without_cost(uuid, text, uuid) to service_role;

commit;

-- Validacao pos-migration:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'whatsapp_instance_notes_action_check';   -- contem 'DELETE'
--   select proacl from pg_proc where proname = 'delete_whatsapp_instance_without_cost';
--     -- esperado: so postgres e service_role, sem anon=, authenticated= ou =X/
--
-- Rollback (so comentario; nada aqui e executavel):
--   O rollback real e UM comando:
--     drop function if exists public.delete_whatsapp_instance_without_cost(uuid, text, uuid);
--   O CHECK de nove acoes FICA. Depois que existir nota com action = 'DELETE',
--   recriar o CHECK de oito acoes falha na validacao das linhas existentes, e
--   as notas DELETE sao auditoria: nao se apagam para destravar um rollback.
--   O DELETE de instancia ja feito e irreversivel por desenho (ciclos saem em
--   cascata; so notas e alertas sobrevivem, com instance_id nulo).
