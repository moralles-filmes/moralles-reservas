# FASE C — Ingestão assíncrona do webhook de WhatsApp

**Data:** 2026-09-24 · **Branch:** `feat/datafy-fase-c-ingestao-assincrona` · **Depende de:** Fases A e B (em produção)

Design da Fase C do plano de integração Datafy. Resolve o **R1** da [auditoria de Fase 0](2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md): o orçamento de resposta da Datafy é incompatível com o pipeline síncrono do `webhook-whatsapp`.

---

## 1. O problema, medido

A Datafy exige **HTTP 200 em 20 s** e reentrega **3×** (2 s, 10 s, 30 s) — documentado, **não medido contra o provider real**. O `webhook-whatsapp` processa o inbound inteiro dentro dessa requisição.

Medição por leitura do código, feita nesta fase. Os números que importam:

| Custo | Valor | Fonte |
|---|---|---|
| Debounce de rajada, **incondicional** | 6 s | `DEBOUNCE_WINDOW_MS` em [index.ts:1031](../../../supabase/functions/webhook-whatsapp/index.ts), `sleep()` em [index.ts:2565](../../../supabase/functions/webhook-whatsapp/index.ts) |
| Idas ao banco em série antes do 1º token do LLM | ≥ 20 | ~14 antes do `sleep`, ~10 montando o system prompt após o claim |
| Turno de LLM — Claude | ~12 s | `DEFAULT_TIMEOUT_MS` ([ai-providers.ts:229](../../../supabase/functions/_shared/ai-providers.ts)) |
| Turno de LLM — OpenAI/Grok/DeepSeek | ~15-17 s | 12 s de rede + backoff |
| Turno de LLM — Gemini | ~31 s | primary + fallback, cada um com orçamento próprio |
| Rodadas de ferramenta por invocação | até **12** | `MAX_ITERATIONS` ([ai-providers.ts:219](../../../supabase/functions/_shared/ai-providers.ts)) |
| Deadline de tempo total | **não existe** | `AGENT_RETRY_BUDGET_MS` só decide se um SEGUNDO `runOnce` começa |

### 1.1 Duas correções à aritmética anterior

**"12 s × 3 tentativas" está errado.** O `AbortSignal` é construído **uma vez**, dentro do literal de `init`, e o `fetchWithRetry` reusa o mesmo `init` em todas as tentativas ([ai-providers.ts:636](../../../supabase/functions/_shared/ai-providers.ts) e [:756](../../../supabase/functions/_shared/ai-providers.ts) contra o loop em [retry.ts:30-51](../../../supabase/functions/_shared/retry.ts)). `AbortSignal.timeout` conta da criação, então os 12 s são teto **do conjunto de tentativas**, não de cada uma: quando o sinal dispara, as restantes rejeitam de imediato e o backoff dorme à toa. Os 2 retries só fazem trabalho real em 5xx/429 **rápido**.

Consequência: o comentário em [ai-providers.ts:226-228](../../../supabase/functions/_shared/ai-providers.ts) ("primary 1 tentativa + fallback 3 tentativas + esperas ≈ 51s") e o **R1 da spec de Fase 0** ("timeout 12 s × até 2 retries") carregam a mesma conta errada. Esta spec a substitui.

**O que estoura o orçamento não é o pior caso — é o caso comum.** O piso é fixo: ~7 s (6 s de debounce + round-trips) **antes de qualquer trabalho**, 35 % do orçamento. Uma reserva comum faz `check_availability` → `create_reservation`, logo 3 turnos: mediano ≈ **16 s**, dentro dos 20 s com ~4 s de margem. Um 4º turno, ou um turno lento, estoura. Um único turno lento no Gemini leva o total a ~45 s.

### 1.2 Achado colateral, independente da Datafy

`AI_LOCK_TTL_SECONDS = 90` foi dimensionado contra "~51 s de pior caso do `runOnce`" ([index.ts:1036-1038](../../../supabase/functions/webhook-whatsapp/index.ts)). Mas 51 s era pior caso de **um turno**, não do loop de 12. Quatro turnos Gemini com falha passam de 90 s: o lock expira com o agente rodando e uma invocação irmã pode reivindicar a conversa — exatamente o que o lock existe para impedir. O takeover de `processed_messages` tem o mesmo prazo. É cauda, e é precisamente a cauda que as reentregas da Datafy exercitariam. Esta fase fecha isso derivando o TTL em vez de adivinhá-lo (§9).

