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

- [x] **Passo 1:** descrever ao responsável a mudança no painel do app 1435590504737997 e esperar autorização. Ele faz a mudança ou autoriza o agente a fazê-la.
  - Login do Facebook para Empresas › Configurações › criar a configuração "Moralles Reservas — Página":
    - tipo de token: Token de acesso do usuário;
    - ativos: com token de usuário o painel não permite escolher; a Página é escolhida no diálogo de login;
    - permissões: `instagram_basic`, `instagram_manage_messages`, `pages_read_engagement`, `pages_show_list` e `business_management`.
    - Essa é a lista obrigatória para mensagens que a própria Meta mostra nesse caso de uso. `pages_manage_metadata` não está disponível nele, então a inscrição da Página no webhook é medida no piloto; a contingência é o "Instagram setup tool".
  - Em "URIs de redirecionamento do OAuth válidos", conferir `https://reservas.moralles.com.br/instagram/callback`.
- [x] **Passo 2:** o responsável roda `node meta-page-login-test.mjs`, escolhe só a Página "Moralles Films" no diálogo e cola a saída aqui.
- [x] **Passo 3:** conferir o critério:
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
  - `choosePage(pages: PageCandidate[]): PageChoice`: filtra por `tasks` ∩ {`MODERATE`, `MANAGE`}. Zero sem filtro dá `no_instagram`; zero só depois do filtro dá `insufficient_task`;
  - `parseDataAccessExpiry(json: unknown): string | null`: lê `data.data_access_expires_at` da resposta do `debug_token`. Inteiro positivo em segundos vira ISO (`new Date(s * 1000).toISOString()`); 0, ausente, não inteiro ou corpo inválido dão `null`.
- Saem: `INSTAGRAM_SCOPES`, `parseLongLived`, `parseMe`. Ficam: `classifyGraphError`, `redactSecrets`, `stripOAuthCodeSuffix`, `parseGraphErrorBody`, `isGraphOutcomeUnknown` e `INSTAGRAM_SUBSCRIBED_FIELDS = ["messages"]`.

- [x] **Passo 1: trocar os testes do authorize e dos parsers por estes casos:**
  - `buildAuthorizeUrl` gera origem+caminho `https://www.facebook.com/v26.0/dialog/oauth`, com `client_id`, `redirect_uri`, `state`, `config_id`, `response_type=code` e `override_default_response_type=true`, e **sem** `scope`;
  - `parsePages` com `{ data: [{ id: "111", name: "Moralles Films", tasks: ["MODERATE","MESSAGING"], access_token: "PAGE-T", instagram_business_account: { id: "17841470263374765", username: "morallesfilmes" } }] }` devolve um candidato com esses valores;
  - id numérico inseguro (`17841470263374765` como number) descarta o item, e inteiro seguro vira string;
  - item sem `access_token` ou sem `instagram_business_account` sai;
  - `parsePages({})` dá `null`;
  - `choosePage([])` dá `{ kind:"none", reason:"no_instagram" }`; um candidato com `tasks: ["ADVERTISE"]` dá `insufficient_task`; dois válidos dão `{ kind:"many", usernames:["a","b"] }`; um válido dá `one`;
  - `parseUserLongLived({ access_token: "U-LONG", token_type: "bearer" })` dá `{ token: "U-LONG" }`, mesmo sem `expires_in`;
  - `parseDataAccessExpiry({ data: { data_access_expires_at: 1801579536 } })` dá `"2027-02-02T14:45:36.000Z"`; com `0`, `"1801579536"` (string), `-5`, `1.5`, `{}` ou `null` dá `null`.
- [x] **Passo 2:** `npx vitest run src/lib/instagram-graph-core.test.ts`. Esperado: FAIL nos casos novos.
- [x] **Passo 3:** implementar as assinaturas acima. O comentário de topo passa a dizer "Login do Facebook para Empresas com a Página".
- [x] **Passo 4:** `npx vitest run src/lib/instagram-graph-core.test.ts`. Esperado: PASS.
- [x] **Passo 5:** commit `feat(instagram): núcleo do Graph para o login pela Página`.

### Task 2: migration `20261104130000_instagram_page_login.sql`

