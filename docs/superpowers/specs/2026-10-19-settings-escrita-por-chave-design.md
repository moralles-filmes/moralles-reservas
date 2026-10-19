# Escrita em `settings` restrita por chave e papel — design

**Status:** aprovada em 2026-10-19 (classificação de §3 aceita; correção do hook de §5 vai em PR próprio).
**Branch/worktree:** `fix/settings-write-acl` em `.claude/worktrees/settings-write-acl` (a partir de `origin/main` `d18f975`).
**Assunto:** banco/RLS (`.claude/rules/banco-de-dados.md`), agente de IA (`.claude/rules/agente-ia.md`).

## 1. Problema

`public.settings` (`id`, `unit_id NOT NULL`, `key`, `value jsonb`, `UNIQUE (unit_id, key)`) guarda a configuração da unidade em pares chave-valor. A policy `unit_member_all_settings` (migration 013, linha 497) é `FOR ALL TO authenticated` com `app_private.is_unit_member(auth.uid(), unit_id)` e não confere papel. Qualquer membro da unidade, inclusive o operador, pode gravar pela API qualquer chave da própria unidade. Isso vale também para `ai_config` (provedor, modelo e provedor reserva) e para as chaves que formam o prompt do agente. Pela UI, só o platform_admin chega a essas telas.

O problema não atravessa tenants. A chave de IA é BYOK da unidade, fica em `ai_provider_credentials` (FORCE RLS, sem policy) e só a EF `manage-ai-providers` grava, gateada por `platform_admins`. O que um operador consegue hoje, na própria unidade:

- **Custo:** trocar o provedor ou o modelo para outro mais caro, entre os que têm chave ativa, ou ligar o provedor reserva. Com a franquia desligada, isso gasta sem teto.
- **Comportamento do agente:** reescrever `ai_system_prompt`, `ai_context_extra`, `restaurant_extra_info` etc. O bot passa a dizer o que o operador quiser a clientes finais no WhatsApp, inclusive links e "promoções", e a Regra 7 não protege contra instrução vinda do próprio prompt.
- **Envio:** desligar ou religar lembrete, pesquisa, mensagens de fila e giftback, alterar o texto do giftback não oficial (este já tem guard, ver §2.3), ligar overbooking e mudar a janela ou a duração da reserva.

## 2. Fatos verificados (código e produção, 2026-10-19)

### 2.1 Banco vivo (`gbabxcrntkwgblgqsiit`, só leitura)

- RLS `enabled`, **não** `forced`. Policies: `platform_admin_all_settings` (ALL, `app_private.is_platform_admin`) e `unit_member_all_settings` (ALL, `app_private.is_unit_member`). Não há policy para anon.
- Trigger existente: `whatsapp_legacy_template_write` (BEFORE INSERT/UPDATE/DELETE, `public.guard_whatsapp_legacy_template_write()`, migration `20261003225857`). Ele só age sobre `giftback_message_template`: exige owner/gerente ou platform_admin, recusa quem não é `authenticated` (inclusive service_role) e, com canal oficial/Datafy, aceita só a RPC `maintain_whatsapp_legacy_template`. **É o precedente direto deste desenho.**
- Grants de tabela: `anon` e `authenticated` têm `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER`. O anon só é barrado pela ausência de policy. `TRUNCATE` ignora RLS e triggers de linha e não é exposto pelo PostgREST, então não há vetor pela API, mas o grant não tem uso.
- Não há `updated_at` nem trigger de auditoria: hoje não dá para saber quem mudou `ai_config`.
- Produção tem 2 unidades e 19 chaves: `additional_info, agent_mode, agent_name, ai_config, ai_context_extra, ai_system_prompt, booking_window_days, delivery_response, reminder_d1_enabled, reservation_duration_minutes, reservation_tolerance_minutes, restaurant_address, restaurant_extra_info, restaurant_instagram, restaurant_menu, restaurant_phone, restaurant_website, rules_and_conditions, survey_d1_enabled`.
- Funções SQL que **leem** `settings`: `get_unit_public_full` e `get_widget_public` (`booking_window_days`, `rules_and_conditions`, `additional_info`), `next_waitlist_code` (`waitlist_code_min/max`), `app_private.whatsapp_automation_post_core` (`<kind>_enabled`, `giftback_whatsapp_enabled`). A única função que **grava** é `maintain_whatsapp_legacy_template` (SECURITY DEFINER, platform_admin, só `giftback_message_template`).
- `unit_members.role` tem CHECK `owner | gerente | operador`. `is_unit_member` é `exists(unit_members where user_id and unit_id)`.

