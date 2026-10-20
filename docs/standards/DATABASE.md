# Banco de dados

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao criar ou alterar migration, policy, função/RPC, view, índice, query pesada, backup ou operação em produção.
> Complementa: MULTI_TENANCY.md (RLS e FK composta), SECURITY.md §5 (bloqueio de escrita direta).

## 1. Migrations

**[N1] Regras gerais:**

- Forward-only. Nunca edite migration já aplicada em qualquer ambiente compartilhado; crie outra.
- Uma preocupação por migration, com nome descritivo.
- Toda tabela nova em schema exposto recebe, **na mesma migration**: RLS habilitada **e forçada** (`force row level security`), policies e revisão de grants. No Supabase, `anon` e `authenticated` costumam receber privilégios padrão nas tabelas de `public`, então a proteção depende de RLS e grants corretos. Confira os grants reais; não presuma.
- Mudança incompatível segue expand → backfill → contract, em deploys separados, para que código antigo e novo convivam.
- Nada de destruir dados silenciosamente. `drop` e `delete` em massa exigem plano, backup e autorização.

**[N1] Antes de aplicar em produção:**

- Avalie locks e duração em tabelas grandes. Índices com `concurrently` não rodam dentro de transação: verifique como a ferramenta de migration executa.
- Lembre que rollback de deploy **não** reverte migration. Tenha roll-forward ou script de reversão testado.

**[N1] Depois de aplicar localmente:**

- Rode os Advisors/lint de segurança e desempenho do Supabase e trate os achados novos.

## 2. Integridade [N1]

Prefira garantias no banco:

- FK (composta quando a relação é dentro do tenant — MULTI_TENANCY §5);
- `unique`, `check`, `not null`;
- enum ou tabela de controle;
- chaves de idempotência únicas.

Validação só no frontend não é integridade.

## 3. Transações e concorrência [N1]

Invariantes que dependem do estado atual (saldo, estoque, limite, status, vagas) são garantidas **na mesma transação** da mutação. Escolha o mecanismo pelo caso:

| Mecanismo | Quando |
|---|---|
| Escrita condicional (`update … where stock >= $qty`) | Decremento/limite simples; é o mais barato |
| `unique` / `check` / exclusion constraint | Regra expressável como restrição |
| `select … for update` | Ler e decidir sobre a mesma linha antes de gravar |
| Coluna `version` (concorrência otimista) | Edição de documento/registro por usuários |
| Isolamento `serializable` | Regras sobre conjuntos de linhas; trate o erro `40001` com retry |

Verificar em uma requisição e gravar em outra não protege: duas requisições simultâneas passam pela verificação e ambas gravam.

## 4. Operações atômicas no Supabase [N1]

O `supabase-js` não mantém transação entre chamadas. Operação de vários passos vira função Postgres. Escolha **um** de dois modelos e registre em "Particularidades":

- **A — servidor chama com service role.** O caso de uso no servidor autentica, resolve o tenant e autoriza. Depois chama a função passando o `company_id` resolvido. `execute` fica revogado de `anon` e `authenticated`.
- **B — usuário chama direto.** A função é `security definer`, verifica membership e permissão internamente via `private.current_user_id()` e ignora qualquer `company_id` que não pertença ao usuário.

Exemplo do modelo A, com idempotência, invariante e outbox na mesma transação:

```sql
create or replace function public.baixar_estoque(
  p_company_id   uuid,
  p_product_id   uuid,
  p_qty          integer,
  p_operation_id uuid,
  p_request_hash text
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.idempotency_keys (company_id, operation_id, operation, request_hash)
  values (p_company_id, p_operation_id, 'estoque.baixar', p_request_hash)
  on conflict (company_id, operation_id) do nothing;

  if not found then
    perform 1 from public.idempotency_keys
     where company_id = p_company_id
       and operation_id = p_operation_id
       and request_hash = p_request_hash;
    if not found then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001';  -- mesma chave, payload diferente
    end if;
    return 'already_processed';  -- em produção, devolva o resultado original guardado na chave (coluna response)
  end if;

  update public.products
     set stock = stock - p_qty
   where id = p_product_id
     and company_id = p_company_id
     and stock >= p_qty;
  if not found then
    raise exception 'ESTOQUE_INSUFICIENTE' using errcode = 'P0001';     -- desfaz tudo, inclusive a chave
  end if;

  insert into public.outbox (company_id, operation_id, event_type, payload)
  values (p_company_id, p_operation_id, 'estoque.baixado.v1',
          jsonb_build_object('product_id', p_product_id, 'qty', p_qty));

  return 'ok';
end;
$$;

revoke execute on function public.baixar_estoque(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
```

É um exemplo ilustrativo: adapte nomes, tipos e o retorno ao esquema real.

## 5. Armadilhas do Supabase/Postgres que vazam dados [N1]

- **View** em schema exposto sem `with (security_invoker = true)` executa com os privilégios do dono e **ignora a RLS** de quem consulta.
- **Função `security definer`** precisa de:
  - `set search_path = ''` e nomes qualificados (`public.tabela`);
  - checagem de tenant interna;
  - ficar fora de schema exposto, salvo intenção explícita.
