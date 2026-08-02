# FASE 6B — Os seis gates `saas-shield-br` — quatro rodadas

> Continuidade: [FASE-6B-RESUMO.md](FASE-6B-RESUMO.md) · Rollout:
> [FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md) · Lote final:
> [FASE-6B-LOTE-ESTABILIZACAO.md](FASE-6B-LOTE-ESTABILIZACAO.md).

| Rodada | Commit auditado | Resultado |
|---|---|---|
| 1 | `469ade2` | 5 PASS · `integration-reliability` **FAIL** (3 ALTO) → corrigido em `b255407` |
| 2 | `b255407` | `integration-reliability` PASS · `identity-access` **FAIL** (`ReferenceError` no caminho de autorização) → corrigido em `0ca1304` |
| 3 | `0ca1304` | 5 PASS/PASS_WITH_WARNINGS · zero P0/P1 · **11 achados abertos**, incluindo o defeito latente FK × CHECK |
| **Final** | `19f8e53` + `e446ba3` | 6 gates · zero P0/P1/P2 aberto · **`SAAS_SHIELD_OVERALL: GO`** |

## Como ler a sequência

**A curva 1 → 8 → 9 achados NÃO representa piora linear.** Ela representa:

- aumento da **profundidade** da análise;
- expansão das **interações** examinadas;
- descoberta de **defeitos latentes**;
- melhoria da **testabilidade**;
- migração de garantias sustentadas por **leitura** para garantias sustentadas
  por **teste**.

A rodada 1 olhou o worker; a 2 olhou o que a 1 havia corrigido; a 3 cruzou
objetos de schema que nenhuma anterior havia relacionado entre si.

**A convergência ocorreu quando o worker foi extraído para núcleo injetável** —
não antes, e não por disciplina de quem corrigia.

O `FINDING-004` é a prova. Ele é **defeito latente da migration 089 desde a
versão original** (`daf5bba`) — não regressão de correção — e passou por duas
auditorias completas antes de alguém analisar a interação entre a FK e a lógica
ternária do CHECK.

**Atribuição correta:** `LATENT_SCHEMA_DEFECT_DISCOVERED_DURING_REAUDIT`.
Não `REGRESSION_INTRODUCED_BY_0ca1304`.

O que sustentava o ciclo era estrutural, não humano: **o worker não era
importável por vitest**. Chamava `serve()` no carregamento e importava
`deno.land`/`esm.sh`, então toda correção nele só podia ser verificada por
leitura — e leitura foi exatamente o que deixou passar o `ReferenceError` da
rodada 2 e o conflito FK × CHECK das rodadas 1 e 2. A rodada final quebra isso
extraindo o núcleo.

---

## Por que rodaram ANTES de Docker

Os seis auditores declaram `tools: Read, Glob, Grep` — **nenhum tem shell, nenhum
acessa banco**. São auditorias estáticas sobre arquivos do repositório.

O bloqueio anterior (`SAAS_SHIELD_GATES_NOT_EXECUTED`) estava classificado como se
dependesse do ambiente. **Não dependia.** Dependia só de autorização de despacho de
subagentes. Corrigido o sequenciamento: **os gates são o passo 1 do caminho
crítico**, antes de instalar Docker, `psql` ou qualquer preparo de stack.

---

# RODADA 1 — `469ade2`

## Resultado por gate

| Gate | Veredito inicial | Críticos/Altos | Médios | Baixos/P3 |
|---|---|---|---|---|
| `migration-validator` | PASS_WITH_WARNINGS | 0 | 0 | 2 |
| `rls-auditor` | PASS | 0 | 1 | 0 |
| `tenant-isolation-auditor` | PASS_WITH_WARNINGS | 0 | 0 | 1 |
| `identity-access-auditor` | PASS | 0 | 0 | 4 |
| `secret-hunter` | PASS | 0 | 0 | 1 (informativo) |
| **`integration-reliability-auditor`** | **FAIL** | **3** | **2** | 0 |

**Veredito consolidado inicial: NO-GO** — três achados ALTO no worker.

