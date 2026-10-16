# Plano — Migração de loja em produção da UazAPI para o WhatsApp oficial (Datafy)

- **Spec:** [2026-10-16-datafy-migracao-loja-em-producao-design.md](../specs/2026-10-16-datafy-migracao-loja-em-producao-design.md)
- **Branch:** `feat/datafy-migracao-uazapi` (criada de `origin/main` em `ee721c9`)
- **Execução:** uma fase por chat. Cada fase fecha com gates verdes, commit, checkboxes marcados aqui, memória atualizada e prompt de handoff (§ Handoff).
- **Fluxo obrigatório (CLAUDE.md):** implementer + review de spec e qualidade por task; review da branch no fim de cada fase. Gates `saas-shield-br:*` em toda fase que toque banco, auth, EF, webhook, RLS ou multi-tenant.
- **Proibido em qualquer fase sem autorização explícita do responsável:**
  - push, merge, `supabase db push`, deploy de EF;
  - mudança em produção;
  - chamada paga ou destrutiva à Datafy, Meta ou UazAPI.

| Fase | Conteúdo | Pode ir a produção sozinha? |
|---|---|---|
| 1 | Mecânica da migração de canal (banco, backend, telas) | Sim, com autorização: não muda loja sem liberação de migração |
| 2 | Templates `fila_mesa_pronta_v1` e `res_cancelada_v1` (catálogo + SQL + gêmeo) | Só com a Fase 3, ou com o frontend tolerante a catálogo maior |
| 3 | Produtores (cancelamento, mesa pronta), telas de Comunicação, janela de 24h | Depois da 2 |
| 4 | Opt-in de marketing nos formulários públicos | Independente |
| 5 | Gates integrados da branch + rollout em produção | — |
| 6 | Operação do Ren Sushi: preparação, templates, corte, reversão, desligamento | — |

---

## Fase 1 — Mecânica da migração de canal

Comandos-base:
- `npm run typecheck` (sempre com `-b`, nunca `tsc --noEmit`);
- `npm test -- <arquivo>`;
- `npm run lint`;
- `npm run build`.

O pré-voo SQL roda em PostgreSQL descartável. Siga o README de `supabase/tests/local-preflight/`, seção "Datafy parceiro (62/63)", que traz porta, banco e `psql -X -v ON_ERROR_STOP=1` sem `-1`.

### Task 1.1 — Migration `20261016120000_datafy_migration_grant.sql`

Arquivo: `supabase/migrations/20261016120000_datafy_migration_grant.sql`. O `BEGIN`/`COMMIT` vai explícito no arquivo, por causa da atomicidade entre statements.

- [x] **Coluna:**
  - `alter table public.whatsapp_official_connection_grants add column if not exists replaces_channel_id uuid;`
  - sem FK, mesma razão de `consumed_channel_id`: registro histórico, e evita o conflito FK × CHECK;
  - `comment on column` explicando que é preenchida pelo servidor.
- [x] **Trigger `whatsapp_official_connection_grants_migration_pin()`:**
  - `security definer`, `set search_path = ''`;
  - `revoke all ... from public, anon, authenticated` com a assinatura completa;
  - `BEFORE INSERT`:
    - trava `units` (`for update`) e depois `whatsapp_channels` da unidade ordenados por `id` (`for update`), na mesma ordem das autoridades Datafy;
    - calcula o binding com o predicado de `assert_datafy_first_configuration`: `is_active is true or (is_active is null and status='connected')`, `order by (is_active is true) desc, created_at asc nulls last, id`;
    - se o provider do binding for ≠ `datafy`, `NEW.replaces_channel_id := binding.id`; senão, `NULL`;
    - **sempre sobrescreve** o valor recebido.
  - `BEFORE UPDATE OF replaces_channel_id`: `raise` se `new.replaces_channel_id is distinct from old.replaces_channel_id`.
  - Trigger: `whatsapp_official_connection_grants_migration_pin_trg before insert or update of replaces_channel_id`. O nome ordena depois de `..._guard_trg`, então o guard de unidade e organização roda antes.
