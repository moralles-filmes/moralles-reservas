# Fase 4a — Runbook de Deploy (passo a passo)

> Branch `billing-asaas/fase-4`. Código completo e revisado; **nada aplicado em
> produção**. Este doc é a Task 13 (deploy + validação ao vivo), sob seu controle.
> Complementa o [FASE-4A-RESUMO.md](FASE-4A-RESUMO.md) com o **como fazer** exato.

## Princípios que valem pro runbook inteiro

- **A flag `asaas_enabled` é o gate mestre.** Com ela OFF: `create-billing-checkout`
  recusa (503) e `asaas-webhook` descarta o evento (200 sem persistir). Nada de
  Asaas acontece até você ligá-la. É também o kill switch.
- **Uma só infra.** Há **1 projeto Supabase** e **1 conta Asaas** com dois modos
  (sandbox/produção) alternados pelo secret `ASAAS_ENV`. Não há staging separado:
  "validar em sandbox" = apontar a stack real pro Asaas sandbox, validar, e só
  então trocar `ASAAS_ENV` pra produção.
- **Blast radius da janela de validação = zero.** Os 2 clientes são vitalícios
  (não veem a oferta) e você mesmo cria as orgs. Ninguém real contrata no meio.

## Onde achar as coisas

| Coisa | Onde |
|---|---|
| `PROJECT_REF` (ref do Supabase) | no `VITE_SUPABASE_URL` (`https://<REF>.supabase.co`) ou Dashboard → Project Settings → API |
| Painel de secrets da plataforma | `/platform/automacao` (logado como super-admin) |
| SQL Editor | Supabase Dashboard → SQL Editor |
| CLI Supabase | o mesmo que você usa pro `db push` |

## Mapa dos passos

| # | Passo | Reversível? |
|---|---|---|
| 0 | Configurar ambiente Asaas (sandbox): `ASAAS_ENV` + chave + token do webhook | sim |
| 1 | Deploy das 5 Edge Functions | sim (redeploy) |
| 2 | `db push` da migration 066 (ativa o plano) | sim (rollback SQL) |
| 3 | Ligar a flag `asaas_enabled` | sim (flip pra false) |
| 4 | Cadastrar o webhook no painel Asaas | sim |
| 5 | Validar os 6 cenários em sandbox (cenário 2 = HARD GATE) | — |
| 6 | Merge da branch → `main` (frontend na Vercel) | difícil |
| 7 | Go-live: trocar sandbox → produção | — |

---

## PASSO 0 — Configurar o ambiente Asaas (sandbox)

Pré-requisito de tudo: sem a chave e o token gravados, o checkout e o webhook não
têm com o que trabalhar.

### 0.1 — Secret de ambiente da Edge Function

```powershell
supabase secrets set ASAAS_ENV=sandbox
```

Por quê: `getAsaasEnv()`/`getAsaasBaseUrl()` leem `ASAAS_ENV` → `sandbox` aponta pra
`api-sandbox.asaas.com`. O default já é `sandbox`, mas set explícito evita surpresa.
Não precisa setar `ASAAS_API_KEY` como secret de EF — a chave vem do `platform_secrets`
(passo 0.2); o env é só fallback legado.

### 0.2 — Gravar a chave da API e o token do webhook (painel)

Em **`/platform/automacao`**, na seção de secrets da plataforma, grave:

- **`asaas_api_key`** = a chave **SANDBOX** (`$aact_hmlg_...`) — a mesma da sonda.
- **`asaas_webhook_token`** = um token que **você gera**, 32–255 chars. Guarde:
  ele vai idêntico no painel do Asaas (passo 4).

Gerar um token aleatório (PowerShell):

```powershell
-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
```

Por quê: `manage-platform-secrets` grava em `platform_secrets` (FORCE RLS, o valor
nunca volta ao frontend — só o `last4`). O `asaas-webhook` autentica comparando o
header `asaas-access-token` da requisição com esse `asaas_webhook_token`, em tempo
constante.

---

## PASSO 1 — Deploy das 5 Edge Functions

