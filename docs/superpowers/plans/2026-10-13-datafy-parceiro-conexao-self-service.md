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

**Estado em 2026-10-14:** rodada feita, relatório em [2026-10-13-datafy-parceiro-validacao-fase0.md](../specs/2026-10-13-datafy-parceiro-validacao-fase0.md). Pendente: revisão do dono, a decisão do item 5 da §4 (`coexistence` ausente do GET × §11.1) e a aplicação das decisões da §4 nas Tasks 4, 5 e 7 antes de a Task 4 começar.

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
   - `id`, `organization_id`, `unit_id`, `grant_id references whatsapp_official_connection_grants`, `reserved_channel_id uuid not null unique default gen_random_uuid()`, `datafy_channel_id text unique`, `channel_token text`, `webhook_secret text`, `datafy_webhook_id text`, `state text not null default 'open'` CHECK em `('open','channel_created','webhook_ready','connected','completed','abandoned')`, `coexistence boolean`, `claim_id uuid`, `claim_step text` CHECK em `('create_channel','create_webhook','subscribe')`, `claim_started_at timestamptz`, `uncertain_steps text[] not null default '{}'`, `last_error text` CHECK `~ '^[A-Z0-9_]{1,64}$'`, `last_link_at timestamptz`, `completed_at`, `abandoned_at`, `created_at`, `updated_at`.
   - CHECK `((claim_id is null) = (claim_started_at is null)) and ((claim_id is null) = (claim_step is null))`.
   - Índice único parcial `(unit_id) where state not in ('completed','abandoned')`.
   - Trigger de coerência org × unit.
3. `whatsapp_channels`: `add column if not exists provider_subscribed_at timestamptz, provider_subscription_canceled_at timestamptz, provider_paused_at timestamptz, provider_coexistence boolean`. Índice único parcial `whatsapp_channels_meta_phone_number_idx on ((credentials->>'phone_number_id')) where provider in ('official','datafy') and credentials ? 'phone_number_id'`. **Antes de criar, o pré-voo e a conferência de produção provam que não há duplicata** (Moralles e eventuais `official` legados).
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

- [ ] **Step 1: Escrever o pré-voo primeiro** (`61-datafy-partner-onboarding.sql`), no molde dos arquivos 18–21 e 56–60. Casos:
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
- [ ] **Step 2: Rodar o pré-voo e ver falhar** (migration ainda inexistente), conforme o README do harness.
- [ ] **Step 3: Escrever a migration** até o pré-voo passar. Reaplicar duas vezes (idempotência).
- [ ] **Step 4: Conferir duplicata em produção (leitura).** `select credentials->>'phone_number_id', count(*) from whatsapp_channels where provider in ('official','datafy') group by 1 having count(*) > 1;` precisa voltar vazio. Se não voltar, parar e reportar.
- [ ] **Step 5: Allowlist de ACL** com as duas assinaturas completas; `acl-estatico` local (`npx vitest run scripts/` ou o comando do workflow) verde.
- [ ] **Step 6: Commit** `feat(db): liberacao, onboarding Datafy com claim cercado e ledger de alertas`.

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

- [ ] **Step 1:** testes do núcleo (os quatro desfechos + controle positivo: um `{ value: {} }` precisa dar `malformed`, nunca `"[object Object]"`).
- [ ] **Step 2:** implementar núcleo e adapter. O adapter **não** lê `Deno.env` para o token (teste estático lendo o arquivo reprova `Deno.env.get("DATAFY`).
- [ ] **Step 3:** `manage-platform-secrets`: chave `datafy_account_token`, descrição "Token de conta da Datafy (sk_acct_...), acesso a todos os canais da conta", e `clearDatafyAccountConfigCache()` na limpeza central.
- [ ] **Step 4:** typecheck + vitest. Commit `feat(datafy): token de conta em platform_secrets sem fallback de env`.

---

### Task 4: Cliente da API de administração Datafy

**Depende da Task 0** (formas medidas).

**Files:**
- Create: `supabase/functions/_shared/datafy-admin-client.ts`
- Create: `src/lib/datafy-admin-client.test.ts`

**Interfaces (ajustar nomes de campo ao relatório da Fase 0):**

