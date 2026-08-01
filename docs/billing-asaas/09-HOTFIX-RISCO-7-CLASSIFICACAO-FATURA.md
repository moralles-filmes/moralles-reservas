# Hotfix pré-6b — Risco 7: classificação de fatura e escalada indevida de `billing_status`

> Intervenção **preventiva e estrutural**, autorizada pelo dono em 2026-08-01.
> **Nenhum dado financeiro precisou ser corrigido.**
> Risco original: [FASE-5B-RESUMO.md § Risco 7](FASE-5B-RESUMO.md). Bug relacionado: [08](08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md).

---

## 1. Por que este documento existe

A Fase 5b registrou o Risco 7 como *"o mais grave da lista"* e como **gate a fechar antes de ligar `billing_invoice_ingestion`**. Durante o brainstorming da Fase 6b (2026-08-01), a verificação do estado real do ambiente encontrou a flag **ligada** desde 2026-07-31 15:24 UTC, com o risco ainda aberto.

A investigação subsequente encontrou **um segundo caminho para o mesmo dano, mais alcançável que o documentado**. O dono determinou fechar o risco estruturalmente antes de prosseguir com a Fase 6b.

## 2. O risco documentado (caminho 1)

`isSystemInvoice` ([_shared/billing-category.ts](../../supabase/functions/_shared/billing-category.ts)) resolve em três caminhos. O terceiro — **sem `billing_subscription_id` e sem `plan:<uuid>` no `external_reference`** — devolve `true` por compatibilidade com fatura legada.

Uma renovação de mês 2+ do Asaas nasce sem `checkoutSession` e sem `externalReference`. Se a correlação não resolver a assinatura, a fatura é gravada com os três nulos e passa a ser lida como **fatura de sistema**. A partir daí `process-billing-overdue` escreve `organizations.billing_status='blocked'` em D+6: **o sistema inteiro morre por uma mensalidade de R$149 da automação de WhatsApp.**

## 3. O caminho encontrado nesta investigação (caminho 2) — mais grave

A escada de correlação casa por `provider_subscription_id` **sem filtrar `status`** ([_shared/asaas-billing-events-apply.ts:616-621](../../supabase/functions/_shared/asaas-billing-events-apply.ts)):

```ts
.from("billing_subscriptions")
.select("id, organization_id, billing_plan_id")
.eq("provider", "asaas")
.eq("provider_subscription_id", providerSubscriptionId)
.maybeSingle();          // ← nenhum filtro de status
```

E `process-billing-overdue` **não verifica o status da assinatura em lugar nenhum** ([process-billing-overdue/index.ts:33-47](../../supabase/functions/process-billing-overdue/index.ts)) — ele parte da fatura `open` vencida e pergunta apenas se é de sistema.

Combinados: uma renovação residual de uma assinatura que o **banco local considera cancelada** correlaciona normalmente, classifica-se como sistema (e de fato o plano é de sistema), e **escala a inadimplência de uma organização por uma assinatura que ela já cancelou**.

### 3.1 Por que isso é concreto, e não hipotético

Estado das assinaturas em 2026-08-01:

| assinatura | organização | categoria | status local | `canceled_at` |
|---|---|---|---|---|
| `sub_rp0p6o3casfcszuk` | `seu-japa` | SYSTEM_SUBSCRIPTION | `canceled` | **NULL** |
| `sub_i89jdm76vjl8gxi8` | `seu-japa` | SYSTEM_SUBSCRIPTION | `canceled` | **NULL** |
| `sub_qn6dpom3q6xr3r8s` | `sandbox-fase-5b-paid` | WHATSAPP_SUBSCRIPTION | `canceled` | 2026-07-31 18:34 |

`status='canceled'` **com `canceled_at` NULL** é a assinatura do [bug 08](08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md): canceladas localmente *antes* da correção, quando `manage-billing` nunca chamava o provedor. **O estado real dessas duas no Asaas Sandbox é `UNKNOWN`** — não é verificável pelo banco, e o banco local não é prova.

Linguagem obrigatória em painel, documentação e telemetria enquanto não houver verificação manual:

> *"Assinatura cancelada localmente com estado no provider ainda não confirmado."*

### 3.2 Raio de dano