- [x] **`create or replace function public.assert_datafy_first_configuration(p_unit_id uuid)`**, mesma assinatura:
  - mantém os locks;
  - seleciona `id, provider` do binding;
  - se o provider for nulo ou `datafy`, retorna;
  - se for outro provider, só retorna se existir `g` com:
    - `g.unit_id = p_unit_id`;
    - `g.revoked_at is null`;
    - `g.replaces_channel_id = binding.id`;
    - `g.consumed_channel_id` nulo, ou um canal `provider='datafy'` da mesma unidade;
  - senão, `raise 'datafy_migration_not_supported' using errcode='23514'`;
  - repete `revoke all ... from public, anon, authenticated, service_role`.
- [x] **`create or replace function public.finalize_datafy_channel_subscription(...)`:** copia o corpo da `20261014170540` e muda só o bloco final de ativação:
  - executa `assert` + `request_whatsapp_channel_activation` + `activate_whatsapp_channel` somente quando `p_grant_id is null or g.replaces_channel_id is null`;
  - com liberação de migração, consome a liberação, conclui o onboarding e devolve `'finalized'` sem intenção;
  - repete os `revoke`/`grant` da assinatura completa.
- [x] Header da migration:
  - o que muda;
  - por que `create or replace` preserva a ACL;
  - nota de rollback forward-only.
- [x] Conferir que o `acl-estatico` local passa: `node scripts/...`, ou o teste estático em `scripts/migration-static-guard.test.ts`, via `npm test -- scripts/migration-static-guard.test.ts`. Allowlist em `scripts/function-acl-allowlist.json` se a regra exigir.

### Task 1.2 — Pré-voo `65`

Arquivos:
- `supabase/tests/local-preflight/65a-datafy-migration-bootstrap.sql`, com as dependências mínimas sobre o bootstrap do 63;
- `supabase/tests/local-preflight/65-datafy-migration-grant.sql`;
- seção nova no `README.md`.

Fixture: unidade com canal `uazapi` ativo, mais uma unidade de controle.

- [x] **M1:** liberação inserida com `replaces_channel_id` forjado ganha o id do binding UazAPI.
- [x] **M2:** liberação em unidade sem canal ou com binding datafy fica `NULL`.
- [x] **M3:** `UPDATE` de `replaces_channel_id` é recusado.
- [x] **M4:** `assert_datafy_first_configuration` passa com a liberação presa ao binding e recusa:
  - sem liberação;
  - com a liberação revogada;
  - com binding trocado (outra linha ativa);
  - com liberação consumida por canal não-datafy.
- [x] **M5:** `finalize_datafy_channel_subscription` com liberação de migração devolve `finalized`, consome a liberação, completa o onboarding e deixa `activation_requested_at` nulo e `is_active=false`, mesmo com eco presente.
- [x] **M6:** com eco e conectado, `request_whatsapp_channel_activation` + `activate_whatsapp_channel` trocam atomicamente: a UazAPI vai a `false` e a datafy a `true`, com um único ativo.
- [x] **M7:** reversão: intenção + ativação na linha UazAPI voltam a UazAPI. O guard Datafy não interfere.
- [x] **M8:** liberação comum (sem pin) com binding UazAPI continua recusando. Regressão da decisão de primeira configuração.
- [x] **Controles positivos**, em subtransação revertida:
  - (a) remover o pin do trigger faz o M1 falhar;
  - (b) recolocar a ativação incondicional no finalizador faz o M5 ativar;
  - (c) relaxar o `assert` para ignorar `revoked_at` faz o M4 passar indevidamente.
- [x] **Reaplicar a migration duas vezes** (idempotência) e reexecutar `61`, `62` e `63` contra o banco com a migration nova: o 63 cobre a primeira configuração e precisa continuar verde.

### Task 1.3 — Núcleo `datafy-onboarding-core.ts`

Arquivos: `supabase/functions/_shared/datafy-onboarding-core.ts`, `src/lib/datafy-onboarding-core.test.ts`.

- [x] `decideStartStep` ganha a entrada `migrationAllowed: boolean`. `UNIT_ALREADY_ACTIVE` só quando `unitHasActiveChannel && !migrationAllowed`. Valores não-boolean falham fechado.
- [x] `OfficialChecklistStep` ganha `"awaiting_cutover"`. `deriveOfficialChecklist` ganha `migrationHold: boolean`: com o canal assinado, eco presente e inativo, devolve `awaiting_cutover` em vez de `awaiting_echo`. Os itens do checklist não mudam.
- [x] Testes RED→GREEN para os dois ramos e para os não-boolean.

