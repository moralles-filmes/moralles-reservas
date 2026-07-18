# FASE 2 — Asaas Sandbox: Resumo de Execução

> Concluída em 2026-07-16, branch `billing-asaas/fase-2` (base `ca957c7`, tag `billing-asaas/fase-1`). 16 commits.
>
> **Nada foi aplicado em produção nesta fase**: `supabase db push` NÃO foi rodado (migration 064 existe mas nunca executou) e nenhuma Edge Function foi deployada. A flag `asaas_enabled` continua OFF.

---

## Entregue

**Pesquisa (pré-requisito do plano — "confirmar na doc oficial antes de codar")**
- [03-ASAAS-API-VERIFICADO.md](03-ASAAS-API-VERIFICADO.md) — fatos verificados nas páginas ao vivo do `docs.asaas.com`. É a **fonte de verdade** da implementação; todo valor exato (URL, header, nome de evento, unidade monetária) saiu de lá. Reconferir antes do cutover (Fase 11).
- [04-RUNBOOK-SANDBOX.md](04-RUNBOOK-SANDBOX.md) — passo a passo pro admin: gerar chave Sandbox, cadastrar chave/webhook no painel, simular pagamento, e o que fazer quando a fila do webhook quebra.

**Código** (`_shared/asaas-core.ts` é puro — zero imports, zero `Deno.*` — e por isso é o único testável no vitest)
- `_shared/asaas-core.ts` — helpers puros: env/base URL, validação de chave por prefixo (3 estados), parse de erro, decisão de retry, conversão monetária, classificador de evento, parser do envelope do webhook.
- `_shared/asaas-config.ts` — resolve `asaas_api_key`/`asaas_webhook_token` de `platform_secrets` → fallback env. Espelha `stripe-config.ts` (cache 5min, nunca lança).
- `_shared/asaas.ts` — cliente HTTP (`fetch` cru, sem SDK): customers, payments, subscriptions, checkout, refund, QR Pix.
- `AsaasBillingProvider` em `_shared/billing-provider.ts` — implementa `BillingProviderPort`; `getBillingProvider("asaas")` não lança mais.
- EF `asaas-webhook` — token no header, persist-before-process, classificação. `verify_jwt=false` no config.toml.
- Worker `process-asaas-reconcile` + migration `064` (cron `0 7 * * *`) — reprocessa `billing_events` presos.
- `manage-platform-secrets` — aceita as 2 chaves novas; painel `/platform/automacao` ganhou seção Asaas.

**Testes:** 160/160 (127 novos). Cobrem a lógica pura: unidade monetária (incluindo o drift de IEEE-754), decisão de retry, prefixo de chave, nomes de evento (contagens 29/7/4 + as 2 pegadinhas), `&` literal no id do evento, e que nenhuma mensagem vaza a chave.

## Verificação

| Item | Resultado |
|---|---|
| `npm run lint` | 0 erros (22 warnings pré-existentes, nenhum novo) |
| `npm run typecheck` | 0 erros |
| `npm run test` | **160/160** |
| `npm run build` | OK |
| `deno check` nas 7 EFs/`_shared` | **limpo** |
| `supabase db push` | ❌ **NÃO rodado** — decisão do usuário (mexe em produção) |
| Testes de sandbox ao vivo | ❌ **NÃO rodados** — dependem da chave Sandbox |

> ⚠️ `supabase/functions/**` está **fora** do `tsc -b` (`tsconfig.app.json` é `include:["src"]`) **e** do eslint. O `deno check` é a **única** coisa que já tipou esse código. `deno` não está instalado na máquina — foi rodado via `npx deno@2.1.4`.

---

## ⚠️ Achados da pesquisa que mudaram a implementação

1. **`value` do Asaas é em REAIS DECIMAIS, não centavos** (`"value": 19.90`). Nosso código fala `amountCents`. Mandar `44900` cobraria **R$ 44.900,00** em vez de R$ 449,00 — **100x**. Conversão fica na fronteira do `AsaasBillingProvider` (§9.1).
2. **O Asaas só aceita HTTP 200.** 201/204 contam como **falha**; 15 falhas seguidas interrompem a fila; eventos ficam 14d e são **apagados pra sempre** (só um e-mail avisa). Um `204` inocente mataria o billing em silêncio.
3. **Não existe `Idempotency-Key`.** Retry cego de `POST /payments` que deu timeout **duplica cobrança**. Daí a política: GET repete; POST/PUT/DELETE só em 429.
4. **Não existe HMAC** — só o token estático `asaas-access-token` (o oposto da Stripe).
5. **O id do evento tem `&` literal** (`evt_<hex>&<num>`) — string opaca, nunca dar split.
6. **`PAYMENT_CONFIRMED` ≠ `PAYMENT_RECEIVED`**: confirmado = pago, saldo indisponível; recebido = liquidado, **até ~30 dias depois no cartão**. Gate de acesso na Fase 4 vai no CONFIRMED (decisão registrada em §5); RECEIVED é conciliação financeira.
7. **Prefixo de ambiente na chave só existe a partir de 10/03/2025** — chave legada é válida e indistinguível por prefixo → validação é de 3 estados (`ok`/`blocked`/`inconclusive`), nunca bloqueia o inconclusivo.

