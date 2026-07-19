# Fase 4a — Assinatura do sistema via Asaas: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o dinheiro entrar e o acesso ligar — uma org paga R$ 449 via Asaas e sai com `billing_status='active'`, ativada pelo webhook e nunca pela URL de retorno.

**Architecture:** A camada multi-provider já existe e está órfã (`BillingProviderPort` + `AsaasBillingProvider`, 8 métodos, zero importadores). Esta fase **pluga** essa porta: um módulo compartilhado com núcleo puro (`_shared/asaas-billing-events.ts`) decide o efeito de cada evento; webhook e worker de reconcile executam o **mesmo** aplicador; o checkout roteia por flag lida server-side.

**Tech Stack:** Deno (Edge Functions), Supabase (Postgres + RLS), React 18 + Vite + TypeScript, TanStack Query, React Hook Form + Zod, Vitest, Tailwind + shadcn/ui.

**Spec:** [docs/superpowers/specs/2026-07-19-billing-asaas-fase-4a-design.md](../specs/2026-07-19-billing-asaas-fase-4a-design.md)
**Fonte de verdade da API Asaas:** [docs/billing-asaas/03-ASAAS-API-VERIFICADO.md](../../billing-asaas/03-ASAAS-API-VERIFICADO.md)

---

## Global Constraints

Estas valem para **todas** as tasks. Violar qualquer uma é regressão, não escolha de estilo.

**Dinheiro**
- `amount_cents` é **centavos inteiros** em todo o nosso código. O Asaas fala **reais decimais**. Converter só na fronteira do provider: `centsToAsaasValue` saindo, `asaasValueToCents` voltando. Mandar `44900` cobra **R$ 44.900,00**.
- `getPayment`/`getSubscription` da porta devolvem **payload cru** — no Asaas isso é **reais**; na Stripe, centavos. O tipo é `ProviderResult<Record<string, unknown>>` e **não protege nada**. Todo leitor desses campos chama `asaasValueToCents` antes de comparar.
- Valores **sempre do banco** (`billing_plans.amount_cents`), nunca do request nem do payload do webhook.

**Retry / idempotência**
- Asaas **não tem `Idempotency-Key`**. Mutação (POST/PUT/DELETE) só repete em **429**; nunca em 5xx, nunca em erro de rede.
- O `fetch` das mutações em `_shared/asaas.ts` é **deliberadamente não-capturado** para propagar erro de rede em vez de repetir. **Não envolver em try/catch. Não rotear por `_shared/retry.ts`.** Ambos duplicam cobrança real.

**Webhook**
- O Asaas só considera **HTTP 200** como sucesso. 201/204 contam como falha; 15 falhas consecutivas interrompem a fila; eventos ficam 14 dias e são apagados permanentemente.
- Régua imutável: `200` = a linha está durável **ou** foi descartada de propósito. **Falha de negócio é 200** com `processing_status='failed'`. Não-`200` (503) só para falha de **persistência**.
- `billing_events.provider_event_id` é string **opaca** com `&` literal (`evt_<hex>&<num>`). Nunca dar split, nunca parsear como query string.

**Segurança**
- Repo público. Antes de todo commit: `git status` + revisar 100% das linhas. Nunca `git add .`/`-A`.
- Chave Asaas começa com `$` — em shell **sempre** entre aspas simples, senão vira string vazia em silêncio.
- Edge Functions nunca devolvem `error.message` cru do Postgres. Mensagem curta PT-BR; detalhe em `console.error`/`jsonLog`.
- EF nova ou alterada precisa de entrada `verify_jwt` no `config.toml` **no mesmo commit**.

**Nomes literais que o código usa** (errar aqui gera import que não resolve)
- Em `_shared/asaas.ts` **tudo é prefixado**: `createAsaasCustomer`, `getAsaasCustomer`, `updateAsaasCustomer`, `createAsaasPayment`, `getAsaasPayment`, `refundAsaasPayment`, `getAsaasPixQrCode`, `createAsaasSubscription`, `getAsaasSubscription`, `updateAsaasSubscription`, `deleteAsaasSubscription`, `createAsaasCheckout`, `asaasRequest`.
- Os nomes **sem** prefixo (`createCustomer`, `getPayment`, `createCheckout`) são métodos da **porta** em `_shared/billing-provider.ts`, obtidos via `getBillingProvider("asaas")`. São módulos diferentes com shapes diferentes.
- A interface se chama `BillingProviderPort`, **não** `BillingProvider`. `BillingProviderName` é o union `"stripe" | "asaas"`.
- O campo de URL do checkout Asaas é `link`; a porta o renomeia para `url`.

**Comandos do projeto**
- `npm run typecheck` = `tsc -b --noEmit`. **Nunca `tsc --noEmit` sem `-b`** (vira no-op silencioso).
- `npm install --legacy-peer-deps` (o `.npmrc` força).
- EFs não entram no `tsc -b` nem no eslint. A única tipagem delas é `npx deno@2.1.4 check <arquivo>`.
- Migrations: **sempre** `supabase db push`, nunca colar SQL no Studio (gera drift).

---

## File Structure

**Criar**
| Arquivo | Responsabilidade |
|---|---|
| `scripts/asaas-probe.ts` | Sonda descartável do sandbox. Responde as 5 pendências do §13. Não vai pra produção. |
| `supabase/functions/_shared/tax-id.ts` | Validação de CPF/CNPJ (backend, Deno). Puro. |
| `src/lib/tax-id.ts` | Validação de CPF/CNPJ (frontend) + formatação de máscara. Puro. |
| `src/lib/tax-id.test.ts` | Testa as duas cópias com o mesmo corpus e afirma que concordam. |
| `supabase/functions/_shared/asaas-billing-events.ts` | Núcleo puro (externalReference + `decideEventEffect`) e aplicador de I/O. |
| `src/lib/asaas-billing-events.test.ts` | Testes do núcleo puro, importado cross-boundary. |
| `supabase/migrations/20260719120000_066_activate_sistema_reservas.sql` | Liga o plano `sistema-reservas`. |

**Modificar**
| Arquivo | Mudança |
|---|---|
| `src/lib/validators/organization.ts` | + `tax_id`, `billing_email` no `createOrganizationSchema` |
| `src/pages/platform/Empresas.tsx` | + 2 `FormField` no `CreateOrgDialog` |
| `supabase/functions/manage-organizations/index.ts` | Valida os 2 campos; cria linha de `billing_customers` |
| `supabase/functions/create-billing-checkout/index.ts` | Roteia por `billing_provider_default`; caminho Asaas |
| `supabase/functions/asaas-webhook/index.ts` | Chama `applyAsaasEvent`; backfill de `organization_id` |
| `supabase/functions/process-asaas-reconcile/index.ts` | Usa `applyAsaasEvent`; consulta payments PENDING; alerta admin |
| `supabase/functions/manage-billing/index.ts` | + actions `get_org_entitlements` e `reprocess_billing_event` |
| `src/hooks/useBilling.ts` | Desempacota erro HTTP; + `useOrgEntitlements` |
| `src/pages/gestao/Cobranca.tsx` | `?session=cancel`; toast condicional; card de cortesia |
| `supabase/config.toml` | (só se surgir EF nova — nenhuma prevista) |
| `CLAUDE.md` | Invariantes novos + checklist de redeploy |

**Fronteira de import verificada:** o vitest resolve `../../supabase/functions/_shared/<mod>` a partir de `src/` (precedentes: `asaas-core.test.ts:22`, `entitlements-core.test.ts:6`). Isso vale **só para módulos puros** (sem `Deno.*`, sem import HTTP). `_shared/tax-id.ts` e o núcleo de `_shared/asaas-billing-events.ts` respeitam essa regra; o aplicador de I/O fica no mesmo arquivo mas **nunca é importado por `src/`**.

---

## Ordem e paralelismo

**Task 1 depende de você rodar a sonda com a chave sandbox.** As Tasks 2–5 não tocam a API do Asaas e podem ser feitas em paralelo à sonda. Da Task 6 em diante, as respostas da sonda são pré-requisito.

---

### Task 1: Sonda do sandbox

Não é TDD — é descoberta. O produto é fato documentado, e possivelmente uma correção em `billing-provider.ts`.

**Files:**
- Create: `scripts/asaas-probe.ts`
- Modify: `docs/billing-asaas/03-ASAAS-API-VERIFICADO.md` (§13 → respostas)
- Modify (condicional): `supabase/functions/_shared/billing-provider.ts`

**Interfaces:**
- Consumes: `_shared/asaas.ts` (`createAsaasCustomer`, `createAsaasCheckout`, `createAsaasSubscription`, `updateAsaasSubscription`, `getAsaasPayment`)
- Produces: fatos que as Tasks 6 e 7 assumem — shape de `PAYMENT_*`, obrigatoriedade de `imageBase64`, aceitação de decimal em `items[].value`, comportamento de `PUT {status:"INACTIVE"}`.

- [ ] **Step 1: Escrever a sonda**

```ts
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
```

- [ ] **Step 2: Rodar a sonda**

Rode você mesmo (a chave sandbox é sua e não deve chegar ao agente):

```bash
ASAAS_ENV=sandbox ASAAS_API_KEY='$aact_hmlg_SUACHAVE' npx deno@2.1.4 run --allow-net --allow-env scripts/asaas-probe.ts
```

Esperado: 6 blocos de saída JSON + a instrução final. Se sair `401 invalid_environment`, a chave é de produção — pare.
Se sair `401 invalid_access_token_format`, o shell comeu o `$` — repita com aspas simples.

- [ ] **Step 3: Fazer o passo manual no painel**

Confirmar o pagamento da "Sonda payment" no painel sandbox e copiar o payload inteiro dos eventos em Integrações → Logs de Webhooks.

- [ ] **Step 4: Registrar as respostas no doc 03**

Substituir a seção `## 13. Pendências pra validar no sandbox (Fase 2/4)` por `## 13. Pendências RESOLVIDAS (sonda de <data>)`, com a resposta de cada item e o **payload real colado**. Marcar `NÃO VERIFICADO` → verificado nos pontos §9 (`imageBase64`), §9.1 (`items[].value`) e §9 (`PUT INACTIVE`).

- [ ] **Step 5: Corrigir `billing-provider.ts` se a sonda exigir**

Só se a sonda 1a tiver falhado e a 1b passado. Nesse caso `imageBase64` é obrigatório e `asaasProvider.createCheckout` precisa mandá-lo. Adicionar no topo do arquivo:

```ts
// PNG 1x1 transparente. O Asaas exige `imageBase64` em items[] (verificado por
// sonda em <data> — §9 do doc 03). Não temos imagem por produto e o campo não
// aparece no checkout de forma relevante, então usamos o menor PNG válido.
const TRANSPARENT_1PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
```

e no `items[0]` de `createCheckout`:

```ts
        items: [
          {
            name: params.description.slice(0, 30),
            quantity: 1,
            value,
            description: params.description.slice(0, 150),
            imageBase64: TRANSPARENT_1PX_PNG,
          },
        ],
```

