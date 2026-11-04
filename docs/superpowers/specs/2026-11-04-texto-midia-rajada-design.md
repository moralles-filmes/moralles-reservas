# Texto e mídia na mesma rajada: a resposta ao texto não pode se perder

Status: **aprovada pelo responsável em 2026-11-04**, com o builder check incorporado. Canais: WhatsApp e Instagram (Direct).

## 1. Intenção

Quando o cliente manda um texto e, poucos segundos depois, uma mídia (foto, áudio, vídeo, documento, figurinha etc.), hoje o texto **nunca é respondido**:
1. o turno do texto espera a janela de rajada (debounce de 6 s);
2. o placeholder da mídia entra no histórico como mensagem `user` mais nova;
3. o turno do texto conclui que foi superado e termina `debounced_superseded`;
4. o caminho de mídia não roda a IA e responde só o `MEDIA_REPLY_TEXT` ("Por aqui só consigo ler texto…").

O cliente que pediu "quero reservar pra 4 sábado às 20h" e mandou um print fica sem a resposta da reserva. O caso apareceu no E2E do piloto do Instagram, em 2026-11-04. O cartão automático "Phone number" do IG, uma variante desse caso, já foi corrigido à parte (PR #72, `ignored_auto_card`). O responsável pediu explicitamente que este caso seja corrigido, e não estacionado.

## 2. Comportamento desejado (decidido pelo responsável)

Regra: **cada coisa é respondida na ordem em que chegou.**

| Sequência dentro da rajada | O cliente recebe |
|---|---|
| Texto → mídia (a mídia chega enquanto a resposta ao texto ainda não saiu) | 1) a resposta normal da IA ao texto; 2) logo abaixo, o **aviso variante** (§3) |
| Mídia → texto | 1) o aviso de hoje (`MEDIA_REPLY_TEXT`), na hora; 2) a resposta da IA ao texto. **Já é assim hoje: não pode regredir.** |
| Texto → mídia → texto | a IA responde aos dois textos juntos, como já faz com rajadas, e o aviso variante vem logo depois |
| Várias mídias enquanto a resposta ao texto ainda não saiu | **um** aviso variante só |
| Só mídia, sem texto pendente | o aviso de hoje, como hoje |

## 3. Texto do aviso variante (decidido pelo responsável)

> "Recebi também sua foto, mas por aqui só consigo ler texto. Se tiver mais alguma dúvida, é só me escrever."

- **Decisão minha:** a palavra "foto" muda conforme o tipo de mídia, quando o tipo é conhecido: foto, áudio, vídeo, documento, figurinha, localização, contato. Quando houver mais de um tipo na rajada, ou o tipo for desconhecido, usa "seu arquivo". O Instagram hoje só tem `[mídia]` genérico, então lá sai "seu arquivo", a menos que o builder já tenha o tipo à mão sem custo.
- O texto fica numa constante compartilhada, ao lado de `MEDIA_REPLY_TEXT` ([media-reply-text.ts](../../../supabase/functions/_shared/media-reply-text.ts)). Todas as variantes (conjunto fechado: um texto por tipo, mais "seu arquivo") entram no filtro `HARDCODED_AGENT_NOISE`, que compara a string exata, do `turn.ts`, pelo mesmo motivo de `MEDIA_REPLY_TEXT`: não poluir o histórico que vai para a IA.

## 4. Objetivos, não objetivos e o que seria fracasso

**Objetivos**
- A resposta ao texto sempre sai quando chega mídia na mesma rajada.
- O aviso sai uma vez, na posição certa: depois da resposta, se a mídia chegou depois do texto; na hora, se chegou antes.
- O mesmo comportamento no WhatsApp e no Instagram. O núcleo é compartilhado: `_shared/agent/turn.ts`, consumido por `webhook-whatsapp` e `process-instagram-inbound`.

**Não objetivos**
- A IA entender o conteúdo da mídia (visão ou transcrição). Visão está prevista para a Fase 2 do Instagram.
- Mudar a janela de debounce, o lock de conversa ou o orçamento do turno.
- Mudar o comportamento com a conversa em atendimento humano (`human_active`/`awaiting_human`): mídia não gera resposta automática, como hoje.
- Mudar o descarte do cartão automático do IG (`ignored_auto_card`).

