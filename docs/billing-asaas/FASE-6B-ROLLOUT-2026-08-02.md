# Fase 6b — registro do rollout de 2026-08-02

O que foi **efetivamente executado** contra produção, em ordem, com a evidência
de cada passo. Este documento é o registro do que aconteceu; o plano continua
em [FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md).

---

## 0. Incidente que precedeu tudo

A `GIT_HISTORY_SECRET_SCAN` — última pendência antes de qualquer merge — foi
executada e encontrou um secret real. Rotação, saneamento e registro em
[INCIDENTE-2026-08-02-INTERNAL-API-KEY.md](../INCIDENTE-2026-08-02-INTERNAL-API-KEY.md).

**Nada do rollout começou antes da rotação estar confirmada** por
`net._http_response` (401 às 16:02/16:03 UTC, 200 de 16:04 em diante) e por
varredura de `pg_trigger`/`pg_proc` devolvendo zero literais de 64 hex.

---

## 1. Pré-voo local — o que deixou de ser `ENVIRONMENT_BLOCKED`

PostgreSQL 18.4 instalado via `scoop`, sem Docker e sem privilégio
administrativo, em `127.0.0.1:55432`, **sem `pg_cron` e sem `pg_net`** — a
ausência das duas extensões é deliberada: treze migrations legadas embutem a URL
de produção nos wrappers de cron, e um replay com elas presentes agendaria jobs
apontando para lá.

A migration **089 real** foi aplicada verbatim (não uma transcrição) sobre um
ambiente mínimo, e os casos FK-A..FK-G de
[whatsapp-instances.integration.md](../../supabase/tests/whatsapp-instances.integration.md)
rodaram contra ela.

```
11 casos · 11 PASS · 0 FAIL
```

Os três que carregam o resultado:

| Caso | O que provou |
|---|---|
| **CONTROLE** | Reintroduzido o CHECK **antigo**, o `DELETE` da instância **aborta** com `check_violation`. O defeito F-01 foi **reproduzido**, não argumentado — sem isto, "FK-C passou" não distinguiria *o fix funciona* de *o teste não testa nada*. |
| **FK-C** | Com o CHECK que subiu, o `DELETE` conclui: linha preservada, `instance_id` nulo, `subject_id` e `organization_id` intactos. |
| **FK-B2** | `INSERT` INSTANCE com `instance_id` nulo **passa** no CHECK relaxado e é recusado **só** pela trigger. A trigger é load-bearing, provado. |

**O que este ambiente NÃO prova:** RLS, grants, ACL, `verify_jwt`, aplicação
real das migrations. Isso exige Supabase de verdade e segue pendente.

---

## 2. Gates sobre o delta

Reexecutados porque a 022 (uma migration) foi editada depois do GO anterior.

| Gate | Veredito | Achados |
|---|---|---|
| `migration-validator` | `PASS_WITH_WARNINGS` | 0 bloqueantes; 2 P3 já mitigados por construção |
| `secret-hunter` | `PASS_WITH_WARNINGS` | 0 bloqueantes; 3 achados, um deles **procedente e corrigido** |

O `secret-hunter` criticou corretamente o guardrail que eu mesmo tinha escrito
horas antes: ele fechava a **instância** do incidente e deixava a **classe**
aberta. Corrigido em `381a371` — cinco formas agora, cada uma com controle
positivo **e negativo**, o negativo existindo porque um regex mais guloso
reprovaria os quinze wrappers de `pg_cron` que leem do Vault.

Confirmações pedidas explicitamente e verificadas de forma independente:

- **092 não agenda cron** — `grep cron.schedule` sem ocorrência.
- **Ren Sushi intocado** — nenhuma das seis faz `ALTER`/`UPDATE`/`INSERT` em
  `organizations`, `billing_status`, `entitlements`, `reservations` ou
  `customers`.
- **As seis são idempotentes** — rodam duas vezes sem erro.

---

## 3. Produção

