# Fase 6c — os cinco follow-ups do review final

**Data:** 07/08/2026
**Origem:** review whole-branch de `fase-6c/ciclo-custo-e-encerramento`, já mergeada em `main` (c1c0b08).
**Spec-mãe:** [2026-08-07-fase-6c-ciclo-custo-e-encerramento-design.md](2026-08-07-fase-6c-ciclo-custo-e-encerramento-design.md).
**Pendências da fase:** [../../billing-asaas/FASE-6C-PENDENCIAS.md](../../billing-asaas/FASE-6C-PENDENCIAS.md).

Nenhum dos cinco é bloqueante. Nenhum toca dado do Ren Sushi. Cada um foi
avaliado com evidência antes de entrar; o §7 registra o que **não** entra e por
quê.

---

## 1. Contexto e princípio comum

Os cinco compartilham uma família: **escrita condicional cujo predicado, se
sumir, some em silêncio**, e **tela que afirma sucesso sem saber o que de fato
aconteceu**. É a mesma família que a frente 6c fechou nas §2.2 e §2.3 — por isso
o critério de aceitação de cada item aqui é o mesmo que ela usou: *reintroduzir
o defeito e ver o teste ficar vermelho*.

Duas restrições moldam todas as verificações:

- `supabase/functions/` **não é alcançada pelo `tsc -b`** e não há Deno no
  ambiente. O único gate automático nativo lá é o `no-undef` do ESLint.
- O harness [supabase/tests/local-preflight/](../../../supabase/tests/local-preflight/README.md)
  prova **comportamento de banco** (trigger, CHECK, FK, índice, idempotência) e
  **nada além disso**.

A consequência prática, que este documento adota como regra: toda escrita
condicional que atravesse os dois lados ganha **duas** provas — o caso de banco
no harness (com controle positivo) e o guardrail estático textual sobre a fonte
da Edge Function. Nenhuma das duas isolada é suficiente, e dizer que uma delas é
"o teste" foi exatamente o problema do item 3.

---

## 2. Item 1 — o toast passa a dizer a verdade

### 2.1 O achado

`manage-whatsapp-instances` devolve `cycle_filled` em `set_cost`
([index.ts:1022](../../../supabase/functions/manage-whatsapp-instances/index.ts))
e `closed_cycle_status` em `confirm_end`
([:1232](../../../supabase/functions/manage-whatsapp-instances/index.ts)).
Nenhum dos dois tem consumidor: grep por
`cycle_filled|cycleFilled|closed_cycle_status|closedCycleStatus` em `src/`
devolve zero. O toast é literal — `"Custo atualizado."`
([WhatsappInstances.tsx:834](../../../src/pages/platform/WhatsappInstances.tsx))
e `"Encerramento confirmado."` ([:869](../../../src/pages/platform/WhatsappInstances.tsx)).

A spec-mãe §4.2.3 justificou o campo assim: *"a tela precisa saber se o ciclo
aberto foi preenchido para dizer a verdade no toast"*.

### 2.2 A decisão: toast condicional; os campos ficam

**Os campos carregam justamente o caso em que a tela mente hoje.**

- `cycle_filled: false` significa que o número foi gravado na instância e o
  ciclo aberto **não** mudou. A copy do diálogo de custo promete o contrário —
  *"o ciclo fica pendente de revisão até o número existir"*
  ([FASE-6C-PENDENCIAS §2.2](../../billing-asaas/FASE-6C-PENDENCIAS.md)). Um
  `"Custo atualizado."` seco afirma que a promessa foi cumprida quando não foi.
- `closed_cycle_status: "PENDING_REVIEW"` significa que o encerramento fechou o
  último ciclo **sem custo** — existe tarefa pendente, e ela tem porta própria
  (`correct_cycle_cost`).

E o painel só revela o `PENDING_REVIEW` **dentro da seção expandida**
([WhatsappInstances.tsx:138-148](../../../src/pages/platform/WhatsappInstances.tsx)),
que o operador precisa abrir. **O toast é o único retorno no instante da ação.**
Remover os campos escolheria o lado errado: apagaria a informação em vez do
silêncio.

