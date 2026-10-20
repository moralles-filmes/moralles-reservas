# Multi-tenancy

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao tocar dados de mais de uma empresa, RLS, membership, cache, jobs, webhooks ou tools que agem em nome de um tenant.
> Permissões por módulo, papéis e filiais: ACCESS_CONTROL.md.

## 1. Declaração do modelo [N1]

- **Tenant** é a empresa cliente do SaaS. **Filial**, quando existir, é uma dimensão abaixo do tenant, com permissões próprias.
- O modelo de cada projeto é declarado em **`.claude/tenancy-profile.yml`**. Ele é a fonte única para agentes e para os plugins (saas-shield-br, saas-builder-br, saas-audit-br): coluna(s) de tenant, coluna de filial, função de resolução, caminho de escrita, tabelas de membership e de permissões.
- **Projeto novo** usa o modelo padrão (arquétipo E): `company_id` + `location_id`, membership consultada no banco (o resolver devolve o **conjunto** de empresas do usuário) e permissões por módulo (ACCESS_CONTROL).
- **Projeto existente** mantém o arquétipo que já usa (A–D do saas-shield-br) e o declara no profile. Migrar de arquétipo é um projeto com ADR e plano expand → backfill → contract, nunca efeito colateral de outra tarefa.
- Não crie `tenant_id` num banco que usa `company_id`, nem o contrário. Use o nome declarado.
- Entidades globais (catálogo da plataforma, planos) não têm coluna de tenant e estão listadas em "Particularidades".

## 2. Contexto de tenant [N1]

```ts
interface TenantContext {
  userId: string;
  companyId: string;              // empresa ativa (da URL), confirmada pela membership
  activeLocationId?: string;      // filial ativa, quando a tela opera numa filial
  permissions: Grant[];           // permissões efetivas (ACCESS_CONTROL §4)
  requestId: string;
}
```

O contexto só é criado depois de:

1. validar o token (assinatura, issuer, audience, expiração);
2. confirmar membership **ativa** do usuário na empresa indicada;
3. confirmar o status da empresa (ACCESS_CONTROL §4);
4. carregar as permissões efetivas e as filiais permitidas.

O cliente pode **indicar** a empresa e a filial (pela URL). O servidor confirma; a indicação nunca concede acesso. Não guarde a empresa ativa em claim do JWT: o mesmo usuário opera várias empresas, às vezes em abas diferentes, e a claim fica velha até o refresh.

## 3. Entrada não confiável [N1]

Vindos do cliente, estes campos nunca são usados sem validação independente:

- coluna de tenant e de filial (`company_id`, `location_id`), `user_id`;
- `role`, `permission`, `is_owner`;
- `price`, `total`, `status`, `owner`.

Em payload de webhook ou argumento de tool MCP, o tenant **nunca** é lido do conteúdo. Ele vem da conexão vinculada à conta externa ou da identidade autenticada.

## 4. RLS no Supabase [N1]

- RLS habilitada **e forçada** (`force row level security`) em toda tabela com dado de tenant em schema exposto. Antes de forçar nas tabelas lidas pelos helpers, confirme que o dono das funções tem `BYPASSRLS` (DATABASE §5).
- Deny-by-default: nenhuma policy `using (true)` em tabela com dado de tenant.
- Policies separadas por operação. Insert e update usam `with check`.
- Os helpers ficam fora do schema exposto (`private`), são `stable`, `security definer`, com `set search_path = ''`, e são chamados dentro de `(select …)` para serem avaliados uma vez por consulta.

No modelo padrão:

```sql
-- tabela da empresa
create policy suppliers_select on public.suppliers for select to authenticated
  using (company_id in (select private.allowed_company_ids('financeiro.fornecedores.ver')));

-- tabela da filial
create policy bills_select on public.bills for select to authenticated
  using (location_id in (select private.allowed_location_ids('financeiro.contas_pagar.ver')));
```

Implementação completa, testada: templates da skill `padrao-saas:aplicar` (ACCESS_CONTROL §9). Nos arquétipos A–D, use o resolver declarado no profile.

## 5. Integridade entre tenants [N1]