Se a sonda 2 revelar que o `subscription: { cycle: "MONTHLY" }` é rejeitado ou exige mais campos, corrigir o bloco `if (isSubscription)` conforme a resposta real e remover o comentário "validar no sandbox antes da Fase 4".

- [ ] **Step 6: Verificar tipagem**

Run: `npx deno@2.1.4 check supabase/functions/_shared/billing-provider.ts`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add docs/billing-asaas/03-ASAAS-API-VERIFICADO.md scripts/asaas-probe.ts
# adicionar billing-provider.ts SÓ se o Step 5 foi necessário
git commit -m "docs(billing): resolve as 5 pendencias do sandbox Asaas por sonda"
```

> ⚠️ **Antes do commit:** confirmar que nenhum output colado no doc 03 contém a chave de API, e-mail real ou id de conta. Payload de sandbox é seguro; chave não.

---

### Task 2: Validação de CPF/CNPJ com sincronia testada

**Files:**
- Create: `supabase/functions/_shared/tax-id.ts`
- Create: `src/lib/tax-id.ts`
- Create: `src/lib/tax-id.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `_shared/tax-id.ts`: `normalizeTaxId(raw: string): string`, `isValidTaxId(raw: string): boolean`
  - `src/lib/tax-id.ts`: `normalizeTaxId(input: string | null | undefined): string`, `isValidTaxId(input: string | null | undefined): boolean`, `formatTaxId(input: string | null | undefined): string`, `validateTaxId(input, opts?: { allowEmpty?: boolean }): TaxIdValidation`
  - `interface TaxIdValidation { valid: boolean; reason?: string; digits: string }`

> **Por que duas cópias com teste de sincronia, e não uma só.** O precedente do repo (`phone.ts`) duplica e mantém sincronia **só por comentário** — `src/lib/phone.test.ts` importa localmente, então nada verifica que as cópias concordam. Aqui duplicamos igual (Deno não importa de `src/`, e `src/` runtime nunca importou de `_shared/`), mas o teste importa **as duas** e roda o mesmo corpus pelas duas. Custa 15 linhas e transforma disciplina em teste.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/tax-id.test.ts
import { describe, it, expect } from "vitest";
import {
  normalizeTaxId,
  isValidTaxId,
  formatTaxId,
  validateTaxId,
} from "./tax-id";
import {
  normalizeTaxId as normalizeTaxIdBackend,
  isValidTaxId as isValidTaxIdBackend,
} from "../../supabase/functions/_shared/tax-id";

// CPFs/CNPJs válidos gerados (dígito verificador correto). Não pertencem a
// ninguém — são os números canônicos de teste usados no Brasil.
const CPF_VALIDO = "52998224725";
const CPF_VALIDO_2 = "11144477735";
const CNPJ_VALIDO = "11222333000181";

describe("normalizeTaxId", () => {
  it("strips mask characters", () => {
    expect(normalizeTaxId("529.982.247-25")).toBe(CPF_VALIDO);
    expect(normalizeTaxId("11.222.333/0001-81")).toBe(CNPJ_VALIDO);
  });
  it("handles empty input", () => {
    expect(normalizeTaxId("")).toBe("");
    expect(normalizeTaxId(null)).toBe("");
    expect(normalizeTaxId(undefined)).toBe("");
  });
});

describe("isValidTaxId — CPF", () => {
  it("accepts a valid CPF, masked or not", () => {
    expect(isValidTaxId(CPF_VALIDO)).toBe(true);
    expect(isValidTaxId("529.982.247-25")).toBe(true);
    expect(isValidTaxId(CPF_VALIDO_2)).toBe(true);
  });
  it("rejects a CPF with a wrong check digit", () => {
    expect(isValidTaxId("52998224726")).toBe(false);
    expect(isValidTaxId("11144477730")).toBe(false);
  });
  it("rejects repeated-digit CPFs (they pass the algorithm)", () => {
    // 111.111.111-11 satisfaz o cálculo do dígito verificador. Sem o guard
    // explícito, todo CPF de dígito repetido passaria.
    expect(isValidTaxId("11111111111")).toBe(false);
    expect(isValidTaxId("00000000000")).toBe(false);
    expect(isValidTaxId("99999999999")).toBe(false);
  });
  it("rejects wrong length", () => {
    expect(isValidTaxId("1234567890")).toBe(false);
    expect(isValidTaxId("123456789012")).toBe(false);
  });
});

describe("isValidTaxId — CNPJ", () => {
  it("accepts a valid CNPJ, masked or not", () => {
    expect(isValidTaxId(CNPJ_VALIDO)).toBe(true);
    expect(isValidTaxId("11.222.333/0001-81")).toBe(true);
  });
  it("rejects a CNPJ with a wrong check digit", () => {
    expect(isValidTaxId("11222333000182")).toBe(false);
  });
  it("rejects repeated-digit CNPJs", () => {
    expect(isValidTaxId("11111111111111")).toBe(false);
  });
});

describe("formatTaxId", () => {
  it("masks CPF and CNPJ by length", () => {
    expect(formatTaxId(CPF_VALIDO)).toBe("529.982.247-25");
    expect(formatTaxId(CNPJ_VALIDO)).toBe("11.222.333/0001-81");
  });
  it("returns partial input untouched", () => {
    expect(formatTaxId("5299822")).toBe("5299822");
    expect(formatTaxId("")).toBe("");
  });
});

describe("validateTaxId", () => {
  it("reports a PT-BR reason on failure", () => {
    const r = validateTaxId("52998224726");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("inválido");
    expect(r.digits).toBe("52998224726");
  });
  it("respects allowEmpty", () => {
    expect(validateTaxId("", { allowEmpty: true }).valid).toBe(true);
    expect(validateTaxId("", { allowEmpty: false }).valid).toBe(false);
    expect(validateTaxId("").valid).toBe(false); // default: obrigatório
  });
  it("returns normalized digits on success", () => {
    const r = validateTaxId("529.982.247-25");
    expect(r.valid).toBe(true);
    expect(r.digits).toBe(CPF_VALIDO);
  });
});

