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

### Task 1.1 — Migration `20261016182000_datafy_migration_grant.sql`

Arquivo: `supabase/migrations/20261016182000_datafy_migration_grant.sql`. Na execução local da Fase 1 o arquivo se chamava `20261016120000_datafy_migration_grant.sql`; passou a `20261016140200` quando o alvo já tinha `20261016140000`/`20261016140100` de `main` e agora a `20261016182000` após a integração de `20261016180000`/`20261016181000`, também já aplicadas. A última mudança alterou só o nome, sem alterar o SQL. O `BEGIN`/`COMMIT` vai explícito no arquivo, por causa da atomicidade entre statements.

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

O fechamento da fase separa preparação local de operações no alvo. A spec principal não autorizava alterar o comportamento de RLS das cinco tabelas herdadas; a spec específica `2026-10-16-force-rls-baseline-design.md` recebeu aprovação para implementação local em 2026-10-16. Enquanto o gate estrito de RLS permanecer vermelho no alvo, o rollout é **NO-GO**. Para qualquer implementação, usar implementer, review de spec e review de qualidade por task, corrigir achados e revisar a branch inteira.

### Task 5.1 — Baseline e spec da correção FORCE RLS

Arquivos: spec própria em `docs/superpowers/specs/`, migrations e policies existentes das cinco tabelas, `.claude/rules/banco-de-dados.md`.

- [x] Levantar, sem banco de produção, o estado derivado das migrations de `reservations`, `waitlist`, `conversations`, `notifications_sent` e `rate_limit_events`: owner, RLS, policies, grants de tabela/coluna e funções `SECURITY DEFINER` que as acessam. Distinguir explicitamente fato local de estado vivo ainda não conferido.
- [x] Escrever uma spec revisável com efeito esperado de `FORCE` para owner, `service_role`/`BYPASSRLS`, funções e fluxos anon/autenticado; casos de regressão; ordem, reversão forward-only e critério NO-GO. **Pedir aprovação da spec antes de criar migration, teste que mude contrato ou código.** Aprovada em 2026-10-16 somente para implementação local.
- [x] Após aprovação: implementar migration idempotente das cinco tabelas, com harness SQL descartável, controles positivos de owner sem `BYPASSRLS`, anon, membro, admin e service role. Implementer + reviews de spec e qualidade por task; registrar hash da aprovação e resultado. A prova é local; owners, funções e ACL do alvo continuam pendentes.

### Task 5.2 — Gates integrados locais

- [x] Conferir SHA, base `origin/main`, árvore de trabalho, migrations locais em ordem e `git diff origin/main...HEAD`; review funcional e de segurança da branch inteira, incluindo riscos aceitos das Fases 1–4. Migrations efetivamente pendentes no alvo exigem leitura autorizada separada.
- [x] Rodar `npm run typecheck`, suíte Vitest completa com um worker (excluir apenas `local-runtime-paths.test.mjs`, executado por `node --test`), `npm run lint`, `npm run build`, `git diff --check` e `deno check` nas EFs afetadas se disponível. Registrar contagens, versões, warnings e falhas reais. `deno` indisponível; as demais execuções estão em Evidências → Fase 5.
- [x] Reexecutar em PostgreSQL Supabase descartável os pré-voos aplicáveis, 65/66/67/67b/67c/67d/68/69 e controles positivos; aplicar cada migration nova inicialmente e mais duas vezes sem `psql -1`; conferir ACL efetiva e descartar o ambiente. 61–63 foram regressões no 65; 64 cobre alertas operacionais sem mudança nesta branch. A prova 69 de concorrência foi repetida nesta fase, sem usar o contêiner da Fase 4.
- [x] Rodar guardas locais do `acl-estatico`, teste do grafo de imports e auditoria de segredos do staged; o `acl-estatico` remoto só pode ser marcado após PR/Checks. Auditoria de ACL do banco alvo depende de procedimento e autorização próprios.

### Task 5.3 — Seis gates de segurança e review

- [x] Executar revisão equivalente local de `migration-validator` para todas as migrations da branch, `rls-auditor` para schema/policies finais, `tenant-isolation-auditor`, `identity-access-auditor`, `integration-reliability-auditor` e `secret-hunter` no diff integrado. Registrar PASS/FAIL, escopo e limitação do runtime nativo; o plugin `saas-shield-br` não está disponível neste host e seu gate nativo segue pendente para merge.
- [x] Resolver achados bloqueantes locais, repetir gates impactados e review da branch. O FAIL herdado de FORCE RLS fechou somente no escopo de fonte/fixture após spec aprovada e prova local; estado vivo, ACL remoto e gateway permanecem gates distintos e **NO-GO** para rollout.
- [x] Repetir os seis gates do plugin nativo `saas-shield-br` no diff final da branch e o review integrado após corrigir o P1 de intenção Datafy com legado NULL sem binding. A emenda de segurança `2026-10-16-datafy-offline-legacy-cutover-guard-amendment.md` foi aprovada pelo responsável apenas para correção local. Resultado e limites em Evidências → Fase 5; CI e estado vivo continuam gates separados.

### Task 5.4 — Matriz de rollout e janela da fila pública

- [x] Enumerar migrations pendentes em ordem estrita de filename, conferir dependências SQL→EF e checar `supabase db push --dry-run` apenas no alvo autorizado. Não usar Studio nem `--include-all` para contornar ordem.
  - O dry-run anterior passou quando a Datafy se chamava `20261016140200`. Depois, o alvo aplicou `20261016180000` e `20261016181000` de `main`; o primeiro dry-run após a integração recusou a ordem com `DbPushMissingRemoteError`. A migration Datafy foi renomeada localmente para `20261016182000`, com SQL idêntico. O segundo dry-run (CLI 2.120.0, `--skip-vault`, projeto `gbabxcrntkwgblgqsiit`) terminou com código 0 e listou exatamente as nove migrations da matriz atual, sem SQL aplicado.
- [x] Calcular a união das EFs afetadas pelo diff da branch com `node scripts/ef-import-graph.mjs --json <shared...>` mais `index.ts` alterados diretamente; registrar comando, entrada, resultado, `verify_jwt` e ordem. Evitar redeploy por prefixo.
- [x] Definir a sequência banco/ACL → EFs não submetedoras exceto `manage-whatsapp-templates` → merge/frontend tolerante em Vercel `READY` → `manage-whatsapp-templates` → `process-whatsapp-templates` sob autorização própria → observação. O frontend antigo rejeita snapshot de nove modelos. Sem autorização própria, reter o último bundle; pausar `catalog` é mitigação administrativa com autorização separada e não substitui a autorização do redeploy.
- [x] Descrever janela de indisponibilidade do frontend antigo da fila: após revogar `anon` em `enter_waitlist`/`waitlist` e antes de Vercel `READY` do frontend novo, o formulário antigo falha. Prever agendamento de horário e responsável, aviso, monitoramento, critério de abortar e reparo forward-only; não prometer duração fixa. A marcação efetiva da janela fica na Task 5.5.
- [x] Planejar prova do `CF-Connecting-IP` no gateway hospedado **antes de liberar a fila nova**: endpoint/sonda sem mutação, cabeçalho recebido de cliente normal, tentativa de valor forjado e confirmação de overwrite/remoção **ou rejeição comprovada antes do handler**, conforme emenda aprovada; definir evidência redigida sem IP pessoal. Ausência ou confiança em valor forjado é NO-GO. A execução da prova fica na Task 5.5.

### Task 5.5 — Pré-voos do alvo, somente com autorização explícita

