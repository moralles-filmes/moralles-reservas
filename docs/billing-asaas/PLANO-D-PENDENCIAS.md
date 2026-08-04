# Pendências do Plano D — franquia de IA inclusa

Fase 7 redefinida (spec §17-18). Ambiente sem Docker e sem banco local.
**Nenhuma migration aplicada, nenhuma Edge Function deployada, nenhuma flag
alterada, nenhum cron criado.** Tudo abaixo é o que a suíte verde NÃO prova.

Este documento é escrito para quem **não viveu esta frente**. Cada linha é uma
decisão que essa pessoa precisa tomar, ou um erro que ela evitaria.

## Gates desta entrega

| Gate | Resultado |
|---|---|
| `npx vitest run` | **1041 testes / 40 arquivos — verde** (baseline da task era 1026/39) |
| `npm run typecheck` (`tsc -b --noEmit`) | **zero erros** |
| `npx eslint supabase/functions --max-warnings=0` | **limpo** (exit 0) |
| `npx eslint <arquivos tocados> --max-warnings=0` | **limpo** (exit 0) |
| `npm run lint` (projeto inteiro) | **244 problemas (2 erros, 242 avisos) — baseline INALTERADO**, medido antes e depois com `git stash`. Os 2 erros (`prefer-const` em `headers`) são pré-existentes e não pertencem a esta frente. |

**Nunca rode `tsc --noEmit` sem `-b`:** o root tem `files: []` + references, e sem
`-b` o comando é um no-op silencioso que sai 0 sem checar nada.

`supabase/functions/` **não é alcançado** por `tsc -b` nem pelo eslint deste
repositório. Todo o código novo de Edge Function está lá. É por isso que os
guardrails de leitura estática existem, e é por isso que a seção
"Seis famílias de falso-verde" é a parte transferível deste documento.

---

## 0. Três fatos de coordenação (ler antes de qualquer decisão)

**1. O portão comercial está FORA desta frente, e continua fechado.** O Plano B
criou `billing_plans_ai_plan_not_sellable_chk` (CHECK em `billing_plans`: plano
que declara `ai` em `included_features` não pode ficar `active`). Enquanto ele
existir, o plano-automação é **invendável no nível do banco, por decisão**. O
header da migration 097 afirma que derrubá-lo é a última ação do Plano D — **isso
não procede**: não existe essa tarefa aqui e ela não entrou. Derrubar o portão é
**ato separado**, depois que as três frentes fecharem. **Se qualquer documento
afirmar que a franquia de IA fica vendável ao fim do Plano D, corrija: ela fica
PRONTA, NÃO VENDÁVEL.**

**2. O CHECK da 094 nunca é dropado.** Quando o portão da 097 for aberto, é só
ele. O `array_position(included_features, null) is null` de
`billing_plans_included_features_chk` (migration 094) é o que fecha o caso de
elemento NULL dentro do array: `'ai' = any(array['system', null])` avalia
UNKNOWN, e um CHECK **aceita** UNKNOWN. Levar os dois juntos reabriria esse
buraco no mesmo commit que abre a venda.

**3. Timestamp de migration nova.** As 099–103 desta frente estão carimbadas às
09h e aplicam **antes** das 096–098 das 12h do Plano B. A inversão é cosmética e
foi conferida: nenhuma das cinco cita `billing_plans`, `included_features`,
`whatsapp_component_cents` nem os slugs novos. **Não renumerar nada.** A regra
vale só para arquivo NOVO: migration nova desta frente precisa de timestamp
**maior que `20260803120300`**.

---

## 1. Nada disto executou — **ALTO**, e é o item que domina todos os outros

Migrations 099–103 não aplicadas. Edge Function não deployada. Nenhuma flag
ligada. **Isto não é defeito: é ausência de evidência** — e é a ausência que
importa mais, porque quase todo item abaixo só pode ser avaliado depois da
primeira execução real.

É na primeira execução que aparece a classe de defeito que leitura estática não
alcança: **forma de retorno das RPCs** (`RETURNS TABLE` com uma linha vs zero),
`null` onde o adapter espera objeto, ordem de commit entre a RPC e a escrita
seguinte. Nenhum guardrail deste repositório vê nada disso.