### Task 1.4 — Ações `datafy-onboarding-actions.ts`

Arquivos: `supabase/functions/_shared/datafy-onboarding-actions.ts`, `src/lib/datafy-onboarding-actions.test.ts`.

- [x] `Grant` e as projeções de `GRANTS` incluem `replaces_channel_id`. Helper `loadBinding(unitId)` devolve `{ id, provider } | null`; a consulta de canais inclui `id`.
- [x] Helper `migrationGrantFor(unitId, binding)`: liberação não revogada com `replaces_channel_id === binding.id`, ativa ou consumida por canal datafy da unidade.
- [x] Ajustes nas três funções:
  - `startConnection` passa `migrationAllowed`;
  - `assertDatafyBinding` aceita o binding de outro provider somente com `migrationGrantFor`;
  - `confirmConnection`/`subscribeChannel` usam o mesmo helper.
- [x] `gatesAllowed(unitId, adminDecisionRecorded, replacementConnection)`: o terceiro argumento é `true` com liberação de migração. O wiring fica em `manage-channels/index.ts` (`checkChannelConnectionAllowance(..., { replacementConnectionRecorded })`, conferir a assinatura em `:407`).
- [x] `state(unitId)`:
  - devolve `migration: { fromProvider } | null`, em que `fromProvider` é o provider do canal `replaces_channel_id`;
  - passa `migrationHold` a `deriveOfficialChecklist` quando a liberação ativa ou consumida pelo canal datafy é de migração e o canal ainda está inativo.
- [x] Testes:
  - migração aceita em start, confirm e subscribe;
  - liberação comum recusada com binding UazAPI;
  - binding trocado recusado;
  - o finalizador é chamado e o estado volta `awaiting_cutover`;
  - o DTO não expõe ids nem credenciais.

### Task 1.5 — `manage-channels` `begin_switch`

Arquivo: `supabase/functions/manage-channels/index.ts`, com os testes estáticos e de roteamento existentes que fixam a recusa.

- [x] Substituir a recusa TS de `begin_switch` para alvo `datafy` por:
  - recusar com 409 `DATAFY_MIGRATION_NOT_SUPPORTED` **somente** sem a liberação de migração presa ao binding atual;
  - reusar o helper exportado pelo módulo de ações, ou uma função pura do núcleo, sem reimplementar o predicado.
  - A autoridade continua no SQL (`request_whatsapp_channel_activation` → `assert`).
- [x] Atualizar a mensagem da recusa: "Esta unidade usa outro provedor. Libere a migração para a API oficial antes de trocar."
- [x] Teste do caminho de migração, mais regressão da recusa sem liberação.

### Task 1.6 — Frontend

Arquivos:
- `src/features/whatsapp/official-connection-api.ts`;
- `src/hooks/useOfficialConnection.ts`;
- `src/pages/gestao/Whatsapp.tsx`;
- `src/components/whatsapp/OfficialConnectionCard.tsx`;
- `src/features/whatsapp/official-checklist-copy.ts`;
- `src/components/whatsapp/DatafyAdminCard.tsx`;
- `src/pages/gestao/Automacao.tsx` (diálogo **Ativar / trocar**);
- os testes de cada um.

- [x] DTO: `readOfficialConnection` projeta `migration` (`{ fromProvider: string } | null`, com string validada contra a lista de providers).
- [x] `ERROR_COPY.UNIT_ALREADY_ACTIVE` passa a: "Esta unidade já usa outra conexão de WhatsApp. Fale com o suporte para migrar para a API oficial."
- [x] `Whatsapp.tsx`: com `migration`, renderiza o cartão **Conexão atual** (o bloco de lifecycle existente, extraído em componente e alimentado por `useWhatsappConnection`) **e** o `OfficialConnectionCard`. Sem `migration`, a regra atual (`useOfficial`) não muda.
- [x] `OfficialConnectionCard` em migração:
  - aviso antes do botão Conectar (texto da spec §5.7);
  - em `awaiting_cutover`: "Canal oficial pronto. A troca será feita pelo suporte.";
  - polling de 30 s.
