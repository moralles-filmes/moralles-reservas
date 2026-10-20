# Controle de acesso: empresas, filiais, papéis e permissões por módulo

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao criar módulo, tela, rota, RPC ou policy; ao mexer em convites, papéis, permissões, filiais ou planos.
> Complementa: MULTI_TENANCY.md (isolamento entre empresas), SECURITY.md (autenticação), TENANT_LIFECYCLE.md (planos e status da empresa).
> Níveis: [N1] base · [N2] operação crítica · [N3] escala (ver AGENTS.md §5).

## 1. Modelo [N1]

```text
Plataforma
└── Empresa (tenant, company_id)          ← o cliente que assina o SaaS
    ├── Filial (location_id)              ← opcional; dados operacionais por unidade
    └── Membros (usuário ↔ empresa, N:N)  ← o mesmo usuário pode estar em várias empresas
        ├── Papéis (por empresa, opcionalmente limitados a filiais)
        └── Concessões diretas (por empresa, opcionalmente limitadas a filiais)
```

- O papel e as permissões do usuário valem **por empresa**. Admin na empresa A e operador na B é o caso normal.
- Tabelas canônicas: `companies`, `locations`, `company_members`, `roles`, `role_permissions`, `member_roles`, `member_permissions`, `permissions`, `app_modules`, `company_modules`, `platform_admins`. Nomes reais do projeto ficam em `.claude/tenancy-profile.yml`.
- Dado da **empresa** (cadastros compartilhados, configurações) tem `company_id`. Dado da **filial** (pedidos, caixa, estoque, contas) tem `company_id` **e** `location_id`.
- Projeto sem filiais declara `locations.enabled: false` no profile e ignora as partes de filial deste documento.

## 2. Chaves de permissão [N1]

Formato: `<modulo>.<submodulo>.<acao>` — `financeiro.contas_pagar.baixar`.

- O primeiro segmento é sempre o módulo; o último é sempre a ação. Módulo sem submódulo usa `<modulo>.<acao>`.
- Minúsculas, `snake_case`, sem acento.
- Ações padrão, reutilize antes de inventar:

| Ação | Significado |
|---|---|
| `ver` | listar e abrir |
| `criar` | lançar novo registro |
| `editar` | alterar registro aberto |
| `excluir` | remover (raro; prefira cancelar ou estornar) |
| `aprovar` | aprovar ou rejeitar |
| `baixar` · `estornar` · `cancelar` | transições de estado de negócio |
| `exportar` | gerar arquivo ou relatório com dados em volume |

- **Fonte única: o catálogo no banco**, escrito só por migration (`permissions` e `app_modules`). O tipo TypeScript com a união das chaves é **gerado** a partir dele, e o CI acusa quando está desatualizado. Nunca escreva uma chave à mão no código sem ela existir no catálogo.

## 3. Concessões [N1]

Uma concessão é um **padrão**:

| Padrão | Dá acesso a |
|---|---|
| `*` | tudo dos módulos contratados (só em papel; nunca concessão direta) |
| `financeiro` | todo o módulo, inclusive submódulos criados no futuro |
| `financeiro.contas_pagar` | todas as ações de contas a pagar |
| `financeiro.contas_pagar.ver` | só ver contas a pagar |

Regras:

- **Qualquer ação de um submódulo implica `ver` desse submódulo.** Quem pode editar precisa enxergar o que edita.
- **Concessões só somam.** Não existe negação: ela cria regras de precedência difíceis de auditar. Para restringir, conceda menos.
- **Escopo de filial:** `location_id` nulo = todas as filiais da empresa, inclusive as criadas depois. Preenchido = só aquela filial.
- **Proprietário** (`company_members.is_owner`) equivale a `*` nos módulos contratados.
- **Papéis de sistema** (`roles.company_id` nulo) são mantidos por migration e valem para todas as empresas. A empresa pode criar papéis próprios.
- O banco rejeita concessão que não corresponde a nenhuma chave do catálogo. Concessão com erro de digitação não daria acesso nenhum e passaria despercebida.

