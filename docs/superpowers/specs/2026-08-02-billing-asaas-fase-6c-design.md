# Fase 6c — Painel de instâncias completo e runbook do fluxo manual

**Data:** 2026-08-02
**Estado:** design aprovado, pronto para plano de implementação
**Precede:** Fase 6b (em produção desde 2026-08-02, em observação de 3 dias)

---

## 1. Contexto

A Fase 6b entregou o inventário de instâncias de WhatsApp: tabela `whatsapp_instances`,
ledger de ciclos, ledger de alertas, worker diário de cinco passos e painel de leitura em
`/platform/instancias-whatsapp`.

A Edge Function `manage-whatsapp-instances` expõe treze ações. **Três não têm nenhuma
interface:** `register_instance`, `update_instance` e `reactivate`. O primeiro registro real
da fase — a instância do Ren Sushi — foi feito pelo console do navegador, chamando a EF na
mão. Isso não é operável.

A causa raiz é conhecida e não muda nesta fase: **não temos a API de Parceiro da Z-API.**
Sem ela, criar e cancelar instância no fornecedor é ato humano no painel deles. O inventário
é a afirmação da plataforma sobre o que existe lá fora, e o worker é quem cobra essa
afirmação de volta.

## 2. Objetivo

1. Dar interface às três ações órfãs.
2. Consertar a perda de histórico em `notes`.
3. Publicar o runbook operacional do fluxo manual assistido.

### Atualização de status (2026-08-03): deixou de ser conveniência operacional

Quando esta spec foi escrita, a 6c era ergonomia — o registro pelo console do navegador
funcionava, só era ruim. **Ela virou pré-requisito duro do Plano C (downgrade).**

O downgrade revoga o WhatsApp no SaaS mas **não** cancela a cobrança da Z-API: ele abre um
`request_cancellation`, e cancelar de fato no fornecedor continua sendo ato humano. Sem o painel
desta fase, essa pendência não tem superfície — o cliente perde o serviço, a plataforma segue
pagando **R$ 99,90/mês** por uma instância que ninguém vai olhar, e o único aviso
(`END_CONFIRMATION_REQUIRED`) hoje não vira e-mail (§10). O custo corre em silêncio.

Consequência para a ordem de trabalho: a 6c precede o Plano C, e o §7 (Reativar) e o §10/R3
(cancelar) deixam de ser caminhos raros — são o fluxo normal do downgrade.

## 3. Escopo

### Entra

| Item | Onde |
|---|---|
| Diálogo **Registrar instância** (backfill) | `src/pages/platform/WhatsappInstances.tsx` |
| Diálogo **Corrigir vínculo** (`update_instance`) | idem |
| Ação **Reativar** (`reactivate`) | idem |
| **Ledger de observações** (`whatsapp_instance_notes`) | migration nova + EF + UI |
| Nome da organização no lugar do UUID cru | `WhatsappInstances.tsx` |
| Link no menu lateral da plataforma | sidebar `/platform` |
| **Runbook do fluxo manual** | `docs/billing-asaas/` |

### Não entra, e por quê

- **`NEW_PROVISION`** — bloqueado por `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A`.
  Botão que sempre devolve 409 é botão fantasma.
- **`AWAITING_PROVISION`** — a fila de "cliente pagou, instância ainda não existe" já vive em
  `whatsapp_implementations`. Duas filas para o mesmo fato é pior que uma. O estado continua
  alcançável no schema, no núcleo e no worker, a custo baixo, se algum dia for preciso.
- **Qualquer chamada à Z-API** — a fase inteira nunca fala com o fornecedor.
- **Flag nova, decisão comercial, mudança no worker ou nos núcleos puros de decisão.**

### Decisão de fluxo: registrar depois de criar

Toda instância nasce no painel da Z-API e **depois** é registrada aqui — ou seja, todo
registro é `BACKFILL_EXISTING`. Não há seletor de intenção na interface.

