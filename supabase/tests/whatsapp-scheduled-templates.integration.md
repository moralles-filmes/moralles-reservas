# Verificação local de templates programados

Este roteiro usa exclusivamente a stack local `moralles-templates-20261003`, API
`127.0.0.1:55451`, banco `55452` e Vite `127.0.0.1:8080`. A execução exige revisão
das seis fontes, gates SQL/JWT e concorrência, e quarentena de cron conferida pelo
controlador principal. O launcher não aplica migrations nem restaura cron.

## Fronteiras da prova

| Camada | Exercício | Limite |
| --- | --- | --- |
| App | App, AuthProvider, BillingGuard, páginas e hooks reais; SDK real com sessão GoTrue | Armazenamento apenas em memória; persistência entre reloads não é coberta |
| HTTP local | Três encaminhamentos fixos para gestão, preferências e reenvio; método, corpo, JWT e resposta preservados | Sem gateway Edge servido, TLS ou cabeçalhos hospedados |
| Request | Índices reais no harness existente; preferências pela factory real | Registro `Deno.serve` não abre listener Deno; origem HTTP é dependência exclusiva do teste |
| SQL | PostgREST, JWT, RLS selecionada, RPCs e ledger reais | Paridade temporária cobre consultas selecionadas, não toda a plataforma |
| Provider | Respostas sintéticas fechadas de Z-API; callback processado pelo handler real | Aceitação e persistência locais; nenhuma homologação ou mensagem externa |
| Realtime | Tentativa real ao serviço local ausente, contada separadamente | Sem evento `SUBSCRIBED` fabricado e sem prova de Realtime funcional |

A seleção de aniversariantes é uma pré-condição sintética deste roteiro. A
emissão atômica de voucher/job usa a RPC real. Testes Request dos produtores
complementam essa fronteira e não devem ser rotulados como execução nativa do
worker de aniversários. Gates 36/37 cobrem separadamente clientes anon,
authenticated, service role e concorrência; o roteiro não soma esses resultados
às verificações próprias.

## Rastreabilidade da spec §11

Nesta matriz, `S/` significa
`.superpowers/sdd/2026-10-03-whatsapp-templates-programados/` e `P/` significa
`supabase/tests/local-preflight/`. Os relatórios anteriores indexam as evidências
de cada tarefa; um relatório de autoria que ainda registra preocupação não é,
isoladamente, aprovação independente. Esta matriz não reexecuta nem reclassifica
os gates históricos. A aprovação consolidada e os resultados finais Task15 ficam
com o controlador principal.

