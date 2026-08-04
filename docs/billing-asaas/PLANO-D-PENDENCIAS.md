# Pendências do Plano D — franquia de IA inclusa

Fase 7 redefinida (spec §17-18). Ambiente sem Docker e sem banco local.
**Nenhuma migration aplicada, nenhuma Edge Function deployada, nenhuma flag
alterada, nenhum cron criado.** Tudo abaixo é o que a suíte verde NÃO prova.

Este documento é escrito para quem **não viveu esta frente**. Cada linha é uma
decisão que essa pessoa precisa tomar, ou um erro que ela evitaria.

## Gates desta entrega

| Gate | Resultado |
|---|---|
| `npx vitest run` | **1084 testes / 40 arquivos — verde** (1047/40 antes da rodada de correção da revisão final; 1026/39 no início da frente) |
| `npm run typecheck` (`tsc -b --noEmit`) | **zero erros** |
| `npx eslint supabase/functions --max-warnings=0` | **limpo** (exit 0) |
| `npx eslint <arquivos tocados> --max-warnings=0` | **limpo** (exit 0) |
| `npm run lint` (projeto inteiro) | **244 problemas (2 erros, 242 avisos) — baseline INALTERADO**, medido antes e depois com `git stash`. Os 2 erros (`prefer-const` em `headers`) são pré-existentes e não pertencem a esta frente. |

**Nunca rode `tsc --noEmit` sem `-b`:** o root tem `files: []` + references, e sem
`-b` o comando é um no-op silencioso que sai 0 sem checar nada.

**Quem alcança `supabase/functions/`, e com o quê:** `tsc -b` **não** alcança (o
tsconfig do app não as inclui). O **eslint alcança — com exatamente UMA regra,
`no-undef`, por decisão**: [eslint.config.js](../../eslint.config.js) tem bloco
dedicado `files: ["supabase/functions/**/*.ts"]`, criado depois de um
`ReferenceError` que chegou ao caminho de autorização de
`manage-whatsapp-instances` sem nenhuma ferramenta do projeto pegá-lo. Ligar o
conjunto completo ali produziria ruído (imports por URL, globais do Deno) e seria
abandonado; uma regra só, contra a classe de defeito que passou, se sustenta.

Todo o código novo de Edge Function está lá, **com essa cobertura e nenhuma
outra**. É por isso que os guardrails de leitura estática existem, e é por isso
que a seção "Seis famílias de falso-verde" é a parte transferível deste
documento.

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

> ⚠️ **CONDIÇÃO — leia antes de mergear o Plano D sozinho.** O CHECK é criado
> pelas migrations **096–098, que NÃO existem nesta branch**: ela vai da 095
> direto para a 099. Enquanto as 096–098 não estiverem aplicadas, **a
> invendabilidade no nível do banco NÃO EXISTE** — nem a migration, nem a
> constraint. Se o Plano D for para produção antes do Plano B, a **única**
> barreira comercial passa a ser o `PLAN_AUTOMACAO_CHECKOUT = NO-GO` da seção 14,
> que é processo, não banco: nada impede alguém de marcar o plano `active` no
> painel. Quem mergear primeiro herda a obrigação de dizer isso em voz alta.

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

- **`btree_gist` é PEDIDA pela 099 e nunca foi criada de fato neste projeto.**
  A migration traz `create extension if not exists btree_gist with schema
  extensions` — o que não se sabe é se a extensão está **disponível na
  instância**, porque nenhuma migration deste projeto jamais a usou. As duas que
  dependem dela (099 e 100) falham por inteiro se não estiver — e **falhar é o
  comportamento certo**: sem o `EXCLUDE`, a não sobreposição deixa de ser
  garantia de banco e vira promessa. **E o inverso da mesma cláusula:** se ela já
  estiver instalada em `public`, a linha é no-op e a auditoria de ACL continua
  suja — conferir com `select extnamespace::regnamespace from pg_extension where
  extname='btree_gist'`.
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

## 4. Identidade de copy e argumento solta nas três portas — **MÉDIO** (N1 fechado)

