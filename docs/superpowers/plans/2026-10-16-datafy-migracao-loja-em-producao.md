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

Escopo da spec §7. A Fase 2 já instalou o catálogo, os kinds e o ledger; esta fase liga somente produtores autenticados, as superfícies de operação e a guarda de conversa. Nenhum teste invoca provider real.

**Decisões de execução:**
- O ledger mantém uma mensagem por `(unit_id, kind, resource_id)`. Novo clique em mesa pronta ou novo ciclo cancelar→reativar→cancelar consulta o job existente e não cria outro envio; a UI deve mostrar o resultado existente. Uma segunda notificação exige uma decisão de produto e mudança de chave em outra spec.
- `fact_at` da mesa pronta é `notified_at` gravado pelo servidor na ação autenticada; o status vira `notified` antes da captura e o POST só prossegue se o snapshot final ainda corresponder. `fact_at` de cancelamento vem de `cancelled_at` gravado por trigger na transição de status, nunca do cliente. Reserva cancelada antes da migration fica com `cancelled_at=NULL` e não ganha envio gerenciado retroativo.
- Uma linha legada `notifications_sent.status='failed'` para o mesmo recurso e kind não pode tornar um POST aceito irrecuperável. Reconciliar/adotar a linha sob a autoridade SQL e provar o caso no pré-voo.
- A seleção de caminho falha fechada: erro de flag, adoção, binding ou ledger não cai em texto livre. O canal Meta sem janela aberta recusa na EF mesmo que a UI esteja desatualizada.

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

### Task 3.1 — Núcleo e contrato do produtor gerenciado

Arquivos: `_shared/whatsapp-automation-dispatch.ts`, `_shared/whatsapp-automation-producer-routing.ts`, `send-scheduled-whatsapp/index.ts` e testes em `src/lib/whatsapp-automation-*.test.ts`/request harness.

- [x] Ampliar os tipos e o roteamento de `cancellation`/`waitlist_table_ready`, preservando a recusa do produtor genérico até o contrato autenticado específico estar ligado.
- [x] No produtor dedicado, derivar `unit_id` de `reservations`/`waitlist`; recusar divergência com qualquer id enviado; conferir status, recurso e origem do fato no servidor. `hasUnitAccess` admite membro ou `platform_admin`.
- [x] Mover `provenance_refused` para depois da leitura do ledger existente; um job prévio volta como resultado durável mesmo se a adoção, o status ou a flag mudaram.
- [x] `send-scheduled-whatsapp` aceita os dois kinds somente por caminho interno autenticado; `resend` de usuário só despacha job existente, com recurso e membership conferidos antes de ler o ledger.
- [x] Testes RED→GREEN de JWT ausente/inválido, recurso alheio, caller sem membership, `fact_at` forjado, status alterado, job existente e dependência indisponível.

### Task 3.2 — Cancelamento

Arquivos: `send-cancellation/index.ts`, migration nova para `reservations.cancelled_at` e trigger de transição, núcleo de roteamento, pré-voo local, testes de request e `src/lib/whatsapp-template-channel-routing.test.ts`.

- [x] Criar migration versionada com `cancelled_at timestamptz` preenchido exclusivamente pelo trigger `BEFORE INSERT OR UPDATE` quando status entra em `cancelled`; alteração direta do campo é sobrescrita. `confirmed` posterior não reutiliza o fato, e recancelamento carimba novo instante. `revoke EXECUTE` da trigger function com assinatura completa. Sem backfill especulativo.
- [x] Pré-voo: timestamp nasce no servidor, spoof é ignorado, status revertido bloqueia, recancelamento troca o instante, cancelamento anterior à migration não vira novo envio após adoção; controle positivo removendo o trigger deve falhar. Conferir ACL e reaplicação idempotente.
- [x] Depois de autenticar o JWT e resolver a reserva, `hasUnitAccess` continua obrigatório antes de qualquer envio ou leitura de dado sensível.
- [x] Selecionar `legacy`/`managed`/`dependency` usando ledger antes de flag/adoção. `legacy` preserva texto e histórico; `managed` enfileira e despacha `cancellation` com auth interna; `dependency` recusa sem envio.
- [x] Reserva que voltou a `confirmed` antes do despacho termina bloqueada, sem POST. Sem `cancelled_at` válido, gerenciado recusa; duplicação e linha legada `failed` não causam segundo POST.
- [x] Testar adotada habilitada, adotada pausada, não adotada, ledger já existente, mudança de status e falhas de leitura.

