# Templates oficiais da Meta — propostas para submissão

**Data:** 2026-09-22 · Deriva de [`2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md`](./2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md)

Escrito para quem vai submeter os templates no painel da Datafy/Meta e para quem vai implementar a Fase F.

A aprovação da Meta é assíncrona e leva dias. Estas propostas são entregues **antes** do módulo de templates (Fase F) exatamente por isso: submeter cedo é ganho puro, e a rejeição de um rascunho custa menos do que a de um template já ligado ao código.

**Endpoint:** `POST https://cloud.datafyapi.com.br/v1/{waba_id}/message_templates` · idioma `pt_BR` · formato posicional (`{{1}}`).

---

## Regras da Meta que moldaram estas redações

- Variável **não pode abrir nem fechar** o corpo, e duas variáveis não podem ser adjacentes.
- Corpo ≤ 1024 caracteres · rodapé ≤ 60 · texto de botão ≤ 25.
- Todo `{{n}}` exige exemplo em `example.body_text`.
- **Não existe linha condicional.** É o que obriga o desdobramento do item 2.
- Categoria é decidida pela Meta, não por nós. O sistema **lê a categoria de volta** do webhook `message_template_status_update` e nunca sobrescreve — tentar forçar UTILITY em conteúdo de Marketing é violação de política, além de errado.

---

## 1. `reserva_confirmada` — UTILITY

Substitui o texto hardcoded de [`send-confirmation`](../../../supabase/functions/send-confirmation/index.ts) no caso sem desconto.

```json
{
  "name": "reserva_confirmada",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Olá, {{1}}! Sua reserva no {{2}} está confirmada.\n\n📅 Data: {{3}}\n⏰ Horário: {{4}}\n👥 Pessoas: {{5}}\n🔑 Código: {{6}}\n\nPara alterar ou cancelar, é só responder esta mensagem.",
      "example": { "body_text": [["Ana", "Ren Sushi", "24/09/2026", "20:00", "4", "A3F9K2"]] }
    },
    { "type": "FOOTER", "text": "Até logo!" }
  ]
}
```

- **Variáveis:** 1 nome · 2 unidade · 3 data DD/MM/AAAA · 4 hora HH:MM · 5 nº de pessoas · 6 código da reserva
- **Justificativa da categoria:** confirma uma transação específica que o cliente acabou de fazer. Sem oferta, sem incentivo. É o caso central de UTILITY.
- **Gatilho:** trigger `enqueue_confirmation_after_insert` → `notification_outbox` → `process-notification-outbox`. Reservas com `source = 'whatsapp'` continuam fora (o agente já confirma na conversa).
- **Cancelar o envio se:** a reserva foi cancelada antes do disparo, ou o TTL do kind `confirmation` venceu (o horário da reserva já passou).

## 2. `reserva_confirmada_com_desconto` — UTILITY

Existe porque **template da Meta não aceita linha opcional**. O texto atual concatena `💸 Desconto: X% off` só quando há desconto; num template isso vira ou um parâmetro sempre preenchido (que escreveria "0% off") ou dois templates. Dois templates é o honesto.

```json
{
  "name": "reserva_confirmada_com_desconto",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Olá, {{1}}! Sua reserva no {{2}} está confirmada.\n\n📅 Data: {{3}}\n⏰ Horário: {{4}}\n👥 Pessoas: {{5}}\n💸 Desconto aplicado: {{6}}\n🔑 Código: {{7}}\n\nPara alterar ou cancelar, é só responder esta mensagem.",
      "example": { "body_text": [["Ana", "Ren Sushi", "24/09/2026", "20:00", "4", "15% off", "A3F9K2"]] }
    },
    { "type": "FOOTER", "text": "Até logo!" }
  ]
}
```

- **Justificativa:** o desconto aqui **já foi concedido** pela regra de horário da própria reserva — é atributo da transação confirmada, não oferta nova. Segue UTILITY. Se a Meta reclassificar como MARKETING, aceitar e passar a tratá-lo como cobrável.
- **Seleção:** `applied_discount_percent > 0` escolhe este; caso contrário, o item 1.

## 3. `reserva_cancelada` — UTILITY

```json
{
  "name": "reserva_cancelada",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Olá, {{1}}. Sua reserva no {{2}} foi cancelada.\n\n📅 Data: {{3}}\n⏰ Horário: {{4}}\n👥 Pessoas: {{5}}\n🔑 Código: {{6}}\n\nSe foi engano ou quiser remarcar, é só responder aqui que a gente ajuda.",
      "example": { "body_text": [["Ana", "Ren Sushi", "24/09/2026", "20:00", "4", "A3F9K2"]] }
    }
  ]
}
```

