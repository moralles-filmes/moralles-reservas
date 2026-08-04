# FASE 6B — Diagnóstico do ambiente local (2026-08-02)

> **Verificação somente leitura.** Nenhum comando remoto, nenhuma migration, nenhum
> deploy, nenhuma escrita local ou remota. O único binário executado foi
> `supabase.exe --version`.
> Contexto: [FASE-6B-RESUMO.md](FASE-6B-RESUMO.md) · [FASE-6B-PACOTE-EXECUCAO.md](FASE-6B-PACOTE-EXECUCAO.md).

---

## 🔴 Achado que muda o quadro de risco

**O repositório JÁ ESTÁ VINCULADO ao projeto de PRODUÇÃO.**

`supabase/.temp/` contém `linked-project.json`, `project-ref`, `pooler-url` e quatro
arquivos de versão do serviço remoto (`gotrue`, `postgres`, `rest`, `storage`), todos
com data de **hoje, 10:36**. O `project-ref` começa com `gbab…` — **é o mesmo projeto
que a Seção D proíbe receber POST**.

Consequência prática, e ela é imediata:

> **A partir deste diretório, `supabase db push` e `supabase functions deploy`
> atingem PRODUÇÃO por padrão — sem pedir confirmação de destino e sem precisar de
> `supabase link`.** O vínculo já está feito.

O que isso **não** significa: nada foi aplicado. `db push` não roda sozinho. Mas o
comando mais destrutivo do pacote deixou de exigir um passo preparatório, e essa
proteção acidental desapareceu.

**Mitigações verificadas:**

| | |
|---|---|
| `supabase/.temp/` está no `.gitignore`? | ✅ sim, linha 13 |
| Algum arquivo de `.temp` rastreado pelo git? | ✅ nenhum |
| `pooler-url` carrega senha embutida? | ✅ não — só usuário e host |
| `.env.local` está ignorado e nunca foi commitado? | ✅ sim (`.gitignore:5`), zero ocorrências no histórico |

**Recomendação:** manter o vínculo (removê-lo não aumenta segurança — bastaria
refazê-lo), e tratar **todo** comando `supabase` neste diretório como
potencialmente remoto até prova em contrário. `--linked` não é o único caminho
para produção; a ausência de `--local` já basta em vários subcomandos.

---

## 1. Diagnóstico do ambiente

| Item | Resultado | Como foi verificado |
|---|---|---|
| **Supabase CLI** | ✅ **2.111.0** | `supabase.exe --version` |
| Caminho do executável | `C:\Users\Yuri\scoop\apps\supabase\2.111.0\supabase.exe` (shim em `scoop\shims`) | busca em disco |
| **CLI no PATH desta sessão** | ❌ **não** — nem no Bash nem no PowerShell | `which` / `Get-Command` |
| **Docker** | ❌ **NÃO INSTALADO** | binário ausente; `Docker Desktop.exe` ausente; serviço `com.docker.service` inexistente; nenhum processo `dockerd` |
| Docker Compose | ❌ ausente por consequência | `docker compose` e `docker-compose` inexistentes |
| WSL | ✅ presente (pré-requisito, não substituto) | `wsl.exe` |
| **`psql`** | ❌ **NÃO INSTALADO** | ausente do PATH; sem instalação em `Program Files\PostgreSQL` |
| `pg_dump` | ❌ ausente | idem |
| `supabase/config.toml` | ✅ existe (4.931 bytes) | — |
| Raiz do projeto correta | ✅ `cwd` == `git rev-parse --show-toplevel` | — |
| Árvore de trabalho | ✅ limpa, `billing-asaas/fase-6b` em `ebb1380` | `git status` |
| **CLI autenticada** | ⚠️ **sim, por credencial fora do disco** | nenhum `access-token` em `~/.supabase`, `%APPDATA%` ou `%LOCALAPPDATA%`; `SUPABASE_ACCESS_TOKEN` não definida — mas o `link` de hoje buscou metadados remotos, então o token está no **Windows Credential Manager** |
| **Projeto linkado** | 🔴 **sim — `gbab…` (produção)** | `supabase/.temp/linked-project.json` + `project-ref`, 10:36 de hoje |
| Vínculo armazenado em | `supabase/.temp/` (ignorado pelo git, não rastreado) | — |
| `.env.local` aponta para produção | ⚠️ sim | contém `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ZAPI_CLIENT_TOKEN` — **nomes conferidos, valores não lidos** |