Uma FK simples garante que o registro referenciado **existe**, não que é **da mesma empresa**. E as checagens de integridade referencial ignoram RLS. Sem proteção, uma conta da empresa A pode apontar para um fornecedor ou uma filial da empresa B.

Em relações que precisam ficar dentro do tenant, use FK composta:

```sql
alter table public.suppliers add constraint suppliers_company_id_id_key unique (company_id, id);

alter table public.bills
  add constraint bills_supplier_same_company
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  add constraint bills_location_same_company
  foreign key (company_id, location_id) references public.locations (company_id, id);
```

Isso exige a chave única correspondente na tabela referenciada. Em projeto existente, é migration planejada (checar órfãos antes), não aplicação em massa. Exceções legítimas (referência a entidade global) ficam em "Particularidades".

## 6. Onde o tenant precisa estar [N1]

| Superfície | Regra |
|---|---|
| SELECT, INSERT, UPDATE, DELETE, RPC, views, funções | RLS e/ou filtro explícito; views com `security_invoker` |
| Telas e queries da aplicação | Filtro pela empresa ativa (e filial ativa) — a RLS é a cerca, o filtro é o foco (ACCESS_CONTROL §7) |
| URL | Empresa ativa no path; o servidor confirma a membership |
| Storage | Path `company_id/...` (e `location_id/` quando o arquivo é da filial); policy por membership e permissão |
| Realtime | Canais privados por empresa; assinaturas respeitam RLS |
| Cache | Chave começa por `company_id` (e usuário/permissão quando o conteúdo varia); troca de empresa ou logout descarta |
| Filas e jobs | Payload carrega `company_id`; o worker revalida tenant e permissão na execução |
| Webhooks | Conta externa → conexão → `company_id` |
| Exportações e relatórios | Filtro de tenant **e** permissão `exportar`; limite de volume |
| Logs | `company_id` controlado; nunca dados de outro tenant no mesmo registro |
| Integrações e MCP | Tenant resolvido pelo servidor a cada chamada |

## 7. Testes de isolamento [N1]

Os testes verificam o bloqueio **sem autorização** e também o **acesso legítimo**. Bloquear tudo também é bug.

| Cenário | Esperado |
|---|---|
| Usuário da empresa X lê/altera registro da empresa Y | Negado |
| Usuário em X **e** Y, navegando em X: listas, totais e exportações | Nenhuma linha de Y |
| Usuário da empresa X **sem** a permissão executa a ação | Negado |
| Usuário da empresa X **com** a permissão executa a ação | Permitido |
| Usuário restrito à filial F1 acessa F2 | Negado |
| Id de outro tenant manipulado no body ou na URL | Negado, sem vazar existência |
| `update` direto via PostgREST com JWT de usuário em tabela protegida | Negado |
| Insert com FK apontando para registro ou filial de outro tenant | Rejeitado pelo banco |
| Membership removida com cache aquecido | Acesso perdido na próxima requisição |
| Logout / troca de empresa | Nenhum dado anterior servido do cache |
| Job enfileirado para X | Executa apenas sobre X |
| Webhook de conta vinculada a X | Não afeta Y |
| Tool MCP com argumento tentando trocar de empresa | Ignorado ou negado |
| Caminho com service role | Filtra a coluna de tenant explicitamente |

Rode contra Supabase local (`supabase start`) com usuários reais de teste e seus JWTs, ou com pgTAP. Esses testes ficam no CI (TESTING §5). Os cenários de módulo e filial estão em ACCESS_CONTROL §10.

## Particularidades deste projeto

- Arquétipo B: `organizations` → `units` → `unit_members`. Dado operacional leva `unit_id`; `customers` e a conta WABA pertencem à organização (`organization_id`).
- Resolver: `app_private.is_unit_member(p_user_id, p_unit_id)`, `app_private.is_org_member`, `app_private.is_platform_admin`; toda policy/guard por unidade tem o paralelo de super-admin.
- Unidade ativa vem da URL (`/g/:unitSlug`, `/o/:unitSlug`), resolvida contra as memberships no cliente; o servidor revalida pelo próprio recurso, nunca por id enviado pelo caller.
- FKs entre tabelas da mesma unidade são majoritariamente simples (sem a coluna de tenant); a consistência vem de guards em trigger/RPC/EF. FK composta entra no plano por tabela, não em massa.