**Testes 42 e 44 da spec seguem PENDENTES e são intransferíveis** — não podem
ser declarados provados por teste unitário, hoje nem depois:

- **Teste 42 — duas reservas concorrentes não usam o mesmo saldo.** Roteiro em
  `20260803090300_102_ai_budget_rpcs.sql`, bloco "Validação pós-migration",
  item 3. Núcleo puro prova a **fórmula**; ele não prova que o
  `SELECT … FOR UPDATE` serializa.
- **Teste 44 — dois ciclos sobrepostos são rejeitados.** Roteiro em
  `20260803090100_100_ai_cycle_budgets.sql`, item 2. O guardrail estático prova
  que o `EXCLUDE USING gist` **está escrito**; só o banco prova que ele existe.

Junto, e pelo mesmo motivo:

- **`btree_gist` nunca foi criada neste projeto.** As duas migrations que
  dependem dela (099 e 100) falham por inteiro se a extensão não estiver
  disponível — e **falhar é o comportamento certo**: sem o `EXCLUDE`, a não
  sobreposição deixa de ser garantia de banco e vira promessa.
- **RLS, grants e a guarda de tenant nunca foram exercitados** contra INSERT
  real. O que existe é a leitura do texto da migration.
- **O CHECK `ai_usage_events_zero_chk` nunca foi exercitado.**

**Enquanto não houver prova contra banco real, não declarar o teto
financeiramente seguro.**

---

## 2. Liquidação que falha não tem fecho real — **ALTO**, condicionado à flag

Se `finalize_ai_reservation` falhar num desfecho que não lança, a reserva fica
`HELD`; a varredura de expiração marca `EXPIRED` **sem incrementar
`settled_cents`**; e o custo real **some do teto**. Só um log denuncia.

**O log é ruidoso e não serve de alerta sem triagem:** `finalizeTurn` devolve
`null` tanto em erro de RPC quanto em `RESERVATION_NOT_FOUND`,
`CYCLE_NOT_FOUND` e `INVALID_STATUS`. Alertar em cima dele hoje produziria
alarme para os três desfechos benignos.

**Com `ai_wallet_enforced` OFF a exposição de hoje é ZERO** — sem gate ligado
nenhuma negação comercial acontece, e subcontabilizar não bloqueia ninguém. Diga
isso a quem for priorizar; sem essa frase a lista sugere sangramento presente.

**Fecho real:** varredura de banco que **liquide** reserva com
`consumed_cents > 0` em vez de expirá-la. Isso nunca coube em guardrail — é
trabalho de worker, e não há cron novo nesta frente.

---

## 3. `entitlements.readFailed` não nega — **MÉDIO hoje, ALTO no dia da flag**

**DECISÃO COMERCIAL PENDENTE, e precisa ser tomada ANTES de `ai_wallet_enforced`
ir para ON.**

Hoje um soluço de banco na resolução de entitlement faz a organização de
franquia rodar **sem ganchos, sem medição e sem hard stop**, em silêncio. É
fail-open **no dinheiro**. Foi telemetrado, não negado, por decisão explícita:
negar é escolha comercial, e não era desta task.

**Não é inócuo com a flag OFF.** Com o gate desligado o turno roda **sem
medição** — e medir é a única coisa que a fase de observação existe para
produzir. Uma degradação silenciosa na observação não custa dinheiro; custa a
própria evidência que decidiria ligar a flag.

Agrava: o `evt` do `jsonLog` desse ramo **não é preso por nenhum guardrail** (ver
N4 abaixo). O "pelo menos é visível" deste item vale enquanto ninguém trocar a
string.

---

## 4. Identidade de copy, `status` e argumento solta nas três portas — **MÉDIO**

Não perde dinheiro. Perde **a fila do operador** e **mente ao cliente**. As três
portas são: o hard stop anterior ao turno (`if (budgetExhaustedNow …)`), a
corrida entre resolução e reserva (`if (opened.kind === "EXHAUSTED")`) e o
fail-closed técnico da abertura (`if (failClosed)`) — mais o bloco de negação do
laço (`DENIED`).

### N1 — o mais consequente: nenhuma das três portas prende `status: "awaiting_human"`

`exigeHardStopCompleto` e `exigeFailClosedTecnico` inspecionam o statement do
`UPDATE` em `conversations` e exigem a **razão** de handoff. Nenhuma das duas
exige o **status**. Trocar `status: "awaiting_human"` por `"ai_active"` fica
**verde nas três**.

