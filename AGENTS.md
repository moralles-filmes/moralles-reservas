# moralles-reservas — contexto para agentes

> Entrada única para Claude Code (via `CLAUDE.md` → `@AGENTS.md`) e Codex. Contém só o que vale em **toda** tarefa. O detalhe de cada assunto está em `.claude/rules/<assunto>.md` (tabela abaixo). Ordem de confiança: código e banco vivo > testes > este texto; divergência é defeito a reportar, não a seguir.

## 1. Projeto

- Reservas de mesa para restaurantes, com agente de IA no WhatsApp, fila de espera, giftback, automações de mensagens e cobrança da plataforma.
- Usuários: dono/gerente/operador de restaurante (painéis), cliente final (portal público e WhatsApp), `platform_admin` (`/platform/*`).
- Criticidade: envia WhatsApp a clientes finais, guarda dados pessoais (LGPD), movimenta dinheiro (caução Stripe, mensalidade Asaas). Repo privado, deploy automático (`main` → Vercel).

## 2. Onde está cada regra

O Claude Code carrega a regra sozinho ao tocar um arquivo do assunto. **Codex e qualquer agente sem esse carregamento: leia o arquivo do assunto antes de editar código dele.** A regra continua obrigatória mesmo não estando aqui.

| Assunto | Arquivo |
|---|---|
| Migrations, RLS, helpers `app_private`, grants/ACL, harness local, CI de ACL | `.claude/rules/banco-de-dados.md` |
| Edge Functions: segredos, workers pg_cron, `verify_jwt`, deploy e redeploy | `.claude/rules/edge-functions.md` |
| Disponibilidade, reservas, clientes, telefone, giftback | `.claude/rules/reservas.md` |
| Frontend: rotas, padrões React/TanStack, storage, wizard, métricas, tema | `.claude/rules/frontend.md` |
| WhatsApp: providers, webhook, fila de inbound, envio/entrega, conversas | `.claude/rules/whatsapp.md` |
| Agente de IA, modelos, BYOK, franquia de IA | `.claude/rules/agente-ia.md` |
| Datafy (parceiro oficial): onboarding, claims, assinatura, migração | `.claude/rules/datafy.md` |
| Templates oficiais, automações, consentimento, preferências | `.claude/rules/whatsapp-templates.md` |
| Billing (Asaas/Stripe), caução, entitlements, custo de instância WhatsApp | `.claude/rules/billing.md` |

Runbooks: `docs/RUNBOOK-ROTACAO-CREDENCIAIS.md`, `docs/whatsapp-multiprovider-uazapi.md`, `docs/datafy-parceiro-runbook.md`, `docs/whatsapp-templates-programados-runbook.md`, `docs/billing-asaas/`. Specs e planos: `docs/superpowers/`.

## 3. Manter este contexto

- **Só entra regra que muda decisão futura:** invariante que evita bug, gotcha de stack, contrato entre features, segurança/multi-tenant. Descobrível em código/`git log`, histórico ("bug X corrigido em Y", "Fase Z", "Task N") e status transitório **não entram** — viram comentário no código ou somem.
- **Formato:** `**regra em 1 frase.** Por quê (1 frase). Ponteiro arquivo.` Sem storytelling, sem datas de incidente.
- **Onde:** regra que vale em toda tarefa → aqui (uma linha). Regra de um assunto → o `.claude/rules/` dele (caminhos repo-relativos; ajuste o `paths:` se o assunto ganhar diretório novo). Assunto novo → arquivo novo + linha na tabela acima.
- Atualize proativamente ao descobrir invariante. Este arquivo fica abaixo de 200 linhas e de ~28 KB (o Codex trunca contexto em 32 KiB).

## 4. Fluxo obrigatório e Git

