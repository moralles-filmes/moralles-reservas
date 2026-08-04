# Runbook — instâncias de WhatsApp (Z-API), fluxo manual assistido

**Fase 6c.** Painel: `/platform/instancias-whatsapp` (menu lateral da plataforma → **Instâncias WhatsApp**).

## A regra que atravessa tudo

**O painel nunca age no fornecedor.** Não temos a API de Parceiro da Z-API: criar e cancelar
instância é ato humano no painel deles. Cada linha do inventário é uma **afirmação humana** sobre
o que existe lá fora, e o worker diário é quem cobra essa afirmação de volta.

Este runbook existe porque essa afirmação envelhece.

---

## R1 — Contratar

1. Pagamento confirmado. (Fora deste escopo: `whatsapp_implementations`.)
2. **Criar a instância no painel da Z-API.** O custo começa aqui, e só aqui.
3. Anotar o **identificador** da instância, o **valor mensal** e o **dia do vencimento**.
4. Registrar no painel: **Registrar instância** → unidade, canal (se já existir), identificador,
   custo, procedência, motivo.
5. **Confirmar a data do ciclo** — o painel já emenda nesse passo depois do registro. A instância
   nasce em `cycle_source: UNKNOWN`, e sem esta confirmação o worker abre `DATE_REVIEW_REQUIRED`.
6. Configurar o canal em `/platform/automacao/<slug>` com as credenciais.

**Sobre o identificador:** apenas o identificador, **nunca a URL** — ela contém o token, e esta
tabela é declarada livre de segredo. O formulário recusa URL, espaço e mais de 128 caracteres.

**Sobre o custo:** vazio significa **desconhecido**, nunca zero. O ciclo fica em
`PENDING_REVIEW` até o número existir, e a margem fica indefinida — que é a verdade.

---

## R2 — Rotina mensal: um alerta, uma ação

| Alerta | `event_type` | Ação |
|---|---|---|
| `CYCLE_DUE_SOON` (D-7) | `admin_zapi_cycle_d7` | Nada obrigatório. Decidir se mantém. |
| `CYCLE_DUE_TOMORROW` (D-1) | `admin_zapi_cycle_d1_action_required` | **Ação hoje.** Ver os quatro motivos abaixo. |
| `END_CONFIRMATION_REQUIRED` | `admin_zapi_end_confirmation_required` | Conferir na Z-API e confirmar o encerramento. |
| `DATE_REVIEW_REQUIRED` | `admin_zapi_date_review_required` | Confirmar a data do ciclo. |
| `DIVERGENCE` | `admin_zapi_divergence` | Canal sem instância → **Registrar esta instância**, pelo próprio card do alerta. |
| `ECONOMIC_IMBALANCE` | `admin_zapi_economic_imbalance` | Decisão comercial, não técnica. Nunca dispara para cliente vitalício. |

### Os quatro motivos do D-1 (`D1Reason`)

| Motivo | O que fazer |
|---|---|
| `COST_UNKNOWN` | Informar o custo. |
| `OPEN_DIVERGENCE` | Resolver a divergência. |
| `CANCELLATION_INTENDED_NOT_REGISTERED` | **Cancelar na Z-API hoje.** O cancelamento foi registrado aqui e não foi feito lá. |
| `REVENUE_UNKNOWN` | Conferir assinatura ou override. |

### `ACKNOWLEDGED` não é `RESOLVED`

**Reconhecer** interrompe o lembrete; **resolver** afirma que o fato deixou de existir. Fato que
desaparece sozinho é resolvido pelo worker com nota do sistema — nunca apagado.

---

## R3 — Cancelar

1. **Registrar cancelamento** no painel: motivo + data-limite de acesso.
   A data informada é o **primeiro dia NÃO coberto** — o acesso vai até a véspera, e o painel
   escreve isso por extenso embaixo do campo.
2. **Cancelar de fato na Z-API.** Este é o passo que interrompe o custo. Sem ele, o registro é
   uma intenção e o dinheiro continua saindo.
3. Chega `END_CONFIRMATION_REQUIRED` → conferir no painel do fornecedor → **Confirmar
   encerramento**.
4. Se o fornecedor desfez o cancelamento: **Reativar**, com a evidência do que foi verificado.
   `ENDED` não reativa — instância encerrada que reapareça exige linha nova.

### O que o cancelamento aqui NÃO faz

Não altera assinatura, `billing_status`, entitlement, envio, canal nem credencial. Ele registra o
**término planejado do custo** — nada mais. Quem interrompe o serviço do cliente é o enforcement
por inadimplência, que é outro mecanismo.

### O caso que vem do downgrade (Plano C)

O downgrade revoga o WhatsApp no SaaS e abre um `request_cancellation` — **ele não cancela nada na
Z-API.** O passo 2 continua sendo humano. Sem alguém executá-lo, o cliente perde o serviço e a
plataforma segue pagando **R$ 99,90/mês** por uma instância que ninguém está usando. É a razão de
a cadência abaixo não ser opcional.

---

## O ponto operacional que este runbook não pode omitir

**Os seis avisos `admin_zapi_*` não viram e-mail hoje.** `billing_notifications_dispatch` segue
OFF para eles pela pendência `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`: resta um intervalo entre
enfileirar e carimbar, e ligar o dispatch transformaria uma falha de carimbo em e-mail duplicado
para o admin.

A fila acumula corretamente. O ledger registra corretamente. **Ninguém é notificado.**

Enquanto isso, o painel é o único canal — e fluxo manual sem aviso ativo exige cadência de
conferência.

### A cadência

**Toda segunda-feira, e obrigatoriamente entre o D-7 e o D-1 de cada instância.**

Com uma instância vencendo dia 4, isso é **dia 28 e dia 3**.

O painel mostra um aviso azul no topo quando existe alerta aberto nascido com o dispatch
desligado — ele existe exatamente para que ninguém leia "não recebi e-mail" como "não houve
alerta".
