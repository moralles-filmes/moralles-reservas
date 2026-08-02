# FASE 6B — Ciclo de vida da instância Z-API (fluxo manual assistido) — Continuidade

> Branch `billing-asaas/fase-6b`, 16 commits sobre `main` (`6550df2`..`58ce517`).
> Spec: [../superpowers/specs/2026-08-01-billing-asaas-fase-6b-design.md](../superpowers/specs/2026-08-01-billing-asaas-fase-6b-design.md) (Seções A–D aprovadas).
> Plano: [../superpowers/plans/2026-08-01-billing-asaas-fase-6b.md](../superpowers/plans/2026-08-01-billing-asaas-fase-6b.md) (23 tasks).
> Pacote de execução: [FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md).
> Diagnóstico do ambiente local: [FASE-6B-DIAGNOSTICO-AMBIENTE.md](FASE-6B-DIAGNOSTICO-AMBIENTE.md).
> Fase anterior: [FASE-5B-RESUMO.md](FASE-5B-RESUMO.md).

---

## 📍 LEIA ANTES DE QUALQUER COISA

**CÓDIGO PRONTO PARA REVISÃO ≠ ROLLOUT AUTORIZADO.** Este documento separa as duas
coisas de propósito, e a separação é o ponto principal dele.

| | |
|---|---|
| **CÓDIGO PRONTO PARA REVISÃO** | ✅ sim — 23 tasks, 668 testes verdes, `typecheck` limpo, **`SAAS_SHIELD_OVERALL: GO`** |
| **ROLLOUT AUTORIZADO** | ❌ **NÃO** — nenhuma migration aplicada, nenhuma EF deployada, integração com banco `ENVIRONMENT_BLOCKED` |

```
SAAS_SHIELD_OVERALL: GO      ← vale só para o código em 19f8e53 + e446ba3
FASE_6B_ROLLOUT:     NO-GO
```

**Nada desta fase tocou o banco de produção.** Nenhuma migration foi aplicada,
nenhuma Edge Function foi deployada, nenhum cron foi agendado, nenhum *backfill*
foi feito. O comportamento de produção hoje é **idêntico ao de antes da fase**.

### Atualização de 2026-08-02 — a CLI foi instalada

| Bloqueio | Antes | Agora |
|---|---|---|
| `SUPABASE_CLI_NOT_INSTALLED` | 🔴 | ✅ **REMOVIDO** — CLI 2.111.0 (scoop) |
| `DOCKER_NOT_INSTALLED` | não verificado | 🔴 **verificado: ausente** |
| `PSQL_NOT_INSTALLED` | não verificado | 🔴 **verificado: ausente** |
| `LINKED_TO_PRODUCTION_REMOTE` | não existia | 🔴 **NOVO** — o repositório está vinculado a produção; `db push`/`deploy` a atingem sem passo preparatório |
| `SAAS_SHIELD_GATES_NOT_EXECUTED` | 🔴 | ✅ **REMOVIDO** — os seis rodaram; ver o estado atual abaixo |
| `REPLAY_FAILS_42P13` · `UNSAFE_AS_IS` · `DATABASE_INTEGRATION_ENVIRONMENT_BLOCKED` · `NO_GO_BEFORE_BACKFILL` · `CRON_NO_GO` · `MERGE_NO_GO` | 🔴 | 🔴 **inalterados** |

**Sem Docker não existe stack local**, então o ambiente está apto **apenas a
validações estáticas**. Diagnóstico completo, tabela de risco por arquivo e o
caminho para destravar em
[FASE-6B-DIAGNOSTICO-AMBIENTE.md](FASE-6B-DIAGNOSTICO-AMBIENTE.md).

**Ter a CLI não transformou** migrations escritas em aplicadas, EFs escritas em
deployadas, painel escrito em publicado, testes bloqueados em executados, nem
gates não executados em verdes.

Ambiente medido: CLI **2.111.0** (scoop), **fora do `PATH` da sessão antiga** ·
Docker, `psql` e `pg_dump` **ausentes** · repositório **vinculado a produção**,
arquivos de vínculo ignorados pelo Git · autenticação ativa pelo **Windows
Credential Manager** · `config.toml` com **43 blocos, todos `[functions.*]`** ·
**118 migrations** (13 com URL literal de produção, 14 usando `net.http_post`,
**nenhuma** declarando `pg_net`, 10 declarando `pg_cron`, 14 com `cron.schedule`,
13 lendo Vault) · segredos esperados `internal_api_key` e `project_url` · replay
**já falhou** com `42P13`.

