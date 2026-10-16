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

Escopo da spec §6. Os produtores (quem enfileira `cancellation`/`waitlist_table_ready`) ficam na Fase 3; aqui o ledger, o catálogo e o SQL passam a **aceitar** os dois kinds, e o produtor genérico os recusa explicitamente até lá.

**Decisões de desenho da Fase 2** (valem para TS e SQL, que precisam concordar):
- **Corpos** seguem o estilo do catálogo atual (sem emoji, frase abrindo com "Olá, {{1}}.", nenhuma variável no início ou fim nem adjacente), adaptando §3/§7 das propostas da mesma forma que `fila_entrada_v1` adaptou §6:
  - `fila_mesa_pronta_v1` (UTILITY, gatilho `waitlist_table_ready`): `Olá, {{1}}. Sua mesa em {{2}} está pronta.\nSenha da fila: {{3}}.\nPor favor, dirija-se à recepção.` Variáveis `customer`, `unit`, `queue_code` (`senha_fila`, máx. 10).
  - `res_cancelada_v1` (UTILITY, gatilho `reservation_cancelled`): `Olá, {{1}}. Sua reserva em {{2}} foi cancelada.\nData: {{3}}. Horário: {{4}}. Pessoas: {{5}}.\nCódigo da reserva: {{6}}.\nSe foi engano ou quiser remarcar, responda a esta mensagem.` Variáveis `customer`, `unit`, `date`, `time`, `people`, `reservation_code`.
- **Elegibilidade:**
  - `cancellation`: reserva com `status='cancelled'` (outro status → motivo novo `reservation_not_cancelled`, estado `blocked`); sem checagem de pagamento; recusa `reservation_past` depois do horário da reserva; cliente obrigatório.
  - `waitlist_table_ready`: entrada com `status in ('waiting','notified')` e `seated_at` nulo, senão `waitlist_not_waiting`; cliente opcional, como `waitlist_entered` (resolve por telefone canônico na organização, sem criar).
  - Ambos UTILITY, propósito `operational`; chave de setting **nula** nos dois (ação explícita do operador, como `confirmation`), em TS e no `v_key` do SQL.
- **TTL:** `cancellation` = 24h (o ledger exige `expires_at`); `waitlist_table_ready` mantém 30 min.

### Task 2.1 — Núcleos TS (catálogo, TTL, kinds)

Arquivos: `whatsapp-template-catalog-core.ts`, `whatsapp-message-ttl-core.ts`, `whatsapp-automation-core.ts`, `whatsapp-template-access-core.ts`, `src/lib/whatsapp-automation-delivery-state.ts` e os testes de cada um (`src/lib/*.test.ts`), mais fixtures que fixam 7 IDs.

- [x] Catálogo: `TemplateId` + as duas definições acima; o teste que fixa 7 IDs passa a 9, com o hash e o render dos dois novos (incluindo parâmetro inválido).
- [x] TTL: `cancellation: 24 * HOUR` em `MESSAGE_TTL_MS` e `ExpirableMessageKind`; reescrever o comentário que justificava deixar `cancellation` de fora (o ledger exige prazo; `reservation_past` cobre o pós-horário) e o teste que fixava `cancellation` como `unmapped_kind`. `send-cancellation` não chama `decideMessageTtl` (conferido), então o caminho legado não muda.
- [x] `whatsapp-automation-core.ts`:
  - `SCHEDULED_KINDS` exportado `as const` (fonte do gêmeo) e `ScheduledKind` derivado dele, com `cancellation` e `waitlist_table_ready`;
  - `ScheduledIntent`: `cancellation` com `reservationId`, `waitlist_table_ready` com `waitlistId`;
  - `logicalAutomationKey` mapeia os dois recursos;
  - `AUTOMATION_PREFLIGHT_REASONS` ganha `reservation_not_cancelled` (estado `blocked`).
- [x] `whatsapp-template-access-core.ts` `pick` de kind e `DELIVERY_KINDS` aceitam os dois kinds (o mapeamento de recurso de `delivery-state` já trata `waitlist_*` e reserva).
- [x] Testes RED→GREEN.

### Task 2.2 — Recursos e despacho TS

Arquivos: `whatsapp-automation-resources.ts`, `whatsapp-automation-dispatch.ts`, `waitlist-defaults.ts` (se faltar o texto padrão de mesa pronta) e os testes (`src/lib/whatsapp-automation-*.test.ts`, fixtures).

