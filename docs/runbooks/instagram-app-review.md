# Instagram — App Review e acesso avançado (app Moralles Reservas)

Para quem vai enviar a revisão no painel da Meta (app `1435590504737997`, BM - Moralles `587894792882399`). Hoje o app está publicado (Live), mas todas as permissões estão em **acesso padrão**: só pessoas com papel no app conversam com a IA. Para ligar o Instagram de qualquer outra loja, precisamos de **acesso avançado** em todas as permissões da configuração de login `950774527855623`.

Fonte: doc da Meta "Instagram Platform › App Review" (lida em 2026-11-04). Os pontos que importam aqui:
- uma descrição e um vídeo por permissão;
- pelo menos uma chamada de API com sucesso por permissão;
- instruções passo a passo para o revisor entrar e testar;
- a interface em inglês ou, se não der, vídeo com legenda;
- não pedir permissão que o app não usa (isso reprova o pedido).

## 1. Antes de enviar (responsável)

- [ ] **Verificação da empresa** da BM - Moralles concluída (Configurações da empresa › Central de segurança). Para um provedor de tecnologia que atende várias empresas, o acesso avançado depende dela.
- [ ] **Configurações do app › Básico:** ícone 1024×1024, categoria, e-mail comercial, política de privacidade `https://reservas.moralles.com.br/privacidade` e exclusão de dados `https://reservas.moralles.com.br/privacidade/exclusao-de-dados`. As duas páginas já estão no ar.
- [ ] **Uma chamada com sucesso por permissão nos últimos dias.** O piloto de 2026-11-04 já fez as chamadas: conexão, inscrição da Página, webhook e envio. Se o painel marcar alguma permissão com "0 chamadas", reconecte a Moralles e troque uma DM de teste.
- [ ] **Acesso do revisor ao painel:**
  - um usuário de teste nosso (e-mail e senha só para a Meta, informados no formulário e nunca no repositório);
  - papel `gerente` numa unidade de demonstração com o módulo Instagram liberado;
  - a conta IG de demonstração conectada, com o Direct ligado.

  **Decisão sua:** usar a Moralles (`@morallesfilmes`) ou criar uma unidade só para a revisão. A unidade separada evita que o revisor veja reservas reais.
- [ ] **Remover os usuários do sistema de teste** que os testes do login unificado criaram nas BMs Moralles e Aldeia da Serra 2. Eles não servem mais e não devem aparecer para o revisor.

## 2. Permissões a pedir (todas as 7 da configuração)

Cada linha diz onde o código usa a permissão. Todas as chamadas estão em [instagram-graph.ts](../../supabase/functions/_shared/instagram-graph.ts).

| Permissão | Uso no código |
|---|---|
| `instagram_basic` | ler o `instagram_business_account{id,username}` da Página em `GET /me/accounts`; ler nome e @ do contato em `GET /{igsid}?fields=name,username` |
| `instagram_manage_messages` | receber DMs pelo webhook (`messages`); responder pelo `POST /{page_id}/messages` |
| `pages_show_list` | listar as Páginas do gerente em `GET /me/accounts`, para escolher a Página ligada ao Instagram da loja |
| `pages_read_engagement` | ler os dados da Página e o token da Página no mesmo `GET /me/accounts` |
| `pages_manage_metadata` | inscrever a Página no webhook: `POST /{page_id}/subscribed_apps?subscribed_fields=messages` |
| `pages_messaging` | exigida junto com a anterior para a inscrição `messages` e para enviar pelo endpoint da Página (sem ela, 403 com código 200, visto no piloto) |
| `business_management` | na lista da própria Meta de permissões obrigatórias para mensagens com login do Facebook; dá acesso a Páginas e contas do Instagram que pertencem a um portfólio empresarial (o caso das lojas) |

**Risco:** `business_management` é a única sem chamada própria no código. Se o revisor recusar por "permissão não usada", tire-a da configuração, reconecte a Moralles e confira se a conexão e o envio continuam funcionando antes de reenviar.

## 3. Textos para colar ("How will your app use this permission?")

Comum a todas (cole antes do texto específico):

> Moralles Reservas is a table-reservation platform for restaurants in Brazil. A restaurant manager connects the restaurant's Instagram professional account (through its linked Facebook Page) in our dashboard. Customers then send Direct messages to the restaurant, and our assistant answers them, checks availability, and books a table. Restaurant staff can take over any conversation and reply manually from our "Conversas" (Conversations) inbox. We only access the Page and Instagram account that the manager selects in the Facebook Login dialog.

