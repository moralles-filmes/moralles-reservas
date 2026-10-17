# Instâncias de WhatsApp: aba de encerradas e exclusão sem custo

Data: 2026-10-15. Aprovado em conversa pelo dono (design e dispensa de revisão do plano).

## Objetivo

A tela `/platform/instancias-whatsapp` mistura instâncias vivas e encerradas na mesma lista. O dono quer a lista principal limpa e poder apagar instâncias de teste.

Critério de sucesso: encerradas ficam numa aba própria; apagar só é possível para instância encerrada que nunca teve custo; histórico financeiro real nunca é apagado por esta porta.

## Decisões

1. **Abas no Inventário:** `Ativas (n)` mostra todo estado diferente de `ENDED`; `Encerradas (n)` mostra `ENDED`. A aba vem do parâmetro `?aba=encerradas` da URL (ausente ou outro valor = Ativas). Alertas e simulador ficam como estão, abaixo.
2. **Quem pode ser apagada:** `lifecycle_state = 'ENDED'` **e** `current_monthly_cost_cents is null` **e** nenhum ciclo com `provider_cost_cents is not null`. Em produção hoje: UazAPI Moralles (`71a7f5b8`, 1 ciclo sem custo) pode; Z-API Ren Sushi (`d4b1d970`, 4 ciclos com custo) não.
3. **O banco decide, não a tela.** RPC nova `delete_whatsapp_instance_without_cost(p_instance_id uuid, p_note text, p_actor uuid) returns table(outcome text)`, `security definer`, `set search_path = public`, service-role-only. Em uma transação:
   - `select ... for update` da instância (ausente → `outcome = 'not_found'`);
   - trava os ciclos dela (`for update`), na ordem instância → ciclos, a mesma de `confirm_whatsapp_instance_end`;
   - estado diferente de `ENDED` → `'not_ended'`; custo na instância ou em algum ciclo → `'has_cost'`;
   - grava nota `DELETE` em `whatsapp_instance_notes` (instance_ref = instance_id = a instância, organization_id dela, note = motivo, created_by = ator) **antes** do delete;
   - `delete from whatsapp_instances` → ciclos saem por `on delete cascade` (088); notas e alertas ficam com `instance_id` nulo por `on delete set null` (096/089), preservando `instance_ref`/`subject_id`; o trigger de auditoria da 087 grava a linha apagada em `audit_log`;
   - `'deleted'`.
4. **Vocabulário do ledger ganha a nona ação `DELETE`.** Fonte canônica `INSTANCE_NOTE_ACTIONS` (`_shared/whatsapp-instance-notes-core.ts`); a migration nova faz `drop constraint if exists` + `add constraint` com as nove; rótulo PT-BR "instância apagada" em `whatsapp-instance-format.ts`. O teste de acoplamento passa a ler o CHECK **efetivo** = o último `add constraint whatsapp_instance_notes_action_check` em ordem de arquivo de migration, não mais a 104 fixa.
5. **Edge Function `manage-whatsapp-instances`:**
   - `list_instances` passa a devolver `has_cost_history: boolean` por instância (custo atual não nulo OU id presente em ciclos com custo, lido numa segunda consulta só de `instance_id`). Falha dessa leitura = 500 como a leitura principal (não esconder como "sem custo", que mostraria botão errado — e o banco recusaria de qualquer forma).
   - Ação nova `delete_instance` (`instance_id` UUID + `reason` ≥ 5 chars, platform_admin como as demais) chama a RPC e traduz: `deleted` → 200 `{ deleted: true }`; `not_found` → 404; `not_ended` → 409 `INSTANCE_NOT_ENDED`; `has_cost` → 409 `INSTANCE_HAS_COST_HISTORY`; erro da RPC → 500 com mensagem curta PT-BR e `jsonLog` com `needsAdminAction`. Tradução em núcleo puro testável (`deleteInstanceOutcomeResponse` em arquivo NOVO `_shared/whatsapp-instance-delete-core.ts`, consumido só por `manage-whatsapp-instances` — não em `whatsapp-instance-core.ts`, que também entra no bundle de `manage-channels` e alargaria o redeploy).
