# FASE 6B — Pacote de execução (máquina com Supabase CLI)

> Destino: uma máquina que tenha `supabase` CLI, Docker e `psql`.
> **Atualização de 2026-08-02:** a CLI **2.111.0** foi instalada na máquina de
> desenvolvimento; **Docker e `psql` continuam ausentes**, e o repositório está
> **vinculado a produção** — `db push` e `functions deploy` a atingem sem passo
> preparatório. Diagnóstico completo:
> [FASE-6B-DIAGNOSTICO-AMBIENTE.md](FASE-6B-DIAGNOSTICO-AMBIENTE.md).
> Continuidade e estado: [FASE-6B-RESUMO.md](FASE-6B-RESUMO.md).
> Spec: [../superpowers/specs/2026-08-01-billing-asaas-fase-6b-design.md](../superpowers/specs/2026-08-01-billing-asaas-fase-6b-design.md).
> Plano (Task 23 é o rollout operacional detalhado): [../superpowers/plans/2026-08-01-billing-asaas-fase-6b.md](../superpowers/plans/2026-08-01-billing-asaas-fase-6b.md).

---

# 🔴 BARREIRA CONTRA PRODUÇÃO — leia antes de digitar qualquer comando

> **Neste repositório, todo comando Supabase potencialmente remoto deve ser
> presumido como direcionado à PRODUÇÃO até prova explícita em contrário.**

`supabase/.temp/linked-project.json` vincula este diretório ao projeto de produção
desde 2026-08-02. O vínculo persistido **altera o destino padrão** de vários
subcomandos.

⛔ **Nunca inferir "é local" só porque a linha não tem `--linked` nem
`--project-ref`.** A ausência da bandeira não prova nada — o vínculo em disco
supre o argumento.

**O vínculo local NÃO é autorização.** Ele diz para onde o comando vai, não que
ele pode ir.

### Classificação obrigatória, antes de executar

| Categoria | O que é | Regra |
|---|---|---|
| **A** | Local, **sem** conexão remota | Pode executar **depois de verificar que realmente não usa o projeto vinculado** |
| **B** | Leitura remota autorizada | Exige **autorização específica para aquela leitura** |
| **C** | Escrita remota | Exige **autorização explícita para aquela alteração** + checklist de GO |
| **D** | **Ambíguo** | ⛔ **Não executar** até o destino ser comprovado |

**Como verificar antes de classificar** — pela ajuda da versão instalada, não pela
memória. Um comando deixa de ser categoria A se ele: exige stack local · consulta o
projeto vinculado · tenta inicializar serviços · usa cache remoto · modifica
arquivos · realiza autenticação · acessa a rede.

**Não apagar `supabase/.temp` como proteção.** O vínculo é recriado em um comando,
a CLI segue autenticada, e a segurança tem de viver **no procedimento e no comando
executado** — não na ausência de um arquivo temporário. Do mesmo modo: não mexer em
autenticação, credenciais ou temporários apenas para produzir sensação de
isolamento.

---

## ⛔ Estado de partida

**`NO-GO PARA APLICAÇÃO E DEPLOY`** até que os passos 1–4 deste documento sejam
cumpridos **nesta ordem**. Este pacote é a receita; ele **não é** a autorização.

**Ambiente em 2026-08-02: categoria B — apto apenas para validações estáticas.**
CLI 2.111.0 presente; **Docker e `psql` ausentes**, logo **não existe stack local**
e **todo comando remoto é NO-GO**.

**Duas proibições que valem do início ao fim:**

- ⛔ **Nenhum *backfill*** antes dos seis gates (passo 4) e da conferência do
  passo 9.
- ⛔ **Nenhum cron** antes do *backfill* conferido e de **duas execuções manuais
  idempotentes** (passo 12).

**Regra herdada do Risco 7: NO-GO não é corrigido "no dado" para manter o rollout
verde.** Se uma query de prova sair errada, para-se e investiga-se — não se ajusta
a linha por SQL.

---

## 1. Commits exatos

Branch `billing-asaas/fase-6b`, 16 commits sobre `main`. Nada fora desta lista
pertence ao pacote.

