# Task 1 — mapa causal do corte legado → gerenciado

Estado: reprodução local concluída; **gate de exclusividade continua vermelho**. Base examinada: `0b3cd01`, branch `codex/whatsapp-template-versioned-dispatch`. Escopo aprovado na [spec](specs/2026-10-19-whatsapp-legacy-managed-cutover-dedup-design.md) e no [plano](plans/2026-10-19-whatsapp-legacy-managed-cutover-dedup.md). Nenhuma leitura ou alteração de produção, navegador, segredo ou provider real foi feita nesta task.

Correção após quality review P2: o cenário misto inicial de confirmação foi **descartado como prova causal**. Ele herdava `adopted_at=01/10` do fixture e combinava esse snapshot retroativo com outbox/primeiro POST em 05/10. Uma adoção real posterior ao outbox faz a confirmação gerenciada recusar `producer_before_adoption`; não se deve enfraquecer esse cutoff. O controle misto válido abaixo usa o cron real de lembrete, com origem de nova produção derivada de `now` após a adoção. Relógios de ambos os isolates e timestamp de adoção são explícitos, substituindo o timestamp fixo somente na fronteira de I/O. Um controle positivo adicional preserva o cutoff correto da confirmação.

## 1. A causa e a fronteira de envio

O legado escolhe a rota por leituras e depois envia. Sua evidência em `notifications_sent` nasce após o POST; o índice único protege a linha de projeção, não o efeito externo. Duas invocações podem passar pela ausência da mesma linha, e uma falha ao persistir o aceite conserva essa ausência. O `recordNotification` de confirmação e o de `send-whatsapp` fazem insert e, no conflito 23505, update/reset da projeção; esse conflito chega depois dos dois possíveis POSTs.

O roteador `_shared/whatsapp-automation-producer-routing.ts:16` lê primeiro job existente; sem job, lê adoção, flag e binding em paralelo (`:35`). Não adquire posse do fato. Adoção persistente impede retorno normal ao legado nas próximas leituras, mas não cancela uma invocação que já escolheu `legacy`.

Últimas fronteiras atuais:

- Legado: `_shared/whatsapp-channel-service.ts:341` resolve credencial/conexão; `:372` executa o callback síncrono opcional `beforeOutbound`; `:378` chama `deps.sendOutbound`. Os produtores desta task não passam um fence durável de fato nesse callback. `_shared/whatsapp-providers.ts:682` delega ao adapter; o fake dos testes está no `fetch` real desse adapter.
- Gerenciado: `_shared/whatsapp-automation-dispatch.ts:197` chama `confirm_whatsapp_automation_resource_post` como último `await`; `:202` chama `channel.sendTemplate`/`sendText`. Esse fence protege o job gerenciado; atualmente não existe marcador comum também adquirido pelo legado.
- Retry dentro do adapter também cruza HTTP: `whatsapp-providers.ts:365` usa zero retries apenas com `retryPolicy:'none'`; sem essa opção, usa três retries adicionais. `_shared/retry.ts:16` repete em rede/5xx/429. O canal gerenciado já usa `retryPolicy:'none'` (`whatsapp-channel-service.ts:671`); os oito caminhos legados não passam essa opção. O guard novo precisa impedir repetição interna ambígua para esses fatos, preservando os envios de chat fora do escopo.

## 2. Os oito kinds

Cada linha descreve um fato por recurso e kind, independente de canal/provider/versão. Confirmação com desconto usa a mesma finalidade `confirmation`.

