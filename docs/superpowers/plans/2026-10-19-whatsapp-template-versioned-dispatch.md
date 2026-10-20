# Plano — despacho versionado dos modelos oficiais

**Estado: implementação e testes locais autorizados; tasks ainda pendentes.** A [spec de despacho versionado](../specs/2026-10-19-whatsapp-template-versioned-dispatch-design.md) recebeu aceite explícito “Aprovo a spec v2 para implementação local” em 19/10/2026, antes do código (`AGENTS.md` §4). A antiduplicidade integrada foi publicada no PR #44 e o v1 habilitado somente na Ren Sushi após reconciliação; a primeira confirmação controlada ainda está pendente. Preservar essa operação ao executar este plano com reviews por task. Esse aceite não autoriza novo `db push`, deploy, reenvio à Meta, ativação v2 ou mensagem paga.

## Contratos antes da execução

- A [copy v2](../specs/2026-10-17-whatsapp-template-copy-v2-design.md) já publicada cuida de preparação/submissão à Meta; coorte/grant v2 não são autoridade de envio. O v1 foi habilitado somente na Ren Sushi após publicação do PR #44, reconciliação e autorizações próprias; a confirmação controlada ainda está pendente. Despacho versionado v2 ainda não implementado; aprovação Meta v2 também incompleta no último snapshot. Reconfirmar no alvo antes de qualquer nova operação.
- Seleção de envio por `(binding_id, kind)` para ato administrativo explícito v1/v2; no enqueue, essa escolha precede default futuro v2 com enrollment automático comprovado, seguido de v1 somente para escopo legado comprovado. Ausência administrativa sozinha não define legado. Erro de leitura = falha fechada. `confirmation` exige as duas variantes v2. Sem `latest APPROVED`, repin histórico ou segunda intenção por fato.
- Antes de operar v1 ou v2, provar a passagem **legado→gerenciado** por finalidade: mensagens já aceitas em `notifications_sent`, outbox, marco de adoção, fatos anteriores e produtores/leases em voo não podem produzir segundo POST. A ausência de job gerenciado não é licença para reenviar. A cerca base do PR #44 está publicada, com prova local e observação operacional proporcional descritas na [evidência de produção](../2026-10-19-whatsapp-cutover-dedup-production-evidence.md); falta a primeira confirmação controlada ponta a ponta. Preservar e revalidar esses contratos no delta v2.
- Cada task de implementação segue **implementer → review independente de spec → review independente de qualidade → correção → aceite do ROOT**. Depois, review integrado da branch. Checkboxes só são marcados com evidência reproduzível, caminhos/SHAs e resultado; contagens de testes sobrepostas não são somadas.
- A spec aprovada inclui preferência automática v2 no enqueue de futuras lojas `origin='auto'` comprovadas. A loja liga finalidades existentes, sem seletor de versão; liberação administrativa de despacho e custo/consentimento permanecem independentes. Ren Sushi manual conserva v1 até opt-in explícito. Preparação de modelos já publicada não concede esses novos comportamentos.

## Task 1 — Autoridade SQL, constraints e provas locais

Arquivos previstos: nova migration criada por `supabase migration new`, harness `supabase/tests/local-preflight/`, allowlist/CI ACL e testes twin de digest. Não editar migration já aplicada.