| Grupo da spec §11 | Tarefas | Testes/gates concretos | Evidência histórica e limite |
| --- | --- | --- | --- |
| Catálogo, kinds, variáveis e renderização | 1 | `src/lib/whatsapp-template-catalog-core.test.ts` | `S/task-1-report.md`; núcleo puro, sem provider |
| Autoridade, tenant, claims, preferências e gestão | 3/4/5/13 | `P/26-template-catalog.sql`, `27-template-claims.sql`, `28-template-concurrency.sh`, `29-template-preferences.sql`, `30-template-preferences-concurrency.sh`, `57-template-management.sql`, `58-template-management-concurrency.sh`, `59-template-management-jwt.mjs` | `S/task-3-report.md`, `task-4-report.md`, `task-5-report.md`, `task-13-report.md`; SQL SET ROLE e JWT são camadas distintas |
| Registry e provisionamento | 2/6 | `src/lib/whatsapp-template-provider-core.test.ts`, `whatsapp-template-account.test.ts`, `whatsapp-template-worker.test.ts`; `P/31-template-workers.sql`, `32-template-workers-concurrency.sh` | `S/task-2-report.md`, `task-6-report.md`, `task-6-re-review-1.md`; respostas de provider sintéticas |
| Webhook, identidade e eventos | 7 | `src/lib/whatsapp-template-events-core.test.ts`; `P/33-template-event-authority.sql`, `34-template-event-authority-concurrency.sh` | `S/task-7-report.md`, `task-7-re-review-1.md`; não homologação de provider |
| Envio, gates de recurso, aceitação e recibos | 8/9/12 | `src/lib/whatsapp-template-channel-routing.test.ts`, `whatsapp-automation-dispatch.test.ts`, `whatsapp-automation-receipts-request.test.ts`; `P/35-automation-dispatch-prerequisites.sql`, `36-automation-dispatch-prerequisites-concurrency.sh`, `37-automation-dispatch-prerequisites-jwt.mjs`, `38-automation-acceptance-repair.sql`, `39-automation-acceptance-repair-concurrency.sh`, `40-automation-acceptance-repair-jwt.mjs`, `41-automation-resource-confirm.sql`, `42-automation-resource-confirm-concurrency.sh`, `43-automation-resource-confirm-jwt.mjs`, `53-automation-receipts-worker.sql`, `54-automation-receipts-concurrency.sh`, `55-automation-receipts-jwt.mjs` | `S/task-8-report.md`, `task-9a-report.md`, `task-9b-report.md`, `task-9c-report.md`, `task-12-report.md`; conclusões finais das revisões/ROOT prevalecem sobre checkpoints antigos |
| Outbox e produtores automáticos | 10/11 | `src/lib/edge-request-harness.test.ts`; `P/45-outbox-automation-delegation.sql`, `46-outbox-automation-delegation-concurrency.sh`, `47-outbox-automation-delegation-jwt.mjs`, `49-scheduled-voucher-issuer.sql`, `50-scheduled-voucher-issuer-concurrency.sh`, `51-scheduled-voucher-issuer-jwt.mjs` | `S/task-10-report.md`, `task-11-report.md`; seleção sintética desta história não substitui esses produtores |
| Atendimento preservado e pesquisa por tenant | 15 | `src/lib/whatsapp-scheduled-templates-integration.test.ts` (23 controles Request reais), `whatsapp-inbound-reentry.test.ts`, `whatsapp-survey-tenant-routing.test.ts`; harness Request real e controles de mutação | `S/task-15-request-independent-early-review.md`, `task-15-completion-author-report.md`, `task-15-completion-main153-focused.log`; último focused 33/33 não substitui full suite |
| Preferências públicas e opt-out | 5/9/14 | `src/lib/whatsapp-message-preferences-core.test.ts`, `whatsapp-message-preferences-handler.test.ts`, `src/pages/public/PreferenciasMensagens.test.tsx`; gates29/30/35–43 acima | `S/task-5-report.md`, `task-9b-report.md`, `task-14-report.md`, `task-15-main-browser-final.md`, `task-15-main-ui-persistence.json`; GET sem escrita, opt-out A e B preservado observados |
| UI real, papéis, finalidade e configuração | 14/15 | `src/components/whatsapp/OfficialAutomationTemplate.test.tsx`, `src/pages/gestao/whatsapp-template-surfaces.test.tsx`, `src/App.preference-route.test.tsx`; roteiro deste documento | `S/task-14-report.md`, `task-15-main-browser-final.md`, `task-15-main-ui-persistence.json`; história final real aprovada com limites e evidências parciais anteriores discriminados pelo ROOT |
| Rollout, auditorias finais, runbook e integração de branch | 16 | Gates e revisão previstos na Task16 do plano | **PENDENTE; não executar nesta conversa.** Próximo chat é dedicado somente à Task16 |

O attempt0 nativo Task15 falhou no seed por coluna ausente; seu cleanup foi
concluído, conforme `S/task-15-attempt0-runtime-evidence.md` e
`S/task-15-full-story-results-attempt0.json`. É evidência de falha recuperada, não
de integração verde. Novas tentativas devem manter resultados distintos.