### 2.3 O que muda

**Edge Function** — `set_cost` passa a devolver também
`has_open_cycle: outcome.open_cycle_id !== null`. Um booleano, não o id: a tela
precisa distinguir *"o ciclo manteve o valor dele"* de *"não há ciclo aberto"*,
e não precisa do identificador para isso. `confirm_end` já devolve o suficiente.

**Núcleo puro de copy** — as duas escolhas de mensagem viram funções puras em
[src/lib/whatsapp-instance-format.ts](../../../src/lib/whatsapp-instance-format.ts),
que é onde os rótulos PT-BR desta tela já moram. Ficam em `src/`, então o
`tsc -b` as alcança e o vitest as testa de verdade — ao contrário da EF.

```
setCostToast({ filled, hasOpenCycle }):
  filled                      → "Custo atualizado e aplicado ao ciclo em aberto."
  !filled && hasOpenCycle     → "Custo atualizado na instância. O ciclo em aberto não mudou."
  !filled && !hasOpenCycle    → "Custo atualizado na instância. Não há ciclo em aberto."

confirmEndToast(closedCycleStatus):
  "CLOSED"          → "Encerramento confirmado. O último ciclo foi fechado."
  "PENDING_REVIEW"  → "Encerramento confirmado. O último ciclo fechou sem custo — informe o valor em Ciclos e margem."
  null              → "Encerramento confirmado. Não havia ciclo em aberto."
```

O segundo ramo diz *"não mudou"*, não *"manteve o valor congelado"*, de
propósito: quando o custo submetido é nulo (desconhecido), o ciclo pode não ter
valor nenhum a manter. A frase precisa ser verdadeira nos dois casos.

**Painel** — o helper `run(body, successMsg)`
([WhatsappInstances.tsx:234](../../../src/pages/platform/WhatsappInstances.tsx))
passa a aceitar `string | ((data: unknown) => string)`. A mutation já entrega o
corpo da resposta ao `onSuccess`; nenhuma requisição nova.

### 2.4 Verificação

Testes unitários das duas funções puras — os seis ramos, incluindo o de custo
nulo com ciclo sem valor. `tsc -b` cobre a assinatura nova do `run`.

---

## 3. Item 2 — `ended_by` e `end_confirmation_note` coalescem junto com `ended_at`

### 3.1 O achado, e a porta de entrada real

Em `confirm_whatsapp_instance_end` ([migration 104](../../../supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql)),
`ended_at = coalesce(ended_at, now())` mas `ended_by` e
`end_confirmation_note` são sobrescritos. Numa repetição a linha passa a afirmar
*"encerrada em T1, por B, com a nota X"* — quando B não confirmou em T1.

O review supôs que só um duplo-envio concorrente alcançaria isso.
**A porta é mais larga.** `canTransition` tem curto-circuito de mesmo estado:

```ts
// whatsapp-instance-core.ts:54
if (from === to) return { ok: true };
```

`ENDED → ENDED` passa. E o botão "Confirmar encerramento" é renderizado a partir
do `lifecycle_state` **em cache** do React Query
([WhatsappInstances.tsx:392](../../../src/pages/platform/WhatsappInstances.tsx)),
com `refetchOnWindowFocus: false` global. Logo: **uma aba parada de outro
administrador continua mostrando o botão depois do primeiro encerramento.**
Clique → a EF lê `ENDED` → `canTransition` aprova → a RPC reescreve autoria e
nota. Não é corrida; é uma aba velha.

### 3.2 A decisão: coalescer os três

`recordInstanceNote` roda em **toda** chamada de `confirm_end`
([index.ts:1221-1224](../../../supabase/functions/manage-whatsapp-instances/index.ts)),
depois da RPC e sem condição. A segunda confirmação sobrevive em
`whatsapp_instance_notes` com ator, nota e carimbo próprios. **Coalescer os três
não perde informação** — move-a para onde ela pertence: a linha da instância
registra coerentemente a *primeira* confirmação, o ledger registra todas.