**Limitado a `seu-japa`, que é organização de teste.** `ren-sushi` e `moralles` são inalcançáveis por três motivos independentes: zero assinaturas, zero faturas, e 3 overrides ativos cada — `hasActiveSystemOverride` corta antes de qualquer escalada.

## 4. Auditoria do período com a flag ligada (2026-07-31 15:24 → 2026-08-01)

Todas as consultas abaixo são **somente leitura**, executadas contra o projeto de produção.

| verificação | query (resumida) | resultado |
|---|---|---|
| Faturas criadas após a ativação | `count(*) from billing_invoices where created_at >= '2026-07-31 15:24:49+00'` | **0** |
| Faturas com `ingestion_source` (coluna que só a ingestão preenche) | `count(*) ... where ingestion_source is not null` | **0** |
| Eventos processados após a ativação | `count(*) from billing_events where processed_at >= '2026-07-31 15:24:49+00'` | **0** |
| Fatura `open` sem vínculo de plano | `status='open' and billing_subscription_id is null and external_reference not like '%plan:%'` | **1** — legado **Stripe** (`in_1TefEW…`), `due_date` NULL, já documentada como invisível ao worker |
| Organizações em `past_due`/`blocked` | `select billing_status from organizations` | **0** (3 `active`, 2 `trialing`) |
| Assinaturas ativas (qualquer categoria) | `status <> 'canceled'` | **0** |

A fatura mais recente do banco é de **2026-07-31 15:13:45 UTC — 11 minutos ANTES** da ativação da flag.

> **Nenhum dado financeiro precisou ser corrigido. A intervenção é preventiva e estrutural.**

Consequência secundária: a flag ficou ligada 8 dias **sem ingerir um único registro**, então sua ativação nunca foi validada por evidência de funcionamento.

## 5. Cobertura de teste antes do hotfix

**`billing-category.ts` não possuía nenhum arquivo de teste.** Os demais núcleos do projeto têm (`billing-delinquency-core`, `billing-correlation-core`, `whatsapp-service-state-core`, `entitlements-core`, …); este não, porque recebe um `SupabaseClient` e nunca coube no padrão de núcleo puro exigido pelo vitest.

O módulo que protege o invariante de maior raio de dano do billing era o único sem teste.

## 6. Contenção aplicada

| campo | valor |
|---|---|
| Flag | `billing_invoice_ingestion` |
| Valor anterior | `true` (desde 2026-07-31 15:24:49 UTC) |
| Valor novo | `false` |
| Data/hora | 2026-08-01 (registrado em `platform_flags.updated_at`) |
| Autorizado por | `morallesfilms@gmail.com` (platform_admin, único administrador da plataforma) |
| Motivo | Exposição financeira real e **não verificável somente pelo banco**: assinaturas locais `canceled` que podem seguir ativas no Asaas Sandbox, somadas a uma correlação que aceita qualquer status e a workers de inadimplência que não verificam status de assinatura |

**Não alterados** (confirmado por leitura após a mudança): `asaas_enabled` (segue `true`), `whatsapp_service_enforcement` (segue `false`), `billing_invoice_ingestion_since` (segue `"2026-07-31"`), `billing_notifications_dispatch` (segue `false`). Nenhum `UPDATE` em `billing_invoices`, `billing_subscriptions` ou `organizations`.

### 6.1 O que a contenção NÃO interrompe

`asaas_enabled` continua ligada: o webhook segue **recebendo e persistindo** `billing_events`. A trilha de auditoria é preservada; apenas a **criação de fatura** para. Eventos recebidos durante a contenção não podem ser marcados como plenamente aplicados, e a estratégia de reprocessamento precisa ser especificada **antes** da reativação — religar a flag não faz backfill automático do período.

## 7. Correção estrutural

### 7.1 Núcleo puro

Extrair a decisão para um núcleo puro, testável pelo vitest a partir de `src/`, no mesmo contrato dos demais (zero imports de Supabase, Deno, env, provider, rede ou relógio global). O módulo com I/O passa a apenas: buscar fatos → normalizar → chamar o núcleo → aplicar idempotentemente → registrar telemetria e divergência.

Veredito com três valores: **`SYSTEM`**, **`NON_SYSTEM`**, **`NEEDS_REVIEW`**.

### 7.2 Regra de classificação — falha fechada

Para fatura **moderna** (nascida depois do marco de ingestão):

