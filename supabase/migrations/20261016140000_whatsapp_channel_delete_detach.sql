-- Remoção de canal WhatsApp sem estourar o statement_timeout do PostgREST.
--
-- O DEFEITO: `webhook_executions.channel_id` e `notifications_sent.whatsapp_channel_id`
-- referenciam `whatsapp_channels` com `on delete set null`. O `DELETE` do canal
-- em `manage-channels` faz o Postgres reescrever TODAS as linhas que apontam
-- para ele num único comando — e o papel `authenticator` do PostgREST corta em
-- 8 s (`statement_timeout=8s`), inclusive para o service role. Um canal Z-API
-- com 49 mil execuções registradas não podia mais ser removido: 57014, sempre.
--
-- A CORREÇÃO tem duas metades:
--   1. esta RPC desvincula as referências em LOTES pequenos, cada chamada um
--      comando curto; a Edge Function chama em laço e só então apaga o canal,
--      quando o `set null` da FK já não tem quase nada a fazer;
--   2. a migration seguinte agenda a retenção de 30 dias do `webhook_executions`
--      (`cleanup_webhook_executions()`, criada na 026 e nunca agendada), que
--      mantém o volume por canal limitado. A purga sozinha NÃO basta: um canal
--      movimentado acumula dezenas de milhares de linhas dentro de 30 dias.
--
-- Semântica idêntica à FK: a RPC faz exatamente o `set null` que o DELETE faria,
-- só que dividido. Nenhuma linha é apagada aqui.
--
-- `whatsapp_instance_alerts.channel_id` fica com a FK: o volume é de unidades de
-- linha e a coerção do `set null` passa pela trigger de guarda da 089, que esta
-- RPC não deve contornar.
--
-- RESIDUAL CONHECIDO: o DELETE do canal ainda dispara `on delete cascade` em
-- `whatsapp_inbound_events` (111). Com a ingestão assíncrona OFF (padrão) a fila
-- fica vazia; um canal com ela ligada e backlog grande pode voltar a estourar o
-- timeout na remoção — a EF falha fechado com 500 e nada se perde.
--
-- ATOMICIDADE: cada lote commita sozinho. Se a remoção falhar depois de lotes já
-- aplicados, o canal segue existindo com parte do histórico desvinculado — o
-- mesmo estado final que o DELETE produziria para essas linhas. Por isso as
-- notificações recentes sem recibo ficam fora (ver o corpo).

create index if not exists idx_webhook_executions_channel
  on public.webhook_executions (channel_id)
  where channel_id is not null;

create index if not exists idx_notifications_sent_whatsapp_channel
  on public.notifications_sent (whatsapp_channel_id)
  where whatsapp_channel_id is not null;

create or replace function public.detach_whatsapp_channel_references(
  p_channel_id uuid,
  p_unit_id uuid,
  p_limit integer default 2000
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 10000);
  v_we integer := 0;
  v_ns integer := 0;
begin
  if p_channel_id is null or p_unit_id is null then
    raise exception 'channel_id e unit_id são obrigatórios' using errcode = '22023';
  end if;

  -- Tenant resolvido pelo PRÓPRIO recurso: o canal tem de ser da unidade
  -- informada. Canal inexistente ou alheio devolve 0 e nada é tocado — o
  -- DELETE seguinte da Edge Function, escopado pelo mesmo unit_id, também não
  -- casa nada, preservando a idempotência que a ação `delete` já tinha.
  if not exists (
    select 1 from public.whatsapp_channels
     where id = p_channel_id and unit_id = p_unit_id
  ) then
    return 0;
  end if;

  update public.webhook_executions w
     set channel_id = null
   where w.id in (
     select id from public.webhook_executions
      where channel_id = p_channel_id
      limit v_limit
   );
  get diagnostics v_we = row_count;

  -- Notificação ainda sem recibo e recente fica para o `set null` da FK, no
  -- DELETE: cada lote commita sozinho, e se a remoção falhar no meio o canal
  -- segue vivo — o callback de entrega correlaciona por
  -- (unit_id, provider, channel_id, provider_message_id), e desvinculá-la cedo
  -- deixaria o envio "sem entrega" no painel Entregas, convidando reenvio.
  if v_we < v_limit then
    update public.notifications_sent n
       set whatsapp_channel_id = null
     where n.id in (
       select id from public.notifications_sent
        where whatsapp_channel_id = p_channel_id
          and not (
            delivered_at is null
            and failed_at is null
            and sent_at > now() - interval '24 hours'
          )
        limit v_limit - v_we
     );
    get diagnostics v_ns = row_count;
  end if;

  return v_we + v_ns;
end;
$$;

revoke all on function public.detach_whatsapp_channel_references(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.detach_whatsapp_channel_references(uuid, uuid, integer)
  to service_role;

comment on function public.detach_whatsapp_channel_references(uuid, uuid, integer) is
  'Desvincula (set null) até p_limit referências de webhook_executions/notifications_sent '
  'ao canal, se ele pertencer a p_unit_id. Devolve quantas linhas mudou; 0 significa '
  'que acabou. Notificações das últimas 24 h sem recibo ficam para a FK. Chamada em '
  'laço por manage-channels:delete antes do DELETE do canal, para que o set null da '
  'FK não estoure o statement_timeout.';

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
--   select has_function_privilege('anon', 'public.detach_whatsapp_channel_references(uuid,uuid,integer)', 'execute');          -- false
--   select has_function_privilege('authenticated', 'public.detach_whatsapp_channel_references(uuid,uuid,integer)', 'execute'); -- false
--   select has_function_privilege('service_role', 'public.detach_whatsapp_channel_references(uuid,uuid,integer)', 'execute');  -- true
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Reimplantar a versão anterior de manage-channels ANTES de dropar a função,
-- senão o delete recusa com 500 (a EF falha fechado sem a RPC):
--   drop function if exists public.detach_whatsapp_channel_references(uuid, uuid, integer);
--   drop index if exists public.idx_webhook_executions_channel;
--   drop index if exists public.idx_notifications_sent_whatsapp_channel;
