/**
 * Resposta fixa a mensagem que não é texto (áudio, imagem, figurinha, anexo do
 * Direct). Uma constante para os dois canais: `webhook-whatsapp` e
 * `process-instagram-inbound` respondem igual, e o texto não passa por
 * sanitização (não é saída de LLM). Mudar o valor regrava a paridade do
 * WhatsApp (`agent-turn-parity.test.ts`).
 */
export const MEDIA_REPLY_TEXT =
  "Por aqui só consigo ler texto. Pode me escrever a informação que precisa? Se quiser falar com a equipe, é só pedir.";
