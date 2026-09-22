// Extrai o código de reserva de texto colado/digitado pelo cliente no lookup
// público (ReservaCodeLookup.tsx).
//
// Todo template que o sistema manda emite `#{code}`: hardcoded em
// send-confirmation, send-cancellation, webhook-whatsapp, WizardSuccess,
// AcompanharReserva — E o lembrete D-0 (process-reservation-reminders), que
// usa `reservation_message_templates.body`, TEXTO LIVRE editado pelo lojista
// no painel (useReservationTemplates.ts, até 600 chars, "{{codigo}}"
// inserível em qualquer posição). `reservation_code` nunca contém "#" e tem
// sempre exatamente 8 caracteres (confirmado contra produção:
// min(length) = max(length) = 8).
//
// (`src/lib/zapi.ts` NÃO é o que a produção envia — zero imports em
// supabase/functions/. É código morto pra esse fim; serviu de proxy nos
// testes da round 2 só porque tem a mesma disposição do "#".)
//
// FIX ROUND 1 assumiu que o cliente cola só o código (com ou sem "#" na
// frente).
//
// FIX ROUND 2: o cliente pode colar a MENSAGEM INTEIRA (a DialogDescription
// diz "recebido no WhatsApp", e é isso que ele tem na tela). Ancorar no
// ÚLTIMO "#" resolveu esse caso.
//
// FIX ROUND 3, achado 1: texto livre do lojista pode ter MAIS de um "#" —
// ex.: uma hashtag de Instagram no corpo do lembrete (`#renSushiOficial`)
// depois do código. "Último #" (round 2) pega a hashtag, não o código.
//
// FIX ROUND 3, achado 2 (descoberto ao testar o achado 1 contra um <input>
// de verdade, não só a função isolada): um `<input type="text">` REMOVE
// quebras de linha do texto colado ANTES do onChange rodar — comportamento
// do HTML padrão (confirmado no jsdom, que segue o spec), sem inserir
// espaço no lugar. Colar a mensagem de confirmação/lembrete inteira (que TEM
// `\n\n` logo depois do código, inclusive no template DEFAULT do lembrete —
// não é preciso customização nenhuma) funde o código com a palavra seguinte:
// "...Código: #8GY6EG9X\n\nAcompanhe..." vira "...#8GY6EG9XACOMPANHE...".
// Se a regra exigisse comprimento EXATO 8 pra QUALQUER "#", esse candidato
// (agora com mais de 8 caracteres) seria descartado e a extração cairia no
// fallback sem âncora — reabrindo exatamente o defeito que a round 2
// existia pra fechar, e sem precisar de hashtag nenhuma: só de colar a
// mensagem padrão.
//
// Por isso a regra é em DUAS camadas:
//   1. Só um "#" no texto com algo alfanumérico depois: não há ambiguidade
//      sobre QUAL "#" é o código (só existe um) — usa os 8 primeiros
//      caracteres do que vier depois dele, mesmo que a colagem tenha fundido
//      lixo no final.
//   2. Dois ou mais "#" com conteúdo: aí sim compara o COMPRIMENTO de cada
//      sequência — só um candidato de comprimento EXATO 8 desambigua com
//      segurança (hashtag quase nunca cai em 8 por acaso). Zero ou mais de
//      um candidato de 8 cai no fallback sem âncora da round 1.
const CODE_LENGTH = 8;

export function extractReservationCode(raw: string): string {
  const upper = raw.toUpperCase();
  const runs = Array.from(upper.matchAll(/#([A-Z0-9]+)/g), (m) => m[1]);

  if (runs.length === 1) {
    return runs[0].slice(0, CODE_LENGTH);
  }

  if (runs.length > 1) {
    const exact = runs.filter((run) => run.length === CODE_LENGTH);
    if (exact.length === 1) {
      return exact[0];
    }
  }

  // Zero "#" com conteúdo, ou ambíguo mesmo com o filtro de comprimento:
  // fallback sem âncora da round 1 — remove não-alfanumérico do texto
  // inteiro e corta em 8. Cobre digitação tecla a tecla e colagem do código
  // puro sem decoração.
  return upper.replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
}
