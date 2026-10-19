# Módulo Instagram — IA no Direct, Stories e Comentários

**Estado:** abordagem aprovada pelo responsável em 2026-10-19 (plano de produto/arquitetura, com as quatro decisões abaixo). O aceite autoriza o plano e a implementação **local** da Fase 0. Cada fase seguinte tem plano próprio. `supabase db push`, deploy de Edge Function, secrets, criação do app Meta e liberação para lojas exigem autorização própria.

## Objetivo

Levar ao Instagram o mesmo atendimento por IA que a loja tem no WhatsApp, com reserva caindo no sistema.

Além do Direct:
- responder **menções e respostas em Story**, comentando o que a foto mostra;
- responder **comentários por palavra-chave**, por tipo de assunto, com palavras padrão do sistema e palavras extras da loja.

O recurso é um **módulo**:
- o super admin libera por unidade;
- a loja escolhe o que a IA pode fazer (Direct, Stories, Comentários e tipos de comentário);
- as conversas do Instagram aparecem em **Conversas**, com filtro de canal WhatsApp / Instagram / Ambos em todas as abas de status.

## Decisões do responsável (2026-10-19)

| Tema | Decisão |
|---|---|
| Integração Meta | **App Meta próprio**, "Instagram API com Instagram Login" (Business Login for Instagram, sem página do Facebook) |
| Cliente sem telefone | **A IA pede o WhatsApp antes de confirmar a reserva** e liga o contato do Instagram ao cadastro `customers` existente |
| Resposta padrão a comentário | **Resposta pública curta + Direct** com o conteúdo completo; a loja muda o modo por tipo |
| Entrega | **Em fases**, cada uma com loja piloto: 0 pré-requisitos → 1 Direct + Conversas → 2 Stories + visão → 3 Comentários |

## Fatos do código que moldam o desenho

1. O agente (prompt, ferramentas, loop, debounce, lock, franquia) vive dentro de [webhook-whatsapp/index.ts](../../../supabase/functions/webhook-whatsapp/index.ts). Um segundo canal exige extraí-lo para `_shared/`.
2. `AgentMessage.content` é string ([ai-providers.ts](../../../supabase/functions/_shared/ai-providers.ts)): não há visão. Imagem recebe `MEDIA_REPLY_TEXT` fixo.
3. `conversations` não tem canal. A busca é por `(unit_id, customer_id)` em `get_or_create_whatsapp_conversation`.
4. `customers.phone` é `NOT NULL` + `UNIQUE (organization_id, phone)`. O contato do Instagram tem só IGSID e @.
5. Estes pontos são exclusivos do WhatsApp:
   - os CHECKs de provider de `processed_messages`, `whatsapp_inbound_events` e `notifications_sent`;
   - a FK `webhook_executions.channel_id → whatsapp_channels`.

   Por isso **Instagram é um canal novo com tabelas próprias, não um `WhatsAppProvider`**: acrescentar membro à união quebra todo `Record` exaustivo.
6. `reservations.source` aceita `web|whatsapp`. O trigger `enqueue_confirmation_notification` enfileira confirmação para tudo que não é `whatsapp`.
7. Não existe sistema de módulos por unidade. O precedente é o grant Datafy (`whatsapp_official_connection_grants` + `DatafyAdminCard`). A tabela `settings` não serve para liberação, porque qualquer membro, operador incluso, escreve nela.
8. **Escopo de tenant nas ferramentas de reserva do agente** (corrigido na Fase 0):
   - `update_reservation` e `cancel_reservation` filtram só por `reservation_code`, que é UNIQUE global, sem `unit_id`, cliente nem status. `update_reservation` ainda devolve sucesso com zero linhas.
   - `get_reservation` por código não filtra o cliente. O fallback por telefone busca `customers` sem a organização, e o `maybeSingle()` falha quando o mesmo telefone existe em duas organizações.
   - Quem conhece um código alheio (print, mensagem encaminhada) pode, via IA, ler, alterar ou cancelar a reserva de outro cliente, inclusive de outra loja. O código tem 8 caracteres aleatórios: não é adivinhável, mas é compartilhável.

## Fatos da plataforma Meta (pesquisa de 2026-10-19; confirmar na doc vigente antes de cada fase)