**Todos os 13 achados foram verificados por leitura direta do código antes de
qualquer correção.** Nenhum foi aceito por confiança no relatório.

---

## Os três bloqueantes — confirmados e corrigidos

Os três são regressões introduzidas na rodada anterior, quando o enfileiramento
foi acrescentado ao worker.

### ALTO-1 — cache de destinatário admin nunca zerado

`adminRecipient` é módulo-level e o `serve()` reseta `reqId`, mas não ele. O
CLAUDE.md documenta o padrão oposto: `process-voucher-triggers` faz
`unitCache.clear()` a cada invocação **porque o isolate sobrevive entre
execuções**.

**Falha concreta:** primeira execução sem `platform_admins` → `null` cacheado. Um
admin é criado depois. Segunda execução no mesmo isolate devolve o `null` cacheado
sem reconsultar → todo alerta nasce **mudo**, sem erro e sem sinal, até o isolate
reciclar. Quebra a premissa do próprio arquivo: *"o sinal de falha é a
telemetria"*.

**Correção:** `adminRecipient = undefined` no início do `serve()`.

### ALTO-2 — erro na query de instâncias não abortava `stepDivergences`

`if (instErr) { log; s.failed++; }` **sem `return`** — e dez linhas abaixo a query
de canais faz `return s;` no erro. Inconsistência dentro da mesma função.

**Falha concreta:** `instances` fica `undefined`, `linked` nasce vazio, e **todo
canal elegível vira `CHANNEL_WITHOUT_INSTANCE`** — falso positivo em massa que a
chave mensal mantém `OPEN` por até um mês, escondendo divergência real no ruído.

**Correção:** `return s;` após o log.

### ALTO-3 — `stepEconomics` engolia erro das duas queries

Ambas desestruturavam só `data`. Falha → laços rodam zero vezes → `processed: 0,
failed: 0`, **indistinguível de "nada a reportar"**.

**Falha concreta:** janela cega sobre o único mecanismo de detecção de prejuízo da
fase, sem nenhum traço em log.

**Correção:** capturar `error`, logar com `needsAdminAction`, incrementar
`s.failed`, retornar cedo.

---

## Os dois médios do worker — corrigidos

### MÉDIO-1 — `resolveRevenueForOrg` e `hasOpenDivergence` degradavam em silêncio

`countRes.count ?? 0` viraria "zero instâncias"; `subRes.data` nulo viraria "sem
assinatura"; `hasOpenDivergence` devolveria `false`. Todos se confundem com estado
real e alimentam tanto os motivos do D-1 quanto o desequilíbrio econômico.

**Correção:** as duas **lançam** em erro de leitura. Os dois callers já rodam em
`try/catch` por item — a instância entra em `failed` e é revista amanhã.
**Receita desconhecida por falha de leitura não pode virar receita desconhecida
por ausência de contrato.**

### MÉDIO-2 — `dedupeKeyD1` carregava os motivos

A janela do D-1 tem dois dias e os motivos são recalculados a cada passada. Um
custo que sincroniza ou uma divergência que abre no meio mudava o conjunto → chave
diferente → **segunda linha `created`** para o mesmo vencimento, e a primeira
congelada com uma lista que já não valia.

**Correção:** chave ancorada só em `cycleStart`, como o D-7. Motivos vão para o
`payload`.

**Uma correção adicional que o relatório não previu:** ele afirmou que o `payload`
*"já é atualizado a cada `upsertAlert`/reminder"*. **Não era** — o caminho de
lembrete só tocava `last_seen_at`, `occurrences` e `last_reminder_at`. Sem também
reescrever o `payload`, tirar os motivos da chave teria congelado a lista no
primeiro dia — trocando um defeito por outro. `upsertAlert` agora reescreve o
`payload` no lembrete.

---

## Achados dos demais gates — corrigidos

