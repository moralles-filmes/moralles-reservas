-- Vínculo chatLid ↔ conversa, aprendido do inbound do cliente.
--
-- Problema: com "Notificar as enviadas por mim também" ligado, a Z-API devolve
-- ao webhook as mensagens que SAEM do número da loja — é a única forma de o
-- sistema enxergar o que o atendente digita no celular. Mas nesse eco o campo
-- `phone` às vezes vem como LID do WhatsApp (15 dígitos) em vez do telefone,
-- e nenhum outro campo do payload traz o número do destinatário. Sem vínculo,
-- a mensagem do atendente não tem como ser pendurada na conversa certa.
--
-- Solução: o inbound do cliente traz `phone` REAL e `chatLid` no mesmo payload.
-- Guardamos o `chatLid` na conversa quando o cliente escreve, e o eco resolve
-- por ele quando o telefone não vier utilizável.
--
-- Fica em `conversations` (e não em `customers`) porque o LID é por conta de
-- WhatsApp, e a conversa já é escopada por unidade.

alter table public.conversations
  add column if not exists wa_chat_lid text;

-- Um LID aponta pra no máximo uma conversa por unidade. Índice PARCIAL: a
-- coluna fica NULL até o cliente escrever, então a maioria das linhas não entra.
create unique index if not exists conversations_unit_wa_chat_lid_idx
  on public.conversations (unit_id, wa_chat_lid)
  where wa_chat_lid is not null;

comment on column public.conversations.wa_chat_lid is
  'LID do chat no WhatsApp (campo `chatLid` da Z-API), aprendido do inbound do cliente. Resolve o eco de mensagem enviada pela loja quando o payload não traz telefone utilizável.';
