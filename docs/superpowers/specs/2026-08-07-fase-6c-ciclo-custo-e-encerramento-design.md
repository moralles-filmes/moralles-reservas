# Fase 6c — custo do ciclo, encerramento e teto de registro

**Data:** 2026-08-07
**Origem:** verificação manual da Fase 6c em produção, registrada em
[../../billing-asaas/FASE-6C-PENDENCIAS.md](../../billing-asaas/FASE-6C-PENDENCIAS.md) §2.1, §2.2 e §2.3.
**Estado:** desenho aprovado pelo dono do projeto.

---

## 1. O problema

A verificação manual registrou três achados. A investigação do desenho encontrou
um quarto, que é a **causa raiz do único dano real que existe hoje** — e mostrou
que o diagnóstico do §2.2 estava incompleto.

### 1.1 Os quatro defeitos

| # | Onde | O que acontece |
|---|---|---|
| **A** (§2.1) | `register_instance` | Sob cortesia vitalícia o backfill não consulta teto nenhum: duas instâncias na mesma unidade coexistem sem que nada reclame. |
| **B1** (novo) | `confirm_cycle_date` | O ciclo `OPEN` nasce **sem custo mesmo quando o custo já é conhecido** — o `insert` não passa `provider_cost_cents`, `cost_source` nem `cost_snapshot_at`. |
| **B2** (§2.2) | `set_cost` | Atualiza `whatsapp_instances` e nunca alcança o ciclo aberto: um ciclo que nasceu sem custo continua sem custo até fechar. |
| **C** (§2.3) | `confirm_end` | Encerrar antes do vencimento deixa o último ciclo `OPEN` para sempre — a RPC 090 pula `lifecycle_state` fora de `ACTIVE`/`CANCELLATION_REQUESTED`, então nada o fecha depois. |

**B1, B2 e C são a mesma doença:** o ciclo não recebe o custo nos três momentos
em que deveria — quando nasce, quando o número aparece, e quando a instância
encerra. Por isso vão numa frente só.

### 1.2 A evidência que reclassifica o §2.2

O documento culpa apenas o `set_cost`. Os carimbos da única instância real
(Ren Sushi) provam que o ciclo já nasce cego:

| Fato | Quando |
|---|---|
| Custo informado na instância — R$ 99,90, `PROVIDER_PANEL` | 02/08 **17:31:07** |
| Ciclo de julho (04/07 → 04/08) criado por `confirm_cycle_date` | 02/08 **17:47:03** |
| `provider_cost_cents` desse ciclo | **nulo** |
| Ciclo de agosto (04/08 → 04/09) aberto pela RPC 090 | 04/08 12:10:01, custo **9990** |

Dezesseis minutos depois de o número estar na tela, o ciclo nasceu sem ele. A RPC
de rolagem fotografa o custo; a criação do primeiro ciclo, não. Consequência
prática: **toda instância registrada por este caminho perde o custo do primeiro
ciclo**, e o Ren Sushi já carrega uma linha `PENDING_REVIEW` permanente por
causa disso.

### 1.3 O que os §2.2 e §2.3 dizem que se perde, e o que de fato se perde

Os dois achados afirmam que o período "nunca vira registro de margem". Isso está
errado por um motivo mais amplo: **nenhum ciclo vira registro de margem.**
`customer_revenue_cents`, `revenue_source` e `gross_margin_cents` não são
escritos por ninguém — os únicos dois produtores da tabela são o `insert` de
`confirm_cycle_date` e a RPC 090, e nenhum dos dois toca essas colunas.
Produção: **2 ciclos, 1 com custo, 0 com receita, 0 com margem.**

O comentário da RPC 090 (`-- Receita e margem ficam NULL aqui e são preenchidas
pelo worker`) é falso: o worker calcula a margem **em memória**, para o payload
do alerta `ECONOMIC_IMBALANCE`, e nunca a grava.

O que B1, B2 e C realmente perdem, portanto, é o **custo** — que é o dado que a
tabela existe para guardar.

---

## 2. Decisões do dono do projeto

Três decisões foram tomadas antes deste desenho e o delimitam:

1. **Colunas mortas de receita/margem:** *corrigir só a promessa.* Persistir
   margem fica fora — o alerta `ECONOMIC_IMBALANCE` já a calcula ao vivo e não
   há consumidor para a versão persistida. O que entra é a correção do
   comentário que afirma o contrário.
2. **Retroatividade:** *ação própria no painel.* `set_cost` preenche o ciclo
   aberto quando ele está sem custo, e uma ação explícita e auditada corrige um
   ciclo passado em `PENDING_REVIEW`. **Nenhuma migration reescreve dado do Ren
   Sushi** — a correção é ato humano, com autor e motivo.