| Kind / identidade real | Produtor e entrada | Seleção e última chamada legada | Escrita após POST / caminhos que repetem |
| --- | --- | --- | --- |
| `confirmation` / `reservations.id` | `enqueue_confirmation_after_insert` → `notification_outbox` → cron `process-notification-outbox`; chamada interna `send-confirmation` | Worker seleciona/claim outbox (`process-notification-outbox/index.ts:191`), lê rota (`:221`), consulta recibo em `stillValid` (`:145`); o handler relê rota (`send-confirmation/index.ts:367`) e chama `sendWhatsApp` (`:440`) | `recordNotification` em `:478`, implementado em `:191`; falha não transforma aceite em prova durável. Reentrada de outbox/retentativa do encaminhamento, duas invocações internas e `resend_whatsapp_only` (`:395`) podem repetir. Claim de uma linha outbox não cobre outra porta de entrada para o mesmo fato. |
| `reminder_d1` / `reservations.id` | Cron `process-reservation-reminders` → `get_reservations_for_reminder(hoje, unit)` | Rota em `process-reservation-reminders/index.ts:193`; legado encaminha a `send-whatsapp` (`:231`) com recurso e fato da reserva (`:244`); último HTTP via helper comum | `send-whatsapp/index.ts:317` envia e `:333` registra. RPC seletora exclui apenas `status='sent'`; seleções concorrentes e nova invocação após erro/failed continuam possíveis. |
| `survey_d1` / `reservations.id` | Cron `process-satisfaction-surveys` → `get_reservations_for_survey(ontem, unit)` | Rota em `process-satisfaction-surveys/index.ts:173`; legado encaminha a `send-whatsapp` (`:208`), com `reservation_id` e fato (`:223`) | Registro comum pós-POST. RPC seletora exclui apenas `sent`; ausência/failed e invocações concorrentes não são exclusão. A resposta/agradecimento à pesquisa recebida no webhook é outro efeito, fora desta task. |
| `waitlist_entered` / `waitlist.id` | Trigger `waitlist_dispatch_entered` → pg_net → `process-waitlist-entered` | Rota em `process-waitlist-entered/index.ts:96`; status/settings/TTL; legado encaminha a `send-whatsapp` (`:203`) com `waitlist_id` e `created_at` (`:217`) | Registro comum pós-POST; o handler não usa o índice de recibo como claim antes do send. Reentrega do encaminhamento, invocações concorrentes e reenvio por `resend-notification` são portas para o mesmo fato. |
| `waitlist_feedback` / `waitlist.id` | Cron `process-waitlist-feedback` → `get_waitlist_for_feedback(ontem, unit)` | Rota em `process-waitlist-feedback/index.ts:167`; legado encaminha a `send-whatsapp` (`:201`) com `waitlist_id` e fato (`:214`) | Registro comum pós-POST; RPC seletora exclui apenas `sent`. Sem posse comum, duas seleções e a transição de adoção podem alcançar as duas rotas. Consentimento/custo gerenciados continuam obrigatórios; esta task não autoriza marketing. |
| `voucher_issued` programado / `vouchers.id` | Cron `process-voucher-triggers`, regras `birthday`/`frequency`; `issueAndSend` (`:114`) | Leitura de adoção (`:132`); legado faz INSERT de voucher (`:172`) e encaminha a `send-whatsapp` (`:216`) | O INSERT legado não pede o ID criado; payload do send contém kind/fact_at, **sem `voucher_id`**. Registro comum não consegue associar o anúncio ao voucher real. Task 3 precisa capturar o ID do INSERT vencedor e propagá-lo; não derivar identidade de telefone/código/kind livre. Uma colisão de emissão protege benefício, não substitui o fence do envio. |
| `cancellation` / `reservations.id` | Operação autenticada via `useReservas.ts:303` → `send-cancellation` | Autorização pelo recurso; rota em `send-cancellation/index.ts:97`; relê detalhes/status; consulta apenas `notifications_sent.status` (`:154`); só `sent` suprime; `sendWhatsApp` em `:200` | UPSERT pós-POST (`:203`) não grava provider ID nesse caminho atual. Duas operações concorrentes ou repetição com `failed`/ausência podem enviar de novo. Outbox não executa cancellation (`process-notification-outbox/index.ts:92`), embora o enum antigo a inclua. |
| `waitlist_table_ready` / `waitlist.id` | Operação autenticada via `useWaitlist.ts:227` → `notify-waitlist-ready` | Rota em `notify-waitlist-ready/index.ts:34`; legado exige `waiting` e encaminha a `send-whatsapp` (`:84`) antes de atualizar status (`:93`) | Registro comum pós-POST; duas operações podem observar `waiting` e enviar antes do UPDATE vencedor. `resend-notification` também encaminha o mesmo kind por `send-whatsapp`. O fato server-owned gerenciado `notified_server_at` não dá posse ao legado em voo. |

