# Fase 6b — Lote único de estabilização

Rodada única que substitui o ciclo "corrige um achado → reauditora → encontra o
adjacente". Fecha os **onze achados abertos** das três rodadas de gates, corrige
o conflito FK × CHECK, extrai o núcleo testável do worker e reordena o rollback.

**Commit auditado na entrada do lote: `0ca1304`.**

---

## 1. Por que um lote, e não a quarta rodada

A curva de achados foi 1 → 8 → 9. Ela **não** mede piora de qualidade: mede
profundidade de leitura. A rodada 1 olhou o worker; a 2 olhou o que a 1 tinha
corrigido; a 3 olhou a interação entre objetos de schema que nenhuma das duas
anteriores havia cruzado. O `FINDING-004` é a evidência — ele existe desde a
primeira versão da migration 089 e sobreviveu a duas auditorias.

O que sustentava o ciclo era estrutural: **o worker não é importável por
vitest.** Ele chama `serve()` no carregamento do módulo e importa `deno.land` e
`esm.sh`. Toda correção nele só podia ser verificada por leitura — e leitura foi
exatamente o que deixou passar o `ReferenceError` da rodada 2 e o conflito FK ×
CHECK das rodadas 1 e 2. A extração do núcleo é o item que fecha essa lacuna.

---

## 2. Inventário fechado — onze achados

| ID | Gate de origem | Sev | Arquivo | Comportamento atual | Risco | Correção | Teste | Status |
|---|---|---|---|---|---|---|---|---|
| **F-01** | rls-auditor `FINDING-004` | **P2** | [089](../../supabase/migrations/20260801200200_089_whatsapp_instance_alerts.sql) | FK `instance_id … on delete set null` × CHECK exigindo `instance_id is not null` no ramo INSTANCE | Excluir instância com alerta INSTANCE aborta a transação com `check_violation` — contradiz o contrato "ledger sobrevive nulando" | CHECK aceita `instance_id is null` no ramo INSTANCE; rigor de INSERT e imutabilidade de `subject_id` migram para trigger | FK×CHECK A–E (banco) | CORRIGIDO |
| **F-02** | tenant-isolation + integration-reliability | **P2** | worker `upsertAlert` | `UPDATE … .eq(organization_id)` sem `.select()`: PostgREST devolve `error: null` com zero linhas casadas | Predicado de tenant que não casa devolve "reminded" e enfileira e-mail sem ter escrito nada | `.select("id")` + zero linhas ⇒ `failed` | núcleo L | CORRIGIDO |
| **F-03** | migration-validator | **P2** | 088 / 090 / 092 | Rollback da 088 cobre só 089→088; ignora a dependência direta de 090 e 092 | Operador executa a sequência publicada e falha no meio, com objetos órfãos | Ordem inversa real 092 → 090 → 089 → 088, publicada nas quatro migrations | guard estático | CORRIGIDO |
| **F-04** | integration-reliability (resíduo REG-03) | P3 | worker `stepEconomics` | `imbalancesReported: s.processed` — `s` é compartilhado com o laço DATE_REVIEW | Três pendências de data são reportadas como três desequilíbrios econômicos | Contadores separados por sub-passo | núcleo F | CORRIGIDO |
| **F-05** | tenant-isolation | P3 | worker `upsertAlert` | `existing.status !== "OPEN"` ⇒ `"seen"` mudo | Fato que reincide sob chave já RESOLVED nunca reabre e nada registra a supressão | Desfecho `suppressed` + telemetria própria | núcleo M | CORRIGIDO |
| **F-06** | integration-reliability | P3 | worker `stepDivergences` | `const { data: ch } = …` — erro do lookup de canal descartado | Falha de leitura vira `legacyRef = null` e produz/suprime `INSTANCE_REF_MISMATCH` falso | Erro propaga; instância cai em `failed` | núcleo G | CORRIGIDO |
| **F-07** | identity-access (pré-existente) | P3 | EF `confirm_end` / `reactivate` | `instance_id` ausente não é barrado; `.eq("id","")` erra no Postgres | 404 "Instância não encontrada" quando o pedido é que estava malformado | Guard explícito ⇒ 400 | — (leitura) | CORRIGIDO |
| **F-08** | integration-reliability | P3 | worker + `billing-notify.ts` | `enqueueBillingNotification` devolve `void` e engole a falha | Ledger grava "lembrado", e-mail não sai, próximo lembrete real só em 30 dias | Retorno `boolean`; janela só avança com enfileiramento confirmado | núcleo D | CORRIGIDO |
| **F-09** | identity-access (pré-existente) | P3 | EF, 4 leituras | `const { data: … } = await …maybeSingle()` sem checar erro | Indisponibilidade do banco vira 404 "não encontrada" — diagnóstico invertido | Erro ⇒ 503 com mensagem própria | — (leitura) | CORRIGIDO |
| **F-10** | migration-validator | P3 | processo | Regra de não reescrever migration aplicada não estava afirmada no pacote | Alguém edita 087–092 depois do `db push` | Regra publicada no pacote de execução | guard estático | CORRIGIDO |
| **F-11** | rls-auditor `FINDING-005` | P3 | rollback | `drop table` publicado sem advertência sobre o que ele destrói | Perda irreversível de auditoria financeira num rollback "de rotina" | Rollback operacional preferencial + advertência destacada | — (documental) | CORRIGIDO |