- **Permissões** (Instagram Login): `instagram_business_basic`, `instagram_business_manage_messages` e `instagram_business_manage_comments`.
  - Atender contas de terceiros exige **Advanced Access** e App Review, com Business Verification.
  - Antes disso, só contas adicionadas ao app.
  - A conta da loja precisa ser Profissional.
- **Token:**
  - o curto (1h) troca pelo longo (60 dias) em `graph.instagram.com/access_token`;
  - `refresh_access_token` renova por mais 60 dias se o token tiver ≥24h e estiver válido;
  - sem refresh, expira e exige reautorização.
- **Direct:**
  - webhook `messages` (também `messaging_postbacks`, `messaging_seen`, `messaging_reactions`, `messaging_referrals`);
  - envio por `POST graph.instagram.com/{ig_id}/messages`;
  - **janela de 24h** desde a última mensagem do cliente;
  - a tag Human Agent (7 dias) é só para resposta humana e depende de revisão própria.
- **Menção em Story:**
  - chega no webhook `messages` com `attachments[].type = "story_mention"` e `payload.url` do CDN;
  - a URL expira (~24h, ou antes se o story for apagado);
  - **é proibido armazenar ou cachear a mídia**, só a URL;
  - conta privada só gera o evento se seguir a loja.
- **Resposta a Story:** a mensagem traz referência ao story respondido (`reply_to`). O formato exato deve ser medido no piloto, porque a doc pública está incompleta.
- **Comentários:**
  - webhook `comments` com id e @ do autor, id do comentário, mídia e texto;
  - resposta pública em `POST /{comment_id}/replies`;
  - **resposta privada** em `POST /{ig_id}/messages` com `recipient.comment_id`: **uma por comentário, até 7 dias** (Live só durante a transmissão);
  - a conversa só continua se o cliente responder, e aí vale a janela de 24h;
  - comentário da própria conta também gera webhook, o que exige filtro anti-laço.
- **Mention API:** menções em Stories **não** são suportadas pela API de mentions; elas chegam só como DM (`story_mention`).

## Arquitetura

### Núcleo do agente por canal (Fase 0)

Extrair de `webhook-whatsapp` para `supabase/functions/_shared/agent/`:
- montagem do prompt;
- definição e despacho das ferramentas;
- execução do turno com debounce, lock de conversa, franquia (`reserve_ai_budget`/`settle_ai_reservation`) e auto-handoff.

O núcleo recebe um `ChannelContext`:

```ts
type ChannelContext = {
  channel: "whatsapp" | "instagram";
  unitId: string;
  organizationId: string;
  conversationId: string;
  customer: { id: string; phone: string } | null;   // null = contato IG sem telefone
  contact?: { id: string; username: string | null }; // instagram_contacts
  identityLine: string;              // frase de identidade do cliente no prompt
  formattingRules: string;           // regras de formatação do canal
  sanitize(text: string): string;    // sanitizeForWhatsApp | sanitizeForInstagram
  send(text: string): Promise<SendResult>;
  reservationSource: "whatsapp" | "instagram";
};
```

O WhatsApp passa a consumir o núcleo **sem mudança de comportamento**, provado por:
- testes de paridade: snapshot do prompt, lista de ferramentas e decisões de retry/handoff;
- redeploy das consumidoras indicadas por `node scripts/ef-import-graph.mjs`.

### Modelo de dados (Fase 1 em diante)

Todas as tabelas novas têm RLS (ou FORCE RLS sem policy quando guardam credencial ou fila) e trigger de auditoria quando são administrativas. Toda função nova revoga `EXECUTE` de `public, anon, authenticated` e concede ao papel mínimo. Todo guard por `unit_id` tem o paralelo `app_private.is_platform_admin`.