- [x] Confirmar ambiente, SHA, migrations aplicadas, backup, dono da janela e permissões. Executar consultas somente leitura para conflitos de `phone_number_id`, ownership WABA, RLS/`relforcerowsecurity`, owners/`BYPASSRLS`, grants, policies e ACL; reconciliar discrepância antes de qualquer escrita.
  - Primeira leitura histórica do alvo: projeto `Moralles Reservas` (`gbabxcrntkwgblgqsiit`), SHA integrado `f9b68d6` e HEAD documental `4f8045e`; 165 migrations até `20261016140100`, nove pendentes naquele dry-run. Backup físico `COMPLETED` de 02h53 BRT, PITR OFF; o responsável aceitou expressamente esse ponto de recuperação em 2026-10-16. O mesmo responsável confirma tecnicamente e pela Ren Sushi. As consultas de conflitos, owners/`BYPASSRLS`, RLS/FORCE, policies, grants e ACL estão em Evidências abaixo. Esta fotografia não é o estado final: imediatamente antes da escrita havia 167 migrations aplicadas; após o `db push`, 176 e nenhum pending, conforme evidência de 2026-10-17 ao fim da seção.
- [x] Conferir `acl-estatico` na aba Checks do PR após o push do código integrado: historicamente, no SHA `876e8a9`, o run `39043059352` passou; após o ajuste pós-SQL da allowlist, o run final `39044052797` passou em `ec8cead`. Prévia Vercel `SUCCESS`, PR #30 `CLEAN/MERGEABLE` antes do merge. `acl-com-banco` foi `SKIPPED` conforme escopo manual não produtivo, sem substituir a auditoria efetiva abaixo.
- [x] Executar auditoria efetiva via `scripts/audit-function-acl.ts` no alvo autorizado. Primeira leitura pré-SQL: Deno código 0, 155 funções, 27 entradas na allowlist, lints 0028=10/0029=25, zero violações. Auditoria final pós-SQL e ajuste revisado da allowlist: Deno código 0, 159 funções, 27 entradas, 0028=9/0029=25, zero violações; detalhes em Evidências. O job `acl-com-banco` permanece SKIPPED por ser manual para alvo não produtivo.
- [x] Validar o contrato do gateway `CF-Connecting-IP` sem criar senha de fila nem outro dado; anexar resultado ao go/no-go. O responsável aceitou expressamente em 2026-10-16 o critério alternativo de rejeição 403 anterior à sonda, limitado à rota/origem testadas; evidência e limites na emenda e abaixo. A extensão à fila pelo ingresso compartilhado é inferência, sujeita a smoke após o deploy autorizado. Commit `2d7678c` retirou código/configuração da branch; `git ls-tree` e `git show HEAD:supabase/config.toml` confirmaram ausência da sonda no HEAD.
- [x] Reconfirmar com o responsável a janela da fila imediatamente antes da escrita, o aviso aos operadores, o monitoramento e a resposta a sessões antigas até Vercel `READY`. O responsável respondeu expressamente `janela confirmada agora` em 2026-10-17, assumindo aviso e acompanhamento da Ren Sushi; evidência temporal abaixo.

### Task 5.6 — Rollout, somente com autorizações explícitas e gates verdes

- [x] Com aprovação de produção para cada classe de ação: `supabase db push` na ordem conferida, auditar ACL/RLS efetivos, deploy das EFs da matriz na ordem da Task 5.4 e smoke sem custo; `manage-whatsapp-templates` só após frontend `READY`. Não foi criada liberação Datafy na janela SQL→bundle. O ACL pós-SQL exigiu ajuste de expectativa da allowlist, revisado e aprovado em CI antes dos bundles.
- [x] Obter autorização **própria** para redeploy de `process-whatsapp-templates`, que pode submeter `fila_mesa_pronta_v1` e `res_cancelada_v1` em toda conta com catálogo liberado, inclusive Moralles. O responsável a concedeu expressamente em 2026-10-17; o deploy ocorreu só depois, com catálogo e despacho OFF e zero contas de templates no snapshot.
- [x] Com autorização de merge, integrar o PR; conferir Vercel `READY`, frontend novo, fila pública, reservas e fluxos de templates sem provocar envio pago. Os smokes foram deliberadamente sem mutação: GET `/r` 200, `public-waitlist` e `create-reservation` com `{}` 400 `invalid_input`, gestão de templates sem autenticação 401; flags OFF e zero contas/jobs/registros em `whatsapp_remote_templates`. Isso prova rotas, parser e guarda de acesso, mas não uma inscrição, reserva, GET no provider ou envio real.

### Task 5.7 — Evidências, commit e handoff

- [x] Atualizar runbook e Evidências → Fase 5 com matriz, comandos/resultados, limites e decisões; marcar somente checks comprovados. Atualizar memória com SHA e próximo passo após o commit local.
- [x] Antes do commit: `git status`, `git diff`, `git diff --cached` integral, `git diff --cached --check` e varredura de segredos em toda linha staged. `git add` de caminhos explícitos; commit local. Sem push, merge, `db push`, deploy, banco de produção ou provider fora de autorização.
- [x] Entregar prompt da Fase 6 com os gates ainda pendentes destacados; a operação da loja começa só após rollout concluído e aprovações nominais de custo/canal.

## Fase 6 — Operação do Ren Sushi (com o responsável e a loja)

Spec §10. Executar task por task com o responsável técnico e a loja (a mesma pessoa se declarou responsável por ambos). Nenhuma autorização da Fase 5 libera conexão, assinatura, submissão à Meta, envio pago, troca de canal ou desconexão. Antes de **cada** operação paga ou destrutiva, mostrar unidade, id/nome exato do canal remoto quando já existir, canal UazAPI substituído, efeito e custo vigente, e colher confirmação específica. A spec §11 registra R$ 49,90/mês proporcional para Datafy e cobrança Meta por template, mas valores e categoria devem ser reconfirmados no momento; não inferir preço atual da spec. Se identidade, custo, titularidade, eco ou resultado remoto estiverem incertos, parar e reconciliar pelo runbook, sem repetir POST às cegas. Evidência sempre redigida, sem telefone, token, QR, conteúdo de conversa ou dados pessoais.

### Task 6.1 — Pré-corte: versão, alvo e janela

Responsáveis: agente faz leitura e registra gates; responsável/loja confirma aparelho, acesso Meta, operadores e janela.

- [x] Conferir a versão publicada antes de qualquer ação: Vercel produção `READY` no SHA `ac2c3b4`, GET `/r` 200, 19 EFs da matriz `ACTIVE`, 176 migrations aplicadas. Evidência da Fase 5 abaixo.
- [x] Ler sem mutação o estado inicial da Ren Sushi: unidade `9dc55e51-99b2-4536-b596-d25b88946b44`, UazAPI `a633d938-68c6-4658-9d24-6e6d8f1a3c6f` `connected`/ativa; zero liberação ativa, onboarding ou canal Datafy; catálogo/dispatch OFF. Confirmado em 2026-10-17, antes de operar a loja.
- [x] Responsável/loja confirma versão 2.24.17+ do WhatsApp Business no aparelho, acesso de administrador à empresa Meta e disponibilidade para acompanhar agora o intervalo sem inbound na plataforma entre conexão Datafy e novo QR UazAPI. Confirmado expressamente em 2026-10-17; reconfirmar a janela imediatamente antes da conexão.
- [ ] Responsável/loja confirma número e empresa Meta exatos no painel antes da conexão, sem expô-los na evidência. Identidade divergente é NO-GO.
- [ ] Conferir titularidade e custo atual da conta Datafy e condições Meta no painel oficial com o responsável; registrar moeda, periodicidade, proporcionalidade e pagador. Definir janela e ponto de abortar se a UazAPI não revincular. Esta leitura não é autorização de contratação.
- [ ] Conferir conta Datafy ativa/adimplente, token de conta configurado sem ler seu valor, allowance de provisionamento e endpoint HTTPS de alertas operacionais configurado/testado pelo fluxo aprovado. Falha ou ausência bloqueia a conexão até resolver; não registrar segredos ou endpoint.

