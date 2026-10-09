# Templates das automações WhatsApp existentes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Método do projeto:** usar obrigatoriamente subagent-driven-development, com implementador e reviews por tarefa e whole-branch.

**Goal:** Atualizar exclusivamente as automações WhatsApp existentes para templates oficiais fixos, preservando atendimento, personalizações não oficiais e benefícios existentes.

**Architecture:** Catálogo puro versionado, adapters de templates no registry e registros remotos por organização/WABA. Produtores existentes encaminham intenções a um despacho com ledger SQL, claims cercados e reconciliação; mensagens de IA/humanas conservam o envio atual. Interface autorizada mostra catálogo oficial somente leitura e mantém o editor não oficial.

**Tech Stack:** Vite, React 18, TypeScript, TanStack Query, shadcn/Tailwind, Vitest, Supabase/Postgres, Edge Functions Deno, adapters Datafy/Meta.

**Spec:** [2026-10-03-whatsapp-templates-programados-design.md](../specs/2026-10-03-whatsapp-templates-programados-design.md). A aprovação do usuário em 2026-10-03 autorizou preparar este plano. A execução será encaminhada a outro chat; este documento não comprova implementação ou homologação.

## Global Constraints

- “O atendimento continua como está: prompt e ferramentas da IA, respostas de texto, mensagens humanas, handoff, locks de conversa, eco do aparelho, captura de notas/comentários e voucher após avaliação não passam pelo catálogo novo.”
- “Não criar módulo Marketing, campanhas, públicos, segmentos, calendário de campanhas, atribuição de vendas, carteira, tarifa financeira automática ou cobrança SaaS.”
- “Implementar e testar localmente. Submissão real, número de homologação, migration/deploy e ativação em produção dependem de autorização específica. Nenhum envio à base é teste permitido.”
- Idioma `pt_BR`, formato `POSITIONAL`, versão lógica 1; copiar os sete corpos e FOOTER da seção 3 da spec literalmente. BODY contém os links; não adicionar botões ou comando SAIR.
- “RPCs de claim/finalização são service-role-only, com revoke explícito de PUBLIC/anon/authenticated e assinatura completa.”
- “Uma WABA não pode ser vinculada a organizações diferentes, inclusive quando um canal usa Datafy e outro Meta direta.”
- “Timeout/queda após início do POST vira uncertain e exige evidência/reconciliação, sem promessa de exatamente uma vez.”
- “Retentativa de rejeição transitória explícita pode reutilizar a mesma intenção com no máximo cinco tentativas totais e intervalos de 1, 4, 16 e 64 minutos entre elas”. Lote máximo 20; sincronização 5 minutos; snapshot oficial antes do POST máximo 60 segundos.
- “Links de preferência contêm token aleatório de pelo menos 256 bits, armazenado apenas como hash, validade de 90 dias e revogação.” GET não altera escolha; POST somente recusa promoções daquela unidade.
- “Frequência promocional do despacho atualizado: no máximo um envio aceito ou uncertain por contato/unidade em sete dias, configurável apenas por platform_admin.”
- Retenção de eventos sanitizados/jobs terminais novos: 90 dias; não purgar não terminais. Flags e opt-in nascem OFF. `adopted_at` impede retorno automático ao legado.
- Ler AGENTS.md e CLAUDE.md integralmente no checkout de execução. Usar builders SaaS adequados, implementador/reviews de spec e qualidade por tarefa e review whole-branch. Gates shield antes de merge de produto. Main mantém decisões de segurança/arquitetura.
- Migrações são arquivos gerados pelo CLI e aplicadas por `supabase db push`, nunca SQL no Studio. O nome com timestamp só existe após `supabase migration new`; abaixo o sufixo identifica inequivocamente o arquivo da tarefa. Não renumerar migrations existentes.
- Nada de push neste handoff. Criar branch `codex/whatsapp-templates-programados`, registrar a branch de destino real e integrar localmente após gates/review se ela não tiver mudado. Push de main dispara deploy e precisa de autorização específica.

## Review Focus

1. Reserva remarcada entre enqueue e POST: renderizar os dados atuais e revalidar data local/TTL, sem hora antiga (Task 9/10).
2. Template perde aprovação ou muda conteúdo durante GET: geração antiga não libera envio, embora antes estivesse aprovado (Task 6/7).
3. POST aceito externamente e persistência falha: reparar registro/histórico sem segundo POST, inclusive com callback antecipado (Task 9/12).
4. Provider/binding troca com fila pendente e flag desliga: conservar identidade lógica e pausar; nenhum envio legado ou novo canal automático (Task 4/9/12).
5. Opt-out/anonimização ocorre depois do enqueue: revalidar no início do POST e impedir envio, sem apagar/recriar voucher (Task 5/9/11).

Cada condição acima recebe testes na tarefa indicada. Não anunciar proteção contra mudança que ocorre depois de o provider aceitar o POST: esse efeito não é recolhível.

## Estrutura de arquivos e contratos

Arquivos existentes estão confirmados no checkout `df0fcc7`. Antes de executar, conferir mudanças posteriores com Git e ajustar apenas referências que realmente mudaram. As unidades abaixo são limites de revisão da mesma feature; catálogo/worker/API não são projetos de Marketing independentes.

| Arquivo novo | Responsabilidade |
| --- | --- |
| `supabase/functions/_shared/whatsapp-template-catalog-core.ts` | Sete definições, validação, hash, prévia e parâmetros POSITIONAL |
| `supabase/functions/_shared/whatsapp-template-provider-core.ts` | Tipos wire, normalização estrutural, paginação e classificação de resultado |
| `supabase/functions/_shared/whatsapp-template-state-core.ts` | Estado utilizável e revisão por epoch, sem I/O |
| `supabase/functions/_shared/whatsapp-template-account.ts` | Descoberta/binding verificados e credencial autorizada para sincronização |
| `supabase/functions/_shared/whatsapp-template-sync.ts` | Listagem completa, comparação, submissão e reconciliação |
| `supabase/functions/_shared/whatsapp-template-events-core.ts` | Discriminação/identidade de lote e extração sanitizada de gestão |
| `supabase/functions/_shared/whatsapp-template-events.ts` | Persistência transacional antes do ACK |
| `supabase/functions/_shared/whatsapp-automation-core.ts` | Intenções, chave lógica, corte legado/novo e política de retry |
| `supabase/functions/_shared/whatsapp-automation-resources.ts` | Leitura dos recursos/telefone/links e elegibilidade atuais |
| `supabase/functions/_shared/whatsapp-automation-dispatch.ts` | Claim, preflight, POST único e finalização/reconciliação |
| `supabase/functions/_shared/whatsapp-message-preferences-core.ts` | Token/hash, consentimento e frequência |
| `supabase/functions/_shared/whatsapp-template-access-core.ts` | Política por ação e projeção client-safe |
| `supabase/functions/send-scheduled-whatsapp/index.ts` | Entrada de intenção estruturada, interna ou JWT autorizado |
| `supabase/functions/process-whatsapp-templates/index.ts` | Worker interno de catálogo, recuperação e retenção |
| `supabase/functions/process-whatsapp-automations/index.ts` | Worker interno de retries conhecidos, expiração e reparo local |
| `supabase/functions/manage-whatsapp-templates/index.ts` | Snapshot e ações de loja/platform_admin |
| `supabase/functions/whatsapp-message-preferences/index.ts` | GET/POST públicos por token opaco |
| `src/hooks/useWhatsappTemplates.ts` | Query/mutations autorizadas e cache por unidade |
| `src/components/whatsapp/OfficialAutomationTemplate.tsx` | Corpo/estado oficiais somente leitura |
| `src/pages/public/PreferenciasMensagens.tsx` | Confirmação explícita de opt-out, sem dados pessoais |
| `src/test/fixtures/whatsapp-automation-fixtures.ts` | Fixtures sintéticas completas para testes de injeção |
| `docs/whatsapp-templates-programados-runbook.md` | Gates, dependências, matriz de EFs e rollback |

Tipos exportados por `whatsapp-automation-core.ts` e utilizados sem variantes locais:

```ts
export type ScheduledKind = 'confirmation' | 'reminder_d1' | 'survey_d1'
  | 'waitlist_entered' | 'waitlist_feedback' | 'voucher_issued';
export type ScheduledIntent =
  | { unitId: string; kind: 'confirmation' | 'reminder_d1' | 'survey_d1';
      reservationId: string; sourceEventKey: string; factAt: string }
  | { unitId: string; kind: 'waitlist_entered' | 'waitlist_feedback';
      waitlistId: string; sourceEventKey: string; factAt: string }
  | { unitId: string; kind: 'voucher_issued'; voucherId: string;
      sourceEventKey: string; factAt: string };
export type DispatchResult =
  | { state: 'accepted'; jobId: string; providerMessageId?: string }
  | { state: 'queued' | 'blocked' | 'expired' | 'uncertain' | 'needs_review'
      | 'failed' | 'reconciled'; jobId: string; reason: string };
export type DispatchSelection = 'legacy' | 'scheduled' | 'paused';
```

`logicalAutomationKey(intent)` usa unit+kind+ID do recurso, nunca template/version/canal/sourceEventKey. `selectAutomationPath({ledgerExists, adoptedAt, enabled})` devolve scheduled se há ledger, paused se já adotado e desabilitado, legacy apenas se nunca adotado e OFF. Falha de leitura não chama essa função com falso inventado.

`TemplateId` são exatamente os sete nomes da spec. `TemplateCategory = 'UTILITY'|'MARKETING'`; `TemplateDefinition` inclui nome/id, versão, idioma, formato, categoria pedida, BODY/FOOTER, validators em ordem, exemplos e lifecycle. `TemplateRender = {body:string; footer:string|null; parameters:string[]}`. `renderTemplate(id, values: readonly string[]): TemplateRender` lança código fechado de parâmetro inválido; `catalogHash(definition): Promise<string>` usa SHA-256 canônico.

`TemplatePage = {items:RemoteTemplate[]; after:string|null}`. `RemoteTemplate` mantém id/name/language/status/requestedCategory/effectiveCategory/quality/components/observedHash, sem credencial. `TemplateSendOutcome` separa `{state:'accepted';providerMessageId?:string}`, `{state:'rejected';retryable:boolean;code:string;status?:number}` e `{state:'uncertain';code:string}`. `TemplateCreateOutcome` tem os mesmos ramos de rejeição/incerteza, mas aceite é `{state:'accepted';remoteTemplateId?:string}`; ID de template não é ID de mensagem. 2xx ambíguo não inventa ID; reconciliar conforme evidência de aceitação documentada.

Serviços com Supabase/fetch não são importados pelos testes Vitest ou pelo frontend. Núcleos puros usam tipos estruturais locais; `serve()` somente nos `index.ts`. Testar serviços via módulo de dependências injetadas, sem token/provider real.

## Preparação da execução

- [ ] Ler spec, auditoria, regras e este plano. Registrar checkout/branch de destino; conferir `git status --short`, `git diff`, `git log -3 --oneline`; preservar trabalho alheio.
- [ ] Confirmar no chat implementador que o usuário revisou/autoriza este plano ou que o prompt de handoff foi colado como instrução de execução. Não repetir brainstorming aprovado. Divergência material da spec é explicada antes de alterá-la.
- [ ] Aplicar ai-router por tarefa; manter decisões críticas no principal. Usar `saas-builder-br:db-schema-designer`, `backend-supabase`, `integrador-apis`, `frontend-react`, `design-ux`, `qa-testes`, `devops-ci` para os limites correspondentes. Descobrir arquivos locais dos agentes; se ausentes, informar o gate concreto e não fingir execução deles.
- [ ] Baseline atual: `npm run typecheck`, `npm run test`; ler `supabase --help`, `supabase migration new --help`, `supabase db push --help`, `supabase test --help`; verificar Deno/Postgres local. O baseline da auditoria (79 arquivos/1.949 testes) é histórico, não resultado da execução futura.
- [ ] Consultar documentação primária de Datafy, Meta e Supabase; confirmar changelog relevante e anotar data. Meta retornou 429 na escrita da spec. Sem contrato/grants verificados, Meta direta não ganha capability. Não instalar dependência nova sem necessidade demonstrada.
- [ ] Para SQL, usar banco local descartável com fixtures, nunca URL/credencial de produção. `PGCLIENTENCODING=UTF8`; a porta local deve estar confirmada. Não parar/remover instância PostgreSQL do usuário.

## Task 1: Catálogo e renderização únicos

**Files:** Create `supabase/functions/_shared/whatsapp-template-catalog-core.ts`; Test `src/lib/whatsapp-template-catalog-core.test.ts`.

**Interfaces:** Produz `TemplateId`, `TemplateDefinition`, `TemplateRender`, `TEMPLATE_CATALOG`, `renderTemplate`, `catalogHash`; consumidos em Task 2/6/9/14.

- [ ] Escrever teste vermelho com os sete IDs, contagens `[7,8,6,4,5,5,6]`, categorias, corpo/FOOTER literais da spec, hash e validações. Exemplo mínimo:

```ts
import { expect, it } from 'vitest';
import { renderTemplate, TEMPLATE_CATALOG, catalogHash }
  from '../../supabase/functions/_shared/whatsapp-template-catalog-core.ts';
it('renderiza sem confundir reserva e voucher', () => {
  const r = renderTemplate('res_lembrete_dia_v1', ['Marina', 'Restaurante Exemplo',
    '20:30', '4', 'RES123', 'https://example.com/acompanhar/00000000-0000-4000-8000-000000000001']);
  expect(r.body).toContain('Código da reserva: RES123.');
  expect(r.parameters[4]).toBe('RES123');
  expect(r.body).not.toContain('{{');
});
it('não trunca código inválido', () => {
  expect(() => renderTemplate('res_lembrete_dia_v1', ['Marina', 'Exemplo',
    '20:30', '4', 'X'.repeat(33), 'https://example.com/acompanhar/a']))
    .toThrow('template_parameter_invalid');
});
it('hash exclui exemplos de análise', async () => {
  const d = TEMPLATE_CATALOG.res_lembrete_dia_v1;
  expect(await catalogHash({...d, examples: [...d.examples].reverse()}))
    .toBe(await catalogHash(d));
});
```

- [ ] Executar `npm run test -- src/lib/whatsapp-template-catalog-core.test.ts`; esperar FAIL por export ausente.
- [ ] Implementar os textos da seção 3 da spec, sem emoji/promoção adicional. Validar cada valor com o schema daquela posição; controles e excesso são recusados; nome vazio recebe “cliente”. Percentual finito >0/≤100; data/hora reais; HTTPS/origem permitida; nenhuma substituição recursiva do conteúdo de variável.

```ts
const body = definition.body.replace(/\{\{(\d+)\}\}/g,
  (_match, position: string) => parameters[Number(position) - 1]);
return {body, footer: definition.footer, parameters};
```

Antes desse trecho, exigir número exato de parâmetros, validar por posição e rejeitar índice fora do intervalo. Canonicalizar componentes fixos/chaves com ordem determinística; preservar diferenças estruturais desconhecidas no remoto.
- [ ] Completar casos 0/101/NaN percentual, pessoas zero/fracionárias, controle Unicode, limites de nome/unidade/códigos/link, idioma e nomes. Prévia deve resultar do mesmo retorno usado pelo envio.
- [ ] Rodar teste verde/typecheck; review spec+qualidade; adicionar somente os dois arquivos e commit `feat: define catalogo dos templates programados`.

## Task 2: Transporte de templates no registry

**Files:** Create `supabase/functions/_shared/whatsapp-template-provider-core.ts`; Modify `supabase/functions/_shared/whatsapp-provider-core.ts`, `supabase/functions/_shared/whatsapp-providers.ts`, `supabase/functions/_shared/datafy-client.ts`; Test `src/lib/whatsapp-template-provider-core.test.ts`, `src/lib/whatsapp-capability-guard.test.ts`, `src/lib/datafy-client.test.ts`, `src/test/whatsapp-provider-core.test.ts`.