### Achado descoberto durante a implementação

| ID | Sev | Arquivo | Comportamento | Correção |
|---|---|---|---|---|
| **F-12** | P3 | worker `upsertAlert` | Alerta nasce com `last_reminder_at` NULL ⇒ `last = 0` ⇒ o lembrete "mensal" dispara **no dia seguinte** à criação | Criação consome o slot quando o enfileiramento confirma | núcleo C |

Registrado neste lote conforme a regra: achado novo durante a implementação
entra no mesmo lote e é avaliado antes da rodada final, sem abrir auditoria
imediata.

---

## 3. Critérios de aceite

**P2 — obrigatórios antes de GO.** Cada um exige correção *e* prova
correspondente (teste executável ou prova estática nomeada).

- **F-01** — as cinco situações A–E abaixo têm comportamento afirmado no schema,
  não na intenção do produtor. Os testes ficam `WRITTEN / NOT EXECUTED AGAINST
  DATABASE`: sem Docker, comportamento de FK e CHECK **não** é declarável verde.
- **F-02** — teste do núcleo com repositório que devolve zero linhas casadas; o
  desfecho tem de ser `failed`, e nenhum enfileiramento pode ocorrer.
- **F-03** — as quatro migrations publicam a mesma ordem inversa, e o guard
  estático de migrations continua verde.

**P3 — corrigido no lote, ou aceito com justificativa explícita.** Nenhum fica
ambíguo. Os onze acima estão todos corrigidos; nenhum foi aceito com follow-up.

---

## 4. F-01 — desenho aprovado para FK × CHECK

O contrato funcional não muda: o ledger é registro administrativo, não é
apagado em cascata, e a exclusão da instância **nem apaga o histórico nem é
bloqueada** por ele.

O desenho anterior era internamente contraditório:

```
FK   instance_id → whatsapp_instances(id) ON DELETE SET NULL
CHECK subject_type='INSTANCE' AND instance_id IS NOT NULL AND subject_id = instance_id

DELETE da instância → FK grava NULL → CHECK avalia FALSE → DELETE inteiro aborta
```

**Semântica adotada** (preferência do dono do produto, item 2 da autorização):

| Campo | Enquanto a instância existe | Depois da exclusão física |
|---|---|---|
| `subject_id` | UUID da instância | **imutável** — identidade histórica preservada |
| `instance_id` | igual a `subject_id` | `NULL` (ação da FK) |
| `organization_id` | obrigatório | obrigatório, inalterado |
| consultável no painel | sim | sim, com marcação "instância removida" |

O CHECK passa a ser:

```sql
(subject_type = 'INSTANCE'    and (instance_id is null or subject_id = instance_id))
or (subject_type = 'ORGANIZATION' and instance_id is null and subject_id = organization_id)
```

Relaxar o CHECK **sozinho** abriria um buraco: `INSERT` de alerta INSTANCE com
`instance_id` nulo e `subject_id` arbitrário passaria a ser aceito. Por isso o
rigor original migra para uma trigger que distingue as duas operações — algo que
um CHECK, por construção, não sabe fazer:

- **INSERT** — `subject_type='INSTANCE'` exige `instance_id` **vivo** e
  `subject_id = instance_id`. Idêntico à garantia original.
- **UPDATE** — `subject_id` é imutável; `instance_id` só pode ir a `NULL` (a
  ação da FK), nunca ser reapontado para outra instância.

A FK **não** vira `cascade` (apagaria auditoria) nem `restrict` (impediria a
exclusão, contrariando a promessa de preservação por nulagem).

### Consumidores verificados antes da mudança

Todo consumidor que filtra alerta por `instance_id` parte de uma instância
**viva**, e nenhum depende de `instance_id` ser não-nulo em alerta INSTANCE:

| Consumidor | Uso | Afetado |
|---|---|---|
| `manage-whatsapp-instances` `get_instance` | `.eq("instance_id", id)` | não — `id` é instância existente |
| `manage-whatsapp-instances` `confirm_cycle_date` | resolve `DATE_REVIEW_REQUIRED` por `instance_id` | não |
| worker `hasOpenDivergence` | `.eq("instance_id", …)` | não |
| worker `upsertAlert` | dedupe por `(subject_type, subject_id, alert_type, dedupe_key)` | não — a chave usa `subject_id`, que sobrevive |
| painel `WhatsappInstances.tsx` | renderiza por `alert_type` e `payload` | **sim** — ganha a marcação "instância removida" |

