# Asaas — fatos verificados na documentação oficial

> Levantado em **2026-07-16** contra as páginas ao vivo de `docs.asaas.com`. O plano da Fase 2 exige confirmar URLs e nomes de evento na doc oficial **antes de codar** — este arquivo é o resultado dessa verificação e a **fonte de verdade para implementação**.
>
> Regra: o que está marcado **NÃO VERIFICADO** não vira código sem checar antes. Reconfirmar este arquivo antes do cutover de produção (Fase 11).

---

## 1. Webhook — autenticação

- **Header: `asaas-access-token`**, enviado em toda requisição. Confirmado em 3 páginas independentes (EN + PT).
- **NÃO existe HMAC / assinatura de payload.** É token estático compartilhado — o oposto da Stripe. A página do fluxo de saque (o mais sensível da Asaas) confirma que o único mecanismo é esse header.
- Token configurado no painel ou via `POST /v3/webhooks` (campo `authToken`): **32–255 chars**, sem espaços, não pode ser sequência previsível nem uma API key do Asaas. Se omitido na criação via API, o Asaas gera — e **o valor só é retornado na criação** (não dá pra recuperar depois).
- Consequência de design: comparação **tempo-constante** contra `asaas_webhook_token` (padrão `constantTimeEquals` de `_shared/security.ts`). Sem verificação de assinatura pra implementar.

## 2. Webhook — semântica de entrega (armadilhas reais)

| Fato | Consequência |
|---|---|
| **Só HTTP 200 conta como sucesso.** 201/204 e qualquer outro 2xx são tratados como **falha**. | O handler DEVE responder exatamente `200`. Um `204 No Content` (padrão comum) quebraria a entrega silenciosamente. |
| **Timeout de 10 segundos.** | Persistir e responder rápido; processar sem segurar a resposta. Reforça o persist-before-process. |
| **15 falhas consecutivas → fila interrompida** (`interrupted: true`), entrega para. | Bug no handler = fila morre. Só avisa por e-mail. |
| **Eventos ficam na fila 14 dias e depois são apagados PERMANENTEMENTE.** | Fila interrompida e não notada em 14 dias = perda definitiva de eventos de pagamento. O worker de reconcile existe pra isso. |
| **Entrega "at least once"** — o mesmo evento pode chegar 2x. | Dedupe obrigatório por `id` do evento. |
| Reativação: painel ou `interrupted: false` via API. Pendentes são reprocessados em ordem cronológica. | Runbook da Fase 11. |

`sendType`: `SEQUENTIALLY` (ordem garantida, evento lento atrasa os seguintes) ou `NON_SEQUENTIALLY` (concorrente, sem ordem). Máx. **10 webhooks por conta**.

## 3. Webhook — shape do payload

```json
{
  "id": "evt_05b708f961d739ea7eba7e4db318f621&368604920",
  "event": "PAYMENT_RECEIVED",
  "dateCreated": "2024-06-12 16:45:03",
  "payment": { "object": "payment", "id": "pay_080225913252" }
}
```

- **`id` = chave de idempotência** → vai em `billing_events.provider_event_id`. Formato `evt_<32 hex>&<numérico>`: **contém um `&` literal**. Tratar como **string opaca** — nunca dar split em `&`, nunca assumir UUID, nunca passar por parse de query string.
- `dateCreated`: `"YYYY-MM-DD HH:mm:ss"`, **sem timezone**. Não é ISO. Não jogar direto em `new Date()` esperando UTC.
- **O shape NÃO é uniforme entre categorias.** Evento de checkout traz `account.id` no topo e o objeto `checkout` inteiro; o exemplo de payment aninha só `{object, id}`. Não assumir shape compartilhado além de `id` / `event` / `dateCreated` + uma chave de entidade.
  - **NÃO VERIFICADO:** se o evento de payment traz o objeto completo ou só o stub `{object, id}` (o exemplo da doc pode estar abreviado). **Confirmar com payload real do sandbox.** De qualquer forma, a regra §19 da spec ("valores sempre do banco") já manda não confiar em valor vindo do payload — reconferir via `getPayment` quando o valor importar.
  - **NÃO VERIFICADO:** shape exato do payload de `SUBSCRIPTION_*`.