A consequência é literalmente a do Y1 que uma rodada anterior declarou fechado:
**cliente avisado, conversa segue `ai_active`, restaurante nunca vê a conversa na
fila.** Y1 pegava a **remoção** do UPDATE; a **neutralização do campo** passa.

**Fecho: uma linha por verificador** — exigir `status: "awaiting_human"` no mesmo
statement já recortado. Não implementado nesta task.

### N2 — copy por valor solta em três formas

`exigeFailClosedTecnico` prende a resposta ao cliente com
`.toMatch(/AGENT_INSTABILITY_TEXT|errText/)` — e **`errText` é o NOME da
variável**, presente qualquer que seja o valor atribuído a ela.

Registre com todas as letras: **isto é a família nº 5 (presença × identidade)
dentro do verificador que foi escrito para fechar a nº 6 (condição × corpo).**
Um verificador construído contra uma família de falso-verde reintroduziu outra.

**Efeito colateral, e é o que dói:** texto que não esteja em
`AI_BUDGET_HARDCODED_TEXTS` não entra no `HARDCODED_AGENT_NOISE` — logo **volta
ao prompt como mensagem de assistente** nas invocações seguintes.

### N3 — `resolveMutationStopText(lastMutationOutcome)`

O caso prende a **chamada** (`toContain("resolveMutationStopText")`), não o
**argumento**. Passar outro valor — ou um literal — mantém a suíte verde e
apaga a distinção das três situações de §17.7.4.

### N4 — quatro identidades soltas no bloco de negação

- `finish("ai_budget_error")` é trocável por `finish("success")` sem reprovar.
- O `append` na conversa pode gravar **texto diferente do enviado** ao cliente.
- O alvo do `.eq("id", …)` e o `toPhone` do `sendOutbound` **não são presos**.
- O `evt` do `jsonLog` do ramo `readFailed` **não é preso** — e é isso que
  enfraquece o "pelo menos é visível" do item 3.

---

## 5. Diferidos por instrução — **BAIXO a MÉDIO**

- **O ramo `UNMETERED` é inalcançável nas duas polaridades**, e três asserções do
  guardrail afirmam sobre ele. **Ou o ramo some, ou algo precisa alcançá-lo** —
  decisão da Task 11, não fechada. Asserção sobre código inalcançável é a
  família nº 2 abaixo, e ela está viva no repositório agora.
- **Divergência de valor de `handoff_reason` entre portas** — as portas usam
  razões próprias por decisão, mas a igualdade entre elas não é verificada.
- **`provider`/`model` da abertura** não são presos. Contido porque o
  `beforeCall` **reprecifica** com o modelo real da chamada; a abertura só
  estima.
- **Inversões de polaridade** (`&&` por `||`, `!` some) fora dos pontos com caso
  próprio — fora do alcance de leitura estática por construção.

---

## 6. O guardrail prende o NOME onde deveria prender o VALOR — **BAIXO**, estrutural

**Não é ancoragem em nome de variável.** Isso foi testado e é falso: renomear
`turnBudget` e `turnBudgetOrgId` por inteiro deixa a suíte **verde** — os
extratores (`varsDaPorta`, `ligadoDe`, `guardasDe`) tiram os nomes do próprio
código, de propósito, para que refatoração legítima não reprove.

**O que morde é o oposto.** O guardrail é robusto a rename e **cego a valor**
exatamente onde o invariante É o valor: a string `"awaiting_human"`, o literal de
`finish(...)`, o `evt` do log, o argumento de `resolveMutationStopText`, o texto
efetivamente enviado. Cada item de N1–N4 é uma instância disso.

Consequência prática para quem for endurecer isto: **não troque os extratores por
nomes literais.** O conserto é acrescentar asserção de **valor** ao lado da de
estrutura, não substituir uma pela outra.

---

## 7. As seis famílias de falso-verde

**É o achado transferível desta frente.** Vale para qualquer guardrail de leitura
estática deste repositório — os de billing, os de ACL, os de migration.

