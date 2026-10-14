# Datafy parceiro: conexão self-service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Depois de uma liberação explícita do admin, o dono de uma loja nova conecta o próprio número (Coexistence, BM dele) pelo portal. O sistema cria e assina o canal na conta de parceiro Datafy da plataforma, cadastra o webhook sozinho e ativa o canal quando o eco do aparelho chega. Nenhum passo exige SQL ou colar URL e segredo à mão. A fila assíncrona passa a ser garantia do provedor, e fila parada ou dead-letter geram alerta externo.

**Architecture:** Decisões em núcleos puros novos (`datafy-onboarding-core`, `datafy-admin-client` com `fetch` injetado, `ops-alert-core`), testados por vitest em `src/lib/`. As Edge Functions (`manage-channels`, `webhook-whatsapp`, `process-whatsapp-channel-health`, `whatsapp-health`, `manage-platform-secrets`) são adapters de I/O. O estado intermediário vive em `whatsapp_datafy_onboardings`, e a linha de `whatsapp_channels` só nasce com `phone_number_id`, o que preserva o invariante de âncora. Passos que geram custo são cercados por claim no SQL.

**Tech Stack:** TypeScript (Deno nas EFs; **sem Deno local**), Vitest + Testing Library + jsdom, Postgres local do pré-voo (`supabase/tests/local-preflight/`), Supabase CLI, Node ≥ 18 para o probe da Fase 0.

**Spec:** [docs/superpowers/specs/2026-10-13-datafy-parceiro-conexao-self-service-design.md](../specs/2026-10-13-datafy-parceiro-conexao-self-service-design.md)

## Global Constraints

- Branch `feat/datafy-parceiro-self-service`. Se usar worktree, ela vive em `.claude/worktrees/` e roda `npm ci` antes de tudo.
- `npm run typecheck` é `tsc -b --noEmit`; nunca `tsc --noEmit` sem `-b`. Baseline: zero erros. `tsc -b` não alcança `supabase/functions/`.
- **Não há Deno local.** Código de `index.ts` de EF só é conferido por eslint (`no-undef`) e por teste estático que lê o arquivo. Toda decisão mora em `_shared/*-core.ts`, importável pelo vitest.
- `tsconfig.app.json` tem `strict: false`: estreitar uniões com `x.ok === false` ou early-return, nunca `!x.ok`.
- **Nenhum log, DTO, erro, query key ou storage carrega:** `sk_acct_`, `sk_live_`, `whsec_`, a URL do link de conexão ou o token `ct_`. Instrumentação de provider é de FORMA (`shapeOf`), nunca de valor.
- **Id do canal Datafy usado em chamada externa vem SEMPRE da linha do nosso banco filtrada pelo `unit_id` do chamador**, nunca do corpo. `phone_number_id`, `waba_id` e `business_id` vêm do `GET` da Datafy, nunca do navegador.
- POST não idempotente à Datafy (`create_channel`, `subscribe`) só depois de claim no SQL; resposta incerta vira `uncertain` e só sai por reconciliação. Nunca retry cego.
- Todo `UPDATE` com predicado de tenant ou de claim usa `.select()` e confere a contagem (UPDATE que casa zero linhas devolve `error: null`).
- Comparação de posse e TTL vive no SQL (`now()` escreve e compara), nunca contra o relógio do Deno.
- Função nova em `public`: `revoke all on function <assinatura completa> from public, anon, authenticated;` e `grant execute … to service_role`. Conferir `acl-estatico`.
- Migration aplicada só por `supabase db push`, **antes** do deploy das EFs que leem as colunas novas.
- `git add <caminho>` com escopo explícito; nunca `git add .`/`-A`. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `CLAUDE.md` e `AGENTS.md` mudam juntos, no mesmo commit.
- Cópia de UI em PT-BR; sem `grid-cols-2` cru em formulário; `ResponsiveDialog` no mobile.

## Review Focus

1. **Clique duplo em "Conectar" ou no `confirm`** → no máximo um `POST /channels/whatsapp` e um `POST /subscribe` por onboarding. Teste de concorrência no pré-voo (Task 2) e teste do núcleo (Task 5).
2. **Claim expirado no meio de um POST** → o próximo chamador recebe `must_reconcile = true` e NÃO pode postar antes de reconciliar. Pré-voo, Task 2.
3. **`postMessage` com origem diferente de `https://app.datafyapi.com.br` ou `source` diferente de `datafy`** → ignorado; e mesmo o válido não carrega dado para o backend. Teste de componente, Task 10.
4. **`phone_number_id` que já ancora outro canal, ou WABA de outra organização** → `confirm` recusa sem criar linha e sem assinar. Núcleo, Task 5.
5. **Owner da unidade A chamando `official_connect_*` com `unit_id` da unidade B** → 403. Teste estático e checagem do `memberLifecycleRole`, Task 7.
6. **Provider `zapi`/`waha`/`uazapi`/`official` com `async_ingestion_enabled = true`** → processa síncrono (capability `inboundRedelivery = "unmeasured"`). Controle positivo, Task 6.
7. **`begin_switch` para `datafy` em unidade com canal ativo de outro provider** → 409 `DATAFY_MIGRATION_NOT_SUPPORTED`. Task 8.
8. **Alerta externo** sem URL configurada → `delivered: false, reason: "unconfigured"`, nunca "ok". Payload sem telefone, corpo ou `raw_body`. Task 9.

---

### Task 0: Fase 0 — validação ao vivo do contrato de parceiro

**Bloqueia todas as outras tasks que tocam a Datafy (2 em diante).** A Task 1 pode correr em paralelo.

**Precisa do dono:** o token de conta `sk_acct_` (Datafy → Minha conta → Parceiros → Criar token) na máquina dele, nunca no chat (está em `.env.local` como `TOKEN_CONTA_DATAFY`, lido com `node --env-file=.env.local`); e um número com app WhatsApp Business num portfólio Meta.

**Decidido em 2026-10-14:** o número é o da Moralles (empresa de teste, sem cliente real). Ele sai do canal assinado (ORIGINAL), conecta num canal de teste em trial (PROBE, nunca assinado, apagado no fim) e volta ao ORIGINAL. Nesta rodada não há `subscribe`: assinatura fica "não medida".

**Lido no OpenAPI de canais em 2026-10-14, antes de rodar:** não existe endpoint para desconectar número (o 409 do `connect-link` manda "desconecte ou delete o canal"; desconectar é no painel da Datafy). `DELETE` exige assinatura do canal cancelada. Existe webhook global da conta (`/channels/whatsapp/global-webhook`), que recebe eventos de todos os canais.

**Files:**
- Create: `scripts/datafy-probe/probe.mjs`
- Create: `scripts/datafy-probe/README.md`
- Create: `docs/superpowers/specs/2026-10-13-datafy-parceiro-validacao-fase0.md` (relatório)

- [x] **Step 1: Escrever o probe**

`scripts/datafy-probe/probe.mjs`. O código abaixo é a referência; o arquivo real acrescenta: leitura de `TOKEN_CONTA_DATAFY`, os comandos `global` e `list-ids`, `dup <id>` no lugar de `create-again-same-name`, fingerprints SHA-256 truncadas de `phone_number_id`/`waba_id`/`business_id` (para comparar o número antes e depois da troca de canal sem imprimir o id), e trava que recusa comando mutante em canal com `subscribed === true` (protege o ORIGINAL). Node ≥ 18, sem dependência. Imprime só forma. Booleans e números aparecem com valor (não são sensíveis e `subscribed`/`on_trial`/`expires_in` são o que se quer medir). Strings aparecem como `string`, `string<sk_live_>` (só o prefixo conhecido) ou `url<host>`.

```js
// Probe da Fase 0 do parceiro Datafy. Imprime FORMA, nunca valor sensível.
// Uso: DATAFY_ACCOUNT_TOKEN=sk_acct_... node scripts/datafy-probe/probe.mjs <comando> [args]
import http from "node:http";

const BASE = "https://cloud.datafyapi.com.br";
const TOKEN = process.env.DATAFY_ACCOUNT_TOKEN ?? "";
if (!TOKEN.startsWith("sk_acct_")) {
  console.error("DATAFY_ACCOUNT_TOKEN ausente ou fora do formato sk_acct_.");
  process.exit(2);
}

const KNOWN_PREFIXES = ["sk_acct_", "sk_live_", "whsec_", "ct_", "wamid."];
const MAX_DEPTH = 5;

function shape(value, depth = 0) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const prefix = KNOWN_PREFIXES.find((p) => value.startsWith(p));
    if (prefix) return `string<${prefix}>`;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return `url<${url.host}>`;
    } catch { /* não é URL */ }
    return value.length === 0 ? "string<empty>" : "string";
  }
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0], depth + 1), `len:${value.length}`];
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "object<depth>";
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k], depth + 1)]));
  }
  return typeof value;
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = "<não-json>"; }
  return { status: response.status, body: parsed };
}

function report(label, result) {
  console.log(JSON.stringify({ label, status: result.status, shape: shape(result.body) }, null, 2));
}

const [command, ...args] = process.argv.slice(2);
const id = args[0];

switch (command) {
  case "list": report("list", await call("GET", "/channels/whatsapp")); break;
  case "create": {
    const result = await call("POST", "/channels/whatsapp", {
      name: `probe-fase0-${Date.now()}`,
      description: "Probe da Fase 0. Pode apagar.",
    });
    report("create", result);
    // O id do canal não é segredo (exige o token de conta para uso) e é necessário nos próximos comandos.
    if (result.body && typeof result.body.id === "string") console.log(`CHANNEL_ID=${result.body.id}`);
    break;
  }
  case "create-again-same-name": {
    // Mede se `name` é único na conta (base da reconciliação por nome).
    const name = args[1];
    report("create-same-name", await call("POST", "/channels/whatsapp", { name }));
    break;
  }
  case "get": report("get", await call("GET", `/channels/whatsapp/${id}`)); break;
  case "webhook": {
    const url = args[1];
    report("webhook-create", await call("POST", `/channels/whatsapp/${id}/webhooks`, {
      url, events: ["messages", "smb_message_echoes"],
    }));
    report("webhook-list", await call("GET", `/channels/whatsapp/${id}/webhooks`));
    break;
  }
  case "link": report("connect-link", await call("POST", `/channels/whatsapp/${id}/connect-link`)); break;
  case "pause": report("pause", await call("POST", `/channels/whatsapp/${id}/pause`)); break;
  case "resume": report("resume", await call("POST", `/channels/whatsapp/${id}/resume`)); break;
  case "subscribe": {
    if (!args.includes("--autorizo-cobranca")) {
      console.error("Assinar cobra na hora. Rode de novo com --autorizo-cobranca se o dono autorizou.");
      process.exit(3);
    }
    report("subscribe", await call("POST", `/channels/whatsapp/${id}/subscribe`));
    report("subscribe-again", await call("POST", `/channels/whatsapp/${id}/subscribe`));
    break;
  }
  case "cancel": report("cancel", await call("POST", `/channels/whatsapp/${id}/cancel`)); break;
  case "delete": report("delete", await call("DELETE", `/channels/whatsapp/${id}`)); break;
  case "serve": {
    // Página local que abre a janela de conexão e registra a FORMA do postMessage.
    const page = `<!doctype html><meta charset="utf-8"><title>Probe Datafy</title>