### Task 6.2 — Pré-corte: liberação de migração presa ao canal

Responsáveis: agente confere precondições; responsável como `platform_admin` executa/autoriza na unidade certa; loja acompanha.

- [ ] Revalidar canal UazAPI operacional e liberação anterior. Se houver liberação comum não consumida, revogá-la apenas com autorização específica e conferir efeito; nunca reaproveitá-la como liberação de migração.
- [ ] Após confirmação nominal da unidade e do canal substituído, **Liberar migração para oficial** no admin. Conferir por leitura que o grant novo tem `replaces_channel_id` igual ao UazAPI confirmado, está não consumido e não revogado; divergência é NO-GO.
- [ ] Registrar ator, horário, id da liberação e snapshot dos guards sem credencial. Não criar uma segunda liberação se a resposta da primeira for incerta.

### Task 6.3 — Pré-corte: conectar Datafy e religar UazAPI

Responsáveis: responsável aprova cada efeito/custo e orienta; loja conecta o número pelo WhatsApp Business e escaneia o QR; agente observa estado sem guardar QR.

- [ ] Antes de **Conectar WhatsApp oficial**, confirmar nominalmente Ren Sushi, canal UazAPI substituído, número/empresa e custo/efeito: a conexão Meta desvincula os aparelhos e derruba temporariamente a UazAPI. Obter autorização própria para essa interrupção e eventual criação remota; verificar que o grant da Task 6.2 ainda corresponde ao binding atual.
- [ ] Loja conclui a janela Datafy; se houver timeout/409/resposta incerta, usar a reconciliação do runbook por GET/listagem, sem novo POST cego ou troca de grant. Conferir nome e id do canal remoto quando descobertos, WABA/organização e canal local, sem registrar telefone ou token.
- [ ] Logo após a queda, gerar novo QR no cartão **Conexão atual** e pedir à loja que escaneie; confirmar UazAPI `connected`/ativa e inbound operacional. Até isso, não prosseguir para assinatura/corte; mensagens no intervalo precisam de conferência pelo responsável no aparelho.

### Task 6.4 — Pré-corte: assinatura, eco e retenção do corte

Responsáveis: responsável autoriza assinatura com custo vigente e canal Datafy identificado; loja produz eco pelo app; agente confere fatos e guards.

- [ ] Antes de **Já concluí a conexão**, conferir nome/id exato do canal remoto, unidade, WABA, estado de assinatura e preço vigente da Datafy; obter autorização específica para a assinatura potencialmente cobrada. A spec cita R$ 49,90/mês proporcional, sujeito a reconfirmação. Timeout/incerteza exige GET/listagem e reconciliação antes de repetir.
- [ ] Confirmar assinatura remota e persistida no mesmo canal; loja envia uma mensagem pelo app ou UazAPI revinculada para produzir eco de coexistência, com destinatário controlado e autorização explícita se o envio puder gerar cobrança. Não usar GET ou `postMessage` como prova de eco.
- [ ] Conferir `awaiting_cutover`, Datafy conectado porém inativo/sem intenção, UazAPI ativa e eco registrado; sem esses quatro fatos, NO-GO para catálogo/corte. Registrar horário e identificadores redigidos, nunca conteúdo da mensagem.

### Task 6.5 — Templates com a UazAPI ainda operacional

Responsáveis: responsável autoriza flags, escopo e eventuais submissões/custos; loja confirma conta Meta e categorias; agente confere jobs e eventos.

- [ ] Confirmar conta WABA, binding Datafy, `awaiting_cutover`, nove IDs/hash/idioma `pt_BR` e ausência de conflito homônimo. Antes de habilitar `whatsapp_template_catalog`, obter autorização específica para o efeito global: o worker pode atuar em toda conta com catálogo liberado, não só na Ren Sushi.
- [ ] Habilitar a flag global somente após conferir o alcance em todas as contas; liberar `catalog` apenas no canal Datafy nominalmente confirmado, com geração/revisão atuais e autorização específica para possível submissão de nove modelos à Meta. Se escopo não puder ser limitado, NO-GO. Registrar snapshot anterior/posterior.
- [ ] Solicitar sync dos nove uma vez pelo painel; registrar id do request/job e conciliar eventual resultado incerto antes de novo POST. Conferir por nome, idioma, hash, categoria pedida e **categoria efetiva** os eventos/estado remoto de cada modelo. Validar que os eventos de status, qualidade, categoria e componentes chegaram pelo webhook autenticado, sem replay, para a WABA correta; um evento antigo sozinho não comprova aprovação atual. Homônimo divergente, rejeição ou reclassificação UTILITY→MARKETING bloqueia o uso desse modelo.
- [ ] Conceder autorização de custo MARKETING somente após custo vigente, pagador, conta, categoria e período serem confirmados nominalmente; registrar consentimento individual de cliente apenas com fonte válida. Não consentir a base em massa nem considerar esse ato autorização de envio.

### Task 6.6 — Corte explícito para o canal oficial

Responsáveis: responsável decide e confirma canal/custo/instante; loja acompanha mensagens; agente executa/observa guards e reconciliação.

- [ ] Preparar ponto de reversão: UazAPI revinculada e ativa, Datafy assinado/conectado/inativo com eco e `awaiting_cutover`, catálogo necessário aprovado, alertas e operadores disponíveis. Congelar ações se qualquer fato envelhecer ou divergir.
- [ ] Imediatamente antes de **Ativar / trocar**, reler nome/id exato do canal Datafy e id UazAPI a substituir; confirmar ao responsável que a troca desativa a UazAPI na transação e que assinatura Datafy continuará gerando custo até cancelamento. Obter autorização específica de corte.
- [ ] Acionar `begin_switch` uma vez pelo fluxo admin; conferir canal Datafy ativo, UazAPI inativa, intenção consumida/estado coerente e inbound no canal certo. Se 409, timeout ou estado incerto, reler e reconciliar; não repetir corte ou forçar SQL. Manter `async_ingestion_enabled=false` até decisão posterior própria.

### Task 6.7 — Despacho e testes vivos controlados

Responsáveis: responsável autoriza o alcance global e cada envio pago, destinatário e teto; loja observa recebimento/resposta; agente confere ledger e painel.

- [ ] Antes de `whatsapp_automation_dispatch` ON, conferir alcance global, custo Meta por categoria vigente e ausência de outra unidade pronta para despacho; obter autorização específica da flag. Liberar `dispatch` só no canal Datafy confirmado, com revisão/geração atuais e autorização específica.
- [ ] Planejar quatro provas com contato consentido/controlado, número do canal, categoria, janela de 24h, valor/teto e pessoa que confirma recebimento: confirmação de reserva, mesa pronta, mensagem manual e resposta da IA. Obter autorização nominal **antes de cada envio**; não usar cliente real sem base legal e decisão da loja.
- [ ] Executar cada prova uma vez, conferir recibo/provider, status no painel **Entregas**, conversa e ausência de duplicata; se houver timeout ou falha após aceite, reconciliar recibo antes de retry. Recusa de template, consentimento ou janela é NO-GO para aquele fluxo; não contornar guard.

### Task 6.8 — Pós-corte, reversão e encerramento

Responsáveis: agente acompanha métricas/evidências; responsável decide reversão/desconexão/cancelamento; loja confirma experiência.