Não perde dinheiro. Perde **a fila do operador** e **mente ao cliente**. As três
portas são: o hard stop anterior ao turno (`if (budgetExhaustedNow …)`), a
corrida entre resolução e reserva (`if (opened.kind === "EXHAUSTED")`) e o
fail-closed técnico da abertura (`if (failClosed)`) — mais o bloco de negação do
laço (`DENIED`).

**N1 (o `status`) foi fechado** na rodada de correção da revisão final, e o fecho
cobriu sete portas em vez de três. **N2, N3 e N4 seguem abertos.**

### N1 — **FECHADO** na rodada de correção da revisão final

Era o mais consequente: `exigeHardStopCompleto` e `exigeFailClosedTecnico` exigiam
a **razão** de handoff e nenhuma das duas exigia o **status**. Trocar
`status: "awaiting_human"` por `"ai_active"` ficava verde — e não só nas três
portas do Plano D: a mesma cirurgia neutralizava os handoffs pré-existentes de
`agent_error` e `api_key_not_configured`, e o da ferramenta
`request_human_handoff`. Consequência idêntica à do Y1: **cliente avisado,
conversa segue com a IA, restaurante nunca vê a conversa na fila.**

O fecho cobre as **sete** escritas, não as três. Além da linha em cada
verificador, há uma enumeração por PROPRIEDADE — toda escrita em `conversations`
com razão de handoff não-nula **e** rearme do lembrete
(`last_silenced_reply_at: null`) é uma porta para a fila do operador —, com a
contagem fixada em 7 e um controle exigindo que exista escrita de handoff FORA
desse padrão (o eco da mensagem digitada na loja, que grava `human_active`): sem
esse controle, um discriminador que casasse tudo ficaria verde sem medir nada.
Porta nova entra sozinha na contagem e reprova com mensagem dizendo isso —
ajustar o número faz parte de acrescentar a porta.

Sabotadas uma a uma, mais dois decoys: campo ausente, e `human_active` no lugar
de `awaiting_human` (que silenciaria o alerta em vez de mudar a fila).
`src/lib/ai-budget-wiring-guard.test.ts`.

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
exatamente onde o invariante É o valor: o literal de `finish(...)`, o `evt` do
log, o argumento de `resolveMutationStopText`, o texto efetivamente enviado.
Cada item de N2–N4 é uma instância disso. **`"awaiting_human"` era a instância
mais consequente e deixou de ser** — ver N1, fechado; o padrão do fecho (asserção
de **valor** ao lado da de estrutura, nunca no lugar dela) é o que as demais
esperam.

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
- **Os outcomes novos JÁ aparecem no painel — como slug cru, em cinza neutro.**
  Não é "falta painel": `whatsapp-health` agrega `by_outcome` **genericamente,
  sem whitelist** ([whatsapp-health/index.ts](../../supabase/functions/whatsapp-health/index.ts)),
  e a aba Diagnóstico de `/platform/automacao/:unitSlug` renderiza **toda** chave
  com `OUTCOME_LABEL[outcome] ?? outcome` e `OUTCOME_TONE[outcome] ?? "neutral"`
  ([Automacao.tsx](../../src/pages/gestao/Automacao.tsx)). Resultado hoje:
  **`ai_budget_exhausted` — um hard stop da IA — é exibido sem tradução e com o
  mesmo cinza de "Duplicada".** `webhook_executions.outcome` é `text` **sem
  CHECK**, então nada quebra; o defeito é de leitura humana, e é pior que
  ausência, porque parece informação. **Fecho: uma entrada em `OUTCOME_LABEL` e
  uma em `OUTCOME_TONE` para cada um dos três** (`ai_budget_exhausted`,
  `ai_budget_denied`, `ai_budget_error`). **Não é painel novo.**
  **Ressalva sobre a amostra:** a agregação roda sobre `.limit(50)` das últimas
  execuções de 24h, não sobre o total — num restaurante movimentado um
  `ai_budget_exhausted` esporádico pode simplesmente **não cair na amostra**.
  Traduzir os três rótulos conserta a leitura de quem os vê; **não** os torna
  confiáveis como contagem.

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
- **`ai-budget-gate.ts`** (adapter de I/O) → `webhook-whatsapp`. Consumidor único hoje. **Acoplado à RPC `record_ai_call_usage` (migration 102), que mudou de assinatura:** os dois sobem juntos. Adapter novo com RPC antiga nunca vê `reason_code`, não loga `ai_usage_record_not_applied` e volta a adotar contadores zerados em silêncio; RPC nova com adapter antigo é compatível (coluna extra ignorada). É acoplamento migration × EF, e por isso não aparece em nenhum `import`.
- **`whatsapp-instance-cycle-core.ts`** → acrescentar **`webhook-whatsapp`** (via `ai-budget-core.ts`, que reusa `clampDayToMonth` em vez de reimplementar a aritmética de âncora). É a única linha desta frente que cruza com o Plano de instâncias.
- **`billing-notify.ts`** → acrescentar **`webhook-whatsapp`** (via `ai-budget-gate.ts`: `resolvePlatformAdminRecipients` + `enqueueBillingNotification`).
- **`platform-flags.ts`** → `webhook-whatsapp` já consta; a flag lida agora inclui `ai_wallet_enforced`.
- **`entitlements.ts` / `entitlements-core.ts`** → acrescentar **`webhook-whatsapp`** às consumidoras já listadas (`manage-billing`, `create-billing-checkout`, `manage-whatsapp-implementations`): o webhook passou a resolver entitlements para descobrir se a organização está no ramo de franquia.