| Origem | Achado | Correção |
|---|---|---|
| `rls-auditor` (MÉDIO) | As três policies sem `TO authenticated`, escopando para `PUBLIC`. A 071 usa o padrão explícito, e a 085 documenta o baseline auditado *"`is_platform_admin` → 26 policies `{authenticated}` + 0 `{public}`"* | `to authenticated` nas três (087/088/089) |
| `migration-validator` (P3) | `on delete cascade` na FK de organização do ledger, contra `restrict` nas duas irmãs | `restrict` na 089 |
| `tenant-isolation-auditor` (P3) **e** `identity-access-auditor` (BAIXO) | `whatsapp_instance_cycles` e `whatsapp_instance_alerts` sem guarda de tenant equivalente à da 087 | `whatsapp_instance_child_tenant_guard()` na 088, reusada pela 089 |
| `identity-access-auditor` (BAIXO) | `cost_source` aceitava string livre do payload; coluna sem CHECK | Whitelist `normalizeCostSource` na EF, 400 em valor fora do domínio |
| `identity-access-auditor` (BAIXO) | `error` do lookup de `platform_admins` descartado — indisponibilidade e "não é admin" davam 403 idêntico e mudo | Log `platform_admin_lookup_failed`, mantendo fail-closed |

**Sobre o `on delete cascade`:** não era só inconsistência entre tabelas. O
cabeçalho da própria 089 justifica `on delete set null` no `channel_id` dizendo
que *"o ledger é registro de auditoria e não pode ser apagado em cascata"* — e a
FK de organização apagava o ledger inteiro. Contradição dentro do mesmo arquivo.

**Sobre a guarda de tenant:** dois gates com escopos diferentes convergiram no
mesmo ponto. Nenhum caminho de escrita atual é explorável (todo produtor deriva
`organization_id` server-side), mas a classe de erro que ela impede — **custo
atribuído à organização errada** — é exatamente a que a fase existe para evitar.

---

## Não corrigidos, com decisão registrada

| Achado | Decisão |
|---|---|
| `acknowledge_alert` sem motivo obrigatório (`identity-access`, BAIXO) | **Aceito por projeto.** O *ack* não fecha o fato — ele silencia o lembrete. Autoria fica gravada; a justificativa pertence ao `resolve_alert`, que a exige |
| `whatsapp_instance_cycles`/`_alerts` sem `audit_trigger_func` (`rls` + `identity`) | **Aceito.** As duas são elas próprias registro histórico, e nenhuma escrita destrutiva existe: `resolve_alert` filtra `status in (OPEN, ACKNOWLEDGED)` e `acknowledge_alert` filtra `status = OPEN` — `resolution_note` e `acknowledged_by` não são sobrescritos, e nada apaga alerta. Reavaliar se surgir escrita destrutiva |
| `validateProviderInstanceRef` não distingue identificador de token puro (`secret-hunter`, informativo) | **Aceito.** O vetor real é a URL da Z-API, que carrega o token na outra metade e é barrada. Um token isolado não é o formato em que ele aparece |
| 092 sem `begin;`/`commit;` (`migration-validator`, P3) | **Sem ação — o achado é improcedente.** Verifiquei: **nenhuma** migration de wrapper de cron do projeto usa `begin/commit` (029, 043, 064, 082, 083). A 092 segue o precedente, não o quebra |

---

## Follow-ups fora do escopo da 6b

| Item | Onde |
|---|---|
| `manage-whatsapp-implementations` tem o mesmo `error` descartado no lookup de `platform_admins` | Pré-existente, EF de outra fase |
| CHECK de domínio para `cost_source` no banco (hoje só a EF valida) | Migration futura; a EF é o guard efetivo porque só ela escreve |

---

## Estado ao fim da rodada 1 — `b255407`

```
npm test ........................ 611/611
npm run typecheck ............... 0 erros
npm run lint .................... 0 erros, 22 warnings (baseline inalterada)
```

```
migration-validator .................. PASS (2 P3: 1 corrigido, 1 improcedente)
rls-auditor .......................... PASS (1 médio corrigido)
tenant-isolation-auditor ............. PASS (1 P3 corrigido)
identity-access-auditor .............. PASS (2 baixos corrigidos, 2 aceitos)
secret-hunter (estático) ............. PASS
integration-reliability-auditor ...... FAIL → 5 achados corrigidos
```