**Files:**
- Create: `supabase/migrations/20261104130000_instagram_page_login.sql`
- Modify:
  - `supabase/tests/local-preflight/79-instagram-module.sql` (14 chamadas de `store_…` ganham `p_page_id`);
  - `supabase/tests/local-preflight/README.md` (a seção 79 aplica a migration nova depois da `120900`);
  - `src/lib/instagram-queue-migration-twin.test.ts` (gêmeo textual do unschedule).

**Interfaces:**
- Produces:
  - coluna `instagram_accounts.page_id text`, com constraint `instagram_accounts_page_id_chk check (page_id is null or page_id ~ '^[0-9]{1,64}$')`;
  - `public.store_instagram_account_connection(p_unit_id uuid, p_ig_user_id text, p_page_id text, p_username text, p_account_type text, p_token text, p_expires_at timestamptz, p_actor uuid) returns uuid`, com `SECURITY DEFINER` e `search_path = ''`.
- A assinatura antiga de 7 argumentos sai com `drop function if exists` antes do `create`.

- [x] **Passo 1: escrever os casos do 79 (RED antes da migration):**
  - `p_page_id` nulo, vazio ou `'12a'` dá `22023`;
  - conectar com `p_page_id='111'` grava `page_id='111'`;
  - reconectar o mesmo `ig_user_id` na mesma unidade com `'222'` reaproveita a linha (mesmo `id`, contatos intactos) e grava `page_id='222'` com o token novo;
  - a assinatura de 7 argumentos não existe mais (`to_regprocedure(...) is null`);
  - `has_function_privilege` da nova: `service_role` sim; `anon`/`authenticated` não;
  - `select count(*) from cron.job where jobname='instagram-token-refresh'` = 0, e os jobs `instagram-inbound-sweep` e `instagram-inbound-purge` continuam.
- [x] **Passo 2:** rodar o pré-voo 79a + 79 sem a migration nova (README, seção 79). Esperado: RED nos casos novos.
- [x] **Passo 3:** escrever a migration.
  - O corpo da `store_…` é o da `20261103120100` sem mudança de regra, com três acréscimos: validar `p_page_id` (`btrim`, `^[0-9]{1,64}$`, senão `invalid_instagram_account_argument` 22023); gravar `page_id` no `update` e no `insert`; `p_expires_at` nulo aceito.
  - Ao fim:
    - revoke/grant da nova assinatura;
    - `do $$ begin if exists (select 1 from pg_namespace where nspname='cron') then perform cron.unschedule(jobid) from cron.job where jobname='instagram-token-refresh'; end if; end $$;`;
    - `comment on column ... page_id`: "Página do Facebook ligada à conta; endereço do envio. Nulo só em linha anterior ao login pela Página."
- [x] **Passo 4:** gêmeo textual. O teste confere que a migration nova contém o `cron.unschedule` de `instagram-token-refresh` e que nenhuma migration posterior à `120500` volta a agendar esse job.
- [x] **Passo 5:** pré-voo 79a + 79 aplicando e reaplicando a migration nova. Esperado: GREEN nas duas, sem resíduo. Rodar também o `67d` sobre o clone `ig79`.
- [x] **Passo 6:** `npx vitest run src/lib/instagram-queue-migration-twin.test.ts`. Esperado: PASS. Commit `feat(instagram): page_id na conta e fim do agendamento do refresh`.

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
  - `debugToken({ appId, appSecret, inputToken })`: GET `/v26.0/debug_token?input_token=…`, com `Authorization: Bearer {appId}|{appSecret}` (o segredo fica fora da URL);
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

