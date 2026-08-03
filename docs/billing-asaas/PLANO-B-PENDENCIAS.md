# Pendências do Plano B — catálogo comercial de dois planos

Modelo comercial de dois planos, Plano B (catálogo, vitrine e superfícies
cliente-facing). Ambiente sem Docker. **Nenhuma migration aplicada, nenhuma
Edge Function deployada, nenhuma flag alterada, nenhum merge.** Tudo abaixo é o
que a suíte verde NÃO prova.

Predecessor: [FASE-DOIS-PLANOS-PENDENCIAS.md](FASE-DOIS-PLANOS-PENDENCIAS.md)
(Plano A) — as pendências de lá continuam abertas, em especial a concorrência
do limite de conexões.

---

## 1. Gate comercial — inalterado

**`PLAN_AUTOMACAO_CHECKOUT = NO-GO`.** O Plano B libera a venda do **Plano 1
apenas**. O Plano Automação fica visível, preparado, **não contratável e não
ativável** até o Plano D entregar e provar o teto de R$ 100 por ciclo contra
banco real.

O Plano B **endureceu** esse gate em vez de só respeitá-lo: a migration 097 cria
o CHECK `billing_plans_ai_plan_not_sellable_chk`, que impede
`active = true` em qualquer plano que declare `ai` em `included_features` —
painel, Edge Function e `UPDATE` manual, todos recusados pelo banco.

**Dropar esse constraint é a última ação do Plano D**, depois do teto provado.

## 2. ADMIN_PLAN_CONTRACT_FIELDS_AUDITED_WRITE

Escrita administrativa auditada de `included_features`,
`included_whatsapp_connections` e `whatsapp_component_cents`. **Não entregue no
Plano B por decisão explícita** — exigiria `manage-billing`, que é de outra
frente.

**Estado atual:** `BillingPlans.tsx` exibe os três campos como **somente
leitura**, com aviso de que são contratuais; a alteração é feita por migration
controlada; `manage-billing` não aceita essas colunas em
`PLAN_WRITABLE_COLUMNS`, então o painel não tem como gravá-las nem por engano.

**Antes de liberar edição, TODOS os itens abaixo:**

- inclusão explícita dos campos em `PLAN_WRITABLE_COLUMNS`;
- validação server-side;
- vocabulário fechado de `included_features`;
- `whatsapp_component_cents` entre zero e `amount_cents`;
- `included_whatsapp_connections` não negativo;
- autorização exclusiva de `platform_admin`;
- trilha de auditoria com before/after;
- identificação do administrador;
- timestamp;
- rejeição de alterações silenciosas;
- testes;
- revisão de segurança.

**Até essa entrega:** edição somente por migration controlada; interface
read-only; nenhuma alteração contratual pelo textarea de marketing; nenhuma
edição direta não auditada.

Isso **não** bloqueia a preparação do catálogo. Continua bloqueando: edição
administrativa desses campos, contratação do Plano 2 e ativação do Plano 2.

**Consequência oposta, nomeada aqui porque é a mesma pendência:** `manage-billing`
não aceitar `included_features` em `PLAN_WRITABLE_COLUMNS` não é só proteção —
também significa que **todo plano novo criado em `/platform/planos` nasce com
`included_features = '{}'`**. Array vazio é o sinal de "plano legado" para
`resolveOrgEntitlements`, e o ramo legado de
`supabase/functions/_shared/entitlements-core.ts` (por volta das linhas
216-219) faz `ai` **herdar** de `system` nesse caso. Na prática: um
`platform_admin` cria um `SYSTEM_SUBSCRIPTION` qualquer pelo painel, marca
"Ativo", e o plano fica contratável **e concede `ai`** — sem passar pelo CHECK
da 097 (que só barra plano que *declara* `'ai'` em `included_features`; um
plano recém-criado não declara nada) e sem o teto financeiro do Plano D.

Isto **não** é furo para o `plano-automacao`: as cinco camadas de defesa da
seção 1 seguram aquele slug especificamente, e ele nasce com
`included_features` explícito pela 098. E é financeiramente inerte hoje,
porque a chave de IA é BYOK por unidade (`ai_provider_credentials`), a
plataforma não paga o consumo, e não existe cliente pagante. Mas é o mesmo
buraco que a escrita auditada desta seção fecha: enquanto
`ADMIN_PLAN_CONTRACT_FIELDS_AUDITED_WRITE` não existir, todo plano novo criado
pelo painel nasce legado e herda IA por omissão, não por decisão.

