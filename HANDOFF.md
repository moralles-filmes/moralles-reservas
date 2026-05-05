# HANDOFF — Diagnóstico do Webhook Z-API + Próximos Passos

> Documento de transferência de contexto. Cole o conteúdo da seção
> **"Briefing para o Claude Code"** num chat novo do Claude Code (Antigravity)
> e siga as etapas dos **Scripts de teste**.

---

## 1) Contexto do projeto

- **Pasta**: `C:\Users\morae\OneDrive\Desktop\APPs AI\2. Aplicativos - Moralles\6. Moralles reservas\moralles-reservas`
- **Supabase project ref**: `gbabxcrntkwgblgqsiit`
- **Stack**: Vite + React + TypeScript (frontend) / Supabase Edge Functions em Deno (backend) / Z-API (WhatsApp) / Anthropic Claude (IA)
- **4 Edge Functions deployadas**: `webhook-zapi`, `send-whatsapp`, `send-confirmation`, `manage-admins`
- Detalhes completos no `CLAUDE.md` da raiz do projeto.

## 2) O que já foi feito

- Migrations 001–011 aplicadas no Supabase.
- Secrets do Supabase setados via `supabase secrets set`:
  - `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`
  - `ZAPI_WEBHOOK_SECRET` (hex 64 chars), `INTERNAL_API_KEY` (hex 64 chars)
  - `ANTHROPIC_API_KEY`
- 4 Edge Functions deployadas com `--no-verify-jwt`.
- Z-API "Webhooks → Ao receber" apontando para:
  ```
  https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-zapi?secret=<ZAPI_WEBHOOK_SECRET>
  ```
- Database Webhook em `reservations INSERT` → `send-confirmation`, com header `X-Internal-Key: <INTERNAL_API_KEY>`.
- Edição feita em `supabase/functions/_shared/security.ts`: `validateWebhookSecret` agora aceita o secret tanto via header `X-Webhook-Secret` quanto via query string `?secret=...` (Z-API não permite header customizado nessa instância).
- Edição feita em `supabase/functions/webhook-zapi/index.ts`:
  - Log `request_received` no topo do handler (debug).
  - Log `incoming_payload_debug` após `req.json()`.
  - Parser tolerante a múltiplos formatos da Z-API (`isFromMe`/`fromMe`, `text.message`/`text.body`/`body`/`message.text`).

## 3) O bug atual

**Sintoma 1**: Acessando `https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-zapi` no navegador via GET, retorna `{"error":"unauthorized"}` em formato JSON. Mas o nosso código retorna `new Response("unauthorized", { status: 401 })` (texto plano). **Esse JSON parece vir do gateway do Supabase antes mesmo de chegar na função.**

**Sintoma 2**: Mensagens do WhatsApp chegam na Z-API (confirmado no painel da Z-API) mas **nenhum log da função aparece** quando isso acontece — não vejo `request_received`, nem `webhook_unauthorized`, nem `incoming_payload_debug`. Os únicos logs são `Listening on...` e `booted` / `shutdown` (boots de cold start).

**Sintoma 3**: No painel do Supabase, em Edge Functions → `webhook-zapi` → Settings, o toggle **"Verify JWT with legacy secret"** está em OFF. Ainda assim a resposta JSON do gateway aparece.

## 4) Hipóteses a testar

1. **`verify_jwt` ainda está ativo apesar do toggle OFF** — talvez o `--no-verify-jwt` não foi persistido, ou existe algum nível de auth do projeto sobrepondo. Solução: configurar via `supabase/config.toml` e re-deploy.
2. **Z-API não está chegando até o Supabase** — talvez a URL salva tem typo, ou o "Salvar" não foi clicado, ou a Z-API deslogou do WhatsApp.
3. **Algum middleware do Supabase está bloqueando antes** — checar headers da resposta do `curl`.
4. **Função é deployada mas o slug remoto está em outro estado** — verificar `supabase functions list` e comparar timestamps.

## 5) Briefing para o Claude Code