<button id="b">Abrir conexão</button><pre id="o"></pre>
<script>
const o = document.getElementById("o");
const KNOWN = ["sk_acct_","sk_live_","whsec_","ct_"];
function shape(v,d=0){ if(v===null) return "null"; if(typeof v==="boolean"||typeof v==="number") return v;
  if(typeof v==="string"){ const p=KNOWN.find(k=>v.startsWith(k)); return p?"string<"+p+">":"string"; }
  if(Array.isArray(v)) return v.length?[shape(v[0],d+1),"len:"+v.length]:[];
  if(typeof v==="object"){ if(d>=5) return "object<depth>"; return Object.fromEntries(Object.keys(v).sort().map(k=>[k,shape(v[k],d+1)])); }
  return typeof v; }
window.addEventListener("message", (e) => {
  const entry = { origin: e.origin, shape: shape(e.data) };
  o.textContent += JSON.stringify(entry, null, 2) + "\\n";
  fetch("/report", { method: "POST", body: JSON.stringify(entry) });
});
document.getElementById("b").onclick = async () => {
  const w = window.open("about:blank", "datafy-conexao", "width=600,height=760");
  const r = await fetch("/link", { method: "POST" });
  const j = await r.json();
  if (!j.url) { o.textContent += "link falhou: " + JSON.stringify(j) + "\\n"; w && w.close(); return; }
  w.location.href = j.url;
};
</script>`;
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(page);
        return;
      }
      if (req.method === "POST" && req.url === "/link") {
        const result = await call("POST", `/channels/whatsapp/${id}/connect-link`);
        report("connect-link", result);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ url: result.body?.url ?? null, status: result.status }));
        return;
      }
      if (req.method === "POST" && req.url === "/report") {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => { console.log("POSTMESSAGE", raw); res.end("ok"); });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(5599, "127.0.0.1", () => console.log("Abra http://localhost:5599"));
    break;
  }
  default:
    console.error("Comandos: list | create | create-again-same-name <id> <name> | get <id> | webhook <id> <https-url> | link <id> | serve <id> | pause <id> | resume <id> | subscribe <id> --autorizo-cobranca | cancel <id> | delete <id>");
    process.exit(1);
}
```

- [x] **Step 2: README do probe**

`scripts/datafy-probe/README.md` com: (a) como definir a variável no PowerShell (`$env:DATAFY_ACCOUNT_TOKEN = Read-Host -AsSecureString`, convertido, para não ficar no histórico) e no bash (`read -s DATAFY_ACCOUNT_TOKEN; export DATAFY_ACCOUNT_TOKEN`); (b) a sequência do Step 3; (c) o aviso de que `subscribe` cobra e exige `--autorizo-cobranca`.

- [x] **Step 3: Rodar a sequência com o dono (na máquina dele)**

A sequência executada em 2026-10-14 é a do README (número da Moralles: ORIGINAL → desconecta no painel → PROBE → desconecta → ORIGINAL, conferindo as fingerprints contra a linha de base). A lista abaixo é a original, para número dedicado:

1. `list`: forma da listagem e valor de `subscription` da conta.
2. `create`: forma da resposta; anotar `CHANNEL_ID`.
3. `create-again-same-name <id> <name do passo 2>`: a Datafy aceita `name` duplicado? (Se aceitar, a reconciliação por nome precisa de `description` ou do `id` guardado antes; registrar.) Apagar o duplicado com `delete`.
4. `get <id>`: forma de canal sem número (`phone_number_id` null? ausente?), `on_trial`, `trial_ends_at`.
5. `webhook <id> https://<ref>.supabase.co/functions/v1/webhook-whatsapp?channel=00000000-0000-0000-0000-000000000000`: forma de criação e listagem. A URL aponta para um canal inexistente de propósito: entrega vira 404.
6. `serve <id>` → abrir `http://localhost:5599` → "Abrir conexão" → percorrer o Embedded Signup com o **número de teste** em Coexistence. Registrar: a origem do `postMessage`, a forma de `data` (o tipo de `coexistence`) e se a mensagem chega a uma página `localhost` (se não chegar, a Datafy restringe por domínio do parceiro: registrar e descobrir onde se configura).
7. `get <id>` de novo: forma com número (`phone_number_id`, `waba_id`, `business_id`, `phone`, `display_name`).
8. `link <id>` com o canal já conectado: confirmar o 409 "já conectado".
9. `pause <id>` e `resume <id>`: formas.
10. **Somente com autorização explícita do dono:** `subscribe <id> --autorizo-cobranca` (mede a resposta e o que um segundo `subscribe` devolve), depois `cancel <id>`. Sem autorização, pular e registrar "não medido".
11. `delete <id>`: medir se um canal **nunca assinado** pode ser apagado direto.

- [x] **Step 4: Relatório**

Escrever `docs/superpowers/specs/2026-10-13-datafy-parceiro-validacao-fase0.md` com, por operação: status HTTP, forma, e a divergência em relação à §3 da spec. Fechar com "decisões que mudam o plano", por exemplo: nome não é único → reconciliação por `description`; `coexistence` é string → parser aceita os dois; `postMessage` não chega em localhost → o portal precisa de domínio registrado.

- [x] **Step 5: Commit**

```bash
git add scripts/datafy-probe/probe.mjs scripts/datafy-probe/README.md docs/superpowers/specs/2026-10-13-datafy-parceiro-validacao-fase0.md
git commit -m "test(datafy): probe da Fase 0 do parceiro e relatorio de forma"
```

**Gate de saída:** relatório revisado pelo dono. Divergência que mude interface atualiza as Tasks 3–10 **antes** de começar.

**Estado em 2026-10-14:** rodada feita, relatório em [2026-10-13-datafy-parceiro-validacao-fase0.md](../specs/2026-10-13-datafy-parceiro-validacao-fase0.md), revisado pelo dono. Item 5 da §4 decidido: o `confirm` não barra por `coexistence`; a prova de Coexistence é o eco do aparelho, que já é exigido para ativar. As decisões da §4 estão aplicadas nas Tasks 2, 4, 5, 7, 10 e 11 (blocos "Fase 0").

---

### Task 1: Capability de reentrega e `decideIngestionMode`

Independe da Datafy ao vivo; pode correr junto da Task 0.

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-provider-core.ts` (tipo de capabilities + valor por provider)
- Modify: `supabase/functions/_shared/whatsapp-inbound-queue-core.ts` (`decideIngestionMode`)
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (passar a capability ao gate)
- Modify: `src/lib/whatsapp-inbound-queue-core.test.ts`
- Modify: `src/lib/whatsapp-capability-guard.test.ts` (se ele enumera as chaves)

**Interfaces:**
- Produces: `PROVIDER_CAPABILITIES[provider].inboundRedelivery: "documented" | "unmeasured"`. `datafy` → `"documented"`; `zapi`, `waha`, `uazapi`, `official` → `"unmeasured"`.
- `decideIngestionMode(input: { source; flagEnabled; flagReadFailed; channelEnabled; providerRedelivery: "documented" | "unmeasured" | undefined }): IngestionMode`.

- [x] **Step 1: Teste que falha.** Em `whatsapp-inbound-queue-core.test.ts`: `providerRedelivery: "unmeasured"` com canal e flag ligados → `"sync"`; `"documented"` → `"async"`; `undefined` → `"sync"` (fail-safe: sem declaração, não confia na reentrega). Manter os casos existentes passando `"documented"`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/whatsapp-inbound-queue-core.test.ts`.
- [x] **Step 3: Implementar.** A nova perna entra **depois** de `source !== "provider"` e **antes** da leitura da flag, junto da perna do canal (é entrada certa, vem do registry em código). Atualizar o comentário de ordem das pernas. Não alterar a ordem canal → flag.
- [x] **Step 4: Ligar no webhook.** No call site de `decideIngestionMode` em `webhook-whatsapp/index.ts`, passar `providerRedelivery: PROVIDER_CAPABILITIES[provider]?.inboundRedelivery`. Teste estático (em `whatsapp-multiprovider-wiring-guard.test.ts` ou novo `datafy-partner-wiring-guard.test.ts`) que reprova se o call site não passar `providerRedelivery`.
- [x] **Step 5: Controle positivo.** Trocar temporariamente o valor do `zapi` para `"documented"` e ver o teste do Step 1 falhar; reverter.
- [x] **Step 6:** `npm run typecheck && npx vitest run` verdes. Commit `feat(whatsapp): ingestao assincrona so para provider com reentrega documentada`.

