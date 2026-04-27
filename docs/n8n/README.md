# Automações N8N — moralles-reservas

Esta pasta contém os workflows N8N que orquestram outbound de WhatsApp **agendado** (lembretes e pesquisa de satisfação). Os fluxos síncronos (confirmação automática e agente IA conversacional) seguem nas Edge Functions do Supabase.

## Pré-requisitos

1. Migration `011_notifications_and_satisfaction.sql` aplicada (`supabase db push` ou SQL Editor).
2. Edge Functions `send-whatsapp` e `webhook-zapi` deployadas com os secrets já configurados (em particular `INTERNAL_API_KEY`).
3. Instância N8N rodando com acesso à internet pública (precisa alcançar `<project>.supabase.co`).

## Credenciais a criar no N8N

Em **Credentials → New → HTTP Header Auth**:

| Nome no N8N | Header name | Header value |
|---|---|---|
| `supabase-service-role` | `apikey` | valor de `SUPABASE_SERVICE_ROLE_KEY` (Settings → API) |
| `moralles-internal-key` | `X-Internal-Key` | valor de `INTERNAL_API_KEY` (mesmo dos secrets das Edge Functions) |

> Para chamadas REST do PostgREST do Supabase, alguns endpoints exigem **dois** headers (`apikey` e `Authorization: Bearer`). Quando isso for necessário, adicione um segundo "Generic Header" no node HTTP Request com `Authorization: Bearer {{ $credentials.apikey }}` apontando para a mesma credencial.

## Variáveis no N8N

Em **Settings → Variables** (ou direto no node):

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |

## Importar os workflows

1. **Workflows → Import from File** → selecione `workflow-reminder-d1.json` → importe.
2. Repita para `workflow-survey-d1.json`.
3. Em cada workflow:
   - Abra os nodes HTTP Request e atribua a credencial `supabase-service-role` (nos que chamam `/rest/v1/...`) ou `moralles-internal-key` (no que chama `/functions/v1/send-whatsapp`).
   - Confirme `SUPABASE_URL` no campo URL.
4. **Active** o workflow (toggle no canto superior direito).

## Cron schedule

Os triggers Cron já vêm configurados:

| Workflow | Cron expression | Significado (BRT) |
|---|---|---|
| `reminder-d1` | `0 10 * * *` | 10h da manhã, todos os dias |
| `survey-d1` | `0 14 * * *` | 14h, todos os dias |

> O timezone do trigger Cron segue a configuração da instância N8N (`GENERIC_TIMEZONE`). Garanta que esteja em `America/Sao_Paulo`.

## Como cada workflow funciona

### `reminder-d1` (lembrete de reserva amanhã)

```
Cron 10h
  → HTTP POST /rest/v1/rpc/get_reservations_for_reminder  (target_date = hoje + 1)
  → SplitInBatches (1)
  → Function: monta texto da mensagem
  → HTTP POST /functions/v1/send-whatsapp                  (X-Internal-Key)
  → HTTP POST /rest/v1/notifications_sent                  (kind=reminder_d1, status=sent|failed)
```

A RPC `get_reservations_for_reminder` já filtra:
- `status = 'confirmed'`
- `customer.do_not_contact = false`
- nenhum registro prévio em `notifications_sent` com `kind='reminder_d1'`

Logo, rodar o workflow N vezes no mesmo dia **não duplica mensagens** — a partir da 2ª execução a RPC retorna 0 linhas.

### `survey-d1` (pesquisa de satisfação)

```
Cron 14h
  → HTTP POST /rest/v1/rpc/get_reservations_for_survey  (target_date = hoje - 1)
  → SplitInBatches (1)
  → Function: monta texto da mensagem
  → HTTP POST /functions/v1/send-whatsapp
  → HTTP POST /rest/v1/notifications_sent               (kind=survey_d1)
```

Filtros adicionais (RPC):
- `r.satisfaction_rating is null` (não envia para quem já respondeu)

A captura da resposta (1-5) é feita pela Edge Function `webhook-zapi`, **antes** do agente IA — economizando tokens. Veja o bloco `Survey response intercept` em `supabase/functions/webhook-zapi/index.ts`.

## Testes manuais

### Teste 1 — disparar lembrete sob demanda

1. No N8N, abra o workflow `reminder-d1` e clique **Execute Workflow**.
2. Confira no Supabase:
   - `select * from notifications_sent where kind='reminder_d1' order by sent_at desc limit 5;`
   - Mensagem chegou no número do cliente teste.
3. Execute novamente — RPC retorna 0 linhas, nenhuma mensagem nova.

### Teste 2 — capturar resposta da pesquisa

1. Insira manualmente um registro fake:
   ```sql
   insert into notifications_sent (reservation_id, kind, status)
   values ('<id-reserva-teste>', 'survey_d1', 'sent');
   ```
2. Mande "5" do número do cliente da reserva via WhatsApp.
3. Confira:
   - `select satisfaction_rating, satisfaction_at from reservations where id = '<id-reserva-teste>';` → deve estar 5
   - Logs do `webhook-zapi`: deve aparecer `evt: "survey_response_captured"` e **não** deve haver chamada ao provedor de IA.
   - O cliente recebe "Obrigado pelo feedback! 🙏".

## Troubleshooting

- **HTTP 401 do Supabase REST**: verifique que o node HTTP Request tem AMBOS os headers — `apikey` e `Authorization: Bearer`.
- **HTTP 403 ao chamar RPC**: a RPC só pode ser executada por `service_role`. Confirme a credencial.
- **Mensagens não saem no WhatsApp**: confira logs da Edge `send-whatsapp` no painel Supabase. Pode ser Z-API rate-limit ou token expirado.
- **Lembretes duplicados**: indica que o INSERT em `notifications_sent` está falhando silenciosamente após o envio. Configure o node HTTP do INSERT como `Continue On Fail = false` e investigue na primeira ocorrência.