- [x] **Passo 1: trocar o `transport` do fixture pelos quatro endpoints do Facebook e escrever os testes:**
  - **sequência feliz:** GET `oauth/access_token` (code) → GET `oauth/access_token` (`fb_exchange_token`) → GET `me/accounts` → GET `debug_token` (com `input_token = PAGE_TOKEN`) → POST `{PAGE}/subscribed_apps`. O `store_…` recebe `p_ig_user_id = IG`, `p_page_id = PAGE` (`PAGE ≠ IG`), `p_token = PAGE_TOKEN`, `p_expires_at = "2027-02-02T14:45:36.000Z"` (fixture `data_access_expires_at: 1801579536`) e `p_account_type = null`; a resposta é `{ unit_slug, username, subscribed: true }`.
  - **prazo de acesso:** `debug_token` com `data_access_expires_at: 0` grava `p_expires_at = null`. `debug_token` com 500 ou erro do Graph **não bloqueia** a conexão: grava `p_expires_at = null` e loga `instagram_debug_token_failed` só com `errorClass`/`httpStatus` (escolha minha: a leitura é informativa, não é gate).
  - **token do usuário:** `USER_LONG`, `SHORT`, `APP_SECRET` e `CODE` não aparecem em nenhum argumento de RPC, em `harness.logs` nem em nenhum corpo de resposta. `PAGE_TOKEN` só aparece no argumento `p_token`.
  - **escolha da Página:** zero Páginas → 422 `noPage`; Página sem a tarefa → 422 `taskInsufficient`; duas → 409 com `usernames` e sem token no corpo. Nos três casos, nenhum `store_…` e nenhum `subscribed_apps`.
  - **`start`:** o `authorize_url` tem `config_id` igual ao env; sem `INSTAGRAM_LOGIN_CONFIG_ID`, ou com `"abc"`, dá 503 sem `state`.
  - **`resubscribe`:** conta com `page_id` nulo → 409 sem chamada ao Graph; conta com `page_id` → POST `{PAGE}/subscribed_apps` com o token do cofre.
  - Os testes atuais de gates (papel, grant, state, 503 de leitura, P0001/42501/22023) continuam, só com o fixture novo.
- [x] **Passo 2:** `npx vitest run src/lib/instagram-connect-request.test.ts`. Esperado: FAIL.
- [x] **Passo 3:** implementar o adapter e a EF.
  - No `callback`, a ordem dos gates não muda até o slug.
  - Depois: `exchangeCode` → `toLongLivedUser` → `listPages` → `choosePage` → `debugToken` + `parseDataAccessExpiry` → `store_…` → `subscribePage` → `record_…`.
  - O comentário de topo da EF descreve o fluxo novo.
- [x] **Passo 4:** `npx vitest run src/lib/instagram-connect-request.test.ts src/lib/instagram-graph-core.test.ts src/lib/instagram-config-core.test.ts` e `deno check supabase/functions/instagram-connect/index.ts`. Esperado: PASS e exit 0.
- [x] **Passo 5:** commit `feat(instagram): conexão pelo Login do Facebook com a Página`.

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

- [x] **Passo 1: testes:**
  - nos dois arquivos, `GRAPH`/`SEND_URL` = `https://graph.facebook.com/v26.0/${PAGE}/messages`, com `PAGE ≠ IG_USER`, e o perfil em `https://graph.facebook.com/v26.0/${IGSID}?fields=name,username`;
  - caso novo em cada arquivo: conta `connected` com `page_id` nulo → RPC de status com `p_error_code: "page_missing"`, nenhuma chamada ao Graph e o log acima;
  - o webhook continua casando pela `ig_user_id` (o teste de request do webhook não muda e fica verde).
- [x] **Passo 2:** `npx vitest run src/lib/instagram-inbound-request.test.ts src/lib/instagram-manual-message-request.test.ts`. Esperado: FAIL.
- [x] **Passo 3:** implementar.
- [x] **Passo 4:** os mesmos testes, mais `src/lib/instagram-webhook-request.test.ts`, e `deno check` das duas EFs. Esperado: PASS e exit 0.
- [x] **Passo 5:** commit `feat(instagram): envio pelo endpoint da Página`.

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

- [x] **Passo 1:** `git rm` dos quatro caminhos, com caminho explícito.
- [x] **Passo 2:** `grep -rn "process-instagram-token-refresh\|instagram-token-refresh-core" src supabase scripts .github .claude`. Esperado: só o comentário histórico da `20261103120500` e o gêmeo da Task 2.
- [x] **Passo 3:** `npm run typecheck`, `npx vitest run src/lib/instagram` e `node scripts/ef-import-graph.mjs --all`. Esperado: 0 erros, PASS e nenhuma EF órfã.
- [x] **Passo 4:** commit `chore(instagram): remove o refresh do token (token da Página não expira)`.

### Task 6: painel

