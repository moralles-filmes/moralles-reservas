# Prompt para o chat da Fase C — ingestão assíncrona do webhook de WhatsApp

> Copie **tudo** abaixo da linha e cole como primeira mensagem num chat novo, na raiz do projeto
> `moralles-reservas`. Não resuma nem edite: o que parece redundante aqui foi aprendido errando.

---

Você vai implementar a **Fase C** da integração Datafy no `moralles-reservas`: **ingestão assíncrona do
webhook de WhatsApp**.

## Antes de escrever qualquer código

Leia, nesta ordem:

1. `CLAUDE.md` inteiro — em especial as seções "Agente IA — WhatsApp", "Conversas — invariantes",
   "Observabilidade WhatsApp" e o checklist de redeploy em "Deploy".
2. `docs/superpowers/specs/2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md` — a auditoria e a
   spec que originou as Fases A–D.
3. `docs/superpowers/plans/2026-09-22-datafy-fases-a-b-provider-oficial.md`, seção **"Notas de execução"**
   no fim — é lá que está escrito por que a Fase C existe.

**Siga o fluxo obrigatório do projeto**, que o `CLAUDE.md` descreve e que não é negociável para mudança
estrutural: `superpowers:brainstorming` → spec em `docs/superpowers/specs/` → `superpowers:writing-plans`
→ plano em `docs/superpowers/plans/` → `superpowers:subagent-driven-development`. Antes de executar,
classifique com `ai-router-br:route`. Antes de mergear, rode os gates `saas-shield-br:*` que se aplicarem
(esta fase toca webhook e banco: no mínimo `rls-auditor`/`migration-validator` se houver migration, e
`integration-reliability-auditor`).

**Crie uma branch e worktree separadas** — há outras frentes ativas em `.claude/worktrees/`, e você não
deve tocar em nenhuma delas.

## O problema, em uma frase

O `webhook-whatsapp` processa o inbound **inteiro** dentro da requisição HTTP do provider, e o orçamento
de resposta da Datafy (~20 s) não comporta esse pipeline.

## Por que não cabe — faça a conta você mesmo antes de desenhar

Leia `supabase/functions/webhook-whatsapp/index.ts` e some o caminho do pior caso. Os números que você
vai encontrar, e que precisa confirmar em vez de aceitar de mim:

- **Debounce de rajada:** 6 s de espera (`DEBOUNCE_WINDOW_MS`), por invocação, antes de qualquer coisa.
- **Claim de conversa:** `try_claim_conversation_for_ai`, TTL 90 s.
- **Chamada ao LLM:** timeout de 12 s por tentativa, com 2 retries em 5xx/429/rede, backoff exponencial
  (`_shared/retry.ts`). Pior caso realista: bem mais de 20 s só aqui.
- **Fallback same-provider** (Gemini Flash → Pro) pode acrescentar outra rodada inteira.
- Depois disso ainda há `sendOutbound` e o append na conversa.

Ou seja: **o pior caso já estoura o orçamento com folga**, e hoje isso não aparece porque os providers em
uso (Z-API, UazAPI) são mais tolerantes. A Datafy não é. E a consequência de estourar não é um erro
visível: o provider considera a entrega falha e **reenvia**, o que multiplica o trabalho e pode gerar
resposta duplicada.

## O que a Fase C precisa entregar

**Separar o ACK do processamento.** O webhook deve validar, persistir o evento cru e responder rápido; o
trabalho pesado (debounce, IA, envio) acontece depois, fora da requisição do provider.

O que **não** está decidido, e é o que você vai desenhar no brainstorming:

- **Qual mecanismo.** O `CLAUDE.md` e o prompt original proíbem infraestrutura nova (Redis, Kafka,
  BullMQ) sem justificativa técnica. O projeto já tem dois padrões de fila próprios que valem estudar
  antes de inventar um terceiro: a tabela `notification_outbox` com worker `pg_cron`, e o padrão
  claim/fence de `processed_messages`. **Avalie também `EdgeRuntime.waitUntil`** — mas repare que o
  `CLAUDE.md` já o proíbe explicitamente no `asaas-webhook`, por um motivo que você precisa entender e
  decidir se vale aqui também.
- **Onde o debounce de 6 s passa a viver.** Ele existe para combinar mensagens de uma rajada. Movido para
  depois do ACK, ele deixa de custar tempo de resposta — mas a lógica de "desisto se chegou mensagem mais
  nova" precisa continuar funcionando, e ela hoje se apoia em timestamps lidos da conversa.
- **O que acontece com a idempotência.** Hoje o claim de `processed_messages` acontece dentro da
  requisição. Se o ACK vem antes, o claim precisa continuar impedindo processamento duplo — e agora
  também precisa impedir que um reenvio do provider, chegando enquanto o primeiro ainda está na fila,
  entre duas vezes.
- **O que acontece com falha no processamento assíncrono.** Hoje um erro vira `agent_error` +
  auto-handoff, dentro da mesma requisição. Fora dela, ninguém está esperando a resposta: decida como o
  erro fica visível (o projeto tem `webhook_executions` com `outcome`, e um padrão de dead letter foi
  pedido na spec original).

## Invariantes que NÃO podem ser quebrados