```
6550df2  docs(6b): spec — secoes A e B
10d4d40  docs(6b): spec — secao C
a71f91a  docs(6b): spec — secao D
133a0ac  docs(6b): fecha a Secao D
4fb8d37  docs(6b): plano em 23 tasks
2898889  feat(6b): nucleos do calendario e do gate de provisionamento
479de74  feat(6b): receita, alertas, divergencias e simulador
6e5dc45  test(6b): guardrail de migration no CI + correcao do veredito
daf5bba  feat(6b): seis migrations — ESCRITAS, NAO APLICADAS
7f6b59b  feat(6b): seis templates + teste do acoplamento por string
3899348  feat(6b): EF de inventario, worker e painel
a2ca27a  docs(6b): invariantes no CLAUDE.md
58ce517  fix(6b): vocabulario canonico dos seis event_type + o enfileiramento
```

**Mais três commits de hotfix que estão na mesma branch e também nunca foram
deployados** — eles entram no pacote porque `_shared/billing-category.ts` mudou:

```
d9dbaa5  fix(billing): fecha o Risco 7 — ausencia de evidencia nao vira "fatura de sistema"
1183d3b  fix(billing): retencao respeita o vocabulario de enforcement_hold_reason
d7198bc  docs(billing): Risco 7 fechado, ingestao religada, telemetria
```

Verificação na máquina de destino:

```bash
git fetch origin
git checkout billing-asaas/fase-6b
git log --oneline main..HEAD | wc -l        # esperado: 16
git status                                   # esperado: limpo
```

---

## 2. Validação estática — antes de tocar em qualquer ambiente

```bash
npm install --legacy-peer-deps
npm run typecheck        # tsc -b --noEmit — NUNCA sem -b
npm test                 # esperado: 610 passando, 27 arquivos
npm run lint             # 0 erros; warnings pré-existentes inalterados
```

**`npm run typecheck` sem `-b` é no-op silencioso** (o root tem `files:[]` +
references). Se der `exit 0` instantâneo, o comando está errado.

**Qualquer falha aqui = NO-GO.** Não prossiga "porque é só um teste".

---

## 3. Gate do Vault e do `project_url` — ANTES da migration 092

A 092 lê `project_url` do Vault em vez de embutir a URL. **Antes de aplicar
qualquer migration, responda as cinco perguntas abaixo com evidência.**

⛔ **NÃO execute `select vault.create_secret(...)` automaticamente.** Confirme
primeiro:

| # | Pergunta | Como verificar |
|---|---|---|
| 1 | O *secret* `project_url` **já existe**? | `select name from vault.decrypted_secrets where name = 'project_url';` |
| 2 | `create_secret` **duplicaria** entrada se já existir? | conferir o comportamento do helper na versão instalada **antes** de rodar |
| 3 | O padrão do projeto é `create_secret`, `update_secret` ou outro helper? | como `internal_api_key` foi semeado originalmente |
| 4 | O valor deve ser **URL base** ou **endpoint completo**? | a 092 concatena `\|\| '/functions/v1/process-whatsapp-instance-cycles'` → **URL base, sem barra final** |
| 5 | Há **nomes distintos por ambiente**? | se sim, a 092 precisa saber disso **antes** de ser aplicada |

Confira também o que já existe:

```sql
select name from vault.decrypted_secrets where name in ('internal_api_key', 'project_url');
```

**A 092 é fail-closed:** sem `project_url` ou sem `internal_api_key`, o *wrapper*
emite `notice` e **retorna sem fazer POST**. Aplicar a migration com o Vault
incompleto é inofensivo — o que **não** se faz é semear às cegas.

**A migration não embute *fallback* para a URL de produção.** Isso é deliberado:
um *fallback* transformaria "Vault vazio" em "chama produção".

---

## 4. Os seis gates `saas-shield-br`

**Status atual: `SAAS_SHIELD_GATES_NOT_EXECUTED`.** Esta sessão não autorizou
despacho de subagentes — isso é **bloqueio de execução, não dispensa**. Os gates
são obrigatórios pelo CLAUDE.md porque a fase toca banco, RLS, Edge Function e
multi-tenant.

### Os seis gates NÃO dependem do ambiente

Verificado no *frontmatter* dos seis agentes: **todos declaram
`tools: Read, Glob, Grep`** — nenhum tem *shell*, nenhum acessa banco. São
auditorias **puramente estáticas** sobre os arquivos do repositório.