**Interfaces:** Adapter opcional `listTemplates(credentials, {wabaId,after}):Promise<TemplatePage>`, `createTemplate(credentials,{wabaId,definition}):Promise<TemplateCreateOutcome>`, `sendTemplate(credentials,{phoneNumberId,toPhone,name,language,parameters}):Promise<TemplateSendOutcome>`. O retorno de create indica aceite da submissão; status de análise sai do GET, nunca do booleano de envio. Acrescentar `templateManagement` para list/create, `templateMessages` para send. Mapear um-para-muitos no guard de capabilities mantendo as exigências antigas.

- [ ] Escrever teste vermelho de método/capability nas duas direções, recipient E164 com DDD55 e body POSITIONAL:

```ts
import {expect, it} from 'vitest';
import {buildTemplateMessage, nextTemplateCursor}
  from '../../supabase/functions/_shared/whatsapp-template-provider-core.ts';
it('preserva DDD 55 e usa BODY posicional', () => {
  const wire = buildTemplateMessage({toPhone:'55999990000', name:'res_pesquisa_reserva_v1',
    language:'pt_BR', parameters:['Marina','RES123','Exemplo','19/10/2026']});
  expect(wire.to).toBe('5555999990000');
  expect(wire.type).toBe('template');
  expect(wire.template.components[0].parameters[1]).toEqual({type:'text',text:'RES123'});
});
it('cursor repetido não faz loop', () => {
  expect(() => nextTemplateCursor('a', new Set(['a']))).toThrow('template_cursor_cycle');
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-template-provider-core.test.ts src/lib/whatsapp-capability-guard.test.ts` e ver FAIL relevante.
- [ ] Datafy GET/POST `v1/{waba}/message_templates` e POST `v1/{phone}/messages` somente pelo cliente atual, token em header; `/me` sem v1. Sanitizar erro na fonte. Construir próxima URL com cursor codificado na origem fixa; nunca seguir `paging.next` remoto. Normalizar os campos conforme docs atuais com fixtures primárias redigidas.

```ts
const path = `v1/${encodeURIComponent(wabaId)}/message_templates`
  + (after ? `?after=${encodeURIComponent(after)}` : '');
const body = {messaging_product:'whatsapp', to:toE164BrPhone(input.toPhone),
  type:'template', template:{name:input.name, language:{code:input.language},
  components:[{type:'body', parameters:input.parameters.map(text => ({type:'text',text}))}]}};
```

- [ ] Classificar timeout/fetch rejeitado após início como uncertain; rejeição explícita só retryable quando contrato prova não aceite. Não classificar todos os 5xx/429 como seguros para repetir. Direct Meta usa versão Graph existente, somente após verificação primária; caso bloqueada, adapter template fica ausente e UI informa unsupported, sem afetar sendText. Demais providers mantêm capabilities falsas e sendText idêntico.
- [ ] Rodar testes citados, secreto-redaction/phone/provider existentes, typecheck; review integrador+qualidade; commit somente paths desta tarefa com `feat: adiciona transporte de templates ao registry`.

## Task 3: Schema interno, binding e guardas de escrita

**Files:** Generate migration via `supabase migration new whatsapp_template_catalog`; generated suffix `_whatsapp_template_catalog.sql`; Create `supabase/tests/local-preflight/25-template-bootstrap.sql`, `supabase/tests/local-preflight/26-template-catalog.sql`; Modify `supabase/tests/local-preflight/README.md`, `scripts/function-acl-allowlist.json`, `scripts/function-acl-allowlist.test.ts`.

**Interfaces:** Tabelas internas `whatsapp_template_accounts`, `whatsapp_template_bindings`, `whatsapp_remote_templates`, `whatsapp_template_jobs`, `whatsapp_template_events`, `whatsapp_automation_jobs`, `whatsapp_message_consent_events`, `whatsapp_message_preference_tokens`, `whatsapp_promotion_slots`, `whatsapp_template_cost_authorizations`. Campos da seção 4 da spec, recursos como três FKs nullable com CHECK de exactly-one; `voucher_issued` só permite voucher_id.

- [ ] Criar teste SQL vermelho no banco local: duas orgs/três units/dois canais/customer/reservation/waitlist/voucher reais da fixture; INSERT WABA compartilhada na mesma org passa, cross-org e binding canal/unit divergente recusam; service_role consegue gravar, anon/authenticated não têm grants internos. Não tratar zero linhas como autorização.

```sql
do $$ begin
  if not exists (select 1 from pg_class where oid='public.whatsapp_template_accounts'::regclass
    and relrowsecurity and relforcerowsecurity) then
    raise exception 'TEMPLATE-RLS: RLS nao forcada';
  end if;
  if has_table_privilege('anon','public.whatsapp_template_accounts','SELECT') then
    raise exception 'TEMPLATE-ACL: anon ganhou leitura';
  end if;
end $$;
```

- [ ] Aplicar arquivos somente no banco local de teste segundo README; esperar relation absent antes de migration. Gerar migration com CLI e registrar caminho real na checklist de execução.
- [ ] Definir PK/FK/unique/check/índices de due_at/oldest nonterminal, categorias/status allowlist e CHECK de recursos. UNIQUE(waba_id) sem provider. Trigger confere unit.org/channel.unit/account.org/customer.org e recurso.unit; funções com helpers app_private qualificados. Credenciais não entram nessas tabelas.

```sql
alter table public.whatsapp_template_accounts enable row level security;
alter table public.whatsapp_template_accounts force row level security;
revoke all on table public.whatsapp_template_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.whatsapp_template_accounts to service_role;
```

Aplicar ACL equivalente explicitamente a cada tabela/sequence nova. Consentimentos via EF; append-only com exceção de purga por anonimização. Token só hash/expiry. Histórico de decisões não é uma linha editável que apague evidência. Cost authorization escopada à conta/categoria/generation/vigência/ator platform_admin.
- [ ] Guardar INSERT/UPDATE/DELETE de corpo/customized nas tabelas reservation/waitlist e a chave `giftback_message_template` em settings para oficial; não bloquear chaves de ativação/configuração ou `table_ready` manual fora do catálogo. Trigger confere papel e canal real; service_role não vira bypass genérico da imutabilidade. Administração de manutenção explícita e auditada. Não apagar texto legado. Tests owner/gerente/operador/platform_admin e tentativa REST direta.
- [ ] Validar idempotência por duas aplicações, rollback transacional e grants completos; migrations/ACL tests verdes; review db-schema+RLS/tenant; commit `feat: cria registros internos de templates e automacoes` com caminho CLI explícito.

## Task 4: RPCs do ledger, posse e transições

**Files:** Generate migration `whatsapp_automation_claims`; Create `supabase/functions/_shared/whatsapp-automation-core.ts`, `src/lib/whatsapp-automation-core.test.ts`, `supabase/tests/local-preflight/27-template-claims.sql`, `supabase/tests/local-preflight/28-template-concurrency.sh`; Modify `scripts/function-acl-allowlist.json`, `scripts/function-acl-allowlist.test.ts`, `supabase/tests/local-preflight/README.md`.

**Interfaces:** RPCs service-only: `enqueue_whatsapp_automation(p_intent jsonb)->uuid`, `claim_whatsapp_automation(p_job_id uuid)->jsonb`, `prepare_whatsapp_automation_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint)->boolean`, `finish_whatsapp_automation(p_job_id uuid,p_fence uuid,p_result jsonb)->boolean`, `select_due_whatsapp_automations(p_limit integer)->setof whatsapp_automation_jobs`. Claim SQL 90s; timeout POST 15s; nenhuma retomada de posting após 90s. Catalog RPCs correspondentes claim/start-sync/publish-sync/record-events transacionais compartilham o mesmo princípio; GET snapshot só publica se epoch ainda atual.

- [ ] Escrever testes vermelhos de chave estável/corte:

```ts
import {expect,it} from 'vitest';
import {logicalAutomationKey,selectAutomationPath}
  from '../../supabase/functions/_shared/whatsapp-automation-core.ts';
it('rollback adotado pausa sem retornar ao legado', () => {
  expect(selectAutomationPath({ledgerExists:false, adoptedAt:'2026-10-03T12:00:00Z',enabled:false})).toBe('paused');
  expect(selectAutomationPath({ledgerExists:true,adoptedAt:null,enabled:false})).toBe('scheduled');
});
it('procedência não cria envio novo', () => {
  const x={unitId:'u',kind:'reminder_d1' as const,reservationId:'r',factAt:'2026-10-03T20:00:00-03:00'};
  expect(logicalAutomationKey({...x,sourceEventKey:'a'}))
    .toBe(logicalAutomationKey({...x,sourceEventKey:'b'}));
});
```

- [ ] Rodar teste Vitest e SQL antes da implementação; confirmar falha. Implementar UPSERT por natural key com locks transacionais, consulta aos notifications_sent aceitos antigos e snapshot pinned de canal/provider/generation. Adopted_at preenchido só na ativação autorizada, nunca desfeito.
- [ ] Claim de queued/retry_wait/claimed vencido usa NOW do banco e fence novo, tenta somente job devido. claimed vencido é retomável se nunca iniciou POST; posting vencido vira uncertain, conserva fence e não é selecionado para POST. seleção não claim batch inteiro. Late accepted com mesmo fence em posting/uncertain registra evidência, nunca posse nova.

```sql
revoke all on function public.claim_whatsapp_automation(uuid) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_automation(uuid) to service_role;
-- Em UPDATEs de posse: WHERE id=p_job_id AND claim_token=p_fence
-- AND status='claimed' AND claimed_until > now(); conferir FOUND.
```

- [ ] prepare bloqueia geração/consentimento/epoch divergentes, trava preferência/slot e valida versão atual; todos os status de retorno têm semântica explícita. Testar fence errado, claim concorrente em duas sessões, fim tardio, postagem ambígua, ledger consultado com flag OFF, reclassification invalidando sync_epoch e jobs mudando para needs_review em troca de binding.
- [ ] Revoke explícito de todas as assinaturas/trigger functions. Tests com SQLSTATE esperado e controles positivos removendo fence/unique revelam regressão; review segurança/main; commit `feat: protege claims e transicoes das automacoes WhatsApp`.

## Task 5: Consentimento e saída pública segura

**Files:** Create `supabase/functions/_shared/whatsapp-message-preferences-core.ts`, `supabase/functions/whatsapp-message-preferences/index.ts`, `src/lib/whatsapp-message-preferences-core.test.ts`, `supabase/tests/local-preflight/29-template-preferences.sql`; Generate migration `whatsapp_message_preferences`; Modify `supabase/config.toml`, `scripts/function-acl-allowlist.json`, `scripts/function-acl-allowlist.test.ts`, `supabase/tests/local-preflight/README.md`.

**Interfaces:** `createPreferenceToken():Promise<{token:string;hash:string}>`, `hashPreferenceToken(token:string):Promise<string>`, `canSendPromotion({decision,doNotContact,deletedAt}):boolean`. RPC interno `revoke_whatsapp_promotion(p_token_hash text)->boolean` deriva unit/customer do token, nunca do body; hash/expiry/revoked e cliente vivo conferidos no SQL. Preferência current revision nasce da evidência append-only mais recente e é cercada pelo prepare de Task 4.

- [ ] Escrever testes vermelhos:

```ts
import {expect,it} from 'vitest';
import {canSendPromotion,createPreferenceToken,hashPreferenceToken}
  from '../../supabase/functions/_shared/whatsapp-message-preferences-core.ts';
it('ausência de recusa não autoriza promoções', () => {
  expect(canSendPromotion({decision:'unknown',doNotContact:false,deletedAt:null})).toBe(false);
});
it('só persiste hash de token aleatório', async () => {
  const a=await createPreferenceToken(), b=await createPreferenceToken();
  expect(a.token).not.toBe(b.token);
  expect(a.hash).toBe(await hashPreferenceToken(a.token));
  expect(a.hash).not.toBe(a.token);
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-message-preferences-core.test.ts`; tests SQL falham antes da RPC. Implementar WebCrypto 32 bytes aleatórios, base64url e SHA-256; TTL de 90 dias via SQL. Endpoint público verify_jwt=false, sem aceitar envio nem leitura de cliente. GET retorna unitLabel/valid/choice permitido; POST body `{token,action:'opt_out'}` exige confirmação explícita da UI.

```ts
const bytes = crypto.getRandomValues(new Uint8Array(32));
// Converter para base64url, sem '+'/'/'/'='; hash antes de gravar.
if (req.method !== 'GET' && req.method !== 'POST') return new Response(null,{status:405});
```

- [ ] Limitar tamanho, content-type, origem dos requests de mutação e volume sem registrar token bruto; GET/POST invalid/expired/revoked/alheio têm resposta sem PII/oráculo. GET de crawler não altera DB; POST repetido é idempotente. Não devolver token em log, error ou query key. UI pública adiciona Referrer-Policy no-referrer e não envia token a analytics.
- [ ] Atomic promotion slot por unit/customer: claimed/posting reserva provisoriamente; accepted/uncertain conserva janela de sete dias; rejeição definitiva libera. duas promoções simultâneas não passam juntas. Opt-out pós-enqueue antes de prepare impede POST. Trigger de anonimização limpa tokens/evidências conforme regra de privacidade sem criar referência pessoal nova; customers lock serializa corrida. Sem cadastro automático de cliente para feedback.
- [ ] Tests SQL de papéis, GET sem UPDATE, revogação unit-scoped e anonimização concorrente; review acesso/tenant; commit `feat: registra preferencias promocionais por unidade`.

## Task 6: Binding verificado e provisionamento durável

**Files:** Create `supabase/functions/_shared/whatsapp-template-state-core.ts`, `supabase/functions/_shared/whatsapp-template-account.ts`, `supabase/functions/_shared/whatsapp-template-sync.ts`, `supabase/functions/process-whatsapp-templates/index.ts`; Test `src/lib/whatsapp-template-state-core.test.ts`, `src/lib/whatsapp-template-sync.test.ts`; Modify `supabase/functions/manage-channels/index.ts`, `supabase/functions/_shared/platform-flags.ts` somente se houver allowlist, `supabase/config.toml`; Generate migration `whatsapp_template_workers` para flags/crons internos OFF.

**Interfaces:** `deriveTemplateState({remoteStatus,hashMatches,categoryAllowed,syncRequired,quality,promotional}):string`; `ensureTemplateAccount(channelId):Promise<{accountId:string;generation:number}>`; `syncTemplateAccount(accountId):Promise<{state:string;processed:number}>`. Serviços exportam factories injetáveis para tests; worker chama requireInternalAuth e processa uma conta/claim de cada vez.

- [ ] Escrever teste vermelho pending/unknown/hash divergente/reclassificado/RED promocional; aprovação antiga não supera syncRequired:

```ts
import {expect,it} from 'vitest';
import {deriveTemplateState} from '../../supabase/functions/_shared/whatsapp-template-state-core.ts';
it('evento invalida aprovação previamente utilizável', () => {
  expect(deriveTemplateState({remoteStatus:'APPROVED',hashMatches:true,
    categoryAllowed:true,syncRequired:true,quality:'GREEN',promotional:false})).not.toBe('usable');
});
```

- [ ] Rodar Vitest; implementar descoberta somente no backend após conexão autorizada. Datafy /me valida phone e WABA; não aceitar WABA body de lojista. Conta globalmente única com binding transacional; prepare de canal não ativo permitido, envio não. Reconexão/rotação invalida generation e jobs antigos, sem tocar atendimento por falta de WABA.
- [ ] Sincronização lista todas as páginas, detecta ciclo; compara nome+idioma+formato+componentes; match exato reutiliza, conflito preserva externo, ausente cria só com flag/submissão autorizada. Pós-timeout de criação marca submitting/reconcile e GET pelo nome+idioma antes de qualquer novo POST. Rejected exige ação/versão autorizada, nunca loop. Nova versão não retira anterior funcional.

```ts
const epoch = await deps.startSync(accountId);
const remote = await deps.listAll(accountId);
await deps.publishSync({accountId,epoch,remote}); // SQL recusa epoch ultrapassado.
```