### Task 3.3 — Mesa pronta no painel Fila

Arquivos: ação Edge autenticada de mesa pronta, migration de `waitlist.notified_at` e autoridade final, `_shared/whatsapp-automation-resources.ts`, `src/hooks/useWaitlist.ts`, `src/pages/operacional/Fila.tsx`, config da EF, pré-voo e testes de request/componente.

- [x] Migration transacional: trigger carimba `notified_at` com relógio SQL na transição `waiting→notified`, preserva em UPDATE lateral, limpa ao voltar a `waiting` e ignora valor enviado pelo caller; ACL mínima da trigger function. Não preencher fatos antigos por inferência.
- [x] Para job gerenciado de `waitlist_table_ready`, o preflight TS e `whatsapp_automation_post_core` final exigem `status='notified'`, `seated_at IS NULL`, `notified_at = job.fact_at` e `notified_server_at = job.fact_at`. O marcador anti-spoof prova que a transição ocorreu no servidor; isso endurece a elegibilidade `waiting/notified` da Fase 2 porque agora o produtor sempre muda o status antes de capturar. Reversão da operação cancela o POST.
- [x] A ação lê a entrada com service role, deriva a unidade dela, autentica JWT e usa `hasUnitAccess`; recusa telefone e `fact_at` vindos do corpo como autoridade.
- [x] Para unidade adotada, mudar `waiting`→`notified` com predicado de status e `.select()` de uma linha, gravar `notified_at` e o marcador anti-spoof `notified_server_at` no servidor, capturar `fact_at` depois da mudança e enfileirar/dispachar `waitlist_table_ready`.
- [x] Para unidade não adotada, manter o texto editável e o caminho legado; erro no gate ou no UPDATE não aciona fallback. Resultado de envio versus persistência do status permanece distinguível para a UI.
- [x] Dois cliques, recurso sentado/cancelado, reversão `notified→waiting` antes/depois da captura, spoof de `notified_at`, corrida de status entre captura e POST, e job já existente têm testes. Pré-voo SQL com controle positivo e reaplicação idempotente.

### Task 3.4 — Reenvios e conflito legado

Arquivos: `resend-notification/index.ts`, `send-scheduled-whatsapp/index.ts`, `src/hooks/useWaitlist.ts`, migration SQL somente se necessária para reconciliar `failed`, pré-voo local correspondente e testes.

- [x] `resend-notification` de mesa pronta usa `dispatch_existing` quando há job, sem reconstruir texto ou criar um novo fato; sem job, só o caminho legado comprovadamente não adotado.
- [x] `useResendWaitlistEntered` usa o endpoint único de reenvio para unidade adotada, em vez de chamar `send-whatsapp` diretamente; legado preserva o comportamento atual.
- [x] Resolver `notifications_sent.failed` pré-existente no aceite do ledger sem duplicar POST; teste SQL positivo e controle que falha se a reparação for removida.
- [x] Confirmar TTL da mesa pronta e autenticação/recurso em cada reenvio.

### Task 3.5 — Telas de Comunicação

Arquivos: `src/pages/gestao/fila/Comunicacao.tsx`, `src/pages/gestao/reservas/Comunicacao.tsx`, hooks de templates se necessários e `whatsapp-template-surfaces.test.tsx`.

- [x] Mesa pronta em modo oficial exibe `TemplateStatus` de `fila_mesa_pronta_v1`; em modo não oficial mantém editor manual.
- [x] Reservas ganha linha de cancelamento: `TemplateStatus` de `res_cancelada_v1` em modo oficial; texto legado editável só se já houver contrato de editor para esse evento, caso contrário indicação clara de mensagem automática.
- [x] Loading/erro de snapshot não revela editor TEXT; testes de unidade oficial/não oficial, troca de unidade e status bloqueado.

### Task 3.6 — Janela de atendimento de 24h

Arquivos: núcleo puro novo em `_shared/`, `send-manual-message/index.ts`, `src/pages/gestao/Conversas.tsx`, `src/hooks/useSendManualMessage.ts`, migration de ACL da conversa, pré-voo local e testes do núcleo/request/semântica da tela.