// O teste que o precedente do phone.ts não tem: prova que as duas cópias
// concordam, em vez de confiar num comentário.
describe("sincronia entre src/lib/tax-id.ts e _shared/tax-id.ts", () => {
  const CORPUS = [
    CPF_VALIDO, CPF_VALIDO_2, CNPJ_VALIDO,
    "529.982.247-25", "11.222.333/0001-81",
    "52998224726", "11222333000182",
    "11111111111", "00000000000", "11111111111111",
    "1234567890", "123456789012", "", "abc", "5299822",
  ];

  it("normalizeTaxId concorda em todo o corpus", () => {
    for (const input of CORPUS) {
      expect(normalizeTaxIdBackend(input)).toBe(normalizeTaxId(input));
    }
  });

  it("isValidTaxId concorda em todo o corpus", () => {
    for (const input of CORPUS) {
      expect(isValidTaxIdBackend(input)).toBe(isValidTaxId(input));
    }
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm run test -- tax-id`
Expected: FAIL — `Failed to resolve import "./tax-id"`.

- [ ] **Step 3: Escrever a cópia backend**

```ts
// supabase/functions/_shared/tax-id.ts
// Validação de CPF/CNPJ (dígito verificador). Módulo PURO — zero imports, zero
// `Deno.*` — para ser importável pelo vitest a partir de src/ (padrão asaas-core).
//
// Existe porque o Asaas exige `cpfCnpj` para criar cliente (§9 do doc 03) e
// rejeitar cedo com mensagem clara é melhor que levar 400 genérico no meio de
// um checkout.
//
// MANTIDO SINCRONIZADO com src/lib/tax-id.ts. A sincronia é verificada por
// teste em src/lib/tax-id.test.ts ("sincronia entre ..."), não por convenção —
// diferente do precedente de phone.ts.

export function normalizeTaxId(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

function isRepeated(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

function validCpf(d: string): boolean {
  if (d.length !== 11 || isRepeated(d)) return false;
  for (const [len, factor] of [[9, 10], [10, 11]] as const) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (factor - i);
    const rest = (sum * 10) % 11;
    const check = rest === 10 || rest === 11 ? 0 : rest;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

function validCnpj(d: string): boolean {
  if (d.length !== 14 || isRepeated(d)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const len of [12, 13]) {
    const slice = weights.slice(13 - len);
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * slice[i];
    const rest = sum % 11;
    const check = rest < 2 ? 0 : 11 - rest;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

export function isValidTaxId(raw: string): boolean {
  const d = normalizeTaxId(raw);
  if (d.length === 11) return validCpf(d);
  if (d.length === 14) return validCnpj(d);
  return false;
}
```

- [ ] **Step 4: Escrever a cópia frontend**

```ts
// src/lib/tax-id.ts
// Validação e formatação de CPF/CNPJ para a UI. O núcleo (normalizeTaxId,
// isValidTaxId) é IDÊNTICO a supabase/functions/_shared/tax-id.ts — a sincronia
// é verificada por teste em ./tax-id.test.ts, não por convenção.
//
// A máscara (formatTaxId) e o resultado estruturado (validateTaxId) são
// frontend-only: o backend só precisa do booleano.

export function normalizeTaxId(input: string | null | undefined): string {
  return (input ?? "").replace(/\D/g, "");
}

function isRepeated(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

function validCpf(d: string): boolean {
  if (d.length !== 11 || isRepeated(d)) return false;
  for (const [len, factor] of [[9, 10], [10, 11]] as const) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (factor - i);
    const rest = (sum * 10) % 11;
    const check = rest === 10 || rest === 11 ? 0 : rest;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

function validCnpj(d: string): boolean {
  if (d.length !== 14 || isRepeated(d)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const len of [12, 13]) {
    const slice = weights.slice(13 - len);
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * slice[i];
    const rest = sum % 11;
    const check = rest < 2 ? 0 : 11 - rest;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

export function isValidTaxId(input: string | null | undefined): boolean {
  const d = normalizeTaxId(input);
  if (d.length === 11) return validCpf(d);
  if (d.length === 14) return validCnpj(d);
  return false;
}

/** Máscara por tamanho. Entrada parcial volta intocada (digitação em progresso). */
export function formatTaxId(input: string | null | undefined): string {
  const d = normalizeTaxId(input);
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return d;
}

export interface TaxIdValidation {
  valid: boolean;
  reason?: string;
  /** Dígitos normalizados, prontos pra persistir. */
  digits: string;
}

export function validateTaxId(
  input: string | null | undefined,
  opts?: { allowEmpty?: boolean },
): TaxIdValidation {
  const digits = normalizeTaxId(input);
  if (!digits) {
    return opts?.allowEmpty
      ? { valid: true, digits: "" }
      : { valid: false, reason: "CPF/CNPJ é obrigatório.", digits: "" };
  }
  if (digits.length !== 11 && digits.length !== 14) {
    return { valid: false, reason: "CPF/CNPJ inválido — informe 11 ou 14 dígitos.", digits };
  }
  if (!isValidTaxId(digits)) {
    return { valid: false, reason: "CPF/CNPJ inválido — verifique os dígitos.", digits };
  }
  return { valid: true, digits };
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm run test -- tax-id`
Expected: PASS, todos os describes, incluindo os dois de sincronia.

- [ ] **Step 6: Verificar tipagem dos dois lados**

Run: `npm run typecheck && npx deno@2.1.4 check supabase/functions/_shared/tax-id.ts`
Expected: zero erros nos dois.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tax-id.ts src/lib/tax-id.test.ts supabase/functions/_shared/tax-id.ts
git commit -m "feat(billing): validacao de CPF/CNPJ com sincronia verificada por teste"
```

---

### Task 3: Onboarding coleta CPF/CNPJ e billing_email

**Files:**
- Modify: `src/lib/validators/organization.ts`
- Modify: `src/pages/platform/Empresas.tsx:52-201` (`CreateOrgDialog`)
- Modify: `supabase/functions/manage-organizations/index.ts:84-210` (`create_organization`)

**Interfaces:**
- Consumes: `validateTaxId` de `@/lib/tax-id`; `isValidTaxId`, `normalizeTaxId` de `../_shared/tax-id.ts`.
- Produces: `CreateOrganizationInput` ganha `tax_id: string` e `billing_email: string`. Após esta task, toda org nova tem linha em `billing_customers` com `tax_id` preenchido e `organizations.billing_email` não-nulo.

- [ ] **Step 1: Estender o schema Zod**

Em `src/lib/validators/organization.ts`, adicionar o import e os dois campos dentro de `createOrganizationSchema`, depois de `owner_password`:

```ts
import { z } from "zod";
import { isValidTaxId, normalizeTaxId } from "@/lib/tax-id";
```

```ts
  owner_password: z.string().min(10, "Senha deve ter ao menos 10 caracteres."),
  // CPF/CNPJ é obrigatório para criar cliente no Asaas (§9 do doc 03). Sem ele,
  // o checkout falha antes da primeira chamada de API — melhor barrar aqui.
  tax_id: z
    .string()
    .min(1, "CPF/CNPJ é obrigatório.")
    .refine(isValidTaxId, "CPF/CNPJ inválido — verifique os dígitos.")
    .transform(normalizeTaxId),
  // Canal de cobrança da org. Antes desta fase nascia nulo em toda org, o que
  // deixava os lembretes de billing sem destinatário.
  billing_email: z.string().email("E-mail de cobrança inválido."),
```

- [ ] **Step 2: Adicionar os campos ao formulário**

Em `src/pages/platform/Empresas.tsx`, no `CreateOrgDialog`: adicionar aos `defaultValues` (depois de `owner_password: ""`):

```tsx
      owner_password: "",
      tax_id: "",
      billing_email: "",
```

E inserir um bloco novo logo **antes** do `<DialogFooter>`:

```tsx
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="tax_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>CPF/CNPJ da empresa</FormLabel>
                    <FormControl>
                      <Input placeholder="11.222.333/0001-81" {...field} />
                    </FormControl>
                    <FormDescription>
                      Obrigatório para emitir cobrança. Aceita CPF ou CNPJ.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="billing_email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>E-mail de cobrança</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="financeiro@acme.com" {...field} />
                    </FormControl>
                    <FormDescription>
                      Recebe faturas e avisos. Pode ser igual ao do proprietário.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
```

Garantir que `FormDescription` está no import de `@/components/ui/form` no topo do arquivo (adicionar se faltar).

- [ ] **Step 3: Validar server-side e criar o billing_customer**

Em `supabase/functions/manage-organizations/index.ts`, adicionar o import no topo:

```ts
import { isValidTaxId, normalizeTaxId } from "../_shared/tax-id.ts";
```

Dentro de `create_organization`, adicionar a leitura junto das outras (depois de `ownerPassword`):

```ts
      const taxId = normalizeTaxId(String(body.tax_id ?? ""));
      const billingEmail = String(body.billing_email ?? "").trim().toLowerCase();
```

E as validações, depois do check de `ownerPassword.length < 10`:

```ts
      if (!isValidTaxId(taxId)) {
        return jsonResponse(req, { error: "CPF/CNPJ da empresa é inválido." }, 400);
      }
      if (!billingEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) {
        return jsonResponse(req, { error: "E-mail de cobrança inválido." }, 400);
      }
```

Trocar o insert de `organizations` (passo 2 do handler) para incluir o e-mail:

```ts
      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .insert({ name: orgName, slug: orgSlug, billing_email: billingEmail })
        .select("id")
        .single();
```

E inserir um passo novo **entre** o passo 4 (unit_member) e o passo 5 (trial):

```ts
      // 4.5. Criar billing_customer com o documento fiscal.
      // Antes desta fase a linha só nascia quando um admin abria BillingDetail e
      // salvava à mão — e sem tax_id o checkout Asaas falha antes da primeira
      // chamada de API (billing-provider.ts valida cpfCnpj e recusa).
      // Falha aqui NÃO faz rollback: a org é utilizável sem billing_customer, e
      // o admin pode criar depois em BillingDetail. Só loga.
      const { error: customerErr } = await supabase.from("billing_customers").insert({
        organization_id: org.id,
        name: orgName,
        email: billingEmail,
        tax_id: taxId,
      });
      if (customerErr) {
        console.error("manage-organizations:create billing_customer insert failed", customerErr);
      }
```

Por fim, incluir o indicador na resposta:

```ts
      return jsonResponse(req, {
        success: true,
        organization_id: org.id,
        unit_id: unit.id,
        owner_id: ownerId,
        trial_applied: trialApplied,
        billing_customer_created: !customerErr,
      });
```

- [ ] **Step 4: Verificar**

Run: `npm run typecheck && npm run lint && npx deno@2.1.4 check supabase/functions/manage-organizations/index.ts`
Expected: zero erros; nenhum warning novo no lint.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validators/organization.ts src/pages/platform/Empresas.tsx supabase/functions/manage-organizations/index.ts
git commit -m "feat(billing): coleta CPF/CNPJ e e-mail de cobranca no onboarding"
```

- [ ] **Step 6: Anotar o backfill pendente**

Adicionar em `docs/billing-asaas/` (no resumo da fase, quando existir) a nota: as orgs Moralles, Ren Sushi e Seu Japa Teste ficaram sem `tax_id`/`billing_email` e precisam de preenchimento manual em `/platform/billing/<org>`. Moralles e Ren Sushi são vitalícias e nunca passam por checkout — nelas é higiene, não pré-requisito.

---

### Task 4: Núcleo puro — externalReference

**Files:**
- Create: `supabase/functions/_shared/asaas-billing-events.ts`
- Create: `src/lib/asaas-billing-events.test.ts`

**Interfaces:**
- Consumes: nada (núcleo puro).
- Produces:
  - `type AsaasPurpose = "subscription" | "implementation" | "ai_topup" | "other"`
  - `interface ExternalReferenceParts { orgId: string; planId: string | null; purpose: AsaasPurpose }`
  - `buildExternalReference(parts: ExternalReferenceParts): string`
  - `parseExternalReference(raw: unknown): ExternalReferenceParts | null`

> Os valores de `AsaasPurpose` espelham o CHECK de `billing_invoices.purpose` (migration 063): `subscription|implementation|ai_topup|other`. Divergir daqui gera 23514 no INSERT.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/asaas-billing-events.test.ts
import { describe, it, expect } from "vitest";
import {
  buildExternalReference,
  parseExternalReference,
} from "../../supabase/functions/_shared/asaas-billing-events";

const ORG = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const PLAN = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("buildExternalReference", () => {
  it("builds the canonical shape", () => {
    expect(buildExternalReference({ orgId: ORG, planId: PLAN, purpose: "subscription" }))
      .toBe(`org:${ORG}|plan:${PLAN}|purpose:subscription`);
  });

  it("emits plan:none when there is no plan", () => {
    expect(buildExternalReference({ orgId: ORG, planId: null, purpose: "other" }))
      .toBe(`org:${ORG}|plan:none|purpose:other`);
  });

  it("stays within the Asaas 200-char limit", () => {
    const ref = buildExternalReference({ orgId: ORG, planId: PLAN, purpose: "implementation" });
    expect(ref.length).toBeLessThanOrEqual(200);
  });
});

describe("parseExternalReference", () => {
  it("round-trips what build produced", () => {
    const parts = { orgId: ORG, planId: PLAN, purpose: "subscription" as const };
    expect(parseExternalReference(buildExternalReference(parts))).toEqual(parts);
  });

  it("round-trips the no-plan form back to null", () => {
    const parts = { orgId: ORG, planId: null, purpose: "ai_topup" as const };
    expect(parseExternalReference(buildExternalReference(parts))).toEqual(parts);
  });

  it("rejects non-string input without throwing", () => {
    expect(parseExternalReference(null)).toBeNull();
    expect(parseExternalReference(undefined)).toBeNull();
    expect(parseExternalReference(42)).toBeNull();
    expect(parseExternalReference({})).toBeNull();
    expect(parseExternalReference([])).toBeNull();
  });

  it("rejects malformed shapes", () => {
    expect(parseExternalReference("")).toBeNull();
    expect(parseExternalReference("garbage")).toBeNull();
    expect(parseExternalReference(`org:${ORG}`)).toBeNull();
    expect(parseExternalReference(`org:${ORG}|plan:${PLAN}`)).toBeNull();
    expect(parseExternalReference(`plan:${PLAN}|org:${ORG}|purpose:subscription`)).toBeNull();
  });

  it("rejects a non-UUID org", () => {
    expect(parseExternalReference("org:not-a-uuid|plan:none|purpose:subscription")).toBeNull();
  });

  it("rejects a non-UUID plan that is not the literal none", () => {
    expect(parseExternalReference(`org:${ORG}|plan:nope|purpose:subscription`)).toBeNull();
  });

  it("rejects an unknown purpose", () => {
    expect(parseExternalReference(`org:${ORG}|plan:none|purpose:mystery`)).toBeNull();
  });

  it("accepts every purpose in the billing_invoices CHECK", () => {
    for (const p of ["subscription", "implementation", "ai_topup", "other"]) {
      const ref = `org:${ORG}|plan:none|purpose:${p}`;
      expect(parseExternalReference(ref)?.purpose).toBe(p);
    }
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm run test -- asaas-billing-events`
Expected: FAIL — não resolve o import.

- [ ] **Step 3: Implementar o mínimo**

```ts
// supabase/functions/_shared/asaas-billing-events.ts
// Decisão e aplicação dos efeitos de negócio dos eventos Asaas.
//
// COMPARTILHADO por asaas-webhook e process-asaas-reconcile de propósito:
// quando `processing_status='processed'` passou a significar "assinatura
// ativada", o reconcile precisou executar a MESMA lógica — senão marca como
// resolvido um evento que nunca ativou nada.
//
// A metade de cima é PURA (zero imports, zero Deno.*) e testada em
// src/lib/asaas-billing-events.test.ts. A metade de baixo faz I/O e nunca é
// importada por src/.

// ─────────────────────────────────────────────────────────────────────────────
// NÚCLEO PURO
// ─────────────────────────────────────────────────────────────────────────────

/** Espelha o CHECK de billing_invoices.purpose (migration 063). */
export type AsaasPurpose = "subscription" | "implementation" | "ai_topup" | "other";

const PURPOSES: ReadonlySet<string> = new Set<AsaasPurpose>([
  "subscription",
  "implementation",
  "ai_topup",
  "other",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExternalReferenceParts {
  orgId: string;
  planId: string | null;
  purpose: AsaasPurpose;
}

/**
 * Correlação que viaja até o Asaas e volta no webhook. Cabe no limite de 200
 * chars de `externalReference` (§9): 3 UUIDs + rótulos ≈ 110.
 */
export function buildExternalReference(parts: ExternalReferenceParts): string {
  return `org:${parts.orgId}|plan:${parts.planId ?? "none"}|purpose:${parts.purpose}`;
}

/**
 * Parse defensivo: é dado NOSSO voltando de terceiro, então qualquer shape
 * inesperado vira `null` e o caller cai nos fallbacks (provider_payment_id,
 * asaas_customer_id). Nunca lança.
 */
export function parseExternalReference(raw: unknown): ExternalReferenceParts | null {
  if (typeof raw !== "string" || !raw) return null;

  const match = /^org:([^|]+)\|plan:([^|]+)\|purpose:([^|]+)$/.exec(raw);
  if (!match) return null;

  const [, orgId, planRaw, purpose] = match;
  if (!UUID_RE.test(orgId)) return null;
  if (planRaw !== "none" && !UUID_RE.test(planRaw)) return null;
  if (!PURPOSES.has(purpose)) return null;

  return {
    orgId,
    planId: planRaw === "none" ? null : planRaw,
    purpose: purpose as AsaasPurpose,
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm run test -- asaas-billing-events`
Expected: PASS, 12 casos.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/asaas-billing-events.ts src/lib/asaas-billing-events.test.ts
git commit -m "feat(billing): externalReference canonico para correlacao Asaas"
```

---

### Task 5: Núcleo puro — decideEventEffect

Aqui mora o gate `PAYMENT_CONFIRMED` **OU** `PAYMENT_RECEIVED`, e é por ser função pura que a idempotência do cartão vira teste em vez de esperança.

**Files:**
- Modify: `supabase/functions/_shared/asaas-billing-events.ts` (append ao núcleo puro)
- Modify: `src/lib/asaas-billing-events.test.ts` (append)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type AsaasEffectKind = "activate_subscription" | "mark_invoice_paid" | "mark_invoice_overdue" | "record_refund" | "noop" | "unknown"`
  - `interface EventDecisionInput { eventType: string; invoiceStatus: string | null; subscriptionStatus: string | null }`
  - `interface AsaasEffect { kind: AsaasEffectKind; reason: string }`
  - `decideEventEffect(input: EventDecisionInput): AsaasEffect`

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao final de `src/lib/asaas-billing-events.test.ts`, e estender o import do topo com `decideEventEffect`:

```ts
describe("decideEventEffect — gate de ativação", () => {
  it("activates on PAYMENT_CONFIRMED when the invoice is still open", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_CONFIRMED",
      invoiceStatus: "open",
      subscriptionStatus: null,
    });
    expect(e.kind).toBe("activate_subscription");
  });

  it("activates on PAYMENT_RECEIVED when the invoice is still open", () => {
    // PIX/boleto NUNCA emite CONFIRMED — provado ao vivo em 18/07/2026 (§5 do
    // doc 03). Um gate só-CONFIRMED deixaria todo cliente de PIX pagando sem
    // receber acesso, e funcionaria no cartão, escondendo o bug.
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "open",
      subscriptionStatus: null,
    });
    expect(e.kind).toBe("activate_subscription");
  });

  it("is idempotent: the card's second event is a noop", () => {
    // Cartão emite CONFIRMED e depois RECEIVED (até ~30d). O primeiro marcou a
    // invoice como paid; o segundo não pode ativar de novo.
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    });
    expect(e.kind).toBe("noop");
  });

  it("is idempotent for CONFIRMED arriving after paid", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_CONFIRMED",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    });
    expect(e.kind).toBe("noop");
  });

  it("marks the invoice paid when there is no subscription to activate", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: null,
      subscriptionStatus: null,
    });
    expect(e.kind).toBe("mark_invoice_paid");
  });
});

describe("decideEventEffect — demais eventos", () => {
  it("marks overdue on PAYMENT_OVERDUE", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_OVERDUE",
      invoiceStatus: "open",
      subscriptionStatus: "active",
    }).kind).toBe("mark_invoice_overdue");
  });

  it("does not re-mark an already paid invoice as overdue", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_OVERDUE",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    }).kind).toBe("noop");
  });

  it("records refunds and chargebacks", () => {
    for (const ev of [
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ]) {
      expect(decideEventEffect({
        eventType: ev,
        invoiceStatus: "paid",
        subscriptionStatus: "active",
      }).kind).toBe("record_refund");
    }
  });

  it("treats informational payment events as noop, not unknown", () => {
    for (const ev of ["PAYMENT_CREATED", "PAYMENT_UPDATED", "PAYMENT_BANK_SLIP_VIEWED"]) {
      expect(decideEventEffect({
        eventType: ev,
        invoiceStatus: "open",
        subscriptionStatus: null,
      }).kind).toBe("noop");
    }
  });

  it("returns unknown for an event outside the Asaas catalogue", () => {
    expect(decideEventEffect({
      eventType: "SOMETHING_NEW",
      invoiceStatus: null,
      subscriptionStatus: null,
    }).kind).toBe("unknown");
  });

  it("does not match chargeback events by prefix", () => {
    // PAYMENT_AWAITING_CHARGEBACK_REVERSAL não começa com PAYMENT_CHARGEBACK_.
    // Um matcher por prefixo erraria justamente esse.
    expect(decideEventEffect({
      eventType: "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    }).kind).toBe("record_refund");
  });

  it("always fills a reason for observability", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "open",
      subscriptionStatus: null,
    });
    expect(e.reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm run test -- asaas-billing-events`
Expected: FAIL — `decideEventEffect is not a function`.

- [ ] **Step 3: Implementar**

Adicionar ao núcleo puro de `_shared/asaas-billing-events.ts`, logo depois de `parseExternalReference`:

```ts
export type AsaasEffectKind =
  | "activate_subscription"
  | "mark_invoice_paid"
  | "mark_invoice_overdue"
  | "record_refund"
  | "noop"
  | "unknown";

export interface EventDecisionInput {
  eventType: string;
  /** billing_invoices.status atual: draft|open|paid|void|uncollectible, ou null. */
  invoiceStatus: string | null;
  /** billing_subscriptions.status atual, ou null se ainda não existe. */
  subscriptionStatus: string | null;
}

export interface AsaasEffect {
  kind: AsaasEffectKind;
  /** Motivo legível — vai pro log e pro billing_events.error_message. */
  reason: string;
}

/**
 * Eventos que liberam acesso. São DOIS de propósito.
 *
 * `PAYMENT_CONFIRMED` = pago, saldo ainda indisponível.
 * `PAYMENT_RECEIVED`  = liquidado.
 *
 * O cartão emite os dois (RECEIVED até ~30 dias depois). PIX e boleto pulam o
 * CONFIRMED e vão direto pro RECEIVED — provado por teste ao vivo em 18/07/2026
 * (§5 do doc 03). Escutar só CONFIRMED deixaria todo cliente de PIX/boleto
 * pagando sem receber acesso, e funcionaria no cartão — bug silencioso e
 * enganoso. Ativar nos dois exige idempotência, que é o `invoiceStatus==='paid'`
 * logo abaixo.
 */
const ACTIVATING_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
]);

/**
 * Estorno e chargeback. Lista EXPLÍCITA, nunca `startsWith`:
 * `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` não começa com `PAYMENT_CHARGEBACK_`
 * e um matcher por prefixo o perderia (armadilha registrada no §4 do doc 03).
 */
const REFUND_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
]);

/**
 * Eventos reconhecidos que não geram efeito. Distinguir de `unknown` importa:
 * `noop` é "conhecido, nada a fazer" e vira `processing_status='processed'`;
 * `unknown` vira `'ignored'` e é sinal de que o catálogo mudou.
 */
const INFORMATIONAL_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_CREATED",
  "PAYMENT_UPDATED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_AWAITING_RISK_ANALYSIS",
  "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_BANK_SLIP_VIEWED",
  "PAYMENT_CHECKOUT_VIEWED",
  "PAYMENT_ANTICIPATED",
  "CHECKOUT_CREATED",
  "CHECKOUT_PAID",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_INACTIVATED",
  "SUBSCRIPTION_DELETED",
]);

const TERMINAL_INVOICE_STATUSES: ReadonlySet<string> = new Set(["paid", "void"]);

export function decideEventEffect(input: EventDecisionInput): AsaasEffect {
  const { eventType, invoiceStatus, subscriptionStatus } = input;

  if (ACTIVATING_EVENTS.has(eventType)) {
    // Idempotência: o segundo evento do cartão encontra a invoice já paga.
    if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) {
      return {
        kind: "noop",
        reason: `Invoice já em '${invoiceStatus}' — ${eventType} duplicado ou tardio.`,
      };
    }
    if (subscriptionStatus === "active" && invoiceStatus === null) {
      return { kind: "noop", reason: "Assinatura já ativa e sem invoice pendente." };
    }
    if (invoiceStatus === null && subscriptionStatus === null) {
      return {
        kind: "mark_invoice_paid",
        reason: `${eventType} sem assinatura correlacionada — registra pagamento.`,
      };
    }
    return { kind: "activate_subscription", reason: `${eventType} libera o acesso.` };
  }

  if (eventType === "PAYMENT_OVERDUE") {
    if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) {
      return { kind: "noop", reason: `Invoice em '${invoiceStatus}' — vencimento irrelevante.` };
    }
    return { kind: "mark_invoice_overdue", reason: "Cobrança vencida." };
  }

  if (REFUND_EVENTS.has(eventType)) {
    return { kind: "record_refund", reason: `${eventType} — registra estorno/chargeback.` };
  }

  if (INFORMATIONAL_EVENTS.has(eventType)) {
    return { kind: "noop", reason: `${eventType} é informativo.` };
  }

  return { kind: "unknown", reason: `Evento fora do catálogo conhecido: ${eventType}.` };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm run test -- asaas-billing-events`
Expected: PASS, todos os casos das Tasks 4 e 5.

- [ ] **Step 5: Rodar a suíte inteira (guarda contra regressão)**

Run: `npm run test`
Expected: PASS. Baseline antes desta fase era 173/173; agora deve ser 173 + os novos.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/asaas-billing-events.ts src/lib/asaas-billing-events.test.ts
git commit -m "feat(billing): decideEventEffect com gate CONFIRMED-ou-RECEIVED idempotente"
```

---

### Task 6: Aplicador de I/O — applyAsaasEvent

**Files:**
- Modify: `supabase/functions/_shared/asaas-billing-events.ts` (append: metade de I/O)

**Interfaces:**
- Consumes: `decideEventEffect`, `parseExternalReference` (Task 4/5); `getBillingProvider` de `./billing-provider.ts`; `asaasValueToCents` de `./asaas-core.ts`.
- Produces:
  - `interface BillingEventRow { id: string; provider_event_id: string; event_type: string; data: Record<string, unknown> | null; organization_id: string | null }`
  - `interface ApplyResult { status: "processed" | "failed" | "ignored"; organizationId: string | null; effect: AsaasEffectKind; error?: string }`
  - `applyAsaasEvent(supabase: SupabaseClient, row: BillingEventRow): Promise<ApplyResult>`

> **Pré-requisito:** a Task 1 precisa ter respondido se o payload de `PAYMENT_*` traz o objeto completo ou só `{object, id}`. Este código assume **só o stub** e sempre reconsulta via `getPayment` — que é correto nos dois casos e é o que a regra §19 ("valores sempre do banco") exige de qualquer jeito.

- [ ] **Step 1: Implementar o aplicador**

Adicionar ao final de `_shared/asaas-billing-events.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// BORDA DE I/O — nunca importada por src/
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getBillingProvider } from "./billing-provider.ts";
import { asaasValueToCents } from "./asaas-core.ts";

export interface BillingEventRow {
  id: string;
  provider_event_id: string;
  event_type: string;
  data: Record<string, unknown> | null;
  organization_id: string | null;
}

export interface ApplyResult {
  status: "processed" | "failed" | "ignored";
  organizationId: string | null;
  effect: AsaasEffectKind;
  error?: string;
}

/** Extrai o id do payment do envelope. Shape não é uniforme entre categorias (§3). */
function extractPaymentId(data: Record<string, unknown> | null): string | null {
  const payment = data?.payment;
  if (typeof payment === "string") return payment;
  if (payment && typeof payment === "object") {
    const id = (payment as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Aplica o efeito de negócio de um evento Asaas já persistido.
 *
 * NUNCA lança: todo caminho de erro vira `{status:'failed'}`, porque o webhook
 * precisa responder 200 (a linha já está durável e o reconcile reprocessa) e o
 * reconcile precisa continuar o lote.
 */
export async function applyAsaasEvent(
  supabase: SupabaseClient,
  row: BillingEventRow,
): Promise<ApplyResult> {
  try {
    const paymentId = extractPaymentId(row.data);

    // 1. Buscar a invoice que já conhecemos deste pagamento, se houver.
    let invoice: {
      id: string;
      status: string;
      organization_id: string;
      billing_subscription_id: string | null;
      amount_cents: number;
    } | null = null;

    if (paymentId) {
      const { data } = await supabase
        .from("billing_invoices")
        .select("id, status, organization_id, billing_subscription_id, amount_cents")
        .eq("provider", "asaas")
        .eq("provider_payment_id", paymentId)
        .maybeSingle();
      invoice = data ?? null;
    }

    // 2. Resolver a organização. Ordem: invoice conhecida → externalReference
    //    do payment (fonte primária) → customer Asaas.
    let organizationId = row.organization_id ?? invoice?.organization_id ?? null;
    let planId: string | null = null;
    let purpose: AsaasPurpose = "subscription";
    let paidValueCents: number | null = null;

    if (paymentId) {
      const provider = getBillingProvider("asaas");
      const res = await provider.getPayment(paymentId);
      if (res.ok && res.data) {
        const parsed = parseExternalReference(res.data.externalReference);
        if (parsed) {
          organizationId = organizationId ?? parsed.orgId;
          planId = parsed.planId;
          purpose = parsed.purpose;
        }

        // getPayment devolve payload CRU do Asaas: `value` é em REAIS.
        // Comparar com amount_cents sem converter é bug de 100x.
        const rawValue = res.data.value;
        if (typeof rawValue === "number") {
          paidValueCents = asaasValueToCents(rawValue);
        }

        if (!organizationId) {
          const customerRef = res.data.customer;
          if (typeof customerRef === "string" && customerRef) {
            const { data: cust } = await supabase
              .from("billing_customers")
              .select("organization_id")
              .eq("asaas_customer_id", customerRef)
              .maybeSingle();
            organizationId = cust?.organization_id ?? null;
          }
        }
      }
    }

    // 3. Estado atual da assinatura da org.
    let subscription: { id: string; status: string } | null = null;
    if (organizationId) {
      const { data } = await supabase
        .from("billing_subscriptions")
        .select("id, status")
        .eq("organization_id", organizationId)
        .neq("status", "canceled")
        .maybeSingle();
      subscription = data ?? null;
    }

    // 4. Decidir (puro).
    const effect = decideEventEffect({
      eventType: row.event_type,
      invoiceStatus: invoice?.status ?? null,
      subscriptionStatus: subscription?.status ?? null,
    });

    if (effect.kind === "unknown") {
      return { status: "ignored", organizationId, effect: effect.kind, error: effect.reason };
    }
    if (effect.kind === "noop") {
      return { status: "processed", organizationId, effect: effect.kind };
    }
    if (!organizationId) {
      return {
        status: "failed",
        organizationId: null,
        effect: effect.kind,
        error: "Não foi possível correlacionar o evento a uma organização.",
      };
    }

    // 5. Executar. Transições por UPDATE CONDICIONAL — o `.neq`/`.eq` no status
    //    anterior é o que garante idempotência sob concorrência (webhook e
    //    reconcile podem tocar a mesma linha).
    switch (effect.kind) {
      case "activate_subscription":
      case "mark_invoice_paid": {
        if (invoice) {
          await supabase
            .from("billing_invoices")
            .update({ status: "paid", paid_at: new Date().toISOString() })
            .eq("id", invoice.id)
            .neq("status", "paid");

          if (paidValueCents !== null && paidValueCents !== invoice.amount_cents) {
            console.error(
              JSON.stringify({
                evt: "asaas_amount_divergence",
                invoice_id: invoice.id,
                expected_cents: invoice.amount_cents,
                paid_cents: paidValueCents,
              }),
            );
          }
        }

        if (effect.kind === "activate_subscription") {
          if (subscription) {
            await supabase
              .from("billing_subscriptions")
              .update({ status: "active" })
              .eq("id", subscription.id)
              .neq("status", "active");
          } else if (planId) {
            const { data: customer } = await supabase
              .from("billing_customers")
              .select("id")
              .eq("organization_id", organizationId)
              .maybeSingle();

            await supabase.from("billing_subscriptions").insert({
              organization_id: organizationId,
              billing_customer_id: customer?.id ?? null,
              billing_plan_id: planId,
              provider: "asaas",
              status: "active",
              payment_method: "pix",
            });
          }

          // Espelha em organizations, que é a coluna autoritativa do
          // BillingGuard e dos guards server-side.
          await supabase
            .from("organizations")
            .update({ billing_status: "active", blocked_at: null, blocked_reason: null })
            .eq("id", organizationId);
        }
        break;
      }

      case "mark_invoice_overdue": {
        if (invoice) {
          await supabase
            .from("billing_invoices")
            .update({ status: "open" })
            .eq("id", invoice.id)
            .not("status", "in", "(paid,void)");
        }
        break;
      }

      case "record_refund": {
        if (invoice) {
          await supabase
            .from("billing_invoices")
            .update({ status: "void" })
            .eq("id", invoice.id)
            .neq("status", "void");
        }
        console.error(
          JSON.stringify({
            evt: "asaas_refund_recorded",
            organization_id: organizationId,
            event_type: row.event_type,
            purpose,
          }),
        );
        break;
      }
    }

    return { status: "processed", organizationId, effect: effect.kind };
  } catch (err) {
    console.error("applyAsaasEvent failed", err);
    return {
      status: "failed",
      organizationId: row.organization_id,
      effect: "unknown",
      error: "Falha ao aplicar efeito do evento — ver logs.",
    };
  }
}
```

- [ ] **Step 2: Confirmar que o núcleo puro continua importável por `src/`**

O import de `SupabaseClient` via URL HTTP fica na metade de baixo, mas o Vite resolve o módulo **inteiro** ao importar qualquer símbolo dele. Rodar:

Run: `npm run test -- asaas-billing-events`
Expected: PASS.

> **Se falhar** com erro de resolução do `esm.sh`, a metade de I/O precisa sair para um arquivo irmão (`_shared/asaas-billing-events-apply.ts`) e o núcleo puro fica sozinho em `asaas-billing-events.ts`. Esse é o mesmo particionamento que existe entre `asaas-core.ts` (puro) e `asaas.ts` (I/O) e é a razão de aquele par existir. Fazer a separação, ajustar os imports das Tasks 8 e 9 para o arquivo novo, e seguir.

- [ ] **Step 3: Verificar tipagem Deno**

Run: `npx deno@2.1.4 check supabase/functions/_shared/asaas-billing-events.ts`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/asaas-billing-events.ts
git commit -m "feat(billing): applyAsaasEvent com reconferencia de valor e updates condicionais"
```

---

### Task 7: Checkout roteado por provider

**Files:**
- Modify: `supabase/functions/create-billing-checkout/index.ts`
- Modify: `src/hooks/useBilling.ts:249-275` (`useCreateBillingCheckout`)

**Interfaces:**
- Consumes: `getFlagString` de `../_shared/platform-flags.ts`; `getBillingProvider` de `../_shared/billing-provider.ts`; `buildExternalReference` de `../_shared/asaas-billing-events.ts`.
- Produces: contrato de resposta inalterado — `{ success: true, url: string, session_id: string }`.

> **Invariante estrutural:** não envolver as chamadas de mutação do Asaas em try/catch próprio nem roteá-las por `_shared/retry.ts`. O `safely()` do provider já converte exceção em `ProviderResult{ok:false}`; qualquer camada extra de retry duplica cobrança porque o Asaas não tem `Idempotency-Key`.

- [ ] **Step 1: Corrigir o desempacotamento de erro no hook**

Sem isto, toda mensagem PT-BR desta task fica invisível: o supabase-js zera `data` em não-2xx, então `(data as {error?})?.error` é sempre `undefined` e o usuário vê "Edge Function returned a non-2xx status code". O padrão certo já existe em `useOrganizations.ts:17-36`.

Substituir o corpo do `mutationFn` em `src/hooks/useBilling.ts`:

```ts
    mutationFn: async (params: {
      organization_id: string;
      plan_id?: string;
      mode?: "subscription" | "setup";
    }) => {
      const { data, error } = await supabase.functions.invoke("create-billing-checkout", { body: params });
      if (error) {
        // supabase-js zera `data` em erro HTTP — a mensagem do backend só existe
        // no corpo da resposta, acessível via error.context. Mesmo padrão de
        // useOrganizations.ts.
        let message = error.message ?? "Erro inesperado.";
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const parsed = await ctx.json();
            if (parsed?.error) message = String(parsed.error);
          } catch {
            // corpo não-JSON — mantém error.message
          }
        }
        throw new Error(message);
      }
      if (data && typeof data === "object" && "error" in data && data.error) {
        throw new Error(String(data.error));
      }
      return data as { success: true; url: string; session_id: string };
    },
```

- [ ] **Step 2: Adicionar os imports na EF**

No topo de `supabase/functions/create-billing-checkout/index.ts`:

```ts
import { getFlagString } from "../_shared/platform-flags.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { buildExternalReference } from "../_shared/asaas-billing-events.ts";
```

- [ ] **Step 3: Estender o SELECT do plano**

O SELECT atual (`:192-210`) pega só campos Stripe. Trocar a lista de colunas para incluir o que o roteamento precisa:

```ts
    .select("id, name, slug, stripe_price_id_card, trial_days, active, amount_cents, provider, billing_type")
```

E **mover** a rejeição por `stripe_price_id_card` ausente para dentro do ramo Stripe (hoje ela roda antes de qualquer bifurcação e recusaria todo plano Asaas).

- [ ] **Step 4: Bifurcar por flag**

Depois de resolver plano, org e as URLs de retorno (`successBase`, e antes da montagem da session Stripe), inserir:

```ts
    // Roteamento por provedor. A flag é lida SERVER-SIDE — o frontend nunca lê
    // platform_flags (FORCE RLS sem policies) e não decide provedor.
    // Precedência: o provider do próprio plano vence a flag global, porque um
    // plano Asaas não tem Price ID e não existe caminho Stripe pra ele.
    const defaultProvider = await getFlagString("billing_provider_default", "stripe");
    const provider = plan.provider === "asaas" || plan.provider === "stripe"
      ? plan.provider
      : defaultProvider;

    if (provider === "asaas") {
      if (mode !== "subscription") {
        return jsonResponse(req, {
          error: "Cadastro de cartão avulso ainda não está disponível para cobranças Asaas.",
        }, 400);
      }
      if (!plan.amount_cents || plan.amount_cents <= 0) {
        return jsonResponse(req, { error: "Plano sem valor configurado." }, 400);
      }

      // 1. Resolver o cliente Asaas da org (criando se ainda não existe).
      const { data: customerRow } = await supabase
        .from("billing_customers")
        .select("id, asaas_customer_id, name, email, tax_id")
        .eq("organization_id", organization_id)
        .maybeSingle();

      if (!customerRow?.tax_id) {
        return jsonResponse(req, {
          error: "CPF/CNPJ da empresa não está cadastrado. Preencha o cadastro fiscal antes de contratar.",
        }, 400);
      }

      const asaas = getBillingProvider("asaas");
      let asaasCustomerId = customerRow.asaas_customer_id;

      if (!asaasCustomerId) {
        const created = await asaas.createCustomer({
          organizationId: organization_id,
          name: customerRow.name ?? undefined,
          email: customerRow.email ?? undefined,
          taxId: customerRow.tax_id,
        });
        if (!created.ok || !created.data) {
          console.error("create-billing-checkout: asaas createCustomer failed", created.error);
          return jsonResponse(req, {
            error: created.error ?? "Falha ao cadastrar a empresa no provedor de pagamento.",
          }, 502);
        }
        asaasCustomerId = created.data.customerId;

        const { error: persistErr } = await supabase
          .from("billing_customers")
          .update({ asaas_customer_id: asaasCustomerId })
          .eq("id", customerRow.id);
        if (persistErr) {
          // O cliente EXISTE no Asaas mas não conseguimos gravar o id. Abortar é
          // mais seguro que seguir: a próxima tentativa criaria um cliente
          // duplicado lá (o Asaas não deduplica por externalReference).
          console.error("create-billing-checkout: falha ao gravar asaas_customer_id", persistErr);
          return jsonResponse(req, {
            error: "Falha ao salvar o cadastro no provedor. Tente novamente em instantes.",
          }, 500);
        }
      }

      // 2. Criar o checkout. Valor SEMPRE do banco, nunca do request.
      const checkout = await asaas.createCheckout({
        providerCustomerId: asaasCustomerId,
        amountCents: plan.amount_cents,
        description: plan.name,
        externalReference: buildExternalReference({
          orgId: organization_id,
          planId: plan.id,
          purpose: "subscription",
        }),
        mode: "subscription",
        // O Asaas não interpola id de sessão na URL (a Stripe usa
        // {CHECKOUT_SESSION_ID}); as URLs vão no corpo da criação, antes de o id
        // existir. Logo, sem `sid` — o frontend tolera a ausência.
        successUrl: `${successBase}?session=success`,
        cancelUrl: `${successBase}?session=cancel`,
      });

      if (!checkout.ok || !checkout.data) {
        console.error("create-billing-checkout: asaas createCheckout failed", checkout.error);
        return jsonResponse(req, {
          error: checkout.error ?? "Falha ao abrir o checkout.",
        }, 502);
      }

      return jsonResponse(req, {
        success: true,
        url: checkout.data.url,
        session_id: checkout.data.checkoutId ?? "",
      });
    }

    // ── daqui pra baixo: caminho Stripe, inalterado ──
```

- [ ] **Step 5: Verificar**

Run: `npm run typecheck && npm run lint && npx deno@2.1.4 check supabase/functions/create-billing-checkout/index.ts`
Expected: zero erros.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/create-billing-checkout/index.ts src/hooks/useBilling.ts
git commit -m "feat(billing): checkout Asaas roteado por billing_provider_default"
```

---

### Task 8: Webhook aplica o efeito

**Files:**
- Modify: `supabase/functions/asaas-webhook/index.ts:198-250`

**Interfaces:**
- Consumes: `applyAsaasEvent`, `BillingEventRow` (Task 6).
- Produces: nenhum símbolo novo. Efeito: `billing_events.organization_id` deixa de ser sempre `null`.

> **A régua de HTTP não muda.** Falha do aplicador continua devolvendo **200** com `processing_status='failed'` — a linha já está durável e o reconcile pega. Só falha de persistência devolve 503. Devolver 503 aqui faria o Asaas reenviar um evento que já está salvo, e 15 falhas seguidas matam a fila.

- [ ] **Step 1: Adicionar o import**

```ts
import { applyAsaasEvent } from "../_shared/asaas-billing-events.ts";
```

- [ ] **Step 2: Substituir o bloco de processamento**

O bloco atual (`:198-215`) só reclassifica. Trocar por:

```ts
    // Processamento: classificar E aplicar o efeito de negócio. A linha já está
    // persistida — daqui pra baixo, TODO caminho responde 200. Erro vira
    // processing_status='failed' e o reconcile reprocessa.
    const classification = classifyAsaasEvent(parsed.event);

    if (classification === "unknown") {
      await supabase
        .from("billing_events")
        .update({ processing_status: "ignored" })
        .eq("id", inserted.id);
      jsonLog({ evt: "asaas_webhook_event_ignored", event: parsed.event, id: parsed.id });
      return new Response("OK", { status: 200 });
    }

    const result = await applyAsaasEvent(supabase, {
      id: inserted.id,
      provider_event_id: parsed.id,
      event_type: parsed.event,
      data: rawBody as Record<string, unknown> | null,
      organization_id: null,
    });

    const { error: updateErr } = await supabase
      .from("billing_events")
      .update({
        processing_status: result.status,
        organization_id: result.organizationId,
        error_message: result.error ?? null,
      })
      .eq("id", inserted.id);

    if (updateErr) {
      // A linha existe e o efeito pode ter sido aplicado; só o carimbo falhou.
      // Ainda é 200: reenviar traria o mesmo evento, e o reconcile encontra a
      // linha em 'received' e reprocessa (applyAsaasEvent é idempotente).
      console.error("asaas-webhook: falha ao carimbar processing_status", updateErr);
    }

    jsonLog({
      evt: "asaas_webhook_event_applied",
      event: parsed.event,
      id: parsed.id,
      status: result.status,
      effect: result.effect,
      organization_id: result.organizationId,
    });

    return new Response("OK", { status: 200 });
```

- [ ] **Step 3: Verificar tipagem**

Run: `npx deno@2.1.4 check supabase/functions/asaas-webhook/index.ts`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/asaas-webhook/index.ts
git commit -m "feat(billing): webhook Asaas aplica efeito de negocio e resolve a organizacao"
```

---

### Task 9: Reconcile completo — os 4 itens herdados da Fase 2

**Files:**
- Modify: `supabase/functions/process-asaas-reconcile/index.ts`
- Modify: `supabase/functions/manage-billing/index.ts` (action `reprocess_billing_event`)

**Interfaces:**
- Consumes: `applyAsaasEvent` (Task 6); `getBillingProvider`; `asaasValueToCents`.
- Produces: action `reprocess_billing_event` em `manage-billing` (admin-only), body `{ action, billing_event_id }`.

- [ ] **Step 1: Trocar a reclassificação pela aplicação real**

O comentário `:131-148` do próprio arquivo já previa isto: quando `'processed'` ganhasse significado de negócio, o reconcile precisaria rodar a mesma lógica.

Adicionar o import no topo:

```ts
import { applyAsaasEvent } from "../_shared/asaas-billing-events.ts";
```

Estender o SELECT do lote para trazer o que o aplicador precisa:

```ts
      .select("id, provider_event_id, event_type, data, organization_id, retry_count")
```

E substituir o corpo do loop (o bloco que hoje chama `classifyAsaasEvent` e faz o UPDATE de `processing_status`) por:

```ts
    for (const row of events ?? []) {
      reprocessed++;
      try {
        // MESMA lógica do webhook. Reclassificar sem aplicar marcaria como
        // resolvido um evento que nunca ativou assinatura nenhuma.
        const result = await applyAsaasEvent(supabase, {
          id: row.id,
          provider_event_id: row.provider_event_id,
          event_type: row.event_type,
          data: row.data as Record<string, unknown> | null,
          organization_id: row.organization_id,
        });

        const { error: updateErr } = await supabase
          .from("billing_events")
          .update({
            processing_status: result.status,
            organization_id: result.organizationId,
            error_message: result.error ?? null,
            retry_count: (row.retry_count ?? 0) + 1,
          })
          .eq("id", row.id);

        if (updateErr) {
          console.error("process-asaas-reconcile: falha ao carimbar evento", row.id, updateErr);
          errors++;
          continue;
        }

        if (result.status === "processed") processed++;
        else if (result.status === "ignored") ignored++;
        else errors++;

        jsonLog({
          evt: "asaas_reconcile_event_applied",
          billing_event_id: row.id,
          event_type: row.event_type,
          status: result.status,
          effect: result.effect,
        });
      } catch (err) {
        // applyAsaasEvent não lança, mas o UPDATE pode. Um item ruim não pode
        // derrubar o lote — só bumpa o retry_count e segue.
        console.error("process-asaas-reconcile: erro inesperado no item", row.id, err);
        errors++;
        await supabase
          .from("billing_events")
          .update({
            retry_count: (row.retry_count ?? 0) + 1,
            error_message: "Erro ao reprocessar no worker de reconcile — ver logs.",
          })
          .eq("id", row.id);
      }
    }
```

> O bloco `CLASSIFICATION_ERROR_MESSAGES` (`:58-61`), que limpava `error_message` só quando a mensagem era de classificação, deixa de fazer sentido: agora o aplicador escreve a própria mensagem e o `result.error ?? null` já limpa quando o evento passa a processar. Remover a constante e seu uso.

- [ ] **Step 2: Adicionar a consulta de payments PENDING**

Depois do loop de eventos presos, adicionar um segundo estágio:

```ts
    // Estágio 2: divergências. É isto que recupera evento PERDIDO — quando a
    // fila do Asaas é interrompida (15 falhas), os eventos são apagados em 14
    // dias e ninguém mais nos conta que a cobrança foi paga. Aqui perguntamos.
    const { data: pendingInvoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, provider_payment_id, status, amount_cents")
      .eq("provider", "asaas")
      .in("status", ["open", "draft"])
      .not("provider_payment_id", "is", null)
      .limit(200);

    const provider = getBillingProvider("asaas");
    let divergences = 0;

    for (const inv of pendingInvoices ?? []) {
      const res = await provider.getPayment(inv.provider_payment_id!);
      if (!res.ok || !res.data) continue;

      const remoteStatus = String(res.data.status ?? "");
      const isPaidRemotely = remoteStatus === "RECEIVED" || remoteStatus === "CONFIRMED";
      if (!isPaidRemotely) continue;

      divergences++;

      // Reconferir o valor. `value` do Asaas é em REAIS — comparar com
      // amount_cents sem converter é bug de 100x.
      const rawValue = res.data.value;
      const paidCents = typeof rawValue === "number" ? asaasValueToCents(rawValue) : null;

      await supabase
        .from("billing_invoices")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", inv.id)
        .neq("status", "paid");

      await supabase
        .from("billing_subscriptions")
        .update({ status: "active" })
        .eq("organization_id", inv.organization_id)
        .neq("status", "canceled")
        .neq("status", "active");

      await supabase
        .from("organizations")
        .update({ billing_status: "active", blocked_at: null, blocked_reason: null })
        .eq("id", inv.organization_id);

      // Item 3 dos herdados: alerta ao admin. Registro consultável no painel —
      // o DISPATCHER de e-mail é entrega da Fase 4b; até lá isto NÃO envia nada.
      await supabase.from("billing_notifications").insert({
        organization_id: inv.organization_id,
        event_type: "asaas_divergence_reconciled",
        channel: "app",
        recipient: "platform_admin",
        status: "logged",
      });

      jsonLog({
        evt: "asaas_reconcile_divergence",
        invoice_id: inv.id,
        organization_id: inv.organization_id,
        remote_status: remoteStatus,
        expected_cents: inv.amount_cents,
        paid_cents: paidCents,
      });
    }
```

Incluir `divergences` nos contadores do retorno.

- [ ] **Step 3: Adicionar a action de reprocessamento manual**

Em `manage-billing/index.ts`, junto das outras actions admin-only (o guard de `platform_admin` em `:204-207` já cobre — **não** adicionar a `CLIENT_FRIENDLY_ACTIONS`):

```ts
    // ── reprocess_billing_event (admin) ────────────────────────────────────────
    if (action === "reprocess_billing_event") {
      const eventId = String(body.billing_event_id ?? "");
      if (!eventId) {
        return jsonResponse(req, { error: "billing_event_id é obrigatório." }, 400);
      }

      const { data: row, error: fetchErr } = await supabase
        .from("billing_events")
        .select("id, provider, provider_event_id, event_type, data, organization_id")
        .eq("id", eventId)
        .maybeSingle();

      if (fetchErr || !row) {
        return jsonResponse(req, { error: "Evento não encontrado." }, 404);
      }
      if (row.provider !== "asaas") {
        return jsonResponse(req, { error: "Reprocessamento manual só está disponível para eventos Asaas." }, 400);
      }

      // Idempotente: applyAsaasEvent decide de novo a partir do estado ATUAL, e
      // todo UPDATE é condicional. Reprocessar um evento já aplicado é noop.
      const result = await applyAsaasEvent(supabase, {
        id: row.id,
        provider_event_id: row.provider_event_id,
        event_type: row.event_type,
        data: row.data,
        organization_id: row.organization_id,
      });

      await supabase
        .from("billing_events")
        .update({
          processing_status: result.status,
          organization_id: result.organizationId,
          error_message: result.error ?? null,
        })
        .eq("id", row.id);

      return jsonResponse(req, {
        success: true,
        status: result.status,
        effect: result.effect,
        organization_id: result.organizationId,
      });
    }
```

Adicionar o import de `applyAsaasEvent` no topo do arquivo.

- [ ] **Step 4: Atualizar o comentário obsoleto**

Substituir o bloco `process-asaas-reconcile/index.ts:22-26` (que diz que a consulta à API não existe porque nada cria cobrança Asaas) pela descrição do que o worker faz agora. O aviso de `:131-148` sobre "o reconcile precisa rodar a mesma lógica" passa a estar **satisfeito** — reescrever para registrar isso em vez de alertar.

- [ ] **Step 5: Verificar**

Run: `npx deno@2.1.4 check supabase/functions/process-asaas-reconcile/index.ts supabase/functions/manage-billing/index.ts`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/process-asaas-reconcile/index.ts supabase/functions/manage-billing/index.ts
git commit -m "feat(billing): reconcile Asaas aplica efeitos, detecta divergencia e aceita reprocesso manual"
```

---

### Task 10: Entitlements no cliente e cortesia visível

**Files:**
- Modify: `supabase/functions/manage-billing/index.ts` (action `get_org_entitlements` + whitelist)
- Modify: `src/hooks/useBilling.ts` (+ `useOrgEntitlements`)
- Modify: `src/pages/gestao/Cobranca.tsx`

**Interfaces:**
- Consumes: `resolveOrgEntitlements(supabase, organizationId)` de `../_shared/entitlements.ts`.
- Produces: `useOrgEntitlements(organizationId: string | null)` → `{ system, whatsapp, ai }`, cada um `{ allowed, source, status, expiresAt }`.

> **Leitura apenas.** Nenhum guard passa a bloquear nada aqui — enforcement é 4b, atrás de `entitlements_enforced`.

- [ ] **Step 1: Adicionar a action, moldando a resposta**

```ts
    // ── get_org_entitlements (client-friendly) ─────────────────────────────────
    if (action === "get_org_entitlements") {
      const orgId = String(body.organization_id ?? "");
      if (!orgId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
      if (!(await canManageOrgBilling(callerId, orgId))) {
        return jsonResponse(req, { error: "Acesso negado." }, 403);
      }

      const ent = await resolveOrgEntitlements(supabase, orgId);

      // Moldar: devolve só o que a UI precisa. `reason`, `granted_by` e
      // `grant_type` do override ficam no servidor — quem concedeu a cortesia e
      // por quê é informação interna da plataforma.
      const shape = (f: { allowed: boolean; source: string; status: string; expiresAt: string | null }) => ({
        allowed: f.allowed,
        source: f.source,
        status: f.status,
        expires_at: f.expiresAt,
      });

      return jsonResponse(req, {
        entitlements: {
          system: shape(ent.system),
          whatsapp: shape(ent.whatsapp),
          ai: shape(ent.ai),
        },
      });
    }
```

Adicionar `"get_org_entitlements"` ao `CLIENT_FRIENDLY_ACTIONS` e o import de `resolveOrgEntitlements`.

- [ ] **Step 2: Adicionar o hook**

Em `src/hooks/useBilling.ts`:

```ts
export interface FeatureEntitlementView {
  allowed: boolean;
  source: "admin_block" | "override" | "subscription" | "trial" | "wallet" | "legacy" | "none";
  status: string;
  expires_at: string | null;
}

export interface OrgEntitlementsView {
  system: FeatureEntitlementView;
  whatsapp: FeatureEntitlementView;
  ai: FeatureEntitlementView;
}

export function useOrgEntitlements(organizationId: string | null) {
  return useQuery<OrgEntitlementsView>({
    queryKey: ["org-entitlements", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const res = await invokeManageBilling({
        action: "get_org_entitlements",
        organization_id: organizationId,
      });
      return (res as { entitlements: OrgEntitlementsView }).entitlements;
    },
  });
}
```

- [ ] **Step 3: Esconder a oferta de quem tem cortesia**

Em `Cobranca.tsx`, adicionar o hook e derivar o estado:

```tsx
  const { data: entitlements } = useOrgEntitlements(organizationId ?? null);

  // Cortesia (LIFETIME/PROMOTIONAL etc. concedida por admin). Mostrar preço a
  // quem tem acesso vitalício gratuito gera dúvida sobre estar sendo cobrado.
  const isCourtesy = entitlements?.system.source === "override" && entitlements.system.allowed;
```

E trocar o bloco de "Planos disponíveis" (`:353-370`) por um condicional:

```tsx
      {isCourtesy ? (
        <Card>
          <CardHeader>
            <CardTitle>Acesso vitalício cortesia</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Sua conta tem acesso liberado por cortesia, sem cobrança. Não há
              nada a contratar nem a pagar.
            </p>
            {entitlements?.system.expires_at && (
              <p className="text-sm text-muted-foreground">
                Válido até {formatDateBR(entitlements.system.expires_at)}.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* bloco "Planos disponíveis" existente, sem alteração */}
        </div>
      )}
```

Garantir que `formatDateBR` está importado de `@/lib/utils`.

- [ ] **Step 4: Verificar**

Run: `npm run typecheck && npm run lint && npx deno@2.1.4 check supabase/functions/manage-billing/index.ts`
Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/manage-billing/index.ts src/hooks/useBilling.ts src/pages/gestao/Cobranca.tsx
git commit -m "feat(billing): expoe entitlements ao cliente e esconde oferta de quem tem cortesia"
```

---

### Task 11: Consertar o retorno do checkout

**Files:**
- Modify: `src/pages/gestao/Cobranca.tsx:61-81`

**Interfaces:**
- Consumes: `sub` (derivado existente na página).
- Produces: nenhum símbolo novo.

- [ ] **Step 1: Substituir o useEffect**

O atual dispara "Pagamento processado. Bem-vindo!" **incondicionalmente** após ~6s e ignora `?session=cancel`. Com Asaas o problema piora: o webhook do PIX pode chegar depois da janela.

```tsx
  // Pós-redirect do checkout: refetch até a assinatura aparecer.
  //
  // O webhook é quem ativa — a URL de retorno NÃO ativa nada (cenário 8). Por
  // isso a mensagem depende do estado REAL ter mudado, e não de o navegador ter
  // voltado com session=success. Com PIX a confirmação pode chegar depois desta
  // janela, e prometer "Bem-vindo!" nesse caso seria mentira.
  useEffect(() => {
    const session = searchParams.get("session");
    if (session !== "success" && session !== "cancel") return;

    const clearParams = () => {
      searchParams.delete("session");
      searchParams.delete("sid");
      setSearchParams(searchParams, { replace: true });
    };

    if (session === "cancel") {
      clearParams();
      toast.info("Checkout cancelado. Nenhuma cobrança foi feita.");
      return;
    }

    let attempts = 0;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      attempts++;
      const [detailResult] = await Promise.all([refetchDetail(), refetchPms()]);

      const activeSub = detailResult.data?.subscriptions?.find((s) => s.status !== "canceled");
      if (activeSub) {
        clearParams();
        toast.success("Pagamento confirmado. Bem-vindo!");
        return;
      }
      if (attempts < 6) {
        setTimeout(tick, 2000);
        return;
      }
      clearParams();
      toast.info(
        "Recebemos seu pagamento e estamos confirmando com o banco. " +
          "Pode levar alguns minutos — você não precisa pagar de novo.",
      );
    };

    tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get("session")]);
```

- [ ] **Step 2: Verificar**

Run: `npm run typecheck && npm run lint`
Expected: zero erros, nenhum warning novo.

- [ ] **Step 3: Commit**

```bash
git add src/pages/gestao/Cobranca.tsx
git commit -m "fix(billing): retorno do checkout trata cancel e so celebra com assinatura real"
```

---

### Task 12: Migration — ligar o plano

**Files:**
- Create: `supabase/migrations/20260719120000_066_activate_sistema_reservas.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- 066: Ativa o plano de assinatura do sistema.
--
-- A Fase 3 seedou os 9 produtos com active=false de propósito: nenhum checkout
-- os processava. A Fase 4a construiu o caminho Asaas, então este plano passa a
-- ser ofertável. Os demais (implantação WhatsApp, instância, pacotes de IA)
-- continuam inativos — cada fase liga o seu.
--
-- Idempotente: o UPDATE é naturalmente re-executável.
--
-- ROLLBACK:
--   update billing_plans set active = false where slug = 'sistema-reservas';

update billing_plans
set active = true,
    updated_at = now()
where slug = 'sistema-reservas'
  and active = false;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from billing_plans
  where slug = 'sistema-reservas' and active = true and provider = 'asaas';

  if v_count <> 1 then
    raise exception 'Esperava exatamente 1 plano sistema-reservas ativo com provider=asaas, encontrei %', v_count;
  end if;
end $$;
```

- [ ] **Step 2: Aplicar**

Run: `supabase db push`
Expected: migration aplicada sem erro. Se o `raise exception` disparar, o seed da Fase 3 não está como esperado — **parar e investigar**, não forçar.

- [ ] **Step 3: Validar por query**

```sql
select slug, name, amount_cents, interval, category, provider, active, recommended
from billing_plans
where active = true
order by sort_order;
```

Expected: exatamente 2 linhas — `trial-padrao` (provider `manual`) e `sistema-reservas` (R$ 449 = `amount_cents` 44900, provider `asaas`, category `SYSTEM_SUBSCRIPTION`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260719120000_066_activate_sistema_reservas.sql
git commit -m "feat(billing): ativa o plano sistema-reservas (R$ 449, Asaas)"
```

---

### Task 13: Deploy e validação ao vivo em sandbox

Nenhuma linha de código nova. É aqui que a fase prova que funciona.

**Files:** nenhum (operacional).

- [ ] **Step 1: Deploy das EFs**

`_shared/asaas-billing-events.ts` e `_shared/tax-id.ts` são novos; EFs não compartilham bundle em runtime, então todo importador precisa de redeploy.

```bash
supabase functions deploy asaas-webhook
supabase functions deploy process-asaas-reconcile
supabase functions deploy create-billing-checkout
supabase functions deploy manage-billing
supabase functions deploy manage-organizations
```

- [ ] **Step 2: Ligar o roteamento Asaas**

```sql
update platform_flags set value = '"asaas"'::jsonb where key = 'billing_provider_default';
```

Esperar **~5 minutos** — cada EF tem cache de flag de 5 min e o painel não limpa o cache das outras.

- [ ] **Step 3: Cenário 1 — trial de 5 dias**

Criar uma org de teste em `/platform/empresas` com CPF/CNPJ e e-mail de cobrança. Verificar:

```sql
select o.name, o.billing_status, o.trial_ends_at, o.billing_email, bc.tax_id
from organizations o
left join billing_customers bc on bc.organization_id = o.id
where o.slug = '<slug-de-teste>';
```

Expected: `billing_status='trialing'`, `trial_ends_at ≈ agora + 5 dias`, `billing_email` e `tax_id` preenchidos.

- [ ] **Step 4: Cenário 4/5 — pagamento PIX ativa a assinatura**

Entrar como owner da org de teste em `/g/<slug>/cobranca`, escolher o plano R$ 449, pagar por PIX no sandbox (botão **CONFIRMAR PAGAMENTO** no painel Asaas). Verificar:

```sql
select provider, event_type, processing_status, organization_id, error_message
from billing_events where provider = 'asaas' order by processed_at desc limit 10;

select o.billing_status, bs.status, bs.provider, bi.status, bi.amount_cents, bi.paid_at
from organizations o
left join billing_subscriptions bs on bs.organization_id = o.id
left join billing_invoices bi on bi.organization_id = o.id
where o.slug = '<slug-de-teste>';
```

Expected: evento `PAYMENT_RECEIVED` com `processing_status='processed'` e `organization_id` **preenchido** (não mais null); `organizations.billing_status='active'`; `billing_subscriptions.provider='asaas'`, `status='active'`; `billing_invoices.amount_cents = 44900` (**não** 4490000 — se for, o bug de 100x escapou).

- [ ] **Step 5: Cenário 7 — reenvio não ativa duas vezes**

No painel Asaas, reenviar o mesmo evento (Integrações → Logs de Webhooks). Verificar que `billing_events` **não** ganhou linha nova (dedupe `23505`) e que nada mudou de estado.

- [ ] **Step 6: Cenário 8 — a URL de retorno não ativa nada**

**O teste mais importante da fase, e nunca foi exercitado contra nada.** Iniciar um checkout, copiar a `successUrl`, **abandonar o pagamento**, e abrir a URL manualmente no navegador. Verificar:

```sql
select billing_status from organizations where slug = '<slug-de-teste>';
```

Expected: **inalterado** (`trialing`, não `active`). Se virou `active`, a ativação está vindo do frontend — bug crítico, parar a fase.

- [ ] **Step 7: Verificar a cortesia**

Entrar como owner do **Ren Sushi** em `/g/ren-sushi/cobranca`. Expected: card "Acesso vitalício cortesia", **sem** oferta de R$ 449 e sem botão de contratar.

- [ ] **Step 8: Registrar os resultados**

Anotar cada cenário como passou/falhou. Cenário que não rodou é registrado como **não rodado**, nunca como passou.

---

### Task 14: Documentação e fechamento

**Files:**
- Create: `docs/billing-asaas/FASE-4A-RESUMO.md`
- Modify: `CLAUDE.md`
- Modify: `docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md` (marcar 4a como concluída, 4b como próxima)

- [ ] **Step 1: Escrever o resumo da fase**

Seguindo o formato dos resumos 1–3: estado atual em tabela, o que foi entregue, verificação (com os resultados reais dos cenários), decisões que desviaram do plano e por quê, bugs pré-existentes encontrados, invariantes fixados, riscos residuais, o que mudou em produção, rollback, próxima fase. **Incluir o backfill pendente de `tax_id`/`billing_email` nas 3 orgs existentes.**

- [ ] **Step 2: Atualizar o CLAUDE.md**

Adicionar na seção Billing, no formato obrigatório (regra em 1 frase + porquê em 1 frase + ponteiro):

```markdown
- **Ativação de assinatura Asaas é `PAYMENT_CONFIRMED` OU `PAYMENT_RECEIVED`, o que chegar primeiro.** PIX/boleto nunca emite `CONFIRMED` (provado ao vivo), então gate só-CONFIRMED deixaria todo cliente de PIX pagando sem acesso — e funcionaria no cartão, escondendo o bug. Idempotência por `invoiceStatus='paid'` em [_shared/asaas-billing-events.ts](supabase/functions/_shared/asaas-billing-events.ts).
- **Webhook e reconcile compartilham `applyAsaasEvent` — nunca duplicar a lógica.** Se o reconcile classificar sem aplicar, marca como resolvido um evento que nunca ativou assinatura. [_shared/asaas-billing-events.ts](supabase/functions/_shared/asaas-billing-events.ts).
- **`getPayment`/`getSubscription` devolvem dinheiro em REAIS no Asaas e em centavos na Stripe, pela mesma interface.** O tipo é `Record<string, unknown>` e não protege; comparar com `amount_cents` sem `asaasValueToCents` é bug de 100x. [_shared/billing-provider.ts](supabase/functions/_shared/billing-provider.ts).
- **`_shared/tax-id.ts` ⇄ [src/lib/tax-id.ts](src/lib/tax-id.ts) são cópias com sincronia VERIFICADA POR TESTE** (`src/lib/tax-id.test.ts` importa as duas e roda o mesmo corpus). Diferente do `phone.ts`, cuja sincronia é só convencional.
- **Org nova nasce com `tax_id` e `billing_email` obrigatórios.** Sem CPF/CNPJ o Asaas recusa criar cliente e o checkout falha antes da primeira chamada de API. [manage-organizations/index.ts](supabase/functions/manage-organizations/index.ts).
```

E adicionar ao checklist de redeploy:

```markdown
- **`asaas-billing-events.ts`** → `asaas-webhook`, `process-asaas-reconcile`, `manage-billing`
- **`tax-id.ts`** → `manage-organizations`
- **`billing-provider.ts`** → `create-billing-checkout`, `asaas-webhook`, `process-asaas-reconcile`, `manage-billing`
```

- [ ] **Step 3: Rodar o checklist completo**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: lint 0 erros e **nenhum warning novo** (22 pré-existentes); typecheck 0 erros; testes todos verdes; build OK. **Não avançar com erro.**

- [ ] **Step 4: Commit e tag**

```bash
git add docs/billing-asaas/FASE-4A-RESUMO.md docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md CLAUDE.md
git commit -m "docs(billing): fecha a Fase 4a (assinatura via Asaas validada em sandbox)"
git tag billing-asaas/fase-4a
```

> ⚠️ **A tag e a branch têm nomes parecidos e isso já causou merge errado duas vezes.** Ao mergear, usar o **ref completo**: `git merge refs/heads/billing-asaas/fase-4`. Depois confirmar com `git log --oneline main..refs/heads/billing-asaas/fase-4` — tem que sair vazio.

---

## Cobertura da spec

| Requisito da spec | Task |
|---|---|
| Passo 0 — Sonda do sandbox (5 pendências) | 1 |
| Passo 1 — CPF/CNPJ e billing_email no onboarding | 2, 3 |
| Passo 2 — `asaas-billing-events.ts` (núcleo puro + aplicador) | 4, 5, 6 |
| Passo 3 — Checkout roteado por flag | 7 |
| Passo 4 — Webhook aplica o efeito | 8 |
| Passo 5 — Reconcile completo (4 itens herdados) | 9 |
| Passo 6 — Esconder oferta de quem tem cortesia | 10 |
| Passo 7 — Ligar o plano por migration | 12 |
| Passo 8 — `?session=cancel` + toast condicional | 11 |
| Testes unitários do núcleo puro | 2, 4, 5 |
| Cenários de sandbox (1, 4/5, 7, 8, cartão) | 13 |
| Invariantes de erro (200/503, valores do banco, conversão, idempotência) | 6, 8, e Global Constraints |
| Rollback documentado | 12, 14 |
| Checklist de fim de fase | 14 |

**Fora de escopo (registrado na spec, vai pra 4b):** `manage-billing.change_plan` ciente de Asaas; vazamento cross-tenant em `process-billing-reminders:77-84`; entitlements enforced nos 3 guards; grace 5d/suspensão D+6 em BRT; `valid_until` de `billing_access_overrides`; `suspended` ausente de `process-billing-unblock`; divergência de `canceled`; `organizations.plan` órfã.
