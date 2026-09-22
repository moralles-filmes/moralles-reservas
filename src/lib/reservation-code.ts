// Extrai o código de reserva de texto colado/digitado pelo cliente no lookup
// público (ReservaCodeLookup.tsx).
//
// Todo template que o sistema manda emite `#{code}` — zapi.ts (confirmação,
// lembrete, cancelamento), send-confirmation, send-cancellation,
// webhook-whatsapp, WizardSuccess, AcompanharReserva. `reservation_code`
// nunca contém "#", então a cerquilha é o âncora confiável.
//
// FIX ROUND 1 assumiu que o cliente cola só o código (com ou sem "#" na
// frente). Round 2: a DialogDescription deste componente diz "recebido no
// WhatsApp", e a mensagem que o sistema manda é exatamente isso que o
// cliente tem na tela — ele pode colar a MENSAGEM INTEIRA, não só o código.
// Sem ancorar no "#", o "código" extraído vira os primeiros 8 caracteres
// alfanuméricos da mensagem inteira ("RESERVAC", "CDIGO8GY" etc.) — passa no
// guard de tamanho, dispara a RPC, volta null, e produz a MESMA tela "não
// encontrada" que este hotfix existe pra matar.
const CODE_LENGTH = 8;

export function extractReservationCode(raw: string): string {
  const upper = raw.toUpperCase();
  const hashIndex = upper.lastIndexOf("#");

  if (hashIndex === -1) {
    // Sem "#": comportamento da round 1 — cobre digitação tecla a tecla e
    // colagem do código puro (sem a decoração de exibição).
    return upper.replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
  }

  // Com "#": pega só a PRIMEIRA sequência alfanumérica depois do ÚLTIMO "#" —
  // ignora tudo que vem depois (quebra de linha, resto da mensagem).
  const afterHash = upper.slice(hashIndex + 1);
  const match = afterHash.match(/[A-Z0-9]+/);
  return (match?.[0] ?? "").slice(0, CODE_LENGTH);
}