```ts
export type DatafyAdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "unauthorized" | "account_inactive" | "not_found" | "conflict" | "payment_declined" | "invalid" | "transport" | "unrecognized"; httpStatus: number | null; code: string };

export interface DatafyChannelCreated { id: string; token: string; webhookSecret: string; subscribed: boolean }
export interface DatafyChannelSnapshot {
  id: string; name: string; subscribed: boolean; onTrial: boolean; trialEndsAt: string | null; paused: boolean;
  phoneNumberId: string | null; wabaId: string | null; businessId: string | null; displayPhone: string | null;
  token: string | null; webhookSecret: string | null; webhooks: { id: string; url: string; events: string[]; enabled: boolean }[];
}
export interface DatafyChannelListItem { id: string; name: string; phoneNumberId: string | null; subscribed: boolean }

export function createDatafyAdminClient(deps: { token: string; fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number }): {
  listChannels(): Promise<DatafyAdminResult<{ accountSubscription: string | null; channels: DatafyChannelListItem[] }>>;
  createChannel(input: { name: string; description: string }): Promise<DatafyAdminResult<DatafyChannelCreated>>;
  getChannel(id: string): Promise<DatafyAdminResult<DatafyChannelSnapshot>>;
  createWebhook(id: string, input: { url: string; events: string[] }): Promise<DatafyAdminResult<{ webhookId: string }>>;
  createConnectLink(id: string): Promise<DatafyAdminResult<{ url: string; expiresInSeconds: number }>>;
  subscribe(id: string): Promise<DatafyAdminResult<{ subscribed: boolean }>>;
  cancel(id: string): Promise<DatafyAdminResult<{ subscribed: boolean }>>;
  pause(id: string): Promise<DatafyAdminResult<{ paused: boolean }>>;
  resume(id: string): Promise<DatafyAdminResult<{ paused: boolean }>>;
};
```

Regras:
- Token em `Authorization: Bearer`, `redirect: "error"`, timeout padrão 10 s. `id` passa por `encodeURIComponent` e por validação de formato (rejeita `/`, `..`, vazio) **antes** do fetch.
- Classificação: 401 → `unauthorized`; 403 → `account_inactive`; 404 → `not_found`; 409 → `conflict`; 402 → `payment_declined`; 400 → `invalid`; exceção de rede ou timeout → `transport`; 2xx com corpo fora do esperado → `unrecognized` + log `shapeOf` (de `webhook-payload-shape-core.ts`).
- `code` é token fixo (`DATAFY_CONFLICT`, …), nunca a mensagem da Datafy (pode conter dado) e nunca `String(error)` (pode conter URL).
- `createConnectLink` devolve a URL só dentro do `value`; o tipo do erro não a carrega.
- Leitura de campo de credencial passa por `typeof === "string"`, nunca `String(...)`.

- [ ] **Step 1:** testes com `fetchImpl` falso, por operação: sucesso com a forma medida; cada status mapeado; `transport`; `unrecognized`. **Teste de redação:** serializar todo resultado de erro e afirmar que não contém o token injetado, `sk_live_`, `whsec_`, `ct_` nem a URL do link (controle positivo: trocar `code` por `String(error)` e ver falhar).
- [ ] **Step 2:** implementar. **Step 3:** typecheck + vitest. Commit `feat(datafy): cliente da API de administracao do parceiro`.

---

### Task 5: Núcleo do onboarding

**Files:**
- Create: `supabase/functions/_shared/datafy-onboarding-core.ts`
- Create: `src/lib/datafy-onboarding-core.test.ts`

**Interfaces:**

```ts
export type OnboardingState = "open" | "channel_created" | "webhook_ready" | "connected" | "completed" | "abandoned";

/** O que o `start` deve fazer a seguir, dado o estado persistido. */
export function decideStartStep(input: {
  grantActive: boolean;
  gatesAllowed: boolean;           // resolveWhatsAppGateByUnit + checkChannelConnectionAllowance
  unitHasActiveChannel: boolean;
  onboarding: { state: OnboardingState; datafyChannelId: string | null; datafyWebhookId: string | null } | null;
}):
  | { kind: "refuse"; code: "GRANT_REQUIRED" | "PROVISIONING_BLOCKED" | "UNIT_ALREADY_ACTIVE" | "ONBOARDING_CLOSED" }
  | { kind: "open_onboarding" }
  | { kind: "create_channel" }
  | { kind: "create_webhook" }
  | { kind: "issue_link" };

/** Valida o GET da Datafy contra o que o `confirm` exige. Nada vem do navegador. */
export function decideConfirm(input: {
  snapshot: { phoneNumberId: string | null; wabaId: string | null; businessId: string | null; coexistence: boolean | null };
  phoneNumberIdTakenByOtherChannel: boolean;
  wabaOwnedByOtherOrganization: boolean;
}):
  | { kind: "not_connected_yet" }
  | { kind: "refuse"; code: "COEXISTENCE_REQUIRED" | "PHONE_NUMBER_ALREADY_BOUND" | "WABA_OWNED_BY_OTHER_ORG" }
  | { kind: "create_channel_row"; phoneNumberId: string; wabaId: string | null; businessId: string | null };

/** Valida o MessageEvent do navegador. Só diz "houve conclusão"; não devolve dado. */
export const DATAFY_CONNECT_ORIGIN = "https://app.datafyapi.com.br";
export function classifyConnectMessage(event: { origin: string; data: unknown }): "connected" | "error" | "ignore";

/** Checklist mostrado ao lojista e ao admin, derivado só de estado persistido. */
export function deriveOfficialChecklist(input: {
  grantActive: boolean;
  onboardingState: OnboardingState | null;
  channel: { status: string | null; isActive: boolean | null; subscribedAt: string | null; echoVerifiedAt: string | null; activationRequestedAt: string | null } | null;
  automationDispatchAdopted: boolean;
}): { step: "not_granted" | "ready_to_connect" | "connecting" | "subscription_pending" | "awaiting_echo" | "active"; items: { id: string; done: boolean }[]; templatesPending: boolean };
```