- **Gatilho:** ação do operador no painel (`send-cancellation`). O outbox não dispara este caso.
- **Cancelar o envio se:** a reserva voltou a `confirmed` antes do disparo.

## 4. `lembrete_reserva_hoje` — UTILITY

O link de acompanhamento vira **botão URL dinâmico**, que é como a Meta modela sufixo variável. Isso também tira a URL do corpo, onde ela poluía a contagem de caracteres.

```json
{
  "name": "lembrete_reserva_hoje",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Olá, {{1}}! 👋 Passando para lembrar da sua reserva hoje no {{2}}.\n\n⏰ Horário: {{3}}\n👥 Pessoas: {{4}}\n🔑 Código: {{5}}\n\nPara alterar ou cancelar, é só responder esta mensagem. Te esperamos!",
      "example": { "body_text": [["Ana", "Ren Sushi", "20:00", "4", "A3F9K2"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Acompanhar reserva",
          "url": "https://reservas.moralles.com.br/acompanhar/{{1}}",
          "example": ["https://reservas.moralles.com.br/acompanhar/6f1c2f8e-2b1a-4f7d-9c33-0a1b2c3d4e5f"]
        }
      ]
    }
  ]
}
```

- **Gatilho:** `process-reservation-reminders`, cron `0 13 * * *` (10:00 BRT). Respeita `settings.reminder_d1_enabled`.
- **Cancelar o envio se:** reserva não está `confirmed`, `customers.do_not_contact = true`, ou o horário da reserva já passou (TTL do kind `reminder_d1` é 0).
- **Atenção na Fase F:** hoje o lojista edita este corpo livremente (600 chars). Com template aprovado, a estrutura congela e só as cinco variáveis são substituíveis. Ou o editor passa a oferecer apenas as variáveis, ou cada edição vira submissão por tenant com aprovação assíncrona — decisão da Fase F, não desta.

## 5. `pesquisa_satisfacao` — UTILITY *(risco de reclassificação)*

```json
{
  "name": "pesquisa_satisfacao",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Oi, {{1}}! 🙂 Esperamos que tenha gostado da sua visita ao {{2}} ontem.\n\nDe 1 a 5, como você avalia sua experiência? Responda só o número.\n\nObrigado por nos ajudar a melhorar!",
      "example": { "body_text": [["Ana", "Ren Sushi"]] }
    }
  ]
}
```

- **Justificativa:** pesquisa sobre uma transação concluída e identificável, sem oferta. **Declaro o risco:** a Meta vem reclassificando pesquisas como MARKETING. Submeter como UTILITY é defensável; se voltar MARKETING, **aceitar** — o custo passa de R$ 0,035 para R$ 0,32 e isso é decisão comercial, não motivo para ressubmeter com outra roupagem.
- **Gatilho:** `process-satisfaction-surveys`, cron `0 17 * * *` (14:00 BRT). Respeita `settings.survey_d1_enabled`.
- **Cancelar o envio se:** `satisfaction_rating` já preenchido, ou TTL de 48 h vencido.
- **Nota:** a resposta "1".."5" do cliente chega dentro da janela de 24 h, então o giftback `after_rating` continua sendo texto livre — não precisa de template.

## 6. `fila_entrada` — UTILITY

```json
{
  "name": "fila_entrada",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Oi, {{1}}! Você entrou na fila de espera do {{2}}.\n\n🎟️ Sua senha: {{3}}\n👥 Pessoas: {{4}}\n\nAvisamos aqui assim que sua mesa estiver pronta.",
      "example": { "body_text": [["Ana", "Ren Sushi", "B12", "4"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Acompanhar a fila",
          "url": "https://reservas.moralles.com.br/acompanhar/{{1}}",
          "example": ["https://reservas.moralles.com.br/acompanhar/6f1c2f8e-2b1a-4f7d-9c33-0a1b2c3d4e5f"]
        }
      ]
    }
  ]
}
```

- **Gatilho:** trigger `dispatch_waitlist_entered` (AFTER INSERT em `waitlist`), via `pg_net`. Não é cron.
- **Cancelar o envio se:** a entrada saiu de `waiting`, ou TTL de 2 h vencido.

## 7. `fila_mesa_pronta` — UTILITY

A mais sensível a atraso do conjunto: TTL de 30 minutos.

```json
{
  "name": "fila_mesa_pronta",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "🔔 {{1}}, sua mesa no {{2}} está pronta!\n\n🎟️ Senha: {{3}}\n\nPor favor, dirija-se à recepção.",
      "example": { "body_text": [["Ana", "Ren Sushi", "B12"]] }
    }
  ]
}
```

