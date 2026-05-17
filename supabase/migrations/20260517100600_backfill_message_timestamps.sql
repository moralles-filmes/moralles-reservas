-- Migration 058: Backfill de timestamps faltantes em conversations.messages.
--
-- A UI de Conversas (/g/:unitSlug/conversas) agrupa mensagens por dia usando
-- elem.timestamp. Mensagens históricas criadas antes do campo virar obrigatório
-- (hoje os 3 writers — webhook-whatsapp, _shared/conversation-log,
-- send-manual-message — sempre incluem timestamp) caem num divisor "Sem data".
--
-- Estratégia: pra cada conversation que tem ao menos uma mensagem com timestamp
-- inválido (null, vazio, ou unparseable), reagrega o array preenchendo os
-- faltantes com conversations.created_at. É a melhor aproximação disponível —
-- não temos sinal mais granular por mensagem.
--
-- Idempotente: rodar 2x não muda nada na segunda execução porque o filtro
-- WHERE EXISTS exclui rows já saneadas.
--
-- Observações:
--   * Dispara trigger conversations_updated_at → updated_at vai pra now().
--     Aceitável: backfill é evento único.
--   * Não recalcula last_message_at (esse campo é populado a cada nova msg).
--   * Função auxiliar criada em pg_temp — some no fim da sessão.
--   * Cada mensagem corrigida ganha flag "timestamp_backfilled": true pra rastro
--     auditável (UI ignora; consultas futuras podem identificar).

create or replace function pg_temp.is_valid_iso_ts(v text)
returns boolean language plpgsql immutable as $$
begin
  if v is null or btrim(v) = '' then
    return false;
  end if;
  perform v::timestamptz;
  return true;
exception when others then
  return false;
end;
$$;

update public.conversations c
set messages = (
  select jsonb_agg(
    case
      when pg_temp.is_valid_iso_ts(elem->>'timestamp') then elem
      else elem || jsonb_build_object(
        'timestamp', to_jsonb(c.created_at),
        'timestamp_backfilled', true
      )
    end
  )
  from jsonb_array_elements(c.messages) elem
)
where jsonb_array_length(c.messages) > 0
  and exists (
    select 1
    from jsonb_array_elements(c.messages) e
    where not pg_temp.is_valid_iso_ts(e->>'timestamp')
  );