| Tabela | Conteúdo | Acesso |
|---|---|---|
| `unit_module_grants` | `unit_id`, `organization_id`, `module` (CHECK `'instagram'`), `granted_by/at`, `revoked_by/at`; um grant ativo por (unit, module) | FORCE RLS; escrita só por EF que checa `platform_admin`; leitura por RPC `SECURITY DEFINER` (`is_unit_member OR is_platform_admin`) |
| `instagram_accounts` | `unit_id`, `organization_id`, `ig_user_id`, `username`, `status` (`connected`/`reauth_required`/`disconnected`), `token_secret_id` (Vault), `token_expires_at`, `token_refreshed_at`, `subscribed_fields`, `connected_by/at` | FORCE RLS sem policy; projeção client-safe por EF/RPC; token nunca sai do Vault/EF |
| `instagram_settings` | `unit_id` PK, `dm_enabled`, `story_mentions_enabled`, `story_replies_enabled`, `comments_enabled`, `vision_enabled` (todos nascem `false`) | leitura por membro; escrita por gerente+ e `platform_admin` |
| `instagram_contacts` | `organization_id`, `unit_id`, `instagram_account_id`, `igsid`, `username`, `name`, `customer_id NULL` (FK `customers`); UNIQUE (`instagram_account_id`, `igsid`) | leitura por membro da unidade; escrita só service role |
| `instagram_inbound_events` | fila no padrão de `whatsapp_inbound_events` (`raw_body bytea`, claim/finalize/purge, sweep pg_cron), dedupe (`instagram_account_id`, `event_key`) | FORCE RLS sem policy |
| `instagram_comment_intents` / `instagram_comment_keywords` | Fase 3 (abaixo) | leitura por membro; escrita por gerente+ |
| `instagram_comment_actions` | ledger por `comment_id` (UNIQUE): intent, ações feitas (`public_reply`, `private_reply`), ids remotos, estado | FORCE RLS; leitura por RPC de membro |

**Alterações:**
- `conversations`:
  - `+ channel text not null default 'whatsapp'` CHECK (`whatsapp`,`instagram`) e `+ instagram_contact_id`;
  - `customer_id` passa a aceitar NULL, com CHECK de coerência (whatsapp ⇒ `customer_id`; instagram ⇒ `instagram_contact_id`);
  - índice (`unit_id`, `channel`, `status`);
  - RPC `get_or_create_instagram_conversation` com advisory lock por unit + contato;
  - `append_conversation_message` é reutilizado; a mensagem ganha `kind` (`story_mention`, `story_reply`, `comment_dm`) e `attachment?: { type, cdn_url }`, só com a URL e nunca com bytes.
  - O impacto do `customer_id` nulo é mapeado em todo leitor de `conversations.customer` antes da migration (`getConversationDisplayName`, Conversas, `send-manual-message`, dead-letter, `conversation-log.ts`).
- `reservations.source`:
  - entra `'instagram'`;
  - `enqueue_confirmation_notification` passa a pular `whatsapp` **e** `instagram`, porque a IA já confirma na conversa;
  - os lembretes seguem pelo WhatsApp quando o cliente tem telefone e consentimento.
- **Contato → cliente:**
  - o contato do Instagram existe sem `customers`;
  - a ferramenta `link_customer_phone(phone, name)` usa `resolveOrCreateCustomer` (dedupe por `(organization_id, phone)` canônico) e grava `instagram_contacts.customer_id` e `conversations.customer_id`;
  - `create_reservation` responde `need_phone` enquanto o contato não estiver ligado.
  - `customers.phone` não muda.

### Edge Functions

| EF | Papel |
|---|---|
| `instagram-connect` | OAuth Business Login for Instagram com `state` assinado (unit + usuário + expiração); troca curto→longo; Vault; `POST /{ig_user_id}/subscribed_apps`. Só owner/gerente da unidade **com grant ativo** ou `platform_admin`. Ações: `start`, `callback`, `status`, `disconnect` |
| `webhook-instagram` | `verify_jwt=false`. GET com `hub.challenge` (`verify_token` em `platform_secrets`). POST com `X-Hub-Signature-256` (app secret em `platform_secrets`), em tempo constante, sobre o corpo cru. Resolve a conta por `entry.id` × `instagram_accounts.ig_user_id`, nunca por id do caller. Descarta: sem grant ativo, toggle desligado, eco do próprio `ig_user_id`. Persiste em `instagram_inbound_events` e dá ACK |
| `process-instagram-inbound` | Worker (sweep pg_cron + `waitUntil`): parse → contato → conversa → append → debounce + lock → núcleo do agente com o `ChannelContext` do Instagram → Send API. Comentários vão ao motor da Fase 3 |
| `process-instagram-token-refresh` | pg_cron diário; renova tokens com ≥30 dias de idade; falha → `reauth_required` + alerta na UI; nunca loga token |
| `send-manual-message` | Ramifica por `conversation.channel`; no Instagram, janela de 24h revalidada antes do POST, sem retry automático |