**Como o guardrail lê este checklist:** cada linha é recortada pelo **item de
lista inteiro** — da abertura do `- ` até o próximo `- ` ou linha em branco —,
nunca por janela de tamanho fixo. A primeira versão media 400 caracteres e
sangrava para o item vizinho, ficando verde com o conteúdo DELE (família nº 1 da
seção 7). Duas consequências para quem editar: **a posição de uma linha na lista
não faz parte da proteção** (reordenar é seguro), e **prosa sobre o teste não
entra dentro de um item** — se entrar, ela passa a satisfazer sozinha a asserção
que verifica aquele item. Este parágrafo fica fora da lista exatamente por isso,
e apagá-lo não quebra nada.

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
deploy da Edge Function que as lê.** Inverter a ordem degrada **ABERTO**, não
fechado — e é por isso que ela precisa ser descrita com precisão, e não pelo pior
caso imaginável.

O que acontece de fato, com a flag OFF:

- **`ai_budget_franchise_read_failed` em 100% dos inbounds.**
  `loadAiFranchise` roda para **toda** organização, inclusive as sem franquia, no
  caminho pós-debounce. Sem `ai_cycle_budgets` a leitura falha, devolve `null`, e
  `null` é tratado como "não consultado" — **nunca** como esgotado. O turno segue.
- **`ai_budget_open_failed` por turno**, nas organizações de franquia:
  `openTurnBudget` chama `open_ai_cycle_budget`, a RPC não existe, o resultado é
  `ERROR/budget_open_failed`, e `failClosed = enforced || code === "price_unknown"`
  é **false** com a flag desligada. O turno roda **sem ganchos e sem medição**.

**O fail-closed de preço NÃO é este caminho, e afirmar que é constrói um modelo
causal falso sobre o único fail-closed que ignora a flag.** Duas razões
independentes: (1) `openTurnBudget` resolve o ciclo **antes** de resolver preço e
retorna no primeiro erro, então `price_unknown` nem é alcançado; (2) não existe
estado em que `ai_model_prices` falte com as RPCs presentes — a 101 tem FK para
`ai_model_prices(id)`, e as três migrations sobem na mesma ordem. `price_unknown`
com a flag OFF é real, mas o gatilho dele é **modelo sem preço semeado** (seção 8
e seção 15), não ordem de deploy.

**O custo real da inversão, então, é o da seção 3:** ruído contínuo que
**mascara** o sinal que se quer enxergar na primeira execução, e — nas
organizações de franquia — perda da **medição**, que é a única coisa que a fase
de observação existe para produzir. Nada disso interrompe atendimento. Também
não há hoje organização alguma com `entitlements.ai.source === "franchise"`, o
que torna o segundo efeito latente até o primeiro plano de franquia existir.