## 3. Depende de banco real

- **Migrations 097 e 098 nunca aplicadas.** Idempotência, o `do $$` de
  `pg_constraint`, o `on conflict (slug) do nothing`, os `is distinct from` da
  auto-correção e as duas `raise exception` da pós-condição foram verificados
  **só por leitura**.
- **O CHECK da 097 nunca foi exercitado contra um `UPDATE` real.** Que
  `update billing_plans set active = true where slug = 'plano-automacao'` falhe
  com 23514 é a afirmação central do gate comercial e **não está provada**. É o
  primeiro comando a rodar depois do `db push` (está no rodapé da 098).
- **A pós-condição do PART 5 da 098 nunca abortou nem passou de verdade.** Se
  algum plano estiver ativo em produção fora do previsto, o `db push` **falha** —
  por desenho, mas é uma falha que só aparece na aplicação.
- **O CHECK `included_features` da 094 (teste 2 da spec) continua não provado** —
  herdado do Plano A.

## 4. Depende de deploy

Ordem obrigatória quando autorizado (fora deste plano):

1. `supabase db push` — **094, 095 (Plano A), 097, 098**, nesta ordem. A 097
   depende da coluna da 094; a 098 depende das duas.
2. Deploy de `manage-whatsapp-implementations` — lê os slugs novos.
3. Frontend (Vercel, automático no merge).
4. Conferir `acl-estatico` na aba Checks.

**A janela entre 2 e 3 é assimétrica de propósito.** Frontend novo com EF antiga:
`costs.automationPlanMonthlyCents` chega `undefined` e o bloco informativo
simplesmente não renderiza — degradação silenciosa e segura, mesma convenção de
`serviceState`. Frontend antigo com EF nova: o card antigo procura
`instancia-whatsapp` em `useBillingPlans()`, não acha (inativo pela 098), e cai
no `"—"` e no botão desabilitado que ele já tratava. **Nenhuma das duas ordens
afirma preço errado** — mas a ordem acima é a que evita o card antigo.

**O risco real está na ordem oposta: deployar a EF nova antes de aplicar a
098.** A EF nova consulta `plano-reservas` e `plano-automacao` pelo slug — mas,
sem a 098 aplicada, essas duas linhas ainda não existem no catálogo.
`priceOf` devolve `null` para as duas, `summarizeMonthlyCosts` colapsa em
zero e o lojista lê "R$ 0,00" onde deveria ler R$ 449,90 (`plano-reservas`) ou
R$ 799,90 (`plano-automacao`). `prices_unavailable` **não** cobre esse caso — a
leitura não falhou; ela devolveu um catálogo que ainda não tem o produto. É
esse mecanismo, e não o inverso, que torna a ordem prescrita acima (migration
**antes** do deploy da EF) obrigatória: aplicar a 098 primeiro garante que as
duas linhas já existem quando a EF nova entrar em produção.

*(Fix round 1: a versão anterior deste parágrafo descrevia o mecanismo
invertido — chegou a citar `sistema-reservas`/`instancia-whatsapp` como se
`priceOf` devolvesse `null` para eles após a 098. Isso é falso: a EF **antiga**
não filtra por `active` na query de catálogo — comentário explícito no código
documenta a omissão —, então essas linhas continuam sendo lidas normalmente
mesmo com `active = false`; a 098 só desliga a coluna `active`, nunca apaga
linha nem altera `amount_cents`. E dos "três slugs" originais, só dois saem da
vitrine pela 098 — `implementacao-whatsapp` permanece `active = true` por
desenho da própria migration (PART 4). Corrigido após revisão.)*

## 5. CLAUDE.md a consolidar

*(Consolidação é commit único no fim, fora deste chat — as três frentes editam o
mesmo arquivo.)*

**Checklist de redeploy — linha existente que muda de razão:**

- `whatsapp-implementation-core.ts` → `create-billing-checkout`,
  `manage-whatsapp-implementations`. A linha já existe. O que mudou: o contrato
  de `MonthlyCostInput`/`MonthlyCostSummary` foi **alterado de forma
  incompatível** (`instanceMonthlyCents` virou `legacyInstanceMonthlyCents`,
  entrou `automationMonthlyCents`, saiu do resumo o eco antigo). Redeploy
  parcial não quebra em runtime (cada EF carrega o `_shared/` do próprio
  bundle), mas o payload divergente é o que a seção 4 acima descreve.

