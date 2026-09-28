# Prompt para o chat da Fase D — CTWA: captura e persistência de `referral` e `ctwa_clid`

> Copie **tudo** abaixo da linha e cole como primeira mensagem num chat novo, na raiz do projeto
> `moralles-reservas`. Não resuma nem edite: o que parece redundante aqui foi aprendido errando.

---

Você vai implementar a **Fase D** da integração Datafy no `moralles-reservas`: **capturar e persistir o
`referral` de anúncio Click-to-WhatsApp (CTWA), incluindo o `ctwa_clid`, que hoje é jogado no lixo.**

## Antes de escrever qualquer código

Leia, nesta ordem:

1. `CLAUDE.md` inteiro — em especial as seções "Agente IA — WhatsApp", "Conversas — invariantes",
   "Banco de dados" (o modelo de tenancy e as invariantes de tabelas) e o checklist de redeploy em
   "Deploy".
2. `docs/superpowers/specs/2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md` — a auditoria que
   originou as Fases A–D. **O achado que a Fase D existe para resolver é o R2**, e a decisão de negócio que
   a delimita é a **nº 4** da tabela "Decisões de negócio".
3. `docs/superpowers/specs/2026-09-24-datafy-fase-c-ingestao-assincrona-design.md` — a fase que acabou de
   entrar, inclusive a §9.1 ("Emendas de execução") e a §16 ("Pendências de validação real"). A Fase D
   pendura trabalho no pipeline que ela construiu.