- [ ] Monitorar por sete dias completos: canal/inbound, QR, falhas de envio e jobs, categorias/aprovação, alertas, custo e painel Entregas. Registrar checkpoints datados e decisões com a loja; interrupção, cobrança inesperada ou divergência de tenant aciona pausa e investigação.
- [ ] Se necessário reverter, confirmar nominalmente UazAPI/Datafy e custo persistente. Se UazAPI perdeu vínculo, gerar QR no painel da plataforma, pedir leitura à loja e comprovar `connected`/eco **antes** da troca. Obter autorização específica para **Ativar / trocar** de volta; então conferir UazAPI ativa e Datafy inativa. Assinatura Datafy não é cancelada pelo rollback; cancelar/pausar exige autorização separada e GET remoto.
- [ ] Só após sete dias estáveis, conferir canal UazAPI/instância exatos, impacto e custo; obter autorização destrutiva específica para desconectar a instância. Conferir histórico local inativo, Datafy operacional e ausência de pendências/claims; registrar evidências, custos reais e aceite da loja.

### Task 6.9 — Gates e checkpoint da operação

- [ ] Para qualquer correção de implementação descoberta na Fase 6: spec aprovada antes do código, implementer + reviews independentes de spec e qualidade por task, testes proporcionais, seis gates de segurança se tocar área sensível e review da branch. Nenhuma correção de produção por SQL avulso; migration forward-only pelo fluxo autorizado.
- [ ] Atualizar Evidências → Fase 6 após cada task, marcar apenas o que foi comprovado, registrar estado GO/NO-GO e próximo responsável; atualizar memória. Antes de cada commit: `git status`, diff, staged integral, `git diff --cached --check`, varredura de segredos, `git add` de caminhos explícitos e commit local; push/merge só dentro da autorização vigente e com CI verde.

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
- Migration hoje chamada `20261016182000_datafy_migration_grant.sql` (na Fase 1, `20261016120000_datafy_migration_grant.sql`; depois `20261016140200_datafy_migration_grant.sql`):
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
1. `supabase db push` da `20261016182000`;
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
1. `supabase db push` da `20261017120000`, depois da `20261016182000`.
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

### Fase 5

**Preparação local (2026-10-16):** a spec específica `2026-10-16-force-rls-baseline-design.md` foi aprovada pelo responsável no chat apenas para implementação e prova locais (SHA-256 do arquivo aprovado: `A3B5C7F87E0731A535A14CE0631C675CB528EB7B4A7A35677484ACC4649EFC38`). O inventário derivado do repo cobre as cinco tabelas, policies, grants conhecidos e dependências de funções/triggers; owner, `BYPASSRLS`, ACL e drift do alvo não foram consultados. A spec passou por review independente após corrigir a referência à RPC removida pela migration 109 e enumerar as dependências finais. O gate estrito herdado de RLS continua **NO-GO** até validar a migration, os seis gates finais e o estado do alvo pelo procedimento autorizado.

**Gates de código já executados:** `npm run typecheck`: 0 erros; `npm run lint`: 0 erros, 18 avisos de baseline; `npx vitest run --maxWorkers=1 --minWorkers=1 --exclude supabase/tests/local-preflight/local-runtime-paths.test.mjs`: **3.581/3.581**, 145/145 arquivos; `node --test supabase/tests/local-preflight/local-runtime-paths.test.mjs`: **3/3**; `npm run build`: PASS (aviso Browserslist antigo e chunk >500 kB). O build transformou 3.949 módulos. `deno`, `supabase` CLI e `gitleaks` não estão disponíveis neste host; não declarar os respectivos gates como executados. Os testes completos antecederam apenas os arquivos SQL/doc da correção FORCE RLS; as guardas de migration/ACL são repetidas após o diff final.

**Matriz local:** `git diff --name-only origin/main...HEAD` identificou 13 `_shared/*.ts` alterados e 8 `index.ts` de EF diretos. `node scripts/ef-import-graph.mjs --json <13 arquivos>` mais a união dos diretos dá **19 EFs**; as 19, `verify_jwt` e a sequência estão no runbook. A ordem segura planejada é SQL/ACL → 17 bundles sem submissão → frontend tolerante em Vercel `READY` → `manage-whatsapp-templates` → `process-whatsapp-templates` apenas com autorização própria. O frontend antigo da fila falha entre a revogação de `anon` e o frontend novo; o cabeçalho `CF-Connecting-IP` exige prova hospedada de presença e de não aceitação de forja. O `POST {}` na EF nova é somente smoke sem mutação de presença/parse, não prova origem. Nada foi executado no alvo, na Vercel ou em provider.

**Pré-voos locais repetidos até aqui:** 65 PASS em PostgreSQL 18.6 próprio no loopback `55565`: RED da guarda antes da migration, GREEN após a primeira aplicação e após duas reaplicações de `20261016120000` (nome usado nos logs; a migration passou depois pelos nomes `20261016140200` e `20261016182000`), controles `M1–M16`/`CTRL-a–e`, regressões 61/62/63 (`C14`/`M10` verdes depois do snapshot). Houve uma tentativa de limpar `t_snap061` antes de a tabela existir no cluster novo (rc=1); a sequência foi corrigida e o gate final ficou verde. 68 PASS em contêiner próprio Supabase PostgreSQL 17.11 no loopback `55568`: `68a`, migration `20261017170000` três vezes e `GREEN68` após cada, incluindo ACL, replay e controles positivos. Migrations foram aplicadas cruas, sem `psql -1`; ambientes próprios encerrados/removidos após verificar identidade. Logs ignorados em `.superpowers/sdd/phase5-preflight-65-results/` e `phase5-preflight-68-results/`. Estes harnesses não provam ACL/owners/RLS do alvo, JWT/PostgREST ou provider.

**Pré-voos SQL adicionais:** 66, em contêiner próprio Supabase PostgreSQL 17.11, mostrou RED esperado antes da migration e no controle positivo, depois GREEN com 171 checks na primeira e terceira aplicação de `20261017120000`. 67 (`20261017130000`) e 67d (`20261017160000`) passaram nas três aplicações. Em replay fresco e ordenado de `120000` → `130000` → `140000` → `150000`, 67b passou com 37 checks e 67c com 36 checks em cada uma das três aplicações de suas migrations. Uma primeira fixture de 67b omitiu a dependência `cancelled_at` da 130000; o banco descartável foi refeito na ordem correta. Os dois contêineres próprios foram removidos após conferir a identidade. O 69 SQL isolado passou em PostgreSQL Supabase 17.11 próprio após `69a` e três aplicações cruas da 173000, com `GREEN69` em cada. A corrida foi repetida nesta fase em contêiner exclusivo, usando cópia temporária do runner com apenas nome/porta alterados: migration e pré-voo SQL três vezes, 5/7 aceites e 2 recusas com espera real por advisory lock; o controle vulnerável aceitou 7/7. Consulta final confirmou função original restaurada, ACL `anon` sem `EXECUTE` e `service_role` com `EXECUTE`; cópia e contêiner removidos. O controle histórico do 69 na Fase 4 não foi contado como execução atual. O 64 de alertas não foi reexecutado porque não há mudança nessa migration nesta branch.