### 2.2 Escritores pela UI

| Tela (rota, guard) | Quem chega | Chaves gravadas |
|---|---|---|
| `Automacao.tsx` → `AITab` (`/platform/unidades/:slug`, `PlatformGuard`) | platform_admin | `ai_config` |
| `Automacao.tsx` → `PromptTab` (mesma rota) | platform_admin | `agent_mode`, `agent_name`, `restaurant_menu`, `delivery_response`, `restaurant_extra_info`, `ai_system_prompt`, `ai_context_extra` |
| `gestao/reservas/Ajustes.tsx` (`GestaoGuard`) | owner, gerente, platform_admin | `reservation_duration_minutes`, `booking_window_days`, `reservation_tolerance_minutes`, `rules_and_conditions`, `additional_info`, `reminder_d1_enabled`, `survey_d1_enabled` |
| `useWaitlistSettings` (`gestao/fila/Ajustes`, `gestao/fila/Comunicacao` com `canEdit` owner/gerente) | owner, gerente, platform_admin | `waitlist_qr_enabled`, `waitlist_menu_link_enabled`, `waitlist_priority_enabled`, `waitlist_code_min`, `waitlist_code_max`, `waitlist_tolerance_minutes`, `waitlist_remote_entry_enabled`, `waitlist_remote_entry_limit`, `waitlist_entered_enabled`, `waitlist_feedback_enabled` |
| `useGiftbackSettings` (`gestao/giftback/Ajustes`, `canManage`) | owner, gerente, platform_admin | `giftback_whatsapp_enabled`, `giftback_email_enabled`, `giftback_message_template` |
| `useTableBlocks` (`gestao/reservas/Bloqueios`) | owner, gerente, platform_admin | `allow_overbooking` |
| `gestao/Conta.tsx` (DELETE ao renomear a unidade) | owner, gerente, platform_admin | `restaurant_name` |

`GestaoGuard` redireciona o operador para `/o/:slug`. Nenhuma tela do Operacional grava `settings`. Nenhuma Edge Function grava `settings`: todas as 15 consumidoras só leem, com service role.

### 2.3 Leitores relevantes no backend

- `webhook-whatsapp`: `ai_config` (provedor, modelo, reserva) e todo o mapa de settings no prompt (`restaurant_name`, `agent_mode`, `agent_name`, `ai_system_prompt`, `ai_context_extra`, `restaurant_menu`, `delivery_response`, `restaurant_extra_info`, `rules_and_conditions`, `additional_info`, `booking_window_days`, `reservation_duration_minutes`, `reservation_tolerance_minutes`); giftback no envio do voucher.
- `whatsapp-health`: `ai_config`.
- `_shared/availability.ts`: `reservation_duration_minutes`, `allow_overbooking`, `booking_window_days`.
- Workers `process-*`: `reminder_d1_enabled`, `survey_d1_enabled`, `waitlist_entered_enabled`, `waitlist_feedback_enabled`, `giftback_*`.
- `send-confirmation`: `restaurant_name`, e `restaurant_address/phone/instagram/website` como fallback das colunas de `units` (migration 050). **Essas quatro chaves legadas não têm escritor na UI.**

## 3. Inventário e classe proposta

Duas classes. Chave fora da lista cai em **platform** (fail-closed).

