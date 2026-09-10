# Hardening dos warnings do Security Advisor — design

Data: 2026-08-17
Projeto Supabase: `gbabxcrntkwgblgqsiit` (Moralles Reservas)

## 1. O problema, medido

O Security Advisor devolve hoje **29 WARN + 17 INFO**. Os WARN são dos lints
`0028_anon_security_definer_function_executable` e
`0029_authenticated_security_definer_function_executable`: funções
`SECURITY DEFINER` do schema `public` alcançáveis por `anon`/`authenticated`
via `/rest/v1/rpc/<nome>`.

Todos os 29 já estão classificados e justificados em
[scripts/function-acl-allowlist.json](../../../scripts/function-acl-allowlist.json).
Nenhum é achado novo. A pergunta desta fase não é "o que descobrimos", é
**"quanto disso é superfície real e quanto é ruído aceito"**.

| Bucket | Lint | Qtd | Redutível |
|---|---|---|---|
| RPCs públicas de portal/fila — 9 funções × (`anon` + `authenticated`) | 0028 + 0029 | 18 | Não, sem trocar por Edge Function |
| Helpers de RLS — `is_unit_member` (anon+auth), `is_platform_admin`, `is_org_member` | 0028 + 0029 | 4 | **Sim** |
| RPCs autenticadas com guard interno — 7 assinaturas | 0029 | 7 | Parcialmente (2 overloads mortos) |
| Tabelas `FORCE RLS` sem policy | 0008 (INFO) | 17 | Não — é o design |

Medições contra o banco que sustentam o desenho:

- `is_unit_member` é referenciado por **42 policies, 24 delas `TO PUBLIC`**;
  `is_platform_admin` por 39; `is_org_member` por 3. Revogar `EXECUTE` de `anon`
  faz a query **estourar com `permission denied`**, não negar linha — por isso o
  grant existe.
- **4 Edge Functions** chamam os helpers como RPC via PostgREST (8 call sites):
  `create-manual-reservation`, `update-reservation`, `send-cancellation`,
  `send-manual-message`.
- **4 funções `SECURITY DEFINER` chamam os helpers pelo nome dentro do corpo**:
  `enter_waitlist`, `anonymize_customer`, `get_customer_stats_bulk` (as três com
  `public.is_*` qualificado) e `get_undelivered_notifications` (sem qualificar,
  com `search_path=public`). **Este é o achado que decide a fase**: em plpgsql o
  nome é resolvido em tempo de execução, então mover o helper de schema sem
  reescrever esses corpos quebra a entrada pública na fila de espera, a
  anonimização LGPD, a listagem de clientes e o painel de Entregas. Não aparece
  em nenhuma leitura de policy.

### Discrepância de contagem

A contagem informada foi 32 e a API devolve 29. A diferença provável são
avisos que o painel soma e a API de advisors não devolve (versão do Postgres,
proteção de senha vazada, extensão em `public`). A Fase 3 fecha isso: o
guardrail passa a imprimir o total observado, então a divergência deixa de ser
memória e vira saída de script.

## 2. Decisões tomadas

1. **Encolher o redutível e documentar o resto.** Zerar o painel exigiria trocar
   as 9 RPCs públicas de portal/fila por Edge Functions — reescrita da camada de
   dados de `/r/:slug`, `/w/:slug`, `/acompanhar/:token` e da entrada na fila,
   com a mesma decisão de confiança apenas mudando de lugar. Custo alto, ganho de
   segurança ~nulo. Rejeitado.
2. **Escopo completo na Fase 1**: migration + `_shared/authz.ts` + redeploy das
   4 EFs.
3. **Aceite auditável**: allowlist estendido + guardrail novo que compara o
   advisor ao vivo contra o esperado.

## 3. Fase 1 — helpers fora do schema exposto

Único item do lote com exposição concreta: hoje qualquer portador da anon key
chama `/rest/v1/rpc/is_unit_member` com `p_user_id`/`p_unit_id` arbitrários e
recebe um booleano — oráculo de enumeração de membership.

### 3.1 `_shared/authz.ts` (novo)

```ts
hasUnitAccess(supabase, userId, unitId): Promise<boolean>
```

Consulta `unit_members` e `platform_admins` direto (as 4 EFs já rodam com
service_role, que bypassa RLS), mantendo o invariante do CLAUDE.md: guard de
unidade **sempre** com o paralelo `platform_admin`, porque `useCurrentUnit.ts`
fabrica pseudo-membership "owner" para super-admin operar unidades alheias.

