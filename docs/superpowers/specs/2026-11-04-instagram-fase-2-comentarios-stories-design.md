# Instagram Fase 2 — IA nos comentários e nos stories

**Estado:** rascunho para aprovação do responsável (2026-11-04). Revisa as Fases 2 e 3 de [2026-10-19-instagram-modulo-design.md](2026-10-19-instagram-modulo-design.md): as duas viram **uma Fase 2**, e a seção "Comentários por palavra-chave (Fase 3)" é **substituída** por este documento. O resto daquela spec (núcleo do agente, modelo de dados da Fase 1, segurança, LGPD, interface base) continua valendo.

**Pré-requisito:** a Fase 1 (Direct + Conversas, PR #66) em produção, com o login da Meta destravado. Esta fase só começa depois disso.

## Intenção

O responsável quer o que o ManyChat tem de bom (as **portas de entrada** de conversa no Instagram: comentário, resposta a story, menção em story, botões do Direct), mas **sem fluxo engessado nem árvore de botões**. Toda porta de entrada cai na **mesma IA** que atende o WhatsApp hoje, que recebe o contexto de onde a pessoa veio e conduz a conversa adaptando-se, como já faz no WhatsApp: entende o pedido, tira dúvida, pede o WhatsApp e reserva.

Referência observada (2026-11-04, conta ManyChat PRO da Ren Sushi, só leitura): o valor do ManyChat está nos gatilhos (comentário com palavra-chave → DM, resposta a story, menção, iniciadores de conversa, menu, métricas de execução). Na prática a Ren usa uma árvore enorme de botões a partir da resposta padrão; é exatamente o que **não** queremos copiar.

## Objetivos

1. **Comentários em posts e reels:** a IA lê cada comentário, entende o tipo e age em dois lugares: **responde em público, curto,** e **inicia uma conversa no Direct** (resposta privada da Meta).
2. **Menções em story** (alguém marca o restaurante no próprio story): a IA **olha a imagem** e o texto, entende o tipo e responde no Direct de acordo.
3. **Respostas a stories do restaurante:** a IA sabe a qual story a pessoa respondeu, vê a imagem e o contexto dele e conduz a conversa.
4. **Crítica vira atendimento humano já adiantado**, em qualquer porta de entrada.
5. **O dono decide o que a IA pode fazer:** interruptores por função na página Instagram da loja.
6. **Custo de IA sob controle da plataforma**, com teto diário por loja.
7. **Números por porta de entrada** na página Instagram.

## Comportamento esperado (decidido pelo responsável)

### Comentários

| Tipo de comentário | Resposta pública | Direct |
|---|---|---|
| Dúvida ou intenção de reservar ("como faz reserva?") | curta, avisando que chamou no Direct | a IA já começa o atendimento sobre o que foi perguntado |
| Elogio | agradece com naturalidade | agradece e deixa a porta aberta para voltar / reservar |
| Crítica ou reclamação | **mensagem genérica e segura** ("sentimos muito, te chamamos no Direct para entender"), sem detalhes nem discussão | triagem (abaixo) + passagem para atendente |

"E assim por diante": outros tipos (horário, endereço, cardápio, evento, delivery, trabalhe conosco) seguem o mesmo padrão de "responde curto em público + continua no Direct". A classificação é da IA, **não** de lista de palavras-chave.

### Crítica (qualquer origem: comentário, menção em story, Direct)

- No Direct, a IA pergunta com empatia o que aconteceu, para adiantar o trabalho do atendente.
- Avisa a pessoa que vai passar para alguém da equipe, que responderá por ali.
- Faz o handoff como o WhatsApp já faz (conversa em "aguardando atendente" em Conversas).
- O atendente vê **um resumo** do caso sem reler tudo (origem, post/story, o que aconteceu).
- A conversa fica **identificável como crítica** para o atendente.

### Stories

- **Menção:** a IA classifica pela imagem + texto: visita/elogio → agradece citando um detalhe verdadeiro e visível e deixa a porta aberta; crítica → fluxo de crítica; marcação sem relação → no máximo um agradecimento curto, ou nada.
- **Resposta a story da loja:** a IA usa a imagem e o contexto daquele story (promoção, evento) e conduz como no WhatsApp.

### Botões do Direct

- Iniciadores de conversa e menu fixo ("Quero reservar", "Horários", "Cardápio") ligados com textos padrão.
- Tocar num botão equivale a escrever a frase; a IA segue a partir dela. Não há caminho pré-montado atrás do botão.

### Página Instagram da loja

- Interruptores: IA no Direct (já existe), IA nos comentários, IA em respostas a story, IA em menções em story. Desligado = sem resposta automática naquela porta; o que chegar aparece em Conversas para a equipe.
- Contexto: a IA lê sozinha a legenda e a imagem do post/story. O dono pode acrescentar uma nota opcional por post ("promoção válida até domingo"); nada precisa ser cadastrado para funcionar.
- Números: conversas iniciadas por comentário e por story, críticas encaminhadas, telefones captados, reservas geradas, por porta de entrada.
- Aviso visível quando o teto diário for atingido.

### Custo e limites

- **O custo da IA é da plataforma**, embutido na mensalidade. A loja paga só a mensalidade e a Meta do WhatsApp.
- A credencial de IA continua **por unidade** (regra do projeto: sem chave global de fallback); quem cadastra a chave é a plataforma. O Instagram usa a mesma chave e o mesmo modelo da unidade.
- **Teto diário por loja** para eventos automáticos de comentário/story e para análises de imagem. Ao atingir: comentários e stories pausam naquele dia, o Direct normal continua, e o dono vê o aviso.
- Análise de imagem só em menção e resposta a story (e na imagem do post comentado, quando necessária), nunca em lote.

## Não-objetivos

- Construtor de fluxos, árvore de botões, sequências pré-montadas.
- Comentários em Live, sorteios, links de afiliado, saudação a novo seguidor.
- Republicar o story do cliente (a API não permite; fica manual).
- Ocultar/apagar comentário, publicar conteúdo, anúncios, Messenger.
- Visão no WhatsApp.

## Anti-objetivos (falha mesmo que "funcione")

- A IA discutir, se defender ou expor detalhes de uma crítica em público.
- A IA prometer desconto, cortesia, reembolso ou promoção que não existe (vale a regra atual de não inventar promoção).
- Expor em público dado do cliente ou da reserva.
- Mandar mensagens repetidas no Direct para a mesma pessoa (cara de spam).
- Um post viral estourar o custo de IA da plataforma.
- Guardar imagem de story ou de cliente.

## Restrições da plataforma Meta (confirmar na doc vigente)

- Comentários exigem `instagram_business_manage_comments` e o campo de webhook `comments`; atender lojas que não administram o app exige Advanced Access, App Review e Business Verification.
- Resposta privada: **uma por comentário, até 7 dias** após o comentário. A conversa continua só se a pessoa responder; aí vale a janela de 24h.
- Comentário da própria conta também gera webhook (anti-laço obrigatório).
- Mídia de story chega por URL de CDN que expira; **é proibido armazenar a mídia**. Story de vídeo pode não oferecer imagem estática.
- Formato exato de `reply_to` da resposta a story: medir no piloto.

## Fatos do código a respeitar

- Núcleo do agente compartilhado em `_shared/agent/` (Fase 0/1); a Fase 2 acrescenta portas de entrada, não um segundo agente.
- `AgentMessage.content` é string hoje: visão exige partes texto+imagem por provider e a capacidade declarada por modelo no catálogo único (`_shared/ai-model-catalog.ts`). Modelo sem visão recebe a descrição neutra do evento.
- Franquia de IA (`reserve_ai_budget`/`settle_ai_reservation`), lock, debounce e handoff são os mesmos do Direct.
- Ledger `instagram_comment_actions` (UNIQUE por `comment_id`) da spec original continua: no máximo uma resposta pública e uma privada por comentário.
- `instagram_settings` já prevê `story_mentions_enabled`, `story_replies_enabled`, `comments_enabled`, `vision_enabled` (a Fase 1 criou só `dm_enabled`).
- Escrita de configuração por gerente+ e `platform_admin`, como nas demais configurações.

## Decisões do responsável nesta conversa (2026-11-04)

1. A IA responde; nada de fluxo engessado.
2. Comentário: resposta pública curta + Direct; crítica com mensagem pública genérica + Direct.
3. Crítica: a IA pergunta a situação, avisa que passará para um atendente e faz o handoff.
4. Story: a IA olha a imagem e classifica (comum, crítica etc.) e responde de acordo.
5. Custo de IA é da plataforma; limites diários por loja.
6. O dono liga e desliga cada função.
7. Ordem: destravar login → Direct no ar (Fase 1) → este documento (Fase 2).

## Escolhas minhas (o responsável pode vetar)

- **Ruído** (só emoji, marcar amigo, spam): nenhuma ação.
- **Já em conversa:** se a pessoa já tem conversa aberta no Direct dentro da janela, a IA não manda nova abertura; segue na conversa existente com o contexto do comentário.
- **Ignorados:** comentários da própria loja, respostas dentro de discussões entre terceiros e comentários com mais de 7 dias.
- **Resposta pública de crítica** vem de variações de texto fixas e seguras, não gerada livremente pela IA; nas demais, a IA gera texto curto com limite de tamanho.
- **Triagem de crítica** coleta só o essencial: quando foi, unidade, o que aconteceu e, se fizer sentido, o WhatsApp para retorno.
- **Limites da IA na crítica:** não promete compensação, não discute, não empurra reserva.
- **Teto diário:** padrão definido pela plataforma, ajustável por unidade pelo `platform_admin`; o dia segue BRT.
- **Quem vê os interruptores:** dono e gerente (mesma regra das outras configurações).

## Respostas à revisão de quem vai construir (escolhas minhas, vetáveis)

1. **Piloto:** Moralles (a mesma da Fase 1), conta da própria empresa dona do app, então roda em modo de desenvolvimento com papéis do app. O piloto exige **visão de verdade**: se o modelo da unidade não ler imagem, trocar para um que leia faz parte da preparação do piloto (custo da plataforma). Advanced Access, App Review e Business Verification correm em paralelo e são pré-requisito só para lojas além da piloto.
2. **Login:** a Fase 1 está sendo refeita sobre o **Login Unificado** da Meta (recomendado para integrações novas; host `graph.facebook.com`; token "Business Integration System User"; conta em `GET /me/assigned_instagram_accounts`). A configuração unificada já inclui `instagram_manage_comments` por padrão. Os endpoints desta fase seguem o host e o token que a Fase 1 adotar.
3. **Tipos de comentário:** as tabelas `instagram_comment_intents` e `instagram_comment_keywords` da spec original **saem**. Os tipos ficam no prompt/código; as variações públicas de crítica ficam no código como padrão do sistema (edição pela loja fica para depois).
4. **Teto diário:** dois contadores por unidade e dia BRT: eventos automáticos (comentário, menção, resposta a story; a resposta pública conta dentro do evento) e análises de imagem. A franquia de IA continua sendo consumida normalmente. Evento acima do teto **não** é adiado: fica registrado no ledger como "não atendido: teto" e aparece na Atividade, para a equipe agir se quiser.
5. **Resposta pública:** `POST /{comment-id}/replies` (permissão de comentários), publicada como a conta da loja. Se a parte pública saiu e o Direct falhou, vale só a retentativa normal do worker; depois disso fica registrado no ledger e sinalizado na Atividade, sem nova tentativa automática.
6. **"Já em conversa":** casar o id do autor do comentário com o id do Direct é premissa a **medir no piloto**. Até provar, a abertura usa a resposta privada da Meta (que cai na mesma conversa do Direct) e o ledger limita a 1 abertura por autor a cada 24h.
7. **Marca de crítica e resumo:** entram no componente compartilhado de Conversas, exibidos só quando existem (nesta fase, só conversas do Instagram). O WhatsApp não muda; os testes de paridade protegem isso.
8. **Nota por post:** tabela nova por unidade + id da mídia, RLS de leitura por membro e escrita por gerente+ e `platform_admin`.

## Fica com quem planejar

- Esquema dos contadores de teto e onde o padrão da plataforma é guardado.
- Como marcar a conversa como crítica e onde guardar o resumo do handoff.
- Prompt por porta de entrada e formato do contexto (post, story, comentário) entregue ao núcleo.
- Modelo de classificação (mesmo turno do agente ou chamada leve separada) e o que acontece quando o modelo da unidade não tem visão.
- Textos padrão dos botões do Direct e das variações públicas de crítica (em PT-BR, revisáveis pelo responsável).
- Ordem das tarefas, testes (incluindo anti-laço, 1/7 dias, teto, sem persistência de mídia) e loja piloto.

## Critério de saída

Na loja piloto:
- comentário "como faz reserva?" → resposta pública curta + Direct → reserva `source='instagram'`;
- comentário de elogio → agradecimento público + Direct;
- comentário de crítica → texto público genérico + triagem no Direct + conversa "aguardando atendente" com resumo e marca de crítica;
- menção em story com foto → resposta cita detalhe verdadeiro; menção com crítica → fluxo de crítica;
- resposta a story da loja → IA usa o contexto daquele story;
- botão "Quero reservar" → IA conduz;
- interruptor desligado → nenhuma resposta automática naquela porta;
- teto atingido → comentários/stories pausam, Direct continua, aviso no painel;
- nenhuma imagem persistida; limites de 1 resposta privada por comentário e anti-laço provados.