**Consequência para a ordem de trabalho:** a ausência de Docker **não** explica a
não execução dos gates, e esperar por Docker para rodá-los seria erro de
sequenciamento. O único bloqueio deles é **autorização de despacho de subagentes**,
e eles podem rodar **antes** de qualquer instalação — inclusive agora, numa sessão
que autorize.

*(Nota do `secret-hunter`: ele não tem *shell*, então a varredura de histórico git
— `gitleaks`/`trufflehog`/`git log` — e o *build* de *bundle* fresco são **emitidos
como próxima ação**, não executados. Rodar esses comandos é trabalho humano
separado.)*

⛔ **Não substitua os gates por autoavaliação informal.** "Eu li o código e parece
certo" não é um gate.

⛔ **Guardrail estático local ≠ gate `saas-shield-br`.** O `acl-estatico` do CI, o
`migration-static-guard`, o teste de acoplamento por string e os 610 testes são
**guardrails estáticos locais** e estão verdes — registrá-los é correto, chamá-los
de gate não é. Nenhum dos seis pode ser marcado como executado sem que o mecanismo
aprovado tenha rodado.

| Gate | Escopo mínimo nesta fase |
|---|---|
| `rls-auditor` | migrations 087, 088, 089, 090 — FORCE RLS sem policy de tenant, policy `platform_admin` presente, ACL das funções novas |
| `tenant-isolation-auditor` | *trigger* `whatsapp_instance_tenant_guard()`, que resolve a org por `whatsapp_channels → units` (não há `organization_id` no canal); ledger com `subject_type`/`subject_id` |
| `identity-access-auditor` | `manage-whatsapp-instances` valida `platform_admin`; `process-whatsapp-instance-cycles` valida `x-internal-key`; `verify_jwt` no `config.toml` |
| `migration-validator` | idempotência e reversibilidade de 087–092; a 091 remove flags e precisa da restauração pronta |
| `secret-hunter` | **nenhuma credencial em `whatsapp_instances`**; `provider_instance_ref` é identificador, nunca URL com token; telemetria sem `credentials` |
| `integration-reliability-auditor` | *lock* de execução do worker, idempotência da rolagem, dedupe do ledger, ausência de chamada ao provedor |

**Critério:** nenhuma falha **alta ou crítica**. Falha média entra em registro e
decisão explícita. **Qualquer alta ou crítica = NO-GO**, e a correção volta ao
código — não ao dado.

---

## 5. Ordem de aplicação — 21 passos

Os passos 1–4 acima são pré-requisito. A partir daqui, **nenhum passo avança com
o anterior pendente**.

| # | Passo | Tipo |
|---|---|---|
| 1 | `npm run typecheck` + `npm test` + `npm run lint` verdes | validação |
| 2 | Gate do Vault/`project_url` (§3) respondido com evidência | gate |
| 3 | Os seis gates `saas-shield-br` sem alta/crítica | **GATE 1** |
| 4 | `supabase db push` — migrations 087 → 092 | banco |
| 5 | Queries de prova de schema (§7) | evidência |
| 6 | Deploy `process-billing-notifications` — **templates ANTES do produtor** | deploy |
| 7 | Deploy dos 6 EFs do hotfix Risco 7 (`billing-category.ts`) | deploy |
| 8 | Deploy `manage-whatsapp-instances` | deploy |
| 9 | Deploy `process-whatsapp-instance-cycles` | deploy |
| 10 | Push da branch → Vercel constrói o painel | deploy |
| 11 | Prova de ACL: `authenticated` e `anon` não leem as três tabelas | evidência |
| 12 | Prova de que **não há cron** ainda | evidência |
| 13 | **GATE 2 — antes do *backfill*** (§8) | **GATE** |
| 14 | *Backfill* do Ren Sushi **pelo painel**, `intent: BACKFILL_EXISTING` | operação |
| 15 | Conferência do estado resultante (§9) | evidência |
| 16 | `confirm_cycle_date` **se e somente se** a data real for conhecida | operação |
| 17 | Execução manual do worker — **duas vezes** | operação |
| 18 | Inspeção do ledger, dos ciclos e do que **não** mudou (§10) | evidência |
| 19 | **GATE 3 — antes do cron** (§11) | **GATE** |
| 20 | Criar, commitar e aplicar a migration 093 (cron) | banco |
| 21 | Observação por 3 dias: uma execução por dia, sem duplicação | observação |

