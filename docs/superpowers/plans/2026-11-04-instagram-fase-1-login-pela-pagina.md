# Instagram Fase 1 — conexão pela Página do Facebook: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar o Login do Instagram pelo Login do Facebook para Empresas com a Página, para o dono conectar a conta da loja e o Direct funcionar.

**Architecture:**
- O adapter do Graph (`_shared/instagram-graph*.ts`) passa a falar com `graph.facebook.com/v26.0`.
- A `instagram-connect` troca o código pelo token longo do usuário. Esse token só serve para ler `/me/accounts`, de onde sai o token da Página, que não expira e vai para o Vault.
- Uma migration aditiva guarda `page_id` e desliga o agendamento do refresh.
- O envio passa a usar `/{page-id}/messages`. Fila, webhook, núcleo do agente e Conversas não mudam.

**Tech Stack:** Supabase Edge Functions (Deno), Postgres/pg_cron/Vault, React + TanStack Query, Vitest com `edge-request-harness`.

**Spec:** `docs/superpowers/specs/2026-11-04-instagram-fase-1-login-pela-pagina-design.md` (aprovada em 2026-11-04). Este plano encaixa antes do restante do Bloco 6 de `docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md`.

## Global Constraints

- **Meta e IA:** nenhuma chamada real feita por agente. Os testes usam o `transport` do harness; os testes reais são scripts que o responsável roda.
- **Graph:** host `https://graph.facebook.com` e versão `INSTAGRAM_GRAPH_VERSION = "v26.0"` (constante única). Diálogo em `https://www.facebook.com/v26.0/dialog/oauth`.
- **Token do usuário do Facebook:** nunca vai para Vault, banco, log, resposta ou mensagem de erro. Morre na requisição do `callback`.
- **Falhas e logs:**
  - falha do Graph devolve só `errorClass`, `httpStatus` e `code`, nunca texto remoto;
  - logs só com `evt`, `action` e classes/códigos;
  - URL com `client_secret` ou `access_token` na query nunca sai do adapter.
- **Segredos:**
  - `instagram_app_secret` (em `platform_secrets`, sem fallback de env) guarda a chave secreta do app Moralles Reservas 1435590504737997;
  - `meta_app_secret` não muda;
  - env novas: `INSTAGRAM_APP_ID=1435590504737997` e `INSTAGRAM_LOGIN_CONFIG_ID`, só dígitos.
- **Migration:** `lock_timeout 5s`, aditiva, idempotente, CHECK `NOT VALID` + `VALIDATE`. Toda função nova revoga `EXECUTE` de `public, anon, authenticated, service_role` e concede só a `service_role`.
- **Gates:** portabilidade com linha de base 489 (se subir, pare e pergunte); `git add` com caminho explícito; nunca `git stash` sem tag.
- **Textos:** do usuário em PT-BR; o painel mostra a mensagem do backend via `InstagramApiError`.
- **Autorização própria** para cada push, `db push`, `secrets set`, deploy de EF e merge, uma por vez.

## Review Focus

1. **Id da Página como número no JSON** (`"id": 1784…`): ids de 15 a 17 dígitos perdem precisão. `parsePages` aceita string de dígitos ou inteiro seguro e descarta o resto (teste na Task 1).
2. **`page_id` diferente de `ig_user_id`:** a conta é gravada e casada pelo id do Instagram (`instagram_business_account.id`), nunca pelo da Página. O webhook casa `entry[].id` com `ig_user_id` (testes nas Tasks 3 e 4).
3. **Mesma conta do Instagram, outra Página, numa reconexão:** o `page_id` e o token são sobrescritos na mesma linha, que guarda os contatos (teste SQL na Task 2).
4. **Token da Página ou `client_secret` vazando por URL em log ou resposta:** nenhum valor sintético de token, secret ou code aparece em `harness.logs` nem no corpo (teste na Task 3).
5. **Página com Instagram mas sem a tarefa MODERATE/MANAGE**, ou várias Páginas: nada é gravado e a mensagem é a da spec (teste na Task 3).

---

### Task 0: teste de fumaça (ponto de parada, sem código)