```powershell
supabase functions deploy create-billing-checkout
supabase functions deploy asaas-webhook
supabase functions deploy process-asaas-reconcile
supabase functions deploy manage-billing
supabase functions deploy manage-organizations
```

- Esse é o conjunto autoritativo: arquivos alterados na branch + quem importa os
  `_shared` mudados (`asaas-billing-events.ts`, `-apply.ts`, `asaas.ts`,
  `billing-provider.ts`, `tax-id.ts`).
- **`manage-platform-secrets` NÃO entra** — importa só `asaas-config.ts`, que não
  mudou. Redeployá-la é inofensivo, só desnecessário.
- `config.toml` já tem `verify_jwt` certo (`asaas-webhook` e
  `process-asaas-reconcile` = `false`; os três `manage-*`/`create-billing-checkout`
  = `true`). Não mexa.
- Cada comando deve terminar com "Deployed Function ...".

---

## PASSO 2 — Aplicar a migration 066 (ativa o plano)

```powershell
supabase db push --dry-run
supabase db push
```

- **Rode o `--dry-run` primeiro** e confirme que a **única** migration pendente é a
  `20260719120000_066_activate_sistema_reservas.sql`, sem drift.
- O que faz: `update billing_plans set active=true where slug='sistema-reservas'`,
  seguido de um bloco `DO` que valida existir **exatamente 1** plano
  `sistema-reservas` ativo com `provider='asaas'` (senão levanta exceção e desfaz).
- **Se o dry-run acusar drift: PARE.** Não cole SQL no Studio. Rode
  `supabase migration repair --status ...` conforme a mensagem e me chame.
- Rollback: `update billing_plans set active=false where slug='sistema-reservas';`

Com a flag ainda OFF (passo 3), ativar o plano aqui não expõe checkout funcional —
o botão apareceria mas o `create-billing-checkout` responde 503. Seguro.

---

## PASSO 3 — Ligar a flag `asaas_enabled`

Não há UI pra flags (`platform_flags` é FORCE RLS, só leitura via
`platform-flags.ts`). É um **UPDATE de dado**, não uma migration de schema — não
toca `schema_migrations`, então o SQL Editor é o caminho certo aqui (a regra
"nunca SQL no Studio" é sobre migrations de schema, não sobre um toggle de config).

No **SQL Editor**:

```sql
update platform_flags set value = 'true'::jsonb, updated_at = now()
where key = 'asaas_enabled';

select key, value from platform_flags where key = 'asaas_enabled';  -- deve vir true
```

- Por quê agora: liga as **duas pontas juntas** — `create-billing-checkout` para de
  dar 503 e `asaas-webhook` para de descartar. Ligar só uma perderia pagamento.
- ⏱ **Cache de 5 min:** `platform-flags.ts` cacheia a flag por 5 min. Depois do
  UPDATE, espere até 5 min **ou** redeploye as EFs pra bustar o cache antes de
  validar.
- Kill switch: a mesma query com `'false'` (mas veja a ressalva no fim do doc —
  pra **parar vendas** sem perder eventos, prefira desativar o plano).

---

## PASSO 4 — Cadastrar o webhook no painel Asaas (sandbox)

Painel **Asaas SANDBOX** → **Integrações → Webhooks → Adicionar**:

- **URL:** `https://<PROJECT_REF>.supabase.co/functions/v1/asaas-webhook`
- **Token de autenticação:** EXATAMENTE o `asaas_webhook_token` do passo 0.2 (o
  Asaas o envia no header `asaas-access-token`).
- **Fila / versão:** ativa ("Sincronizado"/enabled).
- **Eventos:** marque os de **pagamento** — no mínimo `PAYMENT_CONFIRMED`,
  `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`; e os de
  assinatura/checkout se o painel oferecer. (A 4a só reage a
  `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` pra ativar; o resto é pra 4b, mas cadastrar
  agora evita re-mexer.)
- ⚠ **Não confunda** com o "webhook de status da mensagem" — aquele é do
  WhatsApp/Z-API, outro produto. Aqui é o webhook de **cobrança** do Asaas.