---

## 2. Decisões de escopo (tomadas pelo dono em 2026-09-24)

| # | Decisão | Consequência |
|---|---|---|
| 1 | **Um pipeline só, atrás de gate, legados em OFF.** | Todos os providers atravessam o caminho novo, mas o despacho assíncrono nasce desligado. Comportamento observável idêntico ao de hoje até alguém ligar, canal por canal. Não se criam duas réguas para a mesma pergunta. |
| 2 | **Latência percebida preservada em ~15-20 s.** | Exige despacho imediato após o ACK; `pg_cron` é rebaixado a varredura de recuperação, nunca o caminho normal. O piso de 1 minuto do `notification_outbox` seria regressão diária para o Ren Sushi. |
| 3 | **Deadline suave + handoff visível.** | Um orçamento impede o loop de COMEÇAR nova rodada de ferramenta e deixa a em curso terminar. Estouro → mensagem de instabilidade + `awaiting_human` com motivo próprio. Duro seria pior: abortar depois de `create_reservation` deixa reserva criada e cliente sem resposta. |
| 4 | **Dead letter durável + painel agora; alerta ativo é pré-requisito da flag.** | O e-mail fica na Fase J, dona de alertas. Fica **escrito** que o gate não pode ser ligado para provider com tráfego real antes do alerta existir — mesmo idioma de `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`. |

---

## 3. Arquitetura

### 3.1 O que já existe e não precisa ser inventado

**O pipeline já se re-entra in-process.** [index.ts:1731-1741](../../../supabase/functions/webhook-whatsapp/index.ts) sintetiza um `Request`, **remove os headers de assinatura** e chama `handleWebhookRequest(..., true)` — em produção, em todo lote Meta multiparte. "Processar payload já autenticado sem revalidar assinatura" não é mecanismo novo neste repo. **A Fase C não extrai as ~1.900 linhas do pipeline.**

**O `asaas-webhook` é o precedente de persist-before-process**, com um contrato de código HTTP que mapeia quase 1:1 no da Datafy: *200 = já está durável ou foi descartado de propósito; não-200 = não consegui guardar, reentrega.*

**O fence do `processed_messages`** (claim por UUID + takeover de 90 s) é o modelo de lease a herdar — **não** o do `notification_outbox`, que documenta duas vezes não ter reaper para linhas presas em `processing` ([process-notification-outbox/index.ts:187-195](../../../supabase/functions/process-notification-outbox/index.ts)).

**A migration 028 é história a respeitar:** ela dropou `send-confirmation-on-reservation`, que chamava `supabase_functions.http_request` na veia, porque não tinha retry nem visibilidade. O que o outbox acrescentou não foi o HTTP — foi a **linha durável**.

### 3.2 Caminho da requisição, com o gate LIGADO

```
Datafy → POST /webhook-whatsapp?channel=<id>
  ├─ SELECT whatsapp_channels por channel_id da QUERYSTRING     (nunca do corpo)
  ├─ guarda de tamanho → req.text()                             (corpo CRU)
  ├─ validação de assinatura sobre o corpo cru                   (antes de JSON.parse)
  ├─ JSON.parse + guarda de identidade Meta (phone_number_id)
  ├─ INSERT whatsapp_inbound_events (corpo cru intacto)          ← obrigatório; falha = 503
  ├─ ─────────── 200 "ok" ───────────                            (2-3 round-trips, < 1 s)
  └─ EdgeRuntime.waitUntil( processar(evento) )                  (latência adicional ≈ 0)
                                    │
                                    └─ re-entra handleWebhookRequest(corpo cru, modo fila)
                                         → split do lote Meta → callbacks de status/conexão
                                         → canal inativo? descarta → eco → inbound:
                                         → claim processed_messages → rate limit → CRM
                                         → conversa → debounce 6 s → lock → agente → envio
                                         (sob o deadline suave de §9)

pg_cron */1 → POST /webhook-whatsapp?sweep=1  (x-internal-key)   ← só recuperação
  └─ lê eventos due (received, ou processing com lease expirado) e processa in-process
```