- [x] `loadScheduledResource`: ramos de elegibilidade da seção de decisões, `templateId` `res_cancelada_v1`/`fila_mesa_pronta_v1`, chave de setting nula.
- [x] `captureExpected`: `cancellation` usa o formato de reserva, e `waitlist_table_ready` o de fila. O tipo `ScheduledResourceExpected` acompanha.
- [x] `renderScheduledTemplate`:
  - `res_cancelada_v1` usa `[cliente, unidade, data, hora, pessoas, código]`;
  - `fila_mesa_pronta_v1` usa `[cliente, unidade, senha]`.
- [x] `renderScheduledText` (unidade adotada com provider não oficial):
  - `cancellation` com o mesmo texto que `send-cancellation` envia hoje;
  - `waitlist_table_ready` com `waitlist_message_templates` (`event='table_ready'`) customizado, ou o padrão de `waitlist-defaults.ts`.
- [x] `whatsapp-automation-dispatch.ts`:
  - o parse ledger→intent aceita os dois kinds com o recurso correto;
  - o produtor genérico (`ScheduledProducerRequest`) devolve `not_enqueued`/`provenance_refused` para os dois até a Fase 3, com teste. Hoje `cancellation` cairia na tabela `waitlist`.
- [x] Testes de elegibilidade:
  - reserva `confirmed` → `reservation_not_cancelled`;
  - reserva no passado → `reservation_past`;
  - fila `seated` ou `cancelled` → `waitlist_not_waiting`;
  - fila `notified` aceita;
  - fila sem cliente aceita.
- [x] Testes de render dos dois kinds.

### Task 2.3 — Frontend tolerante

Arquivo: `src/hooks/useWhatsappTemplates.ts`, com os testes que fixam o snapshot.

- [x] `snapshotSchema`: `templates` aceita **subconjunto** do catálogo (`length <= catálogo`, ids únicos e conhecidos), em vez de `===`. Frontend novo (9) com EF antiga (7) continua funcionando.
- [x] `jobSchema.kind` aceita os dois kinds. `correctionReasons` não muda: `reservation_not_cancelled` não é corrigível.
- [x] Testes:
  - snapshot com 7 aceito;
  - snapshot com 9 aceito;
  - id duplicado ou desconhecido recusado.
- [x] Ordem de deploy registrada: o frontend antigo recusa id desconhecido, então o frontend vai antes das EFs ou junto delas (Fase 5).

### Task 2.4 — Migration `20261017120000_whatsapp_templates_table_ready_cancellation.sql`

`BEGIN`/`COMMIT` explícitos no arquivo. Todo corpo é copiado da **última** definição no histórico. Para achá-la, o script de inventário (abaixo) lista cada função cujo corpo vigente cita kind ou id de template. `create or replace` com a mesma assinatura preserva a ACL, mesmo assim os `revoke`/`grant` da assinatura completa se repetem.

- [x] **CHECKs**, localizados por `pg_constraint` (relação, colunas e expressão), como faz o bloco `DO` da `20261004184738`, e nunca pelo nome gerado:
  - `whatsapp_remote_templates.logical_id` com os 9 ids;
  - `whatsapp_automation_jobs.kind` com os 8 kinds;
  - kind↔recurso: `cancellation` com `reservation_id` e `waitlist_table_ready` com `waitlist_id`;
  - `whatsapp_automation_pin_tuple_check` (`initial_catalog_key`) recriado com os 9 ids.
- [x] **Funções**, com os `CASE` kind→template e as listas:
  - `enqueue_whatsapp_automation`: validade kind↔recurso, ramo de fila incluindo `waitlist_table_ready`, `CASE` lógico;
  - `app_private.whatsapp_automation_post_core`:
    - reserva esperada `cancelled` só para `cancellation`, sem checagem de pagamento;
    - `reservation_past` para `cancellation`;
    - fila `waiting`/`notified` com `seated_at` nulo para `table_ready`;
    - cliente nulo permitido para `table_ready`;
    - `v_key` nulo nos dois;
    - categoria UTILITY;
  - `app_private.change_whatsapp_automation_pins` e `guard_whatsapp_template_scope`: `CASE` lógico e ramo de fila;
  - `confirm_whatsapp_template_post`, `revalidate_whatsapp_template_job` e `prepare_whatsapp_template_provision`: listas de ids;
  - `reconcile_whatsapp_automation_acceptance`: cliente nulo também para `table_ready`;
  - qualquer outra que o inventário aponte com lista fixa: `confirm_whatsapp_automation_resource_post` e as que delegam ao `post_core` só mudam se tiverem lista própria.