| # | Ação | Evidência |
|---|---|---|
| 4 | `supabase db push` — 087→092 | `Finished supabase db push`, 6 migrations |
| 6–9 | Deploy de 9 Edge Functions | 9/9 OK, `process-billing-notifications` **primeiro** |
| 10 | Push da branch | exigiu escopo `workflow` no token |
| — | `vault.create_secret('…', 'project_url')` | não existia; gate respondido por diagnóstico |
| 17 | Disparo manual do worker, **5×** | `200`, `success:true`, seis passos |
| 20 | `supabase db push` — 093 | cron `whatsapp-instance-cycles`, `10 12 * * *` |

### Por que `process-billing-notifications` foi a primeira

Os seis `admin_zapi_*` acoplam produtor e dispatcher **só por string**. Se o
produtor subisse antes dos templates, toda linha enfileirada morreria em
`failed/unknown_event_type` e o aviso sumiria em silêncio.

### O conjunto de redeploy foi derivado, não copiado

Dez arquivos de `_shared/` mudaram. `billing-notify.ts` tem nove consumidores,
mas a mudança é `void` → `boolean` — ampliação compatível, e o próprio
comentário do arquivo afirma que uma cópia antiga em memória continua correta.
Verificado no diff antes de decidir: quatro consumidores ficaram de fora **de
propósito**, não por esquecimento.

---

## 4. O que a execução manual descobriu

Com o inventário **vazio**, o passo `divergences` devolveu `processed: 1` em
todas as cinco execuções.

É `CHANNEL_WITHOUT_INSTANCE`: existe um canal de WhatsApp operacional sem
registro correspondente no inventário novo. O texto do alerta é literalmente
*"Revise e faça o backfill manual se ele for faturável."*

**O worker pediu sozinho o passo 14, antes de qualquer automação estar ligada.**
Essa é a justificativa inteira de a 092 e a 093 serem migrations separadas: sem
a separação, o cron teria nascido no mesmo push das tabelas e essa descoberta
teria acontecido sem ninguém olhando.

---

## 5. Ren Sushi — a verificação que precedeu o backfill

O custo real da instância (R$ 99,90/mês) só pôde ser registrado depois de
confirmar, **no banco**, que o override existe exatamente como o código exige
([index.ts:118](../../supabase/functions/process-whatsapp-instance-cycles/index.ts)):
`feature='whatsapp'`, `grant_type='LIFETIME'`, `enabled=true`,
`revoked_at is null`. Confirmado para Ren Sushi **e** Moralles.

Com isso, `attributeRevenue` devolve `LIFETIME_OVERRIDE`, e o passo econômico
faz `continue` antes de qualquer alerta
([worker-core.ts:829](../../supabase/functions/_shared/whatsapp-instance-worker-core.ts)):
margem negativa de cliente cortesia é **custo conhecido de decisão comercial**,
não anomalia. A margem exibida é `NOT_APPLICABLE`, não prejuízo.

Sem esse override, o Ren Sushi cairia em `NO_ENTITLEMENT` e geraria alerta
econômico todo mês. **A verificação não era formalidade.**

---

## 6. O que continua desligado, e por quê

| | Estado | Razão |
|---|---|---|
| `billing_notifications_dispatch` | **OFF** | bloqueado por `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE` ([FASE-6B-FOLLOWUPS.md](FASE-6B-FOLLOWUPS.md)) |
| `whatsapp_service_enforcement` | **OFF** | decisão do responsável |
| `whatsapp_implementation_flow` | **OFF** | decisão do responsável |
| `whatsapp_subscription_checkout` | **OFF** | decisão do responsável |
| Asaas | **sandbox** | go-live é fase posterior |

Com o dispatch OFF, o cron rola ciclo, registra no ledger e enfileira aviso —
e a fila acumula sem enviar e-mail. É o modo previsto da fase, não uma
degradação.

---

## 7. Pendente

1. **Backfill do Ren Sushi pelo painel** — `intent: BACKFILL_EXISTING`,
   custo R$ 99,90, vencimento 04/08, âncora dia 4. Resolve a divergência da §4.
2. **Observação de 3 dias** — uma execução automática por dia, sem duplicação
   no ledger.
3. **Merge em `main`** — só depois da observação.
4. **Ambiente capaz de provar RLS/grants** — Docker, quando houver.

⛔ Nenhuma flag deve ser ligada como parte do encerramento desta fase.