**Files:**
- Modify: `src/pages/gestao/Instagram.tsx`, `src/pages/InstagramCallback.tsx`
- Test: `src/pages/gestao/Instagram.test.tsx`, `src/pages/InstagramCallback.test.tsx`

- [x] **Passo 1: testes:**
  - o botão sem conta se chama "Conectar pelo Facebook";
  - acima dele aparecem três itens:
    - "O Instagram da loja precisa ser profissional e estar ligado a uma Página do Facebook.";
    - "Você precisa administrar ou moderar essa Página.";
    - "No app do Instagram, ligue Configurações › Mensagens e respostas ao story › Controles de mensagens › Ferramentas conectadas › Permitir acesso às mensagens.";
  - o mock de `connectStart` usa `https://www.facebook.com/v26.0/dialog/oauth?…`;
  - "Acesso válido até" sai do painel;
  - conta com `token_expires_at: null` não mostra prazo nem o botão de renovar;
  - conta conectada com prazo a mais de 14 dias mostra "Reconecte até DD/MM/AAAA para manter o acesso." (data em `America/Sao_Paulo`), sem destaque e sem botão;
  - prazo a 14 dias ou menos: o mesmo texto em destaque (token de aviso) e o botão "Reconectar pelo Facebook", que chama o mesmo `connect` da conexão;
  - prazo vencido: "O acesso aos dados venceu em DD/MM/AAAA. Reconecte para voltar a responder." e o botão "Reconectar pelo Facebook";
  - o botão de `reauth_required` passa a se chamar "Reconectar pelo Facebook";
  - os testes de prazo usam relógio fixo (`vi.useFakeTimers` + `vi.setSystemTime`);
  - callback com `error` na URL mostra "A autorização no Facebook não foi concluída. Inicie a conexão de novo se quiser conectar.";
  - callback com erro 409 da EF mostra a mensagem do backend.
- [x] **Passo 2:** `npx vitest run src/pages/gestao/Instagram.test.tsx src/pages/InstagramCallback.test.tsx src/hooks/useInstagram.callback.test.tsx`. Esperado: FAIL nos novos.
- [x] **Passo 3:** implementar, com cor só por token e sem `glass`. Texto de erro do início: "Não foi possível iniciar a conexão com o Facebook. Tente novamente."
- [x] **Passo 4:** os mesmos testes. Esperado: PASS. Commit `feat(instagram): painel conecta pelo Facebook`.

### Task 7: documentação do release e gates

**Files:**
- Modify:
  - `docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md` (Tasks 6.2, 6.3 e 6.4, mais as Evidências);
  - `docs/superpowers/specs/2026-10-19-instagram-modulo-design.md` (só um aviso no topo apontando a spec do plano B);
  - descrição do PR #66 (o texto fica no scratchpad `pr-body.md` até a autorização do push).

- [x] **Passo 1: Tasks 6.2 e 6.3 do plano original:**
  - `db push` só da `20261104130000`, depois de conferir a lista do remoto;
  - `secrets set INSTAGRAM_APP_ID=1435590504737997 INSTAGRAM_OAUTH_STATE_SECRET=… INSTAGRAM_LOGIN_CONFIG_ID=<da Task 0>`;
  - `instagram_app_secret` = chave secreta do app Moralles Reservas;
  - a matriz perde `process-instagram-token-refresh`;
  - `manage-platform-secrets` continua em v27, sem redeploy.
- [x] **Passo 2: reescrever a Task 6.4 para o plano B:**
  - configuração de login (Task 0);
  - Webhooks › objeto Instagram › callback `https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-instagram` + verify token › campo `messages`;
  - papel no app para o testador;
  - "Permitir acesso às mensagens" no Instagram da Moralles;
  - app publicado (Live);
  - contingência: "Instagram setup tool" (Messenger › Configurações do Instagram) se o webhook não chegar com a Página inscrita;
  - Standard Access só responde a quem tem papel no app;
  - App Review em paralelo;
  - remover os usuários do sistema de teste nas BMs Moralles e Aldeia da Serra 2.