### Os seis gates rodaram — quatro rodadas

Os seis auditores `saas-shield-br` declaram `tools: Read, Glob, Grep` — **nenhum
tem shell, nenhum acessa banco**. São auditorias **puramente estáticas**, e a
falta de Docker nunca foi o motivo de não terem rodado; o bloqueio era só
autorização de despacho.

| Rodada | Commit | Resultado |
|---|---|---|
| 1 | `469ade2` | 5 PASS · `integration-reliability` FAIL (3 ALTO) → `b255407` |
| 2 | `b255407` | `integration-reliability` PASS · `identity-access` FAIL (`ReferenceError`) → `0ca1304` |
| 3 | `0ca1304` | zero P0/P1 · 11 achados abertos, incl. o defeito latente FK × CHECK |
| Final | `19f8e53` | lote único de estabilização — resultado em [FASE-6B-GATES-SEGURANCA.md](FASE-6B-GATES-SEGURANCA.md) |

**A curva 1 → 8 → 9 achados não mede piora**, mede profundidade da superfície
auditada. O `FINDING-004` prova: é defeito latente da migration 089 desde a
versão original (`daf5bba`), não regressão — e sobreviveu a duas auditorias
completas antes de alguém cruzar a FK com a lógica ternária do CHECK.

**Guardrail estático local não é gate.** Os 661 testes, o `acl-estatico` do CI, o
`migration-static-guard` e o teste de acoplamento por string são **guardrails
locais** — eles não substituem nenhum dos seis.

### Vínculo com produção — achado de alta severidade operacional

O diretório do repositório **já está vinculado ao projeto Supabase de produção**.
`db push` e `functions deploy` podem atingir produção **usando o vínculo
persistido, sem exigir um novo `supabase link`**.

**O vínculo local não é autorização.** Apagar `supabase/.temp` **não** é proteção
suficiente: o vínculo é recriado num comando, a CLI segue autenticada, e o operador
pode refazer o `link` — a segurança tem de viver no **procedimento e no comando
executado**. O vínculo **não foi removido**, e nada de autenticação, credencial ou
temporário foi alterado para produzir sensação de isolamento.

A barreira operacional — classificação obrigatória de cada comando em A/B/C/D antes
de executar — está no topo de
[FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md).

---

## O invariante que governa a fase

> **Cancelar no painel da Z-API interrompe o CUSTO DA PLATAFORMA, não o SERVIÇO DO
> CLIENTE.** A instância segue viva até o fim do ciclo já pago. **Quem corta
> serviço é o *enforcement* interno da Fase 5b** (já existe, validado ao vivo,
> flag `whatsapp_service_enforcement` OFF).

Duas ações, dois relógios, duas consequências. A **6b cuida só de custo e
calendário** — ela não envia, não bloqueia, não altera entitlement, não altera
`organizations.billing_status` e **nunca chama o provedor**.

`whatsapp_instances.lifecycle_state` **nunca autoriza envio nem entitlement.**

---

## Taxonomia de status — o vocabulário desta fase

Três estados distintos, e **"implementado" sozinho não é um deles**. Item que
ainda não foi aplicado nem validado no ambiente real se descreve como *"código
escrito e commitado; aplicação e validação operacional pendentes"*.

| Rótulo | Significa |
|---|---|
| **EXECUTADO** | Rodou de verdade, com evidência reproduzível registrada aqui |
| **ESCRITO MAS NÃO EXECUTADO CONTRA BANCO** | O arquivo existe e está commitado; nenhum banco o viu |
| **NÃO DEPLOYADO** | O código existe no repositório; o runtime em produção não o tem |

### Estado item a item