### 3.3 A fronteira é ÚNICA, e fica logo depois da guarda de identidade

**Tudo a jusante da guarda de identidade Meta é diferido em bloco** — split de lote, callback de status, callback de conexão, descarte de canal inativo, eco de aparelho e inbound. Não se recorta "o que é caro" para diferir só isso.

O motivo é o invariante do corpo cru, e ele não admite acordo. O split do lote Meta acontece **antes** dessas checagens ([index.ts:1728-1750](../../../supabase/functions/webhook-whatsapp/index.ts)), e uma parte de lote só existe **re-serializada** (`JSON.stringify(part)`, [index.ts:1739](../../../supabase/functions/webhook-whatsapp/index.ts)). Inserir depois do split obrigaria a guardar corpo re-serializado, destruindo a capacidade de revalidar a assinatura — ou a duplicar o corpo inteiro em N linhas. Inserir **antes** do split guarda o corpo uma vez, intacto, e deixa o processador dividir em memória.

Três consequências que o implementador precisa saber de antemão:

1. **O que fica ANTES do ACK é só o que produz não-200:** resolução do canal pela querystring, guarda de tamanho (413), assinatura (401) e identidade Meta (401). Um payload que falha qualquer um deles **nunca** vira linha na fila.
2. **Callback de status passa a ser diferido.** É aceitável: `delivered_at`/`read_at` não são sensíveis a ~0 s pelo caminho rápido nem a ~60 s pela varredura. O que **não** muda é a correlação de 4 campos que impede recibo alheio de contaminar o painel.
3. **Canal inativo passa a persistir o corpo antes de descartar.** É PII de cliente numa linha que não gera nada — coberto pela purga de 7 dias da §4, e o descarte em si continua sem CRM, conversa ou IA, como o invariante exige.

O branch `?sweep=1` é reconhecido **antes** da exigência de `?channel=` (que hoje devolve `missing_channel_param`): a varredura não tem canal, ela resolve o canal de cada linha.

Com o gate **DESLIGADO**: nada disso acontece. Nenhum insert, nenhum ACK antecipado, nenhum `waitUntil`. O caminho é o de hoje, byte a byte. **Não existe estado intermediário "insere mas processa síncrono"** — ele criaria risco de processamento duplo pela varredura, e é justamente a loja em produção que pagaria.

---

## 4. `whatsapp_inbound_events` (migration 111)

Próxima migration: numeração `_111_`, timestamp **> `20260922170000`**.

```sql
create table if not exists whatsapp_inbound_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text        not null check (provider in ('zapi','uazapi','waha','official','datafy')),
  channel_id        uuid        not null references whatsapp_channels(id) on delete cascade,
  unit_id           uuid        not null references units(id) on delete cascade,
  raw_body          text        not null,   -- CRU, byte a byte; nunca re-serializado
  signature_header  text,                   -- header recebido, permite revalidar
  signature_scheme  text,                   -- qual esquema validou (auditoria)
  delivery_id       text,                   -- x-datafy-delivery-id, quando o provider tem
  received_at       timestamptz not null default now(),
  status            text        not null default 'received'
                    check (status in ('received','processing','done','dead')),
  attempts          integer     not null default 0,
  next_attempt_at   timestamptz not null default now(),
  claim_id          uuid,                   -- fence, modelo processed_messages
  claimed_until     timestamptz,            -- expiração do lease
  outcome           text,                   -- espelha o outcome do processamento
  last_error        text,
  updated_at        timestamptz not null default now()
);

alter table whatsapp_inbound_events enable row level security;
alter table whatsapp_inbound_events force row level security;
-- Sem policies: só service_role, via Edge Function. Mesma disciplina de
-- whatsapp_channels, processed_messages e webhook_executions.
```

**Uma linha por ENTREGA, não por parte do lote.** O corpo cru fica armazenado **uma vez e intacto** — guardar a parte já divida seria re-serializar, o que destrói a capacidade de revalidar a assinatura. O processador divide o lote em memória e itera as partes; a idempotência **por parte** já é de `processed_messages (provider, message_id)`, que é exatamente para isso. Numa retentativa da entrega, as partes já concluídas são recusadas como duplicata pela camada que já é dona da pergunta.