Reentrega de webhook pela Meta é premissa a **medir** no piloto, como na regra do WhatsApp. Enquanto não houver prova, o modo de ingestão segue o mesmo gate fail-closed: a gravação na fila acontece antes do ACK, e falha da gravação devolve 503.

### Agente no Instagram

- **Identidade no prompt:** "cliente via Instagram @user; telefone ainda não informado" (ou o telefone, se ligado).
- **Formatação:** sem markdown do WhatsApp, até 1000 caracteres por mensagem (dividir quando maior).
- **Regra nova de prompt:** pedir o WhatsApp antes de confirmar a reserva, explicando que a confirmação e os lembretes vão por lá.
- Mesmo BYOK (`ai_provider_credentials`, sem fallback global), mesma franquia, mesmo handoff e mesmo lock.
- Story e comentário não autorizam inventar promoção (regra 7). Giftback só é citado se houver regra ativa (bloco com âncora negativa).

### Visão (Fase 2)

- `AgentMessage.content` passa a aceitar partes (texto + imagem) em `runClaude`, no runner compatível com OpenAI e em `runGemini`.
- A capacidade de visão é declarada por modelo ao lado de `KNOWN_MODELS`, com os gêmeos UI e backend sincronizados. Modelo sem visão recebe a descrição neutra do evento.
- O worker baixa a imagem do CDN **só em memória**:
  - host da Meta em allowlist, HTTPS, sem redirect para fora;
  - limite de tamanho e MIME `image/*`; timeout curto;
  - a imagem não é persistida, logada nem reenviada; vai ao modelo como base64 no turno.
- Uma imagem por turno. O custo entra na franquia.
- **Prompt de Story:**
  - agradecer;
  - mencionar um detalhe verdadeiro e visível (prato, ambiente, ocasião), sem inferir dado sensível de pessoas;
  - convidar a voltar ou reservar.
- **Painel:** a bolha de story renderiza da URL do CDN, com placeholder "Story indisponível" quando a URL falha.

### Comentários por palavra-chave (Fase 3)

**Tabelas:**
- `instagram_comment_intents`: `unit_id`, `key`, `label`, `enabled`, `reply_mode` (`public`|`dm`|`both`|`none`), `public_reply_variants text[]`, `dm_instruction`, `handoff`, `is_system`.
- `instagram_comment_keywords`: `intent_id`, `keyword`, `normalized`, `is_system`.

A seed do sistema é criada ao conceder o módulo. A loja acrescenta palavras e desativa, sem apagar, as do sistema.

| Tipo | Palavras padrão (exemplos) | Modo padrão |
|---|---|---|
| Cardápio | cardápio, menu, preço, valor, quanto custa, vegano | público curto + DM com link do cardápio |
| Reservas | reserva, reservar, mesa, disponível, vaga para | público curto + DM; a IA continua para fechar a reserva |
| Horário e endereço | horário, abre, fecha, endereço, onde fica, estacionamento | público curto + DM |
| Delivery | delivery, entrega, ifood, pedido | DM com link |
| Eventos e grupos | aniversário, evento, confraternização, grupo, espaço privativo | DM; a IA coleta dados ou faz handoff |
| Elogio | amei, delícia, maravilhoso, top, 😍 | só público, com variações |
| Reclamação | ruim, péssimo, demorou, frio, reclamação | **sem resposta automática**: alerta + conversa para humano |
| Trabalhe conosco | vaga de emprego, currículo, trabalhar aí | DM com o contato |

**Regras do motor:**
- normalização sem acento, minúsculas e palavra/frase inteira;
- prioridade fixa quando vários tipos casam: Reclamação > Reservas > Eventos > Cardápio > Horário > Delivery > Trabalhe > Elogio;
- ignora o próprio `ig_user_id`, respostas a respostas e comentários com mais de 7 dias;
- ledger UNIQUE por `comment_id` (no máximo uma resposta pública e uma privada por comentário);
- no máximo 1 DM por autor e tipo a cada 24h;
- a resposta pública sorteia entre as variações;
- sem palavra-chave, nenhuma ação (classificação por IA fica opcional e futura, e consome franquia);
- o DM privado é registrado na conversa do contato; quando o cliente responde, a IA assume dentro da janela de 24h.