1. **Janela de tamanho fixo medindo a entrada vizinha.** `slice(i, i + 400)`
   sobre um arquivo cujo bloco cresceu: passa a medir o próximo. Todo recorte tem
   de ser por **fronteira sintática real** (chaves balanceadas, parênteses
   balanceados, fim de statement, delimitador de comentário).
2. **Asserção sobre código morto ou já corrigido.** Ela nunca fica vermelha
   porque o alvo não executa. O `UNMETERED` do item 5 é um exemplo vivo.
3. **Apagador de comentários que não conhece strings.** Tratar `//` dentro de
   `"https://…"` como comentário cega o detector da linha em diante — e a linha
   cegada foi justamente a URL que carrega a chave BYOK.
4. **Asserção que mede POSIÇÃO em vez de RAMO.** "vem depois do índice X"
   continua verdadeiro quando o código é movido para dentro do ramo de falha.
5. **Asserção que mede PRESENÇA em vez de IDENTIDADE.** "a chave `model` existe"
   é satisfeita por um literal fixo; "o `model` autorizado é o `model` invocado"
   não é.
6. **CONDIÇÃO testada com CORPO livre.** Três portas tinham o gate verificado e o
   corpo livre para mentir ao cliente.

**Corolário:** `toContain` sobre o **arquivo inteiro** é satisfeito pela **linha
de import**. Toda asserção de "esta função chama aquele núcleo" tem de ser sobre
o **corpo recortado**, e com o `(` no fim.

**Regra de método, que saiu desta frente:** **todo caso novo é sabotado nas duas
direções antes do commit. Caso que não for sabotável é declarado como tal — nunca
vendido como proteção.**

---

## 8. Fatos operacionais que ninguém deduz do código

- **`available_cents` clampa em zero** — no núcleo puro e no SQL (`greatest(…, 0)`
  em `102`). **A magnitude de um estouro se lê em `settled_cents - limit_cents`,
  nunca em `available_cents`.** Quem for construir o painel da §13 precisa disto:
  um painel que meça excesso pelo disponível mostra sempre zero.
- **`ERROR` / `price_unknown` agora ocorrem com a flag DESLIGADA.** É
  consequência direta de o preço desconhecido falhar **fechado** inclusive em
  observação (sem preço não há `price_id`, que é NOT NULL, e o evento financeiro
  não pode existir). Quem ligar a flag esperando "nada acontece até lá" vai
  encontrar esses desfechos já no log.
- **5 leituras extras por inbound de TODA organização** — `loadAiFranchise` (2:
  `ai_cycle_budgets` + `ai_cost_reservations`) e `resolveOrgEntitlements` (3) —
  **inclusive as sem franquia**, no caminho pós-debounce. Mais **2 no ramo de
  handoff por franquia**. Não foi medido contra carga real.
- **Os outcomes novos não aparecem em painel nenhum.** `ai_budget_exhausted`,
  `ai_budget_denied` e `ai_budget_error` entram em `webhook_executions.outcome`,
  que é `text` **sem CHECK** — nada quebra, e ninguém lê. Painel novo de
  observabilidade de WhatsApp deveria começar por eles.

---

## 9. Desvios deliberados da spec (registrados, não acidentais)

1. **Copy do hard stop ao cliente final.** §18.3 traz um texto "conceitual" com a
   palavra *franquia*; o destinatário real é o cliente do restaurante, e a
   própria §18.3 proíbe informar-lhe o limite. Os textos de
   `_shared/ai-budget-copy.ts` comunicam o mesmo fato (a equipe assume, nada
   quebrou) sem vocabulário de contrato. Testado em
   `src/lib/ai-budget-milestones-core.test.ts`.
2. **`DENY_PRICE_UNKNOWN` não tem `event_type` de e-mail próprio.** §18.2 congela
   quatro tipos; criar um quinto ampliaria a spec congelada. O alerta ao
   platform_admin existe como telemetria (`evt: ai_price_unknown` + meta em
   `webhook_executions`). **Reavaliar antes de ligar `ai_wallet_enforced`:** com
   a flag ligada, preço ausente interrompe a IA de uma organização, e só o log
   avisaria.
3. **Marcos são percentuais do `limit_cents`, não valores absolutos.** Com o
   limite de R$ 100 caem exatamente em R$ 70/80/90/100 da spec; com um limite
   diferente (plano CUSTOM futuro) a escada acompanha, em vez de um marco de
   R$ 70 virar "94% do teto" sem ninguém decidir isso.