3. **Lugar da guarda do §2.1:** *servidor recusa, tela confirma.* A Edge Function
   recusa `register_instance` com código próprio quando a unidade já tem
   instância viva, salvo reconhecimento explícito no corpo. A decisão mora num
   núcleo puro testado **fora** de `checkConnectionAllowance`, para não vazar
   resultado sem sentido no `manage-channels`, que compartilha aquele núcleo.

---

## 3. Escopo

### 3.1 Dentro

- Migration **104** com duas RPCs transacionais, extensão do CHECK do vocabulário
  do ledger (096) e correção dos comentários das colunas de receita/margem.
- `manage-whatsapp-instances`: guarda de registro duplicado, snapshot de custo em
  `confirm_cycle_date`, `set_cost` e `confirm_end` via RPC, ação nova
  `correct_cycle_cost`.
- Núcleo puro novo `whatsapp-instance-registration-core.ts` + oitava constante em
  `whatsapp-instance-notes-core.ts`.
- Painel: confirmação de registro duplicado, correção de copy do `set_cost` e do
  registro, ação "corrigir custo" nas linhas `PENDING_REVIEW`.
- Casos novos no harness `supabase/tests/local-preflight/`, **com controle
  positivo em cada um**.

### 3.2 Fora

- Persistir `customer_revenue_cents` / `gross_margin_cents` (decisão 1).
- Verificar no fornecedor se a instância existe de verdade — é Fase 6a, e a
  constante `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A` continua de
  pé.
- Qualquer mudança na política de teto de conexões
  (`whatsapp-connection-allowance-core.ts` não é alterado).
- Apertar a guarda da 089 para igualar a 096 (segue como pendência própria).
- Qualquer chamada à Z-API.

---

## 4. Desenho

### 4.1 Migration 104

**Arquivo:** `supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql`

Numeração e timestamp: 104 é o próximo livre (099–103 são do Plano D) e o
timestamp precisa ser **maior que `20260803120300`**.

Idempotente por design: `create or replace function`, `alter table … drop
constraint if exists` antes de recriar o CHECK, `comment on column` (idempotente
por natureza).

#### Por que RPC e não duas escritas na EF

As correções **B2** e **C** escrevem em **duas tabelas**. PostgREST não tem
transação: se a segunda escrita falha, o resultado é exatamente o bug de hoje,
em silêncio. E há corrida real com o worker diário — a RPC de rolagem toma
`FOR UPDATE` na instância; escrita fora dessa trava pode preencher um ciclo que
o worker está fechando no mesmo instante. As duas operações tomam **a mesma
trava**, pelo mesmo princípio que a 090 já declara: *juntos ou não acontecem*.

#### `set_whatsapp_instance_cost(p_instance_id, p_cost_cents, p_cost_source, p_cost_note, p_actor)`

Retorna `(instance_found boolean, open_cycle_id uuid, cycle_filled boolean)`.

1. `select … from whatsapp_instances where id = p_instance_id for update`.
   Não encontrada → `(false, null, false)`.
2. Grava na instância: `current_monthly_cost_cents`, `cost_source`,
   `cost_updated_at`/`cost_updated_by` (nulos quando o custo é desconhecido),
   `cost_note`, `updated_by`.
3. Busca o ciclo `status = 'OPEN'` da instância, `for update`.
4. **Preenche o ciclo só quando `provider_cost_cents is null` e o custo novo não
   é nulo** — grava `provider_cost_cents`, `cost_source`, `cost_snapshot_at =
   now()`; `cycle_filled = true`.
5. Em qualquer outro caso o ciclo não é tocado: `cycle_filled = false`.

**O princípio da competência fica de pé.** O comentário do `set_cost` na EF diz
que o custo do ciclo corrente foi congelado na abertura e representa a
competência já iniciada — e continua verdadeiro: preencher um nulo **não é**
reescrever um valor congelado; é registrar o que nunca se soube. Sobrescrever
valor existente permanece proibido, e é a correção auditada (§4.2.4) que trata o
caso de valor errado.

#### `confirm_whatsapp_instance_end(p_instance_id, p_note, p_actor)`

Retorna `(instance_found boolean, lifecycle_before text, closed_cycle_id uuid,
closed_cycle_status text)`.