MAIN153 adiciona temporariamente somente três colunas de canal e a tabela de
telemetria do callback, com ausência original e metadata dos canais verificadas
separadamente. MAIN154 acrescenta duas colunas de grandfathering na organização
e três tabelas vazias com as colunas efetivamente consultadas pelo gate de
serviço. Esse fixture mínimo não prova o schema completo nem as constraints de
billing. Somente as duas organizações próprias recebem grandfathering; o
controller observa sucesso das três leituras reais e ausência de overrides ou
assinaturas. O estado legacy resulta desses dados pelo núcleo real; nenhum DTO
de gate é substituído. A projeção de saúde é fresca e o relógio VM é fixo:
`syntheticProviderHealth === 0` confirma que consulta de saúde ao provider e sua
RPC não foram exercitadas. MAIN155 prepara somente `last_health_check_at` dos dois
canais sintéticos próprios antes de dispatch/reenvio e alinha o relógio de teste
ao timestamp SQL privado, com zero trabalho pendente. Isso é uma pré-condição de
fixture explicitamente contada, não comprovação de saúde do provider. O relógio
real do banco permanece intacto. Attempt3 demonstrou o controle negativo:
projeção vencida no SQL bloqueou B com `channel_unavailable`, sem POST externo ou
sintético; ROOT restaurou os sete grupos de estado após essa tentativa.

## Fontes e início controlado

As duas fontes versionadas são `whatsapp-scheduled-templates-local.mjs` e
`local-preflight/whatsapp-scheduled-templates-ui-testsetup.mjs`. As quatro fontes
de execução revisadas ficam em
`.superpowers/sdd/2026-10-03-whatsapp-templates-programados/`:

- `task-15-full-story-launch.mjs`;
- `task-15-full-story-vite.config.ts`;
- `task-15-full-story-client.ts`;
- `task-15-full-story-browser-proof.mjs`.

Essas fontes scratch fazem parte da revisão da execução; os dois arquivos
versionados isolados não são um runner portátil. O responsável pelo runtime
confere hashes, catálogo e a quarentena antes de invocar o launcher com Node,
sem argumentos e com stdin mantido aberto. Não reutilizar processo existente em
8080. Não iniciar com `npm run dev`, que usa configuração de ambiente diferente.

O controlador exige inventário exato dos sete containers próprios, pipe Linux,
portas, configuração, GoTrue, cron vazio, ausência de trabalho/resultado pg_net,
ausência dos nomes de worker no Vault e corpo conhecido do trigger. Adquire um
lease exclusivo antes de ler uma única vez o arquivo local de status guardado.
Chaves e senhas permanecem em closures. Valores `VITE_*` herdados são removidos
por nome antes da configuração, que usa um diretório vazio.

O endpoint de bootstrap aceita somente POST same-origin com corpo `{role}` de
até 256 bytes. Há uma operação por vez, no máximo 32 sucessos agregados e duração
máxima de uma hora. As sete identidades próprias usam login GoTrue; a variante
`public_preferences` entrega somente anon e duas capabilities próprias emitidas
por SQL. Não registrar resposta, sessão, token, hash, HAR ou URL de capability.

## Sequência da história

1. Após `TASK15_READY`, abrir apenas `http://127.0.0.1:8080`. Usar os botões de
   papéis; nunca injetar JWT nem fabricar contexto de autenticação. Executar o
   comando stdin `authority` uma vez: papéis reais, ausência de JWT, acesso
   estrangeiro/inexistente, contato alheio/removido, bind service-only, PT409
   limitado com zero efeito, reconciliação real e join/UPDATE de pesquisa.
2. Como owner/gerente, visitar reservas, fila e Giftback. Alterar um valor visível
   em cada fluxo pertinente, salvar, trocar de contexto e confirmar a leitura
   persistida. Conferir também a linha própria por consulta nativa limitada.
   Verificar operador, estrangeiro e admin sem membership pelos controles
   previstos; respostas negadas e botões ocultos são evidências distintas.
3. Visitar as três telas oficiais com `foreign_member`. Conferir os sete kinds,
   configuração oficial somente leitura e ausência de POST de provider. Registrar
   separadamente qualquer cenário de erro, flag desligada e finalidade selecionada
   efetivamente observado; contadores sozinhos não provam esses cenários.
4. Desmontar o contexto; enviar `billing_block`, entrar novamente como owner e
   observar o BillingGuard real bloqueando a tela. Desmontar, enviar
   `billing_restore`, entrar de novo e confirmar o retorno. O novo App cria o
   QueryClient real novamente, evitando reutilizar cache de outro ator.