**Acoplamento novo, do mesmo tamanho:** `record_ai_call_usage` (102) mudou de
assinatura — a RPC e `_shared/ai-budget-gate.ts` sobem **juntos**. Adapter novo
com RPC antiga nunca produz o log de anomalia (`ai_usage_record_not_applied`) e
volta a adotar contadores zerados em silêncio; RPC nova com adapter antigo é
compatível (a coluna extra é ignorada).

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
- **A ordem de lock das RPCs do orçamento vale para os locks IMPLÍCITOS de FK, não só para os `for update`.** Toda checagem de chave estrangeira roda `select … for key share` na linha-pai: um `insert into ai_usage_events` trava sozinho a linha do orçamento e a da reserva, e fazê-lo antes do `for update` do MESMO orçamento é deadlock de upgrade (40P01). Agravante que ninguém deduz: essa ordem é subproduto da **ordem das colunas** na `create table` da 101 — reordená-las inverte a aquisição em silêncio, e o guardrail estático mede posição textual de `for update`, sendo cego a isso. `20260803090300_102`.
- **O upgrade `KEY SHARE → FOR UPDATE` continua existindo na linha da RESERVA**, e é seguro só porque **todo escritor trava o orçamento antes** — não porque a ordem textual esteja certa. Caminho novo que toque `ai_cost_reservations` sem passar pelo `for update` do orçamento reabre o 40P01. Pré-existente, não regressão. `20260803090300_102`.
- **`with schema extensions` é no-op se a extensão já existir em `public`.** A 099 não conserta uma `btree_gist` já instalada no schema errado, e a auditoria de ACL continuaria suja — mover exige `alter extension … set schema`, em migration própria.
- **No lado direito de um `set`, coluna da tabela atualizada é sempre qualificada** (102 e 103). Sem alias, a correção depende de a coluna não ser homônima de OUT param **daquela** função — e a lista de retorno é o que mais muda. Guardrail: `src/lib/ai-budget-migrations-guard.test.ts`, bloco "nenhum SET referencia coluna crua".
- **A guarda de tenant do orçamento cobre DOIS caminhos de atribuição** (`cycle_id` e `unit_id`), e lê o segundo por `to_jsonb(new)`: a função é compartilhada por tabelas sem a coluna, onde `new.unit_id` seria 42703 em tempo de execução. `20260803090200_101`.

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

### O guardrail de redeploy reproduziu três das seis famílias — e foi corrigido

Não é anedota: é a prova de que a lista da seção 7 vale **para quem a escreveu**.
A primeira versão destes casos foi escrita e revisada por quem acabara de
catalogar as seis famílias, e caiu em três delas.

- **`toMatch(/42/)` e `/44/` eram VÁCUAS, não "fracas no futuro".** Já estavam
  satisfeitas pela **tabela de gates deste próprio documento**, que traz
  `244 problemas (2 erros, 242 avisos)`: `242` casa `/42/`, `244` casa `/44/`.
  **Apagar a seção 1 inteira** — testes 42/44 pendentes, `btree_gist`, RLS nunca
  exercitada, a conclusão de não declarar o teto seguro — **deixava a suíte
  verde**, e essa é a única asserção que protegia a pendência mais importante do
  documento. Família nº 5. Fechado: o caso recorta a **seção** que contém a
  afirmação e exige a substância dela.
- **Cinco dos seis casos "tem linha própria no checklist" não verificavam linha
  nenhuma** — só presença do nome em qualquer parágrafo. Apagar o bullet de
  `ai-price-core.ts`, `ai-budget-core.ts`, `ai-budget-copy.ts`,
  `ai-call-authorizer-core.ts` ou `ai-budget-gate.ts` ficava verde, porque os
  cinco também são citados em prosa. É **o corolário da seção 7**
  (`toContain` sobre o arquivo inteiro é satisfeito pela linha de import),
  aplicado a prosa em vez de código. Fechado: o caso exige **início de bullet**
  (`- **\`nome.ts\`**`) e lê o item recortado.