1. `for update` na instância. Não encontrada → `(false, null, null, null)`.
2. Grava `lifecycle_state = 'ENDED'`, `ended_at = coalesce(ended_at, now())`
   (repetição não reescreve a data da primeira confirmação), `ended_by`,
   `end_confirmation_note`, `channel_id = null`, `updated_by`, **e limpa
   `current_cycle_started_on` / `current_cycle_due_on`** — é isso que faz o
   painel parar de anunciar "em curso" numa instância encerrada, e é o mesmo que
   a 090 faz no ramo `CLOSED_NO_REOPEN`.
3. Fecha o ciclo `OPEN`, se houver, **pela mesma regra do vencimento**:
   `provider_cost_cents is null` → `PENDING_REVIEW`, senão `CLOSED`. Grava
   `closed_at = now()` e `closed_by = p_actor` — há humano identificado aqui, ao
   contrário da rolagem automática.

**O ciclo mantém `provider_due_on`.** O fornecedor cobrou o período inteiro;
encurtar a data mentiria sobre o custo. Encerrar cedo fecha o ciclo, não o
reduz.

A transição de estado **não** é revalidada aqui: `canTransition` já roda na EF,
e duplicar a máquina de estados em plpgsql criaria a segunda verdade que a Fase
6b existe para impedir. A RPC é idempotente: repetir sobre instância já `ENDED`
não encontra ciclo aberto e não reescreve `ended_at`.

#### Vocabulário do ledger

O CHECK de `whatsapp_instance_notes.action` enumera as sete ações da 096. A
correção de custo é a **oitava**:

```sql
alter table whatsapp_instance_notes drop constraint if exists whatsapp_instance_notes_action_check;
alter table whatsapp_instance_notes add constraint whatsapp_instance_notes_action_check
  check (action in ('REGISTER', 'UPDATE', 'REACTIVATE', 'SET_COST',
                    'CONFIRM_CYCLE_DATE', 'REQUEST_CANCELLATION', 'CONFIRM_END',
                    'CORRECT_CYCLE_COST'));
```

A fonte canônica continua sendo `INSTANCE_NOTE_ACTIONS` em
`_shared/whatsapp-instance-notes-core.ts`; o teste de duas vias já existente
reprova se as listas divergirem.

#### Comentários corrigidos

`comment on column` nas três colunas mortas, dizendo o que elas de fato são: não
escritas por produtor nenhum, e a margem calculada ao vivo pelo worker para o
alerta `ECONOMIC_IMBALANCE`. **A 090 não é reescrita** — migration aplicada não
se reescreve; a 104 registra que o comentário inline dela é falso.

#### ACL

`revoke all on function … from public, anon, authenticated;` seguido de
`grant execute … to service_role;` para as duas RPCs. Sem isso elas nascem
executáveis por `anon` pelo grant implícito do `CREATE FUNCTION`.

### 4.2 Edge Function `manage-whatsapp-instances`

#### 4.2.1 `register_instance` — guarda de unidade

Antes do insert, e **depois** da guarda de allowance já existente, conta as
instâncias `lifecycle_state <> 'ENDED'` da mesma `unit_id`. Havendo conflito e
sem `acknowledge_unit_conflict: true` no corpo, responde **409** com código
`UNIT_ALREADY_HAS_INSTANCE` e a lista das conflitantes (id, estado, referência
do fornecedor, data de criação) para a tela poder mostrá-las.

Decisão num núcleo puro novo, `_shared/whatsapp-instance-registration-core.ts`:

```ts
checkUnitInstanceConflict(input: {
  unitScoped: boolean;                       // false quando unit_id vem nulo
  conflicts: { id: string; lifecycleState: string }[];
  acknowledged: boolean;
}): { ok: true; policy: "NO_UNIT_SCOPE" | "NO_CONFLICT" | "ACKNOWLEDGED" }
 | { ok: false; code: "UNIT_ALREADY_HAS_INSTANCE" }
```