**Nota sobre `.env.local`:** `SUPABASE_SERVICE_ROLE_KEY` e `ZAPI_CLIENT_TOKEN` estão
num arquivo de env do frontend. Não vazam no *bundle* (não têm prefixo `VITE_`) e o
arquivo nunca foi commitado — mas o CLAUDE.md manda segredo de Edge Function morar em
`supabase secrets set`. Fica registrado; **não é ação desta rodada**.

---

## 2. `config.toml` não é config de stack local

Achado independente e decisivo para a pergunta "a CLI pode subir a stack?":

- **43 blocos, todos `[functions.*]`.** Zero outras seções.
- **Não existe `project_id`**, nem `[db]`, `[api]`, `[auth]`, `[studio]`, `[storage]`.

Este arquivo foi escrito para **configurar deploy de Edge Functions**, não para
levantar ambiente local. `supabase start` a partir daqui não tem configuração de
banco, porta, versão de Postgres nem seeds. Levantar a stack exigiria **escrever um
`config.toml` de stack** — o que é mudança de configuração do projeto, não
verificação.

---

## 3. Pré-análise estática

### 3.1 Compatibilidade CLI × projeto

| | |
|---|---|
| CLI local | **2.111.0** |
| Postgres remoto (cache do link) | **17.6.1.111** |
| Formato das migrations | `YYYYMMDDHHMMSS_nome.sql` — compatível |
| Migrations no repositório | **118** (112 aplicadas + **6 da 6b, pendentes**) |
| Risco de versão | ⚠️ **CLI ≥ 2.95 mudou o default de `verify_jwt` para `true`** — já tratado: as duas EFs novas têm entrada explícita no `config.toml` |

### 3.2 As seis migrations da 6b, em ordem

```
20260801200000_087_whatsapp_instances.sql
20260801200100_088_whatsapp_instance_cycles.sql
20260801200200_089_whatsapp_instance_alerts.sql
20260801200300_090_whatsapp_instance_cycle_rpc.sql
20260801200400_091_drop_zapi_auto_flags.sql
20260801200500_092_whatsapp_instance_cycles_trigger.sql
```

Nenhuma delas embute URL, segredo ou `cron.schedule`. A 093 (cron) **não existe** —
por desenho, para que `db push` não agende no primeiro passo.

### 3.3 O `42P13`, medido agora

Contagem própria sobre as 118 migrations, independente do ensaio de 30/07:

| Padrão | Ocorrências |
|---|---|
| `create or replace function` | **116** |
| `drop function` | **15** |
| `returns table` | 29 |

O ensaio de 30/07 mediu o **subconjunto causal** (54 × 4: funções cujo **retorno
tabular** mudou). Minha contagem é do padrão inteiro e concorda na direção.

**O que localiza o bloqueio** — funções redefinidas em mais de um arquivo:

| Função | Vezes redefinida |
|---|---|
| `get_unit_public_full` | **10** |
| `get_widget_public` | **8** |
| `get_reservations_for_survey` | 4 |
| `get_reservations_for_reminder` | 4 |
| `get_customer_stats` · `check_rate_limit` · `anonymize_customer` | 3 cada |
| mais 7 funções | 2 cada |

Uma única dessas cadeias em que a assinatura de retorno mudou já produz o `42P13`.
**Não vou reproduzir o erro** — a evidência é suficiente e o ensaio já foi feito.

### 3.4 Tabela de risco