Encaminhador compartilhado: `send-whatsapp/index.ts:44` aceita seis desses kinds (todos menos confirmação/cancelamento), valida titularidade de reserva/fila (`:251`) e TTL (`:290`), mas não adquire exclusão comum por fato. Sem recurso, o voucher programado atual contorna a verificação de titularidade específica; isso precisa ser fechado com o ID derivado da emissão, sem acrescentar tenant livre.

Reenvio compartilhado: `resend-notification/index.ts` autentica usuário/escopo; confirmação segue para `send-confirmation`; fila segue para `send-whatsapp` (`:238`). O roteamento gerenciado preserva job existente; a perna legada não tem fence durável comum. Não se deve criar uma terceira escada de retry na correção.

## 3. Cron, outbox, recibos e jobs

Inventário estático de agendamentos locais, sem afirmar estado do cron em produção:

| Entrada | Definição em migrations | Agendamento declarado |
| --- | --- | --- |
| Outbox | `20260507153701_029_outbox_cron.sql:56` | Cada minuto |
| Lembrete | `20260508211157_045_reservation_automation_cron.sql:83` | 13h UTC / 10h BRT |
| Pesquisa de reserva | Mesmo arquivo `:97` | 17h UTC / 14h BRT |
| Feedback de fila | `20260514181701_048_waitlist_automation.sql:218` | 17h UTC / 14h BRT |
| Voucher programado | `20260508161319_043_giftback_cron.sql:49` | 12h UTC / 9h BRT |
| Consumidor gerenciado | `20261009135808_whatsapp_automation_worker_cron.sql:626` | Cada minuto; não cria produtor promocional novo |

`notification_outbox` tem unicidade por reserva/kind (`20260507153453_028_notification_outbox.sql`), estado/attempts e escada própria antiga. O worker claim usa UPDATE com predicado `pending`; a exclusividade dessa linha não disputa o mesmo fato com o gerenciado ou com invocação direta. Delegação gerenciada, tokens iniciais e polling (`20261006003631_whatsapp_outbox_automation_delegation.sql`) continuam relevantes, mas não cercam POST legado já iniciado.

`notifications_sent` serve de projeção/evidência: confirmação/fila têm chave natural; erro 23505 depois do envio pode substituir o ID remoto anterior e zerar timestamps. `send-cancellation` não conserva o ID nessa projeção atual. Ausência de linha, ou uma linha única, não prova número de POSTs.

Callbacks: `webhook-whatsapp/index.ts:169` correlaciona `(unit_id, provider, channel_id, provider_message_id)`. Recibo `failed` grava `status='failed'` e `failed_at` sem apagar provider ID (`:207`). Logo a seletora que só exclui `sent` pode reconsiderar um envio aceito cuja entrega falhou. Recibos gerenciados têm ledger próprio (`record_whatsapp_automation_receipts` / `reconcile_whatsapp_automation_receipts`, migration `20261009135808`). Eles preservam evidência e não autorizam retry do mesmo fato por si.

Gerenciado: `enqueue_whatsapp_automation` vigente (`20261017120000_whatsapp_templates_table_ready_cancellation.sql:105`) faz advisory lock por unidade/kind/recurso (`:125`), procura job existente e exclui recibos `sent`/`delivered`/`read` (`:128`). Não cobre `failed`+ID remoto nem legado ainda sem recibo. `claim_whatsapp_automation` usa row lock do job e cerca o lease; `posting` vencido vira `uncertain` (`20261004184738:144`). Isso já protege reentrada do próprio job, sem exclusão com o legado.

## 4. Ordem atual de locks e ponto da mudança futura

Leitura estática das funções vigentes; **não é prova de ausência de deadlock**:

1. Enqueue: advisory lock do fato → evidência histórica/job → customer `FOR SHARE` quando presente → account → binding → channel → template → INSERT/job. Não existe mutex comum por unidade antes desse lock do fato.
2. Adoção administrativa: `release_whatsapp_template_channel` (`20261017203000:716`) resolve recurso → account `FOR SHARE` → binding `FOR UPDATE` → channel `FOR SHARE`; no enable, UPDATE do binding dispara `guard_whatsapp_template_scope`, que insere `whatsapp_automation_adoptions` (`:639`). A unidade não é travada previamente por todos os participantes; o trigger já é tarde para introduzir um mutex global na ordem.
3. Claim: job `FOR UPDATE`. Prepare/final confirm: `app_private.whatsapp_automation_post_core` vigente (`20261017140000:39`) descobre job sem lock → customer `FOR UPDATE` → account → bindings ordenados → channels ordenados → template → consent → slot promocional/custo → job `FOR UPDATE` → revalida recurso/fato/TTL/canal antes do resultado autorizado.
4. Finish/repair: preservam a ordem de pais antes do job. `finish_whatsapp_automation` promocional faz customer → slot → job (`20261004014032:222`). Repair (`20261017150000:5`) faz customer → slot quando aplicável → job → linha de notificação. Aceite com projeção faltante só deve reparar; não repetir provider.
5. Legado: SELECTs de rota/recurso e UPDATEs/INSERTs de projeção em transações separadas; nenhum claim de fato sobrevive até o HTTP. O futuro mutex unidade→fato deve entrar no início dos entrypoints SQL participantes, antes desses locks já existentes, conforme a spec; não acrescentá-lo apenas no trigger de binding.

## 5. Boundary do voucher e exclusões

O `kind='voucher_issued'` também aparece em `webhook-whatsapp/index.ts:1366`, no benefício após avaliação. Esse fluxo usa regra `after_rating`, insere a notificação com `reservation_id`, prepara o texto/benefício do agradecimento e não é o anúncio programado birthday/frequency. ACK, feedback livre, chat IA e mensagem manual de operador continuam fora do delta aprovado; ações explícitas de cancellation/mesa pronta permanecem dentro. Não instalar guard no agradecimento pela mera igualdade do kind.

Não há tabela `whatsapp_voucher_automation_issuances` no código examinado. A autoridade real do voucher programado gerenciado é `issue_scheduled_whatsapp_voucher` (`20261009003452_whatsapp_scheduled_voucher_issuer.sql:5`): regra só birthday/frequency (`:42`), INSERT novo vencedor (`:69`), enqueue atômico com `voucher_id` e `source_event_key=voucher.id` (`:75`), sem recuperar vencedor histórico. O loader (`whatsapp-automation-resources.ts:263`) e o SQL final (`20261017140000:230`) recusam rule `after_rating`. Portanto não foi comprovada sobreposição do mesmo voucher after_rating com o gerenciado sob esse contrato; a discriminação por origem/recurso precisa permanecer explícita.

## 6. Evidência executável Task 1

Arquivos novos:

- `src/lib/whatsapp-cutover-dedup.test.ts`.
- `src/test/fixtures/whatsapp-cutover-dedup-fixture.ts`, reutilizando `edge-request-harness.ts` e `whatsapp-automation-fixtures.ts` sem alterá-los.

Comando executado: `npx vitest run src/lib/whatsapp-cutover-dedup.test.ts --reporter=verbose`. Resultado corrigido: **3 PASS e 4 RED intencionais**, exit 1, sete testes; nenhum skip/`.fails`.