A alternativa avaliada (registrar antes, provisionar depois) foi descartada: ela não protege
custo nenhum, porque o custo começa no clique dentro da Z-API, não no registro. O valor real
dela seria uma fila rastreada de pedidos pendentes — que já existe em
`whatsapp_implementations`.

---

## 4. Arquitetura

O frontend fala com duas Edge Functions que já existem e já validam `platform_admin` no JWT:

- `manage-whatsapp-instances` — as ações de inventário.
- `manage-channels` — a lista de canais de uma unidade (`whatsapp_channels` é `FORCE RLS`).

Os dados de preenchimento saem de hooks existentes:

- `useAllUnits()` → `{id, slug, name, organization_id, organization_name, organization_slug}`.
  Um seletor de unidade entrega organização e unidade de uma vez.
- `useWhatsAppChannels(unitId)` → canais da unidade, via EF.

**A validação continua autoritativa no backend.** A interface valida para evitar a viagem,
nunca para substituir o guarda. Nenhum grant nem RPC nova; a superfície de isolamento
multi-tenant não muda — exceto pela tabela nova do §8, que nasce `FORCE RLS` **com** a policy
`platform_admin_all_*`, no padrão das três irmãs desta fase (087/088/089).

---

## 5. Tela A — Registrar instância (backfill)

### Entradas

Botão no cabeçalho, botão no estado vazio, e **botão no card do alerta `DIVERGENCE`** do tipo
`CHANNEL_WITHOUT_INSTANCE` — esse alerta já carrega o `channel_id`, então pré-preenche o
formulário. O alerta deixa de ser aviso e vira o começo da tarefa.

### Campos

| Campo | Origem | Obrigatório na UI | Aceito pela EF |
|---|---|---|---|
| Unidade | `useAllUnits()` | **sim** | `organization_id` obrigatório, `unit_id` opcional |
| Canal | `useWhatsAppChannels(unitId)` | não | opcional |
| Identificador no fornecedor | texto livre | **sim** | opcional |
| Custo mensal (R$) | texto → centavos | não | opcional |
| Procedência do custo | `COST_SOURCES` | sim, se houver custo | idem |
| Motivo | textarea | sim | obrigatório |

O corpo enviado carrega `intent: "BACKFILL_EXISTING"` fixo e `provider: "zapi"`.

### Três restrições da UI mais apertadas que o backend

- **Unidade obrigatória.** A EF aceita `unit_id: null`, mas instância sem unidade não é
  alcançada por nenhum alerta do worker e vira órfã silenciosa.
- **Canal opcional.** É realista que a instância exista na Z-API antes de o canal estar
  configurado. É o buraco que a Tela B fecha depois.
- **Identificador obrigatório.** Sem ele o índice único `(provider, provider_instance_ref)`
  não deduplica, e registrar duas vezes a mesma instância física passa batido.

  **Atualização (Plano A, 2026-08-03): deixou de ser só disciplina de UI — o backend recusa.**
  O allowance de conexões trata `providerInstanceRefKnown: false` numa operação fixa
  `BACKFILL_EXISTING` como `BACKFILL_WITHOUT_PROVIDER_REF` → **409**, com a mensagem "Informe o
  identificador da instância no fornecedor: só é possível registrar instância que já existe lá."
  (`manage-whatsapp-instances/index.ts`, `ALLOWANCE_DENIED_MESSAGE`). Backfill sem referência é
  provisionamento novo entrando por outra porta, sem passar pelo teto. **O campo nasce
  obrigatório no formulário** — não como "melhor preencher", senão o admin descobre pelo 409.
  Registrado em `FASE-DOIS-PLANOS-PENDENCIAS.md` §2.4.

O campo do identificador leva a advertência **antes** do erro, não só depois:
*"apenas o identificador da instância, nunca a URL — ela contém o token."*
`validateProviderInstanceRef` recusa URL, espaço e mais de 128 caracteres.

### Conversão de valor