---

# RODADA 2 — `b255407`

Reexecutados os cinco gates cujo domínio o `b255407` tocou.

`integration-reliability-auditor` passou a **PASS**: os três ALTO confirmados
resolvidos. Mas `identity-access-auditor` **REPROVOU**, e o achado foi meu:

## IAA-6B-05 — `ReferenceError` no caminho de autorização

Ao acrescentar o log de `platform_admin_lookup_failed` em `isPlatformAdmin`, usei
`reqId` — que é `const` **dentro do callback do `serve`**, enquanto
`isPlatformAdmin` é função de **módulo**.

| Consequência | Havia? |
|---|---|
| `AUTHORIZATION_BYPASS` | **NÃO** — o `throw` sobe para o `catch` externo, que devolve 500. Fail-closed sobreviveu |
| `ADMINISTRATIVE_PATH_OUTAGE` | **SIM** — toda a EF cai em 500 sempre que o lookup de `platform_admins` falhar |
| `OBSERVABILITY_LOSS` | **SIM** — o log nunca sai, e o `catch` externo descarta o `error.message` |

O diagnóstico ficou **pior** que o silêncio original: antes era um 403 mudo,
depois um 500 genérico sem causa registrada.

**Correção (`0ca1304`):** `reqId` por parâmetro — convenção já usada em quatro
outras EFs do projeto. **Explicitamente NÃO promovido a `let` de módulo**: isso
seria reintroduzir o defeito do `adminRecipient` da rodada 1.

## Guardrail que nasceu daqui — e as três tentativas

Nenhuma ferramenta do projeto pegaria essa classe de defeito: `tsc -b` não
alcança `supabase/functions/` e não há Deno instalado. O identificador fora de
escopo compilava, passava no lint, passava nos 611 testes e só explodia em
runtime, num ramo que só executa quando o banco falha.

| Tentativa | O que aconteceu |
|---|---|
| 1 | Removi o ignore global e ampliei o bloco genérico sobre `supabase/functions` → importei 88 warnings alheios + 1 erro `prefer-const` pré-existente |
| 2 | Bloco isolado **sem parser TS** → o espree produziu "93 erros" que eram **falhas de parse disfarçadas de achado** |
| 3 | Bloco com `tseslint.parser`, só `no-undef` → Edge Functions limpas, baseline do app intacta em 22 warnings |

**Controle positivo executado:** injetei um identificador indefinido numa EF, o
lint reprovou nomeando-o; removi, voltou limpo.

**Limitação registrada, não escondida:** `no-undef` não entende TIPOS de
TypeScript e acusa identificador que só existe como tipo (por isso
`RequestInit: "readonly"` na lista de globais). Se essa lista começar a crescer
toda semana, a regra virou tributo — a saída é um typecheck de verdade sobre
`supabase/functions`, **nunca desligar `no-undef` em silêncio**.

---

# RODADA 3 — `0ca1304`

Cinco gates reexecutados. **Zero P0, zero P1.** Nenhum bloqueante.

```
migration-validator .................. PASS_WITH_WARNINGS
rls-auditor .......................... PASS_WITH_WARNINGS
tenant-isolation-auditor ............. PASS_WITH_WARNINGS
identity-access-auditor .............. PASS
integration-reliability-auditor ...... PASS_WITH_WARNINGS
```

Mas **onze achados abertos** (3 P2 + 8 P3, dois deles pré-existentes da EF). O
inventário fechado, com comportamento atual, risco, correção, teste e critério
de aceite por achado, está em
[FASE-6B-LOTE-ESTABILIZACAO.md](FASE-6B-LOTE-ESTABILIZACAO.md) §2.

## FINDING-004 — o achado mais importante das três rodadas

A FK `instance_id … on delete set null` convivia com um CHECK que exigia
`instance_id is not null` no ramo INSTANCE. Apagar uma instância com alerta
INSTANCE fazia a FK gravar NULL, o CHECK avaliar `FALSE` e **o DELETE inteiro
abortar** com `check_violation` — o oposto exato do contrato documentado no
próprio arquivo: *"o ledger é registro de auditoria e não pode ser apagado em
cascata"*. A promessa era "sobrevive nulando"; o schema entregava "impede o
delete".