**Invariantes novos, propostos para o corpo do CLAUDE.md:**

- **Plano que declara `ai` em `included_features` não pode ficar `active`** —
  CHECK `billing_plans_ai_plan_not_sellable_chk`. `PLAN_AUTOMACAO_CHECKOUT =
  NO-GO` é estrutural, não configuração; dropar o constraint é a última ação do
  Plano D. [migration 097](../../supabase/migrations/20260803120200_097_billing_plan_ai_sale_guard.sql).
- **`isSelectableSystemPlan` filtra `active` — e isso não é redundante com o
  servidor.** `manage-billing` action `list_plans` devolve `select("*")` sem
  filtro de `active` para `platform_admin`; sem o filtro no cliente, o admin vê
  produtos retirados da vitrine com botão de contratar na tela do lojista.
  [billing-plan-display.ts](../../src/lib/billing-plan-display.ts).
- **A mensalidade de contrato legado de WhatsApp vem do join da própria
  assinatura, nunca de lookup por slug no catálogo.** O preço de tabela pode ter
  mudado depois da contratação, e o lookup reintroduziria a dependência de
  `instancia-whatsapp` numa superfície de oferta (§A6.2).
  [manage-whatsapp-implementations](../../supabase/functions/manage-whatsapp-implementations/index.ts).
- **Superfície comercial nova entra no `SCOPE` do guardrail e é classificada.**
  `src/lib/commercial-surface-guard.test.ts` reprova arquivo não classificado
  dentro do escopo — é o que impede o guardrail de apodrecer. Migrations,
  testes e comentários ficam fora **por construção**.
- **`billing_plans.amount_cents` é `NOT NULL` no schema** (migration
  `20260528000000_billing_module.sql`), e o gate de custo do lojista lê a
  mensalidade legada por join `!inner` na assinatura da própria organização.
  Por isso "assinatura legada sem valor conhecido" é inalcançável na prática, e
  o `?? null` nesse caminho é defesa, não tratamento de caso real.
- **O guardrail de superfícies comerciais tem um limite conhecido:**
  `discover()` ignora em silêncio um caminho do `SCOPE` que deixe de existir. Só
  a podridão do manifesto `SURFACES` é testada, não a do `SCOPE`. Hoje os dez
  caminhos existem.

## 6. Limites conhecidos do guardrail (§A6.2)

- **É textual e baseado em linha.** Um slug retirado num comentário no fim de
  uma linha de código (`const x = 1; // instancia-whatsapp`) não é descartado —
  comportamento deliberado, porque a linha é código.
- **Não segue indireção.** Um slug montado por concatenação
  (`"instancia-" + "whatsapp"`) passa. Análise estática de texto é o que resta:
  os `index.ts` das EFs importam `deno.land`/`esm.sh` e chamam `serve()` no
  carregamento, então vitest não consegue importá-los.
- **Cobre os caminhos declarados no `SCOPE`, não o repositório.** Uma superfície
  comercial criada fora dele não é varrida — por isso acrescentar caminho ao
  `SCOPE` faz parte de criar superfície nova, e a asserção de "manifesto podre"
  obriga o `SCOPE` a acompanhar remoções.

## 7. Residuais de produto, não de código

- **Assinatura viva num plano que saiu da vitrine perde o card "Plano atual".**
  `PricingTable` só renderiza planos ofertáveis; uma org assinante de
  `sistema-reservas` não veria o próprio plano na grade. **Inócuo hoje** — não
  existe cliente pagante; Ren Sushi é vitalício sem assinatura. Vira problema
  real no dia da primeira venda seguida de troca de catálogo, e é trabalho do
  **Plano C** (upgrade/downgrade), que já vai mexer nessa tela.
- **Nenhuma assinatura foi migrada de `sistema-reservas` para `plano-reservas`.**
  Deliberado: não há o que migrar, e migrar assinatura é fluxo do Plano C.