| Chave | Efeito | Escritor UI hoje | Classe proposta |
|---|---|---|---|
| `ai_config` | provedor/modelo/reserva → **custo** | platform_admin | **platform** |
| `ai_system_prompt`, `ai_context_extra` | instrução direta ao LLM → **agente/envio** | platform_admin | **platform** |
| `agent_mode`, `agent_name` | escopo e persona do agente | platform_admin | **platform** |
| `restaurant_menu`, `delivery_response`, `restaurant_extra_info` | texto injetado no prompt | platform_admin | **platform** |
| `restaurant_address`, `restaurant_phone`, `restaurant_instagram`, `restaurant_website` | fallback legado em mensagem ao cliente | ninguém | **platform** (default) |
| `reservation_duration_minutes`, `booking_window_days`, `reservation_tolerance_minutes`, `rules_and_conditions`, `additional_info` | disponibilidade, portal, prompt | owner/gerente | **manager** |
| `reminder_d1_enabled`, `survey_d1_enabled` | liga/desliga envio | owner/gerente | **manager** |
| `waitlist_*` (10 chaves de §2.2) | fila; `entered`/`feedback` ligam envio | owner/gerente | **manager** |
| `giftback_whatsapp_enabled`, `giftback_email_enabled`, `giftback_message_template` | envio de voucher | owner/gerente | **manager** (o template mantém também o guard oficial existente) |
| `allow_overbooking` | disponibilidade | owner/gerente | **manager** |
| `restaurant_name` | nome legado em e-mail/prompt | owner/gerente (DELETE) | **manager** |

**manager** = `owner` ou `gerente` da unidade da linha, ou platform_admin. **platform** = só platform_admin. O **operador não grava nenhuma chave**, igual à UI. Isso não tira nada que ele faça hoje.

### 3.1 `ai_config` só para platform_admin (recomendado)

Concordo com a sua preferência e não proponho abrir para owner/gerente nesta entrega, por três motivos:

1. **Custo é da plataforma.** A chave BYOK é cadastrada pelo platform_admin, o preço vem de `ai_model_prices` (modelo sem preço com franquia falha em `PRICE_UNKNOWN`) e a reserva exige uma segunda chave paga. Escolher modelo e provedor é decisão comercial, não operacional.
2. **Não existe tela na Gestão.** Abrir o banco sem UI só aumenta superfície.
3. **A Entrega B vai mexer nisso.** Ela redefine a lista de modelos e o prompt global com complemento por unidade. Se algo for liberado ao dono, sai de lá, com tela e validação. Pela classe de §4, liberar depois é trocar uma linha do classificador.

O mesmo vale para as chaves de prompt. Há um argumento de produto para o dono editar o cardápio (`restaurant_menu`) e a resposta de delivery, mas hoje não existe tela e o texto entra cru no prompt. Fica **platform** e a decisão vai para a spec da Entrega B (complemento por unidade).

## 4. Desenho do controle

### 4.1 Por que trigger, não policy por operação

- **Mesmo padrão da tabela.** `whatsapp_legacy_template_write` já protege uma chave de `settings` com trigger BEFORE e `42501`. Uma segunda régua (policies por chave) faria duas lógicas de papel conviverem na mesma tabela.
- **`42501` explícito.** Policy que nega no `USING` de UPDATE/DELETE devolve **zero linhas com `error: null`**: a UI mostraria "salvo" sem gravar (AGENTS §8). O trigger levanta `42501`.
- **Testável no harness.** O `local-preflight` prova trigger, CHECK e idempotência, mas **não prova RLS** (regra do banco). Com policy, o teste pedido ("operador e gerente recusados") não teria onde rodar sem um Supabase de verdade.
- **Sem oráculo.** O trigger só dispara em linha que já passou pelo RLS. Membro da unidade A escrevendo na unidade B continua vendo zero linhas, exatamente como hoje. Dentro da própria unidade o membro já tem `SELECT` em todas as chaves, então a recusa não revela nada. A mensagem é uma só (`setting_write_forbidden`) para chave platform, papel insuficiente e chave desconhecida.

As policies **não mudam**: o isolamento de tenant continua no RLS e o trigger soma a regra de papel por chave. A leitura não muda.

### 4.2 Objetos (uma migration, `BEGIN`/`COMMIT`, idempotente)