**Correção FORCE RLS local:** migration `20261017180000_force_rls_operational_baseline.sql` põe as cinco tabelas em `FORCE` numa transação com `lock_timeout=5s`, sem mexer em policy, grants ou funções. O pré-voo 70 em contêiner descartável Supabase PostgreSQL 17.11 aplicou `69a` → `70a` → `173000` → `70b` (`GREEN70-before`) → `180000` → `70` (`GREEN70`); repetiu `180000` mais duas vezes, com `GREEN70` em cada. O review encontrou duas lacunas de asserção (leitura da fila por admin e `EXECUTE` anon das RPCs), corrigidas e revalidadas nas três aplicações; a linha inserida pelo wrapper faz o admin ver três entradas. A primeira aplicação sem contenção levou 11,113 ms somando os tempos de `psql \timing`, com 3,862/1,615/1,513/0,670/0,357 ms nos cinco `ALTER TABLE`; cada medição inclui aquisição local do lock, sem prever espera no alvo. Snapshot de ACL/policies preservado; o controle alternou `NO FORCE`/`FORCE` e observou SELECT/UPDATE do dono sem `BYPASSRLS` abrir/fechar, mantendo acesso `service_role` e limitador da fila. A fixture é compacta e usa stub de `enter_waitlist`; não reconstitui todos os corpos de funções históricas nem prova o estado vivo. O contêiner próprio foi removido. Implementer, review de spec e review de qualidade deram PASS no escopo local; os pré-voos próprios e a auditoria do alvo cobrem as dependências não reconstruídas pelo 70. Guardas locais `function-acl-allowlist`, `migration-static-guard` e `advisor-divergence-core`: **93/93** após a migration.

**Review integrado da branch:** base `origin/main` em `ee721c97f00efaa5ca394bfd8d7dc2c390e285f4`, HEAD inicial da Fase 5 `adb5e4d0c4464baca0628e200471a685091ce39e`, nove migrations novas em ordem local. A revisão independente de todo o diff das Fases 1–5 não encontrou bloqueio novo na fonte. Os seis gates equivalentes locais ficaram: `migration-validator` **PASS_LOCAL_WITH_WARNINGS** (cadeia completa/dry-run alvo/CI pendentes), `rls-auditor` **PASS_SOURCE_LOCAL_WITH_WARNINGS** (cinco FORCE e 70 verde; owners/funções/ACL do alvo pendentes), `tenant-isolation-auditor` **PASS_SOURCE**, `identity-access-auditor` **PASS_SOURCE_WITH_WARNINGS** (proveniência do IP hospedado pendente), `integration-reliability-auditor` **PASS_WITH_WARNINGS** (janela de fila e autorização Meta), `secret-hunter` **PASS_STATIC_AND_STAGED**. A ressalva de concorrência do 69 foi fechada após esse review, com 5/7 na implementação e 7/7 no controle vulnerável. O plugin nativo `saas-shield-br`, `acl-estatico` remoto, `deno check`, `gitleaks`, `db push --dry-run` e auditoria do alvo não rodaram; nenhum PASS local os substitui. A reexecução focada após as alterações finais de SQL/doc passou **99/99** em quatro arquivos (`function-acl-allowlist`, `migration-static-guard`, `advisor-divergence-core`, `ef-import-graph`). O rollout continua **NO-GO**.

**Checkpoint de commit local:** nove caminhos explícitos da Fase 5 foram staged; `git status`, diff de trabalho e `git diff --cached` integral foram conferidos. `git diff --cached --check` passou. A varredura de todas as linhas adicionadas staged não encontrou prefixos de credenciais, header de autorização com valor, URL com usuário/senha, atribuição literal de segredo ou hex longo de autenticação; `service_role` aparece como papel/identificador SQL. Nenhum arquivo de ambiente ou chave entrou no índice. Commit somente local; memória externa atualizada com o SHA após o commit.

**Releitura para a Fase 6 (2026-10-16, HEAD local `66d8e62`):** as evidências das Fases 1–4 e a preparação local da Fase 5 foram conferidas. A árvore estava limpa e a branch dois commits à frente de `origin/feat/datafy-migracao-uazapi`; logo, o CI remoto não cobre o HEAD local. Continuam abertos os checkboxes 5.4 (migrations efetivas do alvo e `db push --dry-run`), 5.5 (backup, conflitos, owners/ACL/RLS, `acl-estatico` remoto, prova hospedada do `CF-Connecting-IP` e janela da fila) e 5.6 (autorizações e rollout coordenado, com autorização própria para `process-whatsapp-templates`). A consulta ao PR pelo conector GitHub retornou 404 e `gh pr view` não alcançou `api.github.com`; nenhum estado de CI foi inferido. Nenhum acesso ao banco de produção, deploy, chamada a provider, push ou merge foi feito nesta releitura. **NO-GO:** a Fase 5 não está concluída; manter a Fase 6 sem detalhamento executivo nem operação até o fechamento comprovado desses gates.

**Pré-voo autorizado após o push (2026-10-16):** `2a45e97` foi enviado ao PR #30. `origin/main` avançou para `155c0eb` com duas migrations de remoção de canal, já aplicadas no projeto `Moralles Reservas` (`gbabxcrntkwgblgqsiit`); a integração local preservou o hotfix e a branch Datafy. O primeiro `supabase db push --dry-run --skip-vault --project-ref gbabxcrntkwgblgqsiit` (CLI 2.120.0) recusou a migration Datafy `20261016120000`, anterior às duas já aplicadas. Sem usar `--include-all`, ela foi renomeada para `20261016140200` com blob SQL idêntico (`363f2336ad7e0c7c682bebc243a1d7c5ad6055ff`). O segundo dry-run passou e listou exatamente, nessa ordem: `16140200`, `17120000`, `17130000`, `17140000`, `17150000`, `17160000`, `17170000`, `17173000`, `17180000` (prefixo `202610`). As dependências SQL→EF da matriz foram conferidas; nenhum SQL foi aplicado.

**Leituras do alvo:** `list_migrations` retornou 165 versões, com `20261016140100` como última; as duas `16140000`/`16140100` estavam no alvo antes da integração. `backups list` retornou backup físico `COMPLETED` de 2026-10-16 05:53 UTC (02:53 BRT); PITR estava desabilitado. Consultas agregadas retornaram zero grupos duplicados de `phone_number_id` e zero conflitos WABA entre organizações. As cinco tabelas do gate FORCE tinham RLS ligado e `relforcerowsecurity=false`, owner `postgres` com `BYPASSRLS`; `service_role` também tinha `BYPASSRLS`. As 47 funções `SECURITY DEFINER` encontradas por busca de referência a essas tabelas tinham owner `postgres` com bypass. `audit_function_acl()` retornou 155 funções, 27 executáveis externamente, todas presentes na allowlist com os papéis observados; zero grants a `PUBLIC`, zero definers com `search_path` mutável e zero comentários “service_role only” expostos. O Security Advisor reportou 0028=10 e 0029=25, iguais à projeção da allowlist; os avisos INFO de tabelas com RLS sem policy correspondem ao desenho privado atual. Essa leitura não substitui o check remoto `acl-estatico` no SHA integrado nem prova o estado após migrations.

**Integração local validada:** implementer resolveu três conflitos de texto, preservou o hotfix de `manage-channels` e renomeou somente o arquivo SQL Datafy; reviews independentes de spec e qualidade aprovaram o merge e o rename. Testes focados: 56/56 no merge e 208/208 após o rename. A suíte integral passou **3.610/3.610 em 146 arquivos** com um worker, excluindo o `node:test` conhecido, que passou 3/3 à parte; `npm run typecheck`, lint das Edge Functions sem avisos, `npm run lint` sem erros (avisos de baseline), `npm run build` e `git diff --cached --check` passaram. `acl-estatico` remoto no SHA integrado, prova do gateway e autorizações de `db push`/deploy e do redeploy `process-whatsapp-templates` seguem pendentes. O responsável informou 15h00 BRT como horário de pouco movimento, assumiu as confirmações técnica e da loja Ren Sushi e depois informou que a loja está fechada e a janela pode ocorrer agora (2026-10-16, após 17h30 BRT). Isso confirma a disponibilidade da loja, mas o início efetivo depende dos gates e autorizações de produção; o aviso aos operadores fica a cargo do responsável. **NO-GO para rollout e Fase 6.**

