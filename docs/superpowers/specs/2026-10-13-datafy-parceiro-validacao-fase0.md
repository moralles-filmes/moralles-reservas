# Fase 0 — validação ao vivo do contrato de parceiro Datafy (relatório)

**Data:** 2026-10-14. **Ferramenta:** [scripts/datafy-probe/](../../../scripts/datafy-probe/README.md) (imprime forma, nunca valor). **Compara com:** §3 da [spec](2026-10-13-datafy-parceiro-conexao-self-service-design.md).

**Gate de saída:** este relatório revisado pelo dono. As decisões da §4 mudam interfaces das Tasks 4, 5 e 7 e precisam entrar no plano antes da Task 4.

---

## 1. Como a rodada aconteceu

A sequência do README (número da Moralles: ORIGINAL → PROBE → ORIGINAL) não pôde ser seguida:

- O painel da Datafy **não tem "desconectar número"**, só "trocar número" (observação do dono).
- O canal que o probe identificou como ORIGINAL pela fingerprint do número (`66b8762d…`) era de **outro sistema de teste do dono**: o mesmo número estava conectado lá, com webhook para um host `*.vercel.app`. Ele não estava assinado nem em trial e foi assinado por engano nesta rodada (o dono resolveu no painel e removeu o canal). **Fingerprint igual identifica o número, não o dono do canal.** Ação com custo exige confirmar o canal pelo nome com o dono.
- O dono removeu os outros canais, inclusive o PROBE criado pelo probe. O teste com número usou o **"Moralles Reservas - Canal Teste" (`6d869b02…`)**, assinado com autorização do dono, e o número da Moralles foi conectado nele pelo Embedded Signup a partir de uma página `localhost`.

## 2. Resultado por operação

| Operação | HTTP | Forma medida | Diferença em relação à §3 |
|---|---|---|---|
| `GET /channels/whatsapp` | 200 | `{subscription, channels[]}`; item: `id, name, description, subscribed, on_trial, trial_ends_at, paused, waba_id, phone_number_id, business_id, display_name` | Igual. Sem `token`/`webhook_secret`. `subscription` = `active`. Item **sem `created_at`**. |
| `GET /channels/whatsapp/global-webhook` | 200 | `{webhook: null}` | Não estava na §3. Existe webhook de conta para todos os canais. |
| `POST /channels/whatsapp` | **200** | `{id, name, description, token: sk_live_, webhook_secret: whsec_, subscribed: false}` | Igual, mas 200 em vez de 201. Canal nasce `on_trial: true` com `trial_ends_at` ISO com offset. |
| `POST` com `name` repetido | 200 | novo `id` | **`name` não é único.** |
| `GET` canal sem número | 200 | `phone_number_id`, `waba_id`, `business_id`, `phone`, `display_name` = `null` (presentes); `description` vazio = `""` | Campos vêm `null`, não ausentes. |
| `GET` canal com número | 200 | os mesmos campos como string; `webhooks[]` com `id, url, events, enabled` | **Não há `coexistence` no GET.** |
| `POST …/{id}/webhooks` | 200 | `{id, url, events, enabled}` | Igual. `events` default `messages` + `smb_message_echoes`. |
| `GET …/{id}/webhooks` | 200 | array do mesmo item | Igual. |
| `POST …/{id}/connect-link` (trial ou assinado) | 200 | `{url: app.datafyapi.com.br, token: ct_, expires_in: 86400}` | Igual. |
| `connect-link` em canal **com número conectado** e assinado | **200** | igual ao acima | **§3 dizia 409 "já conectado".** |
| `connect-link` em canal sem assinatura e sem trial | 409 | `{message: "O canal não está assinado (teste encerrado ou assinatura cancelada). Assine o canal para poder conectar.", statusCode: 409}` | Igual. A checagem de assinatura vem **antes** da de conexão: o 409 saiu com número conectado. |
| `POST …/{id}/subscribe` | 200 | `{id, subscribed: true}` | Igual. Repetição (idempotência) **não medida**: poderia cobrar de novo. |
| `DELETE` canal nunca assinado, sem número | 200 | `{ok: true}` | Confirma que "assinatura cancelada" inclui "nunca assinado". |
| Canal inexistente | 404 | `{message: "Canal não encontrado", statusCode: 404}` | — |
| Envelope de erro | — | `{message, statusCode}` | **Sem campo `code`/`error`**: as variantes de um mesmo status só diferem pelo texto. |
| `pause` / `resume` / `cancel`, `delete` com número ou assinado | — | **não medido** | O PROBE foi removido antes; não se pausou o canal com o número real. |

## 3. Janela de conexão e identidade do número

- **O `postMessage` chegou a uma página `http://localhost:5599`.** Não há restrição de domínio do parceiro, e `Referrer-Policy: no-referrer` não atrapalha. `127.0.0.1` não foi medido (houve uma conexão só).
- Forma, idêntica à §3: `origin = "https://app.datafyapi.com.br"`, vindo da própria janela aberta (`e.source === popup`), `data = {source: "datafy", event: "connected", data: {phone_number_id, waba_id, business_id, coexistence}}`. `coexistence` é **boolean** (`true`). Uma mensagem só.
- A janela fechou sozinha 103 s depois de aberta, após mostrar "WhatsApp conectado".
- **A identidade do número sobrevive à troca de canal:** no mesmo portfólio e WABA, `phone_number_id`, `waba_id` e `business_id` do canal novo têm as mesmas fingerprints do canal anterior e do canal da Moralles no nosso banco (`phone_number_id` `dfc5c5bc520e`, WABA `940664c312c7`).