O usuário digita reais (`99,90`); a EF exige inteiro em centavos (`9990`). A conversão é
função pura em `src/lib/`, testada. `parseCostCents` recusa não-inteiro, negativo e
não-número; vazio significa **custo desconhecido**, não zero.

### Encadeamento

A instância nasce `cycle_source: "UNKNOWN"`, o que faz o worker abrir `DATE_REVIEW_REQUIRED`
na execução seguinte. Em vez de esperar um dia, o diálogo **emenda direto na confirmação da
data do ciclo**, que já tem interface. Foi assim que a instância do Ren Sushi foi operada, em
dois passos manuais.

### Erros mapeados

| Código | Mensagem da EF | Leitura |
|---|---|---|
| 409 `23505` | "Esta instância ou este canal já está registrado." | duplicata |
| 409 `23514` | "Unidade ou canal pertence a outra organização." | guarda de tenant |
| 400 `REF_LOOKS_LIKE_URL` | mensagem sobre o token | colou a URL |

---

## 6. Tela B — Corrigir vínculo

Campos: unidade, canal, identificador, data prevista de provisionamento, motivo.

**Restrição que define a implementação:** a EF decide o que gravar por `"campo" in body`.
Mandar uma chave significa *escreva isto, inclusive `null`*. Um formulário ingênuo, que
enviasse o objeto inteiro, **apagaria o canal** de quem só quis corrigir o identificador.

O diálogo envia **somente os campos alterados**. Essa diferença sai do componente e vira
função pura testada:

```
buildUpdatePatch(original, form) → objeto só com o que mudou
```

Regras: campo intocado não aparece no patch; campo esvaziado aparece como `null`; patch vazio
não dispara requisição.

---

## 7. Tela C — Reativar

Botão visível **somente** em `lifecycle_state === "CANCELLATION_REQUESTED"`.

`ENDED` não mostra nada: `canTransition` recusa mesmo com evidência, e oferecer um botão que
sempre falha é mentir para o operador. Instância encerrada que reapareça no fornecedor exige
linha nova.

Um campo, obrigatório: a evidência de que o cancelamento foi desfeito no fornecedor.

---

## 8. Correção da perda de histórico em `notes`

### O defeito

A migration 087 declara, no bloco de rollback, que `notes`, `cost_note`,
`cancellation_reason` e `end_confirmation_note` "registram DECISÃO HUMANA sobre o que a
plataforma paga ao fornecedor, e não têm segunda cópia — o painel da Z-API não reconstrói
nenhum deles."

E a EF escreve `notes: reason` em `register_instance`, `update_instance` e `reactivate` —
sobrescrevendo. Cada ação apaga a justificativa da anterior. `updated_by` sofre do mesmo mal:
guarda só o último autor. A tabela promete auditoria e entrega último-valor.

### Por que não usar `audit_log`

O caminho mais barato seria pendurar o trigger genérico `audit_trigger_func()` em
`whatsapp_instances`: quatro linhas de migration, zero mudança na EF, histórico de todas as
colunas, e imune a esquecimento de escritor futuro.

**Está descartado por vazamento.** O trigger preenche `organization_id`, e `audit_log` tem a
policy `unit_member_read_audit`, que libera leitura para membro da organização. Auditar
`whatsapp_instances` ali entregaria `current_monthly_cost_cents` — o que a plataforma paga ao
fornecedor — para os membros do próprio cliente. É exatamente o que o `FORCE RLS` da tabela
existe para impedir.

### O conserto

Tabela nova `whatsapp_instance_notes`, no mesmo padrão dos dois ledgers da fase:

```sql
create table if not exists whatsapp_instance_notes (
  id              uuid primary key default gen_random_uuid(),
  -- Identidade histórica IMUTÁVEL, no padrão de whatsapp_instance_alerts.subject_id:
  -- a observação sobrevive à remoção da instância. Sem CHECK exigindo instance_id
  -- not null — foi assim que a 089 tornou o `on delete set null` inexecutável.
  instance_ref    uuid not null,
  instance_id     uuid references whatsapp_instances(id) on delete set null,
  organization_id uuid not null references organizations(id),
  action          text not null check (action in (
                    'REGISTER','UPDATE','REACTIVATE','SET_COST',
                    'CONFIRM_CYCLE_DATE','REQUEST_CANCELLATION','CONFIRM_END')),
  note            text not null,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now()
);
```

`enable` + `force row level security` **mais a policy `platform_admin_all_whatsapp_instance_notes`**
(`for all to authenticated using/with check (is_platform_admin(auth.uid()))`) — exatamente o que
087, 088 e 089 fazem, e o padrão das irmãs vence.

> **Correção de spec (2026-08-03).** A redação original dizia "sem policies, como
> `whatsapp_instances`" — as duas metades da frase se contradiziam: `whatsapp_instances` **tem**
> `platform_admin_all_whatsapp_instances` (087:207). "FORCE RLS sem policies" é o padrão das
> tabelas de CREDENCIAL do `CLAUDE.md` (`whatsapp_channels`, `platform_secrets`), onde nem o
> super-admin lê pelo PostgREST. Esta tabela não guarda credencial e é irmã dos dois ledgers da
> fase: sem a policy, o painel perderia a leitura direta que as irmãs têm e a divergência
> apareceria só no dia em que alguém tentasse usá-la. A EF continua sendo o caminho da UI
> (ela usa `service_role`, que ignora RLS de qualquer forma) — a policy é a paridade com as
> irmãs, não uma porta nova para o lojista: `is_platform_admin` já exclui todo membro de
> organização.

Índice em `(instance_ref, created_at desc)`.

A guarda de tenant reusa `whatsapp_instance_child_tenant_guard()` (088), como a 089 faz — ela
já retorna cedo quando `instance_id` é nulo, que é o estado da linha depois de a instância ser
apagada.

**Backfill idempotente:** cada `notes` não-nulo existente vira a primeira entrada, com
`action = 'REGISTER'`, guardado por `where not exists (...)`.

### Mudanças na EF

- Helper `recordInstanceNote(instanceRef, orgId, action, note, callerId)`.
- Chamado pelas **sete ações que mudam a instância** e pedem motivo: `register_instance`,
  `update_instance`, `reactivate`, `set_cost`, `confirm_cycle_date`, `request_cancellation` e
  `confirm_end`. Cobrir as sete é o que torna a propriedade difícil de perder: ação nova que
  peça motivo já tem onde registrar.
- **`acknowledge_alert` e `resolve_alert` ficam de fora de propósito.** Elas também pedem
  motivo, mas escrevem no ledger de alertas, que já guarda uma linha por alerta — o histórico
  delas não se perde, e duplicá-lo aqui misturaria dois assuntos na mesma linha do tempo.
- **Depois** da mutação, nunca antes: observação sobre operação que não aconteceu é pior que
  observação ausente.
- **Best-effort:** falha do ledger não derruba a operação já concluída, mas emite telemetria
  com `needsAdminAction: true`. Falhar a requisição depois de o efeito ter ocorrido faria o
  operador repetir uma ação já feita.