**CI e identidade do canal (2026-10-16):** o merge local revisado foi commitado como `f9b68d6` e enviado ao PR #30. O PR ficou `MERGEABLE`; `acl-estatico` passou no run 38963818948 (auditoria estática, divergência do advisor, guardrail de migrations e lint das EFs), e a prévia Vercel ficou `SUCCESS` para esse SHA. O HEAD documental `4f8045e` também passou no run 38964166880 e na prévia Vercel. O job `acl-com-banco` foi `SKIPPED`, conforme seu escopo manual de alvo não produtivo; a auditoria efetiva por RPC no alvo continua documentada acima, sem atribuir PASS ao job não executado. Nova leitura do alvo mostrou `whatsapp_template_catalog=false`, `whatsapp_automation_dispatch=false` e zero contas em `whatsapp_template_accounts`; `public-waitlist` ainda não estava implantada. A unidade Ren Sushi tinha um canal UazAPI `a633d938…` conectado e ativo (unidade `9dc55e51…`); nenhuma chamada a esse provider foi feita. O responsável aceitou expressamente o backup físico de 02h53 BRT com PITR desabilitado. **NO-GO:** prova hospedada de `CF-Connecting-IP`, autorizações específicas de banco/deploy e sequência de produção ainda faltam. O redeploy de `process-whatsapp-templates` conserva aprovação própria mesmo com as flags OFF e zero contas no snapshot.

**Sonda do gateway preparada localmente:** `supabase/functions/cf-connecting-ip-gateway-probe/` e sua configuração temporária permitem duas leituras GET autenticadas por `x-internal-key`, com resposta limitada a `present`, `valid` e `equalsForgedMarker`; não há banco, provider ou log de IP. O procedimento redigido está em `docs/superpowers/2026-10-16-cf-connecting-ip-gateway-probe.md`. Testes 3/3, ESLint, `deno check` 2.1.4 e reviews independentes de spec/qualidade passaram. `INTERNAL_API_KEY` não está disponível no shell do agente; o responsável deve executar as leituras de um ambiente seguro, sem divulgar a chave. Deploy e exclusão da sonda requerem autorização conjunta antes do deploy; ambos, a prova hospedada e a remoção do código/configuração antes do merge ainda não ocorreram. O checkbox 5.5 de cabeçalho permanece aberto.

**Tentativa hospedada da sonda:** o responsável autorizou especificamente deploy e exclusão de `cf-connecting-ip-gateway-probe` no projeto `gbabxcrntkwgblgqsiit`, com consumo normal de invocações Edge e sem chamada Datafy/Meta. Após `acl-estatico` e prévia Vercel verdes no SHA `2f80b10`, o deploy por CLI 2.120.0 (`--use-api --no-verify-jwt`) publicou só a sonda; `list_edge_functions` confirmou versão 1 `ACTIVE`, `verify_jwt=false`. O `.env.local` tinha a variável `INTERNAL_API_KEY` definida sem valor. Duas tentativas GET com esse valor vazio receberam 401 (normal) e 403 (cabeçalho forjado); não retornaram os booleanos e **não comprovam** o contrato do gateway. O responsável recebeu instruções para usar a chave já existente no Vault em ambiente seguro, sem colá-la no chat. A sonda ainda deve ser excluída pela autorização recebida; não houve acesso à loja, banco ou provider nessas chamadas.

**Resultado hospedado e limpeza (2026-10-16, durante a janela com Ren Sushi fechada):** após carregar a chave existente somente na sessão PowerShell, o responsável confirmou `carregada=True`, `caracteresDeControle=False` sem revelar o valor. O GET normal autenticado devolveu HTTP 200, `present=True`, `valid=True`, `equalsForgedMarker=False`. A tentativa da mesma origem com `CF-Connecting-IP` e `X-Forwarded-For` iguais ao marcador reservado devolveu HTTP 403 (`System.Net.WebException`), sem os três booleanos. A sonda implementada emitiu apenas 200/401/405, logo o 403 indica recusa anterior à lógica da função, mas não confirma overwrite/remoção do cabeçalho no pedido forjado. Naquele momento, reviews independentes de spec e qualidade recusaram fechar o gate sob o critério original de duas respostas 200 e três booleanos; o checkbox 5.5 permaneceu **[ ]**, e a Fase 5/Fase 6 continuaram **NO-GO**. Com a autorização de exclusão já dada, `supabase functions delete cf-connecting-ip-gateway-probe --project-ref gbabxcrntkwgblgqsiit --yes` na CLI 2.120.0 retornou `Deleted Edge Function`; `list_edge_functions` confirmou ausência. Código/configuração temporários removidos localmente antes do merge. Nenhuma migration, EF da matriz, chamada Datafy/Meta ou mudança no canal UazAPI da Ren Sushi foi feita nesta prova.

**Metadados e emenda aprovada sem nova chamada:** o responsável inspecionou a resposta 403 já capturada no PowerShell: `Server=cloudflare`, `CF-Ray` presente, sem expor IP ou chave. Esses metadados mostram passagem pela Cloudflare, sem identificar qual componente do ingresso gerou o 403. Consulta agregada de `function_edge_logs` no projeto e pathname da sonda, 20:45–21:10 UTC, encontrou um 200, um 401 e zero 403. Isso apoia rejeição antes da lógica da sonda para a origem/marcador testados, sem medir diretamente `public-waitlist`. Reviews independentes de spec e qualidade aprovaram a redação da emenda `docs/superpowers/specs/2026-10-16-cf-connecting-ip-gateway-gate-amendment.md` como critério alternativo revisável, e o responsável a aceitou expressamente em 2026-10-16. O gate específico do IP pode ser marcado com esse escopo; os demais gates da Fase 5 e o rollout continuam **NO-GO**.

**Limpeza no commit e ACL real:** commit local `2d7678c22afc84142adc2975b87085c4bf1b25a7` removeu os três arquivos da sonda e sua entrada em `supabase/config.toml`; `git ls-tree -r --name-only HEAD` e `git show HEAD:supabase/config.toml` não encontraram o slug. A condição 5 da emenda está comprovada na branch local, além da exclusão remota já confirmada. Sob o pré-voo de produção autorizado, `scripts/audit-function-acl.ts` foi executado contra `gbabxcrntkwgblgqsiit` com `SUPABASE_SERVICE_ROLE_KEY` obtida pela CLI somente em memória, sem imprimir valor e limpa no `finally`. Uma primeira execução terminou com `auditExit=0`, mas o invólucro PowerShell terminou com código 1; a repetição com saída explícita terminou com código externo **0** e `auditExit=0`. Ambas reportaram 155 funções não-trigger, 27 entradas na allowlist, lints equivalentes 0028=10/0029=25/total=35 e **zero violações**. O check `acl-estatico` deve passar de novo no SHA que receber o próximo push; `acl-com-banco` continua SKIPPED. Nenhuma migration foi aplicada nessa auditoria.

**Gate nativo adicional antes do push:** revisão incremental por `saas-shield-br` encontrou `migration-validator` e `rls-auditor` PASS_WITH_WARNINGS, `tenant-isolation-auditor` e `identity-access-auditor` PASS, `secret-hunter` PASS (143 arquivos/13.976 linhas adicionadas, nenhum segredo), mas `integration-reliability-auditor` **FAIL/P1**: com legado `is_active=NULL` desconectado e liberação de migração presa a ele, `begin_switch` classifica binding ausente, grava `activation_requested_at` antes do teste de eco/saúde e pode devolver 409 deixando intenção durável. O callback seguinte pode ativar o alvo sem repetir o teste. O Ren Sushi estava em `is_active=true` na última leitura, mas o vetor é alcançável na matriz de migração. **NO-GO para push, merge e rollout até corrigir, testar e repetir o gate.**