- evidência inequívoca de assinatura de categoria de sistema → `SYSTEM`;
- evidência inequívoca de categoria não sistêmica → `NON_SYSTEM`;
- **ausência, conflito ou ambiguidade → `NEEDS_REVIEW`**.

**O default `true` para fatura moderna sem vínculo confiável é removido.**

Não vale como prova isolada: ausência de `billing_subscription_id`; ausência de `checkoutSession`; ausência de `plan:` no `external_reference`; valor da cobrança; "assinatura mais recente"; organização associada; `external_reference` não versionada; status financeiro inferido por compatibilidade.

Compatibilidade legada permanece **apenas** em casos delimitados por fatos objetivos: fatura originada na Stripe, ou anterior ao marco aprovado de ingestão. Nunca como exceção ampla do tipo "se não souber, é sistema".

### 7.3 Assinatura cancelada

A correlação **continua** encontrando a assinatura cancelada — perder o vínculo seria pior. Mas o resultado nunca escala: `NEEDS_REVIEW` (ou categoria conhecida com `enforcement_hold=true`), divergência administrativa registrada, correlação preservada, e **nenhum worker altera `organizations.billing_status` enquanto a revisão estiver pendente**.

O alerta comunica organização, provider, `provider_subscription_id` mascarado, categoria local, status local, evento recebido e ação esperada — **sem secret e sem payload bruto do provedor**.

### 7.4 Invariante, como teste explícito

> **Somente uma obrigação inequivocamente classificada como `SYSTEM` pode escrever ou escalar `organizations.billing_status`.**

Consequências obrigatórias: `WHATSAPP_SUBSCRIPTION`, `WHATSAPP_IMPLEMENTATION`, `AI_CREDIT_PACKAGE` e `NEEDS_REVIEW` **nunca** escrevem `billing_status` global; assinatura local cancelada nunca escala automaticamente; cobrança ambígua nunca é promovida a `SYSTEM` por compatibilidade moderna.

## 7.5 Teste de integração do raio de dano — executado ao vivo em 2026-08-01

Quatro fixtures criadas direto no banco (`provider='manual'`, para não mentir sobre existir no Asaas), em **duas organizações sandbox** — nunca `ren-sushi`, nunca `moralles`. Todas com fatura `open` vencida há 15 dias (D+15 → `blocked` pela régua). Worker real invocado pelo mesmo wrapper `trigger_billing_overdue()` que o `pg_cron` usa.

| caso | vínculo | veredito esperado | retida | status da org | aviso |
|---|---|---|---|---|---|
| **J1** — o Risco 7 documentado | nenhum | `NEEDS_REVIEW` | ✅ `MANUAL_REVIEW` | `trialing` — **não escalou** | 1 |
| **J2** — mensalidade da instância | assinatura WhatsApp ativa | `NON_SYSTEM` | não | `trialing` | 0 |
| **J3** — o caminho descoberto aqui | assinatura SISTEMA **cancelada** | `NEEDS_REVIEW` | ✅ `MANUAL_REVIEW` | `trialing` — **não escalou** | 1 |
| **J4** — CONTROLE | assinatura SISTEMA **ativa** | `SYSTEM` | não | ✅ **`blocked`** — escalou | 0 |

**O par J1/J4 é a evidência que fecha o argumento:** a mesma fatura vencida, mesmo valor, mesma idade, na mesma régua — bloqueia quando é do sistema e é retida quando não dá para afirmar. Sem o controle J4, "nada escalou" significaria apenas "o worker está quebrado".

**Idempotência (item I):** o worker foi executado duas vezes; os avisos permaneceram em 1 por fatura (UNIQUE `(organization_id, event_type, invoice_id)`), sem transição financeira repetida.

**Limpeza:** as 4 faturas, as 3 assinaturas de apoio, os 2 avisos e o estado da organização de controle foram removidos/restaurados. Estado final conferido: 6 faturas (as originais), 0 retenções, 2 notificações (as originais), nenhuma organização em estado anormal, `ren-sushi` `active`.

### 7.5.1 Defeito encontrado PELO teste, invisível ao teste unitário

A primeira execução classificou os quatro casos corretamente **mas não reteve nenhum**. Causa: o `UPDATE` violava duas constraints da migration 077 e era recusado com `23514`:

- **`billing_invoices_hold_reason_chk`** — `enforcement_hold_reason` tem **vocabulário fechado** (`INITIAL_BACKFILL`, `PRE_GO_LIVE_INVOICE`, `CORRELATION_AMBIGUITY`, `VALUE_MISMATCH`, `MANUAL_REVIEW`) e o código gravava texto livre com o motivo preciso;
- **`billing_invoices_hold_requires_reason_chk`** — `enforcement_hold=true` exige também `enforcement_held_at` preenchido.

Correção: reason passa a ser `MANUAL_REVIEW` (o valor do vocabulário que significa exatamente "exige olho humano") e `enforcement_held_at` é carimbado; o motivo PRECISO (`MODERN_WITHOUT_LINK`, `SUBSCRIPTION_TERMINAL_STATUS`, …) vai para a telemetria e para o painel, que é onde serve à triagem — a coluna existe para ser enumerável, não para carregar diagnóstico.

Duas lições registradas: (1) o fail-safe funcionou mesmo com o defeito — a falha do `UPDATE` foi logada e **não** relançada, então nenhuma organização escalou e o aviso saiu assim mesmo; (2) **nenhum teste unitário pegaria isto** — a regra violada mora no banco, não no código. É a justificativa concreta para o teste de integração existir.

## 8. Fora de escopo

- **Bug do `externalReference` acima de 100 caracteres** ([07](07-BUG-EXTERNALREFERENCE-LIMITE.md)) — segue separado. Formato, parser, tamanho, versionamento e compatibilidade histórica **não** são tocados aqui.
- **Cancelamento das assinaturas no Asaas** — ação externa com efeito financeiro; só após verificação manual e confirmação explícita.
- **Reativação da ingestão** — exige nova autorização, precedida do checklist de GO/NO-GO.

## 8.5 Telemetria — a falha do fail-safe não pode se esconder atrás dele

O fail-safe evitou dano durante a execução defeituosa (§7.5.1), mas "não causou dano" não pode virar "não aconteceu nada". Cinco sinais distintos, para que uma falha parcial nunca passe por sucesso:

| evento | significa |
|---|---|
| `invoice_category_needs_review` | classificação concluiu: a fatura é indeterminada (com o motivo preciso) |
| `billing_overdue_hold_persisted` | retenção gravada com sucesso |
| `billing_overdue_hold_persist_failed` | **classificação OK, persistência falhou** → `needsAdminAction: true` |
| `billing_overdue_review_no_recipient` | não há admin notificável → `needsAdminAction: true` |
| `billing_overdue_review_notified` | aviso criado, carregando `holdPersisted` — nível `error` quando o aviso saiu **apesar** da retenção ter falhado |

**Falha ao persistir a retenção nunca resulta em escalada no mesmo processamento:** o `continue` vem depois do bloco de retenção, independentemente do resultado — a fatura sai do conjunto avaliado naquela passada, com ou sem `hold` gravado.

## 8.6 Reativação — executada em 2026-08-01

| campo | valor |
|---|---|
| Flag | `billing_invoice_ingestion` |
| Valor anterior | `false` (contenção de 2026-08-01 20:41 UTC) |
| Valor novo | **`true`** (2026-08-01 21:32 UTC) |
| Autorizado por | `morallesfilms@gmail.com` (platform_admin) |
| Data de corte | **`"2026-07-31"` PRESERVADA** — decisão explícita |
| Motivo | Classificador falha FECHADA para fatura moderna ambígua; assinatura cancelada não escala billing global; cobrança não sistêmica não escreve `organizations.billing_status`; raio de dano validado por teste de integração com controle positivo |

**Por que a data de corte não virou `2026-08-01`:** 31/07 foi a data real de entrada em operação da ingestão, gravada antes da ativação conforme o procedimento. Movê-la trataria artificialmente cobranças de 31/07 como pré-go-live, ampliando a compatibilidade legada por conveniência em vez de por fato histórico. A escolha preserva a verdade da ativação.

**Flags conferidas após a mudança, nenhuma alterada como efeito colateral:** `asaas_enabled=true` · `whatsapp_service_enforcement=false` · `billing_notifications_dispatch=false` · `whatsapp_implementation_flow=false` · `whatsapp_subscription_checkout=false` · `billing_invoice_ingestion_since="2026-07-31"`.