4. **A varredura de reservas expiradas roda dentro de `reserve_ai_budget`**, sob
   o mesmo lock, em vez de um worker novo. **Não há cron novo nesta frente.**
   Consequência: uma organização que **pare** de usar IA deixa reservas órfãs
   `HELD` até o próximo turno. Elas não custam nada (o ciclo só é consultado
   quando há uso), mas inflam `activeReservedRemainingCents` se alguém ler o
   disponível por fora. **Se um painel de franquia for construído, ele precisa
   expirar antes de exibir — ou ganhar o worker.**
5. **`DENY_USAGE_UNRESOLVED` é escopado ao CICLO.** Bloqueio perpétuo entre
   ciclos seria o "alerta eterno" que §17.2.2 também proíbe; o valor comprometido
   já foi apropriado no ciclo em que ocorreu.

---

## 10. Reconciliação administrativa de `USAGE_REVIEW_REQUIRED` — **sem superfície**

§17.2.2 exige resolução "administrativa ou por reconcile seguro, nunca por
decurso de prazo". O **estado** existe (`ai_usage_events.usage_state`,
`resolved_at`, `resolved_by`, `resolution_note`;
`ai_cost_reservations.usage_review_required`), e a expiração automática o
respeita. **A superfície de resolução não existe** — não há painel nem action de
`manage-billing` para marcar um evento como resolvido. Hoje isso se faz por SQL
de platform_admin.

**Quem decide:** engenharia, antes de ligar `ai_wallet_enforced`. Com a flag OFF
o estado nunca bloqueia ninguém; com ela ligada, um usage indeterminado
interrompe a IA da organização **até o fim do ciclo**.

---

## 11. CLAUDE.md a consolidar

> Esta frente **não edita** `CLAUDE.md` (três frentes em paralelo editam o mesmo
> arquivo; a consolidação é um commit único no fim, fora deste chat). O que
> entraria lá está aqui, pronto para colar, no formato do arquivo.

### Checklist de redeploy — linhas novas

- **`ai-providers.ts`** → **`webhook-whatsapp` apenas** — é o único importador de runtime, verificado por teste (`src/lib/ai-budget-redeploy-guard.test.ts`). A linha do checklist do `CLAUDE.md` que cita a EF de catálogo existe por OUTRA razão: o invariante de **sincronização do catálogo de modelos** (`DEFAULT_MODELS`, `KNOWN_MODELS`, `MODELS_BY_PROVIDER`, `DEFAULT_MODEL_BY_PROVIDER`). O Plano D **não toca o catálogo**, logo não exige o redeploy daquela EF.
- **`ai-price-core.ts`** (núcleo puro, testado em `src/lib/ai-price-core.test.ts`) → `webhook-whatsapp` (via `ai-budget-gate.ts` e `ai-call-authorizer-core.ts`). Decide vigência de preço e o `CostResult` discriminado; redeploy parcial deixa uma ponta precificando com vigência velha em memória.
- **`ai-budget-core.ts`** (núcleo puro, testado em `src/lib/ai-budget-core.test.ts`) → `webhook-whatsapp` (import direto, e também via `ai-budget-gate.ts`). Carrega a fórmula do teto, a janela do ciclo, a estimativa conservadora e a união `BeforeCallDecision`.
- **`ai-budget-milestones-core.ts`** (núcleo puro) → `webhook-whatsapp` (via `ai-budget-gate.ts`). **Fonte canônica dos quatro `admin_ai_budget_*`** (`EVENT_TYPE_BY_MILESTONE_PERCENT`) — nunca redigitar a lista.
- **`ai-budget-copy.ts`** (núcleo puro) → `webhook-whatsapp` (import direto). Os textos determinísticos do bloqueio; mudá-los sem redeployar deixa o `HARDCODED_AGENT_NOISE` filtrando frases que já não são emitidas — e as novas voltam ao prompt como mensagem de assistente.
- **`ai-call-authorizer-core.ts`** (núcleo puro, testado em `src/lib/ai-call-authorizer-core.test.ts`) → `webhook-whatsapp` (via `ai-providers.ts`). O protocolo ordenado de §17.7.3.
- **`ai-budget-gate.ts`** (adapter de I/O) → `webhook-whatsapp`. Consumidor único hoje.
- **`whatsapp-instance-cycle-core.ts`** → acrescentar **`webhook-whatsapp`** (via `ai-budget-core.ts`, que reusa `clampDayToMonth` em vez de reimplementar a aritmética de âncora). É a única linha desta frente que cruza com o Plano de instâncias.
- **`billing-notify.ts`** → acrescentar **`webhook-whatsapp`** (via `ai-budget-gate.ts`: `resolvePlatformAdminRecipients` + `enqueueBillingNotification`).
- **`platform-flags.ts`** → `webhook-whatsapp` já consta; a flag lida agora inclui `ai_wallet_enforced`.
- **`entitlements.ts` / `entitlements-core.ts`** → acrescentar **`webhook-whatsapp`** às consumidoras já listadas (`manage-billing`, `create-billing-checkout`, `manage-whatsapp-implementations`): o webhook passou a resolver entitlements para descobrir se a organização está no ramo de franquia. **Esta linha fica por último de propósito** — o guardrail a lê por janela de 400 caracteres a partir do nome do arquivo, e com um item abaixo dela a janela sangraria para o vizinho (família nº 1 da seção 7), deixando o caso verde com o `webhook-whatsapp` do bullet seguinte.

