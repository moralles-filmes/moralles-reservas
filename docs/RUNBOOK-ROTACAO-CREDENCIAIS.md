# Runbook — rotação de credenciais

Onde cada credencial vive, como cadastrar a nova e como confirmar que pegou. Nenhum valor aparece aqui.

**Janela ideal:** enquanto `asaas_enabled`, `whatsapp_implementation_flow` e `whatsapp_subscription_checkout` estiverem **OFF** e o Asaas estiver em sandbox, rotacionar é barato — não há cobrança em trânsito para perder na janela entre trocar de um lado e do outro. Depois do go-live, cada troca tem uma janela de erro real.

---

## 1. Asaas — chave de API e token de webhook

**Onde vivem:** tabela `platform_secrets` (FORCE RLS, o `value` nunca volta para o frontend — a UI só mostra `last4`), chaves `asaas_api_key` e `asaas_webhook_token`. Lidas por [_shared/asaas-config.ts](../supabase/functions/_shared/asaas-config.ts), com fallback para `Deno.env` (`ASAAS_API_KEY` / `ASAAS_WEBHOOK_TOKEN`) quando não há linha no banco.

**Como cadastrar a nova:** painel **Plataforma → Automação** (`/platform/automacao`), campos "Chave da API (Access Token)" e "Token de autenticação do webhook". A tela chama a Edge Function `manage-platform-secrets`, que só aceita `platform_admin`. **Não** dá para cadastrar por SQL sem perder a limpeza de cache que a EF dispara.

**Ordem — chave de API:**
1. Gerar a nova no painel do Asaas (isso invalida a antiga na hora).
2. Cadastrar imediatamente em `/platform/automacao`.

**Ordem — token de webhook:**
1. Cadastrar o novo token em `/platform/automacao` **primeiro**.
2. Atualizar em seguida no painel do Asaas (campo do header `asaas-access-token`).

Entre os dois passos, todo evento que chegar é recusado com 401. O Asaas reentrega, mas **15 falhas consecutivas interrompem a fila de eventos de todos os clientes** — por isso a janela tem que ser curta, e por isso rotacionar com as flags OFF é o momento certo.

**Pegadinha do cache (a mais fácil de errar):** cada Edge Function é seu próprio isolate com sua própria cópia do módulo, e o cache de config tem TTL de 5 minutos **sem invalidação cross-isolate**. Uma chave rotacionada pode levar até 5 minutos para valer em todo lugar. Se o teste logo após a troca falhar, espere e repita antes de concluir que deu errado.

**Fallback de ambiente:** se `ASAAS_API_KEY` ou `ASAAS_WEBHOOK_TOKEN` ainda existirem como secret de Edge Function, eles seguem valendo sempre que a linha do banco estiver ausente. Confira com `supabase secrets list` e remova os que sobraram — senão você rotaciona no banco e um valor antigo continua aceito por outro caminho.

**Como confirmar:** um POST ao `asaas-webhook` com o token **errado** tem que devolver 401, e com o novo tem que passar. Não valide só o caminho feliz — o caminho que precisa falhar é o que prova que a troca aconteceu.

---

## 2. Z-API — secret de webhook por canal

**Onde vive:** coluna `whatsapp_channels.webhook_secret` (tabela FORCE RLS, sem policies — a UI acessa via Edge Function). Validada em [_shared/whatsapp-providers.ts](../supabase/functions/_shared/whatsapp-providers.ts) (`validateChannelSecret`), que aceita o header `x-webhook-secret` **ou** a query string `?secret=`. A Z-API não permite header customizado no webhook, então na prática o valor viaja na URL — e é por isso que ele aparece em log de gateway e merece rotação periódica.

**A lacuna estrutural:** `manage-channels` gera o secret **só na ação `create`**. A ação `update` preserva o secret de propósito (para trocar o Client Token da Z-API sem invalidar o webhook já configurado). **Não existe ação de rotação.** Então há dois caminhos:

- **(a) Recriar o canal** pela tela **Gestão → Automação** (`/g/:slug/automacao`): gera secret novo, mas **muda o `channel_id`**, ou seja, muda a URL inteira do webhook. É preciso reconfigurar no painel da Z-API.
- **(b) UPDATE direto** em `whatsapp_channels.webhook_secret` (precisa de `service_role`, a tabela é FORCE RLS). Preserva o `channel_id`; só o parâmetro `secret=` da URL muda. É DML pontual, não migration — a regra de nunca colar SQL no Studio vale para **migrations** (que gravam `schema_migrations` com timestamp divergente e travam o próximo `db push`); um UPDATE de dado não tem esse efeito.

Depois de qualquer um dos dois, a URL completa e já pronta para colar na Z-API aparece na tela **Gestão → Automação**, no card do canal.

**Verifique também o fallback global:** o webhook resolve `channel.webhook_secret ?? Deno.env.get("ZAPI_WEBHOOK_SECRET")`. Se algum canal tiver a coluna nula **e** o secret global antigo ainda estiver cadastrado como secret de Edge Function, o valor antigo continua aceito. Confira `supabase secrets list` e remova `ZAPI_WEBHOOK_SECRET` se não houver canal dependendo dele. (Com secret vazio nos dois lados, `validateChannelSecret` recusa — falha fechada, não aberta.)

**Como confirmar:** POST em `webhook-whatsapp?channel=<id>&secret=<antigo>` tem que devolver não autorizado; com o novo, tem que ser aceito. O endpoint legado `webhook-zapi` responde **410 Gone** e não valida nada — testar contra ele não prova coisa alguma.

---

## 3. Resend — chave de API

**Onde vive:** variável de ambiente das Edge Functions, `RESEND_API_KEY` (mais `RESEND_FROM_EMAIL`). Lida por [_shared/email.ts](../supabase/functions/_shared/email.ts).

**Consumidores reais** (só estes dois importam o helper): `process-billing-notifications` e `send-confirmation`.

**Como cadastrar:**

```bash
supabase secrets set RESEND_API_KEY=<nova>
# se o remetente também mudar:
supabase secrets set RESEND_FROM_EMAIL=<endereco>
```

Depois **redeploye os dois consumidores** — isolate quente pode seguir com o valor antigo em memória até reciclar:

```bash
supabase functions deploy process-billing-notifications
supabase functions deploy send-confirmation
```

**Como confirmar:** `sendEmail` degrada em silêncio quando não há chave — devolve `{ ok:false, skipped:true, reason:"no_api_key" }` e loga `email_skipped`. Ou seja, **chave errada não quebra nada visível**: os avisos simplesmente param de sair. Confirme por um envio real (uma notificação de billing pendente na fila, ou uma confirmação de reserva) e olhe o log procurando `email_sent`.

---

## 4. `INTERNAL_API_KEY` — a que mora em dois lugares

Não estava entre as credenciais expostas, mas se a rotação for geral, esta é a que mais quebra quando feita pela metade.

Ela precisa estar **nos dois lugares**:

```bash
supabase secrets set INTERNAL_API_KEY=<nova>
```

e no Supabase Vault, sob o nome `internal_api_key`, que é de onde os wrappers `SECURITY DEFINER` do `pg_cron` leem para montar o header `x-internal-key`.

Rotacionar só no primeiro faz **todos os workers automáticos pararem em silêncio** — o `pg_net.http_post` é fire-and-forget, então a chamada falha com 401 e ninguém recebe erro. O sintoma aparece dias depois, como lembrete que não saiu e outbox que não drenou.

**Como confirmar:** depois de trocar nos dois, espere o próximo ciclo do `process-notification-outbox` (roda a cada minuto) e verifique que a fila drenou.

---

## Depois de rotacionar

Toda credencial cadastrada por comando de terminal vira parte do comando — e, no Claude Code, o comando pode acabar na allowlist de permissões (`.claude/settings*.json`), que é onde as cinco credenciais expostas foram parar. Prefira cadastrar pelo painel quando houver painel, e quando for terminal, use variável de ambiente em vez do valor literal:

```bash
$env:K = "<valor>"        # PowerShell
supabase secrets set RESEND_API_KEY=$env:K
$env:K = $null
```

Esses arquivos são git-ignored (`.claude/*`) e nunca foram versionados — o risco não é o GitHub, é o OneDrive e toda sessão de agente que lê a configuração local.