- [x] **Passo 3: refazer a Task 6.1 sobre a branch:**
  - typecheck, lint, build e Vitest completo (falhas aceitas: só as da lista da 6.1);
  - `deno check` das EFs da matriz, `check-padrao` e portabilidade (489);
  - harness Docker 73/78;
  - pré-voo 79a, 79, 08, 38 e 67d;
  - review da branch inteira (`superpowers:requesting-code-review`), `saas-shield-br:pre-deploy` e `saas-shield-br:secret-scan`.
- [x] **Passo 4:** atualizar as caixas deste plano, as Evidências e a memória do módulo. Commit `docs(instagram): release do login pela Página`.
- [ ] **Passo 5:** parar e pedir autorização para o push. Daí em diante vale o Bloco 6 do plano original, um passo autorizado por vez.

## Evidências

**Task 0, painel (2026-11-04).** O responsável autorizou e o agente executou.
- **Configuração** "Moralles Reservas — Página": variação Geral, token de acesso do usuário, config_id `950774527855623`.
- **Permissões da configuração:** `business_management`, `instagram_basic`, `instagram_manage_messages`, `pages_read_engagement` e `pages_show_list`.
  - Antes, `pages_read_engagement`, `pages_show_list` e `business_management` foram adicionadas ao caso de uso "Gerenciar mensagens e conteúdo no Instagram" › Permissões e recursos ("Pronto para teste").
  - `pages_manage_metadata` não existe nesse caso de uso.
- **Painel:** a "Configuração da API com login do Facebook" aparece como legado, mas funcional.
- **URI de redirecionamento:** já estava cadastrado, com modo estrito ligado; nada foi mudado ali.
- **App:** continua "Não publicado".
- **Migration nova** renomeada para `20261104130000`: a planta aplicou `20261104120000` em produção.

**Task 0, teste de fumaça (2026-11-04).** O responsável rodou o script e colou a saída.
- **Troca e token longo:** HTTP 200 nos dois.
- **Token do usuário:** tipo `USER`, `expires_at` 1798987456 (2027-01-03), `data_access_expires_at` 1801579536 (2027-02-02). Escopos: `pages_show_list`, `business_management`, `instagram_basic`, `instagram_manage_messages`, `pages_read_engagement`, `public_profile`. Os `granular_scopes` apontam para a Página, a conta do Instagram e a BM Moralles.
- **`/me/accounts`:** Página "Moralles Films" `758899170635576`, tasks `MANAGE, CREATE_CONTENT, MODERATE, MESSAGING, ADVERTISE, ANALYZE, MANAGE_LEADS`, Instagram `17841470263374765` `morallesfilmes`.
- **Token da Página:** tipo `PAGE`, `expires_at` 0, `data_access_expires_at` 1801579536 (90 dias).
- **Conversas do Instagram pela Página:** HTTP 200, 1 conversa.
- **Critério:** passou, menos o `data_access_expires_at`, que não veio 0. O responsável aprovou aplicar a escolha 2 da spec: o prazo vai para `token_expires_at` na conexão (Tasks 1 e 3) e o painel avisa "Reconecte até" (Task 6). Sem worker. A doc da Meta isenta `business_management` e `pages_*` desse prazo, mas não cita `instagram_*`; o efeito real no Direct só se vê em 2027-02-02.

**Task 1 (2026-11-04), núcleo do Graph.** Commits `190fa04` e `442dbb8` (base `68dc46d`). Review: spec ok; 1 Important (`parseId` aceitava qualquer string não vazia) corrigido na rodada 1 (ids do Graph só com dígitos). Minors adiados: sem teste de id numérico inseguro, `!isObj(ig)` redundante, sem teste de `tasks` vazio ou ausente.

**Task 2 (2026-11-04), banco.** Commit `0e733d7` (migration `20261104130000`: `page_id` na conta, store de 8 argumentos, fim do agendamento do refresh). Review limpa. Sem pg_cron no `ig79`: o caso "cron.job = 0" virou migration aplicada limpa sem schema `cron` mais gêmeo textual do `unschedule`; o `unschedule` real só se mede no `db push`. Faixa 7901–7999 do 79 cheia, README com faixa nova. Minors adiados: o gêmeo confere a guarda por posição; a varredura de reagendamento só pega `select cron.schedule(...)`.