| Controle | Evidência antes do assert de exclusividade | Resultado no predecessor |
| --- | --- | --- |
| Fato novo elegível | Handler real, 1 POST, 1 aceite, 1 recibo com o mesmo provider ID; ordem aceite → INSERT | PASS |
| Aceite legado persistido → outbox | Worker real vê recibo e marca `expired:already_sent`; nenhuma segunda chamada provider | PASS |
| Duas invocações legadas | Dois isolates carregam handler real, compartilham I/O; primeiro `fetch` suspenso por barreira e ainda sem recibo; segundo cruza provider | RED: 2 POSTs, esperado ≤1 |
| Lembrete legado em voo → adoção causal → novo cron gerenciado | Primeiro cron real chega ao `fetch` de `send-whatsapp` às 15:00:00Z, sem recibo; adoção externa fornecida às 15:00:01Z; segundo cron roda às 15:00:02Z. A origem gerenciada é `now` do novo produtor, não a data de criação do outbox. A reserva de hoje permanece elegível e o managed alcança o adapter real | RED: 2 POSTs, esperado ≤1 |
| Confirmação anterior à adoção causal | Outbox/primeiro POST às 15:00:00Z; adoção às 15:00:01Z; enqueue real às 15:00:02Z retorna `producer_before_adoption` antes da RPC de enqueue | PASS: 1 POST legado, nenhum POST gerenciado |
| Aceite → falha ao persistir → reentrada outbox | Primeiro provider aceita, INSERT devolve erro 08006, handler responde sucesso; worker real encontra ausência e encaminha de novo | RED: 2 POSTs, esperado ≤1 |
| `failed` histórico com ID remoto | Recibo sintético conserva ID aceito; handler real aceita proveniência `resend_whatsapp_only`, sem ler o ID na projeção atual | RED: 1 POST novo, esperado 0 |

As falhas são exatamente os asserts de quantidade de POSTs; verificações anteriores de HTTP, causalidade temporal e I/O fechado passaram. Os caminhos de enqueue/confirm descrevem o predecessor, não uma obrigação de alcançar o caminho inseguro na correção. Recusa fechada antecipada (200/202 com supressão, 409 ou 503) é permitida nos cenários negativos, conservando o assert de no máximo um POST. As barreiras são promessas explícitas, sem depender de atraso aleatório. Nenhum provider foi simulado como chamada interna: os encaminhamentos usam handlers reais e os adapters usam `fetch` externo substituído apenas no transporte final. O fixture não guarda corpo/telefone em seus eventos de observação.

Verificações adicionais: `npm run typecheck`, ESLint apenas dos dois arquivos TypeScript novos e `git diff --check` passaram. Não foi executada suíte completa, pois os quatro REDs são gate deliberadamente aberto para Tasks 2–4.

## 7. Limites e provas ainda obrigatórias

- Os testes executam JS dos `index.ts`/núcleos reais, mas os RPCs de automação vêm do fixture existente. O snapshot adotado é uma entrada de I/O fornecida: **não executa nem prova autorização/serialização da adoção SQL**. Dois isolates de EF não são duas sessões PostgreSQL.
- O mapa cobre oito kinds; a reprodução dinâmica nova cobre confirmação (inclusive outbox/reenvio/cutoff) e lembrete por cron real. Não declarar os outros seis, versões v1/v2, provider Datafy real, crash/lease ou isolamento SQL como provados por sete testes.
- Task 2 deve provar em PostgreSQL descartável duas sessões/barreiras reais, ordem unidade→fato, ACL/RLS/tenant, recurso falso, drift, failed+ID, aceite sem projeção, incerteza ativa versus aceite terminal, deadlock e erro de leitura. Task 3 precisa instrumentar todos os produtores/encaminhadores e desabilitar retry de transporte ambíguo para os oito fatos; Task 4 precisa ampliar a matriz por kind/versão.
- SQL novo sem todos os bundles guardados e sem prova de drenagem de instâncias antigas continua incompatível com ativar dispatch. Tempo decorrido, ausência de recibo/job e uma única linha em Entregas não comprovam exclusividade.
- Reviews concluídos: implementer `template_v2_ui_impl`; spec `template_v2_task3_map` e ROOT no assert condicional final; qualidade `template_v2_integration_quality`, que reexecutou os sete controles e deu PASS após a correção temporal. O ROOT aceitou a Task 1 e marcou apenas seu inventário/reprodução/reviews no plano; exclusividade integrada e concorrência SQL seguem pendentes. Nenhum commit, push, merge, deploy, banco de produção ou mensagem paga ocorreu nesta task.