**Efeito colateral bem-vindo:** isso dissolve o "qualquer filho falho → 500 do pai" de [index.ts:1742-1746](../../../supabase/functions/webhook-whatsapp/index.ts) — depois do ACK não há status de pai para envenenar. **Não resolve** a pendência bloqueante da Fase F: a decisão 401-vs-200 para evento WABA sem `metadata` continua sendo decisão de alguém.

**Dedupe de entrega:** `unique (channel_id, delivery_id) where delivery_id is not null`. Escopado por canal porque um id de entrega só tem significado dentro dele. Providers legados não têm o header: para eles não há dedupe no insert, e `processed_messages` segue sendo a autoridade — como hoje. `x-datafy-delivery-id` **não é lido por nada hoje** (verificado): a Fase C é o primeiro consumidor.

**Índices:** `(status, next_attempt_at)` parcial nos não-terminais (consulta da varredura) · `(unit_id, status, received_at desc)` (painel) · o unique parcial acima.

**Retenção.** `raw_body` carrega telefone e texto de cliente: é PII. Purga na própria varredura, sem job novo: `done` após 7 dias, `dead` após 30 (precisa sobreviver à investigação). Alinhado ao TTL de 30 d do `webhook_executions`.

---

## 5. Contrato de código HTTP

Régua herdada do `asaas-webhook`, adaptada ao contrato da Datafy:

| Código | Quando | Por quê |
|---|---|---|
| **200** | Evento persistido (gate ON) · processado por inteiro (gate OFF) · descartado de propósito (canal inativo, entrega duplicada, callback que não é inbound) | Já está durável, ou a decisão de descartar foi nossa |
| **401** | Assinatura inválida, identidade Meta divergente | Inalterado |
| **404** | Canal não encontrado · **413** payload grande demais | Inalterado |
| **503** | **Gate ON e o INSERT falhou**, ou a leitura do gate falhou | Novo. A Datafy reentrega 3× — é o que queremos. Um 200 aqui apagaria o inbound para sempre |

**Nunca 200 sobre insert que falhou** e **nunca 500 de filho de lote** (não há mais filho HTTP). Leitura do gate que falha é falha de persistência, não "OFF": tratá-la como OFF processaria síncrono e estouraria o orçamento sem rastro.

---

## 6. O gate

**Duas perguntas independentes, ambas precisam ser verdadeiras:**

1. **Kill-switch global** — `platform_flags.whatsapp_async_ingestion`, lido por `checkFlagEnabled` de [_shared/platform-flags.ts](../../../supabase/functions/_shared/platform-flags.ts) (cache 5 min, **fail-closed**: ausente = OFF). Semeada em migration com `on conflict do nothing`. Um `UPDATE` desliga tudo durante incidente.
2. **Opt-in por canal** — `whatsapp_channels.async_ingestion_enabled boolean not null default false`. A linha do canal **já é lida antes do ACK** ([index.ts:1581](../../../supabase/functions/webhook-whatsapp/index.ts)), então custa **zero** I/O extra. Dá o rollout mais conservador possível — um canal por vez, reversível com um `UPDATE`.

**A migration 111 precisa ser aplicada ANTES do deploy da Edge Function que lê a coluna.** Invariante já registrado no `CLAUDE.md`: coluna inexistente vira 400 do PostgREST, a leitura falha, e um gate fail-closed passa a recusar. Aqui o efeito seria pior que recusa — seria 503 em todo inbound de todo canal.

---

## 7. Despacho e varredura

**Caminho rápido: `EdgeRuntime.waitUntil`.** Documentado pelo Supabase exatamente para isto ("respond quickly while processing continues"). Duas propriedades medidas nos docs e que o desenho respeita:

- O wall clock de 400 s (plano pago) é **por worker, não por request**: "a worker can serve multiple requests or process background tasks". Uma tarefa em `waitUntil` herda o resto de vida de um worker que ela não conhece, e `waitUntil` "does not extend the hard wall clock limit". **Logo o caminho rápido é otimista, nunca garantia.**
- Degradação é benigna: worker morto no meio deixa a linha em `processing` com lease expirado, e a varredura a retoma. O cliente espera ~70 s em vez de nunca.