- [x] Núcleo decide a janela a partir do timestamp máximo entre as mensagens **recebidas do cliente** (`role='user'`) na conversa, mesmo se o JSONB vier fora de ordem; timestamp válido e relógio do servidor. Janela fecha em `>=24h`; sem mensagem recebida válida, fecha. `last_message_at` mistura papéis e não serve.
- [x] `send-manual-message` resolve o binding operacional real da unidade com `resolveUnitChannelBinding` e usa `isMetaShapedProvider`; para ele, 409 `OUTSIDE_SERVICE_WINDOW` antes do POST. UazAPI/Z-API preservam envio, inclusive com Datafy inativo. Nenhum erro de leitura vira janela aberta. A mensagem JSONB só é carregada depois da autorização do recurso.
- [x] A fonte `conversations.messages` é escrita só por serviço: migration revoga INSERT/DELETE e UPDATE de tabela de `public, anon, authenticated`, reabre UPDATE apenas das colunas de handoff usadas pelo painel e preserva service role. Pré-voo prova que membro não injeta inbound por INSERT/UPDATE, mas ainda altera o handoff autorizado.
- [x] Uma guarda síncrona revalida o prazo imediatamente antes do outbound, após I/O de credencial/conexão; Meta manual não faz retry automático que possa atravessar o prazo. O canal continua pinado ao binding validado.
- [x] Conversas usa a mesma semântica para mostrar aviso e desabilitar composer quando o canal oficial está fora da janela; aguarda detalhe canônico, bloqueia em erro/placeholder, reavalia o relógio mesmo sem Realtime e atualiza o snapshot do canal em foco/periodicamente. O backend permanece autoridade. Tratar 409 no hook com copy em PT-BR e refetch.
- [x] Testes de borda temporal, mensagens desordenadas, mensagem `human`/`assistant` posterior, timestamp inválido/futuro, canal não oficial, Datafy inativo, cruzamento do prazo antes do outbound e UI stale.

### Task 3.7 — Gates e review da fase

- [x] Implementer + review de spec + review de qualidade para **cada** task 3.1–3.6; corrigir achados antes da próxima task. Review da branch inteira ao fim.
- [x] `npm run typecheck`, testes focados e suíte completa, `npm run lint`, `npm run build`; `deno check` se disponível. Pré-voos SQL das Tasks 3.2, 3.3 e 3.4 com controles positivos.
- [ ] Gates `saas-shield-br`: migration-validator se houver SQL; rls-auditor, tenant-isolation-auditor, identity-access-auditor, integration-reliability-auditor e secret-hunter. Conferir o `acl-estatico` local se houver função SQL. Executados; permanece o FAIL estrito de RLS herdado, detalhado nas evidências.
- [x] Revisar `git status`, `git diff`, `git diff --cached` integral, varrer segredos staged; `git add <caminhos>` explícitos e commit somente dos caminhos da Fase 3, preservando o staged alheio.

### Task 3.8 — Checkpoint e handoff

- [x] Marcar os checkboxes concluídos, registrar comandos/resultados/desvios/limites em "Evidências → Fase 3", atualizar memória do projeto e entregar o prompt da Fase 4.

## Fase 4 — Opt-in de marketing

Escopo da spec §8. Cada task usa implementer, review de spec e review de qualidade, com correção dos achados antes da próxima task. O fluxo público nunca cria consentimento por omissão: só `marketing_opt_in === true` registra `opt_in`. Falha do registro é observável e não desfaz uma reserva ou entrada de fila já persistida.

### Task 4.1 — Autoridade SQL do consentimento público

Arquivo: migration nova criada com `supabase migration new`, depois de `20261017160000`. Basear guardas, lock do cliente, revisão e auditoria em `record_whatsapp_message_consent` da `20261009153435`, sem ampliar a ACL dessa RPC de gestão.