---

### Task 2: Migration — liberações, onboarding, colunas, claim e ledger de alertas

**Files:**
- Create: `supabase/migrations/20261014120000_datafy_partner_onboarding.sql`
- Create: `supabase/tests/local-preflight/61-datafy-partner-onboarding.sql`
- Modify: `scripts/function-acl-allowlist.json` (as duas RPCs novas)

**Conteúdo da migration (idempotente):**

1. `public.whatsapp_official_connection_grants`
   - `id uuid pk default gen_random_uuid()`, `organization_id uuid not null references organizations`, `unit_id uuid not null references units on delete cascade`, `granted_by uuid not null`, `granted_at timestamptz not null default now()`, `revoked_by uuid`, `revoked_at timestamptz`, `consumed_channel_id uuid`, `consumed_at timestamptz`.
   - CHECK: `(revoked_at is null) = (revoked_by is null)`; `(consumed_at is null) = (consumed_channel_id is null)`; não pode estar revogada e consumida ao mesmo tempo.
   - Índice único parcial `(unit_id) where revoked_at is null and consumed_at is null`.
   - Trigger de coerência: `organization_id` = organização da `unit_id` (mesma disciplina do touchpoint da 115).
2. `public.whatsapp_datafy_onboardings`
   - `id`, `organization_id`, `unit_id`, `grant_id references whatsapp_official_connection_grants`, `reserved_channel_id uuid not null unique default gen_random_uuid()`, `datafy_channel_id text unique`, `channel_token text`, `webhook_secret text`, `datafy_webhook_id text`, `state text not null default 'open'` CHECK em `('open','channel_created','webhook_ready','connected','completed','abandoned')`, `claim_id uuid`, `claim_step text` CHECK em `('create_channel','create_webhook','subscribe')`, `claim_started_at timestamptz`, `uncertain_steps text[] not null default '{}'`, `last_error text` CHECK `~ '^[A-Z0-9_]{1,64}$'`, `last_link_at timestamptz`, `completed_at`, `abandoned_at`, `created_at`, `updated_at`.
   - CHECK `((claim_id is null) = (claim_started_at is null)) and ((claim_id is null) = (claim_step is null))`.
   - Índice único parcial `(unit_id) where state not in ('completed','abandoned')`.
   - Trigger de coerência org × unit.
3. `whatsapp_channels`: `add column if not exists provider_subscribed_at timestamptz, provider_subscription_canceled_at timestamptz, provider_paused_at timestamptz`. **Fase 0 (§4 item 5): nenhuma coluna de Coexistence, nem aqui nem no onboarding.** O GET da Datafy não traz o campo, e a prova é o eco (`manual_echo_verified_at`); coluna sem produtor confiável não nasce. Índice único parcial `whatsapp_channels_meta_phone_number_idx on ((credentials->>'phone_number_id')) where provider in ('official','datafy') and credentials ? 'phone_number_id'`. **Antes de criar, o pré-voo e a conferência de produção provam que não há duplicata** (Moralles e eventuais `official` legados).
4. `public.whatsapp_ops_alerts`: `unit_id`, `alert_type` CHECK em `('inbound_dead_letter','inbound_backlog_stalled','datafy_subscription_failed')`, `last_sent_at`, `last_watermark timestamptz`, unique `(unit_id, alert_type)`.
5. Para as quatro tabelas: `enable` + `force row level security`, sem policies, `revoke all on table … from public, anon, authenticated`.
6. RPC `public.claim_datafy_onboarding_step(p_onboarding_id uuid, p_step text, p_actor_id uuid, p_ttl_seconds integer default 120)` → `table(claimed boolean, claim_id uuid, must_reconcile boolean, state text)`:
   - `for update` na linha; `p_step` validado contra o CHECK; TTL limitado a 30..900.
   - Claim vivo (`claim_started_at > now() - ttl`) → `claimed = false`.
   - Claim expirado **ou** `p_step = any(uncertain_steps)` → novo claim com `must_reconcile = true` (o POST anterior pode ter acontecido).
   - Senão → novo claim com `must_reconcile = false`.
   - Linha `completed`/`abandoned` → `raise exception 'onboarding_closed' using errcode = 'check_violation'`.
7. RPC `public.release_datafy_onboarding_step(p_onboarding_id uuid, p_claim_id uuid, p_step text, p_outcome text, p_error_code text default null)` → `boolean`:
   - Fence: `claim_id` e `claim_step` têm de bater, senão `raise … errcode '40001'` (`stale_onboarding_claim`).
   - `p_outcome` em `('succeeded','failed','uncertain','reconciled_absent','reconciled_present')`. `uncertain` acrescenta o passo a `uncertain_steps`; os demais o retiram. `last_error` recebe `p_error_code`. Limpa o claim.
8. Para as duas RPCs: `security definer`, `set search_path = ''`, `revoke all on function <assinatura completa> from public, anon, authenticated; grant execute … to service_role;`.

**Revisão de 2026-10-14 (revisor da Task 2 + `saas-shield-br:migration-validator`), vale sobre os itens acima:**
- **`failed` não limpa a incerteza** (era P1 bloqueante): só `succeeded`, `reconciled_absent` e `reconciled_present` tiram o passo de `uncertain_steps`. Um `failed` não diz nada sobre um POST anterior que pode ter acontecido. Para limpar, o handler libera `reconciled_*` e reivindica de novo antes de postar.
- **Takeover de claim vencido grava o passo do dono morto em `uncertain_steps`**, além de devolver `must_reconcile = true`.
- **Vida do claim pelo TTL do dono:** coluna `claim_expires_at` (gravada no claim, comparada com `now()`), não o TTL de quem desafia.
- **RPCs recebem `p_unit_id`** logo depois de `p_onboarding_id` e recusam `42501` se a linha for de outra unidade (defesa em profundidade; o tenant sai da linha).
- **Índice de número normalizado como o `metaPayloadMatchesChannel` lê:** expressão `btrim(credentials->>'phone_number_id', E' \t\r\n')`, excluindo vazio. Sem isso, `"777"` e `" 777 "` ancorariam o mesmo número em dois canais.
- CHECKs novos: `completed`/`abandoned` sem `channel_token` e `webhook_secret` (a cópia autoritativa é `whatsapp_channels`); `state in ('open','abandoned') or datafy_channel_id is not null`. `organization_id`, `unit_id` e `grant_id` imutáveis depois do insert; uma liberação só alimenta um onboarding não abandonado (índice único parcial em `grant_id`); `consumed_channel_id` tem de ser canal da mesma unidade.

- [x] **Step 1: Escrever o pré-voo primeiro** (`61-datafy-partner-onboarding.sql`), no molde dos arquivos 18–21 e 56–60. Casos:
  - C1: duas liberações ativas na mesma unidade → `23505`.
  - C2: liberação com `organization_id` de outra organização → recusada pela trigger.
  - C3: dois onboardings abertos na mesma unidade → `23505`; um `completed` e um aberto → aceito.
  - C4: claim de passo livre → `claimed = true, must_reconcile = false`; segundo claim imediato → `claimed = false`.
  - C5: claim com `claim_started_at` forçado para 200 s atrás → novo claim `must_reconcile = true`.
  - C6: release `uncertain` → claim seguinte do mesmo passo `must_reconcile = true`; release `reconciled_absent` → claim seguinte `must_reconcile = false`.
  - C7: release com `claim_id` velho → `40001`.
  - C8: dois canais `datafy` com o mesmo `credentials->>'phone_number_id'` → `23505`; um `zapi` com o mesmo valor → aceito (fora do índice).
  - C9: `has_function_privilege('anon', …)` e `('authenticated', …)` falsos para as duas RPCs.
  - **Controle positivo:** para C5 e C8, reintroduzir o defeito (remover a cláusula de TTL; remover o índice) e ver o caso falhar; registrar no arquivo como os controles existentes fazem.
- [x] **Step 2: Rodar o pré-voo e ver falhar** (migration ainda inexistente), conforme o README do harness.
- [x] **Step 3: Escrever a migration** até o pré-voo passar. Reaplicar duas vezes (idempotência).
- [ ] **Step 4: Conferir duplicata em produção (leitura, o dono roda: o modo automático bloqueia SQL em produção).** A query com a mesma expressão do índice está no cabeçalho da migration (o `group by 1` cru juntava as linhas sem a chave num grupo NULL e dava alarme falso); precisa voltar vazia **antes do `db push` da Task 14**. Se não voltar, parar e reportar. Duplicata faz o `create unique index` falhar no push (falha visível, não silenciosa).
- [x] **Step 5: Allowlist de ACL** com as duas assinaturas completas; `acl-estatico` local (`npx vitest run scripts/` ou o comando do workflow) verde.
- [x] **Step 6: Commit** `feat(db): liberacao, onboarding Datafy com claim cercado e ledger de alertas` (`548ba49`).

---

### Task 3: Credencial de conta Datafy