- **A lista de benefícios do Plano Automação está hardcoded em
  `AutomacaoWhatsappCard.tsx` (`PlanoAutomacaoInfo`, por volta das linhas
  259-265), duplicando o jsonb `features` semeado pela migration 098** para o
  plano `plano-automacao`. `features` **é** gravável por `manage-billing`
  (`PLAN_WRITABLE_COLUMNS`) — um `platform_admin` editando a copy comercial
  pelo painel faria o card do lojista divergir em silêncio, porque o payload
  de `get_service_status` (`manage-whatsapp-implementations`) ecoa só o preço
  (`costs.automationPlanMonthlyCents`), nunca a lista de features. **Não
  corrigido agora:** fazer o card ler `features` exigiria ampliar esse payload
  para carregar a copy do plano, o que é escopo novo nesta altura — e o
  produto ainda não é contratável (`PLAN_AUTOMACAO_CHECKOUT = NO-GO`), então a
  divergência não tem cliente pagante para enganar hoje. Corrigir junto do
  Plano D, quando o bloco vira oferta de verdade.
- **`flags.subscription_checkout` continua no payload da EF sem consumidor no
  frontend** depois da Task 6. Mantida no contrato de propósito — removê-la é
  mudança de payload que o Plano C/D deve decidir junto com o resto do fluxo.
  **Mesmo caso, mesmo motivo:** `system_allowed` (`src/types/billing.ts`, por
  volta da linha 506) existia só para gatear o botão "Contratar instância" que
  saiu do card nesta branch, e perdeu o único consumidor no mesmo commit.
  Mantido no contrato de propósito pela mesma razão — remoção é decisão do
  Plano C/D junto com o resto do fluxo.

## 8. Fora do escopo deste plano

Entitlement e resolvedor (**Plano A**, concluído). Upgrade, downgrade e
cancelamento (**Plano C**, depende da Fase 6c). Preços versionados, ledger,
reserva, `beforeCall` e hard stop de IA (**Plano D** — é ele que destrava o
Plano 2).

## 9. Isolamento de worktree e colisão de branch

Durante a execução, as frentes do Plano B e do Plano D estavam compartilhando o
mesmo diretório de trabalho e o mesmo HEAD do git. A frente do Plano D executou
`git checkout -b dois-planos/plano-d` entre turnos do Plano B, e os quatro
primeiros commits do Plano B caíram em `dois-planos/plano-d`. Nada foi perdido.

**Correção aplicada:** `dois-planos/plano-b` foi movido para o commit correto e
esta frente passou a rodar no worktree isolado `.claude/worktrees/plano-b`.

**Pendência aberta para a frente do Plano D:** `dois-planos/plano-d` continua
apontando para os commits do Plano B e precisa ser resetado por quem é dono
dela — não foi tocado por esta frente.

**Lição registrada:** branch compartilhando diretório de trabalho não é
isolamento; worktree é.

## 10. GATE DA ATIVAÇÃO — `billing_plans` expõe coluna a qualquer autenticado

**Não bloqueia o Plano B. Bloqueia a ativação do `plano-automacao`.**

`billing_plans` tem policy de leitura direta para `authenticated`, e ela é cega
a coluna:

```sql
-- 20260528000000_billing_module.sql:107-109
create policy "authenticated_read_active_plans" on billing_plans
  for select to authenticated
  using (active = true);
```

Nenhuma migration faz `revoke` de coluna em `billing_plans`. É a lição da 086
aplicada a outra tabela: **policy filtra LINHA e é cega a COLUNA.** Qualquer
usuário autenticado — inclusive um `operador` de qualquer unidade — faz
`select("*")` em `billing_plans` pelo PostgREST com a anon key do bundle e
recebe **todas as colunas de todo plano ativo**. `PLAN_PUBLIC_COLUMNS` não
participa desse caminho: ele só protege a porta do `manage-billing`.

**O que o Plano B expõe hoje, e por que é aceitável.** As linhas que ele semeia
e deixa ativas publicam `included_features = {system}` e
`included_whatsapp_connections = 0` — isso é descrição de produto, não segredo.
O valor que importaria, `whatsapp_component_cents = 35000`, está no
`plano-automacao`, que nasce `active = false` e é escondido pelo
`using (active = true)`.

**Mas está protegido por acidente, e o acidente vence exatamente quando o
Plano D abre o portão.** No instante em que a constraint da 097 cair e alguém
ativar o `plano-automacao`, o rateio interno de R$ 350,00 passa a ser legível
por qualquer autenticado, sem Edge Function no meio — junto com
`provider_metadata` e os `stripe_price_id_*` legados, que já estavam expostos
para os planos ativos antes desta branch.

**A correção é barata porque a policy não tem consumidor.** `grep` por
`.from("billing_plans")` em `src/` não encontra nenhuma leitura direta: tudo
passa por `list_plans`, e Edge Function usa `service_role`, que ignora RLS.
Duas saídas, ambas válidas:

- derrubar a policy `authenticated_read_active_plans`; ou
- `revoke select (whatsapp_component_cents, included_features,
  included_whatsapp_connections, provider_metadata, stripe_price_id_*)` no
  padrão da 086.

**O lugar certo é a mesma migration que ativar o `plano-automacao`** — para a
correção viajar acoplada ao risco, em vez de depender de alguém lembrar.

---

## 11. Colisão de timestamp com a 6c — resolvida renumerando o Plano B

`dois-planos/fase-6c` criou `20260803120000_096_whatsapp_instance_notes.sql` com
**exatamente o mesmo prefixo de 14 dígitos** que a 097 original deste plano. O
Supabase CLI deriva a `version` desse prefixo e `schema_migrations.version` é
chave primária: não eram "096 e 097", eram duas migrations disputando a versão
`20260803120000`. Invisível enquanto as branches vivem separadas; aparece no
primeiro `db push` depois do merge, como drift.

Único prefixo duplicado nos cinco branches (`main`, `fase-6b`, `fase-6c`,
`plano-b`, `plano-d`). **O Plano B renumerou; a 6c não se mexeu:**

| antes | depois |
|---|---|
| `20260803120000_097_billing_plan_ai_sale_guard.sql` | `20260803120200_097_…` |
| `20260803120100_098_two_plan_commercial_catalog.sql` | `20260803120300_098_…` |

Duas razões, nenhuma de precedência:

1. **Ordem numérica tem que casar com ordem de timestamp.** A 6c é a 096, número
   menor. Se ela recuasse, a 096 aplicaria depois da 097/098 — exatamente a
   inversão que se quer evitar. O Plano B indo para frente resolve nas duas
   dimensões.
2. **Custo assimétrico e mensurável.** A 6c tem o nome do arquivo hardcoded em
   `src/lib/whatsapp-instance-notes-core.test.ts:24` mais quatro docs — mexer ali
   é alterar teste de frente já fechada. O Plano B só tinha referência em
   documento.

**O Plano D não precisa renumerar.** Suas cinco migrations (099–103) estão
carimbadas às 09h e aplicariam antes das 096–098 das 12h — inversão numérica
real, mas **cosmética**: nenhuma das cinco cita `billing_plans`,
`included_features`, `whatsapp_component_cents` nem qualquer slug deste catálogo.
Sem dependência quebrada, não se mexe.

### O que o Plano D herda desta renumeração

1. **A migration que derruba o CHECK da 097 precisa de timestamp maior que
   `20260803120300`** — não mais que `120000`. A margem ficou mais apertada e o
   modo de falha é silencioso: `drop constraint if exists` aplicado antes de a
   constraint existir é **no-op**, o portão parece aberto, o `plano-automacao`
   segue invendável e ninguém descobre até a primeira tentativa de venda.
2. **O número dela não é 099.** 099 a 103 já são do Plano D — é **104** ou o
   próximo livre na hora da entrega.

Ambos estão escritos no header da própria 097, para viajarem com o arquivo em
vez de dependerem deste documento.

---

## 12. Achados dos gates de segurança — o que ficou fora de escopo

`migration-validator`: PASS com atenções (0 bloqueante). `identity-access-auditor`:
PASS (0 bloqueante). O que **foi corrigido** nesta branch: gate do botão
"Reativar" + discriminação do `23514` por nome de constraint; asserção de
`provider`/`billing_type`/`interval` no PART 5 da 098; texto do rollback das duas
migrations. O que **fica registrado sem ação**:

- **`coalesce(active, false)` no CHECK da 097** — cosmético: `active` é `NOT NULL`
  (`20260528000000_billing_module.sql:93`), o `coalesce` não mudaria nada. **A
  parte útil do achado é outra e vale registro: o CHECK da 097 depende do
  `billing_plans_included_features_chk` da 094 continuar vivo.** A 097 sozinha
  não fecha o caso "elemento NULL dentro do array" — `'ai' = any(array['system',
  null])` avalia UNKNOWN e o CHECK **aceita** UNKNOWN. Quem proíbe o elemento
  nulo é `array_position(included_features, null) is null`, na 094. Dropar o
  CHECK da 094 reabre o portão da 097 em silêncio.
- **Diagnóstico cru em dois abortos da 098** (`plano-automacao` pré-existente já
  ativo; `plano-reservas` com outra categoria e assinatura viva, barrado pelo
  trigger da 074). Fail-closed corretos, só a mensagem é feia. Pré-condições
  praticamente impossíveis hoje.