**Files:**
- Sem arquivo do repo.
- Script do responsável: `C:\Users\nicol\AppData\Local\Temp\claude\f4a664b9a07f90c9\089e8263-b09a-4ab6-9d1f-2aece552999b\scratchpad\meta-page-login-test.mjs`. Só leitura; nunca imprime token, secret nem code.

- [ ] **Passo 1:** descrever ao responsável a mudança no painel do app 1435590504737997 e esperar autorização. Ele faz a mudança ou autoriza o agente a fazê-la.
  - Login do Facebook para Empresas › Configurações › criar a configuração "Moralles Reservas — Página":
    - tipo de token: Token de acesso do usuário;
    - ativos: Páginas e contas do Instagram;
    - permissões: `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list` e `pages_read_engagement`.
  - Em "URIs de redirecionamento do OAuth válidos", conferir `https://reservas.moralles.com.br/instagram/callback`.
- [ ] **Passo 2:** o responsável roda `node meta-page-login-test.mjs`, escolhe só a Página "Moralles Films" no diálogo e cola a saída aqui.
- [ ] **Passo 3:** conferir o critério:
  - a Página "Moralles Films" aparece com `instagram.username` = `morallesfilmes` e `instagram.id` = `17841470263374765`;
  - as `tasks` incluem `MODERATE` ou `MANAGE`;
  - o token da Página tem `expires_at` 0;
  - a leitura de conversas dá HTTP 200.
  - Registrar `config_id`, `expires_at`, `data_access_expires_at` e escopos nas Evidências.
  - **Se algo falhar ou se `data_access_expires_at` não for 0, pare e traga o resultado ao responsável antes da Task 1.**

### Task 1: núcleo puro do Graph

**Files:**
- Modify: `supabase/functions/_shared/instagram-graph-core.ts`
- Test: `src/lib/instagram-graph-core.test.ts`

**Interfaces:**
- Produces:
  - `INSTAGRAM_AUTHORIZE_URL = "https://www.facebook.com/v26.0/dialog/oauth"` (montada de `INSTAGRAM_GRAPH_VERSION`);
  - `buildAuthorizeUrl(i: { appId: string; redirectUri: string; state: string; configId: string }): string`;
  - `parseCodeExchange(json: unknown): { shortToken: string } | null`, só no formato `{ access_token }` de topo;
  - `parseUserLongLived(json: unknown): { token: string } | null`, que substitui `parseLongLived`;
  - `type PageCandidate = { pageId: string; pageName: string | null; pageToken: string; tasks: string[]; igUserId: string; igUsername: string | null }`;
  - `parsePages(json: unknown): PageCandidate[] | null`: `null` se `data` não for array; ficam só itens com `access_token`, id de Página e `instagram_business_account.id` válidos;
  - `type PageChoice = { kind: "one"; page: PageCandidate } | { kind: "none"; reason: "no_instagram" | "insufficient_task" } | { kind: "many"; usernames: string[] }`;
  - `choosePage(pages: PageCandidate[]): PageChoice`: filtra por `tasks` ∩ {`MODERATE`, `MANAGE`}. Zero sem filtro dá `no_instagram`; zero só depois do filtro dá `insufficient_task`.
- Saem: `INSTAGRAM_SCOPES`, `parseLongLived`, `parseMe`. Ficam: `classifyGraphError`, `redactSecrets`, `stripOAuthCodeSuffix`, `parseGraphErrorBody`, `isGraphOutcomeUnknown` e `INSTAGRAM_SUBSCRIBED_FIELDS = ["messages"]`.

- [ ] **Passo 1: trocar os testes do authorize e dos parsers por estes casos:**
  - `buildAuthorizeUrl` gera origem+caminho `https://www.facebook.com/v26.0/dialog/oauth`, com `client_id`, `redirect_uri`, `state`, `config_id`, `response_type=code` e `override_default_response_type=true`, e **sem** `scope`;
  - `parsePages` com `{ data: [{ id: "111", name: "Moralles Films", tasks: ["MODERATE","MESSAGING"], access_token: "PAGE-T", instagram_business_account: { id: "17841470263374765", username: "morallesfilmes" } }] }` devolve um candidato com esses valores;
  - id numérico inseguro (`17841470263374765` como number) descarta o item, e inteiro seguro vira string;
  - item sem `access_token` ou sem `instagram_business_account` sai;
  - `parsePages({})` dá `null`;
  - `choosePage([])` dá `{ kind:"none", reason:"no_instagram" }`; um candidato com `tasks: ["ADVERTISE"]` dá `insufficient_task`; dois válidos dão `{ kind:"many", usernames:["a","b"] }`; um válido dá `one`;
  - `parseUserLongLived({ access_token: "U-LONG", token_type: "bearer" })` dá `{ token: "U-LONG" }`, mesmo sem `expires_in`.
