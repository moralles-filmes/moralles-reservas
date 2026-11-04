# Instagram Fase 1 — conexão pela Página do Facebook (plano B)

Revisa, na spec `2026-10-19-instagram-modulo-design.md`, só a parte de **login, token, assinatura do webhook e chamadas ao Graph** da Fase 1. Todo o resto da Fase 1 (fila, worker, agente, Conversas, envio manual, grants, LGPD) continua como está na branch `feat/instagram-fase-1` (PR #66).

## Intenção

O dono da loja precisa conseguir conectar o Instagram da loja e ter o Direct atendido pela IA. Nas palavras dele: "desde que funcione e a pessoa consiga conectar o instagram da loja da empresa dele."

O código atual usa o **Login do Instagram** (`graph.instagram.com`). O app novo da Meta (Moralles Reservas, 1435590504737997) não oferece esse login no painel, só o **Login unificado**. Quatro testes reais da troca do código (duas BMs, Moralles e Aldeia da Serra 2) deram sempre o mesmo resultado: um token de usuário do sistema que não expira, mas **sem nenhuma conta do Instagram** (`assigned_instagram_accounts` vazio, `granular_scopes` sem `target_ids`). O Login unificado não entrega a conta.

O plano B é o **Login do Facebook para Empresas com a Página** ligada ao Instagram. É o caminho documentado há anos e o mesmo que o ManyChat oferece como "Entrar pelo Meta".

## Objetivos

1. O owner ou gerente clica em "Conectar", entra com o Facebook, escolhe a Página da loja e volta ao painel com o @ do Instagram conectado.
2. O Direct recebe o webhook e a IA responde, como já está construído.
3. Sem token que vence em 60 dias: o token da Página não expira. A reconexão só acontece quando a Meta invalida o acesso (senha trocada, permissão removida, Página desligada), e o painel já mostra "reconectar" nesse caso.
4. A troca de login mexe só no adapter do Graph, na `instagram-connect`, numa migration pequena e nos textos do painel.

## Não-objetivos

- Comentários, stories, visão: Fase 2 (spec `2026-11-04-instagram-fase-2-comentarios-stories-design.md`).
- Escolher entre várias Páginas numa tela nossa (ver "Escolhas minhas").
- Manter o Login do Instagram como alternativa.
- App Review e Advanced Access: correm em paralelo, fora do código.

## Anti-objetivos

- Guardar o token do **usuário** do Facebook. Ele serve só para chegar ao token da Página e é descartado na mesma requisição.
- Conectar uma conta sem confirmar com o responsável o @ pelo nome (regra do piloto).
- Qualquer chamada real à Meta feita pelo agente. Os testes usam fakes; os testes reais são scripts que o responsável roda.

## Fatos da Meta (documentação lida em 2026-11-04; reconfirmar no teste de fumaça)

**Requisitos da loja**
- Conta do Instagram **Profissional** ligada a uma **Página do Facebook**.
- Quem conecta tem na Página a tarefa MODERATE ou MANAGE. O envio pede MESSAGE e o perfil do cliente pede MODERATE.
- No app do Instagram, a opção "Permitir acesso às mensagens" precisa estar ligada (Configurações › Mensagens e respostas ao story › Controles de mensagens › Ferramentas conectadas).

**Permissões**
- `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list` e `pages_read_engagement` (esta última para o perfil do cliente).
- Com acesso padrão (Standard Access), o app **só envia mensagens a pessoas com papel no app**. Clientes de verdade exigem Advanced Access, que depende de App Review. O piloto de ponta a ponta usa um testador com papel no app.

**Login**
- Login do Facebook para Empresas, com uma configuração (`config_id`) de token de **usuário**. Os ativos são Páginas e contas do Instagram, com as permissões acima.
- Diálogo: `https://www.facebook.com/v26.0/dialog/oauth` com `client_id`, `redirect_uri`, `state`, `config_id`, `response_type=code` e `override_default_response_type=true`.

**Troca e tokens** (todos em `https://graph.facebook.com/v26.0`)
1. `GET /oauth/access_token` com `client_id`, `client_secret`, `redirect_uri` e `code` devolve o token curto do usuário.
2. `GET /oauth/access_token` com `grant_type=fb_exchange_token`, `client_id`, `client_secret` e `fb_exchange_token` devolve o token longo do usuário (cerca de 60 dias).
3. `GET /me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username}` traz as Páginas, o token de cada uma e a conta do Instagram ligada.
- O token de Página obtido de um token **longo** de usuário **não expira**; o obtido de um token curto vale 1 hora.
- O `data_access_expires_at` do token de Página precisa ser medido. Ver "Teste de fumaça".

**Webhook**
- Objeto `instagram`, campo `messages`, configurado no painel do app (produto Webhooks). `entry[].id` é o **id da conta profissional do Instagram**, o mesmo id que `instagram_business_account.id`.
- A regra S1 continua valendo, com outra fonte para o id: a conta é casada por `instagram_accounts.ig_user_id` = `entry[].id`.
- Por conta, a Página é inscrita no app com `POST /{page-id}/subscribed_apps?subscribed_fields=messages`, usando o token da Página e `pages_manage_metadata`.
- A referência da Meta diz que `subscribed_fields` não assina os webhooks do Instagram, que vêm do painel. A inscrição da Página no app continua necessária para os eventos daquela Página chegarem. O piloto confirma; se não bastar, o "Instagram setup tool" do painel (Messenger › Configurações do Instagram) é o plano de contingência.
- Assinatura `X-Hub-Signature-256` com o segredo do app Moralles Reservas.
- O app precisa estar **publicado** (modo ao vivo) para receber webhooks, independentemente do App Review.

**Envio e perfil**
- Envio: `POST /{page-id}/messages` com o token da Página. O corpo é o mesmo de hoje (`recipient.id` = IGSID, `message.text`) e a resposta traz `message_id`. Texto de até 1000 bytes UTF-8 (`INSTAGRAM_MAX_TEXT_BYTES` já corta por bytes).
- Perfil: `GET /{igsid}?fields=name,username` com o token da Página. Exige que o cliente tenha mandado mensagem antes.

## Teste de fumaça antes do código

O Login unificado só falhou no teste real. Por isso, **nenhuma linha de código antes de um teste real do plano B**:

1. **Painel da Meta** (descrito e autorizado antes; o responsável faz ou autoriza):
   - criar a configuração de login "Moralles Reservas — Página", token de usuário, ativos Páginas e Instagram, com as permissões acima;
   - conferir a URI de redirecionamento `https://reservas.moralles.com.br/instagram/callback` no Login do Facebook para Empresas.
2. **Script de teste** (eu escrevo, o responsável roda; só leitura; nunca imprime token, secret nem code). Ele imprime:
   - a troca do código, a troca pelo token longo e o `debug_token` do token de usuário;
   - `/me/accounts` com nome da Página, `tasks` e `instagram_business_account{id,username}`;
   - o `debug_token` do token da Página, com `type`, `expires_at`, `data_access_expires_at` e escopos;
   - uma leitura `GET /{page-id}/conversations?platform=instagram&limit=1`, que só confirma que o token da Página alcança o Direct.
   - Ele **não** inscreve a Página no app. Essa é uma escrita, que fica para a conexão de verdade.
3. **Critério para seguir:** a Página "Moralles Films" aparece ligada a **@morallesfilmes**, o token da Página tem `expires_at` 0 e a leitura de conversas responde 200. Se falhar, paro e trago o resultado antes de escrever código.

## O que muda no código

| Peça | Hoje | Plano B |
|---|---|---|
| `_shared/instagram-graph-core.ts` | `INSTAGRAM_AUTHORIZE_URL` do Instagram, escopos na URL, `parseMe` com `account_type` | URL do diálogo do Facebook com `config_id`, sem escopo na URL; `parseCodeExchange`/`parseLongLived` no formato do Facebook; `parsePages` novo, com filtro de Página que tem `instagram_business_account` e `access_token`; `classifyGraphError` mantido (os códigos são do Graph). |
| `_shared/instagram-graph.ts` | host `graph.instagram.com`, `exchangeCode` POST em `api.instagram.com`, `toLongLived` `ig_exchange_token`, `refresh`, `me`, `subscribe` no IG, `sendText` em `/{ig}/messages` | host `graph.facebook.com/v26.0`; `exchangeCode` GET; `toLongLived` `fb_exchange_token`; `listPages`; `subscribePage` em `/{page-id}/subscribed_apps`; `sendText` em `/{page-id}/messages`; `profile` igual com outro host. Sai o `refresh`. Continua: falha devolve só classe, status e código, e nada de texto remoto. |
| `instagram-connect` (`callback`) | troca → longo → `me` (Profissional) → grava → assina | troca → longo do usuário → `/me/accounts` → escolhe a Página (regra abaixo) → grava (token da **Página**, `page_id`, `expires_at` nulo) → `subscribePage` → `record_…`. O token do usuário morre na requisição. O `state` e a ordem dos gates não mudam. |
| `instagram-connect` (`resubscribe`) | `subscribe` no IG | `subscribePage` com o `page_id` da conta |
| `process-instagram-inbound`, `send-manual-message` | `sendText({ igUserId })` | `sendText({ pageId })`. O select da conta passa a ler `page_id`; 190 continua virando `reauth_required` com CAS. |
| `process-instagram-token-refresh` + cron `instagram-token-refresh` | renova a cada dia | **Sai.** O token da Página não tem renovação. Uma migration tira o agendamento (`cron.unschedule`) e a EF não entra no deploy. O código e os testes dela são removidos da branch. |
| Migration nova (aditiva) | — | `instagram_accounts.page_id text` (só dígitos, nulo nas linhas antigas); `store_instagram_account_connection` ganha `p_page_id`. A assinatura antiga sai com `drop function` e a nova volta a revogar `EXECUTE` de `public, anon, authenticated` e a conceder só a `service_role`. O agendamento do refresh sai. A RPC do status passa a expor `page_name` só se o painel precisar; minha escolha é não expor. |
| Segredos e env | `INSTAGRAM_APP_ID` = app do Instagram; `instagram_app_secret` = segredo do app do Instagram | `INSTAGRAM_APP_ID` = 1435590504737997. `instagram_app_secret` guarda a **chave secreta do app Moralles Reservas**, a mesma do teste. Env nova `INSTAGRAM_LOGIN_CONFIG_ID`, não secreta mas por ambiente. `meta_app_secret` **não** muda e continua só como segundo candidato do HMAC do webhook do Instagram (S6). Em produção ele guarda a mesma chave do Moralles Reservas (gravado em 03/11), o que é inofensivo: o WhatsApp oficial valida com o `credentials.app_secret` do próprio canal e não lê este segredo. |
| Painel (`Instagram.tsx`, `InstagramCallback.tsx`) | "Conectar Instagram", erro "conta precisa ser Profissional" | botão "Conectar pelo Facebook"; antes do botão, a lista curta de requisitos (Página ligada, permissão na Página, "Permitir acesso às mensagens"); erros novos: nenhuma Página com Instagram, mais de uma, permissão insuficiente na Página. O "expira em" some quando `token_expires_at` é nulo. |
| Testes | fakes do `graph.instagram.com` | os mesmos testes de request com os fakes do `graph.facebook.com`. Somam-se: o token de usuário nunca chega ao Vault, a log nem à resposta; a regra das Páginas; `page_id` nas chamadas. |

**Regra de escolha da Página no `callback`**
- Ficam só as Páginas com `instagram_business_account.id` e `access_token`, e com `tasks` contendo `MODERATE` ou `MANAGE`.
- **Zero** Páginas: 422, "Nenhuma Página do Facebook com Instagram profissional ligado foi autorizada." Se houver Página com Instagram mas sem a tarefa, a mensagem é "Sua permissão nessa Página não basta para atender o Direct."
- **Uma:** conecta essa.
- **Mais de uma:** 409, "Selecione só a Página desta loja ao conectar", com os @ encontrados no corpo, sem tokens. Nada é gravado e o owner conecta de novo escolhendo uma.

## Decisões do responsável

- **Plano B** (Login do Facebook com a Página) no lugar do Login unificado, em 2026-11-04 ("SEGUE COM O PLANO B").
- Ordem: destravar o login e pôr o Direct no ar; comentários e stories na Fase 2.
- Piloto: Moralles; antes de conectar, confirmar o @ pelo nome.
- O app secret e o verify token ficam com o responsável, que os grava no painel.

## Escolhas minhas (vetáveis)

1. **Mais de uma Página: recusa e pede nova conexão,** sem tela de escolha. Evita guardar o token do usuário entre duas requisições. Se o piloto mostrar que isso incomoda, uma tela de escolha vem depois.
2. **O worker de refresh sai** em vez de virar verificador de saúde. Um 190 no envio já marca `reauth_required`. Se o teste de fumaça mostrar `data_access_expires_at` diferente de 0 no token da Página, ele vai para `token_expires_at` e o painel avisa "reconecte até DD/MM". Ainda sem worker.
3. **`instagram_app_secret` mantém o nome** e passa a guardar o segredo do app Moralles Reservas. Não muda chave em `platform_secrets`, e a `manage-platform-secrets` (v27 em produção) não precisa de redeploy.
4. **A desconexão não chama a Meta**, como hoje: o token é sobrescrito no Vault e a conta sai. Desinscrever a Página fica para a Fase 2.
5. `account_type` passa a ser gravado como `null`. Conta ligada à Página é profissional por definição, e a coluna fica para não mexer no esquema.

## Respostas à revisão de quem vai construir

1. **O teste de fumaça ainda não foi feito.** É a primeira tarefa do plano, com ponto de parada: configuração no painel (autorizada antes), script rodado pelo responsável, resultado trazido. Só depois vem código. Se o token da Página vier com `data_access_expires_at` diferente de 0, vale a escolha 2. Se o webhook não chegar com a Página inscrita, entra a contingência do "Instagram setup tool", que é configuração no painel e não código.
2. **Não há conta conectada em produção.** Só as migrations e a `manage-platform-secrets` v27 estão lá; a `instagram-connect` nunca foi publicada. Por isso:
   - não há tarefa de reconexão forçada;
   - a coluna `page_id` aceita nulo, mas a `store_…` nova exige `p_page_id` só com dígitos (22023 se faltar);
   - o resto do contrato da RPC não muda: locks por `ig_user_id` e por unidade, `instagram_account_in_use`, desconexão da conta anterior, Vault, autorização no SQL;
   - Página e conta do Instagram são 1:1 na Meta, então a trava por `ig_user_id` já impede a mesma Página em duas unidades;
   - numa reconexão da mesma conta, o `page_id` é sobrescrito junto com o token.
3. **Conta com `page_id` nulo** (só possível em linha antiga ou corrompida): o worker e o envio manual tratam como `reauth_required`, com o mesmo CAS por `connected_at` do erro 190 e o log `instagram_account_page_missing`. O painel mostra "reconectar", como já faz. *(minha escolha)*
4. **`process-instagram-token-refresh` não está publicada em produção, mas o job `instagram-token-refresh` está agendado** pela 20261103120500. A migration nova faz o `cron.unschedule` de forma idempotente (só se o job existir), igual ao início da 120500. As RPCs `record_instagram_token_refresh` e `set_instagram_account_status` ficam: são aditivas e a segunda é usada pelo 190. A remoção da primeira é um follow-up, sem `drop` nesta fase. Os testes da EF removida saem junto. "73/78" são os números dos arquivos do harness Docker, não contagens; se algum deles cobrir o refresh, o caso sai e o plano registra isso.
5. **`INSTAGRAM_LOGIN_CONFIG_ID` ausente ou fora do formato de dígitos:** `start` responde 503 e loga `config_id_missing`, falhando fechado como `app_id_missing`. Os testes injetam a env. *(minha escolha)*
6. **O 409 de várias Páginas** devolve só os @ das Páginas que o próprio usuário acabou de autorizar no diálogo. Não é oráculo, e nenhum token aparece. No piloto, o responsável escolhe só a Página "Moralles Films" no diálogo.
7. **v26.0** é a versão das páginas atuais da documentação (get-started e perfil do usuário). Continua constante única em `INSTAGRAM_GRAPH_VERSION`.

## Fica para quem planejar

- A ordem das tasks e a divisão dos commits.
- O nome exato dos parsers e das funções do adapter.
- O texto final dos erros no painel (revisão PT-BR).
- O ajuste da matriz de redeploy da Task 6.3:
  - sai `process-instagram-token-refresh`;
  - entram a migration nova e o env `INSTAGRAM_LOGIN_CONFIG_ID`;
  - `manage-platform-secrets` continua sem mudança.

## Impacto na Fase 2

A Fase 2 usa os mesmos hosts e o mesmo token da Página:
- resposta pública em `POST /{comment-id}/replies`;
- resposta privada em `POST /{page-id}/messages` com `recipient.comment_id`.

Ela soma a permissão `instagram_manage_comments` e o campo `comments` no webhook, e a configuração de login ganha essa permissão quando a Fase 2 começar. O item 2 das respostas à revisão da spec da Fase 2 é atualizado para apontar este documento.

## Critério de saída

- O teste de fumaça passou, com Moralles Films ligada a @morallesfilmes, `expires_at` 0 e conversas 200.
- Gates da Fase 1 verdes com os fakes novos: typecheck, lint, Vitest, `deno check`, harness Docker 73/78, pré-voo SQL (79a, 79, 08, 38, 67d), portabilidade em 489, revisão da branch inteira, `saas-shield-br:pre-deploy` e `secret-scan`.
- No piloto, com a conta confirmada pelo nome: conectar → DM de um testador com papel no app → IA responde → reserva `source=instagram` → aparece em Conversas → assumir e devolver.