```
Estou debugando um problema com Edge Functions do Supabase no projeto 
moralles-reservas (sistema de reservas de restaurante via WhatsApp + IA).

Pasta do projeto: C:\Users\morae\OneDrive\Desktop\APPs AI\2. Aplicativos - Moralles\6. Moralles reservas\moralles-reservas
Supabase project ref: gbabxcrntkwgblgqsiit

O que já foi feito e o que está acontecendo está documentado em detalhe 
no arquivo HANDOFF.md na raiz do projeto. POR FAVOR LEIA ESSE ARQUIVO 
ANTES DE COMEÇAR. Também há um CLAUDE.md com a arquitetura completa do 
sistema.

Resumo do problema:
- Endpoint https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-zapi 
  retorna {"error":"unauthorized"} (JSON) quando acessado, mas o código 
  retorna texto plano "unauthorized". Suspeita: o gateway do Supabase está 
  bloqueando antes da função.
- Mensagens da Z-API chegam mas não geram nenhum log na Edge Function. 
  Nem mesmo o log de debug `request_received` que adicionei no topo do 
  handler.

Por favor, execute o plano de diagnóstico descrito na seção 6 do HANDOFF.md 
("Scripts de teste") e me reporta o resultado de cada passo. Pode editar 
arquivos do projeto e re-deployar Edge Functions livremente — eu valido 
depois. Foco em descobrir POR QUE os requests não chegam até a função.

Quando o webhook estiver respondendo, valide enviando uma mensagem real 
do WhatsApp para o número da instância Z-API e confirma que o bot 
respondeu automaticamente.
```

## 6) Scripts de teste (rodar em sequência)

> Roda no terminal do Antigravity. PowerShell ou Git Bash funciona.
> A maioria dos comandos precisa de `curl` e `supabase` CLI já instalados.

### 6.1) Confirmar deploy state e logs do remoto

```bash
# Listar funções e ver quando foram deployadas
supabase functions list

# Ver logs em tempo real (deixa rodando em outro terminal)
supabase functions logs webhook-zapi --tail
```

### 6.2) Testar resposta crua via curl (sem nada)

```bash
curl -i -v -X GET "https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-zapi"
```

**O que olhar**:
- O cabeçalho `Server:` ou `via:` revela se passou pelo gateway.
- Se o body for `{"error":"unauthorized"}` → veio do gateway (JWT ainda ativo).
- Se o body for `unauthorized` (texto plano) → chegou na função, retornou o nosso 401.
- Verificar header `Content-Type` da resposta: `application/json` = gateway; `text/plain` = nossa função.

### 6.3) Testar com a flag de no-verify-jwt explícita no deploy

```bash
cd "C:/Users/morae/OneDrive/Desktop/APPs AI/2. Aplicativos - Moralles/6. Moralles reservas/moralles-reservas"

supabase functions deploy webhook-zapi --no-verify-jwt --debug
supabase functions deploy send-whatsapp --no-verify-jwt --debug
supabase functions deploy send-confirmation --no-verify-jwt --debug
```

Depois repete o `curl` da etapa 6.2 e observa se mudou.

### 6.4) Configurar via `supabase/config.toml` (forma persistente)

Se o `--no-verify-jwt` no deploy não estiver pegando, configurar o arquivo `supabase/config.toml` na raiz do projeto. Adicionar/editar:

```toml
[functions.webhook-zapi]
verify_jwt = false

[functions.send-whatsapp]
verify_jwt = false

[functions.send-confirmation]
verify_jwt = false

[functions.manage-admins]
verify_jwt = true
```

E redeployar:

```bash
supabase functions deploy webhook-zapi
supabase functions deploy send-whatsapp
supabase functions deploy send-confirmation
supabase functions deploy manage-admins
```

### 6.5) Testar POST com payload Z-API simulado (secret correto)

> Substituir `<ZAPI_WEBHOOK_SECRET>` pelo valor real que está nos secrets.
> Para descobrir, ver no `.env` (se foi anotado lá), no gerenciador de
> senhas, ou rotacionar gerando um novo no PowerShell:
> `-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })`
> e atualizar com `supabase secrets set ZAPI_WEBHOOK_SECRET="..."`.

```bash
curl -i -X POST "https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-zapi?secret=<ZAPI_WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999999999",
    "text": { "message": "oi teste" },
    "isFromMe": false,
    "messageId": "test-msg-001"
  }'
```

**Esperado**:
- Status `200 OK`
- Logs no Supabase com `request_received`, `incoming_payload_debug` e `agent_usage`.
- Tentativa de envio para Z-API (provavelmente vai falhar para o número fake `5511999999999`, mas o log `zapi_send_failed` mostra que o fluxo chegou até lá).

### 6.6) Confirmar headers do request (com `-v` verbose)

```bash
curl -v "https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-zapi"
```

Verificar o response completo, em especial `< Server:`, `< X-Sb-...`, e o body. Se o `Server` for `cloudflare` ou `kong`, é o gateway; se for `deno-deploy` ou similar, chegou na função.

### 6.7) Conferir Z-API está realmente disparando

No painel da Z-API, ir em **"Histórico"** ou **"Logs de webhook"** ou **"Eventos"** (a localização exata varia por versão). Filtrar pelos últimos eventos. Olhar:
- Status code que a Z-API recebeu da nossa função (200 = OK, 401 = secret errado, 5xx = erro nosso).
- Se nenhum evento aparecer = Z-API não está disparando o webhook (URL salva errada, ou WhatsApp desconectado).