**Nota sobre `import type`:** `ai-providers.ts` importa `BeforeCallContext`/`BeforeCallDecision` de `ai-budget-core.ts` **só como tipo** (apagado na compilação), e `ai-budget-gate.ts` faz o mesmo com `ai-providers.ts` e `ai-call-authorizer-core.ts`. Isso não muda nada hoje — todas as consumidoras são a mesma EF — mas quem for propagar essas dependências para outra EF no futuro precisa saber quais arestas são de runtime.

### Acoplamento por string — SEXTA ocorrência

`webhook-whatsapp` (via `ai-budget-gate.ts`) enfileira
`admin_ai_budget_70|80|90|stop`, e é `process-billing-notifications`
(`TEMPLATE_BY_EVENT`) quem sabe renderizá-los. As duas EFs **não compartilham
nenhum `_shared/`** para esse acoplamento — é só o `event_type`. Deployar o
produtor sozinho é inofensivo (a linha fica `pending`); deployar com um
`process-billing-notifications` anterior a este commit mata o aviso em
`failed/unknown_event_type` exatamente quando importa. Teste bidirecional:
`src/lib/ai-budget-dispatcher.test.ts`.

### Ordem de aplicação — é invariante, não recomendação

**As migrations 099–103 precisam ser aplicadas (`supabase db push`) ANTES do
deploy da Edge Function que as lê.** Se a EF subir primeiro, `loadAiFranchise`
loga `ai_budget_franchise_read_failed` **a cada inbound** e degrada **aberto**
(não fecha) — tolerável, mas é ruído contínuo e **mascara o item 3** deste
documento, que é exatamente o sinal que se quer enxergar.

Depois das migrations: **`process-billing-notifications` primeiro**, antes de
qualquer produtor dos quatro `admin_ai_budget_*`. Só então `webhook-whatsapp`.

### Invariantes novos (candidatos a linha no CLAUDE.md)

- **A franquia de IA tem teto FINANCEIRO e nenhum teto de volume.** Qualquer código que conte conversas, mensagens ou interações para autorizar ou negar está errado. `_shared/ai-budget-core.ts`.
- **`beforeCall` devolve união discriminada, nunca boolean.** `ERROR` de infraestrutura e `DENY_BUDGET` levam ao mesmo destino operacional mas dizem coisas opostas ao cliente e ao admin — só uma significa que a franquia acabou. `_shared/ai-budget-core.ts`.
- **`estimateCostUsd` serve telemetria; o orçamento usa `ai-price-core.ts`.** O primeiro devolve zero para modelo desconhecido, e zero no caminho de orçamento é consumo ilimitado sem tocar o teto. Não unificar. `_shared/ai-providers.ts`.
- **A chamada de fallback do Gemini é chamada financeira própria** — autorização, preço do modelo real e `call_id` próprios; sem usage da primeira, a segunda recebe `DENY_USAGE_UNRESOLVED`. `_shared/ai-providers.ts`.
- **`settled_cents` e reservas nunca colapsam num campo só.** Reserva é capacidade comprometida, não gasto. `ai_cycle_budgets` / `ai_cost_reservations`.
- **Reserva com `usage_review_required` sai da varredura de expiração.** Sem isso o TTL de recuperação de crash vira porta de saída para consumo não contabilizado. `20260803090200_101`.
- **`ai_usage_events.price_id` é NOT NULL** — evento financeiro só existe com preço conhecido; é o que torna o fail-closed de preço uma garantia de banco, e é por isso que `price_unknown` ocorre mesmo com a flag OFF.
- **Modelo novo em `KNOWN_MODELS` exige preço semeado na 099 no mesmo PR.** Sem preço o agente daquela organização **cala** (não degrada), porque o fail-closed é de banco. Guardrail: `src/lib/ai-budget-migrations-guard.test.ts`, bloco "todo modelo conhecido tem preço semeado".