**A migration 093 não existe no repositório de propósito.** `db push` aplica tudo
que está pendente — se o `cron.schedule` estivesse escrito hoje, o cron nasceria
no passo 4. A função `trigger_whatsapp_instance_cycles()` existir sem estar
agendada é inofensiva: ninguém a chama.

---

## 6. Deploy — ordem e escopo

**Nove Edge Functions.** Edge Functions **não compartilham bundle em runtime** —
alterar `_shared/` exige redeploy de todas as que importam.

```bash
# 6.1 — templates ANTES do produtor (senão a linha morre em failed/unknown_event_type)
supabase functions deploy process-billing-notifications

# 6.2 — hotfix do Risco 7: _shared/billing-category.ts + billing-category-core.ts
supabase functions deploy manage-billing
supabase functions deploy process-billing-overdue
supabase functions deploy process-billing-reconcile
supabase functions deploy process-billing-reminders
supabase functions deploy process-billing-unblock
supabase functions deploy process-trial-expiry

# 6.3 — as duas novas da 6b
supabase functions deploy manage-whatsapp-instances
supabase functions deploy process-whatsapp-instance-cycles
```

**Por que 6.1 vem primeiro:** `process-whatsapp-instance-cycles` enfileira seis
`event_type` que só `process-billing-notifications` sabe renderizar. As duas EFs
**não compartilham nenhum arquivo `_shared/`** para esse acoplamento — é só a
string. Deployar o produtor antes do dispatcher mata o aviso em
`failed/unknown_event_type`. É a **quinta ocorrência** do padrão no projeto, e a
primeira com teste nas duas direções.

**Por que 6.2 não pode ficar de fora:** os seis EFs estão com
`parseExternalReference`/`isSystemInvoice` **antigos em memória**. Deployar só a
6b deixaria o Risco 7 vivo — uma fatura de R$149 da instância lida como fatura de
sistema, bloqueando a organização inteira.

**`config.toml` já tem as duas entradas novas** (`manage-whatsapp-instances`
`verify_jwt=true`, `process-whatsapp-instance-cycles` `verify_jwt=false`). Sem a
segunda, o gateway responde 401 antes do `requireInternalAuth` e o cron silencia
— `pg_net` é fire-and-forget.

---

## 7. Queries de prova — depois do passo 4 (schema)

```sql
-- 7.1 — as três tabelas existem com RLS ligada E forçada (esperado: 3 linhas, t/t)
select relname, relrowsecurity, relforcerowsecurity
  from pg_class
 where relname in ('whatsapp_instances', 'whatsapp_instance_cycles', 'whatsapp_instance_alerts');

-- 7.2 — cada uma tem policy de platform_admin e NENHUMA policy de tenant
select tablename, policyname
  from pg_policies
 where tablename like 'whatsapp_instance%'
 order by tablename;

-- 7.3 — os índices únicos que sustentam os invariantes (esperado: 5)
select indexname from pg_indexes
 where indexname in (
   'whatsapp_instances_provider_ref_idx',
   'whatsapp_instances_channel_idx',
   'whatsapp_cycles_instance_start_idx',
   'whatsapp_cycles_one_open_idx',
   'whatsapp_alerts_dedupe_idx'
 );

-- 7.4 — a RPC de rolagem existe e está FECHADA (esperado: só service_role)
select p.proname,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('roll_whatsapp_instance_cycle',
                     'try_whatsapp_instance_cycles_lock',
                     'release_whatsapp_instance_cycles_lock',
                     'trigger_whatsapp_instance_cycles');
-- Esperado: anon=f, authenticated=f, service_role=t em TODAS.

-- 7.5 — as três flags zapi_auto_* sumiram (esperado: 0 linhas)
select key from platform_flags where key like 'zapi_auto%';

-- 7.6 — nenhuma coluna de credencial entrou nas tabelas novas (esperado: 0 linhas)
select table_name, column_name
  from information_schema.columns
 where table_name like 'whatsapp_instance%'
   and column_name ~* 'token|secret|password|senha|api_key|credential';

-- 7.7 — nenhuma linha ainda (esperado: 0, 0, 0)
select (select count(*) from whatsapp_instances)       as instancias,
       (select count(*) from whatsapp_instance_cycles) as ciclos,
       (select count(*) from whatsapp_instance_alerts) as alertas;
```

Prova de ACL do passo 11, **com a chave anon e com um JWT de `authenticated`**
(não pelo SQL Editor, que roda como superusuário e bypassa RLS):