- [ ] Inventariar enqueue, `change_whatsapp_automation_pins`, trigger de integridade, prepare/confirm/check, custo MARKETING, grants v2 de submissão e índices únicos. Congelar contrato v1 e diagramar pin inicial, pré-configuração e revalidação por versão.
- [ ] Provar ou corrigir, **antes de qualquer ativação**, exclusividade legado→gerenciado por finalidade: ceder produtor antigo quando houver adoção/job, bloquear fato anterior/aceito em `notifications_sent`, reconciliar outbox/receipt e race de lease/POST em voo. Se a prova exigir mudança de comportamento fora da spec aprovada, emendar/aprovar o desenho antes do código correspondente; não mascarar com `dispatch OFF` no teste.
- [x] Criar seleção administrativa privada `(binding_id, kind)` explícita v1/v2, revision/CAS/ator/audit, por RPC que resolve binding/organização/conta e exige platform_admin. Resolver único no enqueue: escolha administrativa válida → default futuro v2 por enrollment automático comprovado → v1 no legado comprovado. Retorno a v1 mantém linha explícita. Erro/inconsistência/proveniência ambígua recusam. Opt-in manual v2 valida ambos os modelos de confirmação e gates de hash/categoria/status/qualidade/sync/grant/canal. Deseleção bloqueia novo POST v2 pendente sem alterar histórico.
- [ ] Fixar versão e fonte/proveniência da escolha também em preconfiguration sem binding/template. Validar enrollment origin auto, onboarding/canal/unidade, revisão/digest; ligar depois apenas à conta/coorte/generation/credential correspondentes. Não promover coorte manual compartilhada, inferir futuro pela conta ou converter job v2 para v1. Policy/grant OFF bloqueia conforme autoridade corrente, preservando pins e sem ressuscitar terminal. Provar Ren manual e dois bindings compartilhando WABA.
- [x] Criar autorização de custo MARKETING específica da v2, escopada a conta/binding/geração/categoria/versão, validade e ator; v1 mantém contrato próprio. Nenhum grant de submissão ou autorização v1 vira custo v2 por herança.
- [ ] Adaptar enqueue/índices/constraints/RPCs de pin e post para gravar versão e revisão de seleção no novo job e preservar versão/modelo do job existente. Manter a unicidade por fato entre versões, consentimento, TTL, fences, rate limits, idempotência, provider uncertain e erro de gate fechados. Não iniciar cron/POST durante testes.
- [ ] Revogar EXECUTE público de toda função nova, conceder papel mínimo, atualizar ACL estático. Em PostgreSQL local descartável, aplicar/reaplicar migration e provar v1 regressão; duas sessões/CAS, tenant-cross, WABA compartilhada, reconexão, grant/custo vencidos, confirmação dupla, seleção falha, preconfig e jobs históricos.
- [ ] Implementer → review spec → review qualidade → correções/aceite. Registrar comandos, exit codes, SHA da migration e fixtures; nenhum `db push` de produção.

### Evidência local da Task 1 — ensaio CAS em duas sessões

Em PostgreSQL 17.11 descartável `margin-versioned-dispatch-sql-pg`, criado com `docker run --network none` e sem publicação de portas, o bootstrap `73-template-auto-bootstrap-versioned-local.ps1`, as migrations `20261019133502`, `20261019183559` e `20261019193132`, e o harness `77-whatsapp-versioned-dispatch.sql` (`docker exec -i ... psql -X -q -v ON_ERROR_STOP=1`) retornaram exit 0. O harness é `BEGIN`/`ROLLBACK` e passou com asserções de grant v2, seleção→enqueue→prepare/confirm, deseleção pré-POST, custo por versão/validade, WABA compartilhada com `grant_unavailable` e binding de outra organização recusado com SQLSTATE `23514`. SHA256 da migration após remover linha vazia final: `7065150F816790FCD7671B1FA9E562C138BAA5600447E04DF95461751BC2429F`; harness: `B253A8576698782562F99261569E1E828926681793727D7C9A06AD4A027509C4`. Nenhum provider foi chamado. Reaplicação da migration, reconexão e grant já vencido não foram provados; o checkbox agregado permanece pendente.

Para testar concorrência real, somente **nesse contêiner sem rede**, executou-se uma cópia transitória do harness com o `ROLLBACK` final trocado por `COMMIT`, criando a fixture visível a duas sessões. Em paralelo, ambas executaram esta transação com a mesma revisão esperada `3` (o identificador de binding é resolvido pela WABA sintética da fixture):

```sql
begin;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',
  (select user_id::text from public.platform_admins order by user_id limit 1),true);
select pg_sleep(2);
select public.set_whatsapp_automation_version_selection(
  (select b.id from public.whatsapp_template_bindings b
   join public.whatsapp_template_accounts a on a.id=b.account_id
   where a.waba_id='7700000000001' limit 1),
  'confirmation',1,3,1,0);
commit;
```