**Emenda para o P1 aprovada:** reviews independentes de spec e segurança deram PASS à emenda `2026-10-16-datafy-offline-legacy-cutover-guard-amendment.md`; o responsável a aprovou expressamente para correção local em 2026-10-16, sem autorização de `db push`, deploy ou operação da loja. O primeiro protótipo de pré-health por grant já consumido foi reprovado nos reviews: `recordSubscription` pode confirmar assinatura antes de `finalize` consumir o grant, e revogação nesse intervalo deixa a autoridade SQL atual tratar legado NULL/desconectado como primeira configuração. A correção aprovada cobre o grant não consumido/revogado e revalidação SQL sob lock, inclusive no callback. Até os testes e gates finais, o P1 permanece aberto e a Fase 5 **NO-GO**.

**Correção local revisada (2026-10-17):** implementer aplicou o fallback determinístico do legado `is_active=NULL` desconectado no adapter, na autoridade SQL e no finalizador administrativo; a autoridade trava e revalida a liberação com `FOR SHARE`, e o `begin_switch` de migração testa eco/conexão antes de pedir intenção. Reviews independentes de spec e qualidade passaram após ajustes de fixtures e ordenação por timestamp; não há P0/P1/P2 remanescente nesses reviews. O pré-voo 65 em PostgreSQL 18 descartável passou RED antes da migration, GREEN depois (24 avisos OK e M10 pendente), duas reaplicações da migration e GREEN final (25 avisos OK, inclusive M17/M18 e controles de sabotagem f/g). Regressões 62 e 63 passaram no mesmo banco; o cluster foi parado e removido. O pré-voo não testa a corrida com duas sessões nem estado do alvo; o lock/recheck é uma garantia estática revisada.

**Checks locais da correção:** suíte completa serial **3.617/3.617 testes, 146/146 arquivos**, antes dos últimos ajustes de documentação/fixtures; testes focados finais **275/275**; `node --test` do grafo local 3/3; guardas estáticas de migration/ACL 83/83; `npm run typecheck` sem erros; `deno check` das três EFs afetadas sem erros; `npm run lint` código 0 com 18 avisos preexistentes; `npm run build` código 0, com avisos de Browserslist e tamanho de chunk; `git diff --check` código 0. Não houve SQL de produção nem chamada a provider.

**Seis gates nativos incrementais no diff final:** `migration-validator` e `rls-auditor` **PASS_WITH_WARNINGS** (sem P0/P1; P2 operacional: `FORCE RLS` pode esperar ou abortar com `lock_timeout=5s`, exigindo janela e conferência posterior do alvo; P3 herdado: policy de fila sem `WITH CHECK` explícito, sem bypass observado); `tenant-isolation-auditor` e `identity-access-auditor` **PASS** (0 P0–P3); `integration-reliability-auditor` **PASS** (P1 offline corrigido, 0 achados novos P0–P3); `secret-hunter` **PASS** (145 arquivos versionáveis/alterados, 38.752 linhas, 0 segredo real; candidatos regex eram docs/fixtures). O bundle gerado foi verificado sem `service_role`; único JWT tinha papel `anon`. Todos são revisões estáticas/incrementais: não substituem CI no SHA do push nem estado RLS/ACL após `db push`. A Fase 5 permanece **NO-GO** até esses gates e autorizações explícitas de produção, inclusive a própria para `process-whatsapp-templates`.

**Ordem do alvo após nova integração de `main` (2026-10-17):** a leitura autorizada mostrou 167 migrations aplicadas em `Moralles Reservas`, até `20261016181000`. Com Datafy ainda nomeada `20261016140200`, `supabase db push --dry-run --skip-vault --project-ref gbabxcrntkwgblgqsiit` (CLI 2.120.0) retornou `DbPushMissingRemoteError`; nenhum SQL foi aplicado. O arquivo foi movido para `20261016182000_datafy_migration_grant.sql` com SHA-256 de conteúdo idêntico antes/depois e Git blob `c0b8686a80d3955f2df2c6ba6dc652c8859cf0eb`. Repetido com o novo nome, o dry-run terminou com código 0 e enumerou, nessa ordem: `16182000`, `17120000`, `17130000`, `17140000`, `17150000`, `17160000`, `17170000`, `17173000`, `17180000` (prefixo `202610`). Task 5.4 tem ordem comprovada no alvo neste snapshot. Nenhum SQL foi aplicado; novas migrations em `main` exigem novo dry-run antes da escrita. **NO-GO** pelos demais gates e autorizações.

**Integração final de `main` e gates incrementais:** o PR #30 em `5b3515f` passou a aparecer `CONFLICTING` após `origin/main` avançar para `df9588a`. O merge local trouxe as duas migrations já aplicadas, sem conflito de timestamp após o rename Datafy. Os três conflitos de documentação (`AGENTS.md`, `CLAUDE.md`, README dos pré-voos) foram resolvidos pelo implementer; reviews independentes de spec e qualidade aprovaram após corrigir a função `P()` do procedimento 66/67 e as regras de audit log e CHECK das notas. O rename Datafy teve reviews independentes de spec e qualidade, ambos sem bloqueio, e foi staged explicitamente como R100. Nova revisão dos seis gates: migration e RLS **PASS_WITH_WARNINGS** (P2 da janela FORCE e P3 herdado de policy); isolamento **PASS_WITH_WARNINGS** no estado integrado e **PASS** no delta do PR (P2 herdado de `main`: RPC de exclusão de instância com `search_path=public`, somente `service_role`, sem bypass identificado; migration já aplicada, eventual correção forward-only); identidade **PASS** no delta; integração e segredos **PASS** (0 achados novos P0–P2 e 0 segredo real). Todos estáticos. `deno check` das três EFs do diff Datafy passou; a EF `manage-whatsapp-instances` incorporada de `main` tem sete erros de tipos Deno herdados, com blob idêntico a `origin/main` (`e74e46713a0f87db2444fc2b3b1558e6a69b2559`), e não integra o delta do PR. O gate Deno global não é considerado PASS. Ainda faltam CI no SHA do merge, janela reconfirmada e autorizações de produção. **NO-GO**.

**Validação integrada antes do commit de merge:** suíte completa serial **3.680/3.680 testes, 150/150 arquivos**; `node --test supabase/tests/local-preflight/local-runtime-paths.test.mjs` **3/3**; `npm run typecheck` **PASS**; `npm run lint` **PASS** (0 erros, 18 avisos de baseline); `npm run build` **PASS**. A revisão final da branch não encontrou P0/P1/P2 novo nem conflitos restantes. Essas verificações não provam deploy, banco vivo nem operação da loja.

**CI do código integrado (2026-10-17):** commit de merge local `876e8a92410ef7ff70e9c6173a1102e482f79fab`, com pais `5b3515f` e `df9588a`, enviado à branch do PR #30. O check `acl-estatico` do run `39043059352` passou, incluindo auditoria estática de ACL, divergência do advisor, guardrail de migrations e lint das EFs; a prévia Vercel ficou `SUCCESS`, e o PR apareceu `CLEAN/MERGEABLE`. O job `acl-com-banco` foi `SKIPPED` por ser manual para alvo não produtivo; a auditoria efetiva autorizada do alvo permanece registrada separadamente. Este CI não autoriza nem executa `db push`, deploy da matriz, redeploy de `process-whatsapp-templates`, merge em `main` ou operação do Ren Sushi. O rollout segue **NO-GO**.

