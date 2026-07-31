# BUG — `externalReference` de cobrança avulsa excede o limite do Asaas Payments

> **Status: BUG REAL, DORMENTE, NÃO CORRIGIDO.** Descoberto em 2026-07-31 durante a Tentativa 2
> do sandbox da Fase 5b ([FASE-5B-ROTEIRO-SANDBOX.md §0.8](FASE-5B-ROTEIRO-SANDBOX.md)).
> **Não corrigir sem spec própria** — o valor participa de correlação financeira e de
> compatibilidade com eventos já emitidos. Prioridade alta: bloqueia a exposição futura da
> cobrança avulsa.

## 1. O defeito

[`buildExternalReference`](../../supabase/functions/_shared/asaas-billing-events.ts) produz

```
org:<uuid>|plan:<uuid>|purpose:<purpose>
```

que, com um plano de verdade e `purpose: subscription`, tem **103 caracteres**. O endpoint
`POST /v3/payments` do Asaas aceita no máximo **100**.

O JSDoc da função afirma o contrário:

> *"Cabe no limite de 200 chars de `externalReference` (§9): 3 UUIDs + rótulos ≈ 110."*

São dois erros na mesma frase: o limite deste endpoint não é 200, e a conta de 110 já estouraria
um limite de 100 se alguém tivesse conferido contra o endpoint certo.

**`/v3/checkouts` tolera o formato atual** — é por isso que todos os checkouts da Fase 5a/5b
passaram e o defeito ficou invisível. O limite menor é do endpoint de cobrança.

## 2. Evidência

Chamada única, Asaas Sandbox, 2026-07-31 18:14:44 UTC:

```
POST https://api-sandbox.asaas.com/v3/payments
→ HTTP 400

invalid_externalReference
  Property [externalReference] of class [{1}] with value
  [org:a705c2e2-...|plan:daa3de8a-...|purpose:subscription]
  exceeds the maximum size of [100]
```

| medida | valor |
|---|---|
| comprimento emitido | **103** (`length(...)` medido em SQL) |
| limite do endpoint | **100** |
| cobrança criada | **nenhuma** — `GET /v3/payments?customer=…` devolveu `totalCount: 0` |

Composição dos 103: `org:` (4) + UUID (36) + `\|plan:` (6) + UUID (36) + `\|purpose:` (9) +
`subscription` (12).

## 3. Impacto

- [`createOneTimeCharge`](../../supabase/functions/_shared/billing-provider.ts) do adapter Asaas
  **falharia com 400 na primeira utilização real** com plano. Não é um caso de borda: acontece
  para **qualquer** organização e **qualquer** plano, porque dois UUIDs são sempre 72 caracteres.
- **O adapter não tem caller ativo hoje** — nenhuma Edge Function chama `createOneTimeCharge`
  (verificado: zero call sites fora dos próprios arquivos de adapter). Por isso o bug está
  dormente. Ele acorda no dia em que alguém expuser cobrança avulsa (recarga de IA, taxa avulsa,
  cobrança manual pelo painel).
- **`plan:none` não é contorno aceitável.** Sem o plano, `isSystemInvoice` perde o vínculo do
  caminho 2 e cai no caminho 3 — "ausência de vínculo ⇒ `true` por compatibilidade legada". Uma
  cobrança de `WHATSAPP_SUBSCRIPTION` passaria a ser classificada como fatura **de sistema**, e o
  worker de inadimplência bloquearia a organização inteira por uma fatura da instância de
  WhatsApp. É exatamente a regressão que a Fase 5a existiu para matar.
  Ver [_shared/billing-category.ts](../../supabase/functions/_shared/billing-category.ts).

## 4. Por que não corrigir agora

O `externalReference` é o degrau 3 da escada de correlação
([billing-correlation-core.ts](../../supabase/functions/_shared/billing-correlation-core.ts)) e
já viaja em eventos, checkouts e faturas emitidos. Encurtar o formato sem plano de convivência
quebra a leitura das referências antigas — e o parser é justamente o que impede uma cobrança
paga de ficar órfã.

## 5. O que a spec da correção precisa definir

1. **Formato versionado** — um prefixo curto que distinga o formato novo do atual.
2. **Teto de 100 caracteres**, validado por teste, não por comentário.
3. **Preservação de organização, `purpose` e plano** — os três, sem sacrificar nenhum.
4. **Codificação compacta e determinística** (por exemplo UUID sem hífens, ou base curta), com a
   mesma entrada produzindo sempre a mesma saída.
5. **Parser compatível com referências antigas** — o formato atual continua sendo lido.
6. **Comportamento explícito para `plan:none`**, incluindo a garantia do item 8.
7. **Prevenção de colisões** — e a decisão explícita sobre se o valor deve ou não ser único,
   dado que hoje ele é rótulo de contexto e a identidade financeira é
   `(provider, provider_payment_id)`.
8. **Garantia de que a ausência de plano não transforma fatura de WhatsApp em fatura de sistema**
   — travada por teste, não por convenção.
9. **Testes de round-trip** `build` → `parse` para todos os purposes.
10. **Testes contra os dois endpoints** — checkout e payment têm limites diferentes, e foi
    exatamente essa diferença que escondeu o defeito.
11. **Fallback seguro para referências desconhecidas** — nunca correlacionar por adivinhação.
12. **Estratégia de rollout sem quebrar eventos já existentes**, incluindo a ordem de deploy dos
    consumidores listados no checklist de `asaas-billing-events.ts` no `CLAUDE.md`.
