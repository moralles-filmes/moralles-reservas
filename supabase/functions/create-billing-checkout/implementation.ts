// Ramo do purpose=implementation: cobrança avulsa da implantação de WhatsApp
// (R$750). Stub — a Task 10 substitui o corpo. A assinatura já é a final para
// que index.ts não precise mudar de novo quando a Task 10 chegar.
import type { CheckoutContext } from "./context.ts";
import type { HandlerResult } from "./subscription.ts";

// deno-lint-ignore require-await
export async function handleImplementation(_ctx: CheckoutContext): Promise<HandlerResult> {
  return { status: 503, body: { error: "Fluxo indisponível." } };
}