Coalescer nenhum faria `ended_at = now()` a cada repetição, reescrevendo a data
em que a plataforma parou de pagar o fornecedor — o fato financeiro do
encerramento — por causa de uma aba desatualizada. É estritamente pior.

**Não se recusa `ENDED → ENDED`.** A RPC se declara idempotente no próprio
`comment on function`, e recusar transformaria um retry legítimo (timeout de
rede sobre uma chamada que de fato completou) num 409 confuso sobre uma operação
que já deu certo.

### 3.3 O que muda

**Migration 105** — `20260807110000_105_whatsapp_end_confirmation_first_wins.sql`.
Timestamp maior que `20260807100000`, número livre (099–103 são do Plano D, 104 é
a frente 6c). Contém:

- `create or replace function public.confirm_whatsapp_instance_end(uuid, text, uuid)`
  — corpo idêntico ao da 104 exceto por
  `ended_by = coalesce(ended_by, p_actor)` e
  `end_confirmation_note = coalesce(end_confirmation_note, p_note)`.
- `comment on function` reescrito para dizer *primeira confirmação vence nos
  três campos; repetições ficam no ledger*.
- `revoke all … from public, anon, authenticated` + `grant execute … to
  service_role`, com assinatura completa. `create or replace` preserva a ACL
  existente, mas reemiti-la é idempotente e mantém a migration correta num
  replay onde a função não exista ainda.

**A 104 não é reescrita.** Migration aplicada não se reescreve.

Nenhuma Edge Function muda: a assinatura e o `returns table` são os mesmos, e o
`confirm_end` já chama a RPC exatamente assim.

### 3.4 Verificação

`END-4` em [05-ciclo-custo-e-fim.sql](../../../supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql):
primeira confirmação com ator A e nota "primeira"; segunda com ator B e nota
"segunda"; a linha final tem `ended_at` da primeira, `ended_by = A` e
`end_confirmation_note = 'primeira'`.

`CONTROLE-5` em [06-controles-104.sql](../../../supabase/tests/local-preflight/06-controles-104.sql):
reintroduz a sobrescrita (`ended_by = p_actor` cru) e mostra `END-4`
**REPRODUZINDO** o defeito. Reaplicar a 105 restaura. Sem esse controle,
"END-4 passou" não distingue a guarda funcionando de teste sem força.

O README do harness ganha a linha do 105 na sequência de execução.

---

## 4. Item 3 — CORR-1/CORR-2 não exercitam a EF, e o registro passa a dizer isso

### 4.1 O achado

Os dois casos reescrevem o `UPDATE` à mão em SQL
([05-*.sql:184-188](../../../supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql)).
Provam que o CHECK `whatsapp_cycles_closed_needs_cost_chk` aceita custo e status
mudando juntos e que o predicado casa — **a metade do banco**. Nenhum teste
falharia se o `UPDATE` real de `correct_cycle_cost` perdesse o
`.eq("status", "PENDING_REVIEW")` ou a conferência de `updated.length`.

O próprio arquivo `05` admite isso num comentário. O **README não admite** —
lista o `05` como "comportamento das RPCs" sem ressalva, o que deixa
exatamente a impressão de cobertura que não existe.

### 4.2 A decisão: fechar a metade que dá, com o mecanismo que o repo já usa

O repo tem **doze** guardrails estáticos que leem fonte de Edge Function com
`readFileSync` + regex, e
[whatsapp-gate-coupling-guard.test.ts:11-14](../../../src/lib/whatsapp-gate-coupling-guard.test.ts)
já registra a razão: *"os `index.ts` importam deno.land/esm.sh e chamam
`serve()` no carregamento, então o vitest não consegue importá-los. Análise
estática de texto é o que resta — e é mais do que existia antes."*

Isso **não** é "a EF foi exercitada", e o documento não vai fingir que é. É uma
afirmação mais estreita e verdadeira: *as duas coisas que quebrariam em silêncio
não podem sumir sem teste vermelho.*

