# Z-API — Como entrar no programa de Parceiro Integrador (passo a passo)

> Guia operacional para o administrador da plataforma. Verificado contra a documentação oficial em 2026-07-16 (`developer.z-api.io/partner/*`). **Reconfirmar o contrato exato dos endpoints no momento da implementação da Fase 6** — a doc de parceiro muda com frequência.

---

## ⛔ RESPOSTAS OFICIAIS DO SUPORTE Z-API (2026-07-31) — leia antes de projetar a Fase 6

As três perguntas do passo 2 foram feitas e respondidas. **As respostas invalidam a premissa central da Fase 6 como estava planejada** (provisionamento e cancelamento via API):

1. **Não existe rota de API para cancelar assinatura.** O cancelamento é **manual pelo painel** (Instâncias → clicar na instância → "Cancelar assinatura"). E **não é imediato**: a instância continua ativa até o fim do ciclo já pago; o cancelamento só impede a **próxima** cobrança.
2. **Não há sandbox de parceiro.** O único mecanismo de teste é o **trial de 2 dias grátis, válido apenas na 1ª instância criada na conta** — ou seja, não há como testar o fluxo da instância nº 2 em diante sem pagar.
3. **No Plano Partner o pagamento é único e mensal**, calculado sobre o total de instâncias (preço por instância cai com o volume). Difere do **Ultimate**, onde cada instância é cobrada individualmente.

**Decisão comercial do dono (2026-07-31): o Plano Partner não compensa agora** — ele só passa a fazer sentido a partir de ~10 instâncias, e hoje há 1 canal. Portanto a Fase 6 assume o cenário que o próprio plano previu como alternativa: **"sem parceria confirmada, a fase vira fluxo manual assistido (admin provisiona, sistema rastreia estados)"**.

**Consequência de modelagem que a Fase 6 precisa resolver:** cancelar no painel da Z-API interrompe o **custo** da plataforma, não o **serviço** do cliente (a instância segue viva até o fim do ciclo pago). Quem interrompe o serviço é o enforcement interno da Fase 5b. São duas ações, com dois relógios diferentes, e não podem ser tratadas como uma só.

## Como o programa funciona (modelo Z-API)

O programa de Parceiro Integrador permite criar, assinar e cancelar instâncias **via API**, sem passar pelo painel manualmente. O caminho tem 2 estágios:

- **Estágio 1 — Token de segurança da conta**: toda conta Z-API já tem um token de conta que permite operar até **25 instâncias** via API. É o suficiente para começar (temos 1 canal hoje).
- **Estágio 2 — Token de parceiro definitivo**: ao atingir **~10 instâncias ativas**, você solicita ao suporte da Z-API o token de **integrador definitivo** (condições comerciais de parceiro, escala sem teto de 25).

Comportamento-chave do modelo: instância criada via API **nasce em trial de 2 dias**; se não for assinada nesse prazo, a Z-API **deleta automaticamente**. Ou seja, o fluxo "cliente pagou a mensalidade → sistema cria E assina a instância" (Fase 5/6 do plano) encaixa perfeitamente — nunca criamos instância antes do pagamento confirmado.

## Passo a passo

### 1. Preparar a conta
1. Acesse o painel da Z-API (conta atual, a mesma que hospeda a instância existente).
2. Em configurações da conta, localize o **Token de Segurança da Conta** (Account Security Token) — é diferente do token de instância e do Client-Token que já usamos.
3. Guarde-o com segurança. Quando a Fase 6 começar, ele será cadastrado em `platform_secrets` como `zapi_partner_token` (painel `/platform/automacao`) — **nunca** em `.env` de frontend nem no Git.