**Files:**
- Create: `supabase/functions/_shared/datafy-account-config.ts`
- Create: `supabase/functions/_shared/datafy-account-config-core.ts`
- Create: `src/lib/datafy-account-config-core.test.ts`
- Modify: `supabase/functions/manage-platform-secrets/index.ts` (`VALID_KEYS`, `KEY_DESCRIPTIONS`, `clearAllProviderConfigCaches`)

**Interfaces:**
- `decideAccountTokenRead(input: { row: { value: unknown } | null; error: unknown }): { ok: true; token: string } | { ok: false; reason: "missing" | "malformed" | "unavailable" }`. Puro. `sk_acct_` obrigatório como prefixo; valor não-string → `malformed`; erro de leitura → `unavailable`, **nunca** fallback.
- `getDatafyAccountToken(): Promise<ReturnType<typeof decideAccountTokenRead>>` com cache de 5 min só do sucesso; `clearDatafyAccountConfigCache()`.

- [x] **Step 1:** testes do núcleo (os quatro desfechos + controle positivo: um `{ value: {} }` precisa dar `malformed`, nunca `"[object Object]"`).
- [x] **Step 2:** implementar núcleo e adapter. O adapter **não** lê `Deno.env` para o token (teste estático lendo o arquivo reprova `Deno.env.get("DATAFY`).
- [x] **Step 3:** `manage-platform-secrets`: chave `datafy_account_token`, descrição "Token de conta da Datafy (sk_acct_...), acesso a todos os canais da conta", e `clearDatafyAccountConfigCache()` na limpeza central.
- [x] **Step 4:** typecheck + vitest. Commit `feat(datafy): token de conta em platform_secrets sem fallback de env` (`0f86b42`).

---

### Task 4: Cliente da API de administração Datafy

**Depende da Task 0** (formas medidas).

**Files:**
- Create: `supabase/functions/_shared/datafy-admin-client.ts`
- Create: `src/lib/datafy-admin-client.test.ts`

**Formas medidas na Fase 0** (relatório §2; os testes usam exatamente estas formas):

| Operação | Status | Corpo |
|---|---|---|
| `GET /channels/whatsapp` | 200 | `{ subscription: "active" \| …, channels: [{ id, name, description, subscribed, on_trial, trial_ends_at, paused, waba_id, phone_number_id, business_id, display_name }] }`. **Sem `created_at`, sem `token`/`webhook_secret`.** |
| `POST /channels/whatsapp` | **200** | `{ id, name, description, token: "sk_live_…", webhook_secret: "whsec_…", subscribed: false }` |
| `GET /channels/whatsapp/{id}` | 200 | os campos do item + `phone`, `webhooks[]` (`{ id, url, events, enabled }`), `token`, `webhook_secret`. Sem número: `phone_number_id`, `waba_id`, `business_id`, `phone`, `display_name` vêm **`null` (presentes)**. **Sem `coexistence`.** |
| `POST …/{id}/webhooks` | 200 | `{ id, url, events, enabled }` |
| `POST …/{id}/connect-link` | 200 | `{ url: "https://app.datafyapi.com.br/…", token: "ct_…", expires_in: 86400 }`. **Também 200 em canal já conectado** (reabre o Embedded Signup e permite trocar o número). |
| `POST …/{id}/subscribe` | 200 | `{ id, subscribed: true }` |
| `DELETE /channels/whatsapp/{id}` | 200 | `{ ok: true }` (medido em canal nunca assinado e sem número) |
| erro | 4xx | `{ message, statusCode }`, **sem `code`**: variantes do mesmo status só diferem pelo texto (409 = "sem assinatura/trial vencido" no link; 409 = "único canal ativo" no cancel). |
| `pause`, `resume`, `cancel`, `subscribe` repetido, `delete` com número | — | **não medidos** |

**Interfaces:**

```ts
export type DatafyAdminErrorKind =
  | "unauthorized" | "account_inactive" | "not_found" | "conflict" | "payment_declined"
  | "invalid" | "rate_limited" | "server_error" | "transport" | "unrecognized";
export type DatafyAdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: DatafyAdminErrorKind; httpStatus: number | null; code: string };

export interface DatafyWebhook { id: string; url: string; events: string[]; enabled: boolean }
export interface DatafyChannelCreated { id: string; token: string; webhookSecret: string; subscribed: boolean }
export interface DatafyChannelListItem {
  id: string; name: string; subscribed: boolean; onTrial: boolean; trialEndsAt: string | null; paused: boolean;
  phoneNumberId: string | null; wabaId: string | null; businessId: string | null;
}
export interface DatafyChannelSnapshot extends DatafyChannelListItem {
  displayPhone: string | null;
  token: string | null; webhookSecret: string | null;   // nullable: a Fase 0 não registrou os dois no GET de forma explícita
  webhooks: DatafyWebhook[];                             // ausente no corpo → []; presente e não-array → unrecognized
}

export function createDatafyAdminClient(deps: {
  token: string; fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number;
  onUnrecognized?: (info: { operation: string; httpStatus: number; shape: unknown }) => void; // o adapter passa jsonLog
}): {
  listChannels(): Promise<DatafyAdminResult<{ accountSubscription: string | null; channels: DatafyChannelListItem[] }>>;
  createChannel(input: { name: string; description: string }): Promise<DatafyAdminResult<DatafyChannelCreated>>;
  getChannel(id: string): Promise<DatafyAdminResult<DatafyChannelSnapshot>>;
  createWebhook(id: string, input: { url: string; events: string[] }): Promise<DatafyAdminResult<{ webhookId: string }>>;
  createConnectLink(id: string): Promise<DatafyAdminResult<{ url: string; expiresInSeconds: number }>>; // o `ct_` da resposta é descartado
  subscribe(id: string): Promise<DatafyAdminResult<{ subscribed: boolean }>>;
  cancel(id: string): Promise<DatafyAdminResult<{ acknowledged: true }>>;
  pause(id: string): Promise<DatafyAdminResult<{ acknowledged: true }>>;
  resume(id: string): Promise<DatafyAdminResult<{ acknowledged: true }>>;
  deleteChannel(id: string): Promise<DatafyAdminResult<{ deleted: true }>>;
};
```

Regras:
- Token em `Authorization: Bearer`, `redirect: "error"`, timeout padrão 10 s. `id` passa por validação de formato (`^[A-Za-z0-9_-]{1,128}$`) e por `encodeURIComponent` **antes** do fetch; inválido → `{ ok: false, kind: "invalid", httpStatus: null, code: "DATAFY_INVALID_ID" }` sem chamar `fetch`.
- **Sucesso é qualquer 2xx** (criar devolve 200, não 201).
- **Classificação só por status HTTP; nada decide pelo texto de `message`** (Fase 0, §4 item 4): 401 → `unauthorized`; 402 → `payment_declined`; 403 → `account_inactive`; 404 → `not_found`; 409 → `conflict`; 400/422 → `invalid`; 429 → `rate_limited`; 5xx → `server_error`; outro status → `unrecognized`; exceção de rede ou timeout → `transport`. **O 409 é ambíguo por natureza**: quem chama decide pelo GET, nunca pelo 409.
- 2xx com corpo fora da forma medida → `unrecognized` + `onUnrecognized({ operation, httpStatus, shape: shapeOf(body) })` (de `webhook-payload-shape-core.ts`). Para mutação (`createChannel`, `createWebhook`, `subscribe`), `transport`/`server_error`/`unrecognized` significam "pode ter acontecido": o chamador trata como `uncertain` e resolve por GET.
- **Operações não medidas** (`pause`, `resume`, `cancel`): qualquer 2xx → `{ acknowledged: true }`, sem exigir forma de corpo. Exigir uma forma que ninguém mediu transformaria todo sucesso em `unrecognized`; o estado efetivo vem do GET que o chamador faz em seguida (Fase 0, §4 item 7). `deleteChannel`: qualquer 2xx → `{ deleted: true }`; 404 → `not_found` (o chamador trata como "já não existe").
- `createConnectLink` só aceita `url` com `protocol === "https:"` e `hostname === "app.datafyapi.com.br"`; outro host → `unrecognized` (o link é aberto no navegador do lojista). A URL só existe dentro do `value`; o `ct_` da resposta é descartado.
- `code` é token fixo no formato `^[A-Z0-9_]{1,64}$` (`DATAFY_UNAUTHORIZED`, `DATAFY_PAYMENT_DECLINED`, `DATAFY_ACCOUNT_INACTIVE`, `DATAFY_NOT_FOUND`, `DATAFY_CONFLICT`, `DATAFY_INVALID_REQUEST`, `DATAFY_RATE_LIMITED`, `DATAFY_SERVER_ERROR`, `DATAFY_TRANSPORT`, `DATAFY_UNRECOGNIZED`, `DATAFY_INVALID_ID`), porque vai para `last_error` do onboarding. Nunca a mensagem da Datafy (pode conter dado) e nunca `String(error)` (pode conter URL).
- Campo de credencial e de id passa por `typeof === "string"`, nunca `String(...)`. `null` vira `null`; string vazia em campo de identidade vira `null`.

- [x] **Step 1:** testes com `fetchImpl` falso, por operação: sucesso com a forma medida da tabela acima (inclusive campos `null` presentes no GET sem número); cada status mapeado; `transport` (fetch lança) e timeout; `unrecognized` com `onUnrecognized` chamado com `shapeOf` (e nunca com o corpo cru); `id` inválido não chama `fetch`; link com host diferente de `app.datafyapi.com.br` → `unrecognized`. **Teste de redação:** serializar todo resultado de erro e toda chamada de `onUnrecognized` e afirmar que não contém o token injetado, `sk_live_`, `whsec_`, `ct_` nem a URL do link (controle positivo: trocar `code` por `String(error)` e ver falhar).
- [x] **Step 2:** implementar. **Step 3:** typecheck + vitest. Commit `feat(datafy): cliente da API de administracao do parceiro` (`f163c11`).