| Arquivo / grupo | Risco | Impacto no replay | Impacto de segurança | Tratamento futuro | Frente |
|---|---|---|---|---|---|
| **13 migrations com URL literal de produção** (022, 029, 043, 045, 048, storage-orphan, stripe-expire, billing-crons, billing-trial, 064, 069, 082, 083) | 🔴 alto | nenhum — aplicam sem erro | **banco local com `pg_cron` faria POST em produção** | parametrizar leitura da URL; não reescrever dentro da 6b | **BASELINE** |
| **14 migrations usando `net.http_post`** | 🔴 alto | quebra ou fica inerte sem `pg_net` | mesma exposição acima | declarar a dependência | **BASELINE** |
| **`create extension pg_net` ausente do histórico** (0 ocorrências) | 🔴 alto | replay depende de extensão nunca declarada | — | declarar em migration compensatória | **BASELINE** |
| **`get_unit_public_full` (10×), `get_widget_public` (8×) e 12 outras** | 🔴 crítico | **é o `42P13`** — o replay para aqui | — | `drop function` antes do `create`, ou migration compensatória | **BASELINE** |
| **13 migrations lendo `vault.decrypted_secrets`** | 🟠 médio | replay passa; *wrappers* ficam inertes | fail-closed é o comportamento correto num banco novo | semear Vault de teste | **BASELINE** |
| **Segredos esperados: `internal_api_key`, `project_url`** | 🟠 médio | — | `project_url` é exigência **nova** da 092 | gate do §3 do pacote de execução | **6b** (o gate) / **BASELINE** (o Vault de teste) |
| **10 migrations com `create extension pg_cron`, 14 com `cron.schedule`** | 🟠 médio | replay agenda **14 jobs** num banco local | combinado com a URL literal → POST em produção | desligar `pg_cron` no *bootstrap* local | **BASELINE** |
| **`config.toml` sem `project_id` e sem `[db]`** | 🟠 médio | impede `supabase start` como está | — | escrever config de stack **fora** do repositório | **BASELINE** |
| **Vínculo ativo com produção** (`supabase/.temp/`) | 🔴 alto | — | **`db push`/`deploy` atingem produção sem passo extra** | disciplina + gates; não remover o vínculo | **6b (operacional)** |
| **6 migrations da 6b** (087–092) | 🟢 baixo | não introduzem o padrão; a 092 lê do Vault | fail-closed sem segredo | aplicar após os seis gates | **6b** |

⛔ **As treze migrations antigas não são alteradas dentro da Fase 6b.**

---

## 4. A CLI pode subir a stack sem replay?

**Existe um caminho suportado, ele já foi usado neste projeto, e ele não é
executável nesta máquina.**

O ensaio de 2026-07-30 ([docs/hotfix-acl/03-ENSAIO-ORDEM-REAL.md §1](../hotfix-acl/03-ENSAIO-ORDEM-REAL.md))
tentou `supabase db reset`, bateu no `42P13`, e resolveu **pulando o replay**:

```
supabase db dump --linked --schema public   # LEITURA PURA em produção
supabase start -x studio,imgproxy,storage-api,realtime,logflare,vector,supavisor,edge-runtime,postgres-meta
docker exec -i supabase_db_… psql -U postgres -d postgres < dump.sql
```

O clone partia do **schema que produção tem hoje** — 47 tabelas, 72 funções, 77
policies, conferido coluna a coluna. A neutralização foi real e verificada:
`edge-runtime` excluído, `vault.secrets = 0` (então os *wrappers* faziam
`raise notice … skip`), e `net._http_response` em **0 do início ao fim**.

**Por que não serve hoje, ponto a ponto:**

| Requisito daquele caminho | Estado aqui |
|---|---|
| `supabase start` | ❌ **exige Docker** — ausente |
| `docker exec … psql` | ❌ **Docker e `psql` ausentes** |
| `supabase db dump --linked` | ❌ é **comando remoto** — proibido nesta rodada |
| `config.toml` de stack | ❌ o do repositório é só de *functions* |

Sobre as demais possibilidades da sua pergunta 4: desligar `pg_cron` no *bootstrap*,
isolar rede, usar config e diretório temporários — **todas pressupõem uma stack de
pé**, e a stack pressupõe Docker. Não há o que avaliar adiante do primeiro item.