- **Funções novas** recebem `execute` para `PUBLIC` por padrão. Revogue (`revoke execute … from public, anon, authenticated`) e conceda só a quem deve chamar.
- **Policies** usam `(select private.current_user_id())`, dentro de `(select …)` para avaliar uma vez por consulta e não por linha. Nunca `auth.uid()` direto: só o adapter de identidade conhece o provedor (GCP_MIGRATION §2). Indexe as colunas usadas.
- **Default privileges do Supabase** dão todos os privilégios em tabela, função e sequence novas de `public` para `anon` e `authenticated`. Na mesma migration, revogue tudo (`revoke all … from anon, authenticated`) e conceda só o necessário. Assim a tabela fica correta no Supabase e num Postgres sem esses defaults.
- **Checagens de FK, unique e PK ignoram RLS.** Use FK composta para manter o tenant e não confie em RLS para impedir referência cruzada.
- **Tabela sem RLS** em schema exposto está pública para quem tem a anon key.
- **`force row level security`** faz a RLS valer também para o dono da tabela. Os helpers `security definer` dependem de o dono das funções ter `BYPASSRLS` (no Supabase, o papel `postgres` tem). Confira com `select rolname, rolbypassrls from pg_roles where rolname = current_user;` antes de forçar nas tabelas de membership e permissões: sem `BYPASSRLS`, os helpers passam pela RLS dessas tabelas e as policies entram em recursão.

## 6. Desempenho de queries

**[N1]** Antes de criar índice, identifique:

- a query e a frequência;
- o volume e o plano (`explain analyze` em ambiente seguro);
- a seletividade;
- o custo de escrita;
- a interação com RLS e a ordenação.

Não indexe tudo.

**[N1]** Boas práticas:

- projeção explícita;
- paginação por cursor em conjuntos grandes;
- agregação no banco;
- limite máximo por query.

**[N1]** Em serverless, conecte pelo pooler (Supavisor) em modo transação. Nesse modo não há prepared statements persistentes; configure o driver de acordo.

**[N2]** Monitore as queries mais lentas e o uso de conexões.

## 7. Dinheiro, datas e precisão [N1]

- Valores monetários em `numeric(…)` ou inteiro em centavos. Nunca `float`/`real`.
- Regra de arredondamento documentada e aplicada num único lugar.
- Datas em `timestamptz`. O fuso de negócio (ex.: `America/Sao_Paulo`) é explícito nos cálculos de dia, mês e competência.
- Competência e caixa são distinguidos quando o domínio exige.
- Lançamento confirmado não é apagado nem editado: corrige-se por estorno. Trilha de auditoria preservada.
- Cálculos críticos no servidor, testados com exemplos reais.

## 8. Backup e recuperação

**[N1]**

- Backups automáticos ativos.
- Backup ou snapshot antes de qualquer operação de risco.
- **O backup do banco não inclui os objetos do Supabase Storage.** Arquivos precisam de estratégia própria.

**[N2]** Defina e registre em `docs/runbooks/RECOVERY.md`:

| Item | Exemplo de decisão |
|---|---|
| Escopo | banco, objetos do Storage, configuração de Auth, secrets, Edge Functions (código no Git) |
| RPO (perda máxima aceitável) | ex.: 5 min com PITR; 24 h sem |
| RTO (tempo para voltar) | ex.: 2 h |
| Retenção | ex.: 7 / 30 dias |
| Procedimento | passo a passo executável, com comandos |
| Verificação | restaurar em ambiente isolado e conferir dados, arquivos e integrações |

**[N2]** Teste a restauração conforme a criticidade e após mudanças relevantes de esquema ou de infraestrutura. Backup nunca restaurado é hipótese.

## 9. Produção [N1]

- Durante auditoria, produção é somente leitura.
- Antes de qualquer alteração em produção, confirme:
  - ambiente correto;
  - backup;
  - impacto de lock e duração;
  - compatibilidade com o código em execução;
  - plano de roll-forward/reversão;
  - observabilidade;
  - **autorização explícita**.

## 10. Retenção e limpeza [N1]

Tabelas técnicas crescem para sempre se ninguém apagar. Cada uma tem prazo e um job de limpeza (pg_cron ou o runner do projeto), idempotente e em lotes pequenos:

| Tabela | Retenção típica (ajuste em "Particularidades") |
|---|---|
| `idempotency_keys` | 30 dias após a operação, ou o prazo de repetição do provedor |
| outbox processada | 30 dias |
| inbox de webhooks processados (payload) | 30–90 dias; o registro de dedup pode ficar mais, sem payload |
| dead-letter | até ser resolvida; alerta acima de N itens |
| convites expirados, sessões de exportação | 7 dias |
| logs e auditoria técnica | conforme SECURITY §10 e obrigação legal |

O audit log de negócio **não** entra nesta limpeza: segue a retenção decidida para ele. A limpeza não apaga linha ainda referenciada por processamento pendente.

## Particularidades deste projeto

- Migration só por `supabase db push`, nunca SQL colado no Studio. Função nova revoga `EXECUTE` de `public, anon, authenticated`; o CI `acl-estatico` confere contra `scripts/function-acl-allowlist.json`.
- Helpers de RLS em `app_private` (schema não exposto). Tabelas de credenciais, filas e ledgers: RLS sem policy, acesso só por service role filtrando o tenant.
- Migrations legadas que embutem a URL do projeto estão numa allowlist fechada (`scripts/migration-static-guard.test.ts`); migration nova nunca embute URL nem segredo.
- Extensões: `pg_cron`, `pg_net`, `supabase_vault`, `pgcrypto`, `btree_gist`, `uuid-ossp`, `pg_stat_statements`.
- RPO/RTO e PITR: não definidos/verificados.
- Detalhe: `.claude/rules/banco-de-dados.md`.