---

### Task 5: Núcleo do onboarding

**Files:**
- Create: `supabase/functions/_shared/datafy-onboarding-core.ts`
- Create: `src/lib/datafy-onboarding-core.test.ts`

**Interfaces:**

```ts
export type OnboardingState = "open" | "channel_created" | "webhook_ready" | "connected" | "completed" | "abandoned";

/** Estado do canal na Datafy, lido pelo adapter num GET. Nunca vem do navegador. */
export interface RemoteChannelState {
  found: boolean;                // false = o GET devolveu 404 (canal apagado na Datafy)
  phoneNumberId: string | null;
  subscribed: boolean;
  onTrial: boolean;
}

/**
 * O que o `start` deve fazer a seguir. Decide pelo GET (Fase 0, §4 itens 2 e 3), nunca pelo 409 do link:
 * - canal com número → `go_confirm` (link de canal conectado reabre o Embedded Signup e troca o número; nunca é emitido);
 * - canal sem número, sem assinatura e sem trial → `recreate_channel` (o link seria recusado; apagar e recriar não custa nada);
 * - canal sumido (404) → `recreate_channel`.
 * Ordem: liberação → gates → unidade ativa → estado. Nenhum passo avança sem liberação e gates.
 */
export function decideStartStep(input: {
  grantActive: boolean;
  gatesAllowed: boolean;           // resolveWhatsAppGateByUnit + checkChannelConnectionAllowance
  unitHasActiveChannel: boolean;
  onboarding: { state: OnboardingState; datafyChannelId: string | null; datafyWebhookId: string | null } | null;
  remote: RemoteChannelState | null; // obrigatório em channel_created/webhook_ready; o adapter faz o GET antes
}):
  | { kind: "refuse"; code: "GRANT_REQUIRED" | "PROVISIONING_BLOCKED" | "UNIT_ALREADY_ACTIVE" | "ONBOARDING_CLOSED" | "REMOTE_STATE_REQUIRED" }
  | { kind: "open_onboarding" }
  | { kind: "create_channel" }
  | { kind: "recreate_channel"; reason: "trial_expired" | "channel_missing" }
  | { kind: "create_webhook" }
  | { kind: "issue_link" }
  | { kind: "go_confirm" };

/** Canal remoto que pode ser apagado sem perder nada: nunca assinado e sem número. Único predicado que autoriza `deleteChannel`. */
export function isDisposableRemoteChannel(channel: { subscribed: boolean; phoneNumberId: string | null }): boolean;

/**
 * Reconciliação do `create_channel` incerto (Fase 0, §4 item 1). `name` não é único e a listagem não tem `created_at`.
 * Candidatos = `name === reservedChannelId` (exato). 0 → absent. Comprometido = assinado ou com número.
 * Mais de um comprometido → ambiguous (nunca apaga comprometido). Um comprometido → adota-o.
 * Nenhum comprometido → adota o de maior `trialEndsAt` (mais trial; data inválida ou nula conta como a menor),
 * empate pelo menor `id`. `discard` = os demais candidatos, todos descartáveis por construção.
 */
export function decideChannelReconciliation(input: {
  reservedChannelId: string;
  channels: { id: string; name: string; subscribed: boolean; phoneNumberId: string | null; trialEndsAt: string | null }[];
}): { kind: "absent" } | { kind: "adopt"; channelId: string; discard: string[] } | { kind: "ambiguous" };

/** Credenciais do canal adotado, lidas do GET. Sem token ou secret: descartável → apagar e recriar; comprometido → recusa para o admin. */
export function decideAdoptedCredentials(snapshot: { subscribed: boolean; phoneNumberId: string | null; token: string | null; webhookSecret: string | null }):
  | { kind: "use"; token: string; webhookSecret: string }
  | { kind: "discard_and_recreate" }
  | { kind: "refuse"; code: "DATAFY_CREDENTIALS_UNAVAILABLE" };

/**
 * Valida o GET da Datafy contra o que o `confirm` exige. Nada vem do navegador.
 * **Sem checagem de Coexistence (Fase 0, §4 item 5):** o GET não traz o campo. A prova de Coexistence é o eco do aparelho,
 * exigido para ativar (`manual_echo_verified_at`). Número sem app é assinado (custo que a liberação já autorizava),
 * nunca produz eco e nunca ativa.
 * `wabaId` é obrigatório: sem ele a unicidade de WABA entre organizações não se verifica.
 */
export function decideConfirm(input: {
  grantActive: boolean;            // recusa antes de olhar o remoto (revisão da Task 5)
  gatesAllowed: boolean;
  remote: { found: boolean; phoneNumberId: string | null; wabaId: string | null; businessId: string | null };
  phoneNumberIdTakenByOtherChannel: boolean;   // calculado EXCLUINDO a linha com id = reserved_channel_id
  wabaOwnedByOtherOrganization: boolean;
}):
  | { kind: "not_connected_yet" }
  | { kind: "refuse"; code: "GRANT_REQUIRED" | "PROVISIONING_BLOCKED" | "REMOTE_CHANNEL_MISSING" | "REMOTE_STATE_REQUIRED" | "REMOTE_IDENTITY_INCOMPLETE" | "PHONE_NUMBER_ALREADY_BOUND" | "WABA_OWNED_BY_OTHER_ORG" }
  | { kind: "create_channel_row"; phoneNumberId: string; wabaId: string; businessId: string | null };
  // número/WABA com espaço nas pontas é RECUSADO (REMOTE_IDENTITY_INCOMPLETE), não aparado: as flags de colisão
  // são calculadas sobre o valor cru, e aparar gravaria um valor diferente do conferido. `businessId` é aparado.

/**
 * Assinatura, decidida pelo GET feito DEPOIS do claim de `subscribe` (nunca por um GET anterior ao claim).
 * Revisão da Task 5: uma assinatura que JÁ aconteceu na Datafy é sempre registrada, mesmo com liberação ou gates negados
 * (`record_subscription`: grava `provider_subscribed_at`, não consome a liberação, não pede ativação, alerta o admin).
 * `grant` distingue "consumida por este canal" de "revogada": finalizar duas vezes é no-op.
 */
export function decideSubscribeStep(input: {
  grant: "active" | "consumed_by_this_channel" | "none";
  gatesAllowed: boolean;
  remote: { found: boolean; subscribed: boolean };
}):
  | { kind: "already_subscribed" }
  | { kind: "record_subscription"; code: "GRANT_REQUIRED" | "PROVISIONING_BLOCKED" }
  | { kind: "subscribe" }
  | { kind: "refuse"; code: "GRANT_REQUIRED" | "PROVISIONING_BLOCKED" | "REMOTE_CHANNEL_MISSING" | "REMOTE_STATE_REQUIRED" };

/**
 * Valida o MessageEvent do navegador. Não devolve dado ao backend.
 * `connected_without_app` ⇔ `data.data.coexistence === false` (boolean estrito): serve só à UI, que avisa e não chama o
 * `confirm` sozinha. Ausência do campo, ou valor não-boolean, conta como `connected`; o GET decide o resto.
 */
export const DATAFY_CONNECT_ORIGIN = "https://app.datafyapi.com.br";
export function classifyConnectMessage(event: { origin: string; data: unknown }): "connected" | "connected_without_app" | "error" | "ignore";

/** Checklist mostrado ao lojista e ao admin, derivado só de estado persistido. */
export function deriveOfficialChecklist(input: {
  grantActive: boolean;
  onboardingState: OnboardingState | null;
  channel: { status: string | null; isActive: boolean | null; subscribedAt: string | null; echoVerifiedAt: string | null; activationRequestedAt: string | null } | null;
  automationDispatchAdopted: boolean;
}): { step: "not_granted" | "ready_to_connect" | "connecting" | "subscription_pending" | "awaiting_echo" | "active"; items: { id: string; done: boolean }[]; templatesPending: boolean };
```

Observações:
- **Fase 0, §4 item 5 (decidido):** Coexistence não é checado no `confirm`. O núcleo registra a decisão no comentário de `decideConfirm`; `classifyConnectMessage` lê `coexistence` só para a UI.
- `classifyConnectMessage` é importado pelo frontend direto de `supabase/functions/_shared/` (cross-boundary deliberado, mesmo motivo de `whatsapp-implementation-core.ts`).
- O núcleo não importa o cliente da Task 4: os tipos de entrada são estruturais e mínimos, e o adapter (Task 7) converte o snapshot.
- **Falha fechada em campo remoto malformado (revisão da Task 5):** o adapter do `manage-channels` nunca passa por typecheck, então um `undefined` por erro de nome de campo não pode virar link, DELETE ou assinatura. "Pode ter número" = `phoneNumberId !== null`; descartável = `subscribed === false && phoneNumberId === null`; `found`/`subscribed`/`onTrial` fora de boolean → `REMOTE_STATE_REQUIRED`.
- Checklist: itens `granted`, `channel_created`, `webhook_ready`, `number_connected`, `subscribed`, `echo_verified`, `active`. `status` da conexão é ignorado de propósito: portal e painel o mostram à parte.

