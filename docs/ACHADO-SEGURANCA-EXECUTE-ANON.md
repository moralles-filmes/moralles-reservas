# Achado de segurança — funções `SECURITY DEFINER` executáveis por `anon` em produção

> **Status: ABERTO, confirmado em produção em 2026-07-30.** Descoberto ao executar a query de
> validação da migration 084 (Fase 5b). **Não é um achado da Fase 5b** — é anterior a ela e
> mais amplo. A 5b só o revelou, e a 084 fecha apenas uma parte.
>
> Projeto: `gbabxcrntkwgblgqsiit` (Moralles Reservas). Evidência colhida por consulta
> read-only a `pg_proc`, `pg_default_acl` e `cron.job`. **Nenhuma função foi invocada** — a
> confirmação é de permissão (`has_function_privilege`), não de exploração.

---

## 1. A causa raiz

O Supabase mantém `ALTER DEFAULT PRIVILEGES` no schema `public` concedendo `EXECUTE` a
`anon`, `authenticated` e `service_role` em **toda função nova**. Confirmado:

```
defaclrole      | schema | tipo     | acl_default
postgres        | public | FUNCTION | {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
supabase_admin  | public | FUNCTION | {postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}
```

Consequência: **toda função criada em `public` nasce chamável por qualquer portador da
`VITE_SUPABASE_ANON_KEY`** — que é pública no bundle do frontend, por design. O schema
`public` é o exposto ao PostgREST, então a função vira endpoint `POST /rest/v1/rpc/<nome>`.

A única proteção é o `revoke` explícito por função. E é aqui que estão os dois modos de falha.

## 2. Os dois modos de falha

### Modo A — nenhum `revoke` (a função nunca foi protegida)

ACL fica `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}`. A entrada
`=X/postgres` (grantee vazio) é o `PUBLIC`.

Atingidas: as 14 funções `trigger_*` de cron, `cleanup_processed_messages`,
`cleanup_webhook_executions`, `mark_outbox_done`, `mark_outbox_failed`.

### Modo B — `revoke ... from public` apenas (o insidioso)

ACL fica `{postgres=X, anon=X, authenticated=X, service_role=X}` — o `PUBLIC` sumiu, o `anon`
**ficou**.

`revoke ... from public` remove só a concessão ao pseudo-papel `PUBLIC`. As concessões a
`anon` e `authenticated` são **entradas próprias e explícitas**, vindas do
`ALTER DEFAULT PRIVILEGES` — sobrevivem intactas.

O resultado é pior que o Modo A: a migration *parece* ter protegido, o comentário na função
*afirma* que protegeu, e o `CLAUDE.md` documenta como protegida. Ninguém procura de novo.

Atingidas: `append_conversation_message`, `get_undelivered_notifications`,
`is_platform_admin`, `is_unit_member`, `is_org_member`, `unit_role`, `list_orphan_unit_assets`.

### O padrão correto (já usado no repo, comprovadamente eficaz)

```sql
revoke all on function public.<nome>(<args>) from public, anon, authenticated;
grant  execute on function public.<nome>(<args>) to <papel restrito>;
```

Verificado ao vivo: `resolve_or_activate_subscription` e `try_claim_conversation_for_ai`,
que usam essa forma, mostram `{postgres=X/postgres, service_role=X/postgres}` — limpas.
**A correção é conhecida e funciona neste banco; o que faltou foi aplicá-la em todo lugar.**

## 3. Achados, por exploitabilidade real

A distinção que importa não é o ACL — é se existe **guarda interna** na função. Várias têm, e
por isso o ACL errado não vira acesso.

### 3.1 Exploitável sem conhecimento nenhum (sem argumentos)

| Função | Efeito |
|---|---|
| 14 × `trigger_*()` | Dispara os workers fora de hora. `SECURITY DEFINER`: lê `internal_api_key` do Vault e chama a Edge Function sozinha — o `x-internal-key` não protege, é a própria função que o fornece. Corrida com o cron legítimo sobre `billing_subscriptions.status`/`suspended_at`; amplificação de custo e rate-limit contra a API do Asaas. |
| `cleanup_processed_messages()` | `delete from processed_messages`, sem guarda. |
| `cleanup_webhook_executions()` | `delete from webhook_executions`, sem guarda. |

Estas são chamáveis por qualquer pessoa, agora, sem saber nada sobre o sistema.

### 3.2 Escrita cross-tenant sem autorização, protegida só por UUID não-adivinhável

**`append_conversation_message(uuid, jsonb)` — o mais grave.**

A função **não tem guarda nenhuma**: valida o formato do JSONB e faz o `UPDATE`. Sem
`auth.uid()`, sem `is_unit_member`, sem nada. O `CLAUDE.md` a descreve como
"`SECURITY DEFINER`, só `service_role`", e o próprio comentário no banco diz
`service_role only` — mas o ACL mostra `anon=X`.