- **Comentário impreciso** em `manage-whatsapp-implementations/index.ts:608-612`:
  justifica o join dizendo que "o preço de tabela pode ter mudado depois da
  contratação", mas o join lê o `amount_cents` **atual** do catálogo mesmo assim.
  `billing_subscriptions` não guarda valor, então a escolha é forçada e não há
  alternativa — só a justificativa escrita está errada. Sem consequência.
- **As duas atenções de autorização do `identity-access-auditor`** são as §10 e
  §2 deste documento, alcançadas de forma independente. Que ele tenha fixado a
  mesma ordem — **fechar antes de ativar** — é confirmação, não item novo.

---

## Ordem de aplicação (quando autorizada — fora deste plano)

0. **Snapshot de leitura ANTES do push** — decide se o PART 5 da 098 vai abortar
   e se o `ADD CONSTRAINT` da 097 valida, além de ser a única forma de o rollback
   saber quais `AI_CREDIT_PACKAGE` ele tocou:
   `select slug, category, active, provider, billing_type, "interval", included_features from billing_plans order by active desc, category, slug;`
1. `supabase db push` — **094, 095, 097, 098** nesta ordem, antes de qualquer deploy.
2. `supabase functions deploy manage-whatsapp-implementations` **e**
   `supabase functions deploy manage-billing` (o `planWriteError` passou a
   discriminar o `23514` por nome de constraint; sem o redeploy, ligar o switch
   do Plano Automação continua devolvendo a frase errada sobre categoria).
3. Merge para `main` → Vercel publica o frontend.
4. Rodar a validação pós-migration do rodapé da 098, **incluindo** a prova de que o CHECK da 097 recusa a ativação do Plano Automação.
5. Conferir `acl-estatico` na aba Checks.

Flags permanecem OFF. `PLAN_AUTOMACAO_CHECKOUT` permanece **NO-GO**.

---

## Auto-revisão

**Cobertura do lote comercial do §24:** os oito itens estão mapeados na tabela do topo, cada um com a task que o entrega. Os itens 1–3 e 8 na Task 2; o 3 também na Task 3 (a parte de frontend, que a coluna `active` sozinha não resolve); o 4 na Task 5; o 5 e o 6 na Task 6; o 7 preservado explicitamente em 2, 4, 5 e 6.

**Testes nomeados da spec cobertos:** **9** (slugs novos não colidem — o `on conflict (slug) do nothing` da 098 e a asserção de pós-condição), **10** (superfícies de contratação nova não ofertam `instancia-whatsapp` — Task 4, com controles positivo e negativo), **11** (produto legado continua consultável para histórico — o guardrail permite `HISTORICAL` e não toca em migration, teste ou comentário; a 098 não apaga nada).

**Testes que este plano NÃO pode declarar provados:** o **teste 2** (CHECK de `included_features`) e a prova de que o CHECK da 097 recusa a ativação dependem de banco real — registrados na seção 3 das pendências, não silenciosamente ausentes.

**Consistência de tipos:** as três colunas contratuais são tipadas na **Task 3, Step 1** — antes dos helpers que as leem (`planIncludedFeatures`/`planBlockedFromSale`, via `Pick<BillingPlan, "included_features">`) e antes da Task 7, que só as consome e confirma por `grep`. `automationMonthlyCents` (entrada do núcleo, Task 5) → `automationPlanMonthlyCents` (saída do núcleo e do payload, Task 5) → prop `monthlyCents` de `PlanoAutomacaoInfo` (Task 6). `legacyInstanceMonthlyCents` (Task 5) é preenchido pelo `planOf(instanceSub)?.amount_cents` do mesmo passo.

**Nomes distintos de propósito:** `automationMonthlyCents` (input, "preço do catálogo") e `automationPlanMonthlyCents` (output, "eco para a UI decidir se renderiza") — se um dia colapsarem num nome só, o eco vira campo mudo e a UI perde o sinal de ausência.

**Sem placeholders:** todo passo de código traz o código; todo passo de execução traz comando e resultado esperado. As duas exceções conscientes são a variável do plano em edição na Task 7 Step 3 (nome real a confirmar por leitura, com a instrução do que fazer nos dois casos possíveis) e o ajuste dos testes pré-existentes na Task 5 Step 1 (renomeação mecânica de campo, sem afrouxar asserção).