**Fracasso, mesmo que "funcione"**
- O cliente fica sem a resposta do texto.
- O aviso sai duas vezes (por exemplo, o caminho da mídia e o turno do texto mandam os dois).
- O aviso se perde quando a mídia e a resposta da IA saem quase ao mesmo tempo.
- A própria IA também diz "não consigo ver imagens", duplicando o aviso.
- O snapshot de paridade do WhatsApp muda em cenários sem mídia.

## 5. Restrições

- **Exatamente uma vez.** O caminho de mídia e o turno do texto rodam em invocações diferentes, sem fila entre eles. A decisão "o aviso vai agora" × "o aviso fica para depois da resposta" e o envio do aviso adiado precisam de uma reivindicação atômica, para que só um dos dois mande. As escritas no histórico já passam pelo RPC atômico `append_conversation_message` ([conversation-log.ts](../../../supabase/functions/_shared/conversation-log.ts)). O builder escolhe o mecanismo, por exemplo:
  - marcar a mídia no próprio `append` e "reler depois de escrever" dos dois lados;
  - um RPC pequeno de reivindicação. Se precisar de migration, valem `.claude/rules/banco-de-dados.md` (revoke de EXECUTE, papel mínimo) e o gate de migration.
- **O debounce ignora mídia ao decidir quem foi superado.** Um placeholder de mídia nunca torna `debounced_superseded` um turno de texto. Texto mais novo continua superando, como hoje.
- **A IA não repete o aviso.** O builder escolhe entre tirar os placeholders de mídia da `combinedUserMessage` (eles continuam no histórico, visíveis para a equipe em Conversas) e manter o placeholder com uma instrução no prompt. **Decisão minha, como preferência:** tirar da mensagem combinada, porque é determinístico e não gasta prompt.
- **Quem responde a rajada manda o aviso adiado.** Se o turno que respondeu não for o do texto original (outro texto da rajada venceu o debounce, ou o irmão ficou com o lock e terminou `conversation_locked`), o aviso sai com a resposta de quem respondeu.
- **Se a resposta ao texto não sair, o aviso adiado também não sai** (decisão minha, aceita pelo responsável). Por exemplo, handoff para a equipe, erro do agente, billing bloqueado ou serviço suspenso. Quem assumir vê a mídia no histórico. Por isso, a mídia adiada precisa registrar desfecho próprio em `webhook_executions`, distinto de `media_response`, para o diagnóstico mostrar que ela foi recebida e o aviso ficou com o turno do texto.
- **Gates do canal.** O aviso adiado sai pelo mesmo envio do canal e respeita os mesmos gates do aviso de hoje:
  - WhatsApp: `decideInboundAutoReply` (bloqueio e suspensão);
  - Instagram: grant, `dm_enabled`, janela de 24 h, limite de 1000 bytes.
- **A mídia só adia o aviso se houver um turno de texto vivo** (em debounce ou com o lock da conversa) que ainda vai ler o histórico no fim. "Texto sem resposta no histórico" não basta, porque o texto pode ter ficado sem resposta num turno que já acabou (`send_error`, `ai_reply_suppressed_by_human` etc.). **Decisão do builder, com teto:** a mídia nunca espera um turno que já morreu. Passado o limite, ou sem turno vivo, ela responde na hora, como hoje.
- **O aviso adiado não pode se perder na corrida** (anti-objetivo do responsável). O turno relê, depois do append final da resposta, as mídias adiadas ainda não reivindicadas. Isso vale também para a mídia que chegou durante a chamada da IA, depois da leitura que montou a `combinedUserMessage`. A reivindicação é atômica dos dois lados, então provavelmente exige um RPC e migration.
- **"A resposta saiu" significa desfecho `success`/`success_history_degraded`** (decisão minha). Depois de qualquer outro desfecho, mesmo que tenha mandado texto ao cliente (texto de franquia `ai_budget_exhausted`, texto de erro de `agent_error`, `empty_response`, mensagem de handoff), o aviso adiado não sai. A mídia fica registrada com desfecho próprio de "aviso adiado e não enviado".
- **A mídia é identificada por um campo no JSON da mensagem**, nunca pelo texto do placeholder: o cliente pode digitar "[imagem]". **Decisão minha:** estender o wrapper `appendToConversation` dos dois canais para gravar um campo como `media_kind`. Ele também dá o tipo para o aviso variante.
- **Qual texto do aviso sai** (decisão minha):
  - o variante sai sempre que a mídia vem depois de um texto da mesma rajada já respondido ou em resposta. Isso inclui o caso sequencial do Instagram: texto e mídia na mesma entrega do webhook, processados um depois do outro na mesma invocação. Ali o texto é respondido antes e a mídia sai logo depois, sem corrida;
  - o de hoje sai quando não há texto recente.