**Varredura: `pg_cron */1` chamando a MESMA função** com `?sweep=1` e `x-internal-key`, via `requireInternalAuth` de [_shared/security.ts](../../../supabase/functions/_shared/security.ts). Wrapper `SECURITY DEFINER` lendo `internal_api_key` **e `project_url`** do Vault — migration **nunca** embute a URL do projeto nem o segredo, e o header se monta por concatenação (`'...' || v_key || '...'`). Guardrail em [scripts/migration-static-guard.test.ts](../../../scripts/migration-static-guard.test.ts).

**Propriedade de segurança do branch `?sweep=1`, e é ela que torna esta abordagem preferível a um worker que re-POSTa cada evento:** o branch **não aceita payload nenhum**. Ele lê exclusivamente da tabela. Se a chave interna vazar, o poder conferido é "fazer uma varredura rodar mais cedo" sobre eventos já persistidos e já validados por assinatura — não injetar inbound. Um caminho público que aceitasse corpo e pulasse a validação de assinatura, gateado só pela chave, seria a superfície perigosa que este desenho recusa.

`webhook-whatsapp` já tem `verify_jwt = false` em `supabase/config.toml`; **nenhuma entrada nova é necessária.** Para exercitar `waitUntil` localmente, `config.toml` precisa de `[edge_runtime] policy = "per_worker"` (só dev local; instâncias são encerradas após a resposta sem isso).

---

## 8. Re-entrada no pipeline

O processador monta um `Request` a partir de `raw_body` + `provider` + `channel_id` e chama `handleWebhookRequest` — o mecanismo de [index.ts:1731-1741](../../../supabase/functions/webhook-whatsapp/index.ts).

**Não sobrecarregar `trustedMetaPayload`.** Hoje esse booleano significa *"sou parte filha de um lote cujo pai já validou a assinatura"*. Reusá-lo para *"vim da fila durável"* junta duas perguntas num sinal, que é o anti-padrão que este repo nomeia em `isMetaShapedProvider` ("forma de payload e esquema de assinatura são DUAS perguntas"). A assinatura da função passa a receber um objeto explícito:

```ts
handleWebhookRequest(req, { signatureAlreadyVerified: true, source: "queue" })
```

**`source: "queue"` é o que impede o processador de inserir o evento de novo.** Reinserir criaria um laço infinito de eventos — o defeito mais perigoso disponível neste desenho. Ele **exige teste com controle positivo**: remover a guarda e ver o teste falhar.

---

## 9. Deadline suave e TTL derivado

**Orçamento de 30 s**, contado do início do **processamento** (não da requisição, que já terminou). Ao estourar, o loop **não começa** nova rodada de ferramenta e deixa a em curso terminar. Teto = orçamento + um turno (~31 s no pior caso Gemini) + envio.

**Onde é aplicado:** `AgentLoopOptions` ganha `shouldContinue?: () => boolean`, checado no topo de cada `while (iterations-- > 0)` nos três runners de [ai-providers.ts](../../../supabase/functions/_shared/ai-providers.ts). **Opcional; ausente = comportamento de hoje, exato.** `manage-ai-providers` não muda de comportamento, mas entra no redeploy (§12) porque o arquivo mudou.

**Ao estourar:** mensagem de instabilidade (a constante `AGENT_INSTABILITY_TEXT` que já existe, já no `HARDCODED_AGENT_NOISE`) + `awaiting_human` com `handoff_reason: agent_deadline` — **distinto de `agent_error`**, porque a consequência é distinta: retry estrutural não resolve nenhum dos dois, mas só um deles diz "o agente estava funcionando, só não caberia".

**O TTL do lock deixa de ser adivinhado.** `AI_LOCK_TTL_SECONDS` permanece **90 s** e passa a ser *verificado* contra a aritmética: `orçamento + pior turno + envio ≤ TTL`. A verificação é **teste**, não runtime — um teste que falha se alguém subir o orçamento sem subir o TTL, fechando o achado de §1.2 sem mudar comportamento.