Observações:
- `coexistence` vem do GET se a Fase 0 mostrar que ele existe lá; senão vem do `postMessage` **apenas** para escolher a copy, e o `confirm` lê do GET o que houver. Ajustar à Fase 0 e registrar a escolha no núcleo.
- `classifyConnectMessage` é importado pelo frontend direto de `supabase/functions/_shared/` (cross-boundary deliberado, mesmo motivo de `whatsapp-implementation-core.ts`).

- [ ] **Step 1:** testes. Casos-chave: liberação revogada → `GRANT_REQUIRED`; unidade já com canal ativo → `UNIT_ALREADY_ACTIVE`; onboarding em `webhook_ready` → `issue_link` sem recriar nada; `coexistence = false` → `COEXISTENCE_REQUIRED`; número já ancorado → recusa; origem `https://app.datafyapi.com.br.evil.com` → `ignore`; `data.source !== "datafy"` → `ignore`; `data` não-objeto → `ignore`. Controle positivo: trocar a comparação de origem por `startsWith` e ver o caso `.evil.com` falhar.
- [ ] **Step 2:** implementar. **Step 3:** vitest. Commit `feat(datafy): nucleo puro do onboarding self-service`.

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
  2. Gates: liberação ativa, `resolveWhatsAppGateByUnit`, `checkChannelConnectionAllowance(unitId, "datafy", {})`, unidade sem canal ativo. `decideStartStep`.
  3. `open_onboarding` → insert (o índice único resolve corrida: `23505` → reler).
  4. `create_channel` → `claim_datafy_onboarding_step(…, 'create_channel')`. `claimed = false` → 409 `ONBOARDING_BUSY`. `must_reconcile = true` → `listChannels()` procurando `name === reserved_channel_id`: achou → `getChannel` para token e secret, grava e libera com `reconciled_present`; não achou → libera `reconciled_absent` e repete o claim. Sem reconciliação pendente: `createChannel({ name: reserved_channel_id, description: "unit:<unit_id>" })`. `transport`/`unrecognized` → release `uncertain` e 503. Sucesso → `UPDATE … where id = X and claim_id = claimId` com `.select()` gravando `datafy_channel_id`, `channel_token`, `webhook_secret`, `state = 'channel_created'` → release `succeeded`.
  5. `create_webhook` → `createWebhook(datafyId, { url: <projeto>/functions/v1/webhook-whatsapp?channel=<reserved_channel_id>, events: ["messages","smb_message_echoes"] })`. Antes, `getChannel` para ver se já existe webhook com essa URL (idempotência por leitura). Grava `datafy_webhook_id`, `state = 'webhook_ready'`.
  6. `issue_link` → `createConnectLink`; grava só `last_link_at`; responde `{ url }` com `Cache-Control: no-store`. `conflict` (já conectado) → responde `{ alreadyConnected: true }` para o front chamar o `confirm`.