### 6.8) Confirmar que a instância Z-API está conectada

No painel Z-API, aba **"Dados da instância web"**. Status precisa estar como **conectado / online**. Se estiver pedindo QR Code, escanear novamente com o WhatsApp do número.

### 6.9) Logs em tempo real durante teste real

```bash
# Terminal 1 — deixa rodando
supabase functions logs webhook-zapi --tail

# Pega o celular pessoal e manda "oi" para o número da instância Z-API
# Terminal 1 deve mostrar logs em ~5 segundos
```

## 7) Sinais de sucesso

Quando funcionar, no `--tail` da função você vai ver, em sequência (em ~10 segundos após mandar a mensagem):

```
{"level":"info", "evt":"request_received", ...}
{"level":"info", "evt":"incoming_payload_debug", "keys":["phone","text",...], "sample":"{...}"}
{"level":"info", "evt":"agent_usage", "provider":"claude", "input_tokens":1234, ...}
```

E o WhatsApp do remetente recebe a resposta do bot.

## 8) Próximos passos depois que o webhook estiver funcionando

### 8.1) Remover os logs de debug temporários

Em `supabase/functions/webhook-zapi/index.ts`, remover:
- O bloco `request_received` no topo do handler.
- O bloco `incoming_payload_debug` logo após `req.json()`.

Manter o parser tolerante (`isFromMe || fromMe`, múltiplas extrações de texto) — é robustez genuína.

Redeployar: `supabase functions deploy webhook-zapi --no-verify-jwt`.

### 8.2) Subir o frontend (admin + landing pública)

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
# Editar .env.local com VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
npm run dev
```

Acessar `http://localhost:8080/auth` e fazer login com o e-mail super_admin (`morallesfilms@gmail.com`).

### 8.3) Configurar dados do restaurante (no painel admin)

- **/admin/configuracoes → "Instruções do Agente IA"**: cola endereço, estacionamento, formas de pagamento, dress code, ticket médio, política de couvert, política de pet, cardápio resumido (sem preços específicos), políticas de reserva, regras de escalonamento (eventos privados → contato humano), tom de voz.
- **/admin/configuracoes → "Horários de funcionamento"**: revisar e ajustar para a realidade do restaurante.
- **/admin/mesas**: cadastrar todas as mesas reais (número + capacidade + interna/externa).
- **/admin/configuracoes → "Datas especiais"**: feriados e dias com horário diferente.

### 8.4) Deploy do frontend na Vercel

```bash
# Já tem .npmrc com legacy-peer-deps=true
# No painel Vercel:
# - Connect repo
# - Framework: Vite (auto)
# - Env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
# Após deploy, atualizar Site URL no Supabase Auth Settings.
```

### 8.5) Configurar Database Webhook em produção

Já está configurado no Supabase (criado pela tela de Database Webhooks). Quando uma reserva é criada via formulário público, dispara `send-confirmation` automaticamente.

### 8.6) (Opcional, depois) Setup do n8n para lembrete D-1 e pesquisa D+1

Documentado em `docs/n8n/README.md` (se existir) ou pode ser substituído por `pg_cron` direto no Supabase. Não é bloqueante.

## 9) Arquivos relevantes

```
moralles-reservas/
├── CLAUDE.md                                    # Arquitetura completa
├── HANDOFF.md                                   # Este arquivo
├── .env.example                                 # Template de envs
├── supabase/
│   ├── functions/
│   │   ├── _shared/
│   │   │   ├── security.ts                      # validateWebhookSecret (header + query string)
│   │   │   ├── ai-providers.ts                  # Multi-provider IA
│   │   │   └── retry.ts
│   │   ├── webhook-zapi/index.ts                # Recebe Z-API → IA → responde (DEBUG ATIVO)
│   │   ├── send-whatsapp/index.ts               # POST p/ Z-API send-text
│   │   ├── send-confirmation/index.ts           # Disparo no INSERT de reservation
│   │   └── manage-admins/index.ts               # CRUD admins (precisa JWT)
│   ├── migrations/                              # 001–011
│   └── config.toml                              # (criar/editar conforme 6.4)
└── src/                                         # Frontend Vite/React
```

## 10) Mensagem de status que devolveria pra mim no Cowork

Depois de resolver o webhook lá, se quiser continuar comigo no Cowork pros próximos passos (configurar restaurante, deploy Vercel, ajustar prompt da IA, etc), volta e me conta:

- O que era o bug (`verify_jwt`? URL errada? Z-API desconectada?)
- O que mudou (arquivos editados, configurações)
- Se já mandou mensagem real e o bot respondeu

Aí seguimos a partir da seção 8.