## 4. Decisões que mudam o plano

1. **Reconciliação do `create_channel` (Tasks 5 e 7).** `name` não é único, então a listagem por `name = reserved_channel_id` pode achar 0, 1 ou N. Como esse nome é um UUID que só o nosso onboarding usa, N > 1 só nasce de reenvio nosso: adotar um, gravar o id e apagar os demais (nunca assinados e sem número, o `DELETE` dá 200). A listagem não traz `created_at`, então a escolha não pode depender de "o mais antigo".
2. **Link em canal conectado devolve 200 (Tasks 4, 5 e 7).** `conflict → alreadyConnected` não existe como sinal. O `start` decide pelo GET: com `phone_number_id`, não gera link e vai para o `confirm`. **Um link de canal conectado reabre o Embedded Signup e permite trocar o número desse canal** ("trocar número"): é capability mais forte do que a §3 supunha, e só pode ser emitido para canal sem número.
3. **Trial é pré-condição do link (Tasks 5 e 7).** Canal sem assinatura e com trial vencido recusa o link. Se o trial (2 dias desde a criação) vencer antes da conexão, recomendação: apagar e recriar o canal (sem custo; o `DELETE` de nunca assinado dá 200), em vez de assinar antes de conectar. `decideStartStep` ganha esse ramo, decidido pelo GET (`on_trial`, `subscribed`), nunca pelo texto do 409.
4. **Classificação de erro (Task 4).** Sem `code` no corpo, o cliente classifica só por status HTTP, como o plano já prevê; nada decide por texto. Sucesso é qualquer 2xx (criar devolve 200).
5. **`coexistence` não está no GET (Tasks 5 e 7) — decisão do dono.** O `confirm` não consegue checar Coexistence pela fonte confiável. Recomendação: o `confirm` não barra por `coexistence`; a prova de Coexistence no servidor é o eco do aparelho, que já é exigido para ativar (`manual_echo_verified_at`). Número só Cloud API nunca produz eco, então nunca ativa, e o checklist fica em "aguardando eco". O `coexistence` do `postMessage` serve só para a copy. **Isso contraria a §11.1** ("o `confirm` não assina" número sem app): sem o campo no GET, cumprir a §11.1 exigiria confiar no `postMessage` ou adiar a assinatura até o eco, com o risco do trial de 2 dias. O dono escolhe.
   **Decidido em 2026-10-14 (o dono delegou, conforme a recomendação):** o `confirm` não barra por `coexistence` e assina assim que o número aparece no GET. Não há coluna de Coexistence (`provider_coexistence` e `coexistence` do onboarding saem da migration): coluna sem produtor confiável não nasce. O custo aceito é o caso "número sem app": um canal assinado que nunca ativa, que a liberação do admin já autorizava, até o admin cancelar. O painel mostra "assinado há X sem eco" depois de 24 h. O portal usa o `coexistence === false` do `postMessage` só para avisar e não chamar o `confirm` sozinho. Adiar a assinatura até o eco foi descartado: se o trial vencer antes do eco, a Datafy para de entregar e o eco nunca chega, o que trava o canal sem assinar.
6. **Portal (Task 10).** O desenho da §5.8 vale como está: janela aberta de forma síncrona, origem `https://app.datafyapi.com.br`, `data.source === "datafy"` e `data.event === "connected"`, e "Já concluí a conexão" como reserva. Não precisa registrar domínio do parceiro.
7. **Não medidos, implementar pela doc com rede de segurança (Tasks 4 e 7):** `pause`, `resume`, `cancel`, `subscribe` repetido, `delete` com número. Corpo 2xx fora do esperado vira `unrecognized` com `shapeOf`. Depois de qualquer operação de admin, o estado efetivo vem de um GET, como o plano já diz.
8. **Webhook global (fora desta entrega).** Existe, mas a doc não diz se a entrega identifica o canal. Mantém-se o webhook por canal com `?channel=`.

## 5. Estado depois da rodada

- **Conta Datafy:** um canal, "Moralles Reservas - Canal Teste" (`6d869b02…`), assinado, com o número da Moralles e **sem webhook**. Ficou um link de conexão não usado (válido por 24 h) gerado pela medição do item 2.
- **Cobranças de hoje:** a assinatura do `66b8762d…` (engano; o dono resolveu no painel) e a do `6d869b02…` (autorizada).
- **No nosso sistema a Moralles está fora do ar:** o canal `7ef9d965…` aponta para credenciais de outro canal da Datafy, e o canal novo não tem webhook. Para voltar: criar o webhook do `6d869b02…` para o `webhook-whatsapp?channel=7ef9d965…`, gravar no nosso canal o `token` e o `webhook_secret` do `6d869b02…` (o `phone_number_id` não muda), refazer a prova de eco e ativar. É o que a ação `datafy_link_existing` (Task 7) vai cobrir; antes dela, só manualmente.
- **Token de conta:** revogar o `sk_acct_` usado nesta rodada (o `.env.local` está numa pasta do OneDrive) e gerar outro só para `platform_secrets`.