---

## 12. Escopo desta frente

Não foram tocados (são de outras frentes): `manage-whatsapp-instances`,
`manage-channels`, `WhatsappInstances.tsx`, `manage-whatsapp-implementations`,
componentes de pricing. Seeds e catálogo dos dois planos: **Plano B**. Fluxos
comerciais: **Plano C**.

O que o lojista vê da franquia (§18.4 — `Franquia disponível` · `Uso elevado` ·
`Franquia utilizada`) **não foi construído**: exigiria superfície de frontend, e
`budgetRemainingCents` **não pode ir ao painel do lojista por caminho
compartilhado** — precisa de caminho de resposta separado, pelo mesmo motivo do
payload de `manage-billing`. É por isso que `FeatureEntitlementView` em
`src/hooks/useBilling.ts` ganhou `"franchise"` em `source` **sem** ganhar
`budgetRemainingCents`.

---

## 13. O que a Task 13 mexeu no código (e o que o próprio guardrail não prova)

Três correções menores, além deste documento e de
`src/lib/ai-budget-redeploy-guard.test.ts`:

- **A varredura de segredo das migrations passou a cobrir as CINCO** (`all =
  [prices, budgets, usage, rpcs, milestones]`). As 102/103 são justamente as que
  montam `SECURITY DEFINER` e `grant execute` — a superfície onde uma chave
  literal teria motivo plausível para aparecer. **Sabotado nas duas direções:**
  com um JWT injetado na 102, o array antigo passava verde e o novo reprova.
- **`FeatureEntitlementView.source` ganhou `"franchise"`** em
  `src/hooks/useBilling.ts`. **Não é sabotável por teste:** o valor chega do
  `manage-billing` como JSON em runtime, e TypeScript não alcança isso. É
  correção de tipo, não proteção — declarada como tal.
- **Caso novo fixando `state: "CLOSED"` → `allowed: true`** em
  `src/lib/entitlements-core.test.ts`. `CLOSED` é ciclo **encerrado**, não teto
  estourado; trocar a comparação por "estado diferente de OPEN" tiraria a IA de
  toda organização de franquia na virada do ciclo, com o teto cheio. **Sabotado:**
  é o único caso da suíte que fica vermelho com essa troca.

**Duas asserções do guardrail de redeploy são fracas, e é honesto dizer:**
`expect(doc).toMatch(/42/)` e `/44/` prendem **dígitos em qualquer lugar** do
documento, não a afirmação de que os testes 42 e 44 seguem pendentes. É a família
nº 5 outra vez. Elas ficam vermelhas hoje se os números sumirem, mas qualquer
`42` acidental futuro as satisfaz.

---

## 14. Gate comercial

**`PLAN_AUTOMACAO_CHECKOUT = NO-GO`** até o teto estar provado contra banco real
(seção 1) e até a pendência do Plano A (concorrência do limite de conexões)
fechar. O teto é parte do modelo econômico de R$ 799,90.

Flags permanecem OFF (`ai_wallet_enforced`, `billing_notifications_dispatch`).
Nenhum plano publicado — e o CHECK do Plano B garante isso no banco (seção 0).
**Ren Sushi segue vitalício e grátis — override LIFETIME em `system`, `whatsapp`
e `ai` intacto, e o ramo de franquia nunca o alcança (prioridade 2 do resolvedor,
testado por cenário nomeado em `src/lib/entitlements-core.test.ts`).**