### 9.1 Emendas de execução — o código diverge desta seção em três pontos

Registradas aqui porque a spec é o documento de design de referência e lê-la sem estas linhas leva a reintroduzir defeito medido. A revisão de branch pode reverter qualquer uma; o que não vale é a divergência ficar só no código.

**(a) O prazo vale SOMENTE na fila.** Acima, §9 não escopa `shouldContinue`, e o plano o liga incondicionalmente — o que o faria valer também no caminho **síncrono**, o dos quatro providers legados com loja real atendendo agora. E não seria inócuo: `AGENT_SOFT_DEADLINE_MS` (30 s) é **menor** que `WORST_SINGLE_TURN_MS` (31 s), então uma rodada de pior caso consome o orçamento inteiro e a seguinte é sempre recusada — cortaria conversas de duas rodadas que hoje concluem e desligaria o empty-retry do Gemini. Escopar preserva o requisito da própria fase ("não altera o comportamento dos quatro providers legados de forma observável"). Consequência colateral: o síncrono continua **sem teto de parede nenhum** — `AGENT_RETRY_BUDGET_MS` só decide se cabe uma retentativa e o TTL do lock **expira** em vez de parar quem o segura. Dar-lhe um teto é decisão própria, com sua própria medição, e não carona desta fase.

**(b) A mensagem ao cliente NÃO é sempre `AGENT_INSTABILITY_TEXT`.** O parágrafo "Ao estourar" acima produz o defeito que `_shared/ai-budget-copy.ts` nomeia no próprio cabeçalho: a rodada 2 executa `create_reservation`, a rodada 3 — a que confirma — é recusada pelo prazo, e o cliente ouve "instabilidade" com a reserva `confirmed` no banco (ele não aparece, mesa segurada vazia; ou aparece achando que não tem reserva). E sem ferramenta mutante o texto afirma falha técnica onde não houve falha nenhuma. O código usa as **três** pernas de §17.7.4 do Plano D: instabilidade só quando o erro é REAL (provedor), `resolveMutationStopText(lastMutationOutcome)` depois de ferramenta mutante, e o texto de parada limpa quando nada foi alterado. O `handoff_reason: agent_deadline` de §9 fica como está. **O ramo pré-existente de `agent_error` tem o mesmo defeito e não foi tocado** — mudá-lo alteraria de carona a mensagem que a loja real já manda hoje.

**(c) `manage-ai-providers` NÃO entra no redeploy — §9 (acima) e §12 estão errados nisso, inclusive no procedimento de deploy.** Medido nesta branch: `supabase/functions/manage-ai-providers/index.ts` tem 141 linhas, importa de `_shared/` apenas `security.ts` e `cors.ts`, e `grep -c "model"` no arquivo devolve **zero**. Ela não importa `ai-providers.ts` — o único `index.ts` que o importa é `webhook-whatsapp`. É CRUD fino sobre `ai_provider_credentials` (`list`/`upsert`/`delete`, gateado por `platform_admins`): não resolve modelo, não classifica preço, não autoriza chamada. A afirmação de §9 ("entra no redeploy porque o arquivo mudou") pressupõe um import que não existe. O `CLAUDE.md` já teve quatro linhas corrigidas pela mesma perna falsa, e a razão de registrar aqui é que **a spec e o plano são de onde ela voltaria por simetria**. O que deployar nesta fase: `webhook-whatsapp`, só.

---

## 10. Núcleo puro: o que a Fase C inventa

O pipeline de ~1.900 linhas fica **intocado**, mas o `vitest` não importa `webhook-whatsapp/index.ts` (`serve()` no carregamento + imports de `deno.land`), e regra que só se confere por leitura já passou defeito duas vezes neste repo. Portanto **tudo que a Fase C inventa** nasce em núcleo puro:

`supabase/functions/_shared/whatsapp-inbound-queue-core.ts`, testado em `src/lib/whatsapp-inbound-queue-core.test.ts`:

| Função | Decide |
|---|---|
| `decideIngestionMode({ flagEnabled, channelEnabled })` | `async` \| `sync`, fail-closed nas duas pernas |
| `decideAckResponse({ mode, inserted, insertError, flagReadFailed })` | A tabela de §5 |
| `nextAttemptAt(attempts)` | O backoff de §11 |
| `shouldPromoteToDead(attempts)` | O teto de tentativas |
| `decideLeaseTakeover({ status, claimedUntil, now })` | Retomada de lease expirado |
| `agentDeadlineVerdict({ startedAt, now, budgetMs })` | `continue` \| `stop_new_rounds` |
| `deliveryDedupeKey(provider, headers)` | Id de entrega, ou `null` para legado |

Padrão do repo: `whatsapp-instance-worker-core.ts` guarda a decisão, o `index.ts` é adapter. **Nenhuma dessas regras pode ser redigitada no `index.ts`** — cabe teste de acoplamento que reprove se reaparecer lá.

Atenção ao `strict: false` de `tsconfig.app.json`: em núcleo que devolve resultado tipado, `if (!x.ok) { x.campo }` **não** estreita união discriminada. Usar `x.ok === false` ou early-return.

---

## 11. Retentativa, dead letter e observabilidade

**O backoff é curto e raso de propósito: resposta atrasada é resposta errada.** O repo já formaliza isso em [whatsapp-message-ttl-core.ts](../../../supabase/functions/_shared/whatsapp-message-ttl-core.ts) — mensagem automática tem prazo contado do fato que a originou. Responder ao cliente uma hora depois é pior que não responder.

`30 s → 2 min → 5 min`, então **`dead`**. Janela total ~8 min. Além disso quem deve assumir é uma pessoa, não uma retentativa.

**Ao promover para `dead`**, se o cliente e a conversa forem resolvíveis, a conversa vai para `awaiting_human` com `handoff_reason: inbound_dead_letter` — o painel já conta isso em `useAwaitingHumanCount`, então a loja vê sem ninguém inventar tela. Best-effort: quando o evento morreu *antes* de existir conversa, isso não é possível, e sobra o contador do painel.

**Contagem no painel:** `dead` por unidade exposta no diagnóstico de `/platform/automacao` via `whatsapp-health`.

**Pré-condição escrita, não implícita:** `ASYNC_INGESTION_DEADLETTER_ALERT` — o gate **não pode ser ligado para provider com tráfego real** antes de existir o alerta ativo da Fase J, ou uma cadência manual de conferência acordada. Motivo documentado: no incidente de 2026-09-03 o dado estava correto no banco e o que corrigiu foi alguém abrir o painel **por acaso, no quinto dia**.

**Outcomes novos em `webhook_executions`:** `queued`, `queue_insert_failed`, `queue_duplicate_delivery`, `sweep_processed`, `sweep_lease_taken`, `agent_deadline`, `inbound_dead_letter`. O processamento continua registrando o outcome que registra hoje.

**Instrumentação de headers de entrega segue a disciplina de [webhook-payload-shape-core.ts](../../../supabase/functions/_shared/webhook-payload-shape-core.ts): nome de campo e `typeof`, NUNCA valor.** Publicar valor de header aqui vazaria credencial e telefone no log. O envelope real da Datafy **se mede, não se deduz** — este repo já teve suíte verde por 14 dias exercitando uma forma inventada.

---

## 12. Ordem de aplicação e redeploy

**Ordem obrigatória — banco primeiro:**

1. `supabase db push` da migration 111 (tabela + coluna + flag semeada OFF + wrapper de cron).
2. Só então `supabase functions deploy webhook-whatsapp`.

Inverter faz o gate ler coluna inexistente → 400 do PostgREST → 503 em todo inbound de todo canal.

**Redeploy (arquivos `_shared/` não compartilham bundle em runtime):**

- `whatsapp-inbound-queue-core.ts` (novo) → **`webhook-whatsapp`** (único consumidor; a varredura vive na mesma função)
- `ai-providers.ts` (ganha `shouldContinue`) → **`webhook-whatsapp`** e **`manage-ai-providers`**

`CLAUDE.md` e `AGENTS.md` ganham, **no mesmo commit**, as regras permanentes desta fase: a régua de código HTTP com o 503 novo, a dupla condição do gate, o fato de `source: "queue"` ser o que impede o laço de reinserção, e as duas linhas de redeploy acima.