- [x] **Step 1:** testes. Casos-chave:
  - `decideStartStep`: liberação revogada → `GRANT_REQUIRED` (mesmo com canal conectado); gates negados → `PROVISIONING_BLOCKED`; unidade já com canal ativo → `UNIT_ALREADY_ACTIVE`; sem onboarding → `open_onboarding`; `completed`/`abandoned` → `ONBOARDING_CLOSED`; `open` → `create_channel`; `channel_created`/`webhook_ready` sem `remote` → `REMOTE_STATE_REQUIRED`; `remote.found = false` → `recreate_channel/channel_missing`; `remote.phoneNumberId` presente (em `channel_created` ou `webhook_ready`) → `go_confirm`, **nunca `issue_link`**; sem número, `subscribed = false`, `onTrial = false` → `recreate_channel/trial_expired`; sem número e assinado (trial vencido) → segue (`create_webhook`/`issue_link`); `webhook_ready` em trial → `issue_link` sem recriar nada; `connected` → `go_confirm`.
  - `isDisposableRemoteChannel`: só `subscribed = false` **e** sem número.
  - `decideChannelReconciliation`: 0/1/N candidatos; nome parecido mas diferente não conta; N descartáveis → adota o de maior `trialEndsAt` e descarta o resto; `trialEndsAt` nulo ou inválido perde; empate → menor `id`; um comprometido entre descartáveis → adota o comprometido; dois comprometidos → `ambiguous`; `discard` nunca contém comprometido (propriedade verificada sobre todos os casos).
  - `decideAdoptedCredentials`: os três desfechos.
  - `decideConfirm`: canal sumido → `REMOTE_CHANNEL_MISSING`; sem número → `not_connected_yet`; número sem WABA → `REMOTE_IDENTITY_INCOMPLETE`; número já ancorado → `PHONE_NUMBER_ALREADY_BOUND`; WABA de outra organização → `WABA_OWNED_BY_OTHER_ORG`; feliz → `create_channel_row`. O tipo da entrada não tem campo de Coexistence.
  - `decideSubscribeStep`: assinado → `already_subscribed`; não assinado → `subscribe`; liberação ou gates negados → recusa (nunca `subscribe`).
  - `classifyConnectMessage`: origem `https://app.datafyapi.com.br.evil.com` → `ignore`; `http://app.datafyapi.com.br` → `ignore`; `data.source !== "datafy"` → `ignore`; `data` não-objeto → `ignore`; `event: "connected"` → `connected`; `coexistence: false` → `connected_without_app`; `coexistence: "false"` (string) → `connected`; `event: "error"` → `error`; outro `event` → `ignore`.
  - Controles positivos: trocar a comparação de origem por `startsWith` e ver o caso `.evil.com` falhar; tirar a perna `phoneNumberId` de `decideStartStep` e ver o caso "canal conectado nunca recebe link" falhar; deixar `discard` incluir comprometido e ver a propriedade falhar.
- [x] **Step 2:** implementar. **Step 3:** vitest. Commit `feat(datafy): nucleo puro do onboarding self-service` (`5473b0a`).

---

### Task 6: Webhook — ativação pelo eco

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (bloco de verificação do eco)
- Create: `src/lib/datafy-partner-wiring-guard.test.ts` (teste estático)

- [ ] **Step 1:** teste estático que lê o `index.ts` e exige, no bloco onde `manual_echo_verified_at` é gravado: chamada a `activate_whatsapp_channel` condicionada a `activation_requested_at` **e** `status === "connected"`, e `throw` em erro da RPC (mesmo padrão do connection callback). Também reprova se a ativação aparecer **antes** da gravação do eco.
- [ ] **Step 2:** implementar: depois do `update` que grava o eco (e só se ele gravou), recarregar `status` e `activation_requested_at` do canal e, se elegível, chamar a RPC. Outcome `conversation_parity_verified_activated` quando ativar.
- [ ] **Step 3:** vitest. Commit `feat(whatsapp): eco do aparelho ativa canal com pedido de ativacao`.

---

### Task 7: `manage-channels` — ações do onboarding e do admin

**Depende das Tasks 2–5.**

**Files:**
- Modify: `supabase/functions/manage-channels/index.ts`
- Modify: `src/lib/datafy-partner-wiring-guard.test.ts`

**Ações:**
- `CLIENT_LIFECYCLE_ACTIONS` ganha `official_connection_state`, `official_connect_start`, `official_connect_confirm`. Continuam passando por `memberLifecycleRole` (owner/gerente) ou `platformAdmin`.
- `grant_official_connection` / `revoke_official_connection` (admin): insere ou revoga com ator. Revogar com onboarding aberto marca o onboarding `abandoned` e **não** cancela nada na Datafy (o canal em trial expira sozinho; registrar na resposta).
- `official_connection_state`: devolve `deriveOfficialChecklist` + `{ granted, onboardingState }`. Nunca token, secret, WABA bruta ou URL.
- `official_connect_start`:
  1. `getDatafyAccountToken()`; falha → 503 `DATAFY_ACCOUNT_UNAVAILABLE`.
  2. Gates: liberação ativa, `resolveWhatsAppGateByUnit`, `checkChannelConnectionAllowance(unitId, "datafy", {})`, unidade sem canal ativo. Se o onboarding aberto tem `datafy_channel_id`, `getChannel` → `RemoteChannelState` (`not_found` → `found: false`; outro erro → 503 `DATAFY_UNAVAILABLE`). `decideStartStep`. O handler repete decidir → executar até chegar a `issue_link`, `go_confirm` ou recusa, com teto de iterações (6) e relendo o onboarding a cada volta.
  3. `open_onboarding` → insert (o índice único resolve corrida: `23505` → reler).
  4. `create_channel` → `claim_datafy_onboarding_step(…, 'create_channel')`. `claimed = false` → 409 `ONBOARDING_BUSY`. `must_reconcile = true` → `listChannels()` e `decideChannelReconciliation` (Fase 0, §4 item 1: `name` não é único e a listagem não tem `created_at`):
     - `absent` → release `reconciled_absent` e novo claim (agora sem reconciliação pendente);
     - `adopt` → `getChannel(adotado)` → `decideAdoptedCredentials`: `use` grava como no sucesso abaixo e libera `reconciled_present`; `discard_and_recreate` apaga o adotado (só se `isDisposableRemoteChannel` pelo GET) e trata como `absent`; `refuse` → release `failed` com `last_error` e 409. Os ids de `discard` são apagados com `deleteChannel` **depois** de gravar o adotado, cada um rechecado por `getChannel` + `isDisposableRemoteChannel` imediatamente antes; falha ao apagar só loga (forma, nunca valor) e não bloqueia;
     - `ambiguous` → release `failed` com `last_error = 'DATAFY_RECONCILE_AMBIGUOUS'` e 409; resolve o admin.
     Sem reconciliação pendente: `createChannel({ name: reserved_channel_id, description: "unit:<unit_id>" })`. `transport`/`server_error`/`unrecognized` → release `uncertain` e 503. Sucesso → `UPDATE … where id = X and claim_id = claimId` com `.select()` gravando `datafy_channel_id`, `channel_token`, `webhook_secret`, `state = 'channel_created'` → release `succeeded`.
  5. `recreate_channel` (Fase 0, §4 item 3: trial vencido recusa o link; apagar canal nunca assinado não custa nada): se `remote.found`, `deleteChannel` **só** se `isDisposableRemoteChannel` (404 conta como apagado; outro erro → 503). Depois `UPDATE … set state = 'open', datafy_channel_id = null, channel_token = null, webhook_secret = null, datafy_webhook_id = null where id = X and datafy_channel_id = <antigo>` com `.select()`. O `reserved_channel_id` (e portanto a URL do webhook) não muda. Segue para `create_channel`.
  6. `create_webhook` → `createWebhook(datafyId, { url: <projeto>/functions/v1/webhook-whatsapp?channel=<reserved_channel_id>, events: ["messages","smb_message_echoes"] })`. Antes, o `getChannel` já feito diz se existe webhook com essa URL (idempotência por leitura). Grava `datafy_webhook_id`, `state = 'webhook_ready'`.
  7. `issue_link` → `createConnectLink`; grava só `last_link_at`; responde `{ url }` com `Cache-Control: no-store`. `conflict` (409) aqui significa "sem assinatura e sem trial" que surgiu entre o GET e o POST: responde 409 `DATAFY_LINK_REFUSED`, e o próximo `start` decide pelo GET (recria).
  8. `go_confirm` → responde `{ next: "confirm" }`; o front chama o `confirm`. **Não existe `alreadyConnected`** (Fase 0, §4 item 2: o link de canal conectado devolve 200 e reabre o Embedded Signup com troca de número, por isso nunca é emitido para canal com número).