| Item | Status | Evidência |
|---|---|---|
| 6 núcleos puros (`whatsapp-instance-*`, `whatsapp-partner-simulator-core`) | **EXECUTADO** | 115 testes verdes, detalhados abaixo |
| Núcleo injetável do worker (`whatsapp-instance-worker-core`) | **EXECUTADO** | 37 testes — decisão, contadores, lembrete, enfileiramento e isolamento entre passos |
| Validação de custo (`parseCostCents` / `normalizeCostSource`) | **EXECUTADO** | 13 testes — inteiro, zero, nulo, decimal, negativo, string, NaN/Infinity |
| Guardrail estático de migrations | **EXECUTADO** | 5 testes + step novo no CI `acl-estatico` |
| Teste do acoplamento por string | **EXECUTADO** | 6 testes, duas direções + a decisão de enfileirar tem de ficar no núcleo |
| `npm test` / `npm run typecheck` / `npm run lint` | **EXECUTADO** | 661/661 · 0 erros · baseline de *warnings* inalterada (22) |
| `eslint supabase/functions` (`no-undef`) | **EXECUTADO** | 0 erros; guardrail nasceu do `ReferenceError` da rodada 2, com controle positivo |
| Migrations 087–092 | **ESCRITO MAS NÃO EXECUTADO CONTRA BANCO** | nenhum `db push`; a CLI existe, mas aplicar atingiria produção |
| Migration 093 (cron) | **NÃO ESCRITA** — pertence ao passo 12 do rollout | por desenho, para que `db push` não agende no passo 1 |
| `manage-whatsapp-instances` | **NÃO DEPLOYADO** | — |
| `process-whatsapp-instance-cycles` | **NÃO DEPLOYADO** | — |
| Os 6 templates em `process-billing-notifications` | **NÃO DEPLOYADO** | — |
| Painel `/platform/instancias-whatsapp` | **NÃO DEPLOYADO** | commitado; sem push em `main`, a Vercel não construiu |
| Entradas de `verify_jwt` no `config.toml` | **ESCRITO MAS NÃO EXECUTADO CONTRA BANCO** | valem no deploy, que não houve |
| Testes de integração com banco (20 casos + FK-A a FK-G) | **`ENVIRONMENT_BLOCKED`** | [supabase/tests/whatsapp-instances.integration.md](../../supabase/tests/whatsapp-instances.integration.md) |
| Os 6 gates `saas-shield-br` | **`SAAS_SHIELD_GATES_EXECUTED`** | quatro rodadas; histórico completo em [FASE-6B-GATES-SEGURANCA.md](FASE-6B-GATES-SEGURANCA.md) |
| *Backfill* do Ren Sushi | **`NO_GO_BEFORE_BACKFILL`** | depende dos gates e do deploy |
| Cron | **NO-GO** | depende do *backfill* conferido e da execução manual idempotente |

---

## Testes — por invariante, não por total

**"661 testes" não é evidência de nada.** O que segue é o que cada teste prova.
Total da fase: **176 testes novos** (115 de núcleo das seções A–D + 37 do núcleo
do worker + 13 de validação de custo + 5 do guardrail de migration + 6 do
acoplamento). Baseline imediatamente antes: **485** — já incluindo os 42 do
hotfix do Risco 7, cujos commits são os mais antigos desta mesma branch.

### `whatsapp-instance-cycle-core` — 16 testes

| Invariante | Testes |
|---|---|
| **O fim do ciclo é EXCLUSIVO** — `>=` e não `>`, senão a rolagem atrasa um dia | 3 (antes / exatamente no vencimento / depois) |
| **Data civil, não instante** — a virada UTC entre 21h e 00h BRT não antecipa nada | 1 |
| **A âncora persistida sobrevive ao *clamp*** — 31 → 28/02 → **31**/03, nunca degradando para 28 permanentemente | 4 (`nextDueFromAnchor`) + 4 (`clampDayToMonth`) |
| Contagem de dias civis atravessando mês e ano | 2 |
| **Reexecução é idempotente** — mesma entrada, mesmo ciclo | 2 |

### `whatsapp-instance-core` — 16 testes

| Invariante | Testes |
|---|---|
| **Nunca criar instância na Z-API antes de pagamento confirmado** — a constante de bloqueio existe, está LIGADA, e recusa provisionamento novo | 3 |
| ***Backfill* de instância existente é permitido** — é o caminho do Ren Sushi | 1 |
| **Ambiguidade BLOQUEIA (fail-closed)** — na dúvida entre *backfill* e criação, recusa | 1 |
| **A mensagem de bloqueio não expõe segredo** | 1 |
| **`ENDED` não volta a `ACTIVE` silenciosamente**, nem com evidência | 1 |
| **`ACTIVE → ENDED` direto é recusado** — passa por `CANCELLATION_REQUESTED` | 1 |
| Reversão de cancelamento exige evidência no fornecedor | 1 |
| Transição para o mesmo estado é no-op (idempotência) | 1 |
| **`provider_instance_ref` é IDENTIFICADOR, nunca credencial** — recusa URL completa (carregaria o token na outra metade), vazio, valor longo demais, espaço/quebra de linha | 5 |