```
GET /rest/v1/whatsapp_instances        → 0 linhas ou erro de permissão, NUNCA dados
GET /rest/v1/whatsapp_instance_cycles  → idem
GET /rest/v1/whatsapp_instance_alerts  → idem
```

Prova do passo 12:

```sql
select jobname from cron.job where jobname = 'whatsapp-instance-cycles';
-- Esperado: 0 linhas.
```

---

## 8. GATE 2 — antes do *backfill*

Confirme **todos**, e registre cada resposta:

- [ ] nenhuma falha **alta ou crítica** nos seis auditores;
- [ ] queries §7.1–§7.7 com os valores esperados;
- [ ] **`authenticated` e `anon` não leem as três tabelas** — prova do passo 11;
- [ ] **worker ainda sem cron** — prova do passo 12;
- [ ] as nove EFs deployadas e respondendo;
- [ ] nenhuma chamada externa nova (`secret-hunter`, itens 8–9).

**Qualquer item pendente = NO-GO.**

---

## 9. *Backfill* do Ren Sushi

⛔ **Pelo painel, nunca por SQL.** A action grava autoria, motivo e auditoria;
`INSERT` direto não grava nada disso. **Não cadastrar manualmente no banco para
adiantar a fase.**

```
action: register_instance
intent: BACKFILL_EXISTING
organization_id:            <Ren Sushi>
unit_id:                    <unidade do Ren Sushi>
channel_id:                 <canal existente do Ren Sushi>
provider:                   zapi
provider_instance_ref:      <identificador lido no painel da Z-API>
current_monthly_cost_cents: <custo real se conhecido; senão NULO — nunca zero>
reason:                     "Backfill da instância existente — Fase 6b"
```

Estado resultante, a conferir:

| Campo | Valor esperado |
|---|---|
| `lifecycle_state` | `ACTIVE` |
| `cycle_source` | `UNKNOWN` — a data ainda não foi confirmada |
| `current_cycle_due_on` | **ausente** — data ausente não vira vencimento inventado |
| alerta aberto | `DATE_REVIEW_REQUIRED` — pendência de painel |
| custo | real se conhecido; `NULL` (**nunca zero**) se não |
| receita no próximo ciclo | `LIFETIME_OVERRIDE`, valor `0` |
| margem | **negativa e visível** — é o produto da fase, não uma anomalia |

O que **não** pode ter acontecido: nenhuma criação no provedor · nenhuma alteração
no canal existente · nenhuma mudança de entitlement · nenhuma mudança em
`organizations.billing_status`.

```sql
select id, organization_id, unit_id, channel_id, lifecycle_state, cycle_source,
       current_cycle_due_on, current_monthly_cost_cents, provider_instance_ref
  from whatsapp_instances;
-- Esperado: 1 linha, cycle_source='UNKNOWN', current_cycle_due_on NULL.
```

No painel, o Ren Sushi aparece com **"data não confirmada"** — nunca com uma data
derivada.

**Passo 16 — `confirm_cycle_date` só se a data real for conhecida.** Se não for,
**PARE e siga com `UNKNOWN`**. Inventar a data para "destravar o rollout" é
exatamente o que a §6.2 da spec proíbe.

---

## 10. Execução manual — duas vezes

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/process-whatsapp-instance-cycles" \
  -H "x-internal-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" -d '{}'
```

**A segunda execução é a prova de idempotência:** nenhum ciclo novo, nenhum alerta
duplicado, `occurrences` inalterado — o lembrete é mensal, não por passada.

```sql
-- 10.1 — ciclos
select instance_id, cycle_start, provider_due_on, status, provider_cost_cents,
       customer_revenue_cents, revenue_source, gross_margin_cents
  from whatsapp_instance_cycles order by cycle_start;

-- 10.2 — ledger
select alert_type, subject_type, dedupe_key, status, occurrences,
       first_detected_at, last_seen_at, dispatch_enabled_at_enqueue
  from whatsapp_instance_alerts order by first_detected_at;

-- 10.3 — a fila recebeu, e recebeu UMA vez por fato
select event_type, status, count(*)
  from billing_notifications
 where event_type like 'admin_zapi_%'
 group by 1, 2;
-- Esperado: nenhuma contagem cresce entre a 1ª e a 2ª execução.