**Task 3 (2026-11-04), conexão pelo Login do Facebook com a Página.** Commit `08a32af`. Review limpa. Gate Deno: `npx -y deno@2.9.6` (>= 2.3 por causa do `deno.lock` v5). A falha do `debug_token` não bloqueia a conexão (`p_expires_at` nulo + log). Minors adiados: `INSTAGRAM_APP_ID` só checado como não vazio (resolvido em `ccde679`); `/me/accounts` com `limit=100`, sem paginação; sem teste do 409 com @ repetido.

**Task 4 (2026-11-04), envio pelo endpoint da Página.** Commit `67375ed`. Review limpa. `page_id` fora de `^[0-9]{1,64}$` conta como nulo (`page_missing`, espelha o CHECK). Perfil do contato por `graph.facebook.com/v26.0/{igsid}?fields=name,username`. Minors adiados: regex de `page_id` duplicada (worker × `send-manual-message`); sem teste do CAS falso no `page_missing`.

**Task 5 (2026-11-04), remoção do refresh.** Commit `5af5bc5`. Review limpa. `parseLongLived`/`parseMe` e o adapter antigo saíram aqui (ruling do pré-voo). `process-instagram-token-refresh` nunca foi publicada (o cron dava 404): não há função remota órfã; o cron sai com a migration. Minors adiados: `function-acl-allowlist.json` ainda cita `record_instagram_token_refresh` (ver follow-ups).

**Task 6 (2026-11-04), painel pelo Facebook.** Commit `42794a8` (inclui os textos de `Integracoes.tsx`). Review limpa; prazos >14 dias, <=14 dias e vencido com relógio fixo. Minors adiados: sem teste das fronteiras `expiresAt == now` e 14 dias + 1 ms.

**Revisão final da branch e fix wave (2026-11-04).** Review Opus de `68dc46d..08508f8`: "With fixes", 0 Critical, 2 Important.
- Important 1 (várias Páginas deixavam a reconexão em 409 para sempre): corrigido em `ccde679` (base `60521c9`). Com várias Páginas aptas, escolhe a única cujo `igUserId` é o da conta não desconectada da unidade do state; falha de leitura é 503; senão 409.
- Important 2 (inscrição da Página provavelmente falha sem `pages_manage_metadata`): decidido no piloto (ver Rulings).
- Fix wave (Sonnet, 7 findings, `ccde679`): `choosePage` `many` carrega `pages`; mensagem `manyPages` com ponto final e a dica do diálogo do Facebook; `INSTAGRAM_APP_ID` validado como dígitos; `rules/instagram.md` (`debugToken` na lista de GETs com credencial na query, sem "(Tasks 4.1/4.2)"); comentários da migration (cabeçalho e ROLLBACK); "Reconecte até DD/MM/AAAA" em BRT via `formatDateBR` e badge "Acesso vencido"; `formatDateBrt` removido.
- Re-review: tudo endereçado, sem quebra nova. Testes focados: 5 arquivos, 173 passed; 6 alvos, 200 passed. `deno check` das 3 EFs, typecheck e portabilidade 489 ok.