### Correção de atribuição histórica

O relatório afirmou que o achado era *"regressão introduzida pela correção do
FINDING-002"*, alegando que antes o ramo INSTANCE era só `subject_id =
instance_id`.

**Verificado no histórico:** `git show daf5bba` mostra `instance_id is not null`
**já presente** no ramo INSTANCE na versão original do arquivo, e
`git diff b255407..0ca1304` mostra que a correção do FINDING-002 tocou
**apenas** o ramo ORGANIZATION.

| | |
|---|---|
| Raciocínio técnico do auditor | **CORRETO** — a lógica ternária do CHECK e a coerção da FK estavam bem analisadas |
| Atribuição histórica | **ERRADA** |
| Classificação correta | `LATENT_SCHEMA_DEFECT_DISCOVERED_DURING_REAUDIT` |

Registrar isso importa: tratar um defeito latente como regressão da rodada
anterior distorce a leitura de todo o processo — sugere que corrigir piora,
quando o que houve foi aprofundamento da leitura.

### `FINDING-004` — registro final

```
STATICALLY_RESOLVED
DATABASE_EXECUTION_PENDING
LATENT_SCHEMA_DEFECT_DISCOVERED_DURING_REAUDIT
```

- **Não** foi regressão de `0ca1304`; existia desde `daf5bba`.
- A interação entre `ON DELETE SET NULL` e o CHECK era contraditória.
- Os **quatro** caminhos de escrita foram revisados; nenhum reabre o buraco.
- O ledger preserva a **identidade histórica** (`subject_id` imutável).
- A correção **não** introduz `cascade`, e **não** troca para `restrict` — as
  duas contrariariam o contrato da tabela por caminhos opostos.
- A validação real da FK e do CHECK no PostgreSQL **continua bloqueada** pela
  ausência de ambiente de integração (casos FK-A a FK-G,
  [supabase/tests/whatsapp-instances.integration.md](../../supabase/tests/whatsapp-instances.integration.md)).

---

# RODADA FINAL — `19f8e53`

Lote único de estabilização. Fechou os onze achados, mais o **F-12** descoberto
durante a implementação (a criação do alerta não consumia o slot mensal, então o
lembrete "mensal" disparava no dia seguinte ao nascimento).

## A medida estrutural — extração do núcleo do worker

| Núcleo `whatsapp-instance-worker-core.ts` | Adapter `index.ts` |
|---|---|
| decisão de criar/lembrar/suprimir | cliente Supabase, queries, updates, RPCs |
| política de avanço do lembrete e do payload | resolução real do destinatário |
| decisão de enfileirar | relógio real, `serve`, resposta HTTP |
| contadores e classificação por sub-passo | leitura da credencial legada (só o identificador) |
| fluxo dos cinco passos e isolamento entre eles | emissão de telemetria |

`clock`, `repo`, `notifier`, `recipients` e `telemetry` são injetados. O núcleo
não importa Supabase, Deno, `fetch`, variável de ambiente nem cliente de
provedor.

### A extração atingiu o objetivo estrutural

- **W1–W4 deixaram de depender de leitura manual** — eram `NOT_EXECUTED`.
- **44 testes reais** cobrem o núcleo extraído.
- O "banco" da bancada é **mutável**, o que permite provar reexecução e mudança
  de estado. Com `find()` estático, o teste de reexecução provava nada.
- As asserções verificam **efeitos**, não só retorno ou presença de chamada.
- Os testes de enqueue distinguem **criação, lembrete, reexecução e falha
  parcial**.

Controle positivo executado duas vezes: desativando a checagem de zero linhas do
F-02, o bloco L reprova nomeadamente; revertendo a ordem em três tempos do
IR-001, 8 testes reprovam. Nos dois casos o estado foi restaurado e a suíte
voltou verde.

**O que estes testes NÃO provam:** atomicidade no PostgreSQL. Ver a separação de
cobertura no consolidado.

## Fronteira preservada

Comportamento aprovado das seções A–D, nomes canônicos, schemas, `event_type`,
chaves de dedupe, sequência dos cinco passos, ausência de chamada externa,
ausência de escrita em `billing_status` e em entitlement — tudo intacto. A única
mudança de regra é o F-12, declarada no documento do lote **antes** de ter sido
feita.

## Veredito dos gates da rodada final

```
migration-validator .................. PASS_WITH_WARNINGS
rls-auditor .......................... PASS_WITH_WARNINGS
tenant-isolation-auditor ............. PASS_WITH_WARNINGS
identity-access-auditor .............. PASS_WITH_WARNINGS
integration-reliability-auditor ...... PASS_WITH_WARNINGS
secret-hunter (estático) ............. PASS  (zero achados em qualquer severidade)

