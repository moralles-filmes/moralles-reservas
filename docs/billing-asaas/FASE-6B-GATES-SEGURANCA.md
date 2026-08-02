# FASE 6B — Os seis gates `saas-shield-br` — execução e resolução

> Executados em 2026-08-02 contra `469ade2` (estado da branch antes das correções).
> Correções aplicadas em seguida; guardrails reexecutados.
> Continuidade: [FASE-6B-RESUMO.md](FASE-6B-RESUMO.md) · Rollout: [FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md).

---

## Por que rodaram ANTES de Docker

Os seis auditores declaram `tools: Read, Glob, Grep` — **nenhum tem shell, nenhum
acessa banco**. São auditorias estáticas sobre arquivos do repositório.

O bloqueio anterior (`SAAS_SHIELD_GATES_NOT_EXECUTED`) estava classificado como se
dependesse do ambiente. **Não dependia.** Dependia só de autorização de despacho de
subagentes. Corrigido o sequenciamento: **os gates são o passo 1 do caminho
crítico**, antes de instalar Docker, `psql` ou qualquer preparo de stack.

---

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

## Estado após as correções

```
npm test ........................ 611/611 (era 610; +1 teste do D-1)
npm run typecheck ............... 0 erros
npm run lint .................... 0 erros, 22 warnings (baseline inalterada)
migration-static-guard .......... 5/5
function-acl-allowlist .......... 8/8
acoplamento event_type ↔ template  5/5
```

### Veredito dos gates

```
migration-validator .................. PASS (2 P3: 1 corrigido, 1 improcedente)
rls-auditor .......................... PASS (1 médio corrigido)
tenant-isolation-auditor ............. PASS (1 P3 corrigido)
identity-access-auditor .............. PASS (2 baixos corrigidos, 2 aceitos)
secret-hunter (estático) ............. PASS
integration-reliability-auditor ...... FAIL → 5 achados corrigidos, RE-AUDITORIA PENDENTE
```

⚠️ **`SAAS_SHIELD_GATES_NOT_EXECUTED` NÃO foi removido.** O
`integration-reliability-auditor` reprovou e as correções **não foram
reauditadas pelo mecanismo aprovado**. Guardrail local verde não é gate verde —
a reexecução daquele gate contra o estado corrigido é obrigatória antes de
declarar os seis fechados.

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

### Demais bloqueios, inalterados

`DOCKER_NOT_INSTALLED` · `PSQL_NOT_INSTALLED` · `LINKED_TO_PRODUCTION_REMOTE` ·
`REPLAY_FAILS_42P13` · `UNSAFE_AS_IS` · `DATABASE_INTEGRATION_ENVIRONMENT_BLOCKED` ·
`NO_GO_BEFORE_BACKFILL` · `CRON_NO_GO` · `MERGE_NO_GO`