### 2. Formalizar a parceria (comercial)
1. Preencha o formulário oficial: [z-api.io/seja-partner-zapi](https://z-api.io/seja-partner-zapi/) (ou [materiais.z-api.io/partners-campaign](https://materiais.z-api.io/partners-campaign)).
2. Ou contate o suporte/comercial direto pelo WhatsApp oficial da Z-API (canal no site) dizendo que você é um **SaaS que quer provisionar instâncias via API para seus clientes** (parceiro integrador).
3. Pergunte explicitamente:
   - Condições de preço por instância para parceiro (o preço de tabela é ~R$ 100/mês por instância; parceiro costuma ter desconto — sua mensalidade de R$ 149 precisa cobrir o custo real);
   - Se o **cancelamento via API** interrompe a cobrança imediatamente ou só no fim do ciclo vigente (impacta §8.2 da spec — registramos `provider_billing_end_at`);
   - Se existe ambiente de teste/sandbox para parceiro ou se o trial de 2 dias é o mecanismo de teste;
   - Como funciona a fatura consolidada das instâncias do parceiro.

### 3. Validar o acesso técnico (antes de codar a Fase 6)
Com o token da conta em mãos, testar manualmente (Postman/curl) os 4 endpoints de parceiro documentados em `developer.z-api.io/partner/`:

| Operação | Doc |
|---|---|
| Criar instância | `developer.z-api.io/partner/create-instance` — POST com `Authorization: Bearer <token>`, body `{ name, ...webhooks }`, resposta `{ id, token, due }` |
| Listar instâncias | `developer.z-api.io/partner/list-instances` |
| Assinar instância | `developer.z-api.io/partner/sign-instance` |
| Cancelar assinatura | `developer.z-api.io/partner/unsubscribe-instance` |

Teste sugerido (baixo custo): criar 1 instância de teste → confirmar que aparece na listagem → **não assinar** → confirmar que some após 2 dias → criar de novo → assinar → cancelar → registrar o comportamento de cobrança. Isso valida o ciclo completo sem custo permanente.

> Atenção da doc oficial: os exemplos de headers variam entre páginas (Bearer token vs headers próprios). O contrato REAL deve ser confirmado nesse teste manual — a Fase 6 do plano já exige isso antes de produção.

### 4. Atingir o estágio 2 (quando escalar)
1. Ao chegar perto de 10 instâncias ativas de clientes, abra chamado no suporte pedindo o **token de parceiro definitivo**.
2. Ao recebê-lo, atualize `platform_secrets.zapi_partner_token` no painel (rotação sem deploy — o resolver tem cache de 5min).

### 5. O que o sistema fará automaticamente (Fase 6, recapitulando)
Pagamento da mensalidade confirmado (webhook Asaas) → `createInstance` → `subscribeInstance` → grava `id`/`token` criptografados em `whatsapp_instances` → cria/associa `whatsapp_channels` → cliente vê QR code no painel → conecta. Inadimplência D+6 → desconecta e (se flag ligada) cancela assinatura na Z-API, registrando `cancellation_requested_at` e o retorno do provedor. Nada disso é ativado sem as flags `zapi_auto_provisioning` / `zapi_auto_cancel`.

## Checklist rápido

- [ ] Localizar Token de Segurança da Conta no painel Z-API
- [ ] Preencher formulário de parceria / falar com comercial
- [ ] Confirmar preço por instância de parceiro (margem sobre R$ 149)
- [ ] Confirmar política de cancelamento (imediato vs fim do ciclo)
- [ ] Teste manual dos 4 endpoints (criar/listar/assinar/cancelar)
- [ ] Cadastrar `zapi_partner_token` em `platform_secrets` (quando a Fase 6 criar a chave)
- [ ] Ao escalar p/ ~10 instâncias: solicitar token definitivo ao suporte

Fontes: [Introdução ao programa de parceiro](https://developer.z-api.io/en/partner/introduction) · [Criando uma instância](https://developer.z-api.io/partner/create-instance) · [Seja Partner Z-API](https://z-api.io/seja-partner-zapi/) · [Campanha de parceiros](https://materiais.z-api.io/partners-campaign)
