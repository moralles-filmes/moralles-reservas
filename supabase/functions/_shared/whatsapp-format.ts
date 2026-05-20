// Converte saída padrão de LLM (markdown) pro formato suportado pelo WhatsApp.
//
// WhatsApp suporta apenas: *bold* (1 asterisco), _italic_, ~strike~, ```mono```
// WhatsApp NÃO interpreta: **bold** (2 asteriscos), # header, [text](url), tabelas.
//
// A ordem das regras importa — bold-italic antes de bold, bold antes de
// "* " de lista, bloco de código antes de inline.
export function sanitizeForWhatsApp(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Bloco de código ```...``` → conteúdo cru (sem cercas)
  out = out.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1");

  // 2. Bold-italic ***x*** → *_x_* (precisa vir ANTES de **x**)
  out = out.replace(/\*\*\*([^*\n]+?)\*\*\*/g, "*_$1_*");

  // 3. Bold markdown **x** → *x*
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");

  // 4. Itálico alternativo __x__ → _x_
  out = out.replace(/__([^_\n]+?)__/g, "_$1_");

  // 5. Headers # / ## / ... → *text*
  out = out.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, "*$1*");

  // 6. Lista com "* " ou "+ " no começo de linha → "- "
  //    WhatsApp renderiza "* " solto como asterisco literal.
  out = out.replace(/^(\s*)[*+]\s+/gm, "$1- ");

  // 7. Code inline `x` → x  (sem backticks)
  out = out.replace(/`([^`\n]+)`/g, "$1");

  // 8. Links markdown [text](http://url) → text (http://url)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");

  // 9. Normaliza 3+ quebras de linha pra exatamente duas
  out = out.replace(/\n{3,}/g, "\n\n");

  return out;
}