**Semântica preservada byte a byte**: hoje o código faz
`if (!memberResult.data && !adminResult.data) → 403`, o que trata erro de
leitura como negação. O helper novo mantém exatamente isso (fail-closed,
`false` em erro) e apenas passa a logar o erro. Esta fase **não** muda código de
status em nenhum caminho — trocar 403 por 503 em falha de banco seria melhoria
defensável, mas é mudança de comportamento e fica fora daqui.

### 3.2 Migration `20260910120000_106_advisor_private_rls_helpers.sql`

Numeração: 106 é o próximo livre (105 é a última numerada); timestamp maior que
`20260817212500`, a última aplicada.

```sql
create schema if not exists app_private;
revoke all on schema app_private from public;
revoke all on schema app_private from anon, authenticated;
grant usage on schema app_private to service_role;

alter function public.is_unit_member(uuid, uuid)    set schema app_private;
alter function public.is_platform_admin(uuid)       set schema app_private;
alter function public.is_org_member(uuid, uuid)     set schema app_private;
```

- `app_private` **não** entra na configuração de schemas expostos do PostgREST.
  Expor o schema reabriria o mesmo lint — é o ponto inteiro da mudança.
- `USAGE` de schema **não** é load-bearing, e por isso `anon`/`authenticated`
  **não** o recebem. As 24 policies `TO PUBLIC` avaliam o helper sob o papel de
  quem consulta, mas o que é conferido ali é o `EXECUTE` da função, por
  identificador já resolvido, em tempo de execução — `USAGE` só governa resolução
  de NOME, que expressão de policy guardada no catálogo nunca faz. Medido no
  pré-voo: a suíte inteira roda com `anon` sem `USAGE` e ACL-1 (policy
  `TO PUBLIC`), ACL-1b (tenant cruzado) e ACL-4 (`anon` na fila ponta a ponta)
  ficam verdes. Negá-lo é defesa em profundidade: se `app_private` for exposto à
  API por engano, `is_unit_member` já carrega `EXECUTE` para `anon`, e a ausência
  de `USAGE` é a única tranca que ainda segura o oráculo. `service_role` mantém
  `USAGE` porque já é todo-poderoso.
- As policies referenciam a função por **OID**, então `SET SCHEMA` é transparente
  para elas. Isso é asserção a **provar no pré-voo** (caso ACL-1), não a assumir.
- Os grants de `EXECUTE` viajam com a função; nenhum `grant`/`revoke` extra.

Na **mesma** migration, `create or replace` das 4 funções que chamam os helpers
pelo nome, qualificando `app_private.is_*` e com
`set search_path = public, app_private, pg_temp`:
`enter_waitlist`, `anonymize_customer`, `get_customer_stats_bulk`,
`get_undelivered_notifications`. Mesma transação — um `SET SCHEMA` sem os
corpos atualizados é a fase quebrando a fila pública.

### 3.3 Allowlist

As 3 entradas do grupo `rls_helpers` saem: `audit_function_acl()` varre apenas
`public`, e as funções deixam de estar lá. Some junto o registro de que elas
eram exceção — o comentário `why` migra para o cabeçalho da migration, que é
onde a decisão passa a viver.

### 3.4 Ordem de aplicação (invertida em relação ao padrão do CLAUDE.md)

O padrão registrado é "migration antes da EF" porque o caso comum é EF que passa
a **ler** algo novo. Aqui é o oposto: a EF precisa parar de **depender** da RPC
antes que ela suma.

1. Deploy das 4 EFs com `_shared/authz.ts` — helpers ainda em `public`, sistema
   idêntico, nada quebra.
2. Confirmar em produção (uma reserva manual, um envio manual, um cancelamento).
3. `supabase db push` da 106.
4. Rodar o advisor: 29 → 25.

## 4. Fase 2 — overloads mortos

`get_reservation_by_code(p_code text)` não tem caller no repositório (o único
call site, [useReservas.ts:101-104](../../../src/hooks/useReservas.ts), passa
sempre `p_unit_id`).

`get_customer_stats(p_customer_id uuid)` só é alcançável quando
[useCustomers.ts:71-74](../../../src/hooks/useCustomers.ts) recebe `unitId`
undefined — o hook monta `p_unit_id` condicionalmente. O único consumidor
([Clientes.tsx:405](../../../src/pages/gestao/Clientes.tsx)) já passa `unitId`.

Trabalho: tornar `unitId` obrigatório em `useCustomerStats` e gatear o `enabled`
da query, depois migration `20260910121000_107_drop_dead_rpc_overloads.sql` com
os dois `drop function`. Migration separada da 106 de propósito — as duas fases
têm perfil de risco diferente e devem poder ser revertidas em separado.

