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

**Aplicar a 098 sem deployar `manage-whatsapp-implementations` deixa a EF
projetando três slugs que acabaram de sair da vitrine**: `priceOf` devolve
`null` nos três, `summarizeMonthlyCosts` colapsa em zero e o lojista lê
"R$ 0,00" onde deveria ler R$ 449,90. `prices_unavailable` **não** cobre esse
caso (a leitura não falhou; ela devolveu linhas inativas). Deployar junto.

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
  Plano D. [migration 097](../../supabase/migrations/20260803120000_097_billing_plan_ai_sale_guard.sql).
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
- **`flags.subscription_checkout` continua no payload da EF sem consumidor no
  frontend** depois da Task 6. Mantida no contrato de propósito — removê-la é
  mudança de payload que o Plano C/D deve decidir junto com o resto do fluxo.

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

---

## Ordem de aplicação (quando autorizada — fora deste plano)

1. `supabase db push` — **094, 095, 097, 098** nesta ordem, antes de qualquer deploy.
2. `supabase functions deploy manage-whatsapp-implementations`.
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