## 4. Avaliação [N1]

Um usuário tem a permissão `P` na empresa `E` (e filial `F`) quando **todas** as condições valem, nesta ordem:

1. membership ativa em `E`;
2. `E` com status `active` — em `read_only`, só ações `ver` e `exportar`; em `suspended` ou `canceled`, nada;
3. o módulo de `P` contratado por `E` (`company_modules`);
4. a filial `F`, quando houver, ativa;
5. alguma concessão (de papel, direta ou de proprietário) casa com `P` no escopo de `F`.

A mesma semântica existe em dois lugares, e os dois precisam concordar:

- **No banco:** `private.grants_for`, `private.allowed_company_ids` e `private.allowed_location_ids`.
- **No servidor:** o `TenantContext` carrega as permissões efetivas (`public.my_permissions(company_id)`) uma vez por requisição, e `can(ctx, P, locationId?)` é uma função pura sobre essa lista. Não reimplemente a regra de casamento em outro lugar.

## 5. Onde a permissão é verificada [N1]

| Camada | Como |
|---|---|
| Banco — tabela da empresa | `using (company_id in (select private.allowed_company_ids('<modulo>.<sub>.ver')))` |
| Banco — tabela da filial | `using (location_id in (select private.allowed_location_ids('<modulo>.<sub>.ver')))`; a FK composta `(company_id, location_id)` amarra a empresa |
| Banco — cadastro compartilhado | alteração exige concessão para a empresa inteira: `allowed_company_ids('…editar', true)` |
| Banco — transição crítica | coluna de estado sem grant de update; a mudança passa por RPC ou caso de uso que confere a ação (`…baixar`) |
| Servidor | o caso de uso chama `can()` antes de abrir a transação (ARCHITECTURE §5) |
| Interface | menu, rotas e botões a partir de `my_permissions` — **só UX** |
| Jobs e webhooks | revalidam, na execução, a permissão de quem originou a ação |

- Chame os helpers sempre dentro de `(select …)` na policy: assim o Postgres avalia uma vez por consulta, não por linha.
- Toda policy de leitura de módulo usa a permissão `ver` do submódulo dono da tabela. Uma tabela pertence a um submódulo; tabela compartilhada entre submódulos é sinal de que ela pertence a um cadastro da empresa.

## 6. Administração de acessos — anti-escalada [N1]

As tabelas de acesso não aceitam escrita direta do cliente (o banco bloqueia). Toda mudança passa por um caso de uso no servidor que garante:

- quem altera tem `configuracoes.usuarios.editar` na empresa;
- só se concede o que **quem concede possui**, no mesmo escopo de filial ou menor. O proprietário concede qualquer permissão dos módulos contratados;
- ninguém altera os **próprios** acessos;
- só proprietário promove ou remove proprietário, e a empresa **nunca fica sem proprietário ativo**;
- papel da empresa usa apenas chaves do catálogo; papel de sistema só muda por migration;
- convite cria membership `invited`, que só vira `active` quando o convidado aceita com a conta autenticada;
- toda mudança grava o audit log com quem, o quê, escopo e antes/depois;
- remover acesso vale na **próxima requisição**. Os helpers leem o banco a cada consulta; nenhum cache de permissão sobrevive além da requisição sem invalidação explícita.

## 7. Empresa ativa e filial ativa [N1]

- A empresa ativa vai na **URL**: `/app/[empresa]/…` (Next) ou `/:empresa/…` (React Router). Trocar de empresa é navegar; duas abas em empresas diferentes funcionam.
- A filial vai na URL quando a tela opera numa filial específica (PDV, caixa). Telas consolidadas listam as filiais permitidas e filtram por elas.
- O servidor resolve o slug para `company_id` e confere a membership a cada requisição. O slug só **indica**; quem concede é a membership.
- **A RLS é a cerca; o filtro é o foco.** A RLS libera tudo o que o usuário pode ver em **todas** as empresas dele. Toda query de tela filtra pela empresa ativa (e pela filial, quando aplicável). Esquecer o filtro mistura dados de duas empresas do mesmo usuário: não é vazamento para estranho, mas é dado errado na tela e no relatório.
- Chaves de cache (TanStack Query, cache de servidor) começam por `company_id`. Trocar de empresa ou fazer logout descarta o cache privado.

