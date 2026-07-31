# Follow-up — tornar o sandbox de inadimplência reproduzível

> **Status: DECISÃO FUTURA REGISTRADA, NADA IMPLEMENTADO.** Aberto em 2026-07-31, ao encerrar
> o ensaio da Fase 5b. Precisa de spec própria (`superpowers:brainstorming` → plano) antes de
> qualquer código. **Nenhuma das opções abaixo está escolhida** — o documento existe para que a
> escolha seja feita de propósito, com as invariantes na mesa.

## 1. O problema

A Fase 5b entrega suspensão da instância de WhatsApp por inadimplência. O comportamento crítico
— **D+6 suspende, pagamento restaura** — nunca foi observado ponta a ponta, porque **o cenário
material não é construível no Asaas Sandbox**:

| barreira | evidência |
|---|---|
| **Nenhum objeto aceita vencimento retroativo nesta conta** | *"Não é permitido data de vencimento inferior a hoje."* — mesma mensagem na assinatura (painel) e em `POST /v3/payments` (HTTP 400), 2026-07-31 |
| `POST /v3/payments` não aceita `subscription` | contrato da API — barreira secundária: a cobrança nem chega a existir |
| Logo, fatura interna nasceria com `billing_subscription_id = null` | `resolvedSubscriptionId` só vem do campo `subscription` do payload |
| O gate filtra por `billing_subscription_id` | [whatsapp-service-gate.ts:160](../../supabase/functions/_shared/whatsapp-service-gate.ts) |
| Segunda assinatura violaria a unicidade | índice parcial da [migration 071](../../supabase/migrations/20260726100000_071_whatsapp_implementations.sql) |
| Ciclo natural | próxima cobrança da fixture só em 2026-08-31 — **única forma comprovada de obter atraso real** |

A barreira principal é a **data de vencimento**, não o vínculo com assinatura: as duas tentativas
foram recusadas antes mesmo de a cobrança existir. Escopo: comportamento comprovado **nesta conta
e neste Sandbox**, não afirmado como regra universal do Asaas.

Registro completo em [FASE-5B-ROTEIRO-SANDBOX.md §0.8](FASE-5B-ROTEIRO-SANDBOX.md).

**O custo de não resolver isto:** `whatsapp_service_enforcement` é uma flag que, quando ligada,
corta o WhatsApp de um cliente pagante. Hoje ela só pode ser ligada às cegas ou esperando um mês.
Nenhuma das duas é aceitável para um mecanismo com esse poder.

## 2. A distinção que precisa ficar explícita

Boa parte da confusão desta fase veio de tratar como um teste só o que são **três testes com
requisitos diferentes**:

| teste | pergunta | precisa de Asaas real? |
|---|---|---|
| **Teste de provider** | O Asaas se comporta como documentamos? | **sim** — é o ponto |
| **Teste de ingestão** | Um pagamento do provedor vira a fatura interna certa? | sim, mas só de um pagamento qualquer |
| **Teste de enforcement** | Dado o estado financeiro X, o gate faz Y? | **não** — depende só do estado do banco |

O enforcement foi bloqueado por uma limitação de **provider**, quando na verdade ele não deveria
depender do provider para ser validado. Qualquer solução deste follow-up passa por separar esses
três níveis.

## 3. Opções a avaliar (nenhuma escolhida)

1. **Suporte oficial do Asaas Sandbox para simular atraso de assinatura.** Verificar se existe
   endpoint, alavanca de painel ou modo de teste que produza uma cobrança vencida numa assinatura.
   Se existir, é a solução mais fiel e as outras viram desnecessárias. **Investigar primeiro.**
2. **Clock controlado ou provider fake no ambiente de teste.** Injetar o "hoje" em vez de ler
   `current_date`, ou substituir o adapter Asaas por um duplo em ambiente de teste. Avaliar o
   risco de o clock injetável vazar para produção.
3. **Adapter sandbox que preserve `provider_subscription_id`.** Um caminho de criação de cobrança,
   exclusivo de ambiente não-produtivo, que popule o vínculo de assinatura que o Asaas não popula.
   Avaliar como impedir que exista em produção.
4. **Fixture de fatura assinada criada apenas em banco local/staging.** Inserir a fatura vencida
   direto no banco — **jamais em produção**. É o caminho mais barato e o mais perigoso: precisa de
   uma barreira dura, não de disciplina.
5. **Testes de contrato do gate sobre o núcleo puro.** `decideWhatsAppGate` já é testado; o que
   falta é provar a **fiação** (as duas queries idênticas de `resolveWhatsAppGateByOrg` e
   `process-whatsapp-enforcement`, ver invariante no `CLAUDE.md`). Um teste de contrato sobre um
   banco de teste cobriria isso sem tocar no provedor.
6. **Ambiente de staging com dados sintéticos.** Hoje não existe — é a causa raiz de metade das
   dificuldades desta fase, e o pré-requisito de várias opções acima. Custo real, benefício amplo.
7. **Mecanismo administrativo explicitamente auditado para cenários de billing.** Uma action
   admin que force estado financeiro, registrando quem, quando e por quê — na linha do
   `release_invoice_enforcement_hold`. Avaliar se o poder concedido compensa o risco.

## 4. Restrições que qualquer solução precisa respeitar

- **Nunca em produção.** Nem fixture, nem clock injetado, nem adapter de teste, nem action de
  forçar estado. A barreira precisa ser estrutural (ambiente, build, migration), não convenção.
- **Não pode enfraquecer a correlação.** A escada de correlação
  ([billing-correlation-core.ts](../../supabase/functions/_shared/billing-correlation-core.ts))
  existe porque o `externalReference` não propaga. Um atalho de teste que preencha o vínculo por
  fora não pode virar o caminho normal.
- **Não pode inverter a polaridade dos gates.** Envio falha-ABERTO a soluço técnico;
  provisionamento falha-FECHADO. Um duplo de teste precisa preservar as duas.
- **Não pode fabricar registro financeiro.** Fatura, evento e cobrança inventados corrompem
  conciliação e auditoria — é a linha que este ensaio se recusou a cruzar.

## 5. Critério de saída

Este follow-up está resolvido quando for possível, **sem tocar em produção e sem esperar um mês**,
demonstrar a sequência completa: fatura vinculada vencida → `SUSPENDED_UNPAID` → envio bloqueado →
pagamento → restauração — e repetir a demonstração a qualquer momento.

Até lá, `whatsapp_service_enforcement` permanece **OFF**, e ligá-la exige a janela controlada
descrita em [FASE-5B-ROTEIRO-SANDBOX.md §0.8](FASE-5B-ROTEIRO-SANDBOX.md).