1. **`app_private.unit_setting_write_class(p_key text) returns text`**: `IMMUTABLE`, `language sql`, `search_path=''`. Devolve `'manager'` para a lista fechada de §3 e `'platform'` para qualquer outra entrada, inclusive `NULL`.
2. **`app_private.guard_unit_setting_write() returns trigger`**: `plpgsql`, `SECURITY DEFINER`, `search_path=''`:
   - `auth.role()` nulo (sem contexto de request: `postgres` em `db push`, cron) ou `service_role` → passa. Os escritores confiáveis seguem como hoje e nenhum deles grava settings atualmente.
   - *(Acréscimo do review da Task 1, 2026-10-19.)* `auth.role()` nulo só passa se o GUC `role` da sessão não for `anon` nem `authenticated`: um papel de API sem claims é recusado. O GUC sobrevive ao `SECURITY DEFINER` (medido no PG 17 e 18). A migration também faz `set local lock_timeout = '5s'`, porque o `drop trigger` pede `ACCESS EXCLUSIVE` numa tabela que os workers leem o tempo todo.
   - Qualquer outro papel que não seja `authenticated` (inclusive `anon`) → `42501`. Hoje o anon é inalcançável (sem policy), mas fica de cinto de segurança, e um papel desconhecido nasce negado.
   - `auth.uid()` nulo → `42501`.
   - `app_private.is_platform_admin(uid)` → passa. É o paralelo obrigatório do guard por `unit_id`.
   - Para **cada escopo não nulo entre `OLD` e `NEW`**, a classe de `key` em `unit_id`: `platform` → `42501`; `manager` → exige `unit_members(user_id=uid, unit_id=escopo, role in ('owner','gerente'))`, senão `42501`. Conferir os dois escopos impede contornar a regra mudando `key` ou `unit_id` num UPDATE, como faz o precedente.
   - `raise exception 'setting_write_forbidden' using errcode = '42501'`, igual em todos os ramos.
   - Devolve `NEW` (INSERT/UPDATE) ou `OLD` (DELETE).
   - O upsert do PostgREST (`INSERT … ON CONFLICT DO UPDATE`) dispara primeiro o BEFORE INSERT e depois o BEFORE UPDATE. As duas passagens chegam ao mesmo veredito.
3. **`create trigger settings_write_role_guard before insert or update or delete on public.settings for each row`** (antecedido de `drop trigger if exists`). Por ordem alfabética roda antes de `whatsapp_legacy_template_write`, que continua intacto.
4. **ACL das funções:** `revoke all on function … from public, anon, authenticated, service_role` com a assinatura completa nas duas. Ninguém chama direto: o trigger dispara sem `EXECUTE` do invocador (mesmo modelo do guard existente) e o classificador é chamado pelo trigger SECURITY DEFINER. Nada entra em `scripts/function-acl-allowlist.json`.
5. **Higiene de grants da tabela:** `revoke insert, update, delete, truncate on public.settings from anon`, mais o revoke de `insert`/`update` por coluna de todas as colunas para anon (o mesmo bloco `DO` da migration `20261017160000`, porque `REVOKE` de tabela não remove grant de coluna), e `revoke truncate on public.settings from public, authenticated`. Anon não grava nem lê settings direto (o portal lê pelas RPCs SECURITY DEFINER). O `SELECT` de anon fica como está: negado pelo RLS e fora do escopo.

### 4.3 Paridade UI ↔ banco

O teste estático `scripts/settings-write-acl.test.ts` (Vitest) lê a lista `manager` da última migration que define `unit_setting_write_class` e confere:

- ela é **igual** à união de `GIFTBACK_SETTING_KEYS`, `WAITLIST_SETTING_KEYS`, `SETTING_KEYS` de `reservas/Ajustes.tsx`, `allow_overbooking` e `restaurant_name`;
- nenhuma chave gravada por `Automacao.tsx` (`ai_config` e as 7 do `PromptTab`) está nela.

Uma chave nova gravada pela Gestão que não entrar no classificador quebra o CI, e não a produção com `42501`. Isso segue o padrão de alinhamento policy ↔ UI ↔ teste do `audit_log`.

Uma linha nova em `.claude/rules/banco-de-dados.md`: **"Chave nova de `settings` nasce gravável só por platform_admin; a Gestão grava só as chaves `manager` de `app_private.unit_setting_write_class`, alinhadas com `scripts/settings-write-acl.test.ts`."**

