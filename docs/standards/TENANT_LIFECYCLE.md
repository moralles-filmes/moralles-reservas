# Ciclo de vida da empresa e cobrança

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao tocar cadastro de empresa, convites, planos, cobrança da assinatura, suspensão, cancelamento, exportação ou exclusão de dados de um cliente.
> Complementa: ACCESS_CONTROL.md (status e módulos contratados), INTEGRATIONS.md (gateway de pagamento), SECURITY.md §10 (LGPD).

## 1. Estados da empresa [N1]

```text
trial → active ⇄ read_only → suspended → canceled → excluída
```

| Status | Acesso | Quem muda |
|---|---|---|
| `active` | normal | provisionamento, pagamento confirmado |
| `read_only` | ler e exportar; nada grava | inadimplência após a carência |
| `suspended` | nenhum dado; só a tela de regularização | inadimplência prolongada, decisão administrativa |
| `canceled` | nenhum dado; exportação final disponível até o prazo | pedido do cliente ou fim da suspensão |

- O trial é um `active` com data de fim e limites próprios; ao acabar sem pagamento, segue a mesma régua da inadimplência.
- A transição de status é um caso de uso auditado, nunca update solto. Cada transição registra motivo, autor (usuário, plataforma ou webhook) e data.
- A régua (dias de carência, de `read_only`, de suspensão, prazo de retenção após o cancelamento) fica em "Particularidades" e é aplicada por job, não por verificação ad hoc na tela.
- Suspensão gradual existe para proteger o cliente: ele precisa conseguir **ver e exportar** antes de perder o acesso.

## 2. Provisionamento [N1]

Criar uma empresa é **uma transação** (RPC chamada pelo servidor):

1. empresa com `slug` único;
2. membership do criador como proprietário ativo;
3. filial inicial, quando o produto usa filiais;
4. módulos base e os do plano em `company_modules`;
5. dados iniciais do produto (categorias padrão, configurações);
6. auditoria.

Falhou um passo, nada fica. Idempotente pela chave do fluxo de cadastro: repetir o envio não cria duas empresas.

## 3. Planos e cobrança da assinatura [N1 quando o SaaS cobra]

- O plano define **módulos** e **limites** (filiais, usuários, mensagens/mês, armazenamento). Ficam em tabela, versionados: mudar o preço de um plano não altera o contrato de quem já assinou.
- Limites são verificados no caso de uso que cria o recurso, dentro da transação (ACCESS_CONTROL §8). Uso medido (mensagens, chamadas de IA) é contado por empresa e período.
- O gateway (Asaas, Stripe, Pagar.me, Mercado Pago…) é uma integração como outra: porta + adapter, webhook com autenticidade e dedup, idempotência, reconciliação (INTEGRATIONS).
- **O webhook do gateway informa um fato**; a mudança de status da empresa é feita pelo caso de uso, que confere o estado no gateway antes de suspender ou reativar.
- Upgrade libera na hora; downgrade vale no próximo ciclo e, se o uso atual excede o novo limite, bloqueia a **criação** de novos recursos sem apagar os existentes.
- Nota fiscal de serviço é emitida por integração própria, com o mesmo rigor de efeito externo. Nota emitida não é alterada; corrige-se por cancelamento ou substituição conforme a regra fiscal.

## 4. Membros e convites [N1]

- Convite: token aleatório de uso único, expiração curta, vinculado ao e-mail convidado; aceito só por usuário autenticado com esse e-mail. Até aceitar, a membership fica `invited`.
- Reenviar convite invalida o anterior. Convites expirados são limpos por job.
- Remover membro desativa a membership e revoga as concessões dele naquela empresa; o histórico e a auditoria ficam.
- Transferência de propriedade: só o proprietário inicia, o novo proprietário aceita, e a empresa nunca fica sem proprietário ativo.

## 5. Exportação dos dados da empresa [N2]

- O proprietário pode exportar os dados da empresa em formato aberto (CSV/JSON por entidade, arquivos do Storage). É assíncrono, auditado e o link expira.
- A exportação respeita permissões e não inclui segredos de integração nem dados de outros tenants.

## 6. Cancelamento e exclusão [N1]

- Cancelar: status `canceled`, integrações desligadas e **tokens revogados nos provedores** (INTEGRATIONS §14), jobs agendados cancelados, webhooks de saída desativados.
- Após o prazo de retenção, a exclusão definitiva é um job auditado que alcança: banco, Storage (o backup do banco não inclui objetos), filas, logs retidos e provedores que guardam dados do cliente. O que a lei obriga a manter (fiscal, por exemplo) é anonimizado ou isolado, com a base legal registrada.
- A exclusão é idempotente e retomável: se cair no meio, continua de onde parou.

## 7. Testes [N1]

- Provisionamento cria tudo ou nada; repetição não duplica.
- Cada status libera e bloqueia o que a tabela de §1 diz.
- Webhook de pagamento duplicado ou fora de ordem não reativa nem suspende indevidamente.
- Limite do plano bloqueia a criação no servidor mesmo com a UI contornada.
- Remover membro tira o acesso na próxima requisição; a empresa nunca fica sem proprietário.
- Cancelamento revoga integrações; a exclusão definitiva não deixa dados no Storage.

## Particularidades deste projeto

- Mensalidade da plataforma por organização via Asaas; caução de reserva via Stripe. Status de cobrança em `organizations.billing_status`; régua, bloqueio e desbloqueio nos workers `process-billing-*`.
- Regras, entitlements e custo de instância WhatsApp: `.claude/rules/billing.md` e `docs/billing-asaas/`.