## 4. Eventos — nomes exatos

### `PAYMENT_*` (lista completa)
`PAYMENT_CREATED` · `PAYMENT_AWAITING_RISK_ANALYSIS` · `PAYMENT_APPROVED_BY_RISK_ANALYSIS` · `PAYMENT_REPROVED_BY_RISK_ANALYSIS` · `PAYMENT_AUTHORIZED` · `PAYMENT_UPDATED` · `PAYMENT_CONFIRMED` · `PAYMENT_RECEIVED` · `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` · `PAYMENT_ANTICIPATED` · `PAYMENT_OVERDUE` · `PAYMENT_DELETED` · `PAYMENT_RESTORED` · `PAYMENT_REFUNDED` · `PAYMENT_PARTIALLY_REFUNDED` · `PAYMENT_REFUND_IN_PROGRESS` · `PAYMENT_REFUND_DENIED` · `PAYMENT_RECEIVED_IN_CASH_UNDONE` · `PAYMENT_CHARGEBACK_REQUESTED` · `PAYMENT_CHARGEBACK_DISPUTE` · `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` · `PAYMENT_DUNNING_RECEIVED` · `PAYMENT_BANK_SLIP_CANCELLED` · `PAYMENT_DUNNING_REQUESTED` · `PAYMENT_BANK_SLIP_VIEWED` · `PAYMENT_CHECKOUT_VIEWED` · `PAYMENT_SPLIT_CANCELLED` · `PAYMENT_SPLIT_DIVERGENCE_BLOCK` · `PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED`

> Atenção ao "CHARGEBACK_*" do plano: os nomes reais são `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE` e `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` — este último **não** casa com o prefixo `PAYMENT_CHARGEBACK_`. Matching por prefixo cru erraria.

### `SUBSCRIPTION_*` (lista completa)
`SUBSCRIPTION_CREATED` · `SUBSCRIPTION_UPDATED` · `SUBSCRIPTION_INACTIVATED` · `SUBSCRIPTION_DELETED` · `SUBSCRIPTION_SPLIT_DISABLED` · `SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK` · `SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK_FINISHED`

> **Não existe `SUBSCRIPTION_CANCELED`.** Cancelamento aparece como `SUBSCRIPTION_DELETED` / `SUBSCRIPTION_INACTIVATED`.

### `CHECKOUT_*` (lista completa)
`CHECKOUT_CREATED` · `CHECKOUT_CANCELED` · `CHECKOUT_EXPIRED` · `CHECKOUT_PAID`

> O plano cita `CHECKOUT_PAID/CANCELED/EXPIRED` — confirmados. `CHECKOUT_CREATED` também existe.

Total do enum na API: **111 valores** (inclui Pix, transferências, notas fiscais, movimentações internas — fora do escopo da Fase 2).

## 5. `PAYMENT_CONFIRMED` vs `PAYMENT_RECEIVED` — decisão de negócio da Fase 4

Citação literal da doc:

- **`PAYMENT_CONFIRMED`**: "Cobrança confirmada (pagamento efetuado, porém, **o saldo ainda não foi disponibilizado**)"
- **`PAYMENT_RECEIVED`**: "Cobrança recebida. (**Valor disponível na conta Asaas**)"

Fluxo documentado no cartão: `PAYMENT_CREATED` → `PAYMENT_CONFIRMED` → `PAYMENT_RECEIVED` **até ~30 dias depois** (ciclo de liquidação). No Pix, os dois são quase simultâneos.

### ⚠️ CORRIGIDO POR TESTE AO VIVO — 2026-07-18

A frase acima ("no Pix, os dois são quase simultâneos") **está errada**. Teste real no sandbox (cobrança PIX/boleto → botão "CONFIRMAR PAGAMENTO", com `PAYMENT_CONFIRMED` marcado no webhook) entregou **exatamente 2 eventos**:

```
PAYMENT_CREATED   evt_05b708f961d739ea7eba7e4db318f621&17319022   21:53:32
PAYMENT_RECEIVED  evt_d26e303b238e509335ac9ba210e51b0f&17319023   21:53:40
```

**`PAYMENT_CONFIRMED` não disparou.** Não é "quase simultâneo" — não veio. Coerente com a semântica: liquidação de PIX/boleto é imediata, então não existe o estado intermediário "pago mas saldo indisponível" que o `CONFIRMED` representa.

**Implicação — muda a decisão da Fase 4:** o gate de acesso **NÃO pode ser só `PAYMENT_CONFIRMED`**. Se fosse, todo cliente pagando por PIX ou boleto (a maioria no Brasil) pagaria e **nunca teria o acesso liberado**, porque o evento escutado jamais chegaria. Bug silencioso e enganoso, porque no cartão funcionaria normalmente.

**Regra correta:** ativar no **`PAYMENT_CONFIRMED` OU `PAYMENT_RECEIVED`, o que chegar primeiro**, com idempotência por assinatura/invoice pra não ativar duas vezes quando o cartão mandar os dois. `PAYMENT_RECEIVED` continua sendo o único que significa dinheiro liquidado — relatório financeiro usa só ele.

**Ressalva honesta:** o disparo veio do botão de simulação do sandbox. Não dá pra descartar que uma liquidação PIX real emita `CONFIRMED` antes. Mas a regra "CONFIRMED ou RECEIVED" é correta nos dois cenários, então não depende de resolver essa dúvida.

**Ainda não observado ao vivo:** o fluxo de cartão (`CREATED` → `CONFIRMED` → `RECEIVED` ~30d depois).

## 6. Sandbox

- Host da API: `api-sandbox.asaas.com` (vs `api.asaas.com` em produção).
- **Webhook Logs**: Menu do usuário → Integrações → Webhook Logs — mostra requisição enviada, status devolvido pelo servidor e payload. É a ferramenta de debug.
- Simulação de recebimento: ações "Confirmar recebimento em dinheiro" / "Desfazer confirmação de recebimento em dinheiro" (verificadas). Botão "CONFIRMAR PAGAMENTO" pós-criação de boleto/Pix — **NÃO VERIFICADO** (capacidade corroborada, label exato não).
- Sem diferença documentada de retry/timeout/threshold entre sandbox e produção.

## 7. Fontes

Páginas efetivamente buscadas ao vivo:

`docs.asaas.com/docs/`: about-webhooks · payment-events · subscription-events · checkout-events · receive-asaas-events-at-your-webhook-endpoint · receba-eventos-do-asaas-no-seu-endpoint-de-webhook · create-new-webhook-via-web-application · create-new-webhook-via-api · send-types · duvidas-frequentes-webhooks · fila-pausada · webhooks-queue-paused · erro-read-timed-out · como-reativar-fila-interrompida · mecanismo-para-validacao-de-saque-via-webhooks · webhook-para-cobrancas · testando-no-sandbox · como-testar-funcionalidades · o-que-pode-ser-testado
`docs.asaas.com/reference/`: create-new-webhook

---

# REST API

## 8. Base URLs e autenticação

| Ambiente | Base URL |
|---|---|
| Produção | `https://api.asaas.com/v3` |
| Sandbox | `https://api-sandbox.asaas.com/v3` |

Confirma a suposição do plano. (`sandbox.asaas.com` como host de API aparece em blog de terceiro — **não** é o host atual da API; é o host do painel.)