ZERO P0 · ZERO P1
```

### Achados anteriores — todos fechados

| Gate | Achado da rodada 3 | Status |
|---|---|---|
| migration-validator | P2 rollback sem 090/092 | **RESOLVIDO**, verificado contra `pg_depend` real |
| rls-auditor | `FINDING-002` ramo ORGANIZATION | **RECONFIRMADO RESOLVED** |
| rls-auditor | `FINDING-004` FK × CHECK | **RESOLVIDO** — quatro caminhos de escrita traçados, nenhum reabre |
| rls-auditor | `FINDING-005` rollback destrutivo | **RESOLVIDO** (residual virou `FINDING-006`, corrigido) |
| tenant-isolation | P2 UPDATE mudo | **RESOLVIDO**, padrão replicado em `stampReminder` |
| tenant-isolation | P3 predicado de status | **RESOLVIDO** |
| integration-reliability | REG-01, REG-03, REG-04 | **CONFIRMADO RESOLVED** |
| integration-reliability | REG-02 (com ressalva na rodada 3) | **RESOLVED — a ressalva foi fechada pelo F-12** |
| identity-access | R1 estado de módulo · R2 `ReferenceError` | **RESOLVIDO**, com sonda de ESLint executada pelo próprio gate |

### Oito achados novos — nenhum bloqueante

Um P2 e sete P3. Sete corrigidos, um aceito com justificativa, um rejeitado com
evidência. Tabela completa e o raciocínio de cada decisão em
[FASE-6B-LOTE-ESTABILIZACAO.md](FASE-6B-LOTE-ESTABILIZACAO.md) §6-bis.

O P2 (`IR-001`) é a consequência espelhada do próprio F-08: enfileirar antes de
gravar troca "aviso perdido" por "aviso duplicado". Corrigido com escrita em três
tempos, e **o primeiro UPDATE é barreira de persistência, não registro de
envio** — quem ler o código depois precisa dessa distinção para não "simplificar"
o passo 1 achando que ele duplica o passo 3. **Controle positivo executado:** com
a ordem antiga, 8 testes reprovam.

**Risco residual explícito e bloqueante para ativação de e-mail:** se o passo 3
falhar depois do passo 2, o ledger não reflete o enfileiramento e a execução
seguinte pode duplicar — repetindo enquanto o ledger não registrar o enqueue
anterior. Como `billing_notifications` não tem dedupe efetiva para `invoice_id`
nulo, eliminar isso estruturalmente exige operação atômica sobre ledger, fila,
estado de enqueue e deduplicação. Requisito formal:
**`ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`**
([FASE-6B-FOLLOWUPS.md](FASE-6B-FOLLOWUPS.md)).

**`ACCEPTED_P3_WITH_FOLLOW_UP`** — `IAA-03`
(`resolvePlatformAdminRecipients` confunde falha de leitura com lista vazia):
impacto é adiar a tentativa com log barulhento, a 6b não está deployada, e a
correção arrastaria redeploy coordenado dos dez consumidores de billing.
Follow-up próprio registrado. **Código novo não deve esconder falha como lista
vazia** — isso não autoriza reabrir a 6b para o existente.

**`DISMISSED_WITH_EVIDENCE`** — `MV-002` (`begin;`/`commit;` na 092): das **oito**
migrations equivalentes de wrapper de cron do projeto (029, 043, 045, storage
orphan, stripe expire, billing crons, 064, 069), **nenhuma** usa bloco
explícito. A 092 segue o precedente real; envolvê-la é que seria a exceção. O
mesmo item já havia sido analisado e rejeitado na rodada 1, e não há evidência
de regressão específica. **Não reabrir sem evidência nova.**

## Guardrails locais

```
npm test ........................ 668/668  (era 611; +44 núcleo do worker, +13 custo)
npm run typecheck ............... 0 erros
eslint supabase/functions ....... 0 erros com --max-warnings=0  (agora NO CI)
npm run lint .................... 0 erros, 22 warnings (baseline inalterada)
migration-static-guard .......... 6/6  (+1: header de auth com valor literal, do incidente)
function-acl-allowlist .......... 8/8
acoplamento event_type ↔ template  6/6  (+1: a decisão de enfileirar fica no núcleo)
varredura de secret no diff ..... limpa (único casamento foi falso positivo: `re_` casando `RE_T` em `WORKER_CORE_TESTS`)
```

## `GIT_HISTORY_SECRET_SCAN: EXECUTED — 1 INCIDENTE, CONTIDO`

Executada em 2026-08-02 com `gitleaks` 8.30.1, instalado via `scoop` — sem
Docker, sem privilégio administrativo, sem reinício. **A ausência de Docker
nunca interferiu nesta tarefa**, como já estava registrado.

```
commits varridos ................ 361
achados brutos .................. 5
  falsos positivos .............. 4
  secret real ................... 1  → INCIDENTE