Teste rápido de auth: se o painel tiver "enviar evento de teste", dispare — deve
voltar **200**. `401` = token diferente. `500` = `asaas_webhook_token` não gravado.

---

## PASSO 5 — Validar em sandbox (stack real, `ASAAS_ENV=sandbox`)

Pra dirigir o checkout pela interface, use o **preview da Vercel da branch** (todo
push da branch gera uma URL de preview) — a produção do site fica intocada até o
passo 6. Alternativa: invocar as EFs direto (comandos abaixo).

> Pra ter o preview: `git push origin billing-asaas/fase-4` (é a **branch**, não a
> `main`). Antes, reconfirme o diff sem secret — a revisão final já passou limpa.

### Cenário 2 — HARD GATE (faça PRIMEIRO): herança do `externalReference`

Prova que a cobrança **nascida do checkout hospedado** carrega o
`externalReference` — é dele que a ativação depende (largamos o `customer`).

1. No preview, logado como owner de uma **org de teste NÃO-vitalícia**, abra
   `/g/<slug>/cobranca` (ou o onboarding) e contrate **"Sistema de reservas"
   (R$ 449)**.
2. Você é redirecionado ao checkout Asaas (sandbox). **Pague com cartão de teste do
   sandbox** (pegue um cartão de teste aprovado na doc do Asaas; o CPF
   `529.982.247-25` que a sonda usou serve).
3. Confira (SQL Editor):
   ```sql
   select event_type, processing_status, processing_error
   from billing_events order by created_at desc limit 5;
   select billing_status from organizations where id = '<org_id>';
   select status from billing_subscriptions where organization_id = '<org_id>';
   ```
   **Esperado:** um `PAYMENT_CONFIRMED` com `processing_status='processed'`,
   `organizations.billing_status='active'`, assinatura `active`.
   - ✅ Ativou → **gate vencido**, deploy validado.
   - ❌ Ficou `failed` por não achar `orgId`/`planId` → a herança falhou. **Pare e
     me chame** — aplico a mitigação (coletar endereço no onboarding + reamarrar o
     `customer` pra ter o fallback por `asaas_customer_id`).

> **De-risk opcional ANTES do deploy:** aponte o webhook do Asaas pra uma URL
> `webhook.site` descartável, abra o link do checkout 2d que a sonda gerou, pague, e
> leia o payload lá. Prova a herança **e** o shape do payload sem tocar na sua infra.

### Cenários 5 e 6 — eventos forjados direto no webhook (não precisam de checkout)

```powershell
$TOKEN = '<asaas_webhook_token>'
$REF   = '<PROJECT_REF>'

# Cenário 6 — evento ativador SEM payment.id → espera processing_status='failed'
curl.exe -sS -X POST "https://$REF.supabase.co/functions/v1/asaas-webhook" `
  -H "asaas-access-token: $TOKEN" -H "content-type: application/json" `
  -d '{\"event\":\"PAYMENT_CONFIRMED\",\"payment\":{\"object\":\"payment\"}}'

# Cenário 5 — org inexistente em billing_customers → espera 'failed'
curl.exe -sS -X POST "https://$REF.supabase.co/functions/v1/asaas-webhook" `
  -H "asaas-access-token: $TOKEN" -H "content-type: application/json" `
  -d '{\"event\":\"PAYMENT_CONFIRMED\",\"payment\":{\"object\":\"payment\",\"id\":\"pay_fake\",\"externalReference\":\"org:00000000-0000-0000-0000-000000000000|plan:00000000-0000-0000-0000-000000000000|purpose:subscription\"}}'
```

Ambos devem responder **HTTP 200** (o webhook quase sempre responde 200 — ver header
do `asaas-webhook/index.ts`). O que prova o cenário é a linha ficar **`failed`**, não
`processed`. Confira:

```sql
select event_type, processing_status, processing_error
from billing_events order by created_at desc limit 5;
```

### Cenário 3 — `getPayment` inalcançável (Asaas fora do ar)