- Mudança de comportamento, estrutural ou feature: spec em `docs/superpowers/specs/` → plano em `docs/superpowers/plans/` → execução com review por tarefa e review da branch inteira. **Nenhum código antes de spec aprovada.** Exceção só para typo/comentário/doc trivial; em dúvida, rode o fluxo.
- Antes de merge/push que toque banco, auth, Edge Function, webhook, RLS ou multi-tenant: gates de segurança `saas-shield-br:*` (RLS, isolamento de tenant, identidade/acesso, migration, secrets, confiabilidade de integrações). Migration/função SQL/grant/ACL: conferir o check `acl-estatico` na aba Checks (não é required check).
- Antes de commit/merge/push: gates proporcionais ao risco, `git status`, `git diff`, `git diff --cached` (100% do staged). Nunca mergeie com gate vermelho ou conflito.
- `git add <caminho>` explícito; nunca `git add .`/`-A`, `git reset --hard` ou descarte de trabalho alheio.
- Trabalho autorizado em branch/worktree só termina com commit + merge na branch de destino após gates; push conforme autorização (`main` dispara deploy).
- Worktrees vivem em `.claude/worktrees/` e ficam excluídas de Vitest, ESLint e de qualquer ferramenta nova que varra o repo por glob ([vite.config.ts](vite.config.ts), [eslint.config.js](eslint.config.js)).

## 5. Segredos — antes de todo commit