**E a alternativa de "criar só as seis tabelas à mão para testar"?** Ela é possível
e seria **teste parcial, nunca replay validado** — o schema resultante não é o real,
e os onze casos de integração que dependem de CHECK, índice parcial, *trigger* de
tenancy e ACL só provam algo contra o schema verdadeiro. Não vou construir isso e
chamar de integração verde.

---

## 4.1 Correção: os seis gates não dependem do ambiente

Verificado no *frontmatter* dos seis agentes `saas-shield-br`: **todos declaram
`tools: Read, Glob, Grep`**. Nenhum tem *shell*, nenhum acessa banco.

| Gate | Ferramentas | Precisa de banco? |
|---|---|---|
| `rls-auditor` | `Read, Glob, Grep` | não |
| `tenant-isolation-auditor` | `Read, Glob, Grep` | não |
| `identity-access-auditor` | `Read, Glob, Grep` | não |
| `migration-validator` | `Read, Glob, Grep` | não |
| `secret-hunter` | `Read, Glob, Grep` | não |
| `integration-reliability-auditor` | `Read, Glob, Grep` | não |

**A ausência de Docker nunca explicou a não execução dos gates.** O único bloqueio
é **autorização de despacho de subagentes** — eles rodam sobre os arquivos do
repositório e poderiam ter rodado antes de qualquer instalação. Colocá-los depois
de "instalar Docker" no caminho crítico seria erro de sequenciamento.

**O `secret-hunter` tem uma ressalva própria:** sem *shell*, a varredura de
histórico git (`gitleaks`/`trufflehog`/`git log`) e o *build* de *bundle* fresco
são **emitidos como próxima ação**, não executados. Isso é trabalho humano à parte,
não parte do gate.

**Guardrail estático local ≠ gate.** Os 610 testes, o `acl-estatico` do CI, o
`migration-static-guard` e o teste de acoplamento por string estão verdes e ficam
registrados **como guardrails estáticos locais**. Nenhum deles pode ser contado
como gate, e `SAAS_SHIELD_GATES_NOT_EXECUTED` permanece.

---

## 5. Status dos bloqueios

**REMOVIDO:**

- ✅ `SUPABASE_CLI_NOT_INSTALLED` → agora `SUPABASE_CLI_INSTALLED` (2.111.0)

**A instalação da CLI removeu SOMENTE esse item.** Ela não autoriza: aplicação de
migrations · deploy de Edge Functions · uso do banco remoto · *dump* remoto ·
*backfill* · execução do worker · criação do cron · merge.

**VERIFICADO NESTA RODADA, e o resultado é negativo:**

- 🔴 `DOCKER_NOT_INSTALLED` *(era `DOCKER_AVAILABILITY_UNVERIFIED`)*
- 🔴 `PSQL_NOT_INSTALLED` *(era `PSQL_AVAILABILITY_UNVERIFIED`)*

**NOVO, descoberto nesta rodada:**

- 🔴 `LINKED_TO_PRODUCTION_REMOTE` — `db push`/`deploy` atingem produção sem passo preparatório

**AINDA PENDENTE, sem alteração:**

- 🔴 `REPLAY_FAILS_42P13`
- 🔴 `UNSAFE_AS_IS`
- 🔴 `DATABASE_INTEGRATION_ENVIRONMENT_BLOCKED`
- 🔴 `SAAS_SHIELD_GATES_NOT_EXECUTED`
- 🔴 `NO_GO_BEFORE_BACKFILL`
- 🔴 `CRON_NO_GO`
- 🔴 `MERGE_NO_GO`

**A instalação da CLI não transformou:** migrations escritas em aplicadas · EFs
escritas em deployadas · painel escrito em publicado · testes bloqueados em
executados · gates não executados em verdes.

---

## 6. Recomendação

### **B — AMBIENTE LOCAL APTO APENAS PARA VALIDAÇÕES ESTÁTICAS**

