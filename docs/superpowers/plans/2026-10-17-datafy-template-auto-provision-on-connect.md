# Plano — submissão automática dos nove modelos Datafy

**Spec:** [design aprovado](../specs/2026-10-17-datafy-template-auto-provision-on-connect-design.md), aprovado pelo responsável em 2026-10-17 para implementação. **Estado:** planejamento; nenhuma task de implementação marcada. Cada task com implementer, review independente de spec, review independente de qualidade; ROOT integra, executa gates e revisa branch inteira.

## Estado inicial e ordem

Em 2026-10-17, o projeto de produção Moralles Reservas `gbabxcrntkwgblgqsiit` tinha zero contas/bindings/jobs/templates e flags catálogo/dispatch OFF. Após autorização nominal do responsável para o catálogo e nove submissões da Ren Sushi, `whatsapp_template_catalog` foi ligado com guarda transacional de zero contas/bindings/jobs; `whatsapp_automation_dispatch` continuou OFF. A ação **Testar** do canal Datafy local `a368bea2-90aa-4d81-880e-6d962255c4b0` descobriu e vinculou a WABA pelo `/me`: binding `69247a84-4e7a-41dc-8fa2-c12947124218`, conta `b076c1f1-5307-4f81-860e-3c69de5c022f`, geração 1, revisão 0, organização coincidente, canal conectado/ativo e saúde recente. O grant `submission_authorized_at` permanece NULL; zero POSTs/jobs/modelos. O catálogo global ON pode semear contas futuras, mas o SQL atual bloqueia POST sem grant. Antes do piloto, reconfirmar que nenhuma outra conta/autorizações apareceram.

**Ordem de entrega:** spec aprovada → SQL/ACL e pré-voo isolado → EF/backend → UI → testes/reviews e PR/CI → autorização separada de `db push`/deploys → SQL no alvo → EF matrix → frontend READY → piloto Ren Sushi → ativação global para conexões futuras com autorização de alcance → observação dos estados Meta. Não usar SQL avulso no Studio para implantar migration; não ligar despacho nem enviar teste a clientes por este plano.

## Checkpoint local do piloto Ren Sushi

Este checkpoint cobre apenas a liberação manual dos nove modelos da Ren Sushi. A política de inscrição automática para futuras lojas, reconciliação persistente e UI dessa política continuam abertas nas Tasks 1–3 e 5.

Leitura de produção às 14h37 BRT: uma única conta/binding de templates, da Ren Sushi; catálogo ON e despacho OFF; grant de catálogo ausente. O worker de leitura já criou nove linhas locais `pt_BR` com `remote_status=UNKNOWN`, sem ID remoto nem `submission_attempted_at`; três jobs eram somente `sync` concluídos, com zero tentativas e nenhum job de `provision`. A criação local das linhas não é submissão à Meta. A saúde do canal Datafy estava recente, mas será conferida novamente antes de qualquer grant/POST.

- [x] A migration `20261017200000_whatsapp_template_approved_submission_pilot.sql` fixa as nove tuplas e o hash do JSON completo incluindo `examples`; os overloads antigos de três argumentos falham fechados. Revisões independentes de spec e qualidade da Task 1 aceitaram o piloto, depois de corrigidos o controle RED e a allowlist ACL.
- [x] O pré-voo 72 aplicou e reaplicou a migration em PostgreSQL local isolado e cobriu ator, spoof de claim, outra organização, grant repetido, revogação, nova liberação, hash alterado e prepare/confirm/check. A corrida entre revogação e confirmação em duas sessões ainda não tem teste automatizado; a ordem dos locks foi revista estaticamente. A confirmação atual é uma checagem sem marca durável própria: o piloto será serial e supervisionado, e uma submissão já confirmada pode chegar à Meta após revogação. Antes da política automática global, gravar a confirmação de uso único sob o fence e testar a corrida em duas sessões.
- [x] O backend do piloto revalida o payload completo e o grant SQL antes do POST; preview de vínculo e confirmação Datafy ainda pendente não disparam refresh. Revisões independentes de spec e qualidade da Task 2 aceitaram essas correções; 53 testes de wiring passaram e `deno check` passou nos três bundles afetados.
- [x] O cartão administrativo fixa canal/geração/revisão no diálogo de liberação e a loja distingue estado remoto desconhecido de análise pela Meta. Revisões independentes de spec e qualidade da Task 3 aceitaram a UI; testes focados passaram.
- [x] `npm run typecheck` (repetido após ajuste do runner), `npm run lint` (zero erros, 18 avisos anteriores), `npm run build`, `deno check` dos três bundles, grafo de imports e 101 testes focados de ACL/migration passaram. As duas expectativas antigas da UI foram corrigidas. O arquivo `node:test` foi excluído da coleta Vitest e suas três provas passaram no Node. Uma execução integral sob carga passou 3.725/3.726, com um timeout de fixture em teste de pesquisa não alterado; esse arquivo passou isolado 16/16. A repetição integral com dois workers fechou verde: 155 arquivos, 3.726/3.726 testes.
- [x] Os seis gates estáticos `saas-shield-br` pertinentes e a revisão integrada independente aceitaram o piloto sem achado P0/P1. O staged foi revisado integralmente e a varredura final de suas linhas não encontrou credencial nem caminho proibido; referências a `service_role` são nomes de papel SQL/ACL.
- [ ] Commit, PR/CI e autorizações de SQL/deploy concluídos.
- [ ] No alvo Ren Sushi: grant manual, exatamente nove submissões sem duplicata e estados remotos reconciliados. Nenhum POST à Meta foi feito neste checkpoint.