- [ ] **Passo 2:** `npx vitest run src/lib/instagram-graph-core.test.ts`. Esperado: FAIL nos casos novos.
- [ ] **Passo 3:** implementar as assinaturas acima. O comentário de topo passa a dizer "Login do Facebook para Empresas com a Página".
- [ ] **Passo 4:** `npx vitest run src/lib/instagram-graph-core.test.ts`. Esperado: PASS.
- [ ] **Passo 5:** commit `feat(instagram): núcleo do Graph para o login pela Página`.

### Task 2: migration `20261104120000_instagram_page_login.sql`

**Files:**
- Create: `supabase/migrations/20261104120000_instagram_page_login.sql`
- Modify:
  - `supabase/tests/local-preflight/79-instagram-module.sql` (14 chamadas de `store_…` ganham `p_page_id`);
  - `supabase/tests/local-preflight/README.md` (a seção 79 aplica a migration nova depois da `120900`);
  - `src/lib/instagram-queue-migration-twin.test.ts` (gêmeo textual do unschedule).

**Interfaces:**
- Produces:
  - coluna `instagram_accounts.page_id text`, com constraint `instagram_accounts_page_id_chk check (page_id is null or page_id ~ '^[0-9]{1,64}$')`;
  - `public.store_instagram_account_connection(p_unit_id uuid, p_ig_user_id text, p_page_id text, p_username text, p_account_type text, p_token text, p_expires_at timestamptz, p_actor uuid) returns uuid`, com `SECURITY DEFINER` e `search_path = ''`.
- A assinatura antiga de 7 argumentos sai com `drop function if exists` antes do `create`.

- [ ] **Passo 1: escrever os casos do 79 (RED antes da migration):**
  - `p_page_id` nulo, vazio ou `'12a'` dá `22023`;
  - conectar com `p_page_id='111'` grava `page_id='111'`;
  - reconectar o mesmo `ig_user_id` na mesma unidade com `'222'` reaproveita a linha (mesmo `id`, contatos intactos) e grava `page_id='222'` com o token novo;
  - a assinatura de 7 argumentos não existe mais (`to_regprocedure(...) is null`);
  - `has_function_privilege` da nova: `service_role` sim; `anon`/`authenticated` não;
  - `select count(*) from cron.job where jobname='instagram-token-refresh'` = 0, e os jobs `instagram-inbound-sweep` e `instagram-inbound-purge` continuam.
- [ ] **Passo 2:** rodar o pré-voo 79a + 79 sem a migration nova (README, seção 79). Esperado: RED nos casos novos.
- [ ] **Passo 3:** escrever a migration.
  - O corpo da `store_…` é o da `20261103120100` sem mudança de regra, com três acréscimos: validar `p_page_id` (`btrim`, `^[0-9]{1,64}$`, senão `invalid_instagram_account_argument` 22023); gravar `page_id` no `update` e no `insert`; `p_expires_at` nulo aceito.
  - Ao fim:
    - revoke/grant da nova assinatura;
    - `do $$ begin if exists (select 1 from pg_namespace where nspname='cron') then perform cron.unschedule(jobid) from cron.job where jobname='instagram-token-refresh'; end if; end $$;`;
    - `comment on column ... page_id`: "Página do Facebook ligada à conta; endereço do envio. Nulo só em linha anterior ao login pela Página."
- [ ] **Passo 4:** gêmeo textual. O teste confere que a migration nova contém o `cron.unschedule` de `instagram-token-refresh` e que nenhuma migration posterior à `120500` volta a agendar esse job.
- [ ] **Passo 5:** pré-voo 79a + 79 aplicando e reaplicando a migration nova. Esperado: GREEN nas duas, sem resíduo. Rodar também o `67d` sobre o clone `ig79`.
- [ ] **Passo 6:** `npx vitest run src/lib/instagram-queue-migration-twin.test.ts`. Esperado: PASS. Commit `feat(instagram): page_id na conta e fim do agendamento do refresh`.