`deps` é objeto injetado da factory de serviço definido no próprio arquivo, métodos tipados e test doubles locais; não usar singleton secreto em Vitest.
- [ ] Tests injetados de duas páginas/cursor cíclico, conflito, timeout GET encontra criado e createCount igual a 1, invalidation durante GET não publica, falha de GET não reabilita. Worker interno verify_jwt=false + requireInternalAuth; scheduler de cinco minutos e flags catálogo/despacho OFF via Vault project_url/internal_api_key, sem credencial literal. Coalescer por account/operação/revisão; alertar job falho e idade do não terminal, não só contagem failed.
- [ ] Purga sanitizados/terminais de 90 dias sem purgar queued/blocked/uncertain/needs_review; migrations locais duas aplicações; review integração+security; commit `feat: provisiona e sincroniza templates por WABA`.

## Task 7: Eventos WABA isolados do atendimento

**Files:** Create `supabase/functions/_shared/whatsapp-template-events-core.ts`, `supabase/functions/_shared/whatsapp-template-events.ts`, `src/lib/whatsapp-template-events-core.test.ts`; Modify `supabase/functions/webhook-whatsapp/index.ts`, `supabase/functions/_shared/whatsapp-meta-batch-core.ts` somente no dispatch de famílias; Test `src/lib/whatsapp-conversation-parity-guard.test.ts`, `src/lib/whatsapp-inbound-reentry.test.ts`, `src/lib/datafy-signature-core.test.ts`.

**Interfaces:** `validateTemplateEventBatch(payload:unknown,{wabaId,phoneNumberId}):{ok:boolean;reason?:string;management:unknown[]}`; `persistTemplateEvents({channelId,unitId,accountId,events}):Promise<void>`. Remote event records sanitizados/digest/processing e enqueue reconciliação são uma transação; payload bruto não vai a template_events.

- [ ] Escrever teste vermelho lote exclusivamente WABA válido sem metadata.phone_number_id e lote misto com mensagem alheia recusado inteiro:

```ts
import {expect,it} from 'vitest';
import {validateTemplateEventBatch} from '../../supabase/functions/_shared/whatsapp-template-events-core.ts';
it('mensagem alheia não usa a identidade WABA para passar', () => {
  const payload={entry:[{id:'waba-a',changes:[
    {field:'message_template_status_update',value:{message_template_id:'t1',event:'APPROVED'}},
    {field:'messages',value:{metadata:{phone_number_id:'phone-b'},messages:[]}}
  ]}]};
  expect(validateTemplateEventBatch(payload,{wabaId:'waba-a',phoneNumberId:'phone-a'}).ok).toBe(false);
});
```

- [ ] Rodar teste e confirmar FAIL. Antes de efeitos, usar assinatura/replay existente no corpo intacto, validar todas entries/changes por família; mensagem/status/echo seguem guarda de número atual. Gestões exclusivamente WABA usam entry.id/binding e alvo remoto verificado. Não comparar provider==='official' no webhook; registry resolve payload/assinatura.
- [ ] Persistir gestão antes do ACK; erro é 503, nenhuma parte válida do lote inválido faz efeito. Ingestão assíncrona permanece com duas flags/source/bytea atuais; reentrada não reinserta. Batch misto validado primeiro, persistido idempotente, depois encaminha mensagens ao caminho existente com source preservado. Evento de gestão não toca customer/conversa/IA/janela.

```ts
if (!validated.ok) return finish('webhook_unauthorized',401,{reason:validated.reason});
await persistTemplateEvents({channelId:channel.id,unitId:channel.unit_id,accountId,events});
// Apenas depois: encaminhar partes de mensagens/recibos pelo caminho existente.
```

- [ ] Paused/disabled/rejected bloqueiam imediatamente; qualquer category/components desconhecido incrementa sync_epoch e sync_required. Aprovação por evento não libera. Testar evento velho/payload inválido/dedupe/falha de persistência e spy zero IA/append; assinatura inválida retorna 401; erro gestão retorna 503; atraso GET antigo rejeitado.
- [ ] Tests de eco/hand-off/paridade/queue passam; review backend+identidade+integration reliability; commit `feat: processa eventos de templates sem alterar atendimento`.

## Task 8: Reutilizar infraestrutura de canal sem mudar sendText

**Files:** Modify `supabase/functions/_shared/whatsapp-send.ts`; Test `src/lib/whatsapp-template-channel-routing.test.ts`, `src/lib/whatsapp-channel-freshness-core.test.ts`, `src/lib/whatsapp-provider-secret-redaction.test.ts`, `src/lib/whatsapp-connection-allowance-guard.test.ts`.

**Interfaces:** Exportar `resolveScheduledChannel(unitId:string,channelId?:string)` e `prepareScheduledChannel(channelId:string,unitId:string)` com credenciais efêmeras e confirmação de frescor, sem expor ao cliente. `sendWhatsAppMessage`/SendMessagePayload/SendResult mantêm contrato antigo. Devolver projeção pinável para Task 9: id/unit/provider/generation e método sendTemplate, credencial apenas backend.

- [ ] Escrever caracterização vermelha da extração: três seleções (id, ativo, fallbackNULL) convergem nas mesmas guardas atuais; canal false nunca escolhido; unit sem canal não usa padrão global. Mock fetch/provider e banco via factory de infraestrutura; comparação do body/texto antigo antes/depois.

```ts
// No teste, usar provider fake local com sendText vi.fn e credencial sintética.
expect(textAdapter.sendText).toHaveBeenCalledWith(fakeCredentials,{toPhone:'11999990000',text:'Olá'});
expect(templateAdapter.sendTemplate).not.toHaveBeenCalled();
```

As variáveis desse trecho são criadas no setup do teste, não imports do registry real. Nenhum secret/servidor de produção.
- [ ] Rodar `npm run test -- src/lib/whatsapp-template-channel-routing.test.ts`; extrair resolução/gate/credencial/frescor de forma compartilhada mantendo wrappers antigos. ClearChannelConnectivityCache/clearWhatsAppGateCache por invocação em todos os consumidores, incluindo os novos.
- [ ] Novo fluxo exige status/generation/token atuais imediatamente antes do POST, sem isenção provider. Falha resolve bloqueio local; não alterar polaridade existente do service gate nem autorizar texto como fallback.
- [ ] Testar status stale e provider desconectado, falha de credencial no Vault, provider desconhecido, canal de unidade alheia, cache positivo limpo em segunda invocação. Caracterização dos quatro consumidores send-whatsapp/confirmation/cancellation/manual deve permanecer.
- [ ] Typecheck/Deno check e regressões verdes; review main+backend; commit `refactor: compartilha resolucao de canal para templates`.

## Task 9: Despacho estruturado e preflight final

**Files:** Create `supabase/functions/_shared/whatsapp-automation-resources.ts`, `supabase/functions/_shared/whatsapp-automation-dispatch.ts`, `supabase/functions/send-scheduled-whatsapp/index.ts`, `src/lib/whatsapp-automation-dispatch.test.ts`, `src/test/fixtures/whatsapp-automation-fixtures.ts`; Modify `supabase/config.toml`.

**Interfaces:** `loadScheduledResource(intent):Promise<{intent;customerId;phone;templateId;parameters;eligibility;generation;consentRevision;syncEpoch}>`; `dispatchScheduledIntent(intent):Promise<DispatchResult>`. Serviço produzido como factory de dependências injetadas. Fixtures exportam `createAutomationFixture(overrides)` retornando intent/resources/dbRPC/adapter/fetchSpies/calls e relógio fixo, sem tipos Deno remotos. `calls.post` conta chamadas externas; `calls.reconcile` conta reparos locais. Overrides `finalizeFailsOnce` e `templateStatus` alteram somente respostas das dependências; `dispatch` executa o serviço real. A tentativa de finalização não apaga a evidência de POST iniciada; a segunda invocação reconcilia o job aceito/incerto, sem novo envio.

- [ ] Escrever teste vermelho essencial, em fixture fake cujo POST incrementa calls.post e finalize pode falhar:

```ts
import {expect,it} from 'vitest';
import {createAutomationFixture} from '../test/fixtures/whatsapp-automation-fixtures';
it('aceite com falha local não repete POST', async () => {
  const f=createAutomationFixture({finalizeFailsOnce:true});
  await f.dispatch(f.intent);
  await f.dispatch(f.intent);
  expect(f.calls.post).toBe(1);
  expect(f.calls.reconcile).toBeGreaterThan(0);
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-automation-dispatch.test.ts`; implementar ordem: derivar recurso.unit/org → seleção/corte → enqueue existente → claim → carregar dados atuais → checar gate/conexão/consentimento/TTL → catálogo snapshot válido/GET se stale → renderizar → prepare SQL cercado → revalidar canal/posse → POST com timeout de 15 segundos → resultado → finalize/registro local. A passagem para posting pertence à tentativa/fence corrente; não fazer segundo POST após erro de gravação.
- [ ] Dados vêm dos recursos, não phone/template/isOfficial/params body. Valores BRT time normalizados HH:MM; Intl IANA por units.timezone, ausente America/Sao_Paulo, inválido blocked. Links via origem configurada/routes, `applied_discount_percent>0` escolhe variante; kind confirmation independente da variante na unique key. voucher_issued só aceita ID voucher emitido, sem emitir benefício.

```ts
const resource = await deps.reloadResource(intent);
const eligible = await deps.checkEligibility(resource);
if (!eligible.ok) return deps.block(jobId,eligible.reason);
const ready = await deps.preparePost({jobId,fence,generation:resource.generation,
  consentRevision:resource.consentRevision,syncEpoch:resource.syncEpoch});
if (!ready) return deps.block(jobId,'preflight_changed');
return deps.postOnceAndFinalize({jobId,fence,resource});
```

- [ ] API aceita JSON de intenção validado (Zod/pure guard), x-internal-key ou JWT conforme ação (verify_jwt=false no gateway, autenticação obrigatória na aplicação), não confia em user unit sem recurso. JWT reenvio valida papel/tipos atuais; webhook IA nunca chama esta EF. Respostas blocked/queued não são sent; body inclui state/reason seguro. Limite de 4096 caracteres e formato de componente do provider; nenhum segredo/error.message cru.
- [ ] Testar pending/payment/cancelled/no_show, reserva remarcada, timezone IANA inválida, dia incorreto/horário passado, nota já respondida, seated errado, consentimento desconhecido/opt-out/anonimização após enqueue, autorização de custo sem vigência, status pending/qualidade RED/hash divergente/categoria incompatível, snapshot vencido e GET falha, canal trocado, flag OFF após adoção, TTL vencido não grava notifications_sent, timeout uncertain, callback antes de finalize, ACK tardio, fence perdido. accepted faz recordNotification tenant-scoped e appendOutboundToConversation com eventId estável `automation:{jobId}:accepted`, author automation existente e texto do renderer.
- [ ] Review backend/security; typecheck/Deno check/test; commit `feat: despacha automacoes com templates e preflight`.

## Task 10: Confirmação, lembrete e pesquisa existentes

**Files:** Modify `supabase/functions/send-confirmation/index.ts`, `supabase/functions/process-notification-outbox/index.ts`, `supabase/functions/process-reservation-reminders/index.ts`, `supabase/functions/process-satisfaction-surveys/index.ts`; Create `src/lib/whatsapp-reservation-automation-routing.test.ts`; ampliar `src/test/fixtures/whatsapp-automation-fixtures.ts`.

**Interfaces:** Consome `ScheduledIntent`, `DispatchResult`, `selectAutomationPath` e `dispatchScheduledIntent` das Tasks 4/9. Produz encaminhamento exclusivo por intenção; outbox aguarda o ledger, sem retry de POST paralelo. E-mail e `resend_whatsapp_only` conservam seus contratos.

- [ ] Escrever teste vermelho usando `createAutomationFixture` da Task 9. Acrescentar à fixture `runReservationProducer(kind, resourceOverrides)`, que executa o handler real com banco/fetch injetados. Registrar `calls.email`, `calls.legacyText`, `calls.post` e `calls.recordSent`.

```ts
import {expect,it} from 'vitest';
import {createAutomationFixture} from '../test/fixtures/whatsapp-automation-fixtures';
it('bloqueio não vira aceite nem impede e-mail', async () => {
  const f=createAutomationFixture({templateStatus:'PENDING'});
  await f.runReservationProducer('confirmation',{source:'web',status:'confirmed'});
  expect(f.calls.post).toBe(0);
  expect(f.calls.recordSent).toBe(0);
  expect(f.calls.email).toBe(1);
});
it('origem WhatsApp não duplica confirmação', async () => {
  const f=createAutomationFixture({});
  await f.runReservationProducer('confirmation',{source:'whatsapp',status:'confirmed'});
  expect(f.calls.post).toBe(0);
  expect(f.calls.legacyText).toBe(0);
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-reservation-automation-routing.test.ts`; esperar FAIL por factory/roteamento ausente.
- [ ] Trocar só a perna automática WhatsApp por seleção/intenção. OFF sem adoção chama legado; OFF após adoção pausa; ledger existente nunca retorna ao legado. `sourceEventKey` deriva do outbox/registro existente, `factAt` do fato original. Notificação manual autorizada conserva intenção/origem. Não acrescentar produtor/cron.

```ts
const result = await dispatchScheduledIntent(intent);
const accepted = result.state === 'accepted'; // HTTP 200 não prova aceite.
```

- [ ] Preservar lembrete 10h BRT no próprio dia e pesquisa 14h BRT D+1, confirmed sem nota. Relê remarcação/estado/nota no despacho. Pesquisa reclassificada MARKETING bloqueia nesta versão; textos não oficiais continuam como estão.
- [ ] Testar hora atual após remarcação, payment pending, variante com desconto, concorrência outbox/worker/reenvio com um POST e e-mail com WhatsApp bloqueado. Confirmação via IA e voucher após avaliação ficam fora do catálogo.
- [ ] Rodar teste focado/typecheck; reviews spec/qualidade/backend; commit `feat: encaminha automacoes de reserva ao novo despacho`.

## Task 11: Fila e vouchers programados existentes

**Files:** Modify `supabase/functions/process-waitlist-entered/index.ts`, `supabase/functions/process-waitlist-feedback/index.ts`, `supabase/functions/process-voucher-triggers/index.ts`; Create `src/lib/whatsapp-waitlist-voucher-routing.test.ts`; ampliar `src/test/fixtures/whatsapp-automation-fixtures.ts`.

**Interfaces:** Consome seleção/intenção/despacho das Tasks 4/9. Produz entered/feedback/voucher_issued com FK correta. Voucher programado permanece inserido antes do envio; retry encontra o mesmo benefício pela chave idempotente existente.

- [ ] Escrever teste vermelho. Fixture implementa `runVoucherProducer()` pelo handler real e registra `voucherInsertCount`, `deletedVoucherIds`, `sentIntents`. Banco fake simula INSERT vencedor, conflito 23505 e releitura.

```ts
import {expect,it} from 'vitest';
import {createAutomationFixture} from '../test/fixtures/whatsapp-automation-fixtures';
it('bloqueio preserva voucher e identidade no retry', async () => {
  const f=createAutomationFixture({templateStatus:'PENDING'});
  await f.runVoucherProducer();
  await f.runVoucherProducer();
  expect(f.voucherInsertCount).toBe(1);
  expect(new Set(f.sentIntents.map(x=>x.voucherId)).size).toBe(1);
  expect(f.deletedVoucherIds).toEqual([]);
  expect(f.calls.post).toBe(0);
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-waitlist-voucher-routing.test.ts`; esperar FAIL relevante.
- [ ] Inserir seleção/intenção nos pontos atuais de envio, preservando suspensão/serviço, voucher às 9h BRT e pesquisa às 14h BRT. `factAt` conserva emissão/fato, nunca data do retry. Aniversário/frequência/min_rating/expiração/benefício mantêm regras atuais.

```ts
const intent: ScheduledIntent = {unitId:voucher.unit_id,kind:'voucher_issued',
  voucherId:voucher.id,sourceEventKey:voucher.id,factAt:voucher.created_at};
await dispatchScheduledIntent(intent);
```