**Uma alternativa descartada:** extrair um núcleo puro de `correct_cycle_cost`.
O que está em risco é **forma de I/O** — o predicado do PostgREST e a
conferência do retorno —, não decisão. Um núcleo puro não sustenta nenhum dos
dois e daria a mesma impressão falsa com mais cerimônia.

### 4.3 O que muda

**Guardrail novo:** `src/lib/whatsapp-instance-ef-write-guard.test.ts`, sobre
`supabase/functions/manage-whatsapp-instances/index.ts`. Um arquivo, um tema —
*as escritas condicionais desta EF não podem perder o predicado*. Cobre os itens
3, 4 e 5 desta spec:

- `correct_cycle_cost` contém `.eq("status", "PENDING_REVIEW")`, a conferência
  de zero linhas e o 409 `CYCLE_NOT_PENDING_REVIEW`;
- `confirm_cycle_date` não trata `23505` como idempotente sem desambiguar (item 5);
- `update_instance` chama `checkUnitInstanceConflict` (item 4).

**Ressalva no README** do harness: um parágrafo explícito sobre o que CORR-1 e
CORR-2 provam e o que não provam, apontando para o guardrail. O lugar onde a
lacuna é lida é o lugar onde ela precisa estar escrita.

---

## 5. Item 4 — a guarda de unidade duplicada passa a valer nas DUAS portas

### 5.1 O achado

[index.ts:1295](../../../supabase/functions/manage-whatsapp-instances/index.ts):

```ts
if ("unit_id" in body) patch.unit_id = body.unit_id ?? null;
```

Nenhuma consulta. E não é porta de fundos:
[UpdateInstanceDialog.tsx:129](../../../src/components/platform/UpdateInstanceDialog.tsx)
tem um `Select` **"Unidade"** — mover instância entre unidades é caminho de UI
comum.

### 5.2 A decisão: entra agora

O estado que a [§2.1 da FASE-6C-PENDENCIAS](../../billing-asaas/FASE-6C-PENDENCIAS.md)
quer impedir — duas instâncias `lifecycle_state <> 'ENDED'` na mesma unidade —
fica plenamente alcançável. E **"registro recusa, mover aceita" é pior que
"nenhum dos dois confere"**: cria confiança falsa numa guarda que esta mesma
frente acabou de instalar.

Está fora do escopo *declarado* da spec-mãe, que fala de registro. Entra assim
mesmo, com o escopo declarado aqui.

### 5.3 O que muda

**Reuso, não regra nova.** `checkUnitInstanceConflict` de
[whatsapp-instance-registration-core.ts](../../../supabase/functions/_shared/whatsapp-instance-registration-core.ts)
é chamado como está. **O arquivo do núcleo não muda**, e
`whatsapp-connection-allowance-core.ts` não é tocado — a separação entre "o
modelo comercial permite mais uma conexão?" e "esta unidade já está ocupada?"
continua de pé, e o `manage-channels` segue alheio a isto.

Em `update_instance`, antes do `UPDATE`:

1. Só quando `"unit_id" in body` e o valor é não-nulo. Não-nulo passa por
   `parseUuid`, como no registro — 400 se inválido. Hoje `update_instance`
   aceita o valor cru e deixa o banco recusar com `22P02`; sem a validação, um
   valor malformado cairia na consulta de conflito e viraria 503, que é a
   mensagem errada.
2. Ler a instância atual. Se `unit_id` não está mudando, **pular a checagem** —
   um patch que reenvia a mesma unidade não é conflito.
3. Consultar as instâncias `lifecycle_state <> 'ENDED'` da unidade de destino
   **com `.neq("id", id)`**. Esta é a única diferença de desenho contra o
   registro: sem excluir a própria instância, ela se auto-conflitaria.
4. Erro de leitura → **503 `ALLOWANCE_UNVERIFIABLE`**, mesmo fail-closed do
   registro ([index.ts:767-773](../../../supabase/functions/manage-whatsapp-instances/index.ts)).
   Lista vazia por falha de leitura liberaria justamente o que a guarda barra.
