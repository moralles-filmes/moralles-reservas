-- Coluna `source` em reservations distingue a origem da reserva e controla
-- quais notificações automáticas disparam.
--
-- - 'web' (default) — criada pelo site/portal público OU pelo painel de gestão.
--                     Gera confirmação automática.
-- - 'whatsapp'      — criada pelo agente IA via WhatsApp. O agente já confirma
--                     conversacionalmente, então NÃO gera confirmação
--                     automática, para evitar mensagem redundante.

alter table reservations
  add column if not exists source text not null default 'web'
    check (source in ('web', 'whatsapp'));

create index if not exists reservations_source_idx
  on reservations(source);

-- O trigger `send-confirmation-on-reservation` que ficava AQUI foi REMOVIDO
-- deste arquivo por saneamento de incidente: ele embutia a `INTERNAL_API_KEY`
-- em texto claro no header, e a URL do projeto de produção.
--
-- A remoção é equivalente em replay: a migration seguinte (028) dropa esse
-- mesmo trigger e substitui o envio direto pelo padrão outbox
-- (`enqueue_confirmation_notification` + `notification_outbox`). Ou seja, o
-- trigger só existia entre 022 e 028 — nada depende dele.
--
-- Regra que fica: migration NUNCA embute segredo. Chamada autenticada a Edge
-- Function lê `internal_api_key` do Vault dentro de um wrapper
-- `security definer`, como fazem os wrappers de pg_cron.
--
-- A chave que estava aqui foi ROTACIONADA nos dois lugares (secrets das Edge
-- Functions e Vault) antes desta edição. O valor antigo segue no histórico do
-- git e é irrecuperável de lá — por isso a rotação vem primeiro, e a remoção
-- do arquivo depois. Ver docs/INCIDENTE-2026-08-02-INTERNAL-API-KEY.md.

drop trigger if exists "send-confirmation-on-reservation" on reservations;