- [ ] entered exige waiting e código/token atuais; feedback exige seated ontem e destino atual. Promoção exige cliente identificável da organização e consentimento, sem cadastro por nome. Formulário de feedback permanece.
- [ ] Testar 23505 concorrente, cliente alheio/inativo, voucher expirado, opt-out entre INSERT/preflight, feedback sem customer e editor não oficial. Mesa manual table_ready/cancelamento/voucher after_rating conservam caminhos existentes.
- [ ] Rodar teste/typecheck; reviews fila/giftback/spec/qualidade; commit `feat: encaminha fila e vouchers programados ao despacho`.

## Task 12: Retry seguro, reconciliação e Entregas

**Files:** Create `supabase/functions/process-whatsapp-automations/index.ts`, `src/lib/whatsapp-automation-worker.test.ts`; Modify `supabase/functions/resend-notification/index.ts`, `src/pages/operacional/Entregas.tsx`, `src/hooks/useComunicacao.ts`, `supabase/config.toml`, `supabase/functions/_shared/whatsapp-automation-core.ts`, `supabase/tests/local-preflight/27-template-claims.sql`; Generate migration `whatsapp_automation_worker_cron`.

**Interfaces:** Produz `nextRetryDelay(attempt:number):number|null` no núcleo da Task 4. Worker consome RPCs/dispatcher, lote até 20, sequencial por canal. Reenvio conserva whitelist confirmation/waitlist_entered/table_ready; table_ready segue manual. Aceito/lido/entregue não é reaberto por esta feature.

- [ ] Escrever teste vermelho de backoff/seleção: uncertain e posting vencido nunca geram repost; claimed vencido é retomável se nenhum POST iniciou.

```ts
import {expect,it} from 'vitest';
import {nextRetryDelay} from '../../supabase/functions/_shared/whatsapp-automation-core.ts';
it('limita cinco tentativas totais', () => {
  expect([1,2,3,4,5].map(nextRetryDelay))
    .toEqual([60000,240000,960000,3840000,null]);
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-automation-worker.test.ts src/lib/whatsapp-automation-core.test.ts`; esperar FAIL antes de implementar.
- [ ] Implementar cron interno de 1 minuto como consumidor via Vault, flags/opt-in OFF. verify_jwt=false exige requireInternalAuth. Deadline só impede próximo job, sem abandonar POST em pending. Respeitar TTL e espera documentada pelo provider.

```ts
export function nextRetryDelay(attempt:number):number|null {
  return [60000,240000,960000,3840000][attempt-1] ?? null;
}
```

- [ ] Reparar aceite/histórico/notification sem POST. Correlacionar callbacks por unit/provider/channel/message; callback antecipado conserva evidência, nunca aplica por ID isolado. Sem ID conhecido não inventar delivered. uncertain aguarda evidência; só rejeição explícita comprovadamente não aceita entra no retry.
- [ ] Reenvio de blocked/needs_review revalida recurso/modalidade/TTL/geração; uncertain recusado. Entregas usa projeção autorizada, sem SELECT direto nas tabelas internas. Notificações antigas aceitas impedem repetição.
- [ ] Testar falha após aceite, late ACK, callback antecipado, limite de tentativas, expiração sem failed, flag OFF e idade do não terminal mais antigo inclusive blocked/uncertain. Rodar teste/typecheck/Deno check; reviews confiabilidade/tenant/spec/qualidade; commit `feat: reconcilia automacoes sem reenvio ambiguo`.

## Task 13: API de gestão client-safe e papéis

**Files:** Create `supabase/functions/_shared/whatsapp-template-access-core.ts`, `supabase/functions/manage-whatsapp-templates/index.ts`, `src/lib/whatsapp-template-access-core.test.ts`; Modify `supabase/config.toml`. Liberação usa gestão de canal existente, sem painel Marketing.

**Interfaces:** Produz `canManageTemplateAction(role:'owner'|'gerente'|'operador'|null,action:TemplateAction,isPlatformAdmin:boolean):boolean`. `TemplateAction` é snapshot|sync|revalidate_job|record_consent|release_channel|authorize_marketing_cost. DTO puro inclui mode/channelId/providerLabel/capabilities/templates/blockedJobs/generatedAt, sem WABA/business ID/credencial/token. EF recebe ação discriminada/unit_id e deriva tenant de cada recurso.

- [ ] Escrever teste vermelho de papel/ação e projeção sem secrets.

```ts
import {expect,it} from 'vitest';
import {canManageTemplateAction} from '../../supabase/functions/_shared/whatsapp-template-access-core.ts';
it('operador não registra consentimento nem libera canal', () => {
  expect(canManageTemplateAction('operador','record_consent',false)).toBe(false);
  expect(canManageTemplateAction('operador','release_channel',false)).toBe(false);
  expect(canManageTemplateAction(null,'release_channel',true)).toBe(true);
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-template-access-core.test.ts`; esperar FAIL por export ausente.
- [ ] JWT via getUser; snapshot membro/platform_admin, gestão owner/gerente, liberação/custo/versão só platform_admin. hasUnitAccess não prova papel: consultar à parte. Erro de auth/query recusa. Recurso alheio/inexistente tem recusa segura equivalente.

```ts
if (!canManageTemplateAction(role,action,isPlatformAdmin)) {
  return Response.json({error:'forbidden'},{status:403});
}
// Conferir job.unit_id, customer.organization_id e channel.unit_id antes de mutar.
```

- [ ] sync coalesce apenas catálogo autorizado; release_channel grava adopted_at sticky/opt-in transacional. record_consent exige evidência individual/origem/data/referência, sem marcar a base. Custo exige conta/categoria/geração/vigência; do_not_contact=false não autoriza promoção.
- [ ] revalidate_job só aceita blocked/needs_review elegível, jamais uncertain. Usar erros fechados. Guarda SQL da Task 3 resiste REST direto e libera configuração independente.
- [ ] Testar papéis reais localmente, duas orgs/admin sem membership, DTO sanitizado, rotação invalidando binding/erro de flag 503. Rodar teste/typecheck/Deno check; reviews identidade/backend/spec/qualidade; commit `feat: expoe gestao autorizada dos templates`.

## Task 14: Telas existentes e preferências públicas

**Files:** Create `src/hooks/useWhatsappTemplates.ts`, `src/components/whatsapp/OfficialAutomationTemplate.tsx`, `src/components/whatsapp/OfficialAutomationTemplate.test.tsx`, `src/pages/public/PreferenciasMensagens.tsx`, `src/pages/public/PreferenciasMensagens.test.tsx`; Modify `src/pages/gestao/reservas/Comunicacao.tsx`, `src/pages/gestao/fila/Comunicacao.tsx`, `src/pages/gestao/giftback/Ajustes.tsx`, `src/App.tsx`. Manter hooks legados para edição não oficial/configuração.

**Interfaces:** Hook consome DTO da Task 13. Componente recebe `template:OfficialTemplateView` e `onSync:()=>void`. Definir OfficialTemplateView no núcleo puro client-safe: body, footer, requestedCategory, effectiveCategory, status, quality, language, hashMatches, syncedAt, blockReason. Rota `/preferencias/mensagens/:token` fora do BillingGuard/admin.

- [ ] Escrever teste vermelho completo; acrescentar casos não oficial/unavailable nas três telas e GET sem mutação na página pública.

```tsx
import {render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {OfficialAutomationTemplate} from './OfficialAutomationTemplate';
it('mostra impedimento sem editor oficial', () => {
  render(<OfficialAutomationTemplate onSync={vi.fn()} template={{
    body:'Modelo fixo',footer:null,requestedCategory:'UTILITY',
    effectiveCategory:'UTILITY',status:'pending',quality:'UNKNOWN',
    language:'pt_BR',hashMatches:true,syncedAt:null,blockReason:'template_pending',
  }} />);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByText('Pendente de análise')).toBeInTheDocument();
  expect(screen.queryByText('Personalizar mensagem')).not.toBeInTheDocument();
});
```

