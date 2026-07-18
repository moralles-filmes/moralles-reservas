# Runbook — Sandbox Asaas (gerar chave, cadastrar webhook, simular pagamento)

> Passo a passo pra quem **já tem a conta Sandbox**. Levantado da doc oficial em 2026-07-16. Fatos técnicos em [03-ASAAS-API-VERIFICADO.md](03-ASAAS-API-VERIFICADO.md).
>
> O que está marcado **NÃO VERIFICADO** veio de página que bloqueou leitura direta (403 na Central de Ajuda) — o rótulo do menu pode ter mudado. O caminho principal de cada passo foi confirmado na doc.

---

## 0. Antes de começar

- **Painel Sandbox: https://sandbox.asaas.com/** — a conta Sandbox é **separada** da de produção. Não existe login compartilhado; nada criado num ambiente aparece no outro. Pode usar o mesmo e-mail.
- **Só usuário administrador gera chave de API.** Não dá pelo app mobile.
- ⚠️ **E-mail e SMS funcionam de verdade no Sandbox.** Não cadastre e-mail/celular real de terceiro em cliente de teste.

---

## 1. Gerar a chave de API do Sandbox

1. Entre em https://sandbox.asaas.com/
2. **Menu do usuário → "Integrações" → aba "Chaves API" → "Gerar nova Chave de API"**
   - Se não achar o atalho: **"Minha conta" → aba "Integração" → "Chaves de API"** *(NÃO VERIFICADO — caminho alternativo)*
3. Dê um nome à chave (ex.: `moralles-reservas-sandbox`). Dá pra definir data de expiração.
4. **COPIE A CHAVE AGORA.** Ela é exibida **uma única vez**, na criação. Não tem como recuperar depois — só gerar outra.

**Formato esperado:** a chave de sandbox começa com **`$aact_hmlg_`** (produção é `$aact_prod_`).

**Regras que valem saber:**
- Até **10 chaves** por conta. Gerar uma nova **não revoga** as antigas — desabilite/exclua manualmente se quiser.
- Chave excluída **não** pode ser restaurada.
- **Inatividade:** 3 meses sem uso → desabilitada automaticamente. 6 meses → expirada permanentemente. (Relevante: se a Fase 2 ficar parada meses, a chave morre sozinha.)

---

> ⚠️ **A chave começa com `$` — isso quebra `supabase secrets set` em silêncio.** Sem aspas simples, PowerShell e bash leem `$aact_hmlg_...` como variável, expandem pra vazio e gravam **string vazia sem dar erro**. Use sempre:
>
> ```
> supabase secrets set ASAAS_API_KEY='$aact_hmlg_...'
> ```
>
> Confira com `supabase secrets list`: o campo `value` é o SHA-256 do valor. `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` é o hash da string vazia — se aparecer isso, a chave não entrou. Vale pro token do webhook (§3) também.

## 2. Cadastrar a chave no nosso painel

1. Entre no painel Moralles como **platform_admin** → `/platform/automacao`
2. Card **"Pagamentos — Configuração da Plataforma"** → seção **Asaas**
3. Cole em **`asaas_api_key`** e salve.

> ⏱ **A chave leva até 5 minutos pra valer em todas as Edge Functions.** Cada EF tem seu próprio cache de 5 min e o painel não consegue limpar o cache das outras (são isolates separados). Se salvou e a EF ainda usa a chave velha, **espere 5 minutos** — não é bug. Vale pra qualquer troca/rotação de chave.

---

## 3. Cadastrar o webhook

**Menu do usuário → "Integrações" → aba "Webhooks" → "Criar Webhook"**

| Campo | O que preencher |
|---|---|
| **Nome** | `moralles-reservas` |
| **URL** | `https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/asaas-webhook` |
| **E-mail** | Um e-mail **que você lê** — é por onde o Asaas avisa que a fila quebrou. Ver §5. |
| **Versão da API** | `3` |
| **Token de autenticação** | Clique em **"Gerar token"**. **32–255 chars**, sem espaços, não pode ser sequência óbvia nem uma chave de API do Asaas. **Só é mostrado na criação — copie.** |
| **Status** | Habilitado |
| **Tipo de envio** | `SEQUENTIALLY` (ordem garantida) ou `NON_SEQUENTIALLY` (concorrente, sem ordem). No sequencial, um evento lento atrasa os seguintes. |
| **Eventos** | Marque no mínimo: `PAYMENT_CREATED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_DELETED`. Lista completa (29 de cobrança + 7 de assinatura + 4 de checkout) na §4 da doc verificada. |

Depois: cole o token gerado em **`asaas_webhook_token`** no `/platform/automacao` (mesmo card, seção Asaas). Vale o mesmo cache de 5 min do passo 2.