**Não é C**, e a razão é única e suficiente: **Docker não está instalado**, então não
existe stack local — logo não há como provar isolamento contra produção, nem que o
cron local não chamaria produção, nem que os segredos são locais. Os outros
critérios de C nem chegam a ser avaliáveis.

**Não é A**, porque A pressupõe que a CLI ainda falta. Ela existe e já habilita
trabalho real: `supabase functions list`, `db diff --local`, *lint* de migrations e
o próprio pacote de execução ganharam viabilidade.

**Não é D**, porque D exige os seis gates e autorização explícita — nenhum dos dois
existe.

### Para chegar a C, na ordem

1. Instalar **Docker Desktop** (WSL já presente) e confirmar o *daemon* rodando;
2. Instalar **`psql`** (cliente PostgreSQL);
3. Escrever um `config.toml` de stack **fora do repositório**, num diretório
   descartável — nunca sobrescrevendo o do projeto, que é de *functions*;
4. Provar isolamento **antes** de qualquer migration: `pg_cron` desligado no
   *bootstrap*, `vault.secrets = 0`, `net._http_response` em 0;
5. Só então decidir entre replay (que exige a frente BASELINE) e clone por `dump`
   (que exige **uma** leitura remota autorizada).

---

## 7. Comandos seguros **para depois** — nenhum executado

Locais, sem tocar produção nem subir banco:

```bash
supabase --version
supabase functions list --help          # só a ajuda; sem --project-ref não vai a lugar nenhum
supabase migration list --local         # lê apenas o diretório local
supabase db lint --help
```

Depois de Docker instalado, ainda **antes** de qualquer migration:

```bash
docker info                             # prova que o daemon responde
supabase start --help
```

## 8. Comandos proibidos nesta rodada — nenhum executado

`supabase db reset` · `supabase db push` · `supabase migration up` em remoto ·
`supabase link` · `supabase functions deploy` · `supabase secrets set` ·
`supabase db dump --linked` · `vault.create_secret` / `update_secret` ·
aplicação das migrations 087–092 · alteração de `platform_flags` · *backfill* do
Ren Sushi · execução do worker em produção · criação do cron · merge · qualquer
`UPDATE`/`INSERT` para "validar" o rollout.

---

## 8.1 Veredito consolidado

```
VALIDAÇÕES ESTÁTICAS ....... GO
STACK LOCAL ................ INDISPONÍVEL
INTEGRAÇÃO COM BANCO ....... ENVIRONMENT_BLOCKED
COMANDOS REMOTOS ........... NO-GO
MIGRATIONS ................. WRITTEN / NOT APPLIED
EDGE FUNCTIONS ............. WRITTEN / NOT DEPLOYED
PAINEL ..................... WRITTEN / NOT DEPLOYED
SAAS-SHIELD-BR ............. NOT EXECUTED
BACKFILL ................... NO-GO
CRON ....................... NO-GO
MERGE ...................... NO-GO
```

**Nenhuma alteração remota foi autorizada.**

---

## 9. Confirmação de não-alteração

**Nada foi alterado, local ou remotamente.** Só houve leitura:

- comandos de versão e de localização de binário (`--version`, `which`, `Get-Command`);
- leitura de arquivos do repositório e de `supabase/.temp/`;
- `git status` / `git log` / `git check-ignore` — todos somente leitura;
- `grep` sobre migrations e `config.toml`.

**Nenhuma conexão foi feita ao projeto remoto por mim.** As versões de `gotrue`,
`postgres`, `rest` e `storage` que aparecem neste documento vieram do **cache em
disco** deixado pelo `link` de hoje às 10:36 — foram lidas do arquivo, não buscadas
na rede.

**Nenhum segredo foi exibido:** o `project-ref` aparece truncado em quatro
caracteres, o `pooler-url` foi inspecionado por programa que reportou apenas
*"tem credencial embutida: não"*, e do `.env.local` só se leram os **nomes** das
chaves.

`git status` ao fim: **limpo**, exceto por este arquivo novo.