- **Mídia que chega depois de a resposta já ter saído e sido gravada** não é adiada. Ela segue a ordem de chegada e manda o aviso na hora, variante se o texto respondido for da mesma rajada.
- **Desempenho.** A resposta ao texto não pode atrasar por causa da mídia além do que já atrasa hoje.
- **Snapshot de paridade** (`src/lib/agent-turn-parity.test.ts`):
  - os cenários sem mídia ficam byte a byte iguais;
  - cenários novos de texto + mídia entram em commit próprio;
  - qualquer regravação de cenário existente é justificada no plano.
- **Deploy:** `node scripts/ef-import-graph.mjs` aponta `webhook-whatsapp` e `process-instagram-inbound` como consumidores do `turn.ts`. O caminho de mídia de cada canal está no `index.ts` de cada uma. Mudança em outro arquivo de `_shared` recalcula a matriz.
- Fluxo do AGENTS §4: spec → plano → execução com review por tarefa e gates `saas-shield-br` (webhook e EF tocados). Se houver migration, também `acl-estatico` e `migration-validator`.

## 6. Onde está hoje (pontos de partida)

- Debounce: [turn.ts](../../../supabase/functions/_shared/agent/turn.ts), "Append imediato + debounce de rajada" (`newestUserTs > myInboundTs` → `debounced_superseded`); mensagem combinada `combinedUserMessage` a partir de `pendingUserMsgs`; filtro `HARDCODED_AGENT_NOISE`.
- Mídia no WhatsApp: [webhook-whatsapp/index.ts](../../../supabase/functions/webhook-whatsapp/index.ts), bloco de `peekInboundMedia`. Ele grava `mediaPlaceholder(kind)` (`[imagem]`, `[áudio]` etc.) como `user`, checa handoff e os gates de serviço e manda `MEDIA_REPLY_TEXT` (`media_response`).
- Mídia no Instagram: [process-instagram-inbound/index.ts](../../../supabase/functions/process-instagram-inbound/index.ts), `item.kind === "media"`. Grava `INSTAGRAM_MEDIA_PLACEHOLDER` (`[mídia]`), checa handoff e manda `MEDIA_REPLY_TEXT`.
- Regras: `.claude/rules/agente-ia.md` (mídia → `MEDIA_REPLY_TEXT`; debounce otimista mais lock) e `.claude/rules/instagram.md` (cartão automático). Ambas precisam de uma linha nova com o invariante "mídia não supera texto; aviso adiado exatamente uma vez".

## 7. Testes que provam o comportamento

- Unidade (núcleo): mídia mais nova não supera texto no debounce; texto mais novo supera; a mensagem combinada não leva placeholder (se essa for a escolha).
- Por canal, os cinco cenários da tabela do §2, mais:
  - corrida mídia × resposta quase simultâneas (aviso exatamente uma vez);
  - resposta ao texto que não sai (aviso adiado não sai, desfecho registrado);
  - mídia com texto pendente velho (passa do teto e responde na hora);
  - conversa em handoff (nada muda).
  - mídia que chega durante a chamada da IA, depois da leitura que montou a mensagem combinada (o aviso sai depois da resposta);
  - mídia com texto sem resposta de um turno que já acabou (aviso na hora, sem adiar);
  - Instagram: texto e mídia em entregas separadas (invocações paralelas) e na mesma entrega (sequencial).
- Paridade do WhatsApp (§5).
- Smoke em produção, depois do deploy e com autorização: nos dois canais, texto mais foto em sequência; depois foto mais texto.

## 8. Fica com o builder

- O mecanismo da reivindicação "exatamente uma vez" e se ele exige migration.
- O teto de "texto pendente recente".
- Os nomes dos novos desfechos em `webhook_executions` e seus rótulos em Automação → Diagnóstico.
- Onde a escolha do tipo de mídia para o texto do aviso é montada, em cada canal.