4. `docs/superpowers/prompts/fase-c-ingestao-assincrona.md` — o prompt da fase anterior. Não para repetir o
   trabalho, mas porque as duas listas de invariantes e o método ("procure por consequência, não por
   forma") valem igual aqui.

**Siga o fluxo obrigatório do projeto**, que o `CLAUDE.md` descreve e que não é negociável para mudança
estrutural: `superpowers:brainstorming` → spec em `docs/superpowers/specs/` → `superpowers:writing-plans`
→ plano em `docs/superpowers/plans/` → `superpowers:subagent-driven-development`. Antes de executar,
classifique com `ai-router-br:route`. Antes de mergear, rode os gates `saas-shield-br:*` que se aplicarem
(esta fase cria tabela e toca o parser de webhook: no mínimo `migration-validator`, `rls-auditor`,
`tenant-isolation-auditor` e `integration-reliability-auditor`).

**Crie uma branch e worktree separadas** — há outras frentes ativas em `.claude/worktrees/`, e você não
deve tocar em nenhuma delas.

## O problema, em uma frase

Quando um cliente clica num anúncio Click-to-WhatsApp e manda a primeira mensagem, a Meta entrega junto um
objeto `referral` com o `ctwa_clid` (o identificador do clique) — e o nosso parser o **descarta antes de
qualquer persistência**. O dado não volta depois.

## Por que o dado não volta — confirme você mesmo antes de desenhar

Não aceite os números e caminhos abaixo de mim. Abra os arquivos, confirme, e **me diga se bate** — se não
bater, o desenho muda e eu quero saber antes de você escrever uma linha.

O que eu medi nesta branch, e que você precisa reconfirmar:

- **`parseOfficialInbound`** vive em
  `supabase/functions/_shared/whatsapp-provider-core.ts:551`. A primeira coisa que ele faz é:

  ```ts
  if (!msgObj || msgObj.type !== "text") return null;
  ```

  Ou seja: **tudo que não é `type === "text"` morre ali**, inteiro, antes de qualquer gravação. Um clique
  de anúncio que chegue como imagem, vídeo ou qualquer tipo não-texto não deixa rastro nenhum.

- **Para mensagem de texto, o `referral` NÃO está perdido — está invisível.** O parser devolve
  `raw: p`, onde `p` é o **corpo inteiro** do POST (linha 567). Então o `referral` é alcançável no call
  site em `raw.entry[0].changes[0].value.messages[0].referral`. O que não existe é campo no contrato e
  ninguém que o leia. Isso muda o custo da fase: para o caso de texto, a Fase D é "extrair para o contrato
  e persistir", não "reconstruir o parser".

- **O contrato `InboundMessage`** está em `whatsapp-provider-core.ts:81-90` e tem sete campos
  (`providerMessageId`, `fromPhone`, `text`, `isFromMe`, `timestamp`, `contactName?`, `raw`). Acrescentar
  campo ali mexe no contrato **compartilhado pelos cinco providers**.

- **`datafy` e `official` usam o MESMO parser.** Em `whatsapp-providers.ts`, tanto o adapter `official`
  (linha 551) quanto o `datafy` (linha 588) registram `parseInbound: parseOfficialInbound`. Mexer nesse
  parser mexe nos dois — não existe "só para a Datafy" sem uma decisão explícita.

- **A capability já existe e já diz `true`.** Em `PROVIDER_CAPABILITIES`,
  `adReferral` é `true` para `official` (linha 344) e `datafy` (linha 379), e `false` para `zapi`, `waha` e
  `uazapi`. Ela foi declarada na Fase A com o comentário "a captura chega na Fase D". **A capability
  afirma uma coisa que o código não faz** — é essa mentira que você vai desfazer, e ela é o motivo de não
  haver nada a decidir sobre capabilities nesta fase.

- **Um POST da Meta pode trazer mensagens de clientes DIFERENTES.** Por isso o handler chama
  `splitMetaWebhookPayload` (`_shared/whatsapp-meta-batch-core.ts`) e só então processa cada parte. O
  `referral` é **por mensagem**, não por POST — capturar uma vez por requisição atribui o anúncio de um
  cliente a outro.

## O que a Fase D precisa entregar

**Capturar o `referral` (com o `ctwa_clid`) do inbound e persistir como touchpoint de atribuição, sem
nunca sobrescrever um touchpoint anterior.**

O que **não** está decidido, e é o que você vai desenhar no brainstorming:

- **De quem é o touchpoint: da unidade ou da organização?** Esta é a decisão mais consequente da fase e o
  `CLAUDE.md` não a responde por você. O modelo é `organizations → units → unit_members`; `customers`
  pertencem à **organização** (o cliente reserva em qualquer unidade da rede), e **todas as outras tabelas
  de negócio levam `unit_id`**. Um clique de anúncio chega num canal, que é de uma unidade — mas o cliente
  é da organização. As duas escolhas têm consequência real: por unidade, o mesmo cliente que clicou num
  anúncio da unidade A e depois falou com a unidade B tem dois históricos separados; por organização, o
  relatório da unidade A passa a mostrar atribuição gerada pela B. Decida, escreva o porquê na spec, e
  repare que a consulta da Fase I (Meta CAPI) vai depender dessa escolha.

- **O que exatamente se persiste do `referral`.** A Meta documenta vários campos além do `ctwa_clid`
  (origem, título e corpo do anúncio, tipo de mídia, URL de origem). Nem todos são iguais em risco: o
  `ctwa_clid` é identificador de clique ligado a uma pessoa. **Trate a lista de campos como pergunta de
  privacidade e retenção, não só de schema** — e veja a nota sobre medição de envelope mais abaixo antes de
  gravar campo que você só viu na documentação.

- **O que fazer com o clique não-texto.** Hoje ele morre no `return null` do parser. Registrar o
  touchpoint mas não responder ao cliente é um comportamento; responder pelo caminho de mídia
  (`MEDIA_REPLY_TEXT`, que já existe) é outro. **Não invente um terceiro caminho de inbound** — o projeto
  já tem `peekInboundMedia()` justamente para o que o parser recusa, e ele roda antes do
  `finish("ignored_non_text")`. Estude-o antes de desenhar.

- **Como o touchpoint aparece para o lojista, se aparecer.** A decisão nº 4 diz "preservar o dado desde
  já"; ela **não** diz "construir relatório de atribuição agora". Se você propuser UI, justifique — e
  repare que atribuição sem anúncio rodando não tem nada para mostrar.

- **Se há backfill, e a partir de onde.** Leia a seção "Estado do sistema" abaixo antes de assumir que o
  passado está disponível. Ele não está.

## Invariantes que NÃO podem ser quebrados

Estes estão no `CLAUDE.md` e valem como critério de aceite. Leia cada um na fonte antes de desenhar:

- **Touchpoint NUNCA é sobrescrito.** É o invariante de atribuição da spec original: um cliente pode
  chegar por vários anúncios ao longo do tempo, e **o histórico é o dado**. O `update` que "atualiza o
  último anúncio" apaga exatamente a informação que a fase existe para guardar. O projeto já tem dois
  idiomas para isso e nenhum deles é `update`: append em array (`customers.emails[]`) e tabela-ledger
  (`whatsapp_instance_notes`, `ai_budget_milestones`). Se usar unique parcial para deduplicar reentrega,
  trate `23505` como dedupe silencioso — é o padrão do repo, escrito na invariante de `vouchers`.
- **Tabela nova com credencial ou dado sensível nasce `FORCE RLS` sem policies, com `unit_id`** (ou o
  escopo que você decidir, explicitamente), e a UI só a alcança por Edge Function. A separação entre
  clientes passa a depender **inteiramente** do `.eq(...)` no código — é assim que
  `whatsapp_channels`, `processed_messages`, `webhook_executions` e a `whatsapp_inbound_events` da Fase C
  funcionam.
- **`UPDATE` do supabase-js que casa ZERO linhas devolve `error: null`.** Escrita com predicado de tenant
  precisa de `.select()` e conferência do tamanho do retorno, senão "o predicado negou" fica
  indistinguível de "gravei".
- **O canal é resolvido pelo `channel` da querystring + `SELECT`, nunca pelo corpo do payload** — e o
  `phone_number_id` do payload é conferido contra o do canal (`metaPayloadMatchesChannel`). É isso que faz
  a guarda anti-cross-tenant valer alguma coisa. Um `referral` vem dentro do payload: ele é **dado do
  cliente**, nunca fonte de identidade de tenant.
- **Migration é idempotente por design, aplicada SEMPRE por `supabase db push`**, nunca colada no Studio.
  Função SQL nova em `public` **nasce executável por `anon`** pelo grant implícito do `CREATE FUNCTION`:
  revogue com a **assinatura completa** de `public, anon, authenticated` e só então conceda ao papel
  mínimo. Confira o check `acl-estatico` na aba Checks do PR.
- **Coluna nova em `units`/`organizations` nasce invisível para `anon`** — o grant é por COLUNA
  (migration 086), e policy `TO anon` filtra LINHA, não coluna.
- **Coluna JSONB nunca é interpolada direto em template literal.** O supabase-js devolve `jsonb` como
  objeto e `${obj}` vira `"[object Object]"`. Se o `referral` for gravado como JSONB e algum dia chegar ao
  prompt do agente, isso vale.
- **`_shared/` não compartilha bundle em runtime.** Mexer em `whatsapp-provider-core.ts` exige redeploy
  das **NOVE** EFs que o alcançam: `webhook-whatsapp`, `send-whatsapp`, `send-confirmation`,
  `send-cancellation`, `send-manual-message`, `manage-channels`, `whatsapp-health`,
  `manage-organizations`, `process-whatsapp-channel-health`. Redeploy parcial deixa parser e envio
  divergentes entre si. **Atualize o checklist de redeploy do `CLAUDE.md` E do `AGENTS.md` no mesmo
  commit** se você criar arquivo novo em `_shared/` — os dois são par obrigatório e sincronizado.

## O que esta fase deliberadamente NÃO faz

- **Não envia nada para a Conversions API da Meta.** Isso é a **Fase I**, que depende desta e está fora do
  escopo desta entrega. A decisão nº 4 é explícita: *"a Conversions API fica para quando houver anúncio
  real — não se inventa atribuição sem evidência."* Captura e persistência agora; envio e deduplicação de
  evento depois.
- **Não altera o comportamento dos providers legados de forma observável.** Z-API e UazAPI estão em
  produção com loja real (Ren Sushi) atendendo **agora**. Eles não declaram `adReferral` e não devem
  ganhar caminho novo. Cuidado específico desta fase: o parser que você vai mexer é **compartilhado com o
  `official`** — se o desenho mudar o caminho dele, isso precisa ser decisão explícita e justificada na
  spec, não efeito colateral.
- **Não implementa mídia** (Fase E), **templates** (F), **janela de atendimento** (G), **campanhas** (H)
  nem **painel de custo** (J).
- **Não constrói relatório de atribuição** a menos que você o justifique e eu aprove.

## Estado do sistema quando você começar

**Fases A, B e C estão entregues nesta ordem; a D fecha a entrega A–D.**

- **A e B em produção:** provider `datafy` registrado no registry, assinatura `whsec_` própria sobre
  `{timestamp}.{corpo}` com anti-replay, migration 110 aplicada, canal criável pelo painel com descoberta
  automática de `phone_number_id` pelo `/me`.
- **Nenhum canal Datafy existe ainda, e nenhum pode ser ativado:** o trigger de paridade exige
  `manual_echo_verified_at`, cuja única fonte para provider Meta-shaped é o eco de aparelho via
  `message_echoes[]`, que só existe em Coexistence. Isso é paridade com o `official` e **não é problema
  seu**.
- **C entregou a ingestão assíncrona:** tabela `whatsapp_inbound_events` (FORCE RLS sem policies, com
  `unit_id`, `raw_body` em **`bytea`** para não perder byte nem recusar `\u0000`), claim cercado por UUID
  com takeover de lease de 90 s, `EdgeRuntime.waitUntil` para o trabalho pesado, varredura de recuperação
  por `pg_cron` (`?sweep=1`), dead letter com contagem no painel de diagnóstico, e prazo suave no laço do
  agente. Migrations **111 a 114**. A próxima livre é a **115**.

- **As migrations 111–114 estão MERGEADAS em `main`, mas NÃO foram aplicadas a banco nenhum, e o
  `webhook-whatsapp` NÃO foi deployado.** Isso tem consequência direta para você: `supabase db push`
  aplica **tudo que está pendente**, então empurrar a sua 115 aplicaria as quatro juntas — inclusive a
  114, que agenda um `pg_cron` a cada minuto contra um webhook que pode ainda estar na versão antiga.
  Antes de qualquer `db push` seu, confirme com o dono se a Fase C já foi aplicada; se não foi, a ordem
  dela vem primeiro (`db push` → `select cron.unschedule('whatsapp-inbound-sweep');` → deploy do
  `webhook-whatsapp` → exercitar `?sweep=1` à mão → reagendar → conferir em `net._http_response`), e
  **inverter o `db push` e o deploy quebra loja viva**: o gate leria coluna inexistente, o PostgREST
  devolveria 400 no SELECT do canal e o webhook responderia 503 a todo inbound de TODO canal, Z-API e
  UazAPI inclusive.

**Três consequências da Fase C que você precisa saber antes de desenhar, e que contradizem premissas
escritas em documento:**

1. **O gate assíncrono embarca DESLIGADO nas duas pernas** — flag global `platform_flags` mais a coluna
   `whatsapp_channels.async_ingestion_enabled` (`not null default false`). Com ele OFF, o inbound é
   processado no caminho síncrono de sempre e **nada é inserido em `whatsapp_inbound_events`**.
2. **Logo, a premissa "a Fase C preserva o payload bruto" é FALSA hoje, para todo canal.** A spec de
   auditoria a escreve na seção de premissas (ao falar de mídia na Fase E) e ela só passa a valer para
   canal com o gate ON. Enquanto ninguém ligar o gate, **não existe backfill possível**: o corpo cru não
   está guardado em lugar nenhum.
3. **E quando o gate estiver ON, o corpo cru é TRANSITÓRIO.** A purga apaga `status='done'` depois de
   **7 dias** e `status='dead'` depois de **30** (constantes `PURGE_DONE_AFTER_DAYS`/
   `PURGE_DEAD_AFTER_DAYS` no núcleo, gêmeas declaradas do SQL da migration 113). A fila é buffer de
   trânsito, não arquivo. **Extraia o `referral` no momento do processamento e grave no seu próprio
   lugar**; contar com a fila como fonte permanente é perder o dado em sete dias sem nenhum erro visível.

- **Nada foi exercitado contra a Datafy real — não há credencial.** A spec da Fase C carrega o aviso
  **VALIDAÇÃO REAL COM PROVIDER PENDENTE** e sete itens abertos (cinco da Fase 0, dois novos). **Se você
  também não tiver credencial, NÃO declare a fase validada:** marque a pendência do mesmo jeito, e
  acrescente a sua — porque a forma exata do `referral` da Datafy, que é proxy da Cloud API, é
  precisamente o que não se pode confirmar sem tráfego real.

## Três coisas que este projeto aprendeu errando, e que você deve herdar

1. **Envelope de provider se MEDE, não se deduz da documentação.** Há um incidente registrado no repo em
   que o formato real de um provider divergia da doc e a suíte ficou **verde por 14 dias** exercitando uma
   forma inventada — 100% dos recibos escorriam para o parser errado. Esta fase é a mais exposta a esse
   erro de toda a entrega, porque o `referral` é o único campo que você **não** pode ver chegar: não há
   anúncio rodando. Instrumente **forma** — nome de campo e `typeof`, pela disciplina de
   `_shared/webhook-payload-shape-core.ts` (`shapeOf`) — e **nunca valor**, que vazaria telefone de
   cliente e credencial para o log. A folha devolver `typeof value` em vez de `value` é a garantia; trocar
   por `String(value)`, que é a "melhoria" de quem está depurando, publica o dado sem erro de tipo nem
   aviso de lint.
2. **Procure por consequência, não por forma.** Nas Fases A–B, três varreduras subestimaram o escopo
   porque buscavam o que *mencionava* um nome de provider, e o que estava errado eram `else`, defaults e
   lookups por capability — invisíveis a `grep` por nome. Ao mapear o que a Fase D alcança, pergunte "o
   que decide se este dado sobrevive?" e não "o que cita `referral`?".
3. **Caso novo entra com controle positivo.** Reintroduzir o defeito e ver o teste ficar **vermelho** é o
   que separa "a guarda funciona" de "o teste não testa nada" — e é assim que se verifica, não relendo o
   arquivo. Comportamento de trigger, CHECK, FK e idempotência de migration se verifica no harness de
   `supabase/tests/local-preflight/` (Postgres local descartável, sem Docker); ele **não** prova RLS,
   grants, ACL nem PostgREST.

## Quando terminar

**A Fase D fecha a entrega A–D** (decisão nº 2 da spec de auditoria). Não há prompt de próxima fase a
produzir: as Fases E–J estão fora deste escopo e cada uma exige decisão de negócio que ainda não foi
tomada.

Em vez disso, entregue ao dono um **relatório de fechamento** que diga, sem enfeite:

- o que as quatro fases entregaram, e o que de cada uma segue **não validado contra provider real**,
  consolidando os itens abertos das Fases 0, C e D numa lista só;
- o procedimento de aplicação em produção na ordem correta, com os redeploys **medidos** (não os que o
  plano supôs) e o aviso de qual inversão quebra loja viva;
- o estado dos gates (`npm run test`, `npm run typecheck`, `npm run lint`, pré-voo local, agentes
  `saas-shield-br:*`, check `acl-estatico`);
- e o que **falta para a Fase I (Meta CAPI)** poder começar — em particular se a decisão de escopo do
  touchpoint (unidade vs organização) fecha ou abre pergunta para ela.

## Primeira coisa a fazer neste chat

Não comece pelo código. Comece confirmando por leitura os caminhos e números que eu afirmei acima — em
especial (a) que o `return null` do `parseOfficialInbound` descarta todo tipo não-texto, (b) que o `raw`
devolvido é o corpo **inteiro** do POST e não um recorte, (c) que `official` e `datafy` compartilham esse
parser, e (d) que a purga da Fase C apaga o corpo cru em 7 dias. **Me diga se bate.** Se algum não bater,
o desenho muda e eu quero saber antes.