- [x] **Não muda:** os ramos promocionais (`waitlist_feedback`/`voucher_issued`), `maintain_whatsapp_legacy_template` (já aceita `table_ready`) e `notifications_sent_kind_check` (já tem `cancellation`/`waitlist_table_ready`).
- [x] Header:
  - o que muda;
  - por que `create or replace` preserva a ACL;
  - rollback forward-only;
  - ordem de deploy (SQL antes das EFs; semear o catálogo novo contra o CHECK velho falha a conta inteira).
- [x] `npm test -- scripts/migration-static-guard.test.ts` e as guardas do `acl-estatico` verdes; allowlist só se a regra exigir.

Inventário (anexar a saída às evidências):

```bash
node <scratchpad>/inv.mjs supabase/migrations   # função → arquivo da última definição, só as que citam kind/id
```

### Task 2.5 — Teste gêmeo TS↔SQL

Arquivo: `src/lib/whatsapp-template-catalog-migration-twin.test.ts`, no padrão de `whatsapp-ad-touchpoint-migration-twin.test.ts`.

- [x] Para cada função vigente (última definição em todo o histórico de migrations) e cada CHECK vigente, extrai as listas literais de ids de template e confere cada uma contra `Object.keys(TEMPLATE_CATALOG)`. Kinds CHECK contra `SCHEDULED_KINDS`, e o `CASE` kind→template contra o mapeamento TS.
- [x] Controle positivo: SQL sintético sem um id e com um kind a mais faz o comparador reprovar.
- [x] O teste falha hoje (RED, só com o TS da 2.1) e passa com a 2.4 (GREEN).

### Task 2.6 — Pré-voo `66`

Arquivos: `supabase/tests/local-preflight/66a-templates-table-ready-bootstrap.sql` (se necessário), `66-templates-table-ready-cancellation.sql` e uma seção nova no `README.md`.

**Runtime:** o PostgreSQL standalone não serve, porque o `25` exige `supabase_vault` (medido nesta fase). Use um contêiner descartável e próprio `public.ecr.aws/supabase/postgres:17.11.0.004`:
- nome `margin-phase2-tpl-pg`;
- porta `127.0.0.1:55467`;
- usuário `supabase_admin`.

Medido: o `25` e as sete migrations de template até a `20261005145913` aplicam limpas nesse contêiner. As seguintes exigem as pontes do README (testsetups `41`/`48` geram `voucher_rules` etc., `44`, `52` e `56`). Nunca toque os contêineres de outros projetos, e remova o próprio ao fim.

- [x] RED: o `66` falha antes da migration nova (guarda do topo).
- [x] Casos:
  - **T1:** os CHECKs aceitam os 9 ids e os 8 kinds e recusam id/kind desconhecido e kind↔recurso trocado;
  - **T2:** `enqueue_whatsapp_automation` com `cancellation`/`table_ready` grava `initial_catalog_key` correto;
  - **T3:** `post_core` para `cancellation`: reserva `cancelled` futura passa; `confirmed` e passada recusam;
  - **T4:** `post_core` para `table_ready`: `waiting`/`notified` passam, `seated`/`cancelled` recusam, cliente nulo passa;
  - **T5:** conta semeada com os 9 `whatsapp_remote_templates`; `prepare_whatsapp_template_provision` e `revalidate_whatsapp_template_job` aceitam os ids novos;
  - **T6:** reparação de aceite com cliente nulo em `table_ready`;
  - **T7:** `block_whatsapp_automation_preflight` aceita `reservation_not_cancelled` e o painel de Entregas o exibe (acrescentado na implementação);
  - **T8:** a ACL das funções substituídas é idêntica ao snapshot de antes, e as trigger functions continuam sem EXECUTE público;
  - **T9:** os casos existentes dos kinds antigos continuam iguais (regressão mínima de `confirmation`, `waitlist_entered` e um promocional).
- [x] Controles positivos em subtransação revertida:
  - (a) CHECK de `logical_id` sem o id novo recusa a semeadura;
  - (b) `post_core` aceitando `confirmed` para `cancellation` faz o T3 falhar;
  - (c) `table_ready` aceitando `seated` faz o T4 falhar.