```

**Achado real:** `INTERNAL_API_KEY` em texto claro dentro de
`supabase/migrations/022_reservation_source.sql` (renomeada depois para
`20260506181440_022_reservation_source.sql`), introduzida em `b5098c6`
(2026-05-06) e **presente em `HEAD`** até o saneamento. Janela de ~88 dias.

**Estado:** `CONTIDO`. Chave rotacionada nos dois lugares (segredo das Edge
Functions e Vault `internal_api_key`), trigger removido do arquivo, guardrail
estático estendido para pegar a forma que faltava.

O registro completo — tipo, local, commits, contenção, verificação e risco
residual, **sem o valor** — está em
[INCIDENTE-2026-08-02-INTERNAL-API-KEY.md](../INCIDENTE-2026-08-02-INTERNAL-API-KEY.md).

### O protocolo foi seguido, com uma falha registrada

Cumpridos: registrar só tipo/arquivo/commit e veredito sanitizado; tratar secret
real como incidente; **rotacionar antes** de remover do histórico.

**Não cumprido:** "não exibir secrets". Durante a apuração, o comando usado para
inspecionar o trecho do commit histórico **não mascarava a saída**, e o valor foi
impresso antes de a natureza real do achado ser conhecida. Está registrado na
§4 do documento do incidente, junto da regra que fica: **inspeção de achado usa
saída mascarada — "real ou falso positivo" se decide pela forma e pelo contexto,
não por ler o valor.**

### Por que o CI não pegou

`scripts/migration-static-guard.test.ts` cobria `sk-`, `sk-ant-`, `xai-`, `re_`,
JWT e URL com credencial. **Nenhuma dessas formas casa com um hex de 64 sem
prefixo.** Corrigido no mesmo lote: nova forma "header de auth com valor
literal", com controle positivo **e negativo** — o negativo existe porque um
regex mais amplo reprovaria os 15 wrappers de `pg_cron`, que montam o header por
concatenação a partir do Vault (padrão correto).

**Working tree limpo é evidência do estado atual, não do histórico** — foi
exatamente esse o caso aqui.

---

## Estado consolidado

**O GO abaixo vale EXCLUSIVAMENTE para o código e a documentação auditados em
`19f8e53` (lote de estabilização) e `e446ba3` (correções da passada final).**

```
SAAS_SHIELD_GATES_EXECUTED
  migration-validator ................ PASS_WITH_WARNINGS
  rls-auditor ........................ PASS_WITH_WARNINGS
  tenant-isolation-auditor ........... PASS_WITH_WARNINGS
  identity-access-auditor ............ PASS_WITH_WARNINGS
  integration-reliability-auditor .... PASS_WITH_WARNINGS
  secret-hunter ...................... PASS_STATIC_ONLY — zero achados estáticos