Índice `whatsapp_alerts_instance_idx` é parcial (`where instance_id is not
null`): a linha simplesmente sai do índice quando é nulada. Correto sem mudança.

---

## 5. Extração do núcleo do worker

**Fronteira.** Não é reescrita da fase. Comportamento aprovado das seções A–D,
nomes canônicos, schemas, `event_type`, chaves de dedupe, sequência dos cinco
passos, ausência de chamada externa, ausência de escrita em `billing_status` e
em entitlement — tudo preservado. A única mudança de regra é **F-12**, e ela
está declarada acima antes de ter sido feita.

| Núcleo — [`whatsapp-instance-worker-core.ts`](../../supabase/functions/_shared/whatsapp-instance-worker-core.ts) | Adapter — [`index.ts`](../../supabase/functions/process-whatsapp-instance-cycles/index.ts) |
|---|---|
| decisão de criar/lembrar/suprimir alerta | cliente Supabase, queries, inserts, updates |
| política de avanço do lembrete e do payload | RPCs `roll_whatsapp_instance_cycle`, lock |
| decisão de enfileirar | resolução real do destinatário |
| contadores e classificação por sub-passo | relógio real, `serve`, resposta HTTP |
| fluxo dos cinco passos e isolamento entre eles | leitura de credencial legada (extração do identificador) |
| telemetria estruturada (eventos e campos) | emissão via `jsonLog` |

O núcleo **não** importa Supabase, Deno, `fetch`, variáveis de ambiente nem
cliente de provedor. Recebe `clock`, `repo`, `notifier`, `recipients`,
`telemetry` e `reqId` por injeção.

---

## 6. Mapa de testes

| Bloco | Onde | Execução |
|---|---|---|
| Núcleo do worker A–M | `src/lib/whatsapp-instance-worker-core.test.ts` | **EXECUTED** |
| Validação de custo (J) | `src/lib/whatsapp-instance-core.test.ts` | **EXECUTED** |
| FK × CHECK A–E | `supabase/tests/whatsapp-instances.integration.md` | **WRITTEN / NOT EXECUTED AGAINST DATABASE** |
| RLS, grants, índices parciais, `SECURITY DEFINER`, triggers, concorrência da RPC | idem | **ENVIRONMENT_BLOCKED** |

```
WORKER_CORE_TESTS:        EXECUTED
DATABASE_CONSTRAINT_TESTS: ENVIRONMENT_BLOCKED
```

Teste de núcleo **não** substitui teste de banco. Não há Docker; nenhuma stack
local foi criada e nenhuma integração é declarada verde.

---

## 6-bis. Achados da rodada final e o que foi feito com cada um

Os seis gates rodaram contra `19f8e53`. **Zero P0, zero P1.** Oito achados
novos, todos corrigidos ou decididos explicitamente — nenhum ambíguo.

| ID | Gate | Sev | O que era | Decisão |
|---|---|---|---|---|
| **IR-001** | integration-reliability | **P2** | Enfileirar ANTES de gravar trocava "aviso perdido" por "aviso duplicado": com escrita falhando de forma persistente, um aviso idêntico por dia, **sem teto** — o UNIQUE de `billing_notifications` é parcial e não deduplica com `invoice_id` nulo, que é o caso de todo aviso desta fase | **CORRIGIDO** — ordem em três tempos |
| IR-002 | integration-reliability | P3 | O teste L prometia "nada é enfileirado" sem asseverar, e o teste de reexecução usava `find()` estático: passariam com o defeito presente | **CORRIGIDO** — bancada com estado mutável + asserções reais |
| IAA-01 | identity-access | P3 | `get_instance` — quinto caminho de leitura, escapou do F-09: `if (inst.error \|\| !inst.data)` colapsava indisponibilidade em 404 | **CORRIGIDO** |
| IAA-02 | identity-access | P3 | `requireInstanceId` validava presença, não forma: `"abc"` virava 503 "tente novamente" + alarme falso | **CORRIGIDO** — `parseUuid`, 400 |
| IAA-03 | identity-access | P3 | `resolvePlatformAdminRecipients` devolve `[]` tanto em erro quanto em tabela vazia | **ACEITO** — ver abaixo |
| IAA-04 | identity-access | P3 | O guardrail `no-undef` não rodava em CI — dependia de disciplina local | **CORRIGIDO** — passo novo no workflow |
| MV-001 | migration-validator | P3 | Rollback da 087 sem referência cruzada nem advertência | **CORRIGIDO** |
| MV-002 | migration-validator | P3 | 092 sem `begin;`/`commit;` | **REJEITADO** — ver abaixo |
| MV-003 | migration-validator | P3 | O comentário "089 antes da 088" citava a razão autocontida, não a cruzada | **CORRIGIDO** — texto nomeia a função e adverte contra reordenar |
| TI-001 | tenant-isolation | P3 | `recordDivergenceKind` descartava erro de escrita | **CORRIGIDO** |