### Task 3: adapter do Graph e `instagram-connect`

**Files:**
- Modify:
  - `supabase/functions/_shared/instagram-graph.ts`;
  - `supabase/functions/instagram-connect/index.ts`;
  - `supabase/functions/_shared/instagram-config-core.ts` (só comentário: `instagram_app_secret` = chave secreta do app Moralles Reservas).
- Test: `src/lib/instagram-connect-request.test.ts`

**Interfaces:**
- Consumes: Task 1 (`buildAuthorizeUrl`, `parsePages`, `choosePage`, `parseUserLongLived`) e Task 2 (`store_…` de 8 argumentos).
- Produces (adapter, `GRAPH = "https://graph.facebook.com"`):
  - `exchangeCode({ appId, appSecret, redirectUri, code })`: GET `/v26.0/oauth/access_token`, credenciais na query;
  - `toLongLivedUser({ appId, appSecret, shortToken })`: GET `/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token`;
  - `listPages({ userToken })`: GET `/v26.0/me/accounts?fields=id,name,tasks,access_token,instagram_business_account{id,username}&limit=100`, com Bearer;
  - `subscribePage({ pageId, pageToken })`: POST `/v26.0/{pageId}/subscribed_apps?subscribed_fields=messages`, com Bearer;
  - `sendText({ pageId, token, igsid, text })`: POST `/v26.0/{pageId}/messages`;
  - `profile({ igsid, token })`: só o host muda.
  - Saem `toLongLived`, `refresh`, `me` e `subscribe`.
- Produces (EF):
  - `start` usa `INSTAGRAM_LOGIN_CONFIG_ID`; ausente ou fora de `^[0-9]+$` → 503 + log `config_id_missing`;
  - `callback` → `{ unit_slug, username, subscribed }` (contrato do painel inalterado);
  - `resubscribe` lê `page_id`; nulo → 409 `MSG.reauth`, sem Graph.
  - Mensagens novas, literais da spec:
    - `noPage`: "Nenhuma Página do Facebook com Instagram profissional ligado foi autorizada." (422);
    - `taskInsufficient`: "Sua permissão nessa Página não basta para atender o Direct." (422);
    - `manyPages`: "Selecione só a Página desta loja ao conectar" (409, corpo `{ error, usernames }`).
  - Sai `notProfessional`.

- [ ] **Passo 1: trocar o `transport` do fixture pelos quatro endpoints do Facebook e escrever os testes:**
  - **sequência feliz:** GET `oauth/access_token` (code) → GET `oauth/access_token` (`fb_exchange_token`) → GET `me/accounts` → POST `{PAGE}/subscribed_apps`. O `store_…` recebe `p_ig_user_id = IG`, `p_page_id = PAGE` (`PAGE ≠ IG`), `p_token = PAGE_TOKEN`, `p_expires_at = null` e `p_account_type = null`; a resposta é `{ unit_slug, username, subscribed: true }`.
  - **token do usuário:** `USER_LONG`, `SHORT`, `APP_SECRET` e `CODE` não aparecem em nenhum argumento de RPC, em `harness.logs` nem em nenhum corpo de resposta. `PAGE_TOKEN` só aparece no argumento `p_token`.
  - **escolha da Página:** zero Páginas → 422 `noPage`; Página sem a tarefa → 422 `taskInsufficient`; duas → 409 com `usernames` e sem token no corpo. Nos três casos, nenhum `store_…` e nenhum `subscribed_apps`.
  - **`start`:** o `authorize_url` tem `config_id` igual ao env; sem `INSTAGRAM_LOGIN_CONFIG_ID`, ou com `"abc"`, dá 503 sem `state`.
  - **`resubscribe`:** conta com `page_id` nulo → 409 sem chamada ao Graph; conta com `page_id` → POST `{PAGE}/subscribed_apps` com o token do cofre.
  - Os testes atuais de gates (papel, grant, state, 503 de leitura, P0001/42501/22023) continuam, só com o fixture novo.