- [x] Criar `public.record_public_promotional_opt_in(p_unit_id uuid, p_customer_id uuid, p_reference text)` com `security definer` e `set search_path=''`, retornando a revisão inserida.
- [x] Guardar na função: unidade `is_public=true`, organização pública, cliente vivo (`deleted_at is null`) na mesma organização, referência não vazia e limitada, sem caracteres de controle nem token/link de preferências. Recurso ausente e alheio recebem a mesma recusa sem oráculo.
- [x] Aceitar somente referências geradas pelo servidor para reserva/fila (`reservation:<uuid>;form:v1` ou `waitlist:<uuid>;form:v1`) e conferir que o recurso citado pertence à unidade e ao cliente; nunca confiar só no prefixo recebido.
- [x] Inserir somente `purpose='promotional'`, `decision='opt_in'`, `source_code='public_form'`, `actor_id=null`, `observed_at` do servidor; manter revisão append-only e audit_log sem telefone ou segredo.
- [x] Sob o lock do cliente, repetir a mesma referência `public_form` devolve a revisão original sem novo insert/audit: um retry depois de opt-out não pode reativar ofertas. Uma nova reserva/entrada pode registrar nova escolha.
- [x] `revoke all` da assinatura completa para `public, anon, authenticated, service_role`; `grant execute` somente a `service_role`. Aplicar duas vezes no pré-voo para provar idempotência/ACL.

### Task 4.2 — Pré-voo SQL 68

Arquivos: `supabase/tests/local-preflight/68-*` e README. Usar cluster PostgreSQL Supabase descartável e isolado, na cadeia de bootstrap documentada; não consultar nem modificar o banco de produção.

- [x] Casos verdes: reserva e fila válidas geram revisão/linha promocional com `public_form`, ator nulo e audit_log; opt-out anterior permanece no histórico; vínculo de unidade/cliente/recurso correto.
- [x] Casos de recusa: unidade/org privadas, cliente apagado ou de outra organização, recurso ausente/alheio, tipo/referência forjados, referência vazia/controle/longa, papéis `anon`/`authenticated` sem EXECUTE.
- [x] Controle positivo: enfraquecer uma guarda em transação revertida deve tornar ao menos um caso vermelho; conferir ACL antes/depois e reaplicar migration duas vezes.

### Task 4.3 — Reserva pública

Arquivos: `supabase/functions/create-reservation/index.ts` e testes de núcleo/contrato.

- [x] Aceitar `marketing_opt_in` apenas quando o JSON contém boolean literal `true`; ausência, `false`, string e número não registram consentimento.
- [x] Após sucesso de `reserveSlot`, chamar a RPC com `reservation:<reservationId>;form:v1` e o cliente resolvido. A falha de escrita produz log estruturado e métrica/evento sem PII; a resposta de reserva continua bem-sucedida.
- [x] Cobrir sucesso, ausência de checkbox, falha da RPC e não criação de evento quando a reserva falha. Preservar validações atuais de unidade/organização e caução.

### Task 4.4 — Entrada pública na fila por Edge Function

Arquivos: EF pública nova, núcleo puro testável, `supabase/config.toml`, `src/hooks/useWaitlist.ts` e testes. A entrada autenticada do painel continua na RPC atual.

- [x] Definir contrato POST/OPTIONS com CORS de `create-reservation`, `verify_jwt=false`, campos da fila estritamente validados e resposta compatível com o código/senha atual; não ecoar dados pessoais.
- [x] Antes de escrever, resolver unidade e organização públicas do banco, conferir billing/estado aplicável e usar rate limit por IP serializado por chave na migration `20261017173000` (falha de leitura fecha). A EF usa `service_role`, mas o tenant vem da unidade resolvida, nunca de `organization_id` do body.
- [x] Fechar caminhos diretos de `anon` (`EXECUTE` de `enter_waitlist`, `INSERT`/policy da tabela) e chamar a nova RPC de entrada pública executável só por `service_role`. Ela retém locks de unidade e organização públicas até o insert atômico de senha, reaproveitando a lógica de `enter_waitlist`; a entrada autenticada do painel permanece. Essa correção é necessária porque o cliente poderia chamar a RPC/tabela diretamente e contornar rate limit e cadastro da EF.
- [x] Após sucesso, resolver/criar cliente por telefone canônico na organização com `service_role`, e ligar `waitlist.customer_id` por escrita com predicado de unidade e verificação da linha afetada.
- [x] Só com `marketing_opt_in === true`, chamar a RPC da Task 4.1 com `waitlist:<id>;form:v1`. Falha pós-entrada (cadastro/vínculo/consentimento) fica observável, sem duplicar entrada nem afirmar consentimento; documentar resposta e retry operacional.
- [x] Cobrir unidade/org privadas, rate limit, telefone inválido, entrada recusada, cadastro existente/novo, race de vínculo, opt-in literal e falhas parciais. O caminho público do hook passa pela EF; a operação interna mantém `enter_waitlist` direto.