---

## 13. O que esta fase deliberadamente NÃO faz

- **Não muda o que o agente faz** — só quando ele roda.
- **Não muda o caminho dos providers legados** enquanto o gate estiver OFF, que é como ele nasce.
- **Não move as ~1.900 linhas do pipeline** para `_shared/`. A testabilidade é comprada só para o que a fase inventa (§10); o refactor inteiro do arquivo mais arriscado do repo, com a loja atendendo, não é preço desta fase.
- **Não muda o mecanismo do debounce.** Ele continua append → `sleep` 6 s → reler → desistir se houver mensagem mais nova, e continua otimista, respaldado pelo lock. Um debounce baseado na fila seria mais preciso e é deliberadamente **não** feito aqui.
- **Não resolve a decisão 401-vs-200** de evento WABA sem `metadata` (pendência bloqueante da Fase F).
- **Não implementa alerta ativo por e-mail** (Fase J), **CTWA/referral** (Fase D), **templates** (F) nem **mídia** (E).

---

## 14. Critérios de aceite

1. Com o gate **OFF**, o comportamento é indistinguível do de hoje em todos os cinco providers — incluindo códigos HTTP e outcomes de `webhook_executions`.
2. Com o gate **ON**, o ACK sai em **< 1 s** medido (2-3 round-trips: canal, credencial do Vault quando o provider exige, insert), e a latência percebida pelo cliente permanece em **~16 s**.
3. Insert que falha devolve **503**, nunca 200 — com teste.
4. Reinserção a partir do modo fila é impossível, **com controle positivo** (remover a guarda faz o teste falhar).
5. Reentrega da Datafy durante o processamento não produz resposta dupla: barrada pelo unique de entrega ou pelo claim de `processed_messages`.
6. Estouro do deadline produz `agent_deadline` + mensagem ao cliente, e **nunca** aborta entre tool mutante e envio.
7. `orçamento + pior turno + envio ≤ AI_LOCK_TTL_SECONDS`, verificado por teste.
8. Evento que esgota as tentativas termina `dead`, contado no painel, e — quando resolvível — com a conversa em `awaiting_human`.
9. `npm run test`, `npm run typecheck` (`tsc -b`), `npm run lint` verdes. Pré-voo local de [supabase/tests/local-preflight/](../../../supabase/tests/local-preflight/README.md) cobrindo CHECK, FK, unique parcial e idempotência da migration, **com controle positivo**.

---

## 15. Gates antes do merge

Toca banco, webhook, autenticação e multi-tenant. Obrigatórios: `saas-shield-br:migration-validator` (migration 111), `saas-shield-br:rls-auditor` (tabela nova `FORCE RLS` sem policy), `saas-shield-br:tenant-isolation-auditor` (`unit_id` na tabela nova, canal resolvido pela querystring), `saas-shield-br:integration-reliability-auditor` (fila, lease, idempotência, dead letter, contrato de retentativa). Conferir o check `acl-estatico` na aba Checks do PR antes de mergear — a migration cria função SQL e concede grants.

---

## 16. Pendências de validação real

**VALIDAÇÃO REAL COM PROVIDER PENDENTE.** Nada aqui foi exercitado contra a Datafy — não há credencial. Os cinco itens da [spec de Fase 0 §9](2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md) seguem abertos, e esta fase acrescenta dois:

6. **`x-datafy-delivery-id` existe e se repete na reentrega?** O dedupe de entrega de §4 depende disso, e **nenhum código hoje lê esse header**. Instrumentar **forma** (nome e `typeof`), nunca valor.
7. **Os 20 s são reais?** O número é documentação. Se o corte efetivo for menor, o ACK de < 1 s ainda cabe — mas o caminho com gate OFF não caberia, e a decisão "que canais ligar" muda.

Duas premissas desta spec que também são leitura, não medição, e merecem teste antes de virarem alicerce:

- **O sinal compartilhado do `fetchWithRetry`** (§1.1) é conclusão de leitura sobre semântica de `fetch` com sinal já abortado. Merece teste com controle positivo.
- **A duração real de um turno de LLM.** Os 2-5 s são comentário do próprio código, não medição.
