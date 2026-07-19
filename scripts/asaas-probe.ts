// scripts/asaas-probe.ts
// Sonda DESCARTÁVEL do sandbox Asaas. Responde as 5 pendências do §13 de
// docs/billing-asaas/03-ASAAS-API-VERIFICADO.md antes de a Fase 4a assumir
// qualquer uma delas. NÃO é código de produção e não deve ser importado.
//
// Uso:
//   supabase secrets list   # confirmar que ASAAS_API_KEY não é hash de vazio
//   ASAAS_ENV=sandbox ASAAS_API_KEY='$aact_hmlg_...' npx deno@2.1.4 run \
//     --allow-net --allow-env scripts/asaas-probe.ts
//
// A chave começa com "$": SEMPRE entre aspas simples, senão o shell expande
// pra vazio e a sonda falha com 401 sem explicar por quê.

const BASE = Deno.env.get("ASAAS_BASE_URL") ?? "https://api-sandbox.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY") ?? "";

if (!KEY) {
  console.error("ASAAS_API_KEY ausente. Use aspas simples: ASAAS_API_KEY='$aact_hmlg_...'");
  Deno.exit(1);
}
if (!KEY.startsWith("$aact_")) {
  console.error("ASAAS_API_KEY não começa com $aact_ — o shell provavelmente expandiu a variável.");
  Deno.exit(1);
}

async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      access_token: KEY,
      "Content-Type": "application/json",
      "User-Agent": "moralles-reservas-probe",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function show(label: string, result: unknown) {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(result, null, 2));
}

// CPF de teste gerado (4Devs). O sandbox valida o formato/dígito.
const CPF_TESTE = "52998224725";

// ---- 0. Cliente base (todas as outras sondas dependem dele) ----
const customer = await call("/customers", "POST", {
  name: "Sonda Fase 4a",
  cpfCnpj: CPF_TESTE,
  email: "sonda-fase4a@example.com",
  externalReference: "probe-fase-4a",
});
show("0. POST /customers", customer);

const customerId = (customer.data as { id?: string })?.id;
if (!customerId) {
  console.error("Sem customerId — as demais sondas dependem dele. Abortando.");
  Deno.exit(1);
}

// ---- 1. imageBase64 é obrigatório em items[]? ----
// O OpenAPI lista como required; o AsaasBillingProvider NÃO manda. Se for
// mesmo obrigatório, billing-provider.ts precisa mudar antes da Task 7.
show("1a. POST /checkouts SEM imageBase64", await call("/checkouts", "POST", {
  billingTypes: ["CREDIT_CARD", "PIX"],
  chargeTypes: ["DETACHED"],
  callback: { successUrl: "https://example.com/ok", cancelUrl: "https://example.com/no" },
  items: [{ name: "Sonda sem imagem", quantity: 1, value: 19.90 }],
  externalReference: "probe-no-image",
}));

// PNG 1x1 transparente — menor imagem válida possível.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

show("1b. POST /checkouts COM imageBase64", await call("/checkouts", "POST", {
  billingTypes: ["CREDIT_CARD", "PIX"],
  chargeTypes: ["DETACHED"],
  callback: { successUrl: "https://example.com/ok", cancelUrl: "https://example.com/no" },
  items: [{ name: "Sonda com imagem", quantity: 1, value: 19.90, imageBase64: PNG_1PX }],
  externalReference: "probe-with-image",
}));

// ---- 2. items[].value aceita decimal? ----
// Se 19.90 voltar como 19.9 no eco, é reais. Se voltar 1990, é centavos e o
// invariante monetário inteiro está errado.
show("2. Checkout RECURRENT com value decimal", await call("/checkouts", "POST", {
  billingTypes: ["CREDIT_CARD", "PIX"],
  chargeTypes: ["RECURRENT"],
  callback: { successUrl: "https://example.com/ok", cancelUrl: "https://example.com/no" },
  items: [{ name: "Sonda recorrente", quantity: 1, value: 19.90, imageBase64: PNG_1PX }],
  subscription: { cycle: "MONTHLY" },
  externalReference: "probe-recurrent",
}));

// ---- 3. PUT {status:"INACTIVE"} preserva as cobranças emitidas? ----
const sub = await call("/subscriptions", "POST", {
  customer: customerId,
  billingType: "UNDEFINED",
  value: 19.90,
  nextDueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  cycle: "MONTHLY",
  description: "Sonda assinatura",
  externalReference: "probe-sub",
});
show("3a. POST /subscriptions", sub);

const subId = (sub.data as { id?: string })?.id;
if (subId) {
  show("3b. GET /subscriptions/{id}/payments ANTES", await call(`/subscriptions/${subId}/payments`));
  show("3c. PUT status INACTIVE", await call(`/subscriptions/${subId}`, "PUT", { status: "INACTIVE" }));
  show("3d. GET /subscriptions/{id} DEPOIS", await call(`/subscriptions/${subId}`));
  show("3e. GET /subscriptions/{id}/payments DEPOIS", await call(`/subscriptions/${subId}/payments`));
}

// ---- 4. Shape de um payment (o que o webhook vai receber) ----
const pay = await call("/payments", "POST", {
  customer: customerId,
  billingType: "PIX",
  value: 19.90,
  dueDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
  description: "Sonda payment",
  externalReference: "org:probe|plan:probe|purpose:subscription",
});
show("4a. POST /payments", pay);

const payId = (pay.data as { id?: string })?.id;
if (payId) {
  show("4b. GET /payments/{id} (shape completo)", await call(`/payments/${payId}`));
}

console.log(`
=========================================================
PRÓXIMO PASSO MANUAL (responde a pendência 2 e 5 do §13):
1. Abra o painel sandbox, ache a cobrança "Sonda payment".
2. Clique em CONFIRMAR PAGAMENTO (anote o rótulo exato do botão).
3. Vá em Integrações -> Logs de Webhooks e copie o PAYLOAD INTEIRO
   dos eventos disparados. É isso que prova se PAYMENT_* traz o
   objeto completo ou só {object, id}.
=========================================================
`);