- [ ] **Passo 2:** `npx vitest run src/lib/instagram-connect-request.test.ts`. Esperado: FAIL.
- [ ] **Passo 3:** implementar o adapter e a EF.
  - No `callback`, a ordem dos gates não muda até o slug.
  - Depois: `exchangeCode` → `toLongLivedUser` → `listPages` → `choosePage` → `store_…` → `subscribePage` → `record_…`.
  - O comentário de topo da EF descreve o fluxo novo.
- [ ] **Passo 4:** `npx vitest run src/lib/instagram-connect-request.test.ts src/lib/instagram-graph-core.test.ts src/lib/instagram-config-core.test.ts` e `deno check supabase/functions/instagram-connect/index.ts`. Esperado: PASS e exit 0.
- [ ] **Passo 5:** commit `feat(instagram): conexão pelo Login do Facebook com a Página`.

### Task 4: envio pelo worker e pelo envio manual

**Files:**
- Modify: `supabase/functions/process-instagram-inbound/index.ts`, `supabase/functions/send-manual-message/index.ts`
- Test: `src/lib/instagram-inbound-request.test.ts`, `src/lib/instagram-manual-message-request.test.ts`

**Interfaces:**
- Consumes: Task 3 (`sendText({ pageId, token, igsid, text })`, `profile`).
- O select da conta nas duas EFs inclui `page_id`.
- `page_id` nulo:
  - chama `set_instagram_account_status(id, 'reauth_required', 'page_missing', connected_at)`, sem Graph;
  - loga `instagram_account_page_missing` com `accountId`;
  - o worker finaliza o evento como o caminho de `reauth_required` já faz;
  - o envio manual responde como no 190.

- [ ] **Passo 1: testes:**
  - nos dois arquivos, `GRAPH`/`SEND_URL` = `https://graph.facebook.com/v26.0/${PAGE}/messages`, com `PAGE ≠ IG_USER`, e o perfil em `https://graph.facebook.com/v26.0/${IGSID}?fields=name,username`;
  - caso novo em cada arquivo: conta `connected` com `page_id` nulo → RPC de status com `p_error_code: "page_missing"`, nenhuma chamada ao Graph e o log acima;
  - o webhook continua casando pela `ig_user_id` (o teste de request do webhook não muda e fica verde).
- [ ] **Passo 2:** `npx vitest run src/lib/instagram-inbound-request.test.ts src/lib/instagram-manual-message-request.test.ts`. Esperado: FAIL.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** os mesmos testes, mais `src/lib/instagram-webhook-request.test.ts`, e `deno check` das duas EFs. Esperado: PASS e exit 0.
- [ ] **Passo 5:** commit `feat(instagram): envio pelo endpoint da Página`.

### Task 5: retirar o refresh do token

**Files:**
- Delete:
  - `supabase/functions/process-instagram-token-refresh/` (pasta inteira);
  - `supabase/functions/_shared/instagram-token-refresh-core.ts`;
  - `src/lib/instagram-token-refresh-core.test.ts`;
  - `src/lib/instagram-token-refresh-request.test.ts`.
- Modify:
  - `supabase/config.toml` (sai `[functions.process-instagram-token-refresh]`);
  - `src/test/fixtures/edge-request-harness.ts` (sai da lista de EFs);
  - `.claude/rules/instagram.md`: título e linhas 32, 62, 63 e 65, para refletir login pela Página, token sem renovação e CAS só no `set_instagram_account_status`.
- **Ficam:** as RPCs `record_instagram_token_refresh` e `trigger_instagram_token_refresh()`, com a remoção em follow-up, e o caso do 79 que as cobre.

- [ ] **Passo 1:** `git rm` dos quatro caminhos, com caminho explícito.
- [ ] **Passo 2:** `grep -rn "process-instagram-token-refresh\|instagram-token-refresh-core" src supabase scripts .github .claude`. Esperado: só o comentário histórico da `20261103120500` e o gêmeo da Task 2.
- [ ] **Passo 3:** `npm run typecheck`, `npx vitest run src/lib/instagram` e `node scripts/ef-import-graph.mjs --all`. Esperado: 0 erros, PASS e nenhuma EF órfã.
- [ ] **Passo 4:** commit `chore(instagram): remove o refresh do token (token da Página não expira)`.

