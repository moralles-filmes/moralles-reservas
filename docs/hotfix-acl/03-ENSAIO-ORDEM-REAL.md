# Ensaio da ordem real — `076 → 085 → 077–084`

> Executado em 2026-07-30 contra **clone efêmero do schema real de produção**.
> **Resultado: NO-GO.** A 085 não deve ir para produção como está. Quatro defeitos
> encontrados, três deles invisíveis à análise estática. Detalhe em §7.

---

## 1. Por que clone de produção, e não `db reset` nem Supabase Branch

O ensaio original tentou `supabase db reset` (replay de 001→085 num banco vazio) e travou:
o histórico versionado **não consegue reconstruir o banco** — 54 migrations usam
`create or replace function` para alterar retorno tabular e só 4 usam `drop function`, o que
estoura com `42P13 — cannot change return type of existing function`. Evidência completa na
branch `investigation/migration-history-replay`.

**Supabase Branch não resolve:** a própria descrição da API diz que ele "aplica todas as
migrations do projeto principal num banco novo" — ou seja, replay do zero, o mesmo `42P13`.

O caminho usado foi o terceiro autorizado, **ambiente equivalente derivado do schema real**:

```bash
supabase db dump --linked -f prod-public.sql --schema public   # LEITURA PURA em producao
# stack local descartavel, fora do repositorio, sem edge-runtime
supabase start -x studio,imgproxy,storage-api,realtime,logflare,vector,supavisor,edge-runtime,postgres-meta
docker exec -i supabase_db_clone-env psql -U postgres -d postgres < prod-public.sql
```

Isso pula o replay inteiro: o clone **parte do schema que produção tem hoje**, que é exatamente
a situação sobre a qual a 085 vai ser aplicada.