### Interface

- **Plataforma:**
  - aba "Instagram" em `/platform/unidades/:slug` ([Automacao.tsx](../../../src/pages/gestao/Automacao.tsx)), no padrão do `DatafyAdminCard`;
  - liberar/revogar o módulo, status da conta, validade do token e diagnóstico (últimos eventos e falhas, sem conteúdo).
- **Loja:**
  - rota `/g/:slug/instagram`; item no `GestaoLayout` só com grant ativo e `isGerente`;
  - abas: **Conexão** (conectar/reconectar, @, validade), **Direct**, **Stories**, **Comentários** (tipos, modo, variações, palavras do sistema e da loja), **Atividade** (Fase 3: ações por comentário e reservas `source='instagram'`).
- **Conversas** ([Conversas.tsx](../../../src/pages/gestao/Conversas.tsx)):
  - chips de canal (Ambos / WhatsApp / Instagram) combinados com os chips de status, com contagens por canal;
  - filtro client-side em `useMemo`, com `channel` em `LIST_COLUMNS`;
  - preferência em `localStorage` (com try/catch);
  - ícone do canal no item;
  - nome exibido: cliente → @username → "Contato do Instagram";
  - copy da janela por canal; título "Conversas".

## Sugestões para fases futuras (fora do escopo aprovado)

- Campanha por post: palavra-chave válida só num post/reel ("comente RESERVA"), com DM próprio.
- Ice breakers e menu persistente no Direct (Ver cardápio, Fazer reserva, Falar com atendente).
- Modo sugestão: a IA rascunha e a equipe aprova nos primeiros dias.
- Ocultar comentário ofensivo (desligado por padrão).
- Relatório de conversão por post.
- Visão também no WhatsApp.

## Fora do escopo

Publicar posts e stories, agendar conteúdo, Instagram Live, anúncios e Facebook Messenger.

## Segurança e privacidade

- O tenant vem do recurso:
  - webhook resolve pela conta (`entry.id`);
  - EF autenticada resolve por membership com `hasUnitAccess`;
  - nenhum id de escopo vem do caller.
- Segredos:
  - app secret e `verify_token` em `platform_secrets`, com `supabase secrets set` sincronizado no mesmo ato (AGENTS.md §5);
  - token de loja no Vault;
  - nenhum token em log, DTO ou erro;
  - a URL do Graph com token é redigida na fonte.
- LGPD:
  - IGSID, @ e conteúdo são dado pessoal;
  - a mídia de story não é armazenada;
  - anonimizar cliente também anonimiza o contato ligado;
  - a retenção da fila segue a do WhatsApp.
- `instagram_settings` nasce desligado. Revogar o grant desliga a ingestão imediatamente (o webhook lê o grant sem cache).

## Fases e critérios de saída

| Fase | Entrega | Saída |
|---|---|---|
| 0 | Escopo de tenant das ferramentas de reserva; extração do núcleo do agente com paridade | Testes de regressão e de paridade verdes; deploy do `webhook-whatsapp` autorizado à parte |
| 1 | Grants, conta, contatos, fila, webhook, connect, refresh, agente no Direct, Conversas com filtro, envio manual | E2E na loja piloto: DM → IA pede telefone → reserva `source=instagram` → aparece em Conversas → assumir/devolver |
| 2 | Stories (menção e resposta) + visão | Story com foto → resposta cita detalhe verdadeiro; URL expirada mostra placeholder |
| 3 | Comentários por palavra-chave + Atividade | Comentário "qual o cardápio?" → resposta pública + DM; limites de 1/7d/24h provados |

A operação Meta (app, Business Verification, Advanced Access) corre em paralelo e é o caminho crítico para lojas além da piloto.

## Verificação

- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` e `deno check` das EFs tocadas.
- Pré-voo SQL local, provando:
  - isolamento A×B de conta, contato, conversa, palavras e ledger;
  - operador sem escrita em `instagram_settings`;
  - só `platform_admin` concede;
  - ACL das funções.
- Gates `saas-shield-br` proporcionais (migration, RLS, tenant, identidade, integrações, secrets) e check `acl-estatico`.