### Task 6: painel

**Files:**
- Modify: `src/pages/gestao/Instagram.tsx`, `src/pages/InstagramCallback.tsx`
- Test: `src/pages/gestao/Instagram.test.tsx`, `src/pages/InstagramCallback.test.tsx`

- [ ] **Passo 1: testes:**
  - o botão sem conta se chama "Conectar pelo Facebook";
  - acima dele aparecem três itens:
    - "O Instagram da loja precisa ser profissional e estar ligado a uma Página do Facebook.";
    - "Você precisa administrar ou moderar essa Página.";
    - "No app do Instagram, ligue Configurações › Mensagens e respostas ao story › Controles de mensagens › Ferramentas conectadas › Permitir acesso às mensagens.";
  - o mock de `connectStart` usa `https://www.facebook.com/v26.0/dialog/oauth?…`;
  - conta com `token_expires_at: null` não mostra "Acesso válido até";
  - callback com `error` na URL mostra "A autorização no Facebook não foi concluída. Inicie a conexão de novo se quiser conectar.";
  - callback com erro 409 da EF mostra a mensagem do backend.
- [ ] **Passo 2:** `npx vitest run src/pages/gestao/Instagram.test.tsx src/pages/InstagramCallback.test.tsx src/hooks/useInstagram.callback.test.tsx`. Esperado: FAIL nos novos.
- [ ] **Passo 3:** implementar, com cor só por token e sem `glass`. Texto de erro do início: "Não foi possível iniciar a conexão com o Facebook. Tente novamente."
- [ ] **Passo 4:** os mesmos testes. Esperado: PASS. Commit `feat(instagram): painel conecta pelo Facebook`.

### Task 7: documentação do release e gates

**Files:**
- Modify:
  - `docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md` (Tasks 6.2, 6.3 e 6.4, mais as Evidências);
  - `docs/superpowers/specs/2026-10-19-instagram-modulo-design.md` (só um aviso no topo apontando a spec do plano B);
  - descrição do PR #66 (o texto fica no scratchpad `pr-body.md` até a autorização do push).

- [ ] **Passo 1: Tasks 6.2 e 6.3 do plano original:**
  - `db push` só da `20261104120000`, depois de conferir a lista do remoto;
  - `secrets set INSTAGRAM_APP_ID=1435590504737997 INSTAGRAM_OAUTH_STATE_SECRET=… INSTAGRAM_LOGIN_CONFIG_ID=<da Task 0>`;
  - `instagram_app_secret` = chave secreta do app Moralles Reservas;
  - a matriz perde `process-instagram-token-refresh`;
  - `manage-platform-secrets` continua em v27, sem redeploy.
- [ ] **Passo 2: reescrever a Task 6.4 para o plano B:**
  - configuração de login (Task 0);
  - Webhooks › objeto Instagram › callback `https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-instagram` + verify token › campo `messages`;
  - papel no app para o testador;
  - "Permitir acesso às mensagens" no Instagram da Moralles;
  - app publicado (Live);
  - contingência: "Instagram setup tool" (Messenger › Configurações do Instagram) se o webhook não chegar com a Página inscrita;
  - Standard Access só responde a quem tem papel no app;
  - App Review em paralelo;
  - remover os usuários do sistema de teste nas BMs Moralles e Aldeia da Serra 2.
- [ ] **Passo 3: refazer a Task 6.1 sobre a branch:**
  - typecheck, lint, build e Vitest completo (falhas aceitas: só as da lista da 6.1);
  - `deno check` das EFs da matriz, `check-padrao` e portabilidade (489);
  - harness Docker 73/78;
  - pré-voo 79a, 79, 08, 38 e 67d;
  - review da branch inteira (`superpowers:requesting-code-review`), `saas-shield-br:pre-deploy` e `saas-shield-br:secret-scan`.
- [ ] **Passo 4:** atualizar as caixas deste plano, as Evidências e a memória do módulo. Commit `docs(instagram): release do login pela Página`.
- [ ] **Passo 5:** parar e pedir autorização para o push. Daí em diante vale o Bloco 6 do plano original, um passo autorizado por vez.

## Evidências

(preencher ao fim de cada task)