Resultado: 25 → 23.

## 5. Fase 3 — aceite auditável dos 23 restantes

**Decisão revista durante o planejamento:** a spec previa um
`scripts/audit-advisor.ts` novo. Ele seria quase duplicata do
[audit-function-acl.ts](../../../scripts/audit-function-acl.ts), que já lê o ACL
real pela RPC `audit_function_acl()` e já sabe quem é `SECURITY DEFINER` — que é
exatamente o que os lints 0028/0029 medem. Dois guardrails com a mesma fonte
divergem; o existente é estendido no lugar.

1. **Allowlist estendido**: cada entrada ganha `advisor_lints` (`"0028"` e/ou
   `"0029"`) ao lado do `why`. `loadAllowlist()` ignora campo desconhecido, então
   a mudança é retrocompatível.
2. **Bloco `_expected_advisor`** na allowlist: o total de WARN esperado por lint.
   É a única forma de "23" virar número conferível em vez de memória.
3. **`audit-function-acl.ts` ganha a regra 6**: calcula o equivalente-advisor a
   partir das mesmas linhas (`is_secdef && (anon_execute || auth_execute)`) e
   **falha nomeando** a divergência contra `_expected_advisor`. Continua rodando
   por `workflow_dispatch` no job `acl-com-banco`, contra alvo não-produção.
4. **`function-acl-allowlist.test.ts` ganha a checagem de consistência** entre
   `_expected_advisor` e as entradas — roda em todo PR, sem banco.
5. Os 17 INFO `rls_enabled_no_policy` **ficam fora do guardrail**: vêm de tabelas,
   não de funções, e cobri-los exigiria RPC nova. São documentados como aceitos
   por design (tabela com credencial usa `FORCE RLS` sem policy e a UI acessa por
   Edge Function — invariante já no CLAUDE.md), não automatizados.

## 6. Testes — nenhuma loja pode ser afetada

Esta seção é requisito, não apêndice. Nada vai para `main` sem os itens abaixo
verdes, e cada guarda nova entra com **controle positivo**: reintroduzir o
defeito e ver o teste falhar é o que distingue "a guarda funciona" de "o teste
não testa nada".

### 6.1 Pré-voo local — `supabase/tests/local-preflight/09-advisor-hardening.sql`

O harness roda Postgres local descartável, sem Docker e sem `pg_cron`/`pg_net`.
O `00-bootstrap.sql` já cria os papéis `anon`, `authenticated` e `service_role`,
então `set role` + `set request.jwt.claims` permitem exercitar **RLS e grants**
de verdade — mais do que o README atual reivindica. O que continua fora do
alcance local é a **exposição PostgREST**; essa metade é da Fase 3, contra o
projeto real.

| Caso | Prova |
|---|---|
| ACL-1 | Policy `TO PUBLIC` que chama o helper continua avaliando depois do `SET SCHEMA` (as policies referenciam por OID). |
| ACL-2 | `enter_waitlist` conclui depois do `SET SCHEMA` **com** os corpos reescritos. |
| ACL-3 | `anonymize_customer`, `get_customer_stats_bulk` e `get_undelivered_notifications` idem. |
| ACL-4 | `set role anon` + insert público em `waitlist` conclui — o caminho da loja, ponta a ponta. |
| ACL-5 | Reaplicar a 106 três vezes não muda contagem nem ACL (idempotência). |
| ACL-6 | Após a 107, a chamada de 2 argumentos de `get_reservation_by_code`/`get_customer_stats` segue funcionando. |
| **CONTROLE-6** | Aplica o `SET SCHEMA` **sem** reescrever os corpos → `enter_waitlist` **falha** com função inexistente. Reintroduz o defeito central desta fase. Sem ele, "ACL-2 passou" não significa nada. |
| **CONTROLE-7** | Duas metades, e a primeira mudou de forma depois de medida. **7a:** afirma a postura entregue — `has_schema_privilege('anon'\|'authenticated', 'app_private', 'usage')` é `false` nas duas —, e quem prova que ela basta são ACL-1/1b/4 verdes ao lado. **7b:** `revoke execute on function app_private.is_unit_member(...) from anon` → a query da policy `TO PUBLIC` **estoura 42501**. É o `EXECUTE` que é load-bearing; revogar o `USAGE` do schema, medido, **não** afeta policy nenhuma — foi o que derrubou a suposição inicial desta spec. |
| **CONTROLE-8** | Dropar o overload de 2 argumentos por engano → o call site real quebra. Delimita o que a 107 pode dropar com segurança. |