## Task 1 — Catálogo aprovado, política e autoridade SQL

Arquivos: migration nova via `supabase migration new`, teste gêmeo, allowlist ACL, pré-voos SQL.

- [ ] Semear allowlist SQL versionada das nove tuplas exatas ID/versão/idioma/hash/categoria/hash do payload completo, incluindo `examples`, com hashes calculados do catálogo TS canônico e controle positivo que falha se payload mudar. Autorização manual e automática fixam o digest da allowlist; edição/modelo novo requer nova versão e autorização.
- [ ] Criar política interna global OFF por default com revisão, digest, admin autenticado e auditoria; RPC admin-only para ligar/desligar. Criar inscrição durável atomicamente no INSERT de novo onboarding Datafy quando a política estiver ON, presa a onboarding/unidade/revisão; reutilizar onboarding existente nunca o inscreve. Confirmação associa a inscrição ao canal. Ren Sushi atual fica fora dessa inscrição e recebe grant manual explícito.
- [ ] Criar estado de preparação por canal e exclusão persistente após stop manual, sem PII/WABA/credencial. Leitura autenticada por unidade/admin sem ampliar RLS; service role só nas operações mínimas. A origem/revisão do grant é imutável e auditada.
- [ ] Criar RPC interna cercada para grant automático após inscrição válida, canal Datafy conectado/saudável, binding verificado, organização/WABA/revisão/geração atuais. Trigger só aceita transição service role com permit tipado de uso único; grants manuais continuam por `release_whatsapp_template_channel` admin-only, agora presos ao digest. Nunca tocar dispatch/adoption.
- [ ] Revalidar allowlist de conteúdo fixo e do payload completo, grant, política/exclusão e fence em `prepare_whatsapp_template_provision` e `confirm_whatsapp_template_post`; persistir confirmação de uso único por job/fence antes do HTTP e provar a corrida de revogação em duas sessões. Um confirm vencedor pode produzir HTTP posterior; não repetir POST incerto. Atualizar ACL/RLS com `revoke` explícito de funções novas e teste estático.
- [ ] Pré-voos locais: cross-tenant/WABA, admin vs owner/service-role, replays, geração/revisão, conexão anterior à política, política OFF/alterada, revogação × confirm, stop/reconnect, hash adulterado, nove modelos e corrida de dois canais da mesma WABA. Controle positivo deve demonstrar que a guarda detecta a mutação.
- [ ] Implementer → review de spec → review de qualidade → correções e aceite por task.

## Task 2 — Preparação e recuperação nas Edge Functions

Arquivos previstos: `manage-channels`, `_shared/whatsapp-template-runtime.ts`, `process-whatsapp-templates`, serviço de conta/sync/worker e testes. Recalcular grafo antes de congelar matriz.

- [ ] No retorno Datafy de conexão confirmada, acionar preparação de templates para inscrição elegível, sem desfazer conexão em falha. Descobrir WABA só por GET `/me`; validar phone_number_id e binding SQL; nenhuma WABA/ID livre do caller concede acesso.
- [ ] Criar seletor SQL/EF próprio de inscrições elegíveis ainda sem binding, pois o seletor atual percorre apenas contas; processar lotes pequenos, revalidar provider/tenant/revisão/geração/política, renovar saúde mesmo no canal conectado inativo e recuperar falha parcial. Persistir `pending`/`discovering`/`ready`/`needs_review`, motivo curto e próximo vencimento; falhas não somem no catch.
- [ ] Sync/POST só sob grant e allowlist atuais. WABA compartilhada deduplica; homônimo incompatível, 429 documentado, timeout/uncertain e categoria reclassificada têm estados distintos e sem retry cego. Nenhum caminho liga despacho, custo MARKETING, adoção ou mensagem.
- [ ] Testes fake de reconciliação/retry, health stale, conta compartilhada, erro em cada fronteira e zero POST ao negar política/permit/hash. `deno check` e import graph dos entrypoints reais.
- [ ] Implementer → review de spec → review de qualidade → correções e aceite por task.