Estes estão no `CLAUDE.md` e valem como critério de aceite. Leia cada um na fonte antes de desenhar:

- **Assinatura sobre corpo cru.** A validação HMAC acontece sobre o texto exato recebido, antes de
  qualquer `JSON.parse`. Se você persistir o evento cru, persista o **corpo cru**, e não um objeto
  re-serializado — re-serializar destrói a capacidade de revalidar.
- **Idempotência é `(provider, message_id)`** com claim cercado por UUID e takeover de 90 s. Erro de
  banco **nunca** é tratado como duplicata nem vira 200: isso perderia inbound ou deixaria duas IAs
  concorrentes.
- **O canal é resolvido pelo `channel` da querystring + `SELECT`, nunca pelo corpo do payload.** É isso
  que faz a guarda anti-cross-tenant valer alguma coisa.
- **Append em `conversations.messages` é sempre pela RPC `append_conversation_message`**, com `event_id`
  estável por tentativa. Nunca SELECT→push→UPDATE.
- **Lock de conversa** (`try_claim_conversation_for_ai`) e **release em todos os caminhos de saída**,
  inclusive no catch externo.
- **`whatsapp_channels`, `processed_messages`, `webhook_executions` são `FORCE RLS` sem policies** — a
  separação entre clientes depende inteiramente do código da Edge Function. Se você criar tabela nova
  para a fila, ela nasce com a mesma disciplina e carrega `unit_id`.
- **Canal inativo responde 200 sem entrar em CRM/conversa/IA.**

## O que esta fase deliberadamente NÃO faz

- Não altera o comportamento dos quatro providers legados de forma observável. Z-API e UazAPI estão em
  produção com loja real (Ren Sushi) atendendo agora. Se o desenho mudar o caminho deles, isso precisa ser
  uma decisão explícita e justificada na spec, não um efeito colateral.
- Não implementa CTWA nem Conversions API — isso é a Fase D.
- Não implementa templates — fase posterior.

## Estado do sistema quando você começar

- Fases A e B estão **em produção**: provider `datafy` registrado, assinatura `whsec_` validada, migration
  110 aplicada, canal criável pelo painel com descoberta automática de `phone_number_id` pelo `/me`.
- **Nenhum canal Datafy existe ainda**, e nenhum pode ser ativado: o trigger de paridade exige
  `manual_echo_verified_at`, cuja única fonte para provider Meta-shaped é o eco de aparelho via
  `message_echoes[]`, que só existe em Coexistence. Isso é paridade com o `official` e não é problema seu.
- **Nada foi exercitado contra a Datafy real** — não há credencial. A spec carrega o aviso
  **VALIDAÇÃO REAL COM PROVIDER PENDENTE** e cinco itens de validação. Se você também não tiver
  credencial, **não declare a fase validada**: marque a pendência do mesmo jeito.

## Duas coisas que este projeto aprendeu errando, e que você deve herdar

1. **Envelope de provider se MEDE, não se deduz da documentação.** Há um incidente registrado no repo em
   que o formato real de um provider divergia da doc e a suíte ficou verde por 14 dias exercitando uma
   forma inventada. Se a Fase C precisar interpretar payload, instrumente **forma** — nomes de campo e
   `typeof`, pela disciplina de `_shared/webhook-payload-shape-core.ts` — e **nunca valor**, que vazaria
   telefone de cliente e credencial para o log.
2. **Procure por consequência, não por forma.** Na Fase A–B, três varreduras minhas subestimaram o escopo
   porque eu buscava o que *mencionava* um nome de provider, e o que estava errado eram `else`, defaults e
   lookups por capability — invisíveis a `grep` por nome. Ao mapear o que a Fase C alcança, pergunte "o
   que decide o tempo de resposta?" e não "o que cita `await`?".

## Quando terminar

Produza, no fim, um arquivo de prompt para a **Fase D** (CTWA — captura e persistência de `ctwa_clid` e
`referral`), no mesmo formato deste, em
`docs/superpowers/prompts/fase-d-ctwa.md`, e entregue o caminho ao usuário para ele abrir o próximo chat.

Escreva esse prompt da Fase D **para quem não acompanhou nada disto** — mesmo nível de detalhe, mesma
honestidade sobre o que não está decidido. Ele precisa conter, no mínimo:

- A decisão de escopo que o dono já tomou: **não há anúncio rodando hoje, mas o dado deve ser preservado.**
  Ou seja: capturar e persistir `referral`/`ctwa_clid` do inbound agora; o envio para a Conversions API da
  Meta (com deduplicação de evento) fica para depois.
- O invariante de atribuição que a spec original define: **touchpoints nunca são sobrescritos** — um
  cliente pode chegar por vários anúncios ao longo do tempo, e o histórico é o dado.
- O estado em que a Fase C deixou o pipeline de ingestão, porque a Fase D vai pendurar trabalho nele.
- Os mesmos invariantes de multi-tenancy, RLS e redeploy listados acima.
- O aviso de validação real pendente, se ainda não houver credencial.

## Primeira coisa a fazer neste chat

Não comece pelo código. Comece confirmando por leitura os números do orçamento que eu afirmei acima
(debounce, timeout, retries) e me diga se eles batem — se não baterem, o desenho muda e eu quero saber
antes.