zero P0 · zero P1 · zero P2 aberto
11/11 achados das três primeiras rodadas .......... FECHADOS
 7/9 achados novos ................................ CORRIGIDOS
 1/9 ............................................. ACEITO com justificativa
 1/9 ............................................. REJEITADO com evidência
nenhum finding bloqueante restante

SAAS_SHIELD_OVERALL: GO
```

**`PASS_WITH_WARNINGS` não é `PASS`.** Cinco dos seis gates carregam ressalvas
registradas, e elas ficam — reduzi-las a "PASS" apagaria a decisão que foi
tomada sobre cada uma. Os *warnings* aceitos e rejeitados estão preservados
adiante e em [FASE-6B-LOTE-ESTABILIZACAO.md](FASE-6B-LOTE-ESTABILIZACAO.md) §6-bis.

### O que este GO não é

```
SAAS_SHIELD_OVERALL: GO
FASE_6B_ROLLOUT:     NO-GO
```

Não equivale a `FASE_6B: GO`, `ROLLOUT: GO`, `DEPLOY: GO`, `BACKFILL: GO`,
`CRON: GO` nem `MERGE: GO`. Os gates são estáticos e falam do código no
repositório — não de nada que tenha sido executado.

### Status operacional

```
SAAS_SHIELD_OVERALL ............. GO
LOCAL_TESTS ..................... GO — 668
TYPECHECK ....................... GO
EDGE_FUNCTION_LINT .............. GO
LOCAL_STATIC_GUARDRAILS ......... GO

MIGRATIONS ...................... WRITTEN / NOT APPLIED
EDGE FUNCTIONS .................. WRITTEN / NOT DEPLOYED
PANEL ........................... WRITTEN / NOT DEPLOYED
DATABASE INTEGRATION ............ ENVIRONMENT_BLOCKED
DOCKER .......................... NOT INSTALLED
LOCAL SUPABASE STACK ............ UNAVAILABLE
GIT_HISTORY_SECRET_SCAN ......... EXECUTED — 1 incidente, CONTIDO
ADMIN_ZAPI_TRANSACTIONAL_ENQUEUE  REQUIRED BEFORE DISPATCH ON

BILLING_NOTIFICATIONS_DISPATCH .. OFF
WHATSAPP_SERVICE_ENFORCEMENT .... OFF
BACKFILL REN SUSHI .............. NO-GO
CRON ............................ NO-GO
MERGE ........................... NO-GO
REMOTE COMMANDS ................. NO-GO
```

Demais bloqueios inalterados: `PSQL_NOT_INSTALLED` ·
`LINKED_TO_PRODUCTION_REMOTE` · `REPLAY_FAILS_42P13` · `UNSAFE_AS_IS`.

### Separação de cobertura — não confundir

```
WORKER_CORE_TESTS ............... EXECUTED
DATABASE_TRANSACTION_TESTS ...... ENVIRONMENT_BLOCKED
REAL_SUPABASE_CONSTRAINT_TESTS .. ENVIRONMENT_BLOCKED
```

Os 668 testes verdes **não** provam atomicidade no PostgreSQL, nem substituem a
execução real de migrations ou Edge Functions. `FINDING-004` é
`STATICALLY_RESOLVED` com `DATABASE_EXECUTION_PENDING`.

### A próxima autorização operacional

Só poderá ser avaliada depois de: ambiente capaz de validar banco · migrations
aplicadas em execução controlada · grants, RLS e RPC verificados · EFs
deployadas na ordem · backfill autorizado · execução manual do worker ·
inspeção do ledger · critérios do cron satisfeitos.

E o envio dos seis `admin_zapi_*` permanece bloqueado até existir enqueue
transacional — ver [FASE-6B-FOLLOWUPS.md](FASE-6B-FOLLOWUPS.md).