- **`slice(i, i + 400)` no caso de `entitlements-core.ts`** sangrava para o item
  vizinho. Família nº 1. Fechado pelo recorte de item.

E a **correção** das três caiu em mais duas, achadas pela sabotagem da própria
rodada de correção — o que é a evidência mais forte de que a lista da seção 7 não
é conhecimento que se "aplica uma vez":

- **A explicação do recorte foi escrita DENTRO do item que ela explica**, e a
  palavra `webhook-whatsapp` dessa prosa passou a satisfazer sozinha a asserção
  sobre aquele item: apagar a consumidora real do bullet ficava verde. Família
  nº 5 de novo. Fechado movendo o parágrafo para fora da lista — onde apagá-lo é
  inofensivo, que é como prosa-sobre-teste deve se comportar.
- **O recorte de seção só conhecia `## `**, então uma âncora dentro de uma
  subseção devolvia a seção 11 INTEIRA: apagar a subseção "Acoplamento por
  string" ficava verde, porque as subseções irmãs também citam
  `process-billing-notifications` e `admin_ai_budget`. Família nº 1 num nível
  acima do original. Fechado recortando pela fronteira mais **próxima** (`## ` ou
  `### `) e ancorando o caso no cabeçalho da própria subseção.

E uma sexta, que sobreviveu a duas rodadas porque **sabotagem por deleção pura
dava vermelho e enganava**:

- **`toMatch(/migration[\s\S]{0,200}antes[\s\S]{0,200}deploy/i)`** era a última
  janela de tamanho fixo sobre o documento inteiro. Apagar a subseção "Ordem de
  aplicação" **e plantar uma frase banal noutra seção** — *"qualquer migration
  futura deve ser revisada antes de ir para deploy"* — ficava **VERDE**. Famílias
  nº 1 e nº 5 juntas. Fechado pelo recorte da subseção, exigindo dela `ANTES`,
  `deploy`, a faixa `099`–`103` e as duas ordens de deploy.
  **Lição de método, e é a mais transferível desta frente:** *sabotar por deleção
  não basta — tem de ser com **decoy**.* Uma asserção por janela larga reprova a
  deleção e passa a mentira, que é o pior dos dois desfechos.

### Contrato de edição deste documento

O guardrail lê por fronteira sintática, então há três coisas que um editor
precisa saber — e nenhuma delas é adivinhável:

1. **Prosa sobre o teste fica FORA de item de lista.** Dentro, ela passa a
   satisfazer sozinha a asserção sobre aquele item. Apagar prosa-sobre-teste tem
   de ser inofensivo, e é: há controle explícito disso.
2. **Subdividir uma seção com `###` é seguro.** O recorte de nível 2 inclui as
   subseções e só termina no próximo `## `. (Não era assim: a versão anterior
   truncava, e reprovava com mensagem que não apontava a causa.)
3. **Renomear um cabeçalho ancorado quebra o caso — de propósito, e com mensagem
   nominal.** As âncoras são: `Nada disto executou`, `Gate comercial`,
   `fatos de coordenação`, `Acoplamento por string`, `Ordem de aplicação`. Trocar
   o título é edição legítima; ajustar a âncora junto é parte dela. **Acrescentar
   texto — inclusive cross-reference a estas seções — é sempre seguro**, porque
   nenhuma âncora é "primeira ocorrência de uma string".

### O que continua sem proteção, declarado

- **Asserção sobre texto não distingue afirmação de negação.** Reescrever "seguem
  PENDENTES" como "NÃO seguem mais PENDENTES" fica **verde**: a palavra sobrevive
  na negação. Nenhum recorte sintático resolve — só leitura humana. Está escrito
  no cabeçalho do arquivo de teste como limite conhecido, não como proteção.
- **A adição de `"franchise"` em `FeatureEntitlementView.source`** não é
  verificável por teste: o valor chega do `manage-billing` como JSON em runtime, e
  o TypeScript não alcança isso. É correção de tipo, não proteção.