-- 10.4 — NADA mudou fora do escopo
select id, billing_status from organizations where id = '<Ren Sushi>';
select id, status from billing_subscriptions where organization_id = '<Ren Sushi>';
select id, status from whatsapp_channels where id = '<canal do Ren Sushi>';
```

**Telemetria:** confira os logs das duas execuções e confirme que **nenhum**
contém `credentials`, token, *client token* ou URL com segredo.

**A divergência `CHANNEL_WITHOUT_INSTANCE`** eventualmente aberta antes do
*backfill* deve aparecer **RESOLVIDA** aqui — o canal agora tem instância.

---

## 11. GATE 3 — antes do cron

- [ ] *backfill* conferido (§9);
- [ ] execução manual **idempotente** — duas execuções, mesmo resultado (§10);
- [ ] **nenhuma duplicação** de ciclo, de alerta ou de linha em `billing_notifications`;
- [ ] **nenhuma alteração** de `organizations.billing_status`;
- [ ] **nenhuma alteração** de entitlement;
- [ ] **nenhuma chamada** ao provedor;
- [ ] telemetria **sanitizada**;
- [ ] *rollback* por desagendamento entendido (§12).

**Qualquer item pendente = NO-GO.**

Só então a migration 093, agendando `10 12 * * *` UTC (09:10 BRT).

---

## 12. Rollback

**O freio de primeira linha é desagendar o cron — efeito imediato, sem deploy:**

```sql
select cron.unschedule('whatsapp-instance-cycles');
```

Além dele:

- desabilitar ações sensíveis do painel por deploy, se o defeito estiver nelas;
- **preservar todas as linhas para auditoria**;
- ⛔ **não apagar ciclos ou alertas para "voltar ao verde"**;
- ⛔ **não alterar `lifecycle_state` diretamente por SQL**;
- não desfazer migrations destrutivamente em produção sem análise;
- tabelas aditivas ficam instaladas mesmo se a interface for retirada.

**Reversão das três flags `zapi_auto_*`:** a migration de restauração está pronta
em [restore-zapi-auto-flags.sql](restore-zapi-auto-flags.sql) (usa `'false'::jsonb`
— a coluna `platform_flags.value` é `jsonb`). Antes de remover, reconfirmar que
não há consumidor: `grep` encontra os nomes apenas na migration 061 e em
documentação.

**Rollback das migrations**, se necessário — na ordem inversa, e cada arquivo
carrega a sua seção no rodapé:

```sql
drop table if exists whatsapp_instance_alerts;
drop table if exists whatsapp_instance_cycles;
drop table if exists whatsapp_instances;
```

---

## 13. O que NÃO entra neste pacote

- ⛔ **Ligar flag.** `whatsapp_service_enforcement`, `whatsapp_implementation_flow`,
  `whatsapp_subscription_checkout` e `billing_notifications_dispatch` **seguem
  OFF**. Ligar é decisão do dono.
- ⛔ **Asaas em produção.** Segue em **sandbox** até a última fase.
- ⛔ **Consertar o replay histórico** ou parametrizar as treze migrations legadas.
  Isso é a frente `BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT`, **nesta ordem**:
  1º tornar o histórico reproduzível sem `42P13`; 2º tornar o ambiente
  reconstruído seguro. **Não tente resolver o baseline dentro da 6b.**
- ⛔ **Rodar os testes de integração** (15 casos) — permanecem `ENVIRONMENT_BLOCKED`
  até aquela frente entregar um banco descartável. **Produção não vira ambiente de
  teste**, e o CI não recebe credencial capaz de criar e remover dados.
- ⛔ **Criar instância nova na Z-API.** O gate
  `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A` está LIGADO e recusa;
  ambiguidade também recusa (fail-closed).
- ⛔ **Qualquer escrita no provedor.** A 6b nunca chama a Z-API.
- ⛔ **Qualquer comando que use o projeto vinculado**, inclusive só para "confirmar"
  o vínculo. Isso inclui `supabase db push`, `migration up` contra remoto,
  `functions deploy`, `secrets set`, `link` e **`db dump --linked`**.

### Sobre o ensaio por *dump* — não é o próximo comando

O caminho de 2026-07-30 (`db dump --linked` → `supabase start` → importação por
`psql`) **evita o replay**, mas **não está autorizado agora**. Ele contém uma
**leitura remota do projeto vinculado** e exige protocolo próprio:

autorização específica para aquela leitura · análise do que o *dump* contém ·
sanitização · local seguro de armazenamento · política de exclusão · Docker ·
`psql` · garantia de que nenhum dado pessoal ou segredo venha junto.

É **alternativa futura com protocolo próprio**, nunca um atalho a executar.

### Configuração local é mudança planejada, não verificação

O `supabase/config.toml` do repositório tem **43 blocos, todos `[functions.*]`** —
sem `project_id`, sem `[db]`, `[api]` ou `[auth]`. Ele **não representa uma
configuração completa de stack local**; existe para o deploy de Edge Functions.

Portanto: ⛔ não assumir que `supabase start` está configurado · ⛔ não alterar o
`config.toml` principal para experimentar · ⛔ não misturar configuração local de
teste com a operacional. Qualquer config local futuro é **isolado, descartável e
incapaz de alterar o comportamento do deploy de produção**.

### Diretório de teste isolado — quando Docker e `psql` existirem

⛔ **Não subir a stack de integração neste diretório vinculado.** Prepare um
*workspace* separado que **não** contenha `supabase/.temp` copiado, **não** herde
`project-ref`, token ou configuração de vínculo, e **não** contenha o `.env.local`
de produção. Ele tem config local próprio, rede e *jobs* controlados, não chama
Edge Functions remotas, e é descartável ao final.

⛔ **Não copiar segredos de produção para o ambiente subir.** Migration que dependa
deles usa **valor local não sensível** ou a dependência é **declarada como
bloqueio** — nunca resolvida com a credencial real.

---

## 14. Tabela de veredito

| Frente | Veredito |
|---|---|
| Núcleos puros e guardrails estáticos | **GO** — 125 testes por invariante |
| Migrations 087–092 | **ESCRITO MAS NÃO EXECUTADO CONTRA BANCO** |
| Edge Functions (9) | **NÃO DEPLOYADO** |
| Painel | **NÃO DEPLOYADO** |
| Integração com banco | **`ENVIRONMENT_BLOCKED`** — `42P13` + ambiente inseguro, dois bloqueios independentes |
| Reconstrução do schema | **`SCHEMA_DERIVED_FROM_MIGRATIONS / REPLAY_FAILS_42P13 / UNSAFE_AS_IS`** |
| Gates `saas-shield-br` | **`SAAS_SHIELD_GATES_NOT_EXECUTED`** |
| *Backfill* do Ren Sushi | **`NO_GO_BEFORE_BACKFILL`** |
| Cron | **NO-GO** |
| Merge em `main` + tag | **NO-GO** — depois dos gates e da observação de 3 dias |
| Validações estáticas | **GO** |
| Stack local | **INDISPONÍVEL** — Docker e `psql` ausentes |
| Comandos remotos | **NO-GO** — nenhuma alteração remota autorizada |
| Ambiente local (2026-08-02) | **B — apto apenas para validações estáticas** |

**CÓDIGO PRONTO PARA REVISÃO: sim. ROLLOUT AUTORIZADO: não.**

---

## 15. Próximo passo operacional aprovado

Preparar a máquina para um ambiente local **isolado** — nesta ordem, e **nenhum
passo aplica migration, faz deploy ou toca o remoto**:

1. instalar **Docker Desktop** com *backend* WSL adequado;
2. instalar cliente PostgreSQL (**`psql`** e **`pg_dump`**);
3. **reiniciar a sessão** para que a CLI entre no `PATH` (hoje ela existe mas não
   está no `PATH` da sessão antiga);
4. comprovar `docker info` — *daemon* saudável;
5. preparar **diretório temporário sem vínculo**;
6. criar plano de configuração local (config isolado, descartável);
7. **provar isolamento ANTES de iniciar qualquer stack**;
8. só então avaliar ensaio local.

⛔ **Ainda não executar:** `supabase start` · `db reset` · *dump* remoto ·
importação · migration · deploy.

**Instalar Docker e `psql` não muda a categoria por si só.** Para sair de B, é
preciso **provar**: destino exclusivamente local · ausência de conexão com produção
· `pg_cron` controlado ou desativado · Vault local vazio · `net._http_response` sem
chamadas · segredos exclusivamente locais · nenhuma URL de produção nos *jobs*
executáveis · ambiente descartável · ausência de dependência do projeto vinculado.