- **Gatilho:** clique do operador em Operacional → Fila.
- **Cancelar o envio se:** a entrada já está `seated` ou foi removida, ou TTL de 30 min vencido — avisar "sua mesa está pronta" 40 minutos depois é pior que não avisar.

## 8. `fila_feedback` — MARKETING

```json
{
  "name": "fila_feedback",
  "language": "pt_BR",
  "category": "MARKETING",
  "components": [
    {
      "type": "BODY",
      "text": "Obrigado por escolher o {{1}}, {{2}}! Conte pra gente como foi sua experiência — leva menos de um minuto e ajuda muito.",
      "example": { "body_text": [["Ren Sushi", "Ana"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Deixar avaliação",
          "url": "https://reservas.moralles.com.br/r/{{1}}",
          "example": ["https://reservas.moralles.com.br/r/ren-sushi"]
        }
      ]
    }
  ]
}
```

- **Justificativa de MARKETING:** diferente do item 5, o botão leva à **vitrine da loja** (`/r/<slug>`), não a um registro da transação. Isso é retorno de tráfego, e a Meta trata assim. Submeter como UTILITY aqui seria a tentativa de enganar a categoria que a política proíbe.
- **Gatilho:** `process-waitlist-feedback`, cron `0 17 * * *` (14:00 BRT).
- **Cancelar o envio se:** TTL de 24 h vencido, ou `do_not_contact`.
- **Custo:** R$ 0,32 por envio, sempre cobrado. Vale revisar se compensa como WhatsApp.

## 9. `giftback_voucher` — MARKETING

```json
{
  "name": "giftback_voucher",
  "language": "pt_BR",
  "category": "MARKETING",
  "components": [
    {
      "type": "BODY",
      "text": "🎁 {{1}}, você ganhou {{2}} de desconto na sua próxima visita ao {{3}}!\n\nCódigo: {{4}}\nVálido até {{5}}\n\nÉ só apresentar esse código na hora de pagar.",
      "example": { "body_text": [["Ana", "10%", "Ren Sushi", "K7M2P9QX", "31/10/2026"]] }
    },
    { "type": "FOOTER", "text": "Aproveite!" }
  ]
}
```

- **Justificativa:** oferta de desconto. É MARKETING por definição, sem discussão. Item 7 do prompt: nunca classificar incentivo comercial como UTILITY para reduzir custo.
- **Gatilho:** `process-voucher-triggers`, cron `0 12 * * *` (09:00 BRT), regras de aniversário e frequência.
- **Cancelar o envio se:** TTL de 7 dias vencido. Lembrar da assimetria já documentada: sob suspensão, **aniversário cria o voucher e só suprime o envio** (a data não volta); frequência pula a regra inteira (a janela é recalculada).
- **Custo:** R$ 0,32 por envio. Com o voucher só persistindo se o envio der certo, uma falha de template significa voucher não emitido — a Fase F precisa preservar esse ciclo.

---

## Resumo e custo estimado

| # | Template | Categoria | Vars | Botão | Custo/msg |
|---|---|---|---|---|---|
| 1 | `reserva_confirmada` | UTILITY | 6 | — | R$ 0,035 |
| 2 | `reserva_confirmada_com_desconto` | UTILITY | 7 | — | R$ 0,035 |
| 3 | `reserva_cancelada` | UTILITY | 6 | — | R$ 0,035 |
| 4 | `lembrete_reserva_hoje` | UTILITY | 5 + 1 URL | ✅ | R$ 0,035 |
| 5 | `pesquisa_satisfacao` | UTILITY ⚠️ | 2 | — | R$ 0,035 ou 0,32 |
| 6 | `fila_entrada` | UTILITY | 4 + 1 URL | ✅ | R$ 0,035 |
| 7 | `fila_mesa_pronta` | UTILITY | 3 | — | R$ 0,035 |
| 8 | `fila_feedback` | MARKETING | 2 + 1 URL | ✅ | R$ 0,32 |
| 9 | `giftback_voucher` | MARKETING | 5 | — | R$ 0,32 |

**São nove, não oito** — `reserva_confirmada` se desdobra em duas porque template da Meta não aceita linha condicional.

**A partir de 1º/10/2026** cada número ganha 1.000 mensagens de **serviço** grátis por mês; acima disso, R$ 0,035. Templates **Utility perdem a isenção dentro da janela de 24 h** — ou seja, os itens 1 a 7 passam a ser cobrados mesmo quando enviados logo após o cliente escrever. Os valores acima já refletem o cenário pós-mudança.

**Nada disto foi submetido.** Estes são rascunhos; nenhum template pode ser marcado como aprovado no sistema antes da resposta oficial da Meta, que chega pelo webhook `message_template_status_update`.