Quem tiver o UUID de uma conversa pode injetar mensagem arbitrária nela, em qualquer tenant,
escolhendo `role` (`user`/`assistant`/`human`) e conteúdo, e ainda mexe em `last_message_at`.

Mitigação real: UUID v4 não é adivinhável, e não achei caminho que os vaze (o
`get_public_tracking` usa id de reserva/fila, não de conversa). Mas isso é obscuridade, não
autorização — e a documentação afirma um controle que não existe.

Mesma categoria, menor impacto: `mark_outbox_done(uuid)` e `mark_outbox_failed(uuid, text)` —
marcar uma notificação pendente como concluída faria o cliente nunca receber a confirmação.

### 3.3 ACL errado, mas **defendido em profundidade** — não há acesso indevido

`get_undelivered_notifications(uuid, timestamptz)` tem guarda interna:

```sql
if not (is_unit_member(auth.uid(), p_unit_id) or is_platform_admin(auth.uid())) then
  raise exception 'forbidden' using errcode = '42501';
end if;
```

Para `anon`, `auth.uid()` é NULL, as duas checagens dão falso e a função levanta `forbidden`.
**O dado não vaza.** Corrigir o ACL continua certo (defesa em profundidade), mas não é urgente.

Este caso é a evidência de que o invariante do projeto — *"todo guard server-side precisa do
par `is_unit_member` / `is_platform_admin`"* — está fazendo exatamente o trabalho para o qual
existe.

### 3.4 Oráculo de enumeração — baixo

`is_platform_admin(uuid)`, `is_unit_member(uuid, uuid)`, `is_org_member(uuid, uuid)`,
`unit_role(uuid, uuid)` recebem o `user_id` por parâmetro em vez de lerem `auth.uid()`. Quem
tiver um UUID de usuário descobre se ele é super-admin ou membro de uma unidade. Requer
conhecer o UUID; não expõe dado de negócio.

### 3.5 Anon por desenho — nenhuma ação

`get_unit_public`, `get_unit_public_full`, `get_widget_public`, `get_menu_public`,
`get_public_tracking`, `get_public_business_hours`, `get_public_hall_schedules`,
`list_public_units`, `get_reservation_by_code`, `enter_waitlist`. São a superfície pública
prevista pelo `CLAUDE.md` ("anon lê só por RPCs `SECURITY DEFINER`"). Corretas.

## 4. O que a migration 084 resolve, e o que não

A 084 (escrita na Fase 5b) revoga de `public, anon, authenticated` em **todas as funções
`trigger_*` do schema `public`** — cobre inteiramente o item 3.1 quanto aos crons, e é segura:
verificado que os 14 jobs em `cron.job` rodam como `username = postgres`, que é também o dono
das funções, e o dono mantém `EXECUTE` implícito.

**Não cobre:** `cleanup_*`, `mark_outbox_*`, `append_conversation_message`, e os oráculos de
enumeração. Esses precisam de correção própria.

## 5. Correção proposta

Uma migration de hardening, **independente da Fase 5b**, que:

1. Aplique `revoke all ... from public, anon, authenticated` em toda função `SECURITY DEFINER`
   de `public` que **não** esteja na lista de superfície pública legítima (§3.5) — lista
   explícita e comentada, nunca inferida, porque errar para o lado do revoke derruba o portal
   público.
2. Conceda ao papel mínimo de cada uma: `service_role` para as consumidas por Edge Function,
   `authenticated` para as operator-facing, `postgres` para os wrappers de cron.
3. Acrescente guarda interna ao `append_conversation_message` — o ACL correto já resolve, mas
   uma função de escrita cross-tenant sem nenhuma checagem é frágil demais para depender de
   uma linha de `grant`. Defesa em profundidade, como o `get_undelivered_notifications` já faz.

**Não** tente resolver via `ALTER DEFAULT PRIVILEGES ... REVOKE` global: mudaria o
comportamento de toda função futura do projeto, incluindo as que precisam ser públicas, e o
efeito só apareceria na próxima migration — exatamente o tipo de armadilha silenciosa que este
documento existe para descrever.

## 6. Invariante para o `CLAUDE.md`

`revoke ... from public` **não** revoga de `anon`/`authenticated` no Supabase — sempre
`from public, anon, authenticated`, porque `ALTER DEFAULT PRIVILEGES` do schema `public`
concede a esses papéis por entrada própria, e um revoke parcial deixa a função exposta
parecendo protegida.

## 7. Como reverificar

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.proacl::text
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.prosecdef
   and has_function_privilege('anon', p.oid, 'EXECUTE')
 order by p.proname;
```

Esperado depois da correção: só as funções de §3.5.
