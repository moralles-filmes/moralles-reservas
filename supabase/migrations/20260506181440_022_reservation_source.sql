-- Coluna `source` em reservations distingue a origem da reserva e controla
-- quais notificações automáticas disparam.
--
-- - 'web' (default) — criada pelo site/portal público OU pelo painel de gestão.
--                     Trigger send-confirmation-on-reservation dispara normalmente.
-- - 'whatsapp'      — criada pelo agente IA via WhatsApp. O agente já confirma
--                     conversacionalmente, então o trigger NÃO dispara para
--                     evitar mensagem redundante.

alter table reservations
  add column if not exists source text not null default 'web'
    check (source in ('web', 'whatsapp'));

create index if not exists reservations_source_idx
  on reservations(source);

-- Recria o trigger com filtro WHEN: só dispara para reservas que NÃO vieram do WhatsApp.
drop trigger if exists "send-confirmation-on-reservation" on reservations;

create trigger "send-confirmation-on-reservation"
  after insert on reservations
  for each row
  when (new.source <> 'whatsapp')
  execute function supabase_functions.http_request(
    'https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/send-confirmation',
    'POST',
    '{"Content-type":"application/json","X-Internal-Key":"0de32cb5b367bb442ee4b374491c63499b1996c4e1e08c48d62d9eb15d855de2"}',
    '{}',
    '5000'
  );