- `official_connect_confirm`:
  1. Carrega o onboarding aberto da unidade (estado `webhook_ready` ou `connected`). Nenhum dado do corpo além de `unit_id`. Onboarding já `completed` → só devolve o estado (idempotente).
  2. Em `webhook_ready`: liberação ativa e gates entram no `decideConfirm`, que recusa antes de olhar o remoto (sem isso, unidade bloqueada ganharia canal). `getChannel(datafy_channel_id)`. Consulta, **excluindo a linha `id = reserved_channel_id`** e com a mesma expressão normalizada do índice (`btrim`), se o `phone_number_id` ancora outro canal e se o WABA aparece em `whatsapp_template_accounts`/canal de outra organização. `decideConfirm`. `not_connected_yet` → 200 `{ step: "connecting" }`.
  3. `create_channel_row` → insert em `whatsapp_channels` com `id = reserved_channel_id`, `provider = 'datafy'`, `credentials = { access_token: channel_token, phone_number_id, business_account_id: wabaId }`, `webhook_secret`, `external_instance_id = datafy_channel_id`, `status = 'connected'`, `is_active = false`, `async_ingestion_enabled = true`. **Sem checagem e sem coluna de Coexistence** (Fase 0, §4 item 5): a prova é o eco, exigido para ativar. `23505` no índice de número → 409. Onboarding → `connected`. **O pedido de ativação não é feito aqui** (achado da Task 5): se o eco chegasse com a assinatura pendente (cartão recusado), o canal ativaria em trial e cairia sozinho quando o trial vencesse.
  4. Assinatura: claim `subscribe`; **sempre um `getChannel` novo depois do claim**; `decideSubscribeStep` com `grant` em três estados (`active`, `consumed_by_this_channel`, `none`). `already_subscribed` → finaliza e libera `reconciled_present` (ou `succeeded` sem reconciliação pendente). `record_subscription` → grava `provider_subscribed_at` pelo GET, libera `reconciled_present`, alerta o admin, e **não** consome liberação, não pede ativação, não fecha o onboarding (assinatura que já aconteceu nunca fica sem registro). Um 2xx do `subscribe` com `subscribed: false` não é sucesso: decide pelo GET seguinte. `subscribe` → `subscribe()`: sucesso → finaliza, release `succeeded`; `payment_declined`/`conflict`/`account_inactive` → release `failed`, `last_error`, alerta `datafy_subscription_failed` (Task 9) e 200 com `step: "subscription_pending"` (a conexão vale, o custo não foi criado); `transport`/`server_error`/`unrecognized` → release `uncertain` e 503 (o próximo `confirm` reconcilia pelo GET). Finalizar = `provider_subscribed_at` no canal (filtrado por `unit_id`), liberação `consumed_*`, `request_whatsapp_channel_activation`, onboarding `completed`, cada `UPDATE` com `.select()`. **Ativação exige assinatura e eco, em qualquer ordem: quem chega por último ativa.** Se o eco já estiver verificado quando a assinatura fecha, o finalizar chama `activate_whatsapp_channel` (a RPC segue sendo a autoridade); senão o eco ativa pela Task 6.
- **Contrato com as RPCs de claim (revisão da Task 2):** as duas recebem `p_unit_id` (o da unidade do chamador). `failed` **não** tira o passo de `uncertain_steps`: num ramo de reconciliação que não resolve (`ambiguous`, `refuse`, erro no GET/list), o onboarding fica bloqueado em reconciliação até o admin resolver (fail-closed). Para limpar a incerteza, liberar `reconciled_*` e reivindicar de novo antes de postar. "Pode ter acontecido" vem de `datafyMutationMayHaveApplied(kind)` do cliente, nunca redigitado. O timeout HTTP do cliente (teto 20 s) fica abaixo do piso de TTL do claim (30 s), e o handler não passa TTL próprio.
- `channel_token` e `webhook_secret` do onboarding são zerados no mesmo `UPDATE` que o leva a `completed` ou `abandoned` (CHECK da migration).
- `consumed_channel_id` da liberação só é gravado depois que a linha de `whatsapp_channels` existe: o guard da migration exige canal existente **da mesma unidade** (23514 caso contrário). Organização, unidade e `grant_id` já gravado são imutáveis no banco; a mesma liberação não alimenta dois onboardings vivos (índice `one_per_grant`).
- No caminho de recriar, `getChannel` do canal adotado pode dar 404 (a listagem pode ainda mostrar o canal recém-apagado): tratar como `absent`.
- `revoke_official_connection` com onboarding em `connected` (linha criada, sem assinatura): marca `abandoned` e deixa a linha inativa; o painel mostra "liberação revogada, canal inativo" (não "assinatura pendente").
- Admin: `datafy_subscribe`, `datafy_cancel`, `datafy_pause`, `datafy_resume` agem sobre `whatsapp_channels.external_instance_id` do canal da unidade; atualizam `provider_*_at` a partir do `getChannel` pós-operação (o efetivo, não o pedido; Fase 0, §4 item 7: essas operações não foram medidas).
- `datafy_link_existing` (Moralles), **em duas fases, porque fingerprint de número não prova dono de canal** (Fase 0, §1: o mesmo número estava num canal de outro sistema de teste na mesma conta):
  - `preview` (padrão): `listChannels` → candidatos com `phoneNumberId === credentials.phone_number_id` do canal da unidade. Devolve, só para platform_admin, `name`, prefixo de 8 do id, `subscribed`, `paused` e o host de cada webhook (do `getChannel`). Não grava nada.
  - `link`: exige `expected_datafy_channel_id` no corpo, aceito **só** se estiver entre os candidatos de uma listagem nova feita na mesma chamada. `getChannel` → grava `external_instance_id`, `credentials.access_token` e `webhook_secret` do GET (o `phone_number_id` tem de ser igual ao gravado), `provider_subscribed_at` conforme `subscribed`; cria o webhook com a URL do canal se não houver. Trocar credencial invalida a prova de eco: conferir o trigger de paridade (se ele exigir `is_active = false`, a mesma escrita desativa e grava `activation_requested_at`, e o eco reativa pela Task 6). O painel (Task 11) mostra o nome e pede confirmação explícita daquele canal antes do `link`.

- [ ] **Step 1:** estender o teste estático: (a) toda chamada `createChannel(`/`subscribe(` é precedida de `claim_datafy_onboarding_step` no mesmo bloco; (b) nenhuma ação Datafy lê `body.datafy_channel_id`, `body.phone_number_id`, `body.waba_id` ou `body.channel_id` para escolher canal Datafy; (c) nenhum `console.*`/`jsonLog` recebe `url`, `channel_token`, `webhook_secret` ou o token de conta; (d) a resposta do `start` define `Cache-Control: no-store`; (e) toda chamada `deleteChannel(` é precedida de `isDisposableRemoteChannel(` no mesmo bloco; (f) nenhum ramo lê `coexistence` do corpo nem grava coluna de Coexistence; (g) não existe `alreadyConnected` no arquivo.
- [ ] **Step 2:** implementar as ações, mantendo a decisão nos núcleos. Mensagens de erro em PT-BR, curtas, sem `error.message` do Postgres.
- [ ] **Step 3:** eslint (`npm run lint`), vitest, typecheck. Commit `feat(whatsapp): conexao oficial self-service no manage-channels`.

---

### Task 8: `begin_switch` aceita Datafy só na primeira configuração

**Files:**
- Modify: `supabase/functions/manage-channels/index.ts` (allowlist do `begin_switch`)
- Modify: `src/lib/datafy-partner-wiring-guard.test.ts`

- [ ] **Step 1:** teste estático: a allowlist inclui `datafy`, e há recusa `DATAFY_MIGRATION_NOT_SUPPORTED` (409) quando a unidade tem canal ativo de outro provider. Controle positivo: remover a recusa e ver o teste falhar.
- [ ] **Step 2:** implementar. O resto do caminho manual (`request_whatsapp_channel_activation` → exige eco → `getConnectionStatus` → `activate_whatsapp_channel`) não muda.
- [ ] **Step 3:** commit `feat(whatsapp): ativar canal Datafy na primeira configuracao pelo painel`.

---

### Task 9: Alerta operacional externo

**Files:**
- Create: `supabase/functions/_shared/ops-alert-sender.ts` (extraído de `createTemplateAlertSender`, mesmo comportamento)
- Modify: `supabase/functions/_shared/whatsapp-template-worker.ts` (reexporta ou importa o sender extraído, sem mudar comportamento)
- Create: `supabase/functions/_shared/ops-alert-core.ts`
- Create: `src/lib/ops-alert-core.test.ts`
- Modify: `supabase/functions/process-whatsapp-channel-health/index.ts`

**Interfaces:**
- `decideInboundAlerts(input: { now: string; units: { unitId: string; channelId: string | null; newDeadSince: number; deadWatermark: string | null; oldestNonTerminalAt: string | null; lastSent: Partial<Record<AlertType, string>> }[]; maxBacklogAgeMs: number; minIntervalMs: number }): { unitId: string; type: AlertType; payload: OpsAlertPayload; newWatermark: string | null }[]`.
- `OpsAlertPayload = { event: AlertType; unit_id: string; channel_id: string | null; count?: number; oldest_age_seconds?: number; generated_at: string }`. Nada além disso.
- `maxBacklogAgeMs` importa `MAX_PENDING_BACKLOG_AGE_MS` de `src/lib/whatsapp-inbound-backlog.ts`? **Não:** o backend não importa de `src/`. Mover a constante (ou a função que a deriva) para `whatsapp-inbound-queue-core.ts` e fazer o arquivo de `src/` reexportar. Teste que garante o mesmo valor nos dois lados.

- [ ] **Step 1:** testes do núcleo: dead novo → alerta com `count`; nenhum novo → nada; backlog acima do limite → `inbound_backlog_stalled`; reenvio dentro de `minIntervalMs` (padrão 30 min) suprimido; payload sem chave fora da lista (teste serializa e confere o conjunto de chaves).
- [ ] **Step 2:** no health worker, depois da observação de conexão: consultar contagem de `dead` com `updated_at > watermark` e a linha não terminal mais antiga por unidade (comparações de tempo no SQL ou contra `now()` do banco, seguindo o critério de relógio do CLAUDE.md); decidir; enviar com `WHATSAPP_OPS_ALERT_URL`; gravar `whatsapp_ops_alerts` **depois** de `delivered: true`. `unconfigured` vai para a resposta do worker e para o log.
- [ ] **Step 3:** vitest + eslint. Commit `feat(whatsapp): alerta externo de dead-letter e fila parada`.

---

### Task 10: Portal do lojista

**Files:**
- Create: `src/hooks/useOfficialConnection.ts` (state/start/confirm via `manage-channels`)
- Create: `src/components/whatsapp/OfficialConnectionCard.tsx`
- Create: `src/components/whatsapp/OfficialConnectionCard.test.tsx`
- Modify: `src/pages/gestao/Whatsapp.tsx`