## 8. Módulos contratados [N1]

- `company_modules` diz o que a empresa contratou. Sem o módulo, ninguém da empresa acessa, nem o proprietário. A interface mostra o módulo como "não contratado", não como erro.
- O provisionamento habilita os módulos base (ex.: `configuracoes`). A cobrança liga e desliga os demais (TENANT_LIFECYCLE §3).
- Limites quantitativos do plano (filiais, usuários, mensagens) são verificados no caso de uso que cria o recurso, dentro da transação. Esconder o botão não é limite.

## 9. Implementação de referência

A skill `padrao-saas:aplicar` traz em `templates/sql/`:

- `00_identidade_supabase.sql` ou `00_identidade_postgres.sql` — adapter de identidade: `private.current_user_id()` e, no Supabase, o espelho `auth.users` → `public.app_users`. É o único arquivo que muda ao sair do Supabase Auth;
- `01_modelo_de_acesso.sql` — usuários da aplicação (`app_users`), tabelas, validações, helpers, RLS, grants e seed de exemplo, sem referência ao schema `auth`;
- `02_exemplo_modulo_financeiro.sql` — tabela da empresa, tabela da filial e transição crítica por RPC;
- `03_modelo_de_acesso.test.sql` — 33 cenários em pgTAP, que passam nos dois adapters;
- `04_identidade_supabase.test.sql` — o espelho de usuários do adapter Supabase.

Adapte nomes ao projeto; não aplique em massa num projeto existente (DATABASE §1). Projeto com FKs para `auth.users`: crie `public.app_users`, faça o backfill (comentado no `00_identidade_supabase.sql`) e troque as FKs em migrations expand → contract.

## 10. Testes obrigatórios [N1]

Além da matriz de MULTI_TENANCY §7:

| Cenário | Esperado |
|---|---|
| Usuário com acesso só a um submódulo lê outro submódulo do mesmo módulo | Negado |
| Usuário com acesso só à filial F1 lê ou grava na F2 | Negado |
| Usuário com acesso à filial F1 altera cadastro compartilhado da empresa | Negado |
| Concessão só de `editar` permite ver | Permitido |
| Empresa sem o módulo contratado, inclusive para o proprietário | Negado |
| Empresa em `read_only`: ler / gravar | Permitido / Negado |
| Membership desativada | Acesso perdido na próxima requisição |
| Filial desativada | Concessões dela deixam de valer |
| Usuário altera as próprias permissões, direto no banco ou pelo caso de uso | Negado |
| Usuário concede permissão que não tem | Negado |
| Remover o último proprietário | Negado |
| Concessão com chave inexistente | Rejeitada pelo banco |
| Transição crítica por update direto | Negado; só pelo RPC/caso de uso com a ação |

## Particularidades deste projeto

- Modelo atual (desvio do §1–§5, arquétipo B): papel enum por unidade em `unit_members.role` — `owner` > `gerente` > `operador`; leitura por `public.unit_role`. Sem `permissions`, `roles`, `member_permissions` nem `company_modules`.
- Owner cria unidades e tem tudo; gerente configura, gerencia membros e dados, sem automação; operador atua em reservas, fila e passantes e não cancela reserva (trigger + gate na EF).
- Módulos contratados: entitlements por organização e por feature (system/whatsapp/ai) em `supabase/functions/_shared/entitlements.ts` (ver `.claude/rules/billing.md`).
- Membros: Edge Function `manage-members`. Super-admin em `platform_admins`; `admin_users`/`manage-admins` foram removidos e não voltam.
- Migração para o modelo de permissões deste padrão exige ADR e plano expand → backfill → contract.