### `whatsapp-instance-revenue-core` — 17 testes

| Invariante | Testes |
|---|---|
| **Receita vem da assinatura `WHATSAPP_SUBSCRIPTION`, nunca da mensalidade do sistema** | 2 |
| **N>1 instâncias + 1 assinatura → `NULL`** — copiar os R$149 para cada uma inflaria a receita em N× | 2 |
| **Override vitalício é ZERO VERDADEIRO, não desconhecido** — e vence a assinatura | 2 |
| **Receita `NULL` é dado ausente, nunca zero** — sem assinatura e sem override dá `NO_ENTITLEMENT` | 1 |
| Assinatura de valor zero **não** é ausência de assinatura | 1 |
| **Margem `NULL` em qualquer ponta não vira margem** | 4 |
| **Ren Sushi: receita 0 + custo conhecido = margem NEGATIVA e visível** — é o produto da fase, não uma anomalia | 1 |
| **Nunca 0% para desconhecido** — receita zero é `NOT_APPLICABLE` (e nunca divisão por zero), `NULL` é `PENDING` | 4 |

### `whatsapp-instance-alerts-core` — 21 testes

| Invariante | Testes |
|---|---|
| **Os seis `event_type` canônicos são exatamente os da spec §10.6** | 2 |
| **Custo desconhecido NÃO tem `event_type` próprio** — é motivo do D-1 e pendência de painel, não aviso isolado | 1 |
| **Sem motivo, silêncio** — `resolveD1Reasons` devolve lista VAZIA quando está tudo em ordem; é o que torna o D-1 condicional | 1 |
| Cada motivo legítimo de D-1 gera exatamente um item | 4 |
| **`AMBIGUOUS_MULTI_INSTANCE` é caso PREVISTO** — receita `NULL` ali não é motivo | 1 |
| **`LIFETIME_OVERRIDE` com receita 0 não é motivo** — é o Ren Sushi, e ele não pode gerar alarme diário | 1 |
| Motivos mantêm ordem definida, não duplicam, são determinísticos | 2 |
| **D-7 cobre a janela 1..7** — worker que perder um dia ainda avisa | 1 |
| **D-1 só com motivo**, janela 0..1 | 1 |
| **Um D-7 por ciclo**; **D-1 muda de chave só quando o CONJUNTO de motivos muda**, não a ordem | 2 |
| **Pendência de data: `<YYYY-MM BRT>:<instance_id>`** — no máximo um lembrete por mês, e o mês seguinte abre ocorrência nova | 2 |
| ***Hash* de desequilíbrio é independente de ordem**, sensível a composição, e **custo desconhecido é distinto de zero** | 3 |

### `whatsapp-instance-divergence-core` — 20 testes

| Invariante | Testes |
|---|---|
| **O limiar é constante única e documentada** — sete dias | 1 |
| **`CHANNEL_WITHOUT_INSTANCE` por EVIDÊNCIA PERSISTIDA, não por `status`** — canal em `error` é integração real que ainda custa | 3 |
| **`PAYING_WITHOUT_CHANNEL` não confunde com `AWAITING_PROVISION`** — ali o canal ainda não existe por definição | 3 |
| **`INSTANCE_REF_MISMATCH` nunca corrige sozinho**, e ausência de valor não vira *mismatch* | 3 |
| **`LIFECYCLE_VS_CHANNEL_STATE`: sete dias COMPLETOS**, `connected` resolve, explicação administrativa suprime, status desconhecido não gera | 6 |
| **`ALIVE_AFTER_END` é evidência LOCAL** — sinal posterior gera, anterior não | 3 |
| **O texto NUNCA afirma que a Z-API continua cobrando** | 1 |

### `whatsapp-partner-simulator-core` — 8 testes

| Invariante | Testes |
|---|---|
| **Preço-alvo é OBRIGATÓRIO** — não existe preço de Partner no código; zero e negativo são recusados | 3 |
| **Usa apenas custo real registrado, e rotula como simulação** | 1 |
| **Custo desconhecido é contado à parte, nunca somado como zero** | 1 |
| **Sem custo conhecido, não há ponto de equilíbrio inventado** | 2 |
| Economia negativa aparece como negativa — o Partner pode não compensar | 1 |

### `whatsapp-instance-format` — 17 testes (superfície do painel)