**Gates locais da Task 7 (HEAD `60521c9`, local, sem push).** Merge (não rebase) de `origin/main` `72132da` na branch, sem conflito: o PR #66 já está no remoto.
- `npm run typecheck` 0; lint 0 erros (20 warnings, +1 em arquivo vindo da main); `npm run build` ok; `check-padrao` ok; `check-portabilidade` 489 = linha de base.
- Vitest: 301 arquivos, 5746 testes, sem regressão. Falhas: `OfficialConnectionCard`, `SalaoDetalhe` e `SalaoPlanta` sem `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (com variáveis fictícias, 33/33); `agent-turn-parity` com timeout de 5 s sob carga (isolado, 26/26). Nenhuma das preexistentes da 6.1 falhou.
- `deno check` (`npx -y deno@2.9.6`) das 10 EFs da matriz: exit 0.
- Matriz recalculada com `ef-import-graph.mjs --all`: `manage-platform-secrets` (sem redeploy), `webhook-instagram`, `instagram-connect`, `process-instagram-inbound`, `webhook-whatsapp`, `send-manual-message`, `send-scheduled-whatsapp`, `create-reservation`, `update-reservation`, `create-manual-reservation`. `_shared/instagram-graph*.ts` alcança `instagram-connect`, `process-instagram-inbound` e `send-manual-message`; após `ccde679` esses três são redeploy obrigatório.
- Pré-voo SQL (cluster descartável PostgreSQL 18.6 com `lc_messages='C'`; contêineres `--network none`, removidos ao fim): 79a + 79 RED exit 3, depois 104/104 e 104/104 de novo (a 120500 do cron não roda sem pg_cron); 67d `GREEN67d` isolado e sobre clone do `ig79`; 08 verde pré-Instagram e, com as migrations IG, o mesmo defeito de fixture da 6.1 (`customer_id` nulo, `conversations_channel_identity_check`); harness Docker na base e com as 10 migrations IG aplicadas duas vezes: `GREEN73`, `GREEN74`, `GREEN74C`, `PASS 76`, `GREEN78`; SQL do 38 com 48 checks (antes da cadeia 78) e `--source-check` exit 0.
- Para encadear o fixture: `01-audit.sql` como `supabase_admin` e `reservations_source_check` no lugar de `resource41_source` (ajuste local, sem mudar o repo).

**Pré-deploy e secret-scan (2026-11-04, HEAD `ccde679`).**
- 0 Dependências: FAIL só por dois P1 anteriores à branch (Node 20 em `function-acl-audit.yml`; Vite 5.4, correção major); a branch não toca `package*.json` nem CI. Os mesmos da 6.1.
- 1 Segredos: histórico 0 achados em 1262 commits (todas as refs); estático sem bloqueante, 2 P3 (project ref em migrations antigas; `supabase/.temp` no disco, não versionado). O App Secret só foi digitado pelo responsável no script local (entrada oculta), nunca no chat.
- 2 Isolamento de tenant: PASS_WITH_WARNINGS, 0 P0/P1. P2: `page_id` sem unicidade entre contas ativas. P3: mensagem `inUse` distinta; `state` sem nonce.
- 3 Identidade e acesso: PASS_WITH_WARNINGS. P3: `get_instagram_account_status` aceita operador por RPC direta (anterior); sem ator no audit de resubscribe.
- 4 Integrações: PASS_WITH_WARNINGS. P2: `subscribed_fields` mantido ao trocar de Página; prazo nulo se o `debug_token` falha (desenho aprovado); código 10 inteiro como `window_closed` (anterior). P3: `/me/accounts` sem paginação; `rate_limited` sem retry; `page_missing` fecha o evento se a marcação falha.
- 5 Schema diff: na Task 6.2, antes do `db push`.
- 6 Migration `20261104130000`: PASS_WITH_WARNINGS, 0 bloqueante. P3: `NOT VALID` + `VALIDATE` na mesma transação sem ganho; rollback comentado perde `page_id`.
- 7 Vercel: o `vercel.json` só muda pela main (`fd453e9`: `deploymentEnabled {"main": true, "**": false}`); a prévia do PR #66 não builda (decisão em aberto na Task 6.2 do plano original).
- 8 Edge Functions: `instagram-connect` e `send-manual-message` PASS_WITH_WARNINGS, `process-instagram-inbound` e `_shared` PASS, 0 P0/P1. P2 anteriores: `cors.ts` aceita qualquer `*.vercel.app`; CORS `*` em `send-manual-message`; `appendErr.message` sem redact no caminho WhatsApp. P3 novos: `page_missing` grava o status antes do gate de grant no worker; operador aciona a marcação `page_missing` no envio manual (o CAS limita).

**Rulings (controller e responsável) e custo se errado.**
- Remoção de `parseLongLived`/`parseMe` e das funções antigas do adapter na Task 5, não nas 1/3: cada task fica verde e o refresh morre junto. Custo: código morto por duas tasks.
- Vermelho transitório T1→T3 (`buildAuthorizeUrl` sem `configId` em `instagram-connect`) e T3→T4 (`sendText` nas EFs de envio): cada task verifica só os testes que lista. Custo: um vermelho intermediário que T3/T4 fecham.
- Sem pg_cron no `ig79`: o "cron.job = 0" vira migration limpa + gêmeo textual. Custo: o `unschedule` real só se mede no `db push`.
- Faixa 7901–7999 do 79 cheia: o implementer abre faixa nova no README. Custo: renumeração cosmética.
- Falha do `debug_token` não bloqueia a conexão (`p_expires_at` nulo + log): leitura informativa, não gate. Custo: conta sem aviso de prazo até a próxima reconexão.
- 409 de várias Páginas sem deduplicar @ repetido: raro, mensagem continua correta. Custo: lista com @ duplicado.
- `page_id` fora de `^[0-9]{1,64}$` tratado como nulo (`page_missing`): espelha o CHECK e o resubscribe. Custo: nenhum (o CHECK impede o caso).
- Textos de `Integracoes.tsx` (placeholder do `instagram_app_secret`, descrição do card) entram na Task 6: "App Secret do Instagram Login" induzia a colar a chave do produto Instagram em vez da do app. Custo: 2 strings a mais no PR.
- Merge (não rebase) de `origin/main` `72132da` antes dos gates: a branch já está no remoto (PR #66), evita force push. Custo: um merge commit no histórico.
- Important 1 (várias Páginas → 409 eterno na reconexão): corrigir em `ccde679`, escolhendo a Página cujo `igUserId` é o da conta não desconectada da unidade; a escolha 1 da spec supunha token sem prazo, e reconectar virou caminho recorrente. Custo: pouco código; a primeira conexão com várias Páginas continua 409.
- Important 2 (inscrição da Página provavelmente falha sem `pages_manage_metadata`; o painel diria "inativo" + "Assinar de novo", que sempre falha): parked para o piloto. Medir o `graphCode` do primeiro `instagram_connect_subscribe_failed` e decidir (a) caso de uso com `pages_manage_metadata` ou (b) registrar a inscrição no primeiro webhook / esconder linha e botão, antes de mostrar o painel à loja; grant fica off fora da Moralles. Custo: painel enganoso só na Moralles durante o piloto.
- Fix wave dos minors baratos (`rules/instagram.md`, comentários da migration, "Reconecte até", badge vencido, `INSTAGRAM_APP_ID` em dígitos, `manyPages`): feito em `ccde679`. Custo: textos.
- `subscribed_fields` mantido ao reconectar com outra Página fica para follow-up: mudar a regra da store exigiria refazer o pré-voo 79; raro. Custo: painel "ativo" sem inscrição na Página nova até o próximo resubscribe.
- O fix wave esperou os gates terminarem (sem mudar arquivos durante o Vitest) e depois reexecutou os testes focados e o `deno check`.

**Follow-ups do plano B (P2/P3, nenhum bloqueia).**
- `page_id` único entre contas ativas: `P0001` na store ou índice único parcial, com caso novo no 79.
- `subscribed_fields` zerado quando o `page_id` muda na reconexão, com caso no 79.
- Código 10 sem o subcódigo da janela de 24 h: tratar como `reauth_required` em vez de `window_closed`.
- `rate_limited` com retry no worker.
- `page_missing` com retry quando a gravação do status falha (hoje o evento fecha).
- `page_missing` depois do gate de grant no worker (hoje grava antes).
- Paginação de `/me/accounts` (hoje `limit=100`).
- Remover `record_instagram_token_refresh` e `trigger_instagram_token_refresh()` (e a entrada em `scripts/function-acl-allowlist.json`).
- Minors adiados do ledger: `choosePage` sem deduplicar `igUserId` repetido e fallback que põe nome/id da Página em `usernames`; sem teste de id numérico inseguro, de `tasks` vazio, do 409 com @ repetido e do log `instagram_account_page_missing` do resubscribe; regex de `page_id` duplicada (worker × `send-manual-message:342`) e `account.page_id as string` dependente do gate; sem teste do CAS falso no `page_missing`; gêmeo do 79 confere a guarda por posição e a varredura de reagendamento só pega `select cron.schedule(...)`; "Instagram Login" no comentário de `_shared/instagram-oauth-state.ts` e no rótulo de `manage-platform-secrets` (fica, sem redeploy); sem teste das fronteiras `expiresAt == now` e 14 dias + 1 ms; fixture do 08 passar `customer_id`; `NOT VALID` + `VALIDATE` na mesma transação; `state` sem nonce de uso único; CORS por lista em `send-manual-message`.