## Invariantes fixados (não quebrar)

- **Webhook:** `200` = persistido de forma durável **ou** descartado de propósito. **Não-200** = "não consegui guardar, reenvia". Não-200 hoje: `405` (não-POST), `401` (token errado), `500` (token não configurado), `503` (falha de INSERT / falha ao **ler** a flag / falha ao **ler o corpo** / catch-all).
- **Falha ao LER a flag ≠ flag OFF.** `checkFlagEnabled` → `{enabled, readFailed}`.
- **Falha de transporte ≠ JSON malformado.** `req.text()` que estoura é rede (503, reenvia); `JSON.parse` que estoura é lixo do Asaas (200, reenviar traz o mesmo lixo).
- **`getPayment`/`getSubscription` devolvem payload CRU — dinheiro em REAIS.** Assimétrico e **dependente do provider** (Stripe devolve centavos na mesma interface). Documentado no header da porta. **Bloqueio conhecido pra Fase 4.**
- **Cache de config não invalida cross-isolate**: rotação de chave leva até 5min (TTL). O `clearXConfigCache()` só limpa o próprio isolate — é assim de propósito, não tentar "consertar".

## Riscos residuais antes de ligar `asaas_enabled`

1. **Nada disso jamais executou.** Migration 064 nunca rodou; webhook e worker nunca viram payload real; `deno check` só garante tipo, não comportamento.
2. **Ordem de deploy importa**: `supabase functions deploy asaas-webhook` **antes** de cadastrar o webhook no painel Asaas — um 404 conta como falha e 15 seguidas matam a fila.
3. **Redeployar `manage-platform-secrets`** ou as 2 chaves novas não são aceitas.
4. **Depois de ligar a flag, espere ~5min** antes do 1º evento (cache). Primeiro evento com `asaas_webhook_flag_off` no log é o cache, não webhook quebrado — e ele **se perde** (flag OFF não persiste).
5. **Pendências que só o sandbox resolve** (§13): `imageBase64` é mesmo obrigatório em `items[]`? Payload de `PAYMENT_*` traz o objeto completo ou só `{object,id}`? `PUT {status:"INACTIVE"}` preserva as cobranças emitidas? `items[].value` aceita `19.90`? Semântica real do `billingType: UNDEFINED`?
6. **A metade "consulta a API" do reconcile não existe** — hoje evento perdido não é detectado por ninguém. Correto pra Fase 2 (não há o que perder), registrado na Fase 4.

## O que a Fase 2 do plano pedia e NÃO foi entregue (registrado, não esquecido)

Da linha "Worker `process-asaas-reconcile`", 4 itens foram adiados **pra Fase 4** (e escritos lá):
consulta de payments `PENDING` antigos na API · correção de divergências · alerta ao admin · action admin de reprocessamento manual.
**Motivo:** nada cria cobrança Asaas ainda — `billing_invoices` não tem linha `provider='asaas'` **por construção** (nenhuma EF consome o `AsaasBillingProvider`). Construir agora seria ramo inexercitável.

Também não rodados: os testes de sandbox que a fase pedia (criar customer, cobrança Pix, assinatura cartão, **cenário 7** = webhook duplicado, **cenário 8** = callback de sucesso sem webhook não ativa nada). Dependem da chave Sandbox. **Cenários 7 e 8 nunca foram exercitados contra nada.**

## Mudou alguma coisa em produção?

**Pros clientes e usuários finais: nada.** Nenhum toque em reservas, WhatsApp, billing Stripe ou qualquer caminho de cliente.

**Mas seria errado dizer que *literalmente* nada muda.** Duas mudanças visíveis, ambas restritas a `platform_admin` e ambas intencionais, quando `main` for deployado / as EFs forem redeployadas:
1. `/platform/automacao` ganha a seção "Asaas" (2 inputs), a copy da Stripe foi corrigida e há uma seção "Outras chaves".
2. `manage-platform-secrets` passa a aceitar 2 chaves novas.

O resto é inerte: `billing-provider.ts` sem importador, `platform-flags.ts` só as 2 EFs novas, migration 064 não executada, EFs novas atrás de flag OFF.

## Rollback

- Flag `asaas_enabled` já está OFF.
- Migration 064 não aplicada. Se aplicar e quiser desfazer: `select cron.unschedule('asaas-reconcile');`.
- EFs novas: não deployadas. Se deployar e quiser reverter, `supabase functions delete asaas-webhook` (ou deixar — sem webhook cadastrado no Asaas, não recebe nada).
- Reverter a branch inteira: `git revert` do range, ou não mergear. A Fase 1 (`ca957c7`) fica intacta.

## Próxima fase

**FASE 3 — Painel de Planos adaptado + seeds** (categorias/provedor na UI, seeds dos planos R$ 449 / R$ 750 / R$ 149 / pacotes de IA / trial 5 dias). Não depende da chave Sandbox.

Se preferir fechar a Fase 2 de verdade antes: pegue a chave Sandbox ([04-RUNBOOK-SANDBOX.md](04-RUNBOOK-SANDBOX.md)), rode `supabase db push`, deploye as EFs, ligue a flag e rode os testes ao vivo — resolvendo de quebra as pendências do §13.