- [x] `DatafyAdminCard`:
  - quando o binding da unidade é de outro provider (dos `channels` recebidos, mesma regra de `resolveUnitChannelBinding`), o botão vira **Liberar migração para oficial** e o diálogo explica a queda, o QR e o corte manual;
  - mostra "Migração: substitui o canal ‹provider› ‹id8›";
  - item `awaiting_cutover` no checklist.
- [x] `Automacao.tsx`, diálogo de **Ativar / trocar** em canal `datafy` com migração: mostra o canal substituído, o estado dos templates (`templatesPending`) e o aviso "Libere o despacho de templates logo após a troca".
- [x] Testes de componente:
  - migração renderiza os dois cartões;
  - a copy nova de erro;
  - `awaiting_cutover`;
  - o label de liberação no admin.

### Task 1.7 — Documentação e invariantes

- [x] Par `CLAUDE.md`/`AGENTS.md`, no mesmo commit: as três regras da spec §12 que valem para a Fase 1 (pin pelo servidor, ativação retida e corte só por `begin_switch`, teto de conexões com reposição). Formato obrigatório, uma frase de regra e uma de porquê, com ponteiro.
- [x] `docs/datafy-parceiro-runbook.md`, seção nova "Migrar loja em produção": passos do §4/§10 da spec até o corte, reversão e janela de queda.
- [x] Runbook: a Fase 1 exige `db push` da migration antes do deploy de `manage-channels`, depois o frontend.

### Task 1.8 — Gates da Fase 1

- [x] `npm run typecheck`, `npm test` (suíte completa; usar `--maxWorkers=1 --minWorkers=1` se o fixture de polling estourar tempo), `npm run lint` e `npm run build`.
- [x] Pré-voo 61, 62, 63 e 65 verdes, com os controles positivos; cluster encerrado.
- [x] Review de spec e qualidade por task; review da branch da fase.
- [x] Gates `saas-shield-br`:
  - `migration-validator` (migration nova);
  - `rls-auditor`;
  - `tenant-isolation-auditor`;
  - `identity-access-auditor`;
  - `integration-reliability-auditor`;
  - `secret-hunter`.
- [x] Revisar `git diff`, `git diff --cached` e `git diff -- CLAUDE.md AGENTS.md`; `git add` com caminhos explícitos; commit.

### Task 1.9 — Checkpoint e handoff

- [x] Marcar os checkboxes; registrar evidências (comandos e resultados) neste arquivo, na seção "Evidências da Fase 1".
- [x] Atualizar a memória do projeto (estado da branch e próxima fase).
- [x] Entregar o prompt da Fase 2 (§ Handoff) e pedir autorização para push/PR, e opcionalmente para o deploy da Fase 1.

---

## Fase 2 — Templates "mesa pronta" e "reserva cancelada"

Detalhar em tasks no início do chat, antes de codar, com a mesma granularidade da Fase 1. Escopo da spec §6.

- [ ] `whatsapp-template-catalog-core.ts`: `fila_mesa_pronta_v1` e `res_cancelada_v1`, com corpos de `2026-09-22-templates-oficiais-meta-propostas.md` §3/§7. Ajustar o teste que fixa 7 IDs.
- [ ] Kind `cancellation` em `whatsapp-automation-core.ts` (`ScheduledKind`), recursos (`whatsapp-automation-resources.ts`: `loadScheduledResource`, `captureExpected`, `renderScheduledTemplate`/`Text`) e despacho (`whatsapp-automation-dispatch.ts`). `waitlist_table_ready` entra como kind gerenciado.
- [ ] TTL: `cancellation` = 24h em `whatsapp-message-ttl-core.ts`, atualizando o comentário e o teste da linha ~102.
- [ ] Migration nova que alarga:
  - CHECK de `logical_id`, `kind` e `kind`↔recurso;
  - pin tuple;
  - os `CASE` e listas de: `enqueue_whatsapp_automation`, `whatsapp_automation_post_core` (reserva `cancelled` só para `cancellation`; status da fila para `table_ready`), `change_whatsapp_automation_pins`, `guard_whatsapp_template_scope`, `confirm_whatsapp_template_post`, `revalidate_whatsapp_template_job`, `prepare_whatsapp_template_provision`;
  - a reparação de aceite com cliente nulo, se aplicável.
  - Copiar cada corpo da última definição; `drop`+`create` exige repetir os `revoke`.