5. Usar `Entrar public_preferences` e os botões `Preferência A/B`. A navegação
   constrói a URL em closure. Não passar essa URL ao CUA nem capturar barra de
   endereço ou HTML bruto. Cancelar A, repetir a operação e confirmar idempotência;
   B deve continuar opt-in. Não cancelar B antes do dispatch positivo.
6. Enviar `dispatch`: A já enfileirado deve ficar bloqueado sem POST; B deve aceitar
   exatamente uma resposta sintética e persistir o voucher original. Enviar
   `receipt` e conferir o recibo com os quatro campos de correlação. Entrar como
   admin e abrir Entregas da unidade irmã para observar a projeção real.
7. Em Entregas de A, usar o botão de reenvio existente da confirmação sintética.
   Conferir resultado real e ledger/notification próprios por SQL. A notification
   legacy failed seedada possui outro UUID na mesma chave natural: MAIN103 exige
   `accepted/reconcile_required` com conflito, preservando essa row. Não declarar
   confirmation reconciliada ou entregue; voucher B é o positivo separado de
   notification/recibo. Segunda tentativa deve ser recusada sem outro POST.
   Não inferir envio pelo clique/toast nem apagar legacy para fabricar resultado.
   Nenhum novo kind é criado. A análise está em
   `S/task-15-resend-conflict-source-audit.md`; o script read-only
   `S/task-15-main-ui-persistence-readonly.sql` distingue os dois controles.
8. Desmontar o contexto, usar `Atualizar prova segura` e enviar `verify`. Conferir
   erros inesperados de console/rede separadamente dos avisos React Router e da
   ausência esperada de Realtime. Contadores zero não substituem as provas de
   persistência e autorização acima.

Antes de aceitar o transporte, o responsável pelo runtime exercita recusas de
host/origem, método, Authorization/Cookie, X-Forwarded, query, JSON, alias,
oversize e body sem término. A resposta é constante, no-store e fecha a conexão
recusada. Conferir ainda ausência de acesso a scratch/segredos via Vite. Esses
negativos só são considerados aprovados após execução e evidência observada.
Os probes de arquivos usam somente um Markdown seguro próprio: incluir casing
Windows (`.SUPERPOWERS`), caminho `/@fs/` absoluto, separador backslash codificado,
encoding duplo e variantes do basename do client. Somente os dois caminhos
canônicos literais do client são exceções. Nunca usar um arquivo de segredo como
controle positivo de divulgação. A tentativa2 encontrou divulgação desse Markdown
por casing; seu cleanup foi concluído, mas os 18 negativos anteriores não cobriam
essa variante. O gate corrigido exige nova execução desses probes pelo ROOT.

## Encerramento e recuperação

Enviar `cleanup` por stdin. O launcher fecha seu servidor; o controlador drena
SDK e backgrounds, apaga somente fixtures próprias, restaura a flag preservando
existência e literal JSONB do Postgres, e restaura catálogo, ACLs, tipos/defaults,
nullabilidade, contagens e valores originais das três unidades. Valores originais
viajam como JSON UTF-8/base64 por stdin privado para uma instrução fixa; isso não
é binding nativo do protocolo PostgreSQL.

Falha de cleanup mantém o processo, o lease e os snapshots privados vivos para
correção e novo `cleanup`. Não matar o processo nem liberar cron nesse estado.
Diagnósticos mostram somente estágio fechado, código fechado e SQLSTATE.
Publicação de resultado que falha depois de restauração verificada é uma falha de
artefato distinta. Não sobrescrever resultado anterior silenciosamente.

Somente `TASK15_CLEANUP_VERIFIED` com comparações exatas, auditoria independente
das fixtures/sessões, servidor encerrado e gates posteriores permite ao
controlador principal restaurar cron. Os gates de compatibilidade do fixture
reduzido rodam novamente depois da restauração. O resultado do launcher não
declara automaticamente sucesso de browser, de todos os gates ou de produção.

Asserções e roteiro são infraestrutura de verificação. A existência destes
arquivos e checks sintáticos não prova que a história foi executada; o relatório
da execução deve identificar os passos realmente observados e os pendentes.