Fora esses dois, **não restou asserção que passe por proteção sem ser** — e a
frase anterior deste parágrafo ("não restou asserção *declarada* como
não-protetora") era verdade literal e engano prático: sobrava uma **não
declarada**, que é pior que uma declarada.

### O que a rodada de correção da revisão final acrescentou, e o que ela declara

Duas lacunas foram **encontradas pela sabotagem**, e as duas foram fechadas —
mas o caminho até elas é o registro que importa, porque as duas eram invisíveis
para o detector que já existia:

- **Reverter a qualificação de `settled_cents` (102) ou de
  `reserved_cents - consumed_cents` (`finalize`) passava VERDE.** O detector
  genérico de 42702 só enxerga coluna que é OUT param **daquela** função, e
  nenhuma das duas é. Fechado por uma regra sem lista de exceção — **no lado
  direito de um `set`, nenhuma coluna da tabela atualizada aparece crua** —,
  que obrigou a qualificar também o `enqueue_attempts` da 103, pelo mesmo
  motivo latente. **Limite declarado: a regra cobre o SET, não o WHERE.**
  Qualificar o WHERE exigiria alias em `touch_ai_budget_milestone` inteiro e
  reescreveria três asserções que leem o predicado por texto; `id` e
  `organization_id` não são nome de OUT param em nenhuma das seis funções. Se
  alguma passar a ser, é ali que entra.
- **Logar a anomalia da RPC e NÃO interromper o gancho passava verde** — ou
  seja, a metade que importa financeiramente (voltar a adotar os contadores
  zerados, dizendo ao `beforeCall` seguinte que a reserva inteira está livre).
  Qualquer asserção sobre o `evt` do log continua verde nesse cenário. Fechado
  por um caso sobre o FLUXO, que aceita as **duas** formas legítimas de impedir
  a queda (interromper, ou pôr a adoção num `else`) — exigir só a primeira
  reprovaria refatoração correta.

E um erro da própria rodada, registrado porque a classe é pior que o defeito:
**a seção "Ordem de aplicação" chegou a afirmar uma cadeia causal que o código
não executa** (`price_unknown` → fail-closed → handoff para todo cliente) **e a
prendeu com teste**. Era inalcançável por duas razões independentes — a abertura
do ciclo precede a resolução de preço e retorna no primeiro erro, e
`ai_model_prices` não pode faltar com as RPCs presentes (FK da 101). Trocou-se
uma descrição correta-mas-subdimensionada por uma incorreta **blindada**, sobre
justamente o único fail-closed que ignora a flag. O caso agora ancora nos dois
eventos observáveis (`ai_budget_franchise_read_failed`, `ai_budget_open_failed`)
e na direção da degradação (**ABERTO**). **Lição de método: um guardrail escrito
sobre um modelo causal não verificado é pior que nenhum — ele transfere a
confiança de quem o lê para a afirmação errada.**

---

## 14. Gate comercial

**`PLAN_AUTOMACAO_CHECKOUT = NO-GO`** até o teto estar provado contra banco real
(seção 1) e até a pendência do Plano A (concorrência do limite de conexões)
fechar. O teto é parte do modelo econômico de R$ 799,90.

Flags permanecem OFF (`ai_wallet_enforced`, `billing_notifications_dispatch`).
Nenhum plano publicado. **A garantia de banco ainda NÃO existe nesta branch:** o
CHECK `billing_plans_ai_plan_not_sellable_chk` vem das migrations 096–098 do
Plano B, que não estão aqui (esta branch vai da 095 direto para a 099). Ele
**passará a garantir** a invendabilidade quando as três forem aplicadas —
condição escrita por extenso na seção 0. Até lá a única barreira é este NO-GO,
que é processo, não banco: nada impede alguém de marcar o plano `active` no
painel. Esta seção é justamente a que se abre para saber o que barra a venda, e
afirmar aqui, no presente, uma garantia que a seção 0 diz não existir era a pior
combinação possível.
**Ren Sushi segue vitalício e grátis — override LIFETIME em `system`, `whatsapp`
e `ai` intacto, e o ramo de franquia nunca o alcança (prioridade 2 do resolvedor,
testado por cenário nomeado em `src/lib/entitlements-core.test.ts`).**

---

## 15. Antes de ligar `ai_wallet_enforced` — o que fechar primeiro

Consolidado aqui porque estava espalhado por quatro seções e cada uma dizia
"reavaliar antes da flag" sem que existisse a lista. **Nada aqui é opcional no
dia em que a negação comercial passar a acontecer de verdade.**

- **Prova contra banco real** — testes 42 e 44 da spec (seção 1). Enquanto não
  houver, não declarar o teto financeiramente seguro.
- **Decisão sobre `entitlements.readFailed`** (seção 3): hoje um soluço de banco
  faz a organização rodar sem ganchos, sem medição e sem hard stop.
- **Superfície de resolução de `USAGE_REVIEW_REQUIRED`** (seção 10) — e, junto
  dela, **alerta de pendência persistente**, que a §17.2.2 da spec pede e não
  existe: hoje **um único usage indeterminado cala a IA da organização até o fim
  do ciclo**, sem alerta nenhum e sem caminho de resolução que não seja SQL
  manual de platform_admin. Com a flag OFF isso nunca bloqueia ninguém; com ela
  ligada, é uma interrupção comercial que ninguém vê acontecer.
- **`billing_notifications_dispatch` tem de ser ligada JUNTO.** As duas flags são
  independentes e a assimetria é armadilha: com o dispatch OFF os quatro marcos
  entram em `billing_notifications` e ficam `pending` para sempre — inclusive o
  de **100%**, que é o aviso de que a franquia acabou. Ligar só
  `ai_wallet_enforced` produz exatamente o pior par: bloqueio acontecendo,
  ninguém avisado.
- **`DENY_PRICE_UNKNOWN` não tem `event_type` de e-mail** (seção 9, desvio 2): com
  a flag ligada, preço ausente interrompe a IA de uma organização e só o log
  avisa.
- **O guardrail de "modelo novo exige preço semeado" lê APENAS o seed da 099.**
  Ele cruza `KNOWN_MODELS` com o bloco `values (…)` daquela migration — preço
  cadastrado numa migration 104+, ou inserido pelo painel, **não o satisfaz**, e
  um modelo legitimamente precificado por fora reprovaria a suíte. O inverso
  também vale e é pior: o guardrail continua verde para um catálogo cujo preço
  real vive noutro lugar. Quem mover a fonte de preço tem de mover o guardrail
  junto. `src/lib/ai-budget-migrations-guard.test.ts`.

---

## 16. Overage: três definições em conflito — **decisão aberta**

Três lugares do sistema chamam a mesma coisa por nomes incompatíveis, e **nenhum
dos três está errado isoladamente** — é a ausência de decisão que é a pendência.

1. **O schema chama de incidente.** `ai_cost_reservations.consumed_cents`
   (`20260803090200_101`, comentário da coluna): "acima de `reserved_cents` é
   overage observável (incidente), nunca franquia adicional".
2. **`planNextCall` trata como rotina.** `_shared/ai-budget-core.ts`: quando
   `remaining` é negativo, o plano é `EXTEND` com `additionalCents` cobrindo o
   déficit **e** a próxima chamada — deliberadamente **sem** clamp a zero, porque
   clampar autorizaria uma chamada sem cobertura. Financeiramente **correto**: o
   teto do CICLO segue íntegro (a extensão só acontece se o ciclo comportar).
3. **A §17.5 da spec pede um terceiro comportamento**: liquidar integral,
   **bloquear** as chamadas posteriores do turno, **registrar incidente** e
   **alertar o platform_admin**. **Nenhuma das três existe.**

**A consequência prática de não decidir:** nada, em log nenhum, distingue um
turno que estourou a própria reserva de um turno que simplesmente cresceu — as
duas coisas aparecem como uma extensão bem-sucedida. Quem for ler o consumo da
fase de observação para calibrar o teto vai ler os dois como a mesma coisa.

**Quem decide:** engenharia + produto, junto com a seção 15. Se a decisão for
manter o comportamento de hoje, **o comentário da 101 é que precisa mudar** —
ele afirma "incidente" sobre algo que o código trata como rotina.