As duas sessões `docker exec -i ... psql -X -q -t -A -v ON_ERROR_STOP=1` terminaram com exit 0; uma retornou `selected, version=1, revision=4`, e a outra `stale, version=1, revision=4`. O verificador retornou `CONCURRENT_CAS_PASS`. A fixture persistida existiu somente para esse ensaio descartável; o contêiner foi removido. Isso prova o CAS concorrente, sem alterar banco de produção nem preencher os checkboxes de rollout.

Review integrado independente do freeze: **PASS local**, sem P0/P1 em isolamento, ACL/RLS, identidade, custo por versão, idempotência ou POST fence. `npx vitest run scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts src/lib/whatsapp-automation-versioned-dispatch.test.ts src/lib/whatsapp-automation-version-access.test.ts src/components/whatsapp/TemplateDispatchVersionAdminCard.test.tsx src/components/whatsapp/TemplateCatalogStoreCard.test.tsx`: 6 arquivos, 176 testes PASS. `npm run typecheck`, `npm run build`, `npm run lint` e `git diff --check`: exit 0 (lint com 18 avisos preexistentes, sem erro). `npx --yes deno@2.1.4 check` nos 13 entrypoints do grafo: exit 0. `node scripts/ef-import-graph.mjs` confirma 13 bundles; isto é matriz de publicação a autorizar, não deploy realizado. CI do commit final e rollout permanecem pendentes.

## Task 2 — EF, renderer e worker versionados

Arquivos previstos: `supabase/functions/_shared/whatsapp-automation-core.ts`, `whatsapp-automation-resources.ts`, `whatsapp-automation-dispatch.ts`, `whatsapp-template-access-core.ts`, `manage-whatsapp-templates`, entrypoints consumidores e testes. Matriz definitiva pelo import graph após o delta.

- [ ] Aceitar no parser somente pares válidos `initial_catalog_key`/`template_version`; buscar definição v1/v2 pelo job, nunca por sugestão do caller ou modelo mais recente. Carregar recurso, renderizar parâmetros na posição canonizada e preservar transporte legado de texto v1.
- [ ] Enviar o nome remoto exato da versão/variante fixada somente após prova SQL e EF de conta, binding, geração, categoria, hash, `APPROVED`/usable, sync, qualidade, consentimento, custo, TTL e fences. Não relaxar one-use POST, retry, uncertain/repair ou receipts.
- [ ] Expor mutations administrativas de seleção/CAS e leitura privacy-safe na EF; manter seleção de submissão v2 e liberação de despacho em ações separadas. Erro de banco/provider não devolve detalhe privado ao browser. O CTA mínimo para liberação de despacho v1 pertence à task do plano antigo aprovado; esta task apenas verifica integração com o guard/RPC já existentes, sem novo setter global.
- [ ] Testar v1 regressão, oito finalidades, duas variantes de confirmação, payload v2 exato, marketing sem autorização v2, falha de leitura e de revalidação, estados retry/uncertain, HTML/emoji/quebras, IDs/version/hash divergentes e cross-tenant. Rodar `deno check` dos entrypoints afetados e import graph.
- [ ] Implementer → review spec → review qualidade → correções/aceite. Registrar lista exata de EFs que incorporam `_shared` alterados.

## Task 3 — Admin, loja e estados legíveis

Arquivos previstos: hooks/DTOs de templates, cartões administrativos, cartões da loja, páginas de configurações de finalidade e testes React.

- [ ] Mostrar ao platform_admin seleção por finalidade, status das duas variantes de confirmação, revisão/CAS e resumo de categoria/custo; CTA para v2/v1. O CTA separado de liberação/parada de despacho vem da task v1 aprovada. Pin de confirmação capturado antes do `await`, lock em voo e erro/resultado ambíguo exigindo refetch antes de repetir.
- [ ] Mostrar à loja apenas os toggles já existentes e status verdadeiro do aviso em linguagem de negócio: pendente/recusado Meta, aprovado mas sem despacho, pronto ou revisão. Pode mostrar o texto canônico; não expor nome `_v1`/`_v2`, seletor de versão, texto editável, custo privado ou promessa de envio automático pela mera aprovação.
- [ ] Manter leituras estritas e tenant-safe; sync/histórico18 e cópias v1/v2 corretas, incluindo parágrafos e emoji. Testar drift, stale, concorrência, renderização sem vazar dados, e que UI não liga dispatch nem seleciona v2 por conta própria.
- [ ] Rodar testes focados, `npm run typecheck`, lint do delta e `git diff --check`.
- [ ] Implementer → review spec → review qualidade → correções/aceite.