**Janela e SQL de produção (2026-10-17):** o responsável, que assumiu os papéis técnico e da Ren Sushi, respondeu `janela confirmada agora` imediatamente antes da escrita e assumiu aviso/monitoramento da fila e sessões antigas. O alvo foi reconfirmado como `Moralles Reservas` (`gbabxcrntkwgblgqsiit`), `ACTIVE_HEALTHY`, com 167 migrations até `20261016181000`; o backup físico `COMPLETED` de 02h49 BRT era mais recente que o ponto de 02h53 BRT do dia anterior aceito pelo responsável; PITR OFF. Conflitos de `phone_number_id` e ownership WABA: zero. Donos, `BYPASSRLS`, grants, policies e as cinco tabelas sem FORCE foram lidos antes; 45 corpos `SECURITY DEFINER` que as referenciam têm owner com bypass. `npx --yes supabase@2.120.0 db push --dry-run --skip-vault --project-ref gbabxcrntkwgblgqsiit` retornou código 0 com exatamente as nove migrations da Task 5.4. Após autorização explícita de `db push`, o mesmo comando sem `--dry-run`, com `--yes`, retornou código 0 e aplicou as nove, sem Vault/seed/roles. A lista remota passou a 176 e novo dry-run ficou sem pendências. As cinco tabelas passaram a `relforcerowsecurity=true`; `anon` perdeu EXECUTE de `enter_waitlist`, mantendo o painel autenticado. Não foi feita chamada Datafy/Meta.

**ACL pós-SQL e CI:** a primeira auditoria efetiva pós-SQL falhou somente porque a allowlist estática ainda esperava o grant `anon` de `enter_waitlist`: o alvo já mostrava 0028=9, 0029=25, 34 grants esperados, sem função nova inesperadamente exposta. O Advisor real mostrou as mesmas contagens (9/25); `rls_enabled_no_policy=47` é desenho das tabelas privadas. Implementer moveu a assinatura para `authenticated_tenant` em `scripts/function-acl-allowlist.json` e ajustou o teste para respeitar a revogação explícita posterior de `anon`; reviews independentes de spec e qualidade deram PASS, testes focados 95/95 e typecheck PASS. Nova auditoria **real** do alvo terminou com código 0: 159 funções públicas, 27 entradas na allowlist, 0028=9, 0029=25, zero violações. Commit `ec8cead6f263ab4ff869696d87b280418de499bb` foi staged por dois caminhos explícitos após diff integral, `diff --cached --check` e varredura das 47 linhas adicionadas sem segredo real. Push autorizado; run `39044052797` `acl-estatico` PASS no SHA, Vercel preview SUCCESS, PR #30 CLEAN/MERGEABLE. O job `acl-com-banco` manual não substitui a auditoria acima.

**Bundles, merge e frontend:** com SQL, ACL e CI verdes, `supabase@2.120.0 functions deploy --project-ref gbabxcrntkwgblgqsiit --use-api` publicou primeiro `manage-channels` 48→49 e `manage-organizations` 43→44 (`verify_jwt=true`); depois, em ordem serial, `create-reservation` 42→43, `notify-waitlist-ready` novo v1, `process-notification-outbox` 23→24, `process-reservation-reminders` 27→28, `process-satisfaction-surveys` 23→24, `process-voucher-triggers` 24→25, `process-waitlist-entered` 24→25, `process-waitlist-feedback` 23→24, `public-waitlist` novo v1, `resend-notification` 20→21, `send-cancellation` 44→45, `send-confirmation` 69→70, `send-manual-message` 48→49, `send-scheduled-whatsapp` 2→3 e `send-whatsapp` 68→69 (esses 15 com `verify_jwt=false`). Sem liberação Datafy durante o intervalo SQL→bundle. O PR #30 foi retirado de draft e integrado com `gh pr merge --merge --match-head-commit ec8cead…`; `MERGED` em 2026-10-17 15:15:46 UTC, merge `ac2c3b499e5e974ef077930477cbdf65098ea08f`. Vercel produção `dpl_7ho7aWUAiUQ5Z71rYcEUhHugs7Pe`, source `main`/`ac2c3b4`, ficou `READY`, alias `reservas.moralles.com.br`; GET `/r` 200. Só então `manage-whatsapp-templates` 2→3 foi publicado. Com autorização **separada** e expressa do responsável, `process-whatsapp-templates` 2→3 foi publicado por último. Listagem remota confirmou as 19 EFs `ACTIVE`, com `verify_jwt` conforme matriz. O deploy pode habilitar submissão futura quando houver conta e escopo; não foi autorizado ligar catálogo ou enviar mensagens.

**Smokes e limite do GO da Fase 5:** `public-waitlist` hospedada respondeu 400 `invalid_input` a `POST {}`; `create-reservation` também respondeu 400 `invalid_input`; `manage-whatsapp-templates` sem autenticação respondeu 401 `unauthorized`; GET do frontend `/r` respondeu 200. São recusas antes de criar fila, reserva, job ou mensagem. A leitura pós-deploy mostrou `whatsapp_template_catalog=false`, `whatsapp_automation_dispatch=false`, zero contas de templates, zero jobs, zero registros locais em `whatsapp_remote_templates`, zero grant ativo/onboarding/canal Datafy da Ren Sushi e UazAPI `a633d938-68c6-4658-9d24-6e6d8f1a3c6f` ainda `connected`/ativa. Não houve GET na Meta/Datafy para provar inventário remoto. A prova do gateway aceita na emenda e o 400 hospedado apoiam a fila nova na rota testada; não medem todo browser, cliente ou mensagem real. **Fase 5 concluída no escopo autorizado; Fase 6 ainda NO-GO para ações pagas/destrutivas e troca de canal sem confirmações próprias.**

### Fase 6

**Pré-corte somente leitura (2026-10-17):** Vercel produção `READY` no merge `ac2c3b4`, 19 EFs `ACTIVE` e 176 migrations; Ren Sushi com UazAPI `a633d938-68c6-4658-9d24-6e6d8f1a3c6f` `connected`/ativa, zero grants ativos, zero onboardings, zero canais Datafy. Flags `whatsapp_template_catalog=false` e `whatsapp_automation_dispatch=false`. Essa leitura fechou os dois primeiros checks da Task 6.1; as confirmações posteriores do responsável estão abaixo. Nenhuma liberação ou conexão havia sido criada, nenhum QR havia sido gerado, e não houve operação remota paga ou corte.

**Confirmação do responsável e pré-requisito ausente:** o responsável confirmou versão WhatsApp Business 2.24.17+, acesso admin Meta e disponibilidade da loja, e informou preço Datafy exibido de **R$ 49,90 por número/mês**. Isso não comprova ainda empresa/número, conta adimplente, allowance, pagador ou tarifa Meta. O banco mostrou `datafy_account_token` configurado por existência booleana, sem ler valor; a lista de **nomes** dos Edge secrets mostrou `INTERNAL_API_KEY` presente e `WHATSAPP_OPS_ALERT_URL` ausente. O alvo continua com zero grant ativo e UazAPI ativa. O responsável autorizou **somente a liberação de migração** presa ao canal UazAPI identificado, sem conexão, assinatura ou corte; a execução da liberação e sua verificação ainda estão pendentes. Não conectar enquanto alertas/conta/identidade/janela não forem reconciliados.

**Grant ainda não comprovado:** o responsável informou que fez a liberação no painel, mas a consulta de leitura ao alvo `gbabxcrntkwgblgqsiit` retornou zero grants ativos da unidade e apenas a liberação comum histórica de 2026-10-16, já revogada, com `replaces_channel_id=NULL`. Não repetir a ação às cegas. Confirmar URL/ambiente e estado do cartão no painel, resolver eventual erro e só marcar a Task 6.2 após encontrar um grant novo, não revogado/não consumido e preso ao UazAPI correto. O navegador acessível ao agente abriu `/admin/login`, sem sessão autenticada; não se usou SQL direto para criar grant nem credencial do usuário.