**Por que fora do `checkConnectionAllowance`:** aquele núcleo é compartilhado
com `manage-channels`, que responde outra pergunta ("posso conectar mais um
canal?") e não tem nada a ver com unidade duplicada. Um campo novo ali obrigaria
o `manage-channels` a preencher entrada que não lhe diz respeito e a interpretar
um `reasonCode` que nunca produz.

**Registro sem unidade não é verificado.** `unit_id` é nulo por design em 087;
sem unidade não há chave pela qual perguntar, e a organização não serve —
rede com cinco unidades tem legitimamente cinco instâncias. O índice único de
`provider_instance_ref` continua sendo a rede nesse caso, e o painel exibe o
registro sem unidade como incompleto.

**Segunda instância legítima continua possível**, como ato consciente: a tela
mostra o que já existe e exige confirmação explícita.

#### 4.2.2 `confirm_cycle_date` — snapshot de custo (B1)

`loadInstanceState` passa a ler também `current_monthly_cost_cents` e
`cost_source`, e o `insert` do ciclo passa a levar `provider_cost_cents`,
`cost_source` e `cost_snapshot_at` — **com a mesma forma da 090**:
`cost_snapshot_at` é nulo quando o custo é nulo.

O caminho `23505` (ciclo já existente, reexecução) **não** passa a preencher o
ciclo que já estava lá: ele pode ter sido rolado ou fechado desde então, e
mexer nele por um efeito colateral de reexecução é justamente o tipo de escrita
não-auditada que esta frente combate. Reparo de ciclo existente tem porta
própria (§4.2.4).

#### 4.2.3 `set_cost` e `confirm_end` — via RPC

As duas passam a chamar as RPCs, depois relêem a instância com
`loadInstanceState(id, INSTANCE_COLUMNS, …)` para devolver a linha ao painel e
obter `organization_id` para o ledger. `recordInstanceNote` continua **depois**
da mutação e best-effort, como hoje.

`set_cost` devolve `{ instance, cycle_filled: boolean }` — a tela precisa saber
se o ciclo aberto foi preenchido para dizer a verdade no toast.

`confirm_end` devolve `{ instance, closed_cycle_status: "CLOSED" | "PENDING_REVIEW" | null }`.

#### 4.2.4 Ação nova `correct_cycle_cost`

Corrige o custo de um ciclo **`PENDING_REVIEW`** — o estado que significa
"terminou sem custo". Exige `cycle_id`, custo, procedência e motivo.

- Recusa qualquer outro estado. **Nunca toca ciclo `CLOSED`**: aquele fechou
  financeiramente concluído, e reabrir esse caso exigiria política própria que
  não existe.
- Recusa custo desconhecido — corrigir para "não sei" não é correção.
- O `UPDATE` carrega o predicado `status = 'PENDING_REVIEW'` (compare-and-set) e
  usa `.select()` com **conferência do número de linhas**: `UPDATE` que casa zero
  linhas devolve `error: null` no Supabase JS, e sem a conferência "o predicado
  negou" é indistinguível de "gravei".
- Promove a `CLOSED` no mesmo `UPDATE` — o CHECK
  `whatsapp_cycles_closed_needs_cost_chk` é satisfeito porque custo e status
  mudam juntos. `closed_at` já é não-nulo (`PENDING_REVIEW` exige).
- Grava `closed_by = callerId`, `cost_source`, `cost_snapshot_at = now()`, e
  **anexa** o motivo a `notes` do ciclo (`notes || '\n[correção de custo] ' ||
  reason`), nunca sobrescreve.
- Registra `CORRECT_CYCLE_COST` no ledger de observações.

Não precisa de RPC: escreve **uma** tabela, e o compare-and-set no `status` faz
o trabalho que a trava faria.

### 4.3 Painel

| Onde | Mudança |
|---|---|
| `RegisterInstanceDialog.tsx` | Ao receber 409 `UNIT_ALREADY_HAS_INSTANCE`, exibe as instâncias existentes da unidade e um botão de confirmação que reenvia com `acknowledge_unit_conflict: true`. |
| `RegisterInstanceDialog.tsx:283` | Copy: hoje diz que "o ciclo fica pendente de revisão até o número existir". Com B1 corrigido, o ciclo nasce **com** o custo quando ele é informado aqui; a frase passa a valer só para o caso de custo desconhecido. |
| `WhatsappInstances.tsx:650` | Copy do `set_cost`: hoje afirma que muda só ciclos futuros. Passa a dizer que preenche o ciclo em curso quando ele está sem custo, que valor já congelado não é sobrescrito, e que ciclo fechado precisa da correção. |
| `CyclesPanel` | Linha `PENDING_REVIEW` ganha ação "corrigir custo" abrindo diálogo com custo, procedência e motivo. |

### 4.4 Verificação

**Vitest** — núcleos puros: `checkUnitInstanceConflict` (todos os ramos),
rótulo PT-BR da ação nova. O teste de duas vias do vocabulário do ledger já
existente cobre `CORRECT_CYCLE_COST` sozinho, nas duas direções.

**`supabase/tests/local-preflight/`** — arquivo novo `05-ciclo-custo-e-fim.sql`,
aplicado depois da 087/088/**090**/096 e da 104. A 090 entra na sequência de
bootstrap (hoje o README não a aplica) porque os casos comparam o comportamento
das RPCs novas com o da rolagem.

Casos:

| Caso | O que prova |
|---|---|
| COST-1 | `set_whatsapp_instance_cost` preenche ciclo `OPEN` com custo nulo. |
| COST-2 | Não sobrescreve custo já congelado no ciclo `OPEN`. |
| COST-3 | Custo desconhecido não apaga o custo do ciclo. |
| COST-4 | Sem ciclo `OPEN`, grava só na instância (`cycle_filled = false`). |
| END-1 | `confirm_whatsapp_instance_end` com custo → ciclo `CLOSED`, instância `ENDED`, projeção limpa. |
| END-2 | Sem custo → ciclo `PENDING_REVIEW`. |
| END-3 | Repetição é idempotente e não reescreve `ended_at`. |
| CORR-1 | Correção promove `PENDING_REVIEW` → `CLOSED` e anexa o motivo. |
| CORR-2 | Correção sobre ciclo `CLOSED` casa zero linhas. |

**Controles positivos, um por família** — sem eles "passou" não distingue *a
guarda funciona* de *o teste não testa nada*:

- **CONTROLE-3:** remover da RPC a condição `provider_cost_cents is null` e ver
  COST-2 falhar (o custo congelado é sobrescrito). Restaurar reaplicando a 104.
- **CONTROLE-4:** remover do `confirm_whatsapp_instance_end` o fecho do ciclo e
  ver END-1/END-2 falharem com o ciclo ainda `OPEN` — que é literalmente o
  defeito §2.3 reintroduzido.

O README ganha a sequência atualizada e a descrição dos dois controles novos.

---

## 5. Invariantes que passam a valer

Entram no `CLAUDE.md` no mesmo PR, no formato de uma frase de regra + uma de por
quê + ponteiro:

1. Custo do ciclo se escreve em **três** momentos e todos fotografam:
   nascimento (`confirm_cycle_date`), preenchimento de nulo (`set_cost` via RPC)
   e rolagem (090). Caminho novo que crie ou feche ciclo fotografa o custo, ou o
   histórico nasce com buraco que só a correção manual tapa.
2. Preencher `provider_cost_cents` nulo **não viola** o congelamento na abertura;
   sobrescrever valor existente, sim — e só a ação auditada
   `correct_cycle_cost`, restrita a `PENDING_REVIEW`, muda custo já gravado.
3. `customer_revenue_cents`, `revenue_source` e `gross_margin_cents` de
   `whatsapp_instance_cycles` **não são escritos por ninguém**; a margem é
   calculada ao vivo pelo worker para o alerta `ECONOMIC_IMBALANCE`. O
   comentário da 090 que afirma o contrário é falso e está corrigido na 104.
4. Registro de instância pergunta duas coisas independentes: *o modelo comercial
   permite mais uma conexão?* (`checkConnectionAllowance`, compartilhado com
   `manage-channels`) e *esta unidade já tem instância viva?*
   (`checkUnitInstanceConflict`, exclusivo do registro). Fundir as duas leva um
   `reasonCode` sem sentido para o `manage-channels`.

---

## 6. Riscos e como são tratados

| Risco | Tratamento |
|---|---|
| Migration aplicada depois do deploy da EF → EF chama RPC inexistente | `supabase db push` **antes** do deploy, como manda o invariante de gate fail-closed do `CLAUDE.md`. |
| Ren Sushi quebrar | Nenhuma escrita automática em dado dele. A 104 cria funções e ajusta CHECK/comentários; o ciclo de julho continua `PENDING_REVIEW` até o dono corrigi-lo pelo painel, com motivo e autoria. |
| Corrida com o worker diário (12:10 UTC) | As duas RPCs tomam `FOR UPDATE` na mesma linha de instância que a 090 toma. |
| Guarda nova barrar registro legítimo | Não barra: recusa uma vez, mostra o que existe e aceita com reconhecimento explícito. |
| CHECK novo do ledger recusar linha antiga | Extensão é aditiva — os sete valores antigos continuam válidos. |

---

## 7. Sequência de aplicação

1. Migration 104 por `supabase db push` (nunca pelo Studio).
2. Deploy de `manage-whatsapp-instances`. É a única EF afetada: os dois núcleos
   puros novos/alterados (`whatsapp-instance-registration-core.ts`,
   `whatsapp-instance-notes-core.ts`) não têm outro consumidor de runtime.
   `whatsapp-connection-allowance-core.ts` **não** é tocado, então
   `manage-channels` não precisa de redeploy.
3. Deploy do frontend (push em `main`).
4. Correção manual do ciclo de julho do Ren Sushi pelo painel, com motivo.