**O dump carrega o que importa:** 186 `GRANT ... ON FUNCTION`, 36 `REVOKE`, 12
`ALTER DEFAULT PRIVILEGES`, 72 funções, 77 policies. Inclusive a própria vulnerabilidade
(`GRANT ALL ON FUNCTION public.append_conversation_message(...) TO "anon"`) e a causa raiz
(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... GRANT ALL ON FUNCTIONS TO "anon"`).

### Fidelidade do clone — conferida contra produção, coluna a coluna

| | tabelas | funções | não-trigger | policies | exec. por anon | SECURITY DEFINER |
|---|---|---|---|---|---|---|
| Produção | 47 | 72 | 57 | 77 | 39 | 60 |
| Clone | 47 | 72 | 57 | 77 | 39 | 60 |

Histórico semeado idêntico: **103 migrations, última `20260726100500` (076)**, nenhuma 077–085.

## 2. Neutralização de efeitos externos — o que foi desligado

| Vetor | Estado no clone | Como se sabe |
|---|---|---|
| Edge Functions | **inexistentes** | `edge-runtime` excluído do `supabase start`; `docker ps` confirma |
| `cron.job` | **schema não existia** | dump é só `public`; `pg_cron` só foi instalado na Fase E |
| Segredos (Vault) | **`vault.secrets = 0`** | os wrappers de cron fazem `raise notice ... skip` sem `internal_api_key` (082:41, 083:42) |
| Chamadas HTTP | **nenhuma** | `net.http_request_queue` e `net._http_response` em **0/0** do início ao fim |
| Asaas / Z-API / Resend / Stripe | inalcançáveis | dependem de Edge Function + segredo; ambos ausentes |
| Dados reais | **nenhum** | dump é `--schema public`, schema-only; nenhum registro de cliente foi copiado |

Na Fase E o `pg_cron` foi instalado (as migrations 082/083 exigem), os 2 jobs criados foram
**removidos com `cron.unschedule`** logo após, e `net._http_response` seguiu em 0.

## 3. Fase A — baseline antes da 085

| Métrica | Valor |
|---|---|
| Funções não-trigger / trigger | 57 / 15 |
| SECURITY DEFINER | 60 |
| Executáveis por `anon` | **39** |
| Executáveis por `authenticated` | 43 |
| **SECURITY DEFINER expostas a `anon`** | **37** |
| SECURITY DEFINER sem `search_path` | 1 — `expire_vouchers()` |
| Ownership | `postgres`, 72 de 72 |
| `pg_default_acl` (funções) | `postgres` **e** `supabase_admin`, ambos com `anon`+`authenticated` |

Estado inicial das críticas: `append_conversation_message`, `cleanup_processed_messages`,
`cleanup_webhook_executions`, `get_undelivered_notifications`, `list_orphan_unit_assets`,
`mark_outbox_done`, `mark_outbox_failed`, `next_waitlist_code`, `search_reservations`,
`unit_role`, `is_*`, `normalize_br_phone` — **todas com `anon = true`**. As 14 `trigger_*`
idem. `expire_vouchers()` já era service_role-only.

## 4. Fase B — a 085 aplicada isoladamente

`supabase migration up` com a 085 como **única pendente**: aplicou limpa, sem erro.

| Métrica | Antes | Depois |
|---|---|---|
| Executáveis por `anon` | 39 | **13** |
| Executáveis por `authenticated` | 43 | **21** |
| SECURITY DEFINER expostas a `anon` | 37 | **12** |
| SECURITY DEFINER sem `search_path` | 1 | **0** |
| `pg_default_acl` do `postgres` | `{postgres, anon, authenticated, service_role}` | **`{postgres, service_role}`** |
| `pg_default_acl` do `supabase_admin` | inalterado | **inalterado** |

### Os 12 pontos

| # | Ponto | Resultado |
|---|---|---|
| 1 | 14 `trigger_*` fechadas a PUBLIC/anon/authenticated | ✅ 0 violações |
| 2 | `cleanup_*` fechadas a esses papéis | ✅ 0 violações |
| 3 | `append_conversation_message` fechada | ✅ `anon=f`, `auth=f` |
| 4 | Callers legítimos com `service_role` seguem autorizados | ✅ Fase C, T6 |
| 5 | Helpers das policies seguem executáveis | ✅ Fase C, T5 |
| 6 | `normalize_br_phone` no trigger INVOKER | ✅ Fase C, T2 |
| 7 | `get_undelivered_notifications` mantém guarda tenant | ✅ `ERROR: forbidden` de dentro da função |
| 8 | `expire_vouchers()` com `search_path` fixo | ✅ |
| 9 | Defaults alterados só na role auditada | ✅ só `postgres`; `supabase_admin` intacto |
| 10 | Nenhuma permissão ampla por precaução | ✅ nenhum grant de schema inteiro |
| 11 | **Snapshot gravado e inacessível ao tenant** | ✅ 72 linhas, FORCE RLS, 0 policies |
| 12 | **Guardrail passa sem violações inesperadas** | ❌ **5 violações** — §7 |

> **Divergência contra a análise estática.** A tabela de impacto do
> [02-VALIDACAO-E-RISCOS.md](02-VALIDACAO-E-RISCOS.md) dizia "**só o dono**" para as `trigger_*`
> e `cleanup_*`. O real é **dono + `service_role`**: a 085 revoga `from public, anon,
> authenticated` e não mexe no grant pré-existente de `service_role`. Os 12 pontos exigem
> fechamento para PUBLIC/anon/authenticated e isso está cumprido — mas a tabela precisa dizer a
> verdade. Sem impacto de segurança: `service_role` já bypassa RLS e é a chave do backend.

## 5. Fase C — regressão dos fluxos legítimos

| Teste | Resultado |
|---|---|
| T1 — 7 RPCs públicas allowlisted como `anon` | ✅ todas executam |
| T2 — INSERT anônimo em `customers` → trigger INVOKER | ✅ telefone gravado `11912345678` (canônico) |
| T3 — reserva anônima ponta a ponta | ✅ criada + `notification_outbox` recebeu linha |
| T4 — 9 negativas como `anon` | ✅ todas `permission denied for function` |
| T5 — `is_unit_member` como `anon` (24 policies `{public}`) | ✅ executa |
| T6 — `service_role` nos 3 callers legítimos | ✅ executam |
| T7 — `search_reservations` como `authenticated` | ✅ executa |
| T7 — `get_undelivered_notifications` como `authenticated` | ✅ `ERROR: forbidden` — **guarda interna preservada** |
| T8 — efeito externo | ✅ `pg_net` 0/0 |

**Nenhum fluxo legítimo quebrou. Nenhum acesso cross-tenant.** A guarda do T7 é o resultado que
mais importa: o ACL libera `authenticated`, e quem barra o tenant errado é a função, como no desenho.

## 6. Fase D — o guardrail morde

Quatro funções deliberadamente inseguras criadas **só no clone**. O guardrail subiu de 5 para
**12 violações**, nomeando função e assinatura em todas:

| Cenário pedido | Regra disparada |
|---|---|
| `SECURITY DEFINER` fora da allowlist | ✅ `fora-da-allowlist` [CRITICO] |
| grant indevido a PUBLIC | ✅ `grant-para-PUBLIC` [ALTO] |
| grant indevido a `anon` | ✅ `fora-da-allowlist` + `grant-para-PUBLIC` |
| COMMENT diz "service_role only" com outro papel executando | ✅ `comentario-mente` [CRITICO] |
| `search_path` mutável | ❌ **não disparou** — §7, D4 |

`drop function` nas quatro → guardrail volta às 5 violações pré-existentes. **Zero objeto
temporário restante** (`fn_teste_%` = 0).

## 7. Os quatro defeitos — motivo do NO-GO

### D1 — a seção 5 concede mas nunca revoga PUBLIC

`get_unit_public(text)`, `list_public_units()` e `normalize_br_phone(text)` continuam com o grant
ao pseudo-papel PUBLIC (`=X/postgres` no ACL). A seção 5 só faz `grant execute ... to anon,
authenticated`; falta o `revoke ... from public` antes. Efeito: qualquer papel presente ou
futuro executa, não só `anon`/`authenticated`. Mantém o guardrail vermelho para sempre.

### D2 — `is_platform_admin` e `is_org_member` mantêm `anon`

A allowlist aprova só `authenticated`; o banco concede `anon` também. **Provado seguro revogar:**

```
is_unit_member    -> 17 policies {authenticated} + 24 policies {public}   <- anon E NECESSARIO
is_platform_admin -> 26 policies {authenticated} + 0 policies {public}
is_org_member     ->  3 policies {authenticated} + 0 policies {public}
```

E **0 funções SECURITY INVOKER** referenciam as duas. Deixar `anon` é o oráculo de enumeração
já registrado como follow-up ("é este UUID um platform admin?"), sem nenhum caller que precise.

### D3 — a causa raiz NÃO fecha por default privileges (o achado mais importante)

O documento do achado dizia: *"`revoke from public` não basta porque restam os grants diretos"*.
Verdadeiro. **A recíproca também é, e passou despercebida:** remover os grants diretos não basta,
porque resta o grant embutido a PUBLIC que todo `CREATE FUNCTION` concede.

Comprovado em schema virgem, sem histórico de default ACL:

```
f1 (nenhum ALTER)                          -> proacl NULL, anon = true
alter default privileges ... revoke execute on functions from public
   -> NENHUMA linha criada em pg_default_acl
f2 (criada depois do revoke)               -> proacl NULL, anon = true
```

Ou seja: **nesta plataforma, `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM
PUBLIC` é no-op**, e toda função nova em `public` nasce executável por `anon`. Confirmado também
no schema real, com invocações separadas, depois da 085 aplicada.

**Consequência para o desenho:** o ponto 11 ("funções novas nascem fechadas") **não é alcançável**
pela seção 8. O que a seção 8 continua entregando, e é real: sem os grants diretos, um
`revoke ... from public` pontual passa a ser **suficiente** para fechar uma função — que é
exatamente o modo de falha original. Mas isso é higiene, não prevenção.

**O guardrail deixa de ser rede de segurança e vira o controle principal.** Ele detecta o caso
(`grant-para-PUBLIC` dispara), então precisa rodar em CI, não sob demanda. Fechar de verdade
exigiria event trigger em `ddl_command_end` — decisão de desenho maior, com revisão própria,
fora do escopo de um hotfix.

### D4 — o guardrail esconde um achado independente

As regras 1 e 3 de [audit-function-acl.ts](../../scripts/audit-function-acl.ts) fazem `continue`,
então a regra 5 (`search_path-mutavel`) **nunca é avaliada** para função exposta fora da
allowlist. Foi por isso que `fn_teste_definer_sem_searchpath` não foi reportada por `search_path`.
Não é falso negativo total (a função é sinalizada por outra regra), mas esconde um defeito
ortogonal e torna a remediação serial. Correção: mover a regra 5 para o topo do laço.

## 8. Correção candidata — validada no clone

D1 e D2 aplicados **como SQL avulso no clone** (o arquivo do repositório não foi tocado):

```sql
revoke all on function public.get_unit_public(text)    from public;
revoke all on function public.list_public_units()      from public;
revoke all on function public.normalize_br_phone(text) from public;
grant execute on function public.get_unit_public(text)    to anon, authenticated;
grant execute on function public.list_public_units()      to anon, authenticated;
grant execute on function public.normalize_br_phone(text) to anon, authenticated;
revoke all on function public.is_platform_admin(uuid)   from anon;
revoke all on function public.is_org_member(uuid, uuid) from anon;
```

| Resultado | |
|---|---|
| Guardrail | ✅ **"Sem violações"**, 60 funções analisadas, 21 na allowlist |
| Executáveis por `anon` | **11** (era 39) |
| SECURITY DEFINER expostas | **10** (era 37) |
| Smoke test reexecutado | ✅ **diff vazio** contra a execução anterior — nenhuma regressão |

D3 **não tem correção candidata** (é impossível por esse caminho). D4 é no script.

## 9. Fase E — ordem `085 → 077–084`

7 arquivos trazidos por `git show` da `billing-asaas/fase-5b` (sem merge, sem tocar a árvore do
repositório) e aplicados com **exatamente** `supabase migration up --include-all`.

**Todas as 7 aplicaram, na ordem 077 → 078 → 079 → 080 → 082 → 083 → 084**, com a 085 já
aplicada antes. Histórico final: 111 versões, `max(version) = 20260730160000` (a 085), o que
comprova a ordem real invertida por timestamp.

| Verificação | Resultado |
|---|---|
| Nenhuma migration dependeu dos default grants antigos | ✅ `exec_anon` **continuou 13**, `secdef_exposta` **continuou 12** |
| Nenhuma função interna voltou a ser exposta | ✅ superfície idêntica à pós-085 |
| 079 preservou o ACL da função existente | ✅ `resolve_or_activate_subscription` = `{postgres=X/postgres,service_role=X/postgres}` |
| 082/083 nasceram fechadas | ✅ `anon=f`, `auth=f` — **mas por revoke explícito da 084**, não pelo default (ver D3) |
| Cron continua como owner | ✅ `username = postgres` nos 2 jobs |
| 084 idempotente | ✅ reexecução completa: `NOTICE: 16 funcao(oes)`, fingerprint MD5 idêntico |
| Efeito externo | ✅ `pg_net` 0/0 |

> A 084 revoga **16** funções `trigger_*` — as 14 antigas **e** as 2 novas da 082/083. Por isso
> elas estarem fechadas não prova o efeito do default da 085; a prova isolada é a Fase D, e ela
> deu negativo (D3).

## 10. Recomendação

**NO-GO para aplicar a 085 em produção como está.**

Não por risco de quebra — o clone provou que ela aplica limpa, corta a exposição de 39 para 13 e
**não quebra nenhum fluxo legítimo**. O NO-GO é porque o critério 10 da lista de GO
("guardrail detecta violações e volta a passar após a limpeza") falha por D1/D2, e porque a
seção 8 promete no cabeçalho um efeito que D3 mostra não existir. Aplicar assim deixaria o
guardrail vermelho desde o primeiro dia — e guardrail que nasce vermelho é guardrail que ninguém
olha.

Os quatro são corrigíveis **dentro da 085 e do script**, que não estão aplicados em lugar nenhum.
Correção proposta:

1. **D1** — acrescentar os três `revoke ... from public` na seção 5. *(validado no clone)*
2. **D2** — acrescentar os dois `revoke ... from anon`. *(validado no clone)*
3. **D3** — corrigir o cabeçalho e a seção 8 para o efeito real; registrar o event trigger como
   follow-up de desenho; declarar o guardrail como controle de CI obrigatório.
4. **D4** — mover a regra `search_path-mutavel` para o topo do laço.

Depois disso, revalidar no clone (Fases B–E) e então reavaliar o GO.

## 11. Ambiente

Continua **de pé** para revalidar a correção assim que autorizada. Evidências em
`scratchpad/clone/`: `A-antes-085.txt`, `B-depois-085.txt`, `C-smoke.txt`, `E-depois-084.txt`,
`F-smoke-pos-correcao.txt`, `G-final.txt`.

Para encerrar:

```bash
cd <scratchpad>/clone-env && npx supabase stop --no-backup
```

Nada foi aplicado, deployado, pushado ou mergeado em produção. O único acesso a produção foi
**leitura**: `db dump --schema public` e queries de auditoria.