## Task 4 — Integração, segurança e commit local

- [ ] Review integrado da branch inteira e comparação contra `origin/main`: v1 operacional, SQL/Ef/UI com mesma versão e migração dos contratos sem side effects. Reexecutar harness descartável, testes proporcionais, typecheck, lint/build, Deno e import graph no freeze final.
- [ ] Executar e registrar seis gates `saas-shield-br`: `migration-validator`, `check-rls`/review RLS, `tenant-isolation-auditor`, `identity-access-auditor`, `integration-reliability-auditor` e `secret-scan`; incluir `edge-function-guard` se o delta justificar. Conferir `acl-estatico` no CI para migration/funções/grants.
- [ ] Atualizar plano/runbook/memória apenas com invariantes e evidências; revisar `git status`, `git diff`, staged completo, varredura de segredos e caminhos proibidos. `git add` somente de caminhos explícitos, commit local, branch review final. Push/PR/merge só após gates e dentro de autorização aplicável; `main` publica frontend na Vercel.
- [ ] Implementer de integração → review spec da branch → review qualidade/segurança → correções/aceite. Registrar SHA/CI, sem marcar produção concluída por teste local.

## Task 5 — Rollout de produção separado

Esta task não começa pela aprovação da spec nem pelo commit. Para cada ação com custo ou efeito destrutivo, reconfirmar nominalmente **Moralles Reservas**, binding/canal Datafy da **Ren Sushi**, efeito e custo (assinatura Datafy já existente vs eventual tarifa Meta por mensagem), alcance e autorização própria. Nenhum teste pago é presumido pelo aceite anterior de submissão.

- [ ] Pré-voo: branch/PR e CI verdes, `acl-estatico`, alvo/projeto, backup/PITR e janela aceitos, canal/binding/geração/conta, estado Meta de todos os modelos, categorias/qualidade/hash/sync, consentimento, grants de custo v2, flags globais e do binding. Reconciliar mensagens legadas aceitas, `notifications_sent`, outbox/leases, jobs e fato/marco de adoção; provar produtor único por finalidade inclusive corrida em voo. Recalcular dry-run para **migration exata** e grafo de EFs (mapa pós-PR #44: 13 consumidores de `whatsapp-automation-core.ts`; número final depende do delta). Qualquer drift/novo alcance ou exclusividade não provada = NO-GO.
- [ ] Com autorização explícita de `db push` da migration exata, aplicar SQL primeiro, verificar ACL/RLS/RPCs e regressão v1 por leitura. Sem SQL ad hoc no Studio.
- [ ] Com autorização explícita de deploy de cada bundle da matriz, publicar EFs na ordem segura, checar versões/health/logs sem dados pessoais, depois frontend `main`/Vercel READY com autorização do efeito automático. Não inferir que a publicação ativa despacho.
- [ ] Somente depois de todos os modelos v2 da finalidade estarem `APPROVED`/usable com hash/categoria/sync corretos, obter autorização administrativa de seleção v2 por finalidade e de custo MARKETINGv2 quando aplicável; registrar ator/revisão/binding e snapshot posterior. Confirmar despacho global/binding/finalidade separadamente antes de qualquer envio.
- [ ] Para teste controlado de mensagem, confirmar canal e possível tarifa Meta **antes de cada envio**, obter autorização explícita, usar contato controlado, reconciliar entrada/saída/receipt sem conteúdo pessoal e observar fallback manual. Não disparar em lote. Registrar evidências e marcar apenas checkboxes comprovados.

**Parada:** exclusividade legado→gerenciado não comprovada, qualquer `PENDING`, `REJECTED`, `UNKNOWN`, categoria diferente, custo não autorizado, leitura de gate falha, erro de CI ou resultado provider incerto mantém NO-GO para a finalidade afetada. Não tentar outra versão automaticamente.
