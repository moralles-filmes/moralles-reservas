-- Adiciona coluna de comentário livre opcional em reservations.
-- Capturada pelo webhook-whatsapp via 2ª pergunta após nota D+1 (janela 30min):
-- ao receber a nota 1-5, o bot pergunta se o cliente quer comentar; a próxima
-- mensagem dentro da janela é gravada como satisfaction_comment.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS satisfaction_comment text NULL;

COMMENT ON COLUMN reservations.satisfaction_comment IS
  'Comentário livre opcional capturado pelo webhook-whatsapp após nota numérica D+1 (janela 30min).';