- [ ] Teste gêmeo TS↔SQL dos IDs do catálogo, com controle positivo.
- [ ] `src/hooks/useWhatsappTemplates.ts`: `snapshotSchema` aceita catálogo ≥ (não `===`); enums de kind; `DELIVERY_KINDS`; `whatsapp-template-access-core.ts` `pick`.
- [ ] Pré-voo: novos casos em 26, 35, 41 e 57 (mais 38 e 53 se tocados), ou harness 66 próprio, com controles positivos.
- [ ] Gates como na Task 1.8; checkpoint e handoff.

## Fase 3 — Produtores, telas e janela de 24h

Escopo da spec §7. Detalhar no início do chat.

- [ ] `send-cancellation`: roteamento `selectAutomationPath`, gerenciado via `send-scheduled-whatsapp` (kind no allowlist; auth interna para o caminho gerenciado; JWT e `hasUnitAccess` preservados na borda). Atualizar `whatsapp-template-channel-routing.test.ts`.
- [ ] Mesa pronta:
  - ação servidor para unidade adotada (parâmetros e `fact_at` no servidor);
  - `useNotifyWaitlist` usa o caminho novo quando adotado;
  - `resend-notification` `table_ready` via `dispatch_existing`;
  - `useResendWaitlistEntered` respeita a adoção.
- [ ] Comunicação: status do template oficial de mesa pronta (`fila/Comunicacao.tsx`) e linha de cancelamento (`reservas/Comunicacao.tsx`); atualizar `whatsapp-template-surfaces.test.tsx`.
- [ ] Janela de 24h:
  - `send-manual-message` recusa 409 `OUTSIDE_SERVICE_WINDOW` para canal ativo de payload Meta com última mensagem `user` há mais de 24h (decisão em núcleo puro testado);
  - Conversas mostra o aviso e desabilita o envio;
  - providers não oficiais não mudam.
- [ ] Gates; checkpoint e handoff.

## Fase 4 — Opt-in de marketing

Escopo da spec §8. Detalhar no início do chat.

- [ ] Migration: RPC `record_public_promotional_opt_in(p_unit_id, p_customer_id, p_reference)`:
  - `service_role` apenas;
  - `opt_in` promocional, origem `public_form`;
  - unidade pública; cliente vivo da mesma organização;
  - referência validada.
  - Revoke a public, anon e authenticated.
- [ ] `create-reservation`: campo `marketing_opt_in` (boolean estrito, `=== true`); grava o evento após criar a reserva; falha de gravação não derruba a reserva (log + métrica).
- [ ] EF pública nova da fila:
  - `enter_waitlist` + `resolveOrCreateCustomer` + opt-in;
  - origem e CORS como `create-reservation`;
  - rate limit por IP;
  - entrada `verify_jwt=false` no `config.toml`.
  - O frontend da fila pública passa a usá-la.
- [ ] Wizard (`StepGuestInfo`), widget e `WaitlistFormPublic`: checkbox desmarcado com a copy da spec. Zod: `boolean().default(false)`.
- [ ] Clientes: status de ofertas por unidade (owner/gerente) via `consent_snapshot`.
- [ ] Pré-voo 67 (RPC + ACL + controles); testes de EF/núcleo; gates; checkpoint e handoff.

## Fase 5 — Gates integrados e rollout

- [ ] Review da branch inteira; suíte completa; pré-voo de todas as fases; seis gates `saas-shield-br`; `acl-estatico`; auditoria de ACL no banco (procedimento autorizado).
- [ ] Matriz de deploy: migrations em ordem; EFs afetadas (enumerar pelo grafo de imports, nunca pelo prefixo); frontend por último.
- [ ] Com autorização explícita:
  - pré-voos somente leitura em produção;
  - `supabase db push`;
  - deploy das EFs;
  - merge do PR;
  - conferir o Vercel `READY` e o smoke sem autenticação.