## Task 3 — UI da loja e operação administrativa

Arquivos previstos: cartão Datafy, snapshot/gestão de templates, painel Platform para política/grant, hooks e testes React.

- [ ] Admin visualiza alcance global e ativa/revoga política por ação autenticada, com digest/versão e estado atual; não inscrever canais antigos automaticamente. No canal Ren Sushi, admin vê geração/revisão e libera catálogo manualmente por mutation/UI autenticada `release_channel` (backend já expõe a ação), depois solicita sync uma vez se o worker ainda não o fez. Incluir `manage-whatsapp-templates` na matriz de deploy se DTO/ação mudar.
- [ ] Loja elegível vê preparação e nove status com polling/refetch, inclusive conexão sem binding e erro persistido; texto de submissão automática aparece só para inscrição elegível. `APPROVED` exige hash/categoria/sync, e a UI distingue “enviado à análise” de “aprovado”. Nenhum botão obrigatório de sync para a loja.
- [ ] Configurações de automação para envio permanecem desligadas/guardadas; nenhuma ação de aprovar modelos ativa despacho ou consentimento de clientes. Testes de sessão/unidade trocada, loading/error/empty, status e textos.
- [ ] Implementer → review de spec → review de qualidade → correções e aceite por task.

## Task 4 — Integração, gates e commit

- [ ] Rodar pré-voo SQL isolado, testes focados de backend/UI, `npm run typecheck`, `npm run lint`, `npm run build`, `deno check`, `node scripts/ef-import-graph.mjs`, ACL estático; corrigir achados proporcionais. Review integrado da branch e seis gates `saas-shield-br` pertinentes a RLS, tenant, identidade, migration, secrets e integração.
- [ ] Revisar `git status`, diff total, staged integral e `git diff --cached --check`; varrer toda linha staged por segredos. `git add` apenas caminhos explícitos e commit local. Push/PR/merge só com CI `acl-estatico` verde e autorizações vigentes; Vercel `READY` não prova SQL/EF.
- [ ] Atualizar plano da Fase 6, runbook e memória com estados comprovados; separar aprovação local da autorização de `db push`/deploy/POST. Nenhum check de Meta aprovado sem evento/snapshot remoto atual.

## Task 5 — Rollout e piloto com a Ren Sushi

- [ ] Antes de qualquer escrita, conferir projeto `gbabxcrntkwgblgqsiit`, backup/janela, migrations pendentes exatas, contas/bindings/grants/jobs, canal Datafy local/remoto e UazAPI desligada. Confirmar nominalmente canal e custo; obter autorizações próprias para `db push`, matriz EF (incluindo `process-whatsapp-templates`) e efeito do merge em Vercel. SQL → ACL/RLS efetiva → EFs → frontend READY.
- [ ] Com dispatch global OFF, reler WABA/binding/saúde/generation/revision e zero outra conta no alcance. Admin concede **somente catálogo** para Ren Sushi, preso aos nove hashes; solicitar sync uma vez ou observar worker. Se resultado é incerto, reconciliar por GET/listagem, sem repetir POST.
- [ ] Conferir nove linhas locais, jobs e estados remotos por ID/idioma/hash/categoria solicitada/efetiva. Registrar `PENDING`/`APPROVED`/`REJECTED` com tempo e limites; aprovação da Meta pode demorar, então concluir submissão não significa concluir aprovação. Confirmar zero mensagens despachadas.
- [ ] Só depois do piloto e da auditoria de outras contas, admin pode ativar política de conexões futuras com confirmação específica de alcance global. Prova controlada de nova conexão em ambiente não produtivo ou fixture integral antes de afirmar self-service. Monitorar falhas/limites e permitir revogação sem repetir POST.
- [ ] Marcar somente checks comprovados, registrar evidências sem telefone/WABA/token/QR/PII, atualizar memória e fazer commit documental com caminhos explícitos. Envio de mensagem a cliente e alertas Resend seguem fora deste plano.
