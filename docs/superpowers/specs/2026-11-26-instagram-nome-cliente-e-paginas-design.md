# Instagram: nome do cliente no prompt e Páginas já conectadas na conexão

Aprovado pelo dono em 26/11/2026. Mudança pequena, em duas partes independentes.

## Por quê

1. No primeiro atendimento real pelo Direct do Ren Sushi, a IA (persona "Yumi") chamou o cliente "Yuri Moraes" de "Yumi". No WhatsApp o prompt tem a frase "o cliente se chama X — esse é o nome do CLIENTE, NÃO o seu" sempre que há cadastro; no Instagram essa frase nunca entra, porque o cadastro privado não vai ao prompt (telefone declarado). O único nome dito com clareza é o da persona, e o modelo os troca — risco já descrito no comentário de `system-prompt.ts`.
2. O Facebook do dono administra várias Páginas e lembra quais liberou ao app. Ao conectar uma loja, o diálogo pode trazer marcada a Página de outra loja (já conectada): a conexão falha com "já está conectada a outra unidade" (`P0001 instagram_account_in_use`) ou pede para deixar só uma Página. Isso se repete a cada loja nova.

## Objetivos

- No Instagram, o prompt separa explicitamente o nome do cliente (primeiro nome do perfil) do nome da persona.
- Conectar uma loja funciona mesmo com Páginas de outras lojas, já conectadas, marcadas no diálogo do Facebook.

## Não objetivos

- WhatsApp: nenhum byte do prompt muda (o snapshot de `agent-turn-parity.test.ts` não é regravado). O WhatsApp sem nome de cliente tem o mesmo risco latente; fica para outra decisão.
- Conferir na Meta se a Página segue inscrita (`subscribed_apps`): fora deste escopo.
- Sem migration, sem mudança de banco ou de RPC.

## Anti-objetivos

- Pôr no prompt do Instagram qualquer dado do cadastro privado (inclusive o nome do cliente ligado pelo telefone): o telefone é declarado, não verificado (`.claude/rules/agente-ia.md`).
- Afrouxar a trava do banco: `instagram_account_in_use` sob lock continua sendo a garantia contra corrida; o filtro novo só evita o tropeço.
- Devolver ao navegador qualquer informação sobre contas de outras unidades além do que já é devolvido hoje.

## Abordagens consideradas

**Parte 1.**
- (escolhida) Campo opcional novo no `ChannelContext` com o primeiro nome do perfil já limpo; o núcleo o usa na frase existente quando não há cadastro privado. Mantém a regra no núcleo e o WhatsApp intocado (ele não preenche o campo).
- Reescrever a linha de identidade do Instagram para incluir a frase: espalha regra do agente no adapter do canal, contra a regra "regra do agente escrita no adapter vale só para um canal".
- Passar o cadastro ligado (`privateCustomer`) para obter o nome: viola o anti-objetivo.

**Parte 2.**
- (escolhida) No callback do `instagram-connect`, ler quais dos `ig_user_id` autorizados já têm conta não desconectada em outra unidade e descartá-los antes de `choosePage`.
- Deixar como está e só melhorar a mensagem: não resolve o tropeço recorrente.
- Tentar gravar cada Página até uma passar: repete chamadas à RPC com lock e mistura erro de corrida com escolha.

## Desenho

### Parte 1 — prompt

- `ChannelContext` ganha `declaredFirstName?: string` (Instagram preenche; WhatsApp não).
- O adapter do Instagram (`process-instagram-inbound`) preenche com o primeiro token de `cleanInstagramProfileName(contact.name)` (string vazia quando não há nome). A extração do primeiro nome é uma função pura nova em `instagram-format.ts`, testada.
- `turn.ts` repassa o campo a `buildSystemPrompt`; em `system-prompt.ts`, `customerFirstName` = nome do cadastro privado (regra atual) ou, quando não houver cadastro privado, `declaredFirstName` passado por `shortStoreText` (mesmo teto `personName`).
- A frase usada é a existente ("O cliente com quem você está falando se chama X — esse é o nome do CLIENTE, NÃO o seu. Você continua sendo {agente}…").
- Quando `declaredFirstName` foi fornecido mas está vazio (perfil sem nome), entra a âncora negativa: "Você é {agente}; não chame o cliente por esse nome." Quando o campo está ausente (WhatsApp), nada muda.
- Testes: prompt do Instagram contém a frase com o primeiro nome do perfil; nunca contém o nome do cadastro privado; perfil sem nome traz a âncora; WhatsApp idêntico (paridade). Controle positivo: remover o repasse faz o teste da frase falhar.

### Parte 2 — escolha de Página

- Núcleo puro em `instagram-graph-core.ts`: `excludePagesInUse(pages, inUseIgUserIds)` devolve as Páginas cujo `igUserId` não está no conjunto. `choosePage` roda sobre o resultado.
- `instagram-connect` (callback), depois de `listPages` e antes de `choosePage`: uma leitura service-role em `instagram_accounts` com `ig_user_id in (ids autorizados)`, `status <> 'disconnected'`, `unit_id <> unidade do state`, selecionando só `ig_user_id`. Erro de leitura → 503 (falha fechada, como as demais leituras do callback).
- Desfechos:
  - todas as Páginas aptas descartadas por estarem em uso → 409 com a mensagem atual `inUse` ("Esta conta do Instagram já está conectada a outra unidade");
  - nenhuma Página com Instagram desde o início → mensagens atuais (`noPage`/`taskInsufficient`), sem mudança;
  - sobrou uma → conecta nela;
  - sobraram várias → fluxo atual de `many` (reconexão pela conta da unidade ou 409 `manyPages` listando só as livres).
- A ordem "descartar em uso" vem antes do filtro de tarefas: uma Página em uso noutra unidade nunca é candidata, tenha ou não as tarefas.
- Log: `instagram_connect_pages_in_use_skipped` com a contagem (sem ids nem @).
- Testes do núcleo: descarta em uso, mantém as livres, mantém a da própria unidade (não entra no conjunto), conjunto vazio não muda nada. Controle positivo: sem o filtro, o caso "Moralles + Ren marcadas, Moralles em uso" cai em `many`.

## Deploy

`process-instagram-inbound` e `instagram-connect` (conferir consumidoras com `node scripts/ef-import-graph.mjs` para cada `_shared/` alterado). Sem migration; ordem livre.

## Fica com quem implementa

Nomes exatos de funções/variáveis, onde no `index.ts` posicionar a leitura, texto do log.