- **Header de auth: `access_token`** — valor cru, **sem `Bearer`**, **não** é `Authorization`. Diferente da Stripe.
- **`Content-Type: application/json`** (a Stripe usa form-urlencoded — não copiar o `URLSearchParams` do `stripe-billing.ts`).
- **`User-Agent` é OBRIGATÓRIO** em contas raiz criadas a partir de **13/06/2024**. Deno `fetch` não manda `User-Agent` por padrão → **precisa ser explícito** ou a API rejeita.
- **Prefixos de chave: produção `$aact_prod_...` · sandbox `$aact_hmlg_...`**
- Erros de auth (todos HTTP 401): `access_token_not_found` · `invalid_access_token_format` (não casa com os prefixos) · `invalid_access_token` · **`invalid_environment`** (chave de prod no host de sandbox ou vice-versa).

> ⚠ **O prefixo de ambiente só existe em chaves geradas a partir de 10/03/2025.** (Changelog do Asaas, publicado 25/02/2025.) Chaves anteriores continuam válidas no formato antigo `$aact_YTU5...` — hash direto após `$aact_`, **sem segmento `prod`/`hmlg`** — e **não são migradas automaticamente**.
>
> **Consequência de design (não ignorar):** validação por prefixo é **de 3 estados**, não booleana:
> 1. prefixo conhecido **e** casa com o env → ok
> 2. prefixo conhecido **e** não casa (ex.: `$aact_prod_` com `ASAAS_ENV=sandbox`) → **erro duro**, falha cedo com mensagem clara (melhor que 401 `invalid_environment` no meio de um checkout)
> 3. prefixo **desconhecido/legado** → **indeterminado: NÃO bloquear.** A chave pode ser legítima e antiga. Deixa passar e loga aviso; quem decide é a API (401 `invalid_environment`).
>
> Tratar o caso 3 como erro rejeitaria chave legada válida. A garantia real de ambiente vem da API, não do prefixo — o prefixo é só um atalho pra falhar cedo no caso 2.

## 9. Endpoints

**Customers** — `POST/GET/PUT /v3/customers[/{id}]`. **Obrigatórios: `name` + `cpfCnpj`.** `externalReference` = id no nosso sistema. Resposta `id`: `cus_000005401844`.
> **`cpfCnpj` é obrigatório** — a interface `CreateCustomerParams.taxId` é opcional (Stripe não exige). O `AsaasBillingProvider` precisa validar presença e devolver erro claro em PT-BR. `billing_customers.tax_id` já existe (nullable) mas está vazio nas orgs atuais; **a Fase 4 tem que coletar CNPJ no cadastro** — `organizations` não tem coluna de documento.

**Payments** — `POST /v3/payments` (obrigatórios: `customer`, `billingType`, `value`, `dueDate` `YYYY-MM-DD`). `billingType`: `UNDEFINED` · `BOLETO` · `CREDIT_CARD` · `PIX`. `description` máx 500. `id`: `pay_...` alfanumérico (**não** só numérico — string opaca).
- `status` (14): `PENDING` `RECEIVED` `CONFIRMED` `OVERDUE` `REFUNDED` `RECEIVED_IN_CASH` `REFUND_REQUESTED` `REFUND_IN_PROGRESS` `CHARGEBACK_REQUESTED` `CHARGEBACK_DISPUTE` `AWAITING_CHARGEBACK_REVERSAL` `DUNNING_REQUESTED` `DUNNING_RECEIVED` `AWAITING_RISK_ANALYSIS`
- Pix QR: `GET /v3/payments/{id}/pixQrCode` → `{ encodedImage (PNG base64), payload (copia-e-cola), expirationDate }`
- Página hospedada da fatura: campo `invoiceUrl`; boleto PDF: `bankSlipUrl`
- Refund: `POST /v3/payments/{id}/refund` body `{ value?, description? }` (sem `value` = total)
- `DELETE /v3/payments/{id}` — a doc avisa: **deletar ≠ estornar**

**Subscriptions** — `POST /v3/subscriptions` (obrigatórios: `customer`, `billingType`, `value`, `nextDueDate`, `cycle`). `cycle`: `WEEKLY` `BIWEEKLY` `MONTHLY` `BIMONTHLY` `QUARTERLY` `SEMIANNUALLY` `YEARLY`. `id`: `sub_...`. **`status` só tem 3 valores: `ACTIVE` · `EXPIRED` · `INACTIVE`** (`EXPIRED` é read-only, setado pelo sistema).