### Observação controlada pós-reativação

Nenhuma cobrança artificial foi criada para justificar a reativação — o teste de integração já forneceu a evidência funcional.

| invariante | resultado |
|---|---|
| Faturas com `ingestion_source` | 0 (nada ingerido ainda) |
| Faturas em `enforcement_hold` | 0 |
| **`hold` sem `held_at`** | **0** |
| Eventos após a reativação | 0 |
| **Notificações duplicadas** | **0** |
| **Organizações em estado anormal** | **0** |
| **`purpose` fora do vocabulário** | **0** |
| `ren-sushi` | `active` |

Os 4 `billing_events` em `failed` são de 2026-07-23, anteriores a esta intervenção — não são regressão.

## 8.7 Regra de NO-GO após a reativação

Desligar a ingestão e apresentar evidências **antes de qualquer outra ação** se ocorrer: fatura ambígua classificada como `SYSTEM`; assinatura `canceled` provocando escalada; cobrança de WhatsApp alterando `organizations.billing_status`; `enforcement_hold` sem `enforcement_held_at`; erro de constraint no caminho de retenção; duplicação de fatura ou aviso; consumidor ignorando `enforcement_hold`; divergência entre webhook e reconcile; evento marcado como processado sem aplicação segura.

**Não corrigir dados diretamente para manter o rollout verde.**

## 9. O que este GO significa — e o que NÃO significa

### 9.1 O Risco 7 está fechado ESTRUTURALMENTE

O caminho que transformava ausência de evidência em "fatura de sistema" não existe mais para fatura moderna, e o caminho descoberto nesta investigação (assinatura cancelada correlacionando e escalando) está fechado junto. Ambos comprovados por teste de integração com controle positivo.

### 9.2 O que este GO NÃO autoriza

- **NÃO conclui o rollout da Fase 5b.** O bloqueio D+6 e a restauração ponta a ponta em condições reais continuam sem validação com cobrança de verdade do provedor.
- **NÃO autoriza ligar `whatsapp_service_enforcement`.** A flag segue `false` e os gates nomeados no [FASE-5B-RESUMO](FASE-5B-RESUMO.md) (Riscos 9, 6 e 4) continuam abertos, sem relação com este hotfix.
- **NÃO autoriza ligar `billing_notifications_dispatch`.** Ela governa TODAS as notificações de billing, não só as desta correção.

### 9.3 Invariantes financeiros que passaram a ter cobertura

Antes deste hotfix, `billing-category.ts` não tinha nenhum teste. Agora, 42 testes cobrem:

| invariante | como é afirmado |
|---|---|
| Só `SYSTEM` inequívoco escreve `organizations.billing_status` | tabela de 10 casos que **nunca** governam × 3 que governam |
| Fatura moderna sem vínculo nunca é presumida de sistema | A1–A3 |
| R$149 de WhatsApp nunca bloqueia o sistema | B1–B3 |
| Assinatura cancelada nunca escala, mesmo sendo de sistema | C1–C2 |
| Renovação legítima de sistema continua escalando | C3, D1–D2 |
| Compatibilidade legada exige fato objetivo, nunca "não sei" | E1–E6 |
| Duplicidade nunca desempata pela mais recente | F1–F2 |
| Conflito `purpose` × categoria nunca é coagido | G1–G3 |
| Renovação sem `checkoutSession` classifica pela assinatura | H1 |
| Leitura indisponível ≠ "não é do sistema" | 4 casos de `READ_FAILED`/`NOT_FOUND` |
| `holdRequired` ⟺ `NEEDS_REVIEW` | assertiva sobre todos os casos da suíte |

## 10. Rollback

- **Da flag:** `update platform_flags set value='true' where key='billing_invoice_ingestion'`. A ingestão é idempotente por `(provider, provider_event_id)` e por `upsert_open_invoice`. **Ressalva:** com eventos acumulados durante a contenção, religar não é rollback neutro — o plano de retomada precisa declarar o impacto da aplicação em lote.
- **Do código:** revert do commit + redeploy coordenado dos consumidores confirmados. Sem mudança de schema; `enforcement_hold` e `ingestion_source` preservados; verificação posterior de `billing_status`.
- **Rollback não é automático diante de alerta ou teste falho** — parar, preservar evidência e apresentar a situação.