### 4.4 Frontend

Não muda nada para os fluxos legítimos. O operador não chega às telas que gravam. Não há mensagem nova, porque o `42501` só aparece por chamada direta à API.

## 5. Achados herdados de `conversations`

Verificado em produção: `unit_member_all_conversations` (ALL, `is_unit_member`) + grant de coluna `UPDATE (status, assigned_to, handoff_reason, handoff_at, updated_at)` a `authenticated`; FK `assigned_to → auth.users ON DELETE SET NULL`; nenhum trigger além de `updated_at`.

| Achado | Impacto real | Proposta |
|---|---|---|
| `assigned_to` aceita o id de outro usuário (qualquer `auth.users`, inclusive de outro tenant) | Atribuição falsa na própria unidade. **Nenhum código lê `assigned_to`** além do tipo em `src/types/reserva.ts`: webhook, auto-resolve e UI não o usam para decidir nada. Não dá acesso. | **Registrar para depois.** A regra certa ("só `NULL` ou `auth.uid()`; platform_admin pode atribuir a membro da unidade?") depende de uma feature de "transferir para colega" que não existe. Vira um item no rule file de WhatsApp e na memória. |
| `releaseToAI`/`markResolved` sem `.eq("unit_id")` e sem `.select()` | O RLS já barra outra unidade, então não vaza. O defeito é silencioso: uma conversa apagada ou fora do escopo devolve `error: null` e a UI mostra sucesso (AGENTS §8). | **PR próprio** (decisão de 2026-10-19), branch separada a partir de `origin/main`: copiar o padrão do `assumeConversation` (`.eq("unit_id", unitId).select("id")` + erro em zero linhas) e criar um teste do hook. Não depende do banco. |

## 6. Testes

### 6.1 `supabase/tests/local-preflight/75a-settings-write-acl-bootstrap.sql` + `75-settings-write-acl.sql`

Base igual à do 68: `00-bootstrap` + `01-audit` + `09a-advisor-bootstrap` + migration 106, que já trazem `units`, `unit_members`, `platform_admins`, `settings` com o UNIQUE e os helpers `app_private.*` na forma de produção. O `75a` acrescenta o que falta: `auth.role()` lendo `request.jwt.claims`, unidades e atores de teste, e o trigger `whatsapp_legacy_template_write` com a função copiada verbatim de produção, para provar que os dois convivem. Depois aplica a migration nova **crua** (sem `psql -1`). As identidades vêm de `request.jwt.claims` (`sub`, `role`), como no CONTROLE-6.

Casos (cada um confere o código `42501` **e** o efeito na tabela):

| # | Ator | Operação | Esperado |
|---|---|---|---|
| S1 | operador U1 | INSERT/UPDATE/DELETE `ai_config` U1 | `42501`, linha intacta |
| S2 | operador U1 | upsert `booking_window_days` U1 (manager) | `42501` |
| S3 | gerente U1 | INSERT/UPDATE/DELETE `ai_config` U1 | `42501` |
| S4 | gerente U1 | UPDATE de cada chave de prompt (7) | `42501` |
| S5 | gerente U1 | chave desconhecida `foo_bar` | `42501` (fail-closed) |
| S6 | gerente U1 | UPDATE que troca `key` de `booking_window_days` → `ai_config` | `42501` |
| S7 | gerente U1 | UPDATE que move `unit_id` de U1 → U2 (sem papel em U2) | `42501` |
| S8 | owner U1 / gerente U1 | upsert de **todas** as chaves `manager` + DELETE `restaurant_name` | ok, valor gravado |
| S9 | platform_admin sem membership | upsert `ai_config` e chaves de prompt em U1 | ok |
| S10 | service_role (`role=service_role`) | upsert `ai_config` | ok |
| S11 | sem claims (`postgres`, migration) | upsert | ok |
| S12 | anon | INSERT direto | `42501` |
| S13 | gerente U1 | `giftback_message_template` com canal não oficial | ok (os dois guards passam) |
| S14 | — | `has_function_privilege` de `anon`/`authenticated`/`service_role` nas duas funções | `false` |
| S15 | — | reaplicar a migration | idempotente, um trigger só |
| S16 | — | `has_table_privilege('anon', 'public.settings', 'INSERT'/'TRUNCATE')`, `authenticated` TRUNCATE | `false` |