## Gates do checkout Task15

Resultados finais de compilação/testes comunicados pelo ROOT, com artefatos
próprios preservados. Eles não declaram automaticamente a história UI concluída.

| Gate | Resultado | Evidência em S/ |
| --- | --- | --- |
| Vitest completo | 106 arquivos, 2838 testes aprovados | `task-15-main-full-test-1791579626000.log` |
| Build | Exit 0 | `task-15-main-full-build-1791579629080.log` |
| Lint | Exit 0, zero erros, 22 warnings baseline | `task-15-main-full-lint-1791579628718.log` |
| Typecheck corrigido | `tsc -b --noEmit`, exit 0 | `task-15-completion-main153-typecheck.log` |
| Focused após fixture corrigida | 33/33, dois arquivos | `task-15-completion-main153-focused.log` |
| Deno real em cache | 38 entradas, exit 0 | `task-15-main-final-deno.log` |
| Matriz AST/imports | 36 consumidores + 2 entradas complementares | `task-15-final-import-matrix.json`, `task-15-final-import-matrix.md` |

O primeiro full typecheck encontrou a inferência da fixture estrangeira; o
resultado acima é a reexecução depois da correção explícita. Tentativas de
runtime anteriores preservam separadamente seus resultados: dependências de
schema ausentes, outbox duplicada, divulgação de Markdown seguro por casing e
frescor SQL expirado foram corrigidos ou delimitados após falhar. Cleanup foi
concluído pelo ROOT entre as tentativas.

## Resultado observado da história final

ROOT executou a história r6 com App/SDK/GoTrue/PostgREST reais. Os registros
`S/task-15-main-browser-final.md` e `S/task-15-main-ui-persistence.json` confirmam
os três saves, BillingGuard bloqueado, admin sem membership, GET público sem
escrita, opt-out A sem POST e aceitação única de voucher B. Para B, notification,
histórico canônico e recibo pelos quatro campos foram persistidos. Gerente,
recusa de operador e telas oficiais também foram observados na tentativa3;
essa evidência parcial permanece identificada como tal, sem transformar aquela
tentativa de dispatch em sucesso.

O reenvio real aceitou a confirmação original uma vez; dois cliques posteriores
não repetiram POST. `S/task-15-full-story-results.json` registra três Requests de
reenvio, dois POSTs sintéticos totais (voucher B e confirmação A), zero rede
externa, zero I/O inesperado e zero erro de transporte. O conflito legacy MAIN103
preserva a confirmação em `accepted/reconcile_required`, sem fabricar seu
histórico ou notification. Isso não representa entrega dessa confirmação.

Dois avisos do browser foram investigados mantendo o contador original. Uma
sessão nova de admin reproduziu ambos antes do reenvio; a origem foi a
normalização de dupla barra do React Router no breadcrumb herdado, cujo lookup
independente começa sem slug. Revisão independente conferiu os arquivos iguais
à baseline. Categoria fechada `router_double_slash`, unknown0, erros0,
uncaught0, unhandled0, egress0; nenhuma mensagem ou stack bruta foi retida.
`S/task-15-browser-proof-r6.json` preserva os contadores anteriores e o relatório
final discrimina o diagnóstico. Realtime ausente e saúde real do provider
continuam fora da prova.

O resultado final do controller registra `cleanup.restored`, igualdade de
metadata lógica/canais, ausência original de telemetry/billing, valores das
unidades e contagens preservadas, todos verdadeiros. A auditoria ROOT separada
`S/task-15-main-cleanup.json` confirmou catálogo original de 70 funções, 25
relações e 13 tipos, ausência de fixtures/usuários/sessões/lease próprios,
servidor encerrado, handlers drenados e ambas as flags false. O gate31 pós-restore
passou novamente 101 asserções (`S/task-15-main-native-31.log`).

`S/task-15-main-cron-restore-1791582384324.json` confirma restauração do único
worker ao schedule/comando originais, novo job45, sem fila/inflight/respostas ou
invocação do worker e com externalRequests0. A decisão de commit permanece com
ROOT. Task16 continua pendente para o próximo chat.