6. **Tela:** botão "Apagar" (variante destrutiva) só em cartão da aba Encerradas com `has_cost_history === false` (campo ausente = não mostra). Diálogo de motivo no padrão dos demais (`MIN_REASON_LENGTH = 5`), texto: a instância e os ciclos dela somem para sempre; o histórico de ações e os alertas ficam, marcados como instância removida. Toast "Instância apagada." no sucesso; erro mostra a mensagem da EF. Decisões puras em `src/lib/whatsapp-instance-format.ts`: `instanceTab(searchParam)`, `partitionInstancesByTab(instances)`, `canOfferInstanceDelete(inst)`.

## Fora de escopo

Apagar instância com custo, apagar não encerrada, tela de histórico de instâncias apagadas, mudança no worker de ciclos.

## Testes (critério de aceite, com controle positivo)

- **Vitest, núcleos puros:** `partitionInstancesByTab`, `instanceTab`, `canOfferInstanceDelete` (ENDED+sem custo → sim; ENDED+custo → não; ACTIVE → não; campo ausente → não); `deleteInstanceOutcomeResponse` para os quatro desfechos + desconhecido.
- **Vitest, acoplamento:** `INSTANCE_NOTE_ACTIONS` ⇔ CHECK efetivo nas duas direções; ACL estática da RPC (revoke de `public, anon, authenticated`, grant só a `service_role`, fora das entradas públicas da allowlist, em `_service_only_whatsapp_instance_delete`); guardrail textual do bloco `delete_instance` (chama a RPC, exige motivo, não usa `.delete()` direto).
- **Vitest, tela:** abas com contagem, encerrada vai para a aba Encerradas, botão Apagar só onde permitido, diálogo envia `{ action: "delete_instance", instance_id, reason }`.
- **Harness local-preflight (banco `fase6c`):** `66-instance-delete.sql` — DEL-1 apaga ENDED sem custo (instância some, ciclo some, nota DELETE existe com `instance_id` nulo e `instance_ref` preservado, audit_log tem o DELETE); DEL-2 recusa ENDED com custo na instância; DEL-3 recusa ENDED com custo só em ciclo; DEL-4 recusa ACTIVE; DEL-5 id inexistente → `not_found`; DEL-6 ACL (anon/authenticated sem EXECUTE, service_role com); DEL-7 idempotência da migration aplicada duas vezes. `67-controles-instance-delete.sql` — CONTROLE-DEL-1 tira a checagem de custo de ciclo e vê DEL-3 apagar; CONTROLE-DEL-2 tira a checagem de estado e vê DEL-4 apagar; restaura reaplicando a migration.
- **Gates:** `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`; agentes `saas-shield-br:migration-validator`, `rls-auditor`, `identity-access-auditor`; conferir `acl-estatico` no PR.

## Ordem de entrega

`supabase db push` da migration **antes** do deploy de `manage-whatsapp-instances` (sem a RPC e sem `DELETE` no CHECK, `delete_instance` responde 500; `list_instances` não depende da migration). Frontend sobe com o merge em `main`; botão só aparece quando a EF já devolve `has_cost_history`.

Redeploy: só `manage-whatsapp-instances` (consome o núcleo novo por valor; `whatsapp-instance-notes-core.ts` entra nela só como `import type`). Medir por fecho de imports antes do deploy, não pelo checklist.

## Adendo — `audit_log` deixa de mostrar dado da plataforma ao cliente

Decidido pelo dono em conversa, na mesma entrega ("corrigir junto").