### Task 4.5 — Checkbox nos formulários

Arquivos: `StepGuestInfo`, estado e envio de `useReservaWizard`, `WaitlistFormPublic` e testes de componentes/contrato. `/r/:slug` e `/w/:slug` compartilham o wizard.

- [x] Checkbox individual desmarcado por padrão com a copy da spec §8 e nome da unidade escapado como texto; não confundir aceite de termos ou notificação operacional com marketing.
- [x] Estado/Zod `boolean().default(false)` para fila; transportar boolean literal no payload da fila e da reserva; limpar/resetar ao reiniciar o formulário ou trocar de unidade.
- [x] Testar os dois portais de reserva e a fila: padrão OFF, ON explícito, envio e ausência de opt-in após reset. Verificar acessibilidade do label e estado do checkbox.

### Task 4.6 — Status em Clientes

Arquivos: `src/pages/gestao/Clientes.tsx`, hook `consent_snapshot` existente e testes.

- [x] No detalhe do cliente, para owner/gerente da unidade corrente, ler `promotional` via `consent_snapshot` e mostrar `opt_in`, `opt_out` ou desconhecido em linguagem clara; estados de loading/erro não parecem consentimento.
- [x] Não criar ação de gravação nessa tela. O registro manual permanece em Giftback, com as três origens atuais.
- [x] Testar troca de unidade/cliente sem estado antigo, autorização/visibilidade e falha da consulta.

### Task 4.7 — Gates, documentação e checkpoint

- [x] Reviews de spec/qualidade por task e review da branch inteira; corrigir todos os bloqueantes.
- [x] Pré-voos 68 e 69 com controles positivos, incluindo concorrência e ACL efetiva da entrada/limite público; testes focados; `npm run typecheck`, suíte completa (excluindo só o `node:test` conhecido), `npm run lint`, `npm run build`, `git diff --check`; `deno check` se disponível.
- [ ] Seis gates `saas-shield-br` (migration, RLS, tenant, identidade, integrações, segredos), guardas locais de `acl-estatico` e grafo de imports. Registrar separadamente o FAIL de baseline FORCE RLS herdado da Fase 3 e não fazer merge/deploy com gate vermelho.
- [x] Atualizar regras de assunto e par `CLAUDE.md`/`AGENTS.md` apenas para invariantes futuros; matriz de deploy/runbook se necessário. Conferir `git status`, diff integral, staged integral e segredos; `git add` por caminho explícito; commit local.
- [x] Marcar checkboxes concluídos, registrar comandos/resultados/desvios/limites em Evidências → Fase 4, atualizar memória e entregar prompt exato da Fase 5. Sem push, merge, `db push`, deploy ou chamada paga a provider.

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

### Fase 3

Implementada localmente em 2026-10-16, sem push, merge, `db push`, deploy ou chamada a provider. A ordem continua SQL → EFs dependentes → frontend, coordenada na Fase 5; o redeploy de `process-whatsapp-templates` ainda exige autorização nominal por poder submeter os dois modelos à Meta nas contas com catálogo habilitado.

**Entregue:**
- Produtor gerenciado dedicado para `cancellation` e `waitlist_table_ready`, com JWT + chave interna, unidade derivada do recurso, `hasUnitAccess` e ledger lido antes de status/flag mutáveis. O produtor genérico ainda recusa novos fatos desses kinds.
- Migrations `20261017130000`–`1600`: fato `cancelled_at` sem backfill, fato `notified_at`/`notified_server_at` da transição de mesa pronta, adoção de notificação legada `failed` sem segundo POST e ACL de `conversations.messages` escrita só por serviço.
- `send-cancellation` e ação autenticada `notify-waitlist-ready` escolhem legado ou job/template pela adoção e recusam dependência indisponível sem fallback. Reenvio usa job existente; Comunicação mostra os modelos oficiais; envio manual Meta fecha aos 24h do último inbound e revalida imediatamente antes do POST, sem retry automático.
- O segundo ciclo cancelar→reativar→cancelar conserva o job anterior pela chave única; preflight TS e guard SQL exigem `cancelled_at=job.fact_at` antes de qualquer POST pendente. Não cria uma segunda mensagem.

