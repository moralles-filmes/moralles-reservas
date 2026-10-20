# Módulo: {{Nome}}

> Modelo de MODULES.md §1. Registre só o que foi confirmado. Copie para `docs/modules/<modulo>.md`.

- Chave do módulo: `{{financeiro}}`
- Status: {{em construção | em rollout (empresas piloto) | ativo | em remoção}}
- Flag: `{{nome da flag}}` — planos que incluem: {{...}}

## Responsabilidade

- Faz: {{...}}
- Não faz (pertence a outro módulo): {{...}}

## Submódulos e permissões

| Submódulo | Ações (`<modulo>.<submodulo>.<acao>`) | Escopo |
|---|---|---|
| {{contas_pagar}} | {{ver, criar, editar, baixar, exportar}} | {{filial}} |

Papéis de sistema que recebem: {{administrador: tudo; financeiro: módulo inteiro}}

## Tabelas

| Tabela | Da empresa ou da filial | Observação |
|---|---|---|
| `{{bills}}` | {{filial}} | {{status só muda por RPC baixar_conta_pagar}} |

## Invariantes

- {{ex.: conta baixada não é editada; correção por estorno}}

## Commands, queries e eventos

- Commands: {{...}}
- Queries: {{...}}
- Eventos publicados: {{`financeiro.conta_baixada.v1`}}

## Integrações

- {{provedor → docs/integrations/providers/<p>.md}}

## Dependências

- {{módulo → contrato usado (função, view, evento)}}

## Decisões

- {{link para ADR}}