- [ ] Atualizar o runbook com as evidências; checkpoint e handoff.

## Fase 6 — Operação do Ren Sushi (com o responsável e a loja)

Spec §10. Cada passo pago ou destrutivo exige confirmação nominal do canal (memória `confirm-channel-before-cost`).

- [ ] Pré-corte:
  - versão do app;
  - liberar a migração;
  - conexão Datafy;
  - QR da UazAPI novamente;
  - assinatura e prova de eco (`awaiting_cutover`).
- [ ] Templates:
  - `whatsapp_template_catalog` ON;
  - liberação de catálogo no canal oficial;
  - sync dos 9;
  - aprovação e categoria efetiva;
  - eventos de template chegando;
  - autorização de custo de marketing.
- [ ] Corte:
  - **Ativar / trocar** no canal oficial;
  - `whatsapp_automation_dispatch` ON e liberação de despacho no canal;
  - testes ao vivo (confirmação, mesa pronta, manual, IA);
  - painel de Entregas.
- [ ] Pós-corte:
  - monitorar por 7 dias;
  - reversão documentada;
  - desconectar a UazAPI;
  - registrar evidências e encerrar.

---

## Handoff

Prompt para abrir o próximo chat (trocar `N` pela fase):

```
Leia a memória do projeto, a spec docs/superpowers/specs/2026-10-16-datafy-migracao-loja-em-producao-design.md
e o plano docs/superpowers/plans/2026-10-16-datafy-migracao-loja-em-producao.md (inclusive as
evidências das fases anteriores). Estamos na branch feat/datafy-migracao-uazapi.
Execute a Fase N: primeiro detalhe as tasks dela no plano com a mesma granularidade da Fase 1,
depois implemente com subagent-driven-development (implementer + review de spec e qualidade por task),
rode os gates da fase, faça commit com git add de caminhos explícitos, marque os checkboxes,
registre as evidências, atualize a memória e me entregue o prompt da Fase N+1.
Sem push, merge, db push, deploy ou chamada paga a provider sem minha autorização explícita.
```

## Evidências

### Fase 1

Fechada em 2026-10-16. Sem push, merge, `db push`, deploy ou chamada a provider.

**Entregue:**
- Migration `20261016120000_datafy_migration_grant.sql`:
  - trigger de pin, com fallback para o canal legado `is_active` NULL mesmo desconectado;
  - `assert_datafy_first_configuration` aceita liberação presa ao binding;
  - o finalizador retém a ativação com liberação de migração **e** sempre que o binding for de outro provider (fecha o vínculo administrativo sem liberação).
- Núcleo e ações:
  - `migrationAllowed`, `awaiting_cutover` e `migrationHold`;
  - `isDatafyMigrationGrant`/`findDatafyMigrationGrant`;
  - DTO `migration: { fromProvider }`;
  - `decideReplacementConnectionRecorded`, que conta só instância da mesma organização;
  - canal de migração nasce com `async_ingestion_enabled=false`.
- `begin_switch`:
  - migração permitida só com liberação presa;
  - no corte de migração, eco e conexão são conferidos **antes** da intenção;
  - erro de leitura da liberação devolve 503 `MIGRATION_GRANT_UNAVAILABLE`.
- Frontend:
  - `/g/:slug/whatsapp` mostra **Conexão atual** e o cartão oficial durante a migração;
  - aviso de queda e QR;
  - `awaiting_cutover`;
  - no admin: rótulo "Liberar migração para oficial", nenhuma segunda liberação durante a retenção, botão desabilitado até os canais carregarem, aviso no **Ativar / trocar**;
  - `resolveReplacedChannel` espelha o pin.
- Par `CLAUDE.md`/`AGENTS.md` (duas regras corrigidas e uma nova) e runbook Datafy "Migrar loja em produção".

**Evidências:**
- **Pré-voo** em PostgreSQL 18.6 descartável (127.0.0.1:55465):
  - 65: 21/21 (M1–M16 mais M9/M10), com os controles positivos (a)–(e) observados falhando;
  - migration aplicada três vezes;
  - 61: 31/31, depois de refazer o snapshot C14 sobre o schema final;
  - 62 e 63: verdes;
  - cluster removido ao fim.