- [x] Migration aplicada três vezes (idempotência), com o `66` verde ao fim.
- [x] Se a cadeia permitir, reexecutar o `57` (SQL) como regressão. Se não, registrar o porquê.

### Task 2.7 — Documentação e invariantes

- [x] Par `CLAUDE.md`/`AGENTS.md` no mesmo commit:
  - o catálogo passa de "sete" para "nove modelos";
  - regra nova: o catálogo TS e as listas SQL têm teste gêmeo, e kind ou template novo exige migration antes das EFs;
  - o frontend aceita catálogo-subconjunto.
- [x] `docs/whatsapp-templates-programados-runbook.md`:
  - catálogo com 9;
  - os dois kinds e os produtores pendentes da Fase 3;
  - ordem SQL → frontend → EFs.

### Task 2.8 — Gates da Fase 2

- [x] `npm run typecheck`, suíte completa (`npx vitest run --maxWorkers=1 --minWorkers=1`), `npm run lint` e `npm run build`.
- [x] Pré-voo 66 verde com os controles; contêiner removido.
- [x] Review de spec e qualidade por task; review da branch da fase.
- [x] Gates `saas-shield-br`:
  - `migration-validator`;
  - `rls-auditor`;
  - `tenant-isolation-auditor`;
  - `identity-access-auditor`;
  - `integration-reliability-auditor`;
  - `secret-hunter`.
- [x] Revisar `git diff`, `git diff --cached` e `git diff -- CLAUDE.md AGENTS.md`; `git add` com caminhos explícitos; commit.

### Task 2.9 — Checkpoint e handoff

- [x] Checkboxes, evidências em "Evidências → Fase 2", memória e prompt da Fase 3.

## Fase 3 — Produtores, telas e janela de 24h

Escopo da spec §7. Detalhar no início do chat.

**Requisitos herdados da Fase 2** (reviews e gates):
- **Produtor de mesa pronta e cancelamento:**
  - a unidade é derivada do recurso (`waitlist`/`reservations`), nunca do corpo;
  - `hasUnitAccess` (membro ou `platform_admin`);
  - `fact_at` calculado no servidor.
  - O `enqueue_whatsapp_automation` só confere o tenant do recurso, não o estado nem a origem de `fact_at` (tenant-isolation P2).
- **Corrida de status:** o snapshot do `post_core` compara status e `seated_at` da fila. Se o produtor de mesa pronta mudar `waiting`→`notified` entre captura e POST, o job termina em `resource_changed`. Mude o status **antes** da captura, ou capture logo antes do POST.
- **Um job por (unidade, kind, recurso):** chamar a mesa duas vezes, ou cancelar, reativar e cancelar de novo, não gera segunda mensagem pelo ledger. Decidir se é aceito ou se `source_event_key` entra na chave.
- **Linha legada `failed` em `notifications_sent`** com o mesmo `(recurso, kind)` faz o reconcile terminar em `deferred`/`notification_conflict` depois do aceite. Adote essa linha no reconcile ou no produtor, com caso no pré-voo.
- O produtor genérico (`enqueueScheduledIntent`) recusa os dois kinds **antes** de consultar o ledger. Ao liberar, mova a recusa para depois da busca do job existente, como em `voucher_issued`.
- `send-scheduled-whatsapp` ainda recusa os dois kinds no allowlist HTTP (`index.ts:75`).

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

### Fase 2

Fechada em 2026-10-16. Sem push, merge, `db push`, deploy ou chamada a provider.

**Entregue:**
- **Catálogo de 9 modelos:**
  - `fila_mesa_pronta_v1` e `res_cancelada_v1` (UTILITY);
  - `SCHEDULED_KINDS` com `cancellation` e `waitlist_table_ready`;
  - TTL de `cancellation` = 24h;
  - motivo novo `reservation_not_cancelled`.
- **Recursos e despacho:**
  - elegibilidade dos dois kinds;
  - render oficial e texto (a mesa pronta usa o link `/acompanhar/<id>`, como o legado);
  - parse do ledger;
  - produtor genérico recusando os dois kinds (`provenance_refused`) até a Fase 3.
- **Frontend:** snapshot aceita catálogo-subconjunto; rótulo "Cancelamento de reserva" em Entregas.
- **Migration `20261017120000_whatsapp_templates_table_ready_cancellation.sql`:**
  - 4 CHECKs alargados, localizados por expressão;
  - 10 funções `create or replace` com a ACL repetida;
  - `set local lock_timeout='5s'`.