**Evidências e gates:**
- Implementer, review de spec e review de qualidade por task 3.1–3.6; os achados foram corrigidos antes do fechamento. Review independente da branch: nenhum achado novo acionável.
- Pré-voos SQL `67`, `67b`, `67c` e `67d` em PostgreSQL Supabase descartável e exclusivo, verdes na aplicação inicial e após duas reaplicações; controles positivos incluem trigger removida, recancelamento sem comparação do fato, conflito legado e grants indevidos de `UPDATE`/`INSERT` por coluna. `67b` fez 37 checagens; os contêineres próprios foram removidos.
- Guardas estáticas `acl-estatico` e grafo de imports: 99/99; `node --test supabase/tests/local-preflight/local-runtime-paths.test.mjs`: 3/3. `npm run typecheck`: 0 erros; `npm run lint`: 0 erros, 18 avisos de baseline; `npm run build`: ok; `git diff --check`: ok.
- Suíte completa (`npx vitest run --maxWorkers=1 --minWorkers=1 --exclude supabase/tests/local-preflight/local-runtime-paths.test.mjs`): **3.540/3.540**, 136/136 arquivos. A primeira passagem teve um teste vermelho porque a fixture ignorava `gate=false`; a fixture/expectativa foi corrigida, 244 testes focados passaram e a suíte integral repetida fechou verde.
- Os seis gates de `saas-shield-br` foram executados por subagents com os contratos locais do plugin (o runtime nativo não está instalado neste Codex). `migration-validator`: PASS_WITH_WARNINGS (P3 documental de reversão); `tenant-isolation-auditor`: PASS após corrigir o oráculo ausente/alheio; `identity-access-auditor`: PASS; `integration-reliability-auditor`: PASS_WITH_WARNINGS, com recancelamento corrigido e limitação do legado documentada; `secret-hunter`: PASS, 48 arquivos e 3.425 linhas staged (última linha de evidência conferida separadamente), sem segredo.
- `rls-auditor`: diff da Fase 3 PASS após revogar também grants por coluna. O contrato estrito segue **FAIL por baseline herdado do HEAD**: `reservations`, `waitlist`, `conversations` e `notifications_sent` têm `ENABLE RLS`, mas não `FORCE RLS`. Nenhuma regressão nova foi identificada. Não aplicar migrations nem fazer merge com esse gate vermelho; avaliar `FORCE` em spec própria e conferir ACL efetivo no alvo antes do rollout.

**Limites:**
- O legado de mesa pronta envia antes de persistir `notified`: concorrência ou falha após aceite pode repetir POST. `statusUpdated:false` expõe falha parcial; operador deve conferir recibo e provider antes de novo envio. O caminho gerenciado usa CAS antes do despacho.
- O PostgreSQL local não prova a rede/provider nem concorrência real; `deno check`, `gitleaks`, `acl-estatico` remoto e auditoria do banco vivo não foram executados (ferramentas ausentes ou dependência de autorização/PR). `local-runtime-paths.test.mjs` é `node:test` e deve ser excluído do Vitest, como nas fases anteriores.

### Fase 4

Implementada localmente em 2026-10-16 na branch `feat/datafy-migracao-uazapi`, sem push, merge, `db push`, deploy ou chamada paga a provider. Migrations e EFs ficam para o rollout coordenado da Fase 5.

**Entregue:**
- Migration `20261017170000`: `record_public_promotional_opt_in` executável só por `service_role`, com cliente vivo, unidade/organização públicas, recurso de reserva/fila vinculado, revisão append-only e replay da mesma referência sem reativar opt-out posterior.
- Migration `20261017173000`: entrada direta `anon` por RPC/tabela fechada; wrapper `enter_public_waitlist` exclusivo de serviço guarda unidade/organização públicas na transação da senha; limite de IP serializado por unidade/chave. A entrada autenticada do painel permanece. O adendo de segurança da spec explica a mudança de autoridade necessária para impedir o bypass da EF.
- `create-reservation` aceita apenas `marketing_opt_in === true` após reserva persistida, limita a tentativa de consentimento a 2 s e registra falha sem PII, com ids de unidade/reserva. Como guard de serviço público, passa a recusar unidade/organização privadas e falhar fechado em leituras de escopo e limite.
- `public-waitlist` valida entrada/telefone, deriva a organização da unidade, usa IP de `CF-Connecting-IP` com parse estrito e fail-closed, cria/vincula cliente após a senha atômica e registra opt-in literal. Falha posterior devolve a senha com aviso e log correlacionável, sem pedir novo envio. O hook público chama a EF; o painel continua na RPC autenticada.
- Wizard `/r` e widget `/w`, fila pública e detalhe de Clientes ganharam checkbox individual OFF por padrão ou status promocional somente leitura, conforme a superfície. O runbook descreve a ordem de rollout e a reconciliação de falhas parciais.