> ⚠️ **A EF `asaas-webhook` precisa estar deployada antes** (`supabase functions deploy asaas-webhook`), senão toda entrega falha e queima o contador da §5.
>
> ⚠️ **A flag `asaas_enabled` está OFF.** Com ela OFF a EF responde 200 e **descarta** o evento sem gravar — de propósito (200 evita matar a fila). Pra testar de verdade, ligue a flag em `platform_flags`. Nada mais no sistema muda com ela ligada nesta fase.
>
> ⚠️ **Depois de ligar a flag, espere ~5 minutos antes de disparar o 1º evento de teste.** `checkFlagEnabled` cacheia por até 5 min — mesmo cache do passo 2. Se você acabou de observar o comportamento "OFF descarta sem gravar" acima, o isolate já rodou com `false` em cache; ligar a flag e clicar em "CONFIRMAR PAGAMENTO" logo em seguida corre o risco de cair DENTRO da janela do cache antigo → 200 sem gravar → **evento perdido pra sempre** (o Asaas marca como entregue e não reenvia). Se o log mostrar `asaas_webhook_flag_off` no primeiro evento depois de ligar a flag, é isso — não é o webhook quebrado, é o cache. Espere os 5 minutos e dispare de novo.

Limite: **10 webhooks** por conta.

---

## 4. Simular um pagamento

1. Crie um cliente (`name` + `cpfCnpj` — use um CPF válido de gerador tipo 4Devs; o Asaas valida o formato).
2. Crie uma cobrança com `billingType` `BOLETO` ou `PIX`.
3. Abra a cobrança no painel → botão **"CONFIRMAR PAGAMENTO"** → dispara `PAYMENT_CREATED` → `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` e credita saldo fictício.
   - Cobrança de **cartão** em `CONFIRMED` mostra **"RECEBER PAGAMENTO"** no lugar.
   - Equivalente por API (só sandbox): `POST https://api-sandbox.asaas.com/v3/sandbox/payment/{id}/confirm`

**Alternativa — "Confirmar recebimento em dinheiro"** *(caminho NÃO VERIFICADO)*: Cobranças → Todas → clique na cobrança → "Mais ações" → "Confirmar recebimento em dinheiro". Dispara `PAYMENT_RECEIVED` com `billingType: RECEIVED_IN_CASH` e **não credita saldo** (registra pagamento fora da plataforma). API: `POST /v3/payments/{id}/receiveInCash`.

**Cartões de teste** (o resultado depende só do número, não do valor):
- **Aprovado:** `4444 4444 4444 4444`, validade futura qualquer, CVV `123`
- **Recusado:** Mastercard `5184019740373151` · Visa `4916561358240741`

**Não dá pra testar no sandbox:** chargeback (precisa falar com o time deles), QR Pix embutido no boleto, desconto/juros/multa em boleto/Pix, notificação WhatsApp, simulação de antecipação. Transferência Pix só pras chaves de teste do BACEN.

---

## 5. ⚠️ Se o webhook parar de funcionar — leia isto

Esta é a parte que mais dói se for ignorada:

- O Asaas considera entrega bem-sucedida **apenas HTTP 200**. Qualquer outro código (inclusive 201/204) é **falha**.
- **15 falhas consecutivas → a fila daquele webhook é interrompida** e para de entregar.
- Os eventos continuam enfileirados por **14 dias** — e depois são **apagados PERMANENTEMENTE**.
- **O único aviso é um e-mail** (pro endereço do passo 3). Por isso o e-mail tem que ser um que você lê.

**Onde investigar:** Menu do usuário → **Integrações → "Logs de Webhooks"**. Mostra evento enviado, data/hora, endpoint, **código HTTP que a nossa aplicação devolveu**, erros de timeout e quantas tentativas rolaram.

**Como reativar:** no painel (Integrações → Webhooks → reativar) ou via API (`interrupted: false`). Os pendentes são reprocessados **em ordem cronológica**.

**Timeout:** o Asaas espera **10 segundos** pela resposta. Estourou = "Read Timed Out" = falha.

**O que a nossa EF faz de propósito:** responde `503` quando **não consegue gravar** o evento (aí o Asaas repete e o evento se salva) e `200` quando gravou ou descartou deliberadamente. Ver `asaas-webhook/index.ts`. `503` nos Logs de Webhook **não é bug** — é o sistema pedindo reenvio em vez de perder o evento. O que **é** bug: `401` (token errado/não cadastrado) e `500` (token não configurado no `platform_secrets`).

---

## 6. Cutover pra produção (Fase 11 — não é agora)

- Gerar chave **de produção** (prefixo `$aact_prod_`) e trocar `asaas_api_key`.
- `ASAAS_ENV=production` via `supabase secrets set`.
- Cadastrar o webhook **de novo** no painel de produção (ambientes são separados) com token novo.
- Chave de prod contra host de sandbox (ou vice-versa) devolve **401 `invalid_environment`**. Nosso guard tenta pegar isso antes, pelo prefixo — mas **chave gerada antes de 10/03/2025 não tem prefixo de ambiente** e passa como "inconclusiva" (§8 da doc verificada).
