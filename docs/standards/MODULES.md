# Módulos: criação, evolução e remoção

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao criar módulo ou submódulo, ao mudar o contrato de um módulo existente ou ao desligar um. A skill `padrao-saas:novo-modulo` executa este procedimento.
> Complementa: ARCHITECTURE.md (estrutura interna), ACCESS_CONTROL.md (permissões), DATABASE.md (migrations).

## 1. O que é um módulo [N1]

Um módulo é uma área de negócio com dono claro (Financeiro, Estoque, Agenda). Ele tem submódulos (Contas a Pagar, Contas a Receber) e, para cada submódulo, um conjunto de ações. Essa árvore é exatamente o catálogo de permissões (ACCESS_CONTROL §2) e o que a empresa contrata (`company_modules`).

Cada módulo tem `docs/modules/<modulo>.md` (modelo em `docs/modules/_TEMPLATE.md`) com:

- responsabilidade e o que **não** é responsabilidade dele;
- submódulos e ações (as chaves de permissão);
- tabelas que possui, e se cada uma é da **empresa** ou da **filial**;
- invariantes (regras que o código não deixa óbvias);
- commands, queries e eventos publicados;
- integrações;
- dependências de outros módulos e o contrato usado (função, view, evento);
- flags e o estado do rollout.

Um módulo não lê nem escreve tabela de outro sem contrato explícito.

## 2. Criar módulo ou submódulo [N1]

Siga a ordem. Cada etapa termina validada antes da próxima.

1. **Escopo.** Escreva o doc do módulo com responsabilidade, submódulos, ações, tabelas (empresa ou filial) e invariantes. Confirme com o usuário as regras de negócio que não forem óbvias. Não invente regra.
2. **Catálogo.** Migration que insere módulo, submódulos e ações em `app_modules`/`permissions`, decide quais **papéis de sistema** recebem as novas chaves e gera de novo o tipo TypeScript das permissões. Sem isso, o módulo nasce invisível para todos.
3. **Dados.** Migrations das tabelas com coluna de tenant (e de filial), FK compostas, constraints, índices, RLS forçada e policies usando os helpers com a permissão `ver` do submódulo dono. Coluna de estado sem grant de update quando a transição é crítica.
4. **Testes de banco.** Isolamento entre empresas, entre filiais, por submódulo e por ação (ACCESS_CONTROL §10), em pgTAP ou contra o Supabase local.
5. **Casos de uso.** Commands com a ordem de ARCHITECTURE §5 e `can()` no início; queries com projeção, paginação e filtro pela empresa/filial ativa. Testes de unidade com portas falsas.
6. **Integrações**, se houver: INTEGRATIONS e o provider doc.
7. **Interface.** Rotas sob a empresa ativa, item de menu e botões guiados por `my_permissions`, formulário validado com o mesmo schema do servidor, e os quatro estados de toda tela: carregando, vazio, erro e **sem permissão**. Módulo não contratado aparece como tal, não como erro.
8. **Flag e rollout.** Módulo novo entra desligado por flag ou fora dos planos até ser validado; libera por empresa piloto e depois por plano.
9. **Documentação.** Doc do módulo atualizado; ADR para decisão que um agente futuro poderia desfazer.
10. **Encerramento.** Relatório de tarefa sensível (AGENTS.md §11) com a Definition of Done abaixo.

## 3. Alterar um módulo existente [N1]

- **Nova ação ou submódulo:** migration de catálogo + concessão aos papéis de sistema que devem recebê-la. Quem tem o módulo ou o submódulo inteiro recebe automaticamente; quem tem ações específicas não.
- **Renomear chave de permissão:** nunca renomeie em lugar. Crie a nova, migre as concessões (`role_permissions`, `member_permissions`, escopos de chaves de API), remova a antiga numa migration posterior.
- **Mudança de schema incompatível:** expand → backfill → contract (DATABASE §1).
- **Tabela que passa a ser por filial:** adicionar `location_id` com backfill decidido com o usuário (qual filial herda os registros existentes), FK composta e troca das policies, em migrations separadas.

## 4. Remover módulo ou submódulo [N2]

1. Desligue por flag e tire dos planos; avise as empresas que usam.
2. Ofereça exportação dos dados do módulo.
3. Pare jobs, cron, webhooks recebidos e enviados, e revogue integrações do módulo.
4. Remova rotas, menu e casos de uso.
5. Remova concessões e chaves do catálogo.
6. Arquive ou apague dados conforme a retenção (DATABASE §10), com backup antes.
7. Remova as tabelas numa migration final, depois de um ciclo sem uso.

## 5. Definition of Done do módulo

Marque cada item como APLICÁVEL, NÃO APLICÁVEL (com justificativa) ou PENDENTE:

- [ ] doc do módulo com responsabilidade, árvore de permissões, tabelas (empresa/filial) e invariantes
- [ ] catálogo de permissões na migration; papéis de sistema atualizados; tipo TS gerado
- [ ] tabelas com coluna de tenant, filial quando aplicável, FK compostas e RLS forçada
- [ ] transições críticas sem update direto; RPC/caso de uso com a ação
- [ ] testes de isolamento (empresa, filial, submódulo, ação) passando
- [ ] casos de uso com `can()`, validação em runtime e erros classificados
- [ ] queries filtrando pela empresa/filial ativa; chaves de cache com `company_id`
- [ ] tela chama só o adapter do módulo; `check-portabilidade` sem dívida nova
- [ ] UI com os quatro estados, menu por `my_permissions`, módulo não contratado tratado
- [ ] integrações com a DoD de INTEGRATIONS §19
- [ ] flag/rollout definidos
- [ ] auditoria das ações sensíveis
- [ ] comandos oficiais (lint, typecheck, testes, build) executados

## Particularidades deste projeto

- Não há catálogo de módulos/submódulos nem permissões por módulo: o acesso é por papel fixo na unidade (ver ACCESS_CONTROL, Particularidades). A árvore de módulos do produto ainda não foi confirmada; não crie catálogo sem essa confirmação.