**Reviews e pré-voos:**
- Implementer, review de spec e review de qualidade por Task 4.1–4.6; achados de replay após opt-out, fixtures privadas falsas, cabeçalho IP forjável, corrida do limitador, bypass anônimo e rastreio de falha parcial foram corrigidos. Rechecks das Tasks 4.3 e 4.4 e review independente da branch passaram, com ressalvas operacionais abaixo.
- Pré-voo 68: migration aplicada três vezes em PostgreSQL Supabase 17.11 descartável, teste verde 3/3, controles positivos de vínculo/visibilidade e ACL efetiva. Pré-voo 69: migration aplicada três vezes, ACL efetiva de anon/authenticated/service_role, `INSERT` por tabela/coluna, guardas de unidade/org e controles positivos verdes 3/3. Sete sessões reais observaram espera por lock: **5/7** aceitas; o corpo inseguro count-then-insert do controle aceitou **7/7**. Contêineres próprios removidos; nenhuma conexão de produção.

**Gates e limites:**
- Guardas locais de `acl-estatico`/migration/advisor: 93/93; `node --test supabase/tests/local-preflight/local-runtime-paths.test.mjs`: 3/3. Grafo de import: `public-br-phone.ts` alcança só `public-waitlist`. `npm run typecheck`: 0 erros; `npm run lint`: 0 erros e 18 avisos de baseline; `npm run build`: ok; `git diff --check`: ok. Suíte integral com um worker, excluindo apenas o `node:test` conhecido: **3.581/3.581 testes, 145/145 arquivos**. A primeira tentativa em paralelo sofreu dois timeouts de testes antigos sob carga; a repetição serial fechou verde.
- Gates `saas-shield-br` executados por revisão independente com contratos locais, pois o plugin nativo não está instalado neste Codex: migration-validator **PASS local**, tenant-isolation **PASS no diff**, identity-access **PASS local** (prova do gateway pendente), integration-reliability **PASS_WITH_WARNINGS**, secret-hunter **PASS no diff**, RLS **FAIL herdado**. O gate estrito exige `FORCE RLS`: além de `reservations`, `waitlist`, `conversations` e `notifications_sent` já documentadas na Fase 3, `rate_limit_events` também tem apenas `ENABLE RLS` nas migrations. O estado vivo ainda precisa de auditoria. **Não fazer merge ou deploy com esse gate vermelho.**
- `supabase` CLI, `deno check` e `gitleaks` não estavam disponíveis; migrations foram criadas como arquivos locais, e `acl-estatico` remoto/ACL do banco vivo ficaram para a Fase 5. O 69 usa stub de `enter_waitlist`: prova ACL e wrapper isolados, mas não membership real do painel/PostgREST. Antes do corte, validar que o gateway hospedado fornece e sobrescreve `CF-Connecting-IP`; sua ausência fecharia a fila com 503. Revogar anon no banco antes do frontend novo causa uma janela de indisponibilidade do formulário antigo, que exige rollout coordenado. Nenhum destes pontos foi testado em produção nesta fase.

**Checkpoint do commit:** `git status` confirmou só os 37 caminhos da Fase 4 staged, nenhum unstaged; `git diff --cached`/`--stat` revisados (2.233 linhas adicionadas, 68 removidas) e `git diff --cached --check` limpo. A varredura de todas as 2.233 linhas adicionadas staged pelos prefixos/atribuições/URLs de credenciais, headers e hex longo retornou zero candidatos; os 13 matches genéricos de `password`/`senha`/`secret`/`token` são texto de plano/runbook/UI, token negativo de fixture ou senha da fila. `service_role` aparece apenas como papel/identificador. Commit local sem push.
