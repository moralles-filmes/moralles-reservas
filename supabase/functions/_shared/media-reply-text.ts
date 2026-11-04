import { INBOUND_DEBOUNCE_WINDOW_MS } from "./whatsapp-inbound-queue-core.ts";

/**
 * Resposta fixa a mensagem que não é texto (áudio, imagem, figurinha, anexo do
 * Direct). Uma constante para os dois canais: `webhook-whatsapp` e
 * `process-instagram-inbound` respondem igual, e o texto não passa por
 * sanitização (não é saída de LLM). Mudar o valor regrava a paridade do
 * WhatsApp (`agent-turn-parity.test.ts`).
 */
export const MEDIA_REPLY_TEXT =
  "Por aqui só consigo ler texto. Pode me escrever a informação que precisa? Se quiser falar com a equipe, é só pedir.";

/** Janela da rajada de mídia, em segundos (RPC `record_conversation_media`). */
export const MEDIA_BURST_SECONDS = 60;
/** Folga sobre o debounce do inbound: derivada, nunca redigitada. */
export const MEDIA_DEBOUNCE_GRACE_SECONDS = INBOUND_DEBOUNCE_WINDOW_MS / 1000 + 5;
/** Idade máxima de mídia adiada elegível ao aviso (`p_since` do claim). */
export const MEDIA_NOTICE_MAX_AGE_SECONDS = 120;

const MEDIA_KIND_WORD: Readonly<Record<string, string>> = {
  image: "sua foto",
  audio: "seu áudio",
  video: "seu vídeo",
  document: "seu documento",
  sticker: "sua figurinha",
  location: "sua localização",
  contacts: "seu contato",
};
const MEDIA_FALLBACK_WORD = "seu arquivo";

const noticeWith = (word: string) =>
  `Recebi também ${word}, mas por aqui só consigo ler texto. Se tiver mais alguma dúvida, é só me escrever.`;

/**
 * Aviso variante: o cliente mandou texto + mídia na mesma rajada e a IA já
 * respondeu ao texto. Um tipo conhecido → palavra dele; vazio, desconhecido ou
 * mais de um tipo distinto → "seu arquivo". Não passa por sanitização.
 */
export function mediaNoticeText(kinds: readonly string[]): string {
  const distinct = [...new Set(kinds)];
  const word = distinct.length === 1 ? MEDIA_KIND_WORD[distinct[0]] : undefined;
  return noticeWith(word ?? MEDIA_FALLBACK_WORD);
}

export const MEDIA_NOTICE_TEXTS: readonly string[] = [
  ...Object.values(MEDIA_KIND_WORD),
  MEDIA_FALLBACK_WORD,
].map(noticeWith);