- **Guardas estáticas do `acl-estatico`** (`function-acl-allowlist`, `advisor-divergence-core`, `migration-static-guard`): 93/93.
- **Suíte completa** (`npx vitest run --maxWorkers=1 --minWorkers=1`): 3406/3406 testes, 125/126 arquivos.
  - O arquivo restante é `supabase/tests/local-preflight/local-runtime-paths.test.mjs`, pré-existente (`3acd7f4`, em `main`). É `node:test` que o vitest não reconhece. Passa com `node --test` e fica como pendência fora desta fase.
- `npm run typecheck`: 0 erros. `npm run lint`: 0 erros e 21 avisos (baseline). `npm run build`: ok.
- **Reviews:**
  - spec e qualidade do backend aprovadas, com P2/P3 corrigidos;
  - frontend com P2 corrigido (botão de liberação habilitado antes dos canais carregarem) e P3 corrigidos;
  - revisão da branch: ver abaixo.
- **Gates `saas-shield-br`**, todos PASS ou PASS_WITH_WARNINGS, sem bloqueante:
  - `migration-validator`;
  - `rls-auditor`;
  - `tenant-isolation-auditor`: filtro de organização na contagem aplicado;
  - `identity-access-auditor`: pin do legado desconectado aplicado;
  - `integration-reliability-auditor`: ingestão síncrona na migração e intenção não armada aplicadas;
  - `secret-hunter`.

**Desvios em relação à spec e ao plano (deliberados, vindos de review e gates):**
- **§5.1:** sem binding, o pin cai no canal legado não-datafy `is_active` NULL mais antigo (`<fallback-legado>`), em vez de NULL. Sem isso, um legado desconectado no instante da liberação geraria liberação comum e o eco ativaria sozinho.
- **§5.3:** o finalizador também retém a ativação quando o binding é de outro provider, inclusive no vínculo administrativo (`p_grant_id` nulo), que a spec dizia não mudar. Casos M11/M12.
- **§5.4:** no corte de migração, `begin_switch` confere eco e conexão **antes** da intenção. Novo 503 `MIGRATION_GRANT_UNAVAILABLE`.
- **§5.5:** a reposição só conta com exatamente uma instância viva do canal substituído na mesma organização, e não "sempre com liberação de migração". Na janela do legado desconectado, `recorded=false`; inofensivo sob o vitalício do Ren Sushi.
- **Novo:** o canal de migração nasce com `async_ingestion_enabled=false`, decidido pelo pin da liberação ou pelo binding estrangeiro.
- **§5.4:** o diálogo de corte mostra templates adotados ou pendentes; não há estado "bloqueados", que depende da Fase 2/3.
- **Plano:**
  - nomes de helpers diferentes: `loadUnitChannels`, `findDatafyMigrationGrant`, `decideReplacementConnectionRecorded`, `resolveReplacedChannel`;
  - arquivos extras: `whatsapp-org-provider-core.ts` (só tipo), `src/features/whatsapp/official-migration.ts` e o teste dele;
  - casos de pré-voo M9–M16 e controles (d)/(e).

**Limites registrados:**
- A liberação consumida continua valendo enquanto o canal substituído for o operacional. Para encerrar, cancelar a assinatura (runbook).
- O predicado de binding está duplicado em SQL, TS e frontend, com testes em cada camada.
- Não executados:
  - `deno check`: deno não instalado;
  - `gitleaks`: não instalado;
  - concorrência `61b`/`63b`;
  - `acl-estatico` remoto e auditoria de ACL no banco: dependem de PR/autorização.

**Deploy da Fase 1** (só com autorização):
1. `supabase db push` da `20261016120000`;
2. logo em seguida, `supabase functions deploy manage-channels`;
3. merge e frontend.
- Nenhuma liberação nesse intervalo.
- `manage-organizations` não precisa de redeploy (mudança só de tipo).

**Pré-voo da Fase 6:** conferir no Ren Sushi `select id, provider, is_active, status from whatsapp_channels where unit_id=<ren>`, esperado UazAPI com `is_active=true`. Revogar e liberar de novo a liberação comum criada antes deste deploy.