> **Não existe `cancel_at_period_end` no Asaas.** A porta `cancelSubscription(id, atPeriodEnd)` foi desenhada em cima da semântica da Stripe. Mapeamento adotado na Fase 2:
> - `atPeriodEnd = true` → `PUT /v3/subscriptions/{id}` `{status:"INACTIVE"}` — para de gerar cobranças futuras, preserva o registro e as cobranças já emitidas. O acesso do período pago continua governado pelo nosso `billing_subscriptions.current_period_end`, não pelo Asaas.
> - `atPeriodEnd = false` → `DELETE /v3/subscriptions/{id}` — encerra e **remove as cobranças pendentes/vencidas em aberto**.
>
> `cancel_subscription_by_owner` (CLAUDE.md) sempre usa `atPeriodEnd=true`, então o caminho do cliente cai no `INACTIVE` — não destrutivo. **Validar empiricamente no sandbox antes da Fase 4** (é dinheiro).

**Checkout (página hospedada)** — `POST /v3/checkouts`. É o produto certo pro nosso caso (sessão por pedido + callback), **não** `/v3/paymentLinks` (link reutilizável, produto mais antigo; ambos ativos).
- `billingTypes[]`: **só `CREDIT_CARD` e `PIX`** (sem BOLETO no checkout)
- `chargeTypes[]`: `DETACHED` · `RECURRENT` · `INSTALLMENT`
- `callback` (obrigatório): `{ successUrl (obrig.), cancelUrl (obrig.), expiredUrl? }` ← é aqui que o retorno é configurado
- `items[]`: `name` (máx 30) · `quantity` · `value` · `description?` (máx 150). **⚠ o array `required` do OpenAPI lista `imageBase64` como obrigatório** — restrição estranha, **NÃO VERIFICADO em runtime**. **Testar no sandbox antes da Fase 4**; se for real, precisamos de uma imagem embutida por item.
- `subscription` obrigatório se `chargeTypes` inclui `RECURRENT`; `minutesToExpire` 10–1440; `externalReference` máx 200
- Resposta: `id` é **UUID** (não tem prefixo `chk_`), `link` = URL hospedada, `status`: `ACTIVE` `CANCELED` `EXPIRED` `PAID`

## 9.1 ⚠ UNIDADE MONETÁRIA — `value` é em REAIS DECIMAIS, não em centavos

**O invariante mais perigoso desta integração.** Nosso código inteiro fala `amountCents` (inteiro). O Asaas fala **reais decimais**.

Prova (doc oficial, `criando-uma-assinatura`): `"value": 19.90` para uma assinatura de R$ 19,90 — ponto decimal é impossível se a unidade fosse centavo inteiro (seria `1990`). Corroborado em `criar-uma-cobranca-parcelada` ("valor total de R$ 350,00 … totalizando R$: 350.00"), `cobrancas-via-boleto` (`"value": 100.00`), `estornar-cobranca` (`"value": 2.00`), `split-de-pagamentos` ("cobrança de R$100,00 … valor líquido R$98,00").

> **Mandar `44900` (centavos de R$ 449,00) cobra R$ 44.900,00 do cliente. 100x.**

**Conversão obrigatória na fronteira** (é o `AsaasBillingProvider` quem converte — o cliente HTTP `asaas.ts` passa `value` cru de propósito, com o nome do campo do Asaas, pra não fingir unidade que não tem):
- enviando: `value = amountCents / 100`
- lendo de volta: `amountCents = Math.round(value * 100)` (o `Math.round` evita drift de float — `19.90 * 100 === 1989.9999999999998` em IEEE 754; truncar daria `1989`, um centavo a menos)

**Campos em reais** (mesma unidade de `value`): `netValue` · `originalValue` · `installmentValue` · `totalValue` · `split[].fixedValue` · `items[].value` · `value` do refund.