**Achado (gates saas-shield, conferido em produção só com leitura):** a policy `unit_member_read_audit` de `audit_log` libera SELECT a qualquer membro da organização (`is_org_member`) ou da unidade. O trigger `audit_trigger_func` grava a linha inteira (`to_jsonb`) de `whatsapp_instances` (087), `whatsapp_implementations` (071) e `organization_entitlement_overrides`, com `organization_id`. Em produção: 116 linhas de instâncias (44 da organização do Ren Sushi), 5 de implantações e 11 de overrides, com `current_monthly_cost_cents`, `cost_note`, `notes`, `cancellation_reason`, `end_confirmation_note`, `amount_cents` e `reason`; nenhuma credencial. A tela Gestão → Auditoria (`useAuditLog`) lista sem filtro de tabela, então o dono e o gerente veem essas linhas. A 096 já registrava o risco e por isso não usou `audit_log`; a 087 pendurou o trigger mesmo assim.

**Decisão:** a policy de membro passa a ler só uma lista explícita de tabelas — `customers`, `reservations`, `unit_members`, exatamente as que a tela de Auditoria do cliente rotula (`TABLE_LABEL`). Tabela auditada nova nasce invisível para o cliente. `platform_admin_read_audit` não muda. O trigger e as linhas existentes não mudam: a trilha continua, só deixa de chegar a quem não deve.

**Testes:** harness com membro da organização vendo as três tabelas e não vendo as três da plataforma, membro de outra organização sem nada, platform admin vendo tudo, e controle positivo com a policy antiga (o vazamento reaparece). Vitest: a policy efetiva (último arquivo de migration que a define) tem a lista, e a lista é igual às chaves de `TABLE_LABEL`. Pós-deploy, sonda em transação somente leitura com o papel `authenticated` e o JWT de um membro real.

**Ordem:** migration por `supabase db push`, junto com a da exclusão; não depende de Edge Function.

## Adendo 2 — endurecimento da exclusão pela auditoria do módulo

Decidido pelo agente principal sob a escolha do dono ("só sem custo" = nunca teve custo), depois da auditoria `saas-audit-br:module` (business-process, data-resilience e tenant-isolation). Nenhuma decisão afrouxa a regra; todas a estreitam ou aumentam o rastro. Conferido em produção (só leitura) que o alvo real, `71a7f5b8`, continua apagável: 4 alertas, todos `RESOLVED`; 63 linhas de `audit_log`, nenhuma com custo.

1. **Ator obrigatório na RPC** (`p_actor` nulo → `check_violation`). A EF já passa o usuário do JWT; a guarda vale para qualquer outro chamador service-role.
2. **Custo no histórico conta como custo.** `set_cost` aceita "desconhecido" em qualquer estado, então anular o custo e apagar escondia custo real. A RPC também recusa `has_cost` se o `audit_log` da instância tiver `current_monthly_cost_cents` não nulo em algum momento. A tela não lê `audit_log`: nesse caso raro ela oferece o botão e o banco recusa com mensagem clara.
3. **Alerta aberto bloqueia** (novo desfecho `open_alerts` → 409 `INSTANCE_HAS_OPEN_ALERTS`). Um alerta de divergência aberto é o único sinal de que o fornecedor ainda cobra, e alerta aberto de instância apagada ficaria órfão. A tela troca o botão por "Resolva os alertas abertos para poder apagar." e não oferece o botão enquanto os alertas carregam ou falham.
4. **Retrato dos ciclos no `audit_log`** antes do `DELETE` (`table_name = 'whatsapp_instance_cycles'`, uma linha por ciclo, com o ator). Ciclos não têm trigger de auditoria e saíam em cascata sem rastro; a policy por lista já os esconde do cliente.
5. **Auditoria do cliente filtra as tabelas também no hook** (`.in("table_name", AUDIT_LOG_MEMBER_TABLES)`), para que um platform admin em pseudo-dono não veja dado da plataforma na tela do cliente.

Mantido como está, por decisão anterior: ciclo `PENDING_REVIEW` com custo nulo conta como "sem custo" (o alvo real é exatamente isso), agora com o retrato do item 4.

Fora do escopo, levado ao dono: o histórico de PII de `customers` em `audit_log` sobrevive à anonimização (pré-existente; exige decisão jurídica); `audit_log` sem revoke de tabela/FORCE RLS e `audit_trigger_func` com `search_path = public` (hardening); runbook de recuperação de instância apagada; cache TanStack não limpo no logout.