- `official_connect_confirm`:
  1. Carrega o onboarding aberto da unidade (estado ≥ `webhook_ready`). Nenhum dado do corpo além de `unit_id`.
  2. `getChannel(datafy_channel_id)`. Consulta se o `phone_number_id` ancora outro canal e se o WABA aparece em `whatsapp_template_accounts`/canal de outra organização. `decideConfirm`.
  3. `create_channel_row` → insert em `whatsapp_channels` com `id = reserved_channel_id`, `provider = 'datafy'`, `credentials = { access_token: channel_token, phone_number_id, business_account_id: wabaId }`, `webhook_secret`, `external_instance_id = datafy_channel_id`, `status = 'connected'`, `is_active = false`, `async_ingestion_enabled = true`, `provider_coexistence = true`. `23505` no índice de número → 409. Depois `request_whatsapp_channel_activation`. Onboarding → `connected`.
  4. Assinatura: claim `subscribe` (com reconciliação por `getChannel().subscribed` quando `must_reconcile`). `subscribe` → sucesso: `provider_subscribed_at`, liberação `consumed_*`, onboarding `completed`, release `succeeded`. `payment_declined`/`conflict` → release `failed`, `last_error`, alerta `datafy_subscription_failed` (Task 9) e resposta 200 com `step: "subscription_pending"`: a conexão vale, o custo não foi criado.
  5. Idempotente: onboarding já `completed` → só devolve o estado.
- Admin: `datafy_subscribe`, `datafy_cancel`, `datafy_pause`, `datafy_resume` agem sobre `whatsapp_channels.external_instance_id` do canal da unidade; atualizam `provider_*_at` a partir do `getChannel` pós-operação (o efetivo, não o pedido). `datafy_link_existing` (Moralles): `listChannels` → canal com `phoneNumberId === credentials.phone_number_id` → grava `external_instance_id` e `provider_subscribed_at` conforme `subscribed`.

- [ ] **Step 1:** estender o teste estático: (a) toda chamada `createChannel(`/`subscribe(` é precedida de `claim_datafy_onboarding_step` no mesmo bloco; (b) nenhuma ação Datafy lê `body.datafy_channel_id`, `body.phone_number_id`, `body.waba_id` ou `body.channel_id` para escolher canal Datafy; (c) nenhum `console.*`/`jsonLog` recebe `url`, `channel_token`, `webhook_secret` ou o token de conta; (d) a resposta do `start` define `Cache-Control: no-store`.
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
- Listener `message` registrado enquanto o card está montado; `classifyConnectMessage(event)`: `connected` → chama `confirm`; `error` → toast "A conexão não foi concluída. Tente de novo na janela da Datafy."; `ignore` → nada.
- Botão secundário "Já concluí a conexão" → `confirm`.
- Checklist e copy: pré-requisitos antes de conectar; depois, "Envie uma mensagem pelo app WhatsApp Business no celular para qualquer contato"; "Cadastre o cartão na sua conta Meta" com os passos de Configurações de pagamento; aviso de templates quando `templatesPending`; "Abra o app WhatsApp Business ao menos a cada 14 dias".
- `Whatsapp.tsx`: com liberação ativa, o card oficial substitui o estado "Nenhum número conectado / … QR Code" e nenhum botão de QR é exibido.

- [ ] **Step 1:** testes de componente (Testing Library + jsdom): `window.open` chamado **sincronamente** no clique (espiar e afirmar que foi chamado antes da resolução da promise do `start`); evento com origem errada não chama `confirm`; evento válido chama `confirm` uma vez; dois eventos válidos seguidos não chamam `confirm` duas vezes enquanto o primeiro está pendente (guarda reentrante); a URL não aparece no DOM.
- [ ] **Step 2:** implementar. **Step 3:** typecheck, vitest, lint. Commit `feat(portal): conexao do WhatsApp oficial pelo lojista`.

---

### Task 11: Painel da plataforma e Diagnóstico

**Files:**
- Modify: `src/pages/gestao/Automacao.tsx`
- Modify: `src/hooks/useWhatsAppChannels.ts` (tipos e ações admin novas)
- Modify: `supabase/functions/whatsapp-health/index.ts`
- Modify: `src/hooks/useWhatsAppHealth.ts`

Itens:
- Liberar/revogar conexão oficial da unidade, com confirmação.
- Card Datafy: checklist de `deriveOfficialChecklist` + modo de ingestão efetivo (coluna + flag + capability, calculado no backend) + ações `datafy_subscribe`/`cancel`/`pause`/`resume`/`link_existing`. Cancelar e pausar pedem confirmação com o efeito escrito ("o número para de enviar e receber").
- Correções do levantamento: ramo Datafy no `EditChannelDialog` (campo de token); toast de rotação específico por provider (Datafy: "Segredo atualizado. Envie uma mensagem pelo celular e use Ativar."); `activation_requested_at` visível; `AddChannelDialog` parte de `default_whatsapp_provider` da organização.
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
- [ ] **Checklist de redeploy:** linhas para `datafy-admin-client.ts`, `datafy-account-config*.ts`, `datafy-onboarding-core.ts` (frontend importa direto), `ops-alert-sender.ts`/`ops-alert-core.ts` e a mudança de `whatsapp-inbound-queue-core.ts` (agora também lido pelo health worker).
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