- [ ] Rodar `npm run test -- src/components/whatsapp/OfficialAutomationTemplate.test.tsx src/pages/public/PreferenciasMensagens.test.tsx`; esperar FAIL antes de implementar.
- [ ] React Query com key exata, sem foco refetch; fetchAuthorizedTemplateSnapshot é função do hook que chama action snapshot/valida DTO. Non-2xx extrai FunctionsHttpError.context.json. Loading/error+retry/empty/unavailable distintos; provider sai do snapshot real, não default da org.

```ts
const query=useQuery({queryKey:['whatsapp-templates',unitId],enabled:!!unitId,
  refetchOnWindowFocus:false,queryFn:()=>fetchAuthorizedTemplateSnapshot(unitId)});
```

- [ ] Reservas/fila/giftback oficiais: BODY/FOOTER somente leitura, categorias pedida/efetiva, qualidade desconhecida explícita, última sync e bloqueio. “Salvar configuração” grava ativação separada. Não oficial preserva textarea/chips/prévia/restaurar/texto salvo; table_ready manual conserva editor.
- [ ] GET público mostra unidade/opção sem PII; botão “Não receber ofertas desta unidade” faz POST explícito. Confirmado/inválido/expirado; sem analytics/token em log, no-referrer, foco/tap 44px. Captura individual de consentimento nos ajustes exige papel/evidência, sem CRM.
- [ ] Testar três superfícies, forms não salvos, retry/loading/unavailable, save oficial recusado, POST só confirmado, papéis/mobile/foco. Rodar testes/typecheck; reviews frontend/design-ux/spec/qualidade/checklist React; commit `feat: mostra templates oficiais nas telas de comunicacao`.

## Task 15: História completa local e controle do atendimento

**Files:** Create `src/lib/whatsapp-scheduled-templates-integration.test.ts`, `supabase/tests/whatsapp-scheduled-templates.integration.md`; ampliar fixture e testes SQL/componentes das Tasks 3–14.

**Interfaces:** Cenário usa handlers reais produtor→dispatch→provider fake→aceite→notification/histórico→callback. Fixture exporta `runChatControl(input)` e `chatCalls`, usando núcleo existente de atendimento com I/O fake, sem mockar decisões sob teste. Banco local exercita SQL e Supabase/PostgREST/RLS/ACL separadamente.

- [ ] Escrever controles: IA por sendText; handoff limpa lock; nota/comentário e voucher after_rating com commit pós-envio; eco com autor atendente; nenhum cria automation job. Fixtures datadas/redigidas vêm de fontes primárias ou testes existentes, sem inventar envelope.

```ts
import {expect,it} from 'vitest';
import {createAutomationFixture} from '../test/fixtures/whatsapp-automation-fixtures';
it('atendimento continua respondendo texto', async () => {
  const f=createAutomationFixture({});
  await f.runChatControl({kind:'customer_text',text:'Quero reservar'});
  expect(f.chatCalls.sendText).toBe(1);
  expect(f.chatCalls.sendTemplate).toBe(0);
  expect(f.chatCalls.enqueueAutomation).toBe(0);
});
```

- [ ] Rodar `npm run test -- src/lib/whatsapp-scheduled-templates-integration.test.ts`; esperar FAIL antes da integração da fixture. Implementar apenas adaptação de teste/injeção, sem mudança de atendimento.
- [ ] Cobrir callback sem abrir janela/IA, gestão WABA sem customer/histórico, GET sem mudança, opt-out interrompendo promoção enfileirada/voucher único. Duas sessões SQL provam claim/slot/WABA/anonimização pelo relógio DB.
- [ ] Rodar `npm run lint`, `npm run test`, `npm run typecheck`, `npm run build`; Deno check de EFs novas/alteradas/consumidores. Runtime ausente é gate pendente; frontend tsc não prova Deno.
- [ ] Supabase/PostgREST local exercita anon, authenticated próprio/alheio, operador/owner/gerente/platform_admin/service_role: REST interno negado, ação por papel. Harness PostgreSQL isolado não prova JWT/RLS/PostgREST. Confirmar help/endpoint local antes de comando, sem produção.
- [ ] Mapear spec §11 à evidência: catálogo 1; auth 3/4/5/13; provisioning 2/6; webhook 7; envio 8/9/12; automações 10/11; atendimento 15; preferências 5/9/14; interface 14; rollout 16. Corrigir falha com regressão, sem remover teste.
- [ ] Review QA/spec/qualidade; commit `test: verifica templates programados e atendimento preservado`, relatório com resultados/limitações sem PII.

## Task 16: Gates, documentação e entrega integrada

**Files:** Create `docs/whatsapp-templates-programados-runbook.md`; Modify `CLAUDE.md` e `AGENTS.md` juntos. Não acrescentar CI sem necessidade; ACL segue workflows existentes.

**Interfaces:** Código local com flags OFF; commits revisados integrados ao destino. Runbook registra migrations, dependências de EFs, comandos revisados e gates externos pendentes; não executa rollout.

- [ ] Executar seis saas-shield-br gates: rls-auditor, tenant-isolation-auditor, identity-access-auditor, migration-validator, secret-hunter, integration-reliability-auditor; review whole-branch independente. Gate ausente é identificado; completar trabalho independente sem fingir aprovação/mergear gate pendente.
- [ ] PR com SQL/ACL exige acl-estatico nos Checks antes do merge. Teste local não é Check remoto. Audit autoritativo scripts/audit-function-acl.ts/acl-com-banco usa só banco autorizado. Sem PR, informar ausência de Check remoto, sem inventar resultado.
- [ ] Revisar 100% staged/secrets, git status/diff/diff --cached/diff --check, paths explícitos. AGENTS/CLAUDE equivalentes; regras permanentes, sem status transitório.
- [ ] Enumerar imports transitivos reais. Base registry/client: webhook-whatsapp, send-whatsapp, send-confirmation, send-cancellation, send-manual-message, manage-channels, whatsapp-health, manage-organizations, process-whatsapp-channel-health. Acrescentar consumidores novos; extração de whatsapp-send mantém seus quatro consumidores antigos na matriz. Não redeployar neste handoff.
- [ ] Runbook: migrations/ACL antes de EFs, frontend depois, flags OFF; autorização submissão/WABA piloto; aprovação/categoria/hash/eventos; consentimento/custo; envio único autorizado; opt-in; observar backlog/blocked/uncertain/delivery; expansão autorizada. Meta sem contrato comprovado continua unsupported. Sem replay retroativo/novo cron promocional.
- [ ] Rollback: API action release_channel com enabled=false pausa não postados, mantém adopted_at/ledger e reconcilia posting/uncertain sem novo POST. Não retorna ao texto oficial livre. Não SQL no Studio/drop de tabelas.
- [ ] Gates verdes: commit `docs: registra contratos e rollout de templates`; merge local preservando trabalho alheio, resolução/review/regressão se conflito/destino mudou. Sem push/deploy/migration produção/submissão/mensagem real.
- [ ] Entregar SHA/branch integrada, resultados reais/testes/gates e dependências externas. Implementação local não comprova homologação nem produção liberada.

## Revisão deste plano e fontes

Revisão própria de arquitetura/segurança: WABA independente do transporte, identidade de lote misto, epoch concorrente, fencing de POST ambíguo, consentimento/slots e preservação do atendimento têm tarefas e testes indicados. Nenhuma auditoria externa, implementação, consulta a banco real ou homologação foi executada nesta etapa.

Fontes Datafy/WhatsApp no [anexo de auditoria](../specs/2026-10-03-whatsapp-templates-programados-auditoria.md). [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security) e [autenticação de Edge Functions](https://supabase.com/docs/guides/functions/auth) consultadas em 2026-10-03. Grants e policies são distintos; gateway JWT desabilitado exige autenticação na aplicação. Leitor web recusou changelog.md por content-type; verificar changelog/CLI vigente, sem concluir ausência de breaking changes.

O [prompt de handoff](2026-10-03-whatsapp-templates-programados-prompt.md) encaminha plano/spec para execução quando o usuário o colar no outro chat. Esta entrega prepara documentos; checkboxes permanecem desmarcados.