- **instagram_basic:** "We read the Instagram professional account ID and username linked to the selected Page, so we can show the manager which account is connected and route incoming webhook events to the right restaurant. We also read the name and username of a customer who messages the restaurant, so we can show them in the inbox."
- **instagram_manage_messages:** "We receive Direct messages sent to the restaurant's Instagram account through the messages webhook, and we send replies (from the assistant or from a staff member) within the 24-hour messaging window. We do not send unsolicited messages."
- **pages_show_list:** "After Facebook Login, we list the Pages the manager can access, so they can choose the Page that is linked to the restaurant's Instagram account."
- **pages_read_engagement:** "We read the selected Page's ID, name, linked Instagram account, and Page access token. We use them to connect the account and to send messages on behalf of the Page."
- **pages_manage_metadata:** "We subscribe the selected Page to our app's webhook (subscribed_apps, field messages), so that Instagram Direct messages reach our platform."
- **pages_messaging:** "The Page subscription to the messages field and the reply endpoint POST /{page-id}/messages require this permission. We use it only to answer conversations that the customer started."
- **business_management:** "Restaurants' Pages and Instagram accounts belong to a Meta business portfolio. This permission lets the manager grant our app access to those business-owned assets during Facebook Login. We do not read or manage any other business data."

## 4. Vídeo (um só, enviado em cada permissão)

A interface é em português, então o vídeo leva **legendas em inglês** em cada passo e um tooltip nos botões que não são óbvios. Grave em tela cheia, sem cortes entre os passos 3 e 5. Todo token, e-mail e telefone que aparecer precisa sair borrado.

1. Entrar no painel `https://reservas.moralles.com.br` com o usuário de teste. _Legenda: "Restaurant manager logs in to Moralles Reservas."_
2. Abrir a página **Instagram** da loja e mostrar a lista de pré-requisitos e o botão **Conectar pelo Facebook**. _"Connect with Facebook" (o botão de login precisa estar visível)._
3. No diálogo do Facebook, escolher a Página e a conta do Instagram e aceitar as permissões. Mostrar a tela de permissões inteira. _"Manager selects the restaurant's Page and Instagram account and grants permissions."_
4. De volta ao painel, mostrar a conta conectada (@), o status da inscrição "ativo" e o "Reconecte até". _"Connected; Page subscribed to the messages webhook (pages_manage_metadata, pages_messaging)."_
5. Ligar o **Direct**. _"Assistant replies enabled."_
6. Num celular com outra conta do Instagram (com papel no app), mandar uma DM para a loja: "Quero reservar uma mesa para 2 amanhã às 20h". Mostrar a resposta chegando no Instagram. _"Customer sends a Direct message; the assistant replies (instagram_manage_messages)."_
7. No painel, abrir **Conversas**, filtrar por Instagram e mostrar a conversa com nome e @ do cliente. _"Conversation appears in the restaurant inbox (instagram_basic)."_
8. Clicar **Assumir**, responder à mão e mostrar a mensagem chegando no celular; depois clicar **Devolver à IA**. _"Staff takes over and replies manually, then hands the conversation back to the assistant."_

Os passos 7 e 8 também cumprem os passos 6–10 do E2E de saída da Fase 1, que ficaram sem registro no piloto. Anote o resultado nas Evidências do plano.

## 5. Instruções para o revisor (campo "Testing instructions")

> 1. Go to https://reservas.moralles.com.br and log in with the test credentials provided in this form.
> 2. Open the "Instagram" page of the demo restaurant. The account @<demo> is already connected; you can disconnect and reconnect it with "Conectar pelo Facebook" (Connect with Facebook).
> 3. From any Instagram account, send a Direct message to @<demo>, for example "I want to book a table for 2 tomorrow at 8 pm". The assistant replies within a few seconds.
> 4. In "Conversas" (Conversations), filter by Instagram to see the conversation. "Assumir" (Take over) lets you reply manually; "Devolver à IA" (Hand back to assistant) returns it to the assistant.
> The dashboard is in Portuguese; the screencast has English captions for every step.

O passo 3 só funciona com acesso avançado ou com o revisor com papel no app. Se a Meta pedir, adicione a conta de teste do revisor como **Testador** do app antes.

## 6. Depois da aprovação

- Conferir em Revisão do app › Permissões e recursos que as 7 estão em **acesso avançado**.
- Só então o `platform_admin` libera o módulo Instagram para outra loja, uma por vez, confirmando o @ pelo nome com o responsável.
- Atualizar `.claude/rules/instagram.md` (a regra sobre acesso padrão) e a memória do módulo.