| Invariante | Testes |
|---|---|
| **Desconhecido nunca vira R$ 0,00**; zero é zero de verdade | 3 |
| **Nunca 0% para desconhecido** — receita zero é "não aplicável", `NULL` é "pendente" | 4 |
| **`provider_access_until` é EXCLUSIVO** — o último dia de acesso é a véspera, e sem data não se inventa rótulo | 4 |
| **`cycle_source='UNKNOWN'` nunca parece data confirmada** | 3 |
| **Nenhuma *copy* de divergência afirma cobrança do fornecedor**; tipo desconhecido cai no próprio código | 3 |

### `whatsapp-instance-alerts-dispatcher` — 5 testes (o acoplamento por string)

| Invariante | Testes |
|---|---|
| **Todo `event_type` canônico tem entrada em `TEMPLATE_BY_EVENT`** — sem ela a linha morre em `failed/unknown_event_type` | 1 |
| **Nenhum produtor emite `event_type` fora da lista canônica** | 1 |
| Custo desconhecido não virou `event_type` em lugar nenhum | 1 |
| Os seis `alert_type` do ledger mapeiam para os seis `event_type` | 1 |
| **Controle positivo** — o detector encontra um evento que sabidamente existe | 1 |

### `migration-static-guard` — 5 testes

| Invariante | Testes |
|---|---|
| **Nenhuma migration NOVA embute URL de projeto Supabase** | 1 |
| Nenhuma migration embute segredo | 1 |
| **A allowlist legada não cresce** — ela é histórica e fechada nos treze arquivos | 1 |
| Entrada órfã na allowlist esconde regressão | 1 |
| **Controle positivo** — o guardrail realmente detecta o padrão | 1 |

---

## Os testes que NÃO existem, e por quê

**Quinze casos de integração com banco estão escritos e marcados
`ENVIRONMENT_BLOCKED`.** Eles não são `.test.ts` de propósito: arquivo de teste
que não roda vira `skip` silencioso, e `skip` verde é a mentira que a Seção D
proíbe.

Onze dos quinze são regras que **vivem no banco** — CHECK, índice único parcial,
*trigger* de tenancy, ACL. **Nenhum *mock* pegaria**, e o hotfix do Risco 7 já
provou o ponto: a classificação estava certa e a retenção não persistia porque o
`UPDATE` violava um CHECK.

Detalhe completo e os dois bloqueios de ambiente em
[supabase/tests/whatsapp-instances.integration.md](../../supabase/tests/whatsapp-instances.integration.md).

---

## Os dois bloqueios independentes

| | Bloqueio | Consertar o outro resolve? |
|---|---|---|
| **A** | O replay do histórico **não completa**: `42P13 — cannot change return type of existing function` (54 `create or replace function` alterando retorno tabular contra 4 `drop function`) | **Não** |
| **B** | Mesmo completando, o banco reconstruído **seria inseguro**: URL de produção nos treze *wrappers* de `pg_cron`, `create extension pg_net` ausente do histórico, Vault assumido semeado | **Não** |

Frente `BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT`, **nesta ordem**: 1º tornar o
histórico reproduzível sem `42P13`; 2º tornar o ambiente reconstruído seguro.
**Fora do escopo da 6b** — a 6b só garante que nenhuma migration nova repita o
padrão, e isso é testado.

---

## O que esta fase remove

**Três flags `zapi_auto_*`** (migration 091), nascidas na 061 sem automação
*end-to-end* que as consumisse. Verificação atual: `grep` encontra os nomes
apenas na própria 061 e em documentação — **nenhum consumidor de código**.

A reversão não depende de comentário no rodapé: os valores anteriores estão
registrados e a migration de restauração está pronta em
[restore-zapi-auto-flags.sql](restore-zapi-auto-flags.sql).

**A 6b não cria flag própria.** A fase não altera envio, `billing_status`,
entitlement, nem chama o provedor — e o cron pode ser desagendado na hora. O
freio operacional é o desagendamento, não uma flag.

Estado das flags ao fim da fase, **inalterado**: `whatsapp_service_enforcement`
OFF · `whatsapp_implementation_flow` OFF · `whatsapp_subscription_checkout` OFF ·
`billing_notifications_dispatch` OFF · Asaas em **sandbox**.

---

## Decisões forçadas pelo schema real (todas aprovadas)

Cinco divergências entre o plano e o banco, encontradas pelos passos de
verificação do próprio plano e corrigidas no código:

| Plano dizia | Schema real | Consequência |
|---|---|---|
| `set_updated_at()` | `update_updated_at()` | *trigger* das três tabelas |
| `is_platform_admin()` | `is_platform_admin(p_user_id uuid)` | policies e guards |
| `platform_flags.value` texto | `jsonb` | `restore-zapi-auto-flags.sql` usa `'false'::jsonb` |
| `whatsapp_channels.organization_id` | **não existe** | *trigger* de tenancy resolve a org por `whatsapp_channels → units` |
| `billing_subscriptions` tem valor | preço vive em `billing_plans.amount_cents` | atribuição de receita faz o *join* |
| `organization_entitlement_overrides.override_type` | `grant_type` | resolução de override vitalício |

**Não foi adicionado `organization_id` redundante a `whatsapp_channels`** para
simplificar *join* — isso seria mudança de schema alheio dentro da 6b.

---

## Defeito encontrado e corrigido nesta fase

**O worker não enfileirava nada.** O ledger e os seis templates existiam, mas
`EVENT_TYPE_BY_ALERT` só era lido pelo teste — `billing_notifications` nunca
recebia linha. Corrigido em `58ce517`: `upsertAlert` enfileira num ponto único.

**E enfileira SÓ em `created` ou `reminded`, nunca em `seen`.** O UNIQUE de
`billing_notifications` é **parcial** e **não deduplica com `invoice_id` nulo** —
e todo aviso desta fase é sem fatura. Enfileirar a cada passada criaria uma linha
por dia para o mesmo fato. **A cadência mensal vive no ledger, não na fila.**

---

## Commits da branch (do mais antigo)

| Commit | Conteúdo |
|---|---|
| `6550df2` | Spec, Seções A e B |
| `10d4d40` | Spec, Seção C |
| `a71f91a` | Spec, Seção D |
| `133a0ac` | Spec, fechamento da Seção D |
| `4fb8d37` | Plano em 23 tasks |
| `2898889` | Núcleos 1–2 (calendário, gate de provisionamento) |
| `479de74` | Núcleos 3–6 (receita, alertas, divergências, simulador) |
| `6e5dc45` | Guardrail de migration no CI + correção do veredito de reconstrução |
| `daf5bba` | Migrations 087–092 — **escritas, não aplicadas** |
| `7f6b59b` | Seis templates + teste do acoplamento por string |
| `3899348` | EF, worker e painel |
| `a2ca27a` | CLAUDE.md — invariantes e checklist de redeploy |
| `58ce517` | Vocabulário canônico dos seis `event_type` + o enfileiramento que faltava |
| `ebb1380` · `916c072` · `469ade2` | Continuidade, diagnóstico de ambiente, barreira contra produção |
| `b255407` | Rodada 1 dos gates — três bloqueantes do worker |
| `0ca1304` | Rodada 2 — o `ReferenceError` que eu introduzi no caminho de autorização + guardrail `no-undef` |
| `19f8e53` | **Lote de estabilização** — FK × CHECK do ledger, extração do núcleo do worker |
| `e446ba3` | **Passada final dos gates** — enqueue em três tempos, oito achados fechados |

Três commits anteriores da branch pertencem ao **hotfix do Risco 7**, não à 6b:
`d9dbaa5`, `1183d3b`, `d7198bc` (ver
[09-HOTFIX-RISCO-7-CLASSIFICACAO-FATURA.md](09-HOTFIX-RISCO-7-CLASSIFICACAO-FATURA.md)).
Eles **também não foram deployados** e entram no mesmo pacote de execução.

---

## Próximo passo

**Não há próxima rodada de correção de código da 6b.** Os gates convergiram e o
pacote documental está fechado.

O que resta é externo ao código:

| Pendência | Onde |
|---|---|
| `GIT_HISTORY_SECRET_SCAN` — `gitleaks`/`trufflehog` em shell autorizado | [FASE-6B-GATES-SEGURANCA.md](FASE-6B-GATES-SEGURANCA.md) |
| Ambiente capaz de validar banco (Docker, `psql`, stack isolada) | [FASE-6B-DIAGNOSTICO-AMBIENTE.md](FASE-6B-DIAGNOSTICO-AMBIENTE.md) |
| `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE` — antes de ligar o dispatch | [FASE-6B-FOLLOWUPS.md](FASE-6B-FOLLOWUPS.md) |
| Rollout em 21 passos, quando autorizado | [FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md) |

⛔ **Não aplicar migrations · não deployar EFs · não fazer backfill · não criar
cron · não fazer merge.**