- A coluna `notes` **continua sendo escrita como está**. Ela vira o resumo ("última
  observação"); o ledger vira o histórico. Ambas saem do mesmo `reason`, na mesma operação.
- Ação nova `list_instance_notes`, com validação de forma do `instance_id` via `parseUuid` —
  a mesma lição do defeito de `alert_id` corrigido nesta fase.

### UI

Seção "Histórico" no detalhe da instância, ordenada da mais recente para a mais antiga, com
data, ação e autor. O rótulo do campo de motivo passa a dizer o que ele faz:
*"Motivo (fica registrado no histórico)"*.

---

## 9. Melhorias pontuais no código tocado

- Nome da organização no lugar de `Organização {uuid}` no card, via `useAllUnits()`.
- Link no menu lateral da plataforma — hoje a rota existe e não é alcançável por navegação.

Nada além disso. Refatoração não relacionada fica fora.

---

## 10. Runbook do fluxo manual assistido

Documento novo em `docs/billing-asaas/`, com três rotinas.

### R1 — Contratar

1. Pagamento confirmado (fora deste escopo: `whatsapp_implementations`).
2. **Criar a instância no painel da Z-API.** O custo começa aqui, e só aqui.
3. Anotar identificador, valor mensal e dia do vencimento.
4. Registrar no painel (Tela A).
5. Confirmar a data do ciclo (encadeado).
6. Configurar o canal em `/platform/automacao/<slug>` com as credenciais.

### R2 — Rotina mensal: um alerta, uma ação

| Alerta | `event_type` | Ação |
|---|---|---|
| `CYCLE_DUE_SOON` (D-7) | `admin_zapi_cycle_d7` | Nada obrigatório. Decidir se mantém. |
| `CYCLE_DUE_TOMORROW` (D-1) | `admin_zapi_cycle_d1_action_required` | **Ação hoje.** Ver os quatro motivos abaixo. |
| `END_CONFIRMATION_REQUIRED` | `admin_zapi_end_confirmation_required` | Conferir na Z-API e confirmar o encerramento. |
| `DATE_REVIEW_REQUIRED` | `admin_zapi_date_review_required` | Confirmar a data do ciclo. |
| `DIVERGENCE` | `admin_zapi_divergence` | Canal sem instância → registrar pelo próprio card. |
| `ECONOMIC_IMBALANCE` | `admin_zapi_economic_imbalance` | Decisão comercial, não técnica. Nunca dispara para cliente vitalício. |

Os quatro motivos do D-1 (`D1Reason`): `COST_UNKNOWN` → informar o custo;
`OPEN_DIVERGENCE` → resolver a divergência; `CANCELLATION_INTENDED_NOT_REGISTERED` →
**cancelar na Z-API hoje**; `REVENUE_UNKNOWN` → conferir assinatura ou override.

### R3 — Cancelar

1. Solicitar cancelamento no painel (motivo + data-limite de acesso).
2. **Cancelar de fato na Z-API.**
3. Chega `END_CONFIRMATION_REQUIRED` → conferir → confirmar encerramento.
4. Se o fornecedor desfez o cancelamento: Reativar, com evidência.

### A regra que atravessa as três

**O painel nunca age no fornecedor.** Cada linha do inventário é uma afirmação humana sobre o
que existe lá fora. O runbook existe porque essa afirmação envelhece.

### O ponto operacional que o runbook não pode omitir

**Os seis avisos não viram e-mail hoje.** `billing_notifications_dispatch` segue OFF para eles
pela pendência `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE` — resta um intervalo entre enfileirar
e carimbar, e ligar o dispatch transformaria uma falha de carimbo em e-mail duplicado para o
admin. A fila acumula corretamente e o ledger registra corretamente. **Ninguém é notificado.**

Enquanto isso, o painel é o único canal, e fluxo manual sem aviso ativo exige cadência de
conferência. O runbook fixa uma: **toda segunda, e obrigatoriamente entre o D-7 e o D-1 de
cada instância.** Com uma instância vencendo dia 4, isso é dia 28 e dia 3.

---

## 11. Testes

Três módulos puros em `src/lib/`, cobertos por vitest:

1. `buildUpdatePatch(original, form)` — campo intocado não entra; campo esvaziado entra como
   `null`; patch vazio não dispara requisição.
2. Conversão de valor — `"99,90" → 9990`; vírgula e ponto; vazio → custo desconhecido, não
   zero; recusa negativo e não-numérico.
3. Rótulos de `COST_SOURCES` — toda constante do núcleo tem rótulo em português, e rótulo sem
   constante correspondente reprova. Mesmo padrão do teste de acoplamento dos `event_type`.

**Não há infraestrutura de teste de componente React neste repositório, e a 6c não introduz
uma.** O que sobra é verificação manual, com roteiro fechado:

- URL colada no identificador → 400 com a mensagem sobre o token.
- Registro repetido da mesma instância → 409.
- Alterar só o identificador → **o canal permanece** (o defeito do §6).
- Instância `ENDED` → botão de reativar ausente.
- Registrar → o histórico mostra a entrada `REGISTER` com autor e data.

O ledger do §8 é verificado contra o banco local (PostgreSQL 18.4 em `127.0.0.1:55432`, sem
`pg_cron`/`pg_net`), no mesmo procedimento usado para validar a 089: aplicar a migration real
sobre bootstrap mínimo, com controle positivo provando que apagar a instância **não** apaga a
observação.

---

## 12. Riscos

1. **Registrar instância que não existe na Z-API.** O inventário passa a mentir sobre custo.
   Mitigado pelo identificador obrigatório e pelo motivo registrado; não eliminado.
2. **Disciplina humana.** O fluxo inteiro depende de alguém olhar o painel. Mitigado pela
   cadência do §10; não eliminado. É a razão de existir da 6a.
3. **Observação da 6b em curso.** A migration do §8 é **aditiva e inerte ao worker**: cria
   tabela nova e lê `notes` para o backfill, sem tocar nenhuma coluna de
   `whatsapp_instances`. Ainda assim, **não mexer no inventário do Ren Sushi antes do dia
   04** — a rolagem do ciclo é o que está sendo observado, e escrever nele contamina a
   leitura.
4. **`notes` e o ledger podem divergir** se o insert best-effort falhar. Escolha consciente:
   o alternativo é derrubar uma operação já concluída. A divergência é detectável pela
   telemetria `needsAdminAction`.

---

## 13. Ordem de aplicação e redeploy

1. `supabase db push` — migration `096_whatsapp_instance_notes`.

   > **Correção de spec (2026-08-03):** era `094`. O Plano A do modelo de dois planos ocupou
   > `094` e `095` na mesma branch. A faixa reservada para a 6c é **096** — três frentes
   > (6c, Plano B, Plano D) numeram migrations em paralelo.
2. `supabase functions deploy manage-whatsapp-instances`.
3. Frontend (push em `main` → Vercel), **depois** do merge da 6b.

Nenhum arquivo de `supabase/functions/_shared/` muda, então o checklist de redeploy cruzado do
`CLAUDE.md` não é afetado. A EF nova é a única a redeployar.

Se a EF subir antes da migration, o insert do ledger falha, é logado e a operação principal
continua correta — mas a ordem acima evita o buraco.

## 14. Atualizações no CLAUDE.md

> **Coordenação (2026-08-03): esta frente NÃO edita `CLAUDE.md`.** Três frentes (6c, Plano B,
> Plano D) tocam o mesmo arquivo; a consolidação é um commit único no fim, fora deste trabalho.
> O que entraria vai para `docs/billing-asaas/FASE-6C-PENDENCIAS.md`, seção
> "CLAUDE.md a consolidar".

- Invariante novo: **por que `whatsapp_instances` não usa o trigger genérico de auditoria** —
  `audit_log` é legível por membro da organização, e o custo do fornecedor não pode ser. O
  histórico vive em `whatsapp_instance_notes`, `FORCE RLS` + policy `platform_admin_all_*`.
- Invariante novo: **o ledger de observações é best-effort e escreve DEPOIS da mutação** —
  `notes` é o resumo, o ledger é o histórico, e divergência entre os dois é detectável pela
  telemetria `needsAdminAction`.
- Nenhuma linha nova no checklist de redeploy cruzado: nada em `supabase/functions/_shared/`
  muda (§13).

~~`whatsapp_instance_notes` entra na lista de tabelas com `FORCE RLS` sem policies.~~
**Corrigido:** ela tem policy `platform_admin_all_*` (§8) — a lista do `CLAUDE.md` é de tabelas
com credencial, e esta não é uma delas.