### IR-001 — a ordem em três tempos, e por que não era só inverter

O F-08 mandou enfileirar antes de gravar, para que o slot mensal nunca fosse
consumido por um aviso que não saiu. Correto para o defeito que endereçava — e
gerador do defeito espelhado: enfileirar sem conseguir registrar que enfileirou.

Inverter de volta reabriria o F-08. A saída foi separar a escrita em duas:

1. **Toca** a linha sem avançar o lembrete (`last_seen_at` + `payload`). É o
   **pedágio de escrita**: se o UPDATE não passa, nada é enfileirado. A classe
   de falha persistente que o auditor descreveu morre aqui.
2. **Enfileira** — agora com a escrita já provada possível naquela linha.
3. **Carimba** o slot consumido. Só o que entrou na fila avança o lembrete.

**Risco residual aceito e declarado:** se o passo 1 funcionar e o passo 3 falhar
— mesma linha, mesmo predicado, segundos depois — a próxima passada relembra e
enfileira uma segunda vez. Uma duplicata, não um fluxo diário. Fechar isso de
vez exige RPC transacional cobrindo fila e ledger juntos, e isso é
**PRÉ-REQUISITO para ligar `billing_notifications_dispatch`** nos seis
`admin_zapi_*` — não para esta fase, em que a flag está OFF e a fila só acumula.

Controle positivo executado: revertendo para a ordem antiga, **8 testes
reprovam**, incluindo o L que antes era vazio.

### IAA-03 — aceito, com justificativa e follow-up

`resolvePlatformAdminRecipients` devolve `[]` em erro de leitura e em tabela
vazia. O worker então trata "não consegui ler" como "não há admin".

**Por que aceitar:** o impacto é contido e barulhento — o núcleo preserva o slot
mensal quando não há destinatário, loga `wa_alert_no_admin_recipient` e
`wa_alert_reminder_no_recipient` com `needsAdminAction`, e o worker é diário.
Nada se perde; adia-se 24h.

**Por que não corrigir aqui:** a função vive em `_shared/billing-notify.ts`, com
dez consumidores em outras fases. Mudar a assinatura arrasta redeploy cruzado de
billing inteiro para resolver um adiamento de um dia numa fase que não está
deployada. É troca ruim dentro do escopo da 6b.

**Follow-up:** agrupar com a próxima mudança legítima de `billing-notify.ts` —
provavelmente a RPC transacional do IR-001, que toca o mesmo arquivo.

### MV-002 — rejeitado, com evidência

O achado pede `begin;`/`commit;` na 092. Verificado no repositório: das
**oito** migrations de wrapper de cron do projeto (029, 043, 045, storage
orphan, stripe expire, billing crons, 064, 069), **zero** usam `begin;`. A 092
segue o precedente; envolvê-la em transação é que seria a exceção.

Mesmo achado já julgado improcedente na rodada 1, agora com evidência mais
ampla. Registrado para não voltar numa quinta rodada.

---

## 7. Critério de convergência da rodada final

Aprovado (item 11 da autorização): zero P0, zero P1, zero P2 aberto, P3
corrigidos ou aceitos explicitamente, guardrails locais verdes, gates afetados
reexecutados sobre o commit final, nenhum achado bloqueante novo, histórico
documentado, limitações de integração preservadas.

Achado P2 ou superior na passada final ⇒ NO-GO, corrige, reexecuta **apenas** os
gates cujo domínio foi afetado. Só P3 novo ⇒ avaliar se é defeito, melhoria ou
preferência; corrigir ou aceitar; não abrir rodada completa sem análise de
impacto.

---

## 8. Bloqueios operacionais — inalterados pelo lote

Mesmo com os gates em GO: migrations não aplicadas, EFs não deployadas, painel
não deployado, integração com banco `ENVIRONMENT_BLOCKED`, Docker ausente,
backfill NO-GO, cron NO-GO, merge NO-GO, comandos remotos proibidos. O
repositório permanece vinculado à produção.

`GIT_HISTORY_SECRET_SCAN` era pendência quando este documento foi escrito;
foi executada em 2026-08-02, encontrou um secret real e o incidente está
**contido**. Ver [INCIDENTE-2026-08-02-INTERNAL-API-KEY.md](../INCIDENTE-2026-08-02-INTERNAL-API-KEY.md).