**Armadilhas — NÃO converter estes:**
| Campo | Unidade real |
|---|---|
| `interest.value` | **SEMPRE percentual** (% ao mês). Não existe `type` — não dá pra usar valor fixo. Mandar `2` = 2%/mês, não R$ 2. |
| `discount.value` / `fine.value` | **Depende do irmão `type`**: `FIXED` → reais; `PERCENTAGE` → percentual. Mesmo nome de campo, unidade diferente. |
| `split[].percentualValue` | Percentual, **4 casas** decimais (ex.: `92.3444`) — distinto de `fixedValue` (reais, 2 casas). |

**NÃO VERIFICADO:**
- `items[].value` do checkout: só aparece como `"value": 100` (sem decimal) nas páginas — sem "prova decisiva" decimal. É o mesmo nome/padrão de todos os outros `value` da API e nada sugere unidade diferente, mas **testar `19.90` no sandbox antes de produção**.
- Comportamento com mais de 2 casas decimais (ex.: `19.999`) — nenhuma página documenta arredondamento ou erro de validação.
- A descrição de `fine.value` na doc diz "Percentual de multa..." mesmo existindo `type: FIXED` no enum — prosa e enum se contradizem. Confirmar no sandbox.

## 10. Rate limit e erros

- Headers: `RateLimit-Limit` · `RateLimit-Remaining` · `RateLimit-Reset` (segundos até reset). `Remaining: 0` → **429**.
- **Não existe `Retry-After`** (confirmado ausente) → o backoff é nosso; dá pra usar o `RateLimit-Reset` quando presente.
- Quota da conta: **25.000 req / 12h** (janela deslizante). Máx **50 GETs concorrentes** (excedeu = 429).
- Shape do erro: `{ "errors": [ { "code": "invalid_object", "description": "O campo items deve ser informado." } ] }` — extrair `errors[0].description` (a Stripe usa `error.message`; **não** copiar).

## 11. Idempotência — não existe do lado da API

**Não há header `Idempotency-Key`** para POST/PUT (confirmado ausente, não apenas "não checado"). Diferente da Stripe. Consequências:
- **POST não é retry-safe.** Um retry cego de `POST /v3/payments` que deu timeout pode gerar cobrança duplicada. O retry automático do cliente HTTP deve valer para **GET** e para falhas de conexão onde nada foi enviado — **nunca** repetir POST de criação às cegas.
- Dedupe é nosso: `externalReference` (não é UNIQUE no lado deles) + check-before-create, ou padrão outbox.
- A idempotência que o Asaas documenta é só do lado **receptor de webhook** (dedupe pelo `id` do evento) — que é o que a UNIQUE `(provider, provider_event_id)` já cobre.

## 12. Fontes (REST)

`docs.asaas.com/docs/`: autenticação-1 · authentication-2 · checkout-asaas · criando-um-link-de-pagamentos · erros-comuns-e-boas-práticas
`docs.asaas.com/reference/`: comece-por-aqui · criar-novo-cliente · list-customers · retrieve-a-single-customer · update-existing-customer · criar-nova-cobranca · listar-cobrancas · recuperar-uma-unica-cobranca · obter-qr-code-para-pagamentos-via-pix · refund-payment · delete-payment · criar-nova-assinatura · list-subscriptions · retrieve-a-single-subscription · update-existing-subscription · remover-assinatura · create-new-checkout · rate-e-quota-limit

## 13. Pendências pra validar no sandbox (Fase 2/4)

1. `imageBase64` é mesmo obrigatório em `items[]` do checkout?
2. Payload de `PAYMENT_*` traz o objeto completo ou só `{object, id}`?
3. Payload de `SUBSCRIPTION_*` — shape exato.
4. `PUT {status:"INACTIVE"}` se comporta como esperado (para cobrança futura, preserva as emitidas)?
5. Label exato do botão de simular pagamento no sandbox.