5. `checkUnitInstanceConflict({ unitScoped: true, conflicts, acknowledged: body.acknowledge_unit_conflict === true })`.
   Recusa → 409 `UNIT_ALREADY_HAS_INSTANCE` com o array `conflicts`, idêntico ao
   registro.

**Diálogo** — `UpdateInstanceDialog` espelha o fluxo que
`RegisterInstanceDialog` já tem
([:169-178](../../../src/components/platform/RegisterInstanceDialog.tsx)):
o 409 não é erro terminal, é uma pergunta. A tela lista o que já existe naquela
unidade e oferece a confirmação explícita, que reenvia com
`acknowledge_unit_conflict: true`.

### 5.4 Verificação

O guardrail estático do item 3 (a EF chama o núcleo). O núcleo em si já tem
teste próprio — [whatsapp-instance-registration-core.test.ts](../../../src/lib/whatsapp-instance-registration-core.test.ts) —
e não muda.

---

## 6. Item 5 — o `23505` de `confirm_cycle_date` passa a distinguir dois erros

### 6.1 A investigação de alcançabilidade

Dois índices de `whatsapp_instance_cycles` produzem `23505`
([088:80-86](../../../supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql)):

| Índice | Significado |
|---|---|
| `whatsapp_cycles_instance_start_idx (instance_id, cycle_start)` | reexecução com a MESMA data — idempotência genuína |
| `whatsapp_cycles_one_open_idx (instance_id) WHERE status='OPEN'` | já existe outro ciclo OPEN, com data DIFERENTE |

A EF trata os dois como reexecução
([index.ts:908](../../../supabase/functions/manage-whatsapp-instances/index.ts))
e segue gravando a projeção **com a data nova**.

Para divergir é preciso o estado *ciclo OPEN + `cycle_source = 'UNKNOWN'`*.
As entradas foram rastreadas:

- O botão "Confirmar data" só aparece com `cycle_source === "UNKNOWN"`
  ([WhatsappInstances.tsx:379](../../../src/pages/platform/WhatsappInstances.tsx));
  após o sucesso vira `ADMIN_CONFIRMED` e some.
- A rolagem grava `SYSTEM_ROLLED` ([090:111](../../../supabase/migrations/20260801200300_090_whatsapp_instance_cycle_rpc.sql))
  e nunca alcança instância com `current_cycle_due_on` nulo.

Sobra **uma** porta, e é a falha parcial que a própria EF documenta: insert do
ciclo OK, `UPDATE` da projeção falha, 500 *"Ciclo registrado, mas a projeção na
instância falhou"*
([:930-932](../../../supabase/functions/manage-whatsapp-instances/index.ts)).
Isso deixa `UNKNOWN` **com** ciclo OPEN, e o botão continua visível. Daí:

- retry com a **mesma** data → `instance_start_idx` → idempotência correta;
- retry com data **diferente** → `one_open_idx` → a projeção diverge do ciclo em
  silêncio.

Também alcançável por chamada direta à EF: o gate do painel é só UI.

**Consequência quando acontece:** a instância e o ciclo passam a discordar da
janela. O D-7/D-1 dispara pela data errada, e a rolagem 090 abre o ciclo
seguinte a partir do `provider_due_on` do **ciclo** (linha 95), deixando um
buraco permanente no histórico.

**Veredito:** probabilidade baixa, consequência silenciosa e permanente,
correção local sem migration. Entra — mas é registrado como o mais fraco dos
cinco.

### 6.2 O que muda

Só a Edge Function. Ao receber `23505` no insert do ciclo, em vez de presumir
reexecução:

1. `SELECT id FROM whatsapp_instance_cycles WHERE instance_id = :id AND cycle_start = :cycleStart`.
2. Encontrou → é reexecução da mesma data. Segue como hoje (idempotente, e o
   ciclo existente **não** é preenchido — a porta de reparo continua sendo
   `correct_cycle_cost`).
