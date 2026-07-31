# Follow-up — customer canônico do Asaas e divergência de contato de cobrança

> **Status: ACHADO REGISTRADO, NADA IMPLEMENTADO.** Descoberto em 2026-07-31 durante o
> sandbox da Fase 5b. **Não corrigir dentro da 5b** — é redesenho de contrato entre
> `billing_customers` e o Asaas, com implicações de LGPD e cross-tenant. Este documento
> existe para que a decisão seja tomada de propósito, não no meio de outra fase.

## 1. O que foi observado

Uma única organização (`SANDBOX FASE 5B — PAID`, `a705c2e2-dff1-4f15-a62c-58af06bf8dcd`)
acumulou **três clientes distintos no Asaas** em menos de 24h, cada um por um caminho
diferente:

| customer | origem | contato | verificado? |
|---|---|---|---|
| `cus_000008529031` | criado pela nossa API (`createAsaasCustomer`, a partir de `billing_customers`) | `morallesfilms+sandbox5b-paid@gmail.com` | sim — é o cadastro interno |
| `cus_000008529056` | digitado pelo pagador no checkout hospedado da **implantação** | não verificado | não |
| `cus_000008533953` | digitado pelo pagador no checkout hospedado da **instância** | `yuri@gmail.com`, `phone 43991336361`, `notificationDisabled: false` | **não** |

**A assinatura recorrente `sub_qn6dpom3q6xr3r8s` (R$149/mês) ficou vinculada ao terceiro**,
não ao cadastro interno. Consequência direta: toda cobrança do ciclo mensal — boleto,
recibo, aviso de vencimento — é notificada pelo Asaas ao contato que o pagador digitou na
página hospedada, **não** ao `billing_customers.email` que a plataforma mantém e exibe ao
lojista.

Isso não é artefato da fixture. É o comportamento normal do checkout hospedado do Asaas:
o formulário coleta nome, documento, e-mail e telefone do pagador, e o Asaas cria (ou
reaproveita) um customer com esses dados. O `externalReference` que gravamos na sessão de
checkout **não propaga** para o customer nem para a cobrança — ver o invariante de
correlação no `CLAUDE.md` e a evidência ao vivo em
[FASE-5B-ROTEIRO-SANDBOX.md §0.5.3](FASE-5B-ROTEIRO-SANDBOX.md).

## 2. Por que importa em produção

- **Cobrança vai para o endereço errado.** O financeiro cadastrado no painel não recebe o
  boleto; quem recebe é quem estava com o cartão na mão. Em cliente com equipe, isso é
  cobrança perdida.
- **Dado pessoal de terceiro entra no nosso provedor de pagamento** sem consentimento
  registrado e sem que a organização saiba.
- **Divergência silenciosa.** Nenhuma tela mostra que o contato da assinatura difere do
  contato de cobrança cadastrado. Não há alerta, log ou métrica.
- **Acúmulo sem teto.** Cada checkout hospedado pode criar mais um customer. Nada limpa,
  nada consolida, nada avisa.
- **A dedupe do Asaas é por `cpfCnpj`**, então dois checkouts com o mesmo documento tendem
  a reaproveitar o customer — mas com documento diferente (ou ausente) nasce outro.

## 3. Pontos a decidir (não implementar agora)

1. **Fonte de verdade do contato de cobrança.** `billing_customers.email` ou o customer do
   Asaas? Um dos dois precisa ganhar, e o outro precisa ser sincronizado ou exibido como
   divergente.
2. **Vinculação determinística entre organização e customer Asaas.** Hoje o vínculo forte é
   só `billing_customers.asaas_customer_id`, e ele não cobre os customers nascidos no
   checkout.
3. **Política para impedir múltiplos customers ativos da mesma finalidade** — por
   organização e por categoria de produto.
4. **Sincronização ou validação do e-mail após o retorno do checkout** — comparar o contato
   do customer recém-vinculado com o cadastro e decidir: sobrescrever, alertar, ou bloquear.
5. **Tela administrativa para revisar o contato financeiro**, mostrando o contato efetivo da
   assinatura (o do Asaas) ao lado do cadastrado.
6. **Aviso ao cliente, no próprio checkout ou no retorno**, sobre qual endereço vai receber
   as cobranças.
7. **Estratégia para customers legados divergentes** — o que fazer com os que já existem.
8. **Proteção contra sobrescrever contato legítimo de outra organização.** Qualquer rotina
   de sincronização precisa provar que o customer pertence à organização antes de escrever;
   sem isso, uma correção automática vira escrita cross-tenant.
9. **Auditoria de todas as organizações com mais de um customer Asaas** — levantamento
   único, antes de qualquer correção.
10. **LGPD: registro de consentimento e de alteração.** Quem alterou o contato, quando, e
    com que base — inclusive para o dado de terceiro já coletado.

Acrescentados a partir da evidência desta fase:

11. **O checkout hospedado permitiu contato divergente do cadastro interno**, sem
    validação nem alerta em nenhuma ponta.
12. **A assinatura recorrente ficou vinculada ao customer criado com dados digitados pelo
    pagador** — não ao customer que a plataforma criou pela API.
13. **Recibos e cobranças podem seguir para contato diferente do financeiro cadastrado.**
14. **A organização acumulou três customers no Asaas** em menos de 24h, por três caminhos
    distintos, sem nenhum sinal disso na plataforma.
15. **O sistema precisa determinar qual customer é canônico por finalidade** (implantação,
    instância, recarga de IA, mensalidade de sistema) — não basta um por organização.
16. **Qualquer futura sincronização deve impedir atualização cross-tenant e sobrescrita de
    contato legítimo**, com a mesma severidade de um guard de RLS.

## 4. Estado atual da fixture (para a auditoria do §9 do sandbox)

Registro do que existe hoje, sem merge automático e sem apagar nada — conforme determinado:

| customer | finalidade | vínculo | contato armazenado | verificado | notificações | destino |
|---|---|---|---|---|---|---|
| `cus_000008529031` | cadastro interno | `billing_customers.asaas_customer_id` | controlado | sim | padrão | **manter** — é o canônico da plataforma |
| `cus_000008529056` | pagador da implantação | cobrança `pay_izm4cc4v0ptzchfh` | não verificado | não | não verificado | arquivar após o sandbox |
| `cus_000008533953` | pagador da instância | assinatura `sub_qn6dpom3q6xr3r8s` | `yuri@gmail.com` → corrigido no painel para o endereço controlado, notificações desativadas | passou a ser controlado | desativadas | arquivar após o sandbox |

A correção do terceiro foi **exclusivamente** para não notificar terceiro durante o ensaio,
pelo painel do Asaas Sandbox, sem tocar em nome, documento, telefone ou endereço. Não é a
solução do problema — é contenção do efeito externo.

## 5. Limite deste documento

Nada aqui é para ser implementado na Fase 5b. A fase entrega enforcement por serviço; este
achado é de **contrato de identidade financeira** e precisa de spec própria
(`superpowers:brainstorming` → plano), incluindo auditoria prévia das organizações reais.