- Procure em toda linha staged: `sk-`, `sk-ant-`, `xai-`, `re_`, `AIza`, `eyJ`, `Bearer `, `Basic `, `service_role`, `whsec_`, `sk_acct_`, `password`/`senha`/`secret`/`token`/`api_key`/`client_token` com valor real, URL com credencial (`https://u:p@`, `postgres://u:p@`), webhook com secret no path/query, hex longo em header de auth.
- Nunca commitar `.env*`, `*.pem`, `*.key`, `id_rsa*`, `service-account*.json`, `supabase/.env`, dumps.
- `VITE_*` é público no bundle: só `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
- Segredo de EF vai por `supabase secrets set`; Stripe/Asaas/Datafy-conta em `platform_secrets`; chave de IA em `ai_provider_credentials` (BYOK por unidade, sem fallback global). Migration nunca embute segredo nem URL do projeto — lê do Vault (`internal_api_key`, `project_url`).
- Secret vazou: pare e **rotacione no provider antes de qualquer push** (reescrever histórico não neutraliza), depois atualize `supabase secrets set` e o Vault. Em dúvida, não commite.
- **`platform_secrets` cai para `Deno.env` em qualquer erro de leitura:** cópia velha em env é credencial viva. Rotacionar no painel exige sincronizar `supabase secrets set` no mesmo ato (ou remover a env).

## 6. Stack e comandos

- Vite + React + TypeScript + Tailwind/shadcn, TanStack Query, React Hook Form + Zod, Sonner; Supabase (Postgres, Auth, Storage, ~50 Edge Functions Deno, pg_cron + pg_net); Vercel; Vitest.
- `npm install --legacy-peer-deps` (`.npmrc` força; react-day-picker × date-fns v4). `npm run dev` (localhost:8080), `lint`, `test`, `build`.
- **Typecheck é `npm run typecheck` = `tsc -b --noEmit`; nunca `tsc --noEmit` sem `-b`** — o root tem `files: []` + references e vira no-op com exit 0. Rode antes de commitar (o dev server SWC não tipa); baseline zero erros. O `tsc -b` não alcança `supabase/functions/`; o gate Deno é `deno check`.
- **`strict: false`: `if (!x.ok) { x.campo }` não estreita união discriminada** (TS2339). Use `x.ok === false` ou early-return. Pior em `supabase/functions/`, onde nem aparece. [tsconfig.app.json](tsconfig.app.json).

## 7. Tenancy e papéis

- `organizations` (cliente SaaS) → `units` (restaurante) → `unit_members` (`owner` > `gerente` > `operador`). Super-admin em `platform_admins`; `admin_users`/`manage-admins` foram removidos — não reinstalar. Perfil declarado em [.claude/tenancy-profile.yml](.claude/tenancy-profile.yml).
- `customers` pertencem à organização (reserva em qualquer unidade); dados operacionais levam `unit_id`; conta WABA e catálogo remoto são da organização, ligados a canal/unidade por bindings validados em guards/RPCs. Não acrescente `unit_id` artificial à conta compartilhada nem infira tenant de id livre do caller.
- Papéis: owner cria units e tem tudo; gerente configura/membros/dados, sem automação; operador atua em reservas/fila/passantes e **não cancela reserva** (trigger + gate na EF service-role).

## 8. Invariantes que valem em qualquer arquivo

- **O tenant vem da sessão + membership, e o guard resolve o tenant pelo PRÓPRIO recurso, nunca por id de escopo enviado pelo caller** (body, query, payload de webhook). Recusa com `42501`, sem oráculo de existência. Detalhe em banco-de-dados.md.
- **Todo guard/policy por `unit_id` tem o paralelo `app_private.is_platform_admin`** — a UI fabrica pseudo-membership "owner" para super-admin. EF usa `hasUnitAccess` de [_shared/authz.ts](supabase/functions/_shared/authz.ts), nunca `rpc("is_unit_member")`.
- **Service role ignora RLS:** EF que a usa autentica o caller, valida o recurso contra o `unit_id` e filtra o tenant em toda query. Tabelas `FORCE RLS` sem policy (credenciais, filas, ledgers) dependem só desse filtro.
- **Função nova (inclusive trigger function) revoga `EXECUTE` de `public, anon, authenticated` e concede ao papel mínimo** — `CREATE FUNCTION` concede a PUBLIC e `public` é exposto pela anon key. `drop`+`create` reabre o grant.
- **Anon só escreve onde previsto e só lê por RPC `SECURITY DEFINER` privacy-safe gateada por `units.is_public`**; coluna nova em `units`/`organizations` nasce invisível para anon.
- **`UPDATE` do supabase-js que casa zero linhas devolve `error: null`:** escrita com predicado de tenant usa `.select()` e confere o tamanho.
- **Edge Functions não compartilham bundle:** mudar `_shared/X.ts` exige redeploy de todas as consumidoras — `node scripts/ef-import-graph.mjs supabase/functions/_shared/X.ts`. Migration que a EF lê (coluna, RPC, valor de CHECK) entra por `supabase db push` **antes** do deploy da EF.
- **Migration só via `supabase db push`, nunca SQL colado no Studio** (drift em `schema_migrations` bloqueia o próximo push).
- **Tempo:** Deno roda em UTC; data/dia "de hoje" e timestamps comparados com o banco usam BRT explícito (`-03:00`). Coluna `time` volta `HH:MM:SS` — `.slice(0, 5)` antes de montar literal.
- **Telefone:** `customers.phone` é canônico sem `55` (`canonicalBrPhone`); destinatário de provider usa `toE164BrPhone`. Nunca `replace(/^55/)` cru — DDD 55 existe.
- **Coluna JSONB nunca é interpolada em template literal** (`${obj}` vira `"[object Object]"`); campo de segredo do corpo passa por `typeof === "string"`, nunca `String(...)`.
- **EF nunca devolve `error.message` cru do Postgres;** mensagem curta PT-BR ao cliente, detalhe no log. Credencial nunca vai a log, DTO ou erro (Z-API põe token no path da URL: redija na fonte).
- **Lote que lê tabela inteira pagina com `.range()` até o fim** — PostgREST trunca em 1000 sem aviso.
- **Erro de leitura de gate/flag nunca vira "OFF" ou "permitido"** sem decisão explícita de polaridade; cada gate documenta se falha aberto ou fechado.

## 9. Deploy

- Frontend: push em `main` → Vercel. Edge Function: `supabase functions deploy <nome>`, depois das migrations, flags e segredos de que ela depende.
- `INTERNAL_API_KEY` vive em Edge secrets **e** no Vault (pg_cron); rotacione Edge primeiro, Vault depois, e confira em `net._http_response` ([runbook](docs/RUNBOOK-ROTACAO-CREDENCIAIS.md) §4). Rotação pela metade silencia todos os workers sem erro visível.

<!-- ai-router-br:start -->
## AI Router BR
When ai-router-br is available (Claude Code skill `ai-router-br:route`, Codex skill `$ai-router`), classify substantial work by risk/cost before executing. Keep critical/security/architecture decisions with the main agent; delegate only when beneficial; external-worker output must be tested and reviewed before integration. Never place secrets in router state.
<!-- ai-router-br:end -->