Difícil simular de fora. Duas opções:
- **Simular:** `supabase secrets set ASAAS_BASE_URL=http://127.0.0.1:9` (porta morta),
  redeploy `asaas-webhook`, mande um `PAYMENT_RECEIVED` forjado → o orçamento de 5s
  estoura → `failed`. **Depois reverta:** `supabase secrets unset ASAAS_BASE_URL` +
  redeploy.
- **Ou aceitar por código:** é o mesmo caminho de erro dos cenários 5/6 (qualquer
  falha no aplicador → `failed`, reconcile reprocessa). Se não quiser simular, marque
  "coberto por revisão de código".

### Cenários 1 e 4

- **1** (contratar + pagar cartão → ativa): já coberto pelo cenário 2.
- **4** (crédito de IA numa org bloqueada não libera acesso): bloqueie uma org de
  teste (`update organizations set billing_status='blocked' where id='<id>'`), gere um
  pagamento de **crédito de IA** (`purpose=ai_topup`) pra ela e confirme. **Esperado:**
  pagamento `processed`, mas `billing_status` **continua** `blocked`.

Anote cada cenário (✅/❌) no fim do FASE-4A-RESUMO ou aqui.

---

## PASSO 6 — Merge da branch → `main` (frontend em produção)

Só **depois** dos cenários passarem (sobretudo o 2).

Regra de segurança (CLAUDE.md): antes do push, `git diff` do range inteiro caçando
secret. A revisão final já passou limpa; reconfirme o range.

```powershell
git checkout main
git merge --no-ff billing-asaas/fase-4
git push origin main
```

Dispara o deploy Vercel do **frontend**, que carrega: coleta de CPF/CNPJ + e-mail de
cobrança no onboarding, oferta de R$ 449 escondida de quem tem cortesia LIFETIME, e
entitlements no cliente. Sem esse merge, o backend aceita o plano mas o onboarding
não coleta o `tax_id` que o `billing-provider.ts` exige → a 1ª org nova travaria no
checkout.

---

## PASSO 7 — Go-live: trocar sandbox → produção

Quando for cobrar de verdade:

1. **Chave de produção:** em `/platform/automacao`, troque `asaas_api_key` pela chave
   **produção** (`$aact_prod_...`).
2. **Ambiente:** `supabase secrets set ASAAS_ENV=production` e **redeploy** das EFs que
   falam com o Asaas (`create-billing-checkout`, `asaas-webhook`,
   `process-asaas-reconcile`) — garante isolate/cache limpos pegando o novo env.
3. **Webhook de produção:** cadastre o webhook no painel **Asaas PRODUÇÃO** (o de
   sandbox não vale) — mesma URL, com o token de prod (pode gerar um novo e atualizar
   `asaas_webhook_token`).
4. **Backfill:** preencha `tax_id`/`billing_email` das orgs reais (Moralles, Ren Sushi,
   Seu Japa Teste) em `/platform/billing/<org>` — pré-req do checkout. **Preciso dos
   CPF/CNPJ reais de você** (não invento).
5. **Rotacionar** a chave de **sandbox** que foi exposta em texto durante os testes —
   higiene (blast radius baixo, mas some com o risco).
6. **Tag:** `git tag billing-asaas/fase-4a && git push origin billing-asaas/fase-4a`.

---

## Kill switch e rollback

- **Parar vendas novas sem perder eventos:** desative o plano —
  `update billing_plans set active=false where slug='sistema-reservas';`. O botão some,
  mas o webhook segue ligado e não perde pagamento em trânsito.
- **Desligar tudo (emergência):**
  `update platform_flags set value='false' where key='asaas_enabled';`. **Cuidado:**
  com a flag OFF o webhook **descarta** eventos (200 sem persistir) — use só se aceitar
  perder o que chegar enquanto está OFF. Prefira o rollback do plano acima pra parar
  vendas.
- **Cache de 5 min** vale pros dois: o efeito de qualquer toggle demora até 5 min (ou
  redeploy).