**Controle positivo:** o arquivo derruba o trigger, repete S1 e exige que o operador **consiga** gravar. Depois recria o trigger e confirma que S1 volta a falhar. Sem isso, um verde não distingue "a guarda funciona" de "o teste não testa".

O harness não prova RLS nem PostgREST: o isolamento entre unidades segue nas policies, que não mudam. A prova HTTP com JWT real é opcional e manual.

### 6.2 Vitest

- `scripts/settings-write-acl.test.ts` (§4.3), com controle negativo: uma fixture com uma chave a mais na Gestão tem de falhar.
- (PR próprio) teste do hook: `releaseToAI`/`markResolved` filtram por `unit_id`, pedem `.select` e lançam erro em zero linhas.
- `npm run typecheck`, `lint`, `test`, `build` verdes. Os dois testes que já falham localmente (CRLF e flake) são registrados como pré-existentes, não como regressão.

## 7. Gates, deploy e rollback

- **Antes do merge:** `saas-shield-br:migration-validator`, `saas-shield-br:rls-auditor` e `saas-shield-br:identity-access-auditor` sobre a migration (Opus). Também o check `acl-estatico` verde na aba Checks e o `git diff --cached` revisado com a varredura de segredos do AGENTS §5.
- **Deploy (cada passo com autorização sua, pedida à parte):** `supabase db push` com a migration. **Nenhuma Edge Function muda e não há redeploy de EF**, porque todas as leitoras usam service role e o trigger deixa service_role passar. Frontend: esta branch não muda `src/`; o merge em `main` dispara a Vercel sem mudança de bundle. A correção do hook vai pelo PR próprio.
- **Verificação pós-push (leitura):** antes do push, `auth.role()` de produção ainda lê `request.jwt.claims` (forma moderna, conferida em 2026-10-19); o trigger existe, as ACLs das funções estão como em S14 e S16, e um owner real consegue salvar Ajustes de reservas e de fila na Gestão.
- **Rollback:** uma migration que faz `drop trigger settings_write_role_guard` volta ao comportamento atual sem perder dado, porque o trigger não grava nada. Os revokes de anon não precisam voltar.

## 8. Fora de escopo

- Auditoria de quem mudou `settings` (não há `updated_at` nem `audit_trigger_func`). Seria útil para `ai_config`, mas exige alinhar a allowlist do `audit_log` (AGENTS §8). Fica registrado.
- Migrar as chaves legadas `restaurant_address/phone/instagram/website` para fora de `settings` (fallback da migration 050).
- `SELECT` de anon em `settings` (negado pelo RLS) e grants equivalentes em outras tabelas.
- Abrir `ai_config` ou chaves de prompt para o dono. Decisão da Entrega B.

## 9. Riscos

| Risco | Mitigação |
|---|---|
| Chave escrita pela Gestão que o inventário não pegou → owner recebe `42501` | O inventário cobre todos os `.from("settings")` de `src/` e as funções do banco vivo. O teste de paridade (§4.3) trava chave nova e a classe pode ser corrigida com outra migration. |
| Escritor service_role futuro sem guard de papel | É o comportamento de hoje. EF com service role já tem de autenticar o caller e validar o recurso (AGENTS §8). |
| Interação com `whatsapp_legacy_template_write` | Os dois rodam e ambos exigem owner/gerente/admin para `giftback_message_template`. S13 prova que convivem. |
| `auth.role()` sem claims dentro de RPC SECURITY DEFINER chamada por usuário | Lá o `auth.role()` continua `authenticated` (lê o JWT da requisição), então a regra vale também via RPC. `maintain_whatsapp_legacy_template` passa porque exige platform_admin. |

## 10. Modelo por tarefa (memória model-choice-by-risk)

- Migration e harness `71/71a`: Opus.
- Teste de paridade e correção do hook (PR próprio): Sonnet.
- Gates `saas-shield-br:*`: Opus.
- Buscas pontuais: Haiku.