- **Teste gêmeo** `src/lib/whatsapp-template-catalog-migration-twin.test.ts`.
- **Pré-voo 66/66a** com o helper versionado `66-extract-bridge.mjs`.
- **Documentação:** par `CLAUDE.md`/`AGENTS.md` e runbook de templates (linha 15 da matriz, "nove modelos", efeito externo do redeploy).

**Evidências:**
- **Pré-voo** no contêiner descartável `public.ecr.aws/supabase/postgres:17.11.0.004` (127.0.0.1:55467), reconstruído do zero com a cadeia do README:
  - `66a` gravou o snapshot (10 funções) e recusou rodar depois da migration;
  - RED: o `66` falhou na guarda do topo;
  - GREEN66 com 171 checagens (T0–T9) e os controles (a)–(c) observados virando;
  - migration aplicada 3×, com o `66` verde e a ACL idêntica ao snapshot;
  - depois do `lock_timeout`, uma 4ª aplicação seguida do `66`, ainda GREEN66;
  - contêiner removido.
  - As pontes extraídas pelo helper endurecido são byte-idênticas às originais.
- **Teste gêmeo:** 13/13. Sem a migration nova, ele reporta 11 divergências.
- **Suíte completa** (`npx vitest run --maxWorkers=1 --minWorkers=1`): 3455/3455 testes, 127/128 arquivos.
  - A falha restante é a pendência conhecida `local-runtime-paths.test.mjs`.
  - Os arquivos editados depois disso foram reexecutados: 381/381.
- `npm run typecheck`: 0 erros. `npm run lint`: 0 erros e 21 avisos (baseline). `npm run build`: ok.
- **Guardas do `acl-estatico`:** `migration-static-guard`, `function-acl-allowlist` e `advisor-divergence-core` verdes.
- **Reviews:**
  - migration aprovada (diff mecânico de cada corpo contra a última definição);
  - TS aprovado, com o P2 corrigido (`link_status` da mesa pronta);
  - revisão da fase: P2 de documentação corrigido (submissão automática dos 2 modelos no redeploy) e P3 corrigidos (README, helper, limites do gêmeo, espelho do `AGENTS.md`, numeração).
- **Gates `saas-shield-br`**, todos PASS ou PASS_WITH_WARNINGS, sem bloqueante:
  - `migration-validator`;
  - `rls-auditor`: `lock_timeout` aplicado;
  - `tenant-isolation-auditor`: P2 do futuro produtor registrado na Fase 3;
  - `identity-access-auditor`: PASS;
  - `integration-reliability-auditor`: runbook corrigido, itens da Fase 3 registrados;
  - `secret-hunter`: só a senha do contêiner descartável em loopback.

**Desvios em relação ao plano (deliberados):**
- Duas funções a mais na migration, `block_whatsapp_automation_preflight` e `get_whatsapp_automation_delivery_state`. Sem elas, o motivo novo estouraria `22023` e o painel mostraria `unknown_reason`.
- `reservation_not_cancelled` também entra em `DELIVERY_REASONS`.
- O caso T7 (motivo novo) foi acrescentado ao pré-voo; ACL e regressão viraram T8/T9.
- O texto de cancelamento mostra a hora como HH:MM, não HH:MM:SS como o legado.
- Os corpos usam o estilo do catálogo atual (sem emoji), não o texto literal das propostas §3/§7.

**Limites registrados:**
- Os harnesses 53, 57 e 60 não rodam neste contêiner, porque o `auth.uid()` da imagem lê outra GUC. Continuam como gates do stack CLI.
- JWT/PostgREST e concorrência entre sessões não foram provados.
- `deno check` e `gitleaks` não executados (não instalados).
- `acl-estatico` remoto e auditoria de ACL no banco dependem de PR e autorização.

**Deploy da Fase 2** (só com autorização, na Fase 5):
1. `supabase db push` da `20261017120000`, depois da `20261016120000`.
2. Merge do frontend tolerante.
3. EFs pela matriz do runbook.

O redeploy de `process-whatsapp-templates` **submete os 2 modelos novos** em toda conta com catálogo liberado (inclusive o piloto Moralles). Precisa de autorização própria, ou de pausar antes o escopo `catalog` dessa conta.
