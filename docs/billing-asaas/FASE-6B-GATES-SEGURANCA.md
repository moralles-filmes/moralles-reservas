# FASE 6B — Os seis gates `saas-shield-br` — quatro rodadas

> Continuidade: [FASE-6B-RESUMO.md](FASE-6B-RESUMO.md) · Rollout:
> [FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md) · Lote final:
> [FASE-6B-LOTE-ESTABILIZACAO.md](FASE-6B-LOTE-ESTABILIZACAO.md).

| Rodada | Commit auditado | Resultado |
|---|---|---|
| 1 | `469ade2` | 5 PASS · `integration-reliability` **FAIL** (3 ALTO) → corrigido em `b255407` |
| 2 | `b255407` | `integration-reliability` PASS · `identity-access` **FAIL** (`ReferenceError` no caminho de autorização) → corrigido em `0ca1304` |
| 3 | `0ca1304` | 5 PASS/PASS_WITH_WARNINGS · zero P0/P1 · **11 achados abertos**, incluindo o defeito latente FK × CHECK |
| **Final** | `19f8e53` | lote único de estabilização — resultado na seção final |

## Como ler a sequência

**A curva 1 → 8 → 9 achados NÃO mede piora de qualidade.** Ela mede
**profundidade da superfície auditada**: a rodada 1 olhou o worker; a 2 olhou o
que a 1 havia corrigido; a 3 cruzou objetos de schema que nenhuma anterior havia
relacionado entre si.

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

**W1–W4, que eram `NOT_EXECUTED` e estavam sustentados por leitura, viraram 37
testes reais.** Controle positivo executado: desativei a checagem de zero linhas
do F-02 e o bloco L reprovou nomeadamente; restaurei e voltou verde.

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
tempos — toca (pedágio), enfileira, carimba — e **controle positivo executado**:
com a ordem antiga, 8 testes reprovam.

**Aceito explicitamente:** `IAA-03` (`resolvePlatformAdminRecipients` confunde
falha de leitura com lista vazia) — impacto é adiar 24h, barulhento em log, e a
correção arrastaria redeploy de billing inteiro. Follow-up registrado.

**Rejeitado com evidência:** `MV-002` (`begin;`/`commit;` na 092) — das oito
migrations de wrapper de cron do projeto, **zero** usam. A 092 segue o
precedente. Mesmo achado já julgado improcedente na rodada 1.

## Guardrails locais

```
npm test ........................ 668/668  (era 611; +44 núcleo do worker, +13 custo)
npm run typecheck ............... 0 erros
eslint supabase/functions ....... 0 erros com --max-warnings=0  (agora NO CI)
npm run lint .................... 0 erros, 22 warnings (baseline inalterada)
migration-static-guard .......... 5/5
function-acl-allowlist .......... 8/8
acoplamento event_type ↔ template  6/6  (+1: a decisão de enfileirar fica no núcleo)
varredura de secret no diff ..... limpa (único casamento foi falso positivo: `re_` casando `RE_T` em `WORKER_CORE_TESTS`)
```

⚠️ **`GIT_HISTORY_SECRET_SCAN`: NÃO EXECUTADO.** O `secret-hunter` não tem shell.
A varredura de histórico permanece pendente de execução humana:

```bash
gitleaks detect --source . --redact
trufflehog git file://. --only-verified
git log -p --all -S "SUPABASE_SERVICE_ROLE_KEY" | head -100
git log -p --all -S "ZAPI_CLIENT_TOKEN" | head -100
git log --all --full-history -- "**/.env*"
git fsck --unreachable --no-reflogs
```

**Working tree limpo é evidência do estado atual, não do histórico.**

---

## Estado consolidado

```
SAAS_SHIELD_GATES_EXECUTED
  migration-validator ................ PASS_WITH_WARNINGS
  rls-auditor ........................ PASS_WITH_WARNINGS
  tenant-isolation-auditor ........... PASS_WITH_WARNINGS
  identity-access-auditor ............ PASS_WITH_WARNINGS
  integration-reliability-auditor .... PASS_WITH_WARNINGS
  secret-hunter ...................... PASS_STATIC_ONLY

ZERO P0 · ZERO P1 · ZERO P2 ABERTO
P3: corrigidos, ou aceitos com justificativa e follow-up — nenhum ambíguo
SAAS_SHIELD_OVERALL: GO
```

O critério de convergência aprovado está satisfeito: zero P0, zero P1, zero P2
aberto, P3 decididos explicitamente, guardrails locais verdes, gates
reexecutados sobre o commit final, histórico das quatro rodadas documentado,
limitações de integração preservadas.

**`SAAS_SHIELD_OVERALL: GO` não é `FASE_6B: GO`.** Os gates são estáticos e
dizem respeito ao código no repositório. Tudo abaixo continua valendo.

### Demais bloqueios, inalterados

`DOCKER_NOT_INSTALLED` · `PSQL_NOT_INSTALLED` · `LINKED_TO_PRODUCTION_REMOTE` ·
`REPLAY_FAILS_42P13` · `UNSAFE_AS_IS` · `DATABASE_INTEGRATION_ENVIRONMENT_BLOCKED` ·
`NO_GO_BEFORE_BACKFILL` · `CRON_NO_GO` · `MERGE_NO_GO`