3. Não encontrou → existe outro ciclo OPEN com data diferente. **409
   `OPEN_CYCLE_DATE_MISMATCH`**, e a projeção **não** é gravada. Mensagem curta
   em PT-BR nomeando a divergência e mandando conferir os ciclos da instância.
4. Erro nessa leitura → **503**, sem gravar a projeção. Fail-closed: gravar uma
   projeção que talvez divirja é o defeito que este item fecha.

### 6.3 Verificação

**A metade do banco**, em `05-ciclo-custo-e-fim.sql`: `CYCLE-1` prova que
inserir com a MESMA `cycle_start` viola `instance_start_idx`; `CYCLE-2` prova
que inserir com data DIFERENTE havendo um OPEN viola `one_open_idx` **e que
nenhuma linha com aquela `cycle_start` existe** — que é exatamente o
discriminador que a EF vai usar. Os dois códigos são `23505`; é essa colisão que
o par de casos torna visível.

**A metade da EF**, no guardrail estático do item 3.

Este é o mesmo pareamento que o item 3 prescreve, aplicado ao caso novo.

---

## 7. Fora de escopo — decidido, não esquecido

- **Reescrever a 104, a 096, a 090 ou a 089.** Migration aplicada não se
  reescreve. O que estiver errado no texto delas se corrige em migration nova.
- **Apertar a 089 para igualar a 096.** Continua fora de escopo, como a
  [FASE-6C-PENDENCIAS §5](../../billing-asaas/FASE-6C-PENDENCIAS.md) já registra.
- **Persistir `customer_revenue_cents` / `gross_margin_cents`.** Sem consumidor
  da versão persistida; a 104 já corrigiu a promessa falsa por
  `comment on column`.
- **Qualquer chamada à Z-API.**
- **Verificar existência real da instância no fornecedor** — é a Fase 6a.
- **Recusar `ENDED → ENDED`.** Ver §3.2: quebraria retry legítimo.
- **Núcleo puro para `correct_cycle_cost`.** Ver §4.2: o risco é forma de I/O,
  não decisão.

---

## 8. Impacto operacional

**Ren Sushi:** nenhuma migration escreve, apaga ou corrige dado dele. A 105 cria
função (`create or replace`), reemite ACL e reescreve um comentário. Zero DML.

**Redeploy cruzado:** nenhum arquivo de `_shared/` muda. O item 4 faz
`manage-whatsapp-instances` chamar `checkUnitInstanceConflict` num segundo
ponto, mas o núcleo em si é idêntico — o checklist de redeploy do `CLAUDE.md`
não é afetado.

**Ordem quando autorizado:** `supabase db push` da 105 → `supabase functions
deploy manage-whatsapp-instances` → frontend (push em `main` → Vercel) →
conferir `acl-estatico` na aba Checks (a 105 cria/substitui função em `public`,
que é exatamente o diff que ele audita).

**Sem hazard de ordem inversa:** a 105 substitui uma função cuja assinatura e
`returns table` não mudam, e a EF já a chama assim. Diferente do caso de coluna
nova lida por gate fail-closed, subir a EF antes não quebra nada — a ordem acima
é convenção, não dependência.

**`CLAUDE.md`** ganha três invariantes (§3.2 primeira-confirmação-vence, §5.2 a
guarda nas duas portas, §6.2 a desambiguação do `23505`) e uma correção na linha
já existente sobre a guarda de unidade, que hoje diz "registro" e passa a valer
para registro **e** alteração de vínculo.

---

## 9. Gates antes de qualquer commit

`npm run lint` · `npm run typecheck` (`tsc -b --noEmit`) · `npx vitest run` ·
`npm run build` · `npx eslint supabase/functions --max-warnings=0`.

Mais o harness local, na sequência do
[README](../../../supabase/tests/local-preflight/README.md) com a 105 inserida
após a 104, e o `CONTROLE-5` rodando **sem** `ON_ERROR_STOP`.

Nenhum `supabase db push` e nenhum `functions deploy` sem autorização explícita
do dono do projeto.