O README do diretório é atualizado com a sequência de execução e com o que cada
controle desfaz.

### 6.2 Guardrails estáticos (vitest, rodam em todo PR)

- `src/lib/authz-ef-guard.test.ts`: falha se qualquer `supabase/functions/**/index.ts`
  voltar a conter `rpc("is_unit_member"` / `rpc("is_platform_admin"` /
  `rpc("is_org_member"`. Mesmo padrão do
  [whatsapp-instance-ef-write-guard.test.ts](../../../src/lib/whatsapp-instance-ef-write-guard.test.ts)
  — as EFs importam `deno.land`/`esm.sh` e chamam `serve()` no carregamento, então
  o vitest não consegue importá-las; a afirmação é estreita de propósito (*o
  padrão não pode voltar sem teste vermelho*) e é o que existe.
- `scripts/migration-static-guard.test.ts`: caso novo garantindo que migration
  futura não recrie os três helpers em `public`.
- `scripts/function-acl-allowlist.test.ts`: consistência entre
  `_expected_advisor` e as entradas, com **controle negativo** — entrada legítima
  não pode reprovar.

### 6.3 Gates obrigatórios antes do merge

A mudança toca RLS, multi-tenant e Edge Function, então os gates
`saas-shield-br:*` são obrigatórios pelo CLAUDE.md: `migration-validator`,
`rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`.
Mais `npm run typecheck` (`tsc -b`, nunca sem `-b`), `npm run test`,
`npm run lint`, e o check `acl-estatico` conferido na aba Checks — ele não é
required status check e não impede merge sozinho.

### 6.4 Verificação em produção, por fase

Depois do passo 1 da §3.4 (EFs, antes da migration): exercitar reserva manual,
envio manual de mensagem, cancelamento e edição de reserva — os 4 caminhos que
mudaram de guard. Depois da 106: entrada pública na fila em
`/r/:slug?action=waitlist`, painel Operacional → Entregas, ficha de cliente.
Depois da 107: busca por código e ficha de cliente de novo.
Ao final de cada uma, rodar o `audit-function-acl.ts` contra o projeto e
conferir o número esperado (25 e depois 23).

## 7. Rollback

Cada fase reverte sozinha.

- **106**: migration reversa devolve os três helpers a `public`
  (`set schema public`), regrant, e `create or replace` dos 4 corpos com a
  qualificação antiga. As EFs já não dependem da RPC, então não precisam voltar.
- **107**: recriar os dois overloads a partir do git.
- **EFs**: redeploy da versão anterior.

Modos de falha e como aparecem: erro de qualificação → 500 na entrada da fila e
nos 3 painéis citados; `usage` faltando → `permission denied` nas queries de
membro. **Nenhum caminho de falha desta fase produz vazamento entre tenants** —
todos falham fechado e barulhento, que é a propriedade que torna a fase segura
de aplicar.

## 8. Fora de escopo

- Trocar RPC pública por Edge Function (rejeitado na §2.1).
- Criar policy nas 17 tabelas `FORCE RLS` — é o design.
- Revogar `authenticated` das RPCs de portal: o dono logado abre o próprio portal
  e a chamada sairia com o JWT dele; o dado é público de qualquer forma.
- Trocar 403 por 503 em falha de leitura no guard das EFs (§3.1).
- Mexer nas outras 3 RPCs autenticadas com guard interno — `search_reservations`
  já é `SECURITY INVOKER`; `anonymize_customer` e `get_undelivered_notifications`
  precisam de DEFINER por desenho.

## 9. Critérios de aceite

1. Advisor do projeto em **23 WARN**, com a diferença explicada linha a linha.
2. `/rest/v1/rpc/is_unit_member` responde 404 para a anon key.
3. Pré-voo `09-advisor-hardening.sql` verde, com CONTROLE-6/7/8 demonstrando
   falha ao reintroduzir cada defeito.
4. `npm run typecheck`, `test`, `lint` verdes; `acl-estatico` verde.
5. Os 4 gates `saas-shield-br:*` sem bloqueante.
6. `audit-function-acl.ts` verde contra o projeto, com a regra 6 conferindo
   `_expected_advisor` e imprimindo o inventário por lint.
7. CLAUDE.md e AGENTS.md atualizados **no mesmo commit**, com o invariante novo:
   helper de RLS mora em `app_private`, e guard de EF usa `_shared/authz.ts`.