Comportamento:
- Query `["official-connection", unitId]` com `refetchInterval` visibility-aware (5 s enquanto `step` for `connecting` ou `awaiting_echo`; 30 s no resto; `false` com aba oculta). Quatro ramos: loading, erro com `refetch`, vazio, conteúdo.
- "Conectar WhatsApp oficial": no `onClick`, **antes de qualquer `await`**, `const popup = window.open("about:blank", "datafy-conexao", "width=600,height=760")`; depois chama `start`; com `url` → `popup.location.href = url`; erro → `popup.close()` e toast. A URL não entra em estado React persistido, query key nem log.
- Listener `message` registrado enquanto o card está montado; `classifyConnectMessage(event)`: `connected` → chama `confirm`; `connected_without_app` → **não** chama o `confirm` sozinho e mostra o aviso "Este número foi conectado sem o app WhatsApp Business. O sistema só funciona com o número no app (Coexistence): sem ele, o canal não entra no ar. Fale com o suporte antes de continuar."; `error` → toast "A conexão não foi concluída. Tente de novo na janela da Datafy."; `ignore` → nada. O aviso é de UX, não barreira (Fase 0, §4 item 5): o `postMessage` não é fonte confiável, e quem impede canal sem app de operar é a exigência do eco.
- Resposta `{ next: "confirm" }` do `start` → chama `confirm` sem abrir link (fecha a janela vazia).
- Botão secundário "Já concluí a conexão" → `confirm`.
- Checklist e copy: pré-requisitos antes de conectar; depois, "Envie uma mensagem pelo app WhatsApp Business no celular para qualquer contato"; "Cadastre o cartão na sua conta Meta" com os passos de Configurações de pagamento; aviso de templates quando `templatesPending`; "Abra o app WhatsApp Business ao menos a cada 14 dias".
- `Whatsapp.tsx`: com liberação ativa, o card oficial substitui o estado "Nenhum número conectado / … QR Code" e nenhum botão de QR é exibido.

- [ ] **Step 1:** testes de componente (Testing Library + jsdom): `window.open` chamado **sincronamente** no clique (espiar e afirmar que foi chamado antes da resolução da promise do `start`); evento com origem errada não chama `confirm`; evento válido chama `confirm` uma vez; evento com `coexistence: false` mostra o aviso e não chama `confirm`; dois eventos válidos seguidos não chamam `confirm` duas vezes enquanto o primeiro está pendente (guarda reentrante); a URL não aparece no DOM.
- [ ] **Step 2:** implementar. **Step 3:** typecheck, vitest, lint. Commit `feat(portal): conexao do WhatsApp oficial pelo lojista`.

---

### Task 11: Painel da plataforma e Diagnóstico

**Files:**
- Modify: `src/pages/gestao/Automacao.tsx`
- Modify: `src/pages/platform/Automacao.tsx` (rótulo e grupo do `datafy_account_token`)
- Modify: `src/hooks/useWhatsAppChannels.ts` (tipos e ações admin novas)
- Modify: `supabase/functions/whatsapp-health/index.ts`
- Modify: `src/hooks/useWhatsAppHealth.ts`

Itens:
- Liberar/revogar conexão oficial da unidade, com confirmação.
- Card Datafy: checklist de `deriveOfficialChecklist` + modo de ingestão efetivo (coluna + flag + capability, calculado no backend) + ações `datafy_subscribe`/`cancel`/`pause`/`resume`/`link_existing`. Cancelar e pausar pedem confirmação com o efeito escrito ("o número para de enviar e receber"). `link_existing` mostra o resultado do `preview` (nome, prefixo do id, assinatura, hosts dos webhooks) e só chama o `link` depois de o admin confirmar aquele canal pelo nome.
- **Assinado sem eco (Fase 0, §4 item 5):** no passo `awaiting_echo`, mostrar há quanto tempo o canal está assinado (`provider_subscribed_at`). Passadas 24 h, a copy diz: "Assinado há X sem mensagem do app. Confirme com o lojista se o número está no app WhatsApp Business; se for um número só de API, ele nunca vai ativar: cancele a assinatura." É o caminho de saída do único custo que a decisão do item 5 aceita.
- Correções do levantamento: ramo Datafy no `EditChannelDialog` (campo de token); toast de rotação específico por provider (Datafy: "Segredo atualizado. Envie uma mensagem pelo celular e use Ativar."); `activation_requested_at` visível; `AddChannelDialog` parte de `default_whatsapp_provider` da organização.
- Tela de segredos da plataforma (`src/pages/platform/Automacao.tsx`, não a de gestão): `SECRET_LABELS`/`SECRET_PLACEHOLDERS` para `datafy_account_token` (placeholder `sk_acct_...`), grupo "WhatsApp oficial (Datafy)" fora do card "Pagamentos", e copy própria no diálogo de remoção ("a conexão oficial de novas lojas fica indisponível"). Sem isso a chave aparece com o nome cru, e o diálogo diz "funcionalidades de pagamento". (Achado da revisão da Task 3.)
- `whatsapp-health`: escolher também o canal em onboarding (inativo, mais recente) quando não houver ativo, marcando `is_active` no payload; expor `ingestion_mode_effective` e `ops_alert_configured` (booleano, nunca a URL).
- [ ] **Step 1:** testes de componente para liberar/revogar e para a confirmação de cancelar. **Step 2:** implementar. **Step 3:** gates. Commit `feat(platform): onboarding Datafy no painel e diagnostico`.

---

### Task 12: Invariantes, checklist de redeploy e runbook

**Files:**
- Modify: `CLAUDE.md` e `AGENTS.md` (juntos)
- Create: `docs/datafy-parceiro-runbook.md`

- [ ] **Invariantes** (formato do CLAUDE.md: regra em 1 frase + por quê + ponteiro):
  - Onboarding Datafy vive em `whatsapp_datafy_onboardings`; a linha de `whatsapp_channels` só nasce com `phone_number_id` do GET da Datafy.
  - Passo que gera custo na Datafy só depois de `claim_datafy_onboarding_step`; `must_reconcile` proíbe POST antes de reconciliar.
  - `sk_acct_` só em `platform_secrets`, sem fallback de env.
  - ~~`decideIngestionMode` exige `inboundRedelivery = "documented"`; substitui a frase "nada no código verifica isso".~~ Feito na Task 1: as duas regras do gate ("TRÊS pernas" e "só provider que reentrega entra na fila") já estão no par CLAUDE.md/AGENTS.md.
  - Atualizar a frase de `automaticWebhook`/"a Datafy responde 403 a `webhook_configuration`": vale para o token de canal; o de conta cria webhook.
  - `begin_switch` aceita `datafy` só sem canal ativo.
  - Coexistence de canal Datafy é provado pelo eco do aparelho, nunca pelo `confirm` (o GET não traz o campo); o `confirm` assina assim que o número aparece no GET, e número sem app fica assinado e inativo até o admin cancelar.
  - Link de conexão só para canal sem número: em canal conectado ele devolve 200 e permite trocar o número.
- [ ] **Checklist de redeploy:** linhas para `datafy-admin-client.ts` (importa `DATAFY_BASE_URL` de `datafy-client.ts`, então quem o importa herda o alcance de `datafy-client.ts`, `whatsapp-template-provider-core.ts` e `phone.ts`), `datafy-account-config*.ts`, `datafy-onboarding-core.ts` (frontend importa direto), `ops-alert-sender.ts`/`ops-alert-core.ts` e a mudança de `whatsapp-inbound-queue-core.ts` (agora também lido pelo health worker).
- [ ] **Runbook:** pré-requisitos da conta Datafy (assinatura ativa, marca na aba Parceiros), cadastro do token no painel, `WHATSAPP_OPS_ALERT_URL` via `supabase secrets set`, passo a passo de liberar uma loja, o que o lojista faz, como reconciliar `uncertain`, como pausar/cancelar, e a ordem de deploy.
- [ ] Commit `docs: invariantes e runbook do parceiro Datafy no par CLAUDE.md/AGENTS.md`.

---

### Task 13: Gates whole-branch

- [ ] `npm run typecheck`, `npm test`, `npm run lint` verdes.
- [ ] Pré-voo local completo verde, incluindo o 61.
- [ ] Auditores `saas-shield-br`: `rls-auditor` e `migration-validator` (migration da Task 2), `tenant-isolation-auditor` e `identity-access-auditor` (ações do `manage-channels`), `integration-reliability-auditor` (cliente, claim, reconciliação, webhook, alerta), `secret-hunter` (diff inteiro). Achado P0/P1 bloqueia merge.
- [ ] Review whole-branch (spec + qualidade).
- [ ] `acl-estatico` conferido no PR.

### Task 14: Deploy e piloto (cada passo com autorização do dono)

1. `supabase db push` (migration da Task 2) e conferência de ACL e índices em produção.
2. Deploy das EFs: `manage-channels`, `webhook-whatsapp`, `process-whatsapp-channel-health`, `whatsapp-health`, `manage-platform-secrets`, `process-whatsapp-templates` (sender extraído), mais as consumidoras de `whatsapp-provider-core.ts`/`whatsapp-inbound-queue-core.ts` conforme o checklist atualizado.
3. Frontend (merge na `main` dispara a Vercel).
4. Dono cadastra `datafy_account_token` no painel e `WHATSAPP_OPS_ALERT_URL` via `supabase secrets set`; confirmar recebimento de um alerta de teste.
5. `datafy_link_existing` na Moralles; conferir `external_instance_id` e assinatura.
6. Piloto com a segunda loja: liberar → lojista conecta → assinatura → eco → ativo, sem SQL. Acompanhar a fila e Entregas na primeira semana.
