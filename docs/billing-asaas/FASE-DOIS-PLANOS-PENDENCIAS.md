# Pendências do Plano A — não declaráveis por teste unitário

Modelo comercial de dois planos, Plano A (modelo de dados + entitlement).
Ambiente sem Docker. **Nenhuma migration aplicada, nenhuma Edge Function
deployada, nenhuma flag alterada.** Tudo abaixo é o que a suíte verde NÃO prova.

**Gates desta entrega (execução real):**

| Gate | Resultado |
|---|---|
| `npm run test` | 767 testes, 32 arquivos — todos passando |
| `npm run typecheck` (`tsc -b --noEmit`) | zero erros |
| `npm run lint` | 0 erros, 22 warnings (baseline pré-existente, nenhum em arquivo desta entrega) |
| `npx eslint supabase/functions --max-warnings=0` | zero |

---

## 1. Limite de conexões — `STATICALLY_GUARDED` / `DATABASE_CONCURRENCY_PENDING`

O núcleo `whatsapp-connection-allowance-core.ts` decide corretamente sobre
fatos corretos, e os dois pontos de entrada o chamam. **Isso é guarda
estática.** Duas chamadas concorrentes que leiam a mesma contagem de
instâncias ativas ainda podem criar duas conexões.

**Enquanto não houver prova contra banco real de que duas operações
concorrentes não criam duas instâncias:**

- não declarar o limite financeiramente seguro;
- não habilitar o Plano Automação para novas contratações;
- não permitir que o Plano B transforme o produto em oferta ativa;
- manter o checkout/ativação do Plano 2 bloqueado.

Invariante a satisfazer: **a autorização e a criação da instância precisam ser
serializadas contra o mesmo allowance.** Mecanismo em aberto — RPC
transacional, lock de linha, advisory lock ou constraint compatível.

**Não criar índice único que hardcode uma conexão por organização:** o modelo
de dados precisa suportar limites maiores (plano CUSTOM).

---

## 2. Descobertas da execução — riscos e decisões em aberto

Não estavam no plano; apareceram implementando. Cada uma com defeito,
consequência e **quem decide**.

### 2.1 O worker de enforcement pode suspender a assinatura de SISTEMA

**Defeito:** `process-whatsapp-enforcement` escreve `status='unpaid'` na
assinatura que `resolveWhatsAppSubscription` apontar como fonte.

**Consequência:** hoje essa fonte é sempre a legada `WHATSAPP_SUBSCRIPTION`,
porque nenhum plano tem `included_features` preenchido (a 094 dá `'{}'` a todas
as linhas e os seeds são do Plano B). **No dia em que existir um Plano 2
vendido, a fonte passa a ser a assinatura de SISTEMA** — e suspendê-la alcança
o sistema inteiro, não só o WhatsApp. Inadimplência da automação derrubaria as
reservas.

**Inalcançável hoje.** Já há nota no cabeçalho do worker
(`process-whatsapp-enforcement/index.ts`, seção "ESCOPO DA SUSPENSÃO").

**Quem decide:** Plano B/C, **antes de vender o Plano 2**. Não é decisão de
implementação — é escolher se inadimplência da automação suspende só a
automação (assinatura de sistema segue ativa, entitlement `whatsapp` negado por
outro caminho) ou se esse produto simplesmente não é suspensível por este
worker.

### 2.2 `BATCH_LIMIT = 200` mudou de semântica

**Defeito:** o filtro `billing_plans.category` saiu da query de
`process-whatsapp-enforcement` (devolvia zero linha para uma organização do
Plano 2, que paga o pacote dentro da mensalidade). O teto de 200 agora conta
**todas** as assinaturas não canceladas, não só as de categoria WhatsApp.

**Consequência, dupla:**
1. linhas irrelevantes consomem orçamento do lote;
2. uma organização cujas assinaturas caiam **nos dois lados do corte** chega ao
   núcleo **incompleta** — ele resolveria uma transição sem enxergar que ela é
   transição, e escolheria a fonte errada.

Inócuo hoje (base pequena, muito abaixo de 200) e o
`whatsapp_enforcement_subs_capped` já avisa quando o teto é atingido — mas
atingir o teto **deixou de ser só "sobrou pra amanhã"**.

**Quem decide:** ninguém precisa decidir nada comercialmente. É trabalho de
engenharia: **paginação por organização** (não por linha) antes de a base
crescer. Enquanto o log de cap não aparecer, não é urgente.

### 2.3 `CANCELLATION_REQUESTED` produz `INVALID_INPUT` a cada passada

**Defeito:** `listCycleInstances`/`listEconomicInstances` varrem `ACTIVE`
**e** `CANCELLATION_REQUESTED` (`ACTIVE_STATES` em
`process-whatsapp-instance-cycles/index.ts`), mas `resolveRevenueForOrg` conta
só `lifecycle_state = 'ACTIVE'`.

**Consequência:** uma organização cuja única instância está em
`CANCELLATION_REQUESTED` produz `activeInstanceCount = 0` →
`{ kind: "INVALID_INPUT", reasonCode: "NO_ACTIVE_INSTANCE" }` no núcleo de
receita, **a cada execução do worker**, enquanto durar o estado. Não é dado
corrompido nem escrita errada, mas é ruído recorrente numa união discriminada
que existe justamente para separar "receita ausente" de "entrada inválida".

O allowance conta de outro jeito de propósito (`lifecycle_state <> 'ENDED'`,
porque a instância custa até a confirmação de encerramento). **Decidir se
`CANCELLATION_REQUESTED` conta como instância ativa para fins de RECEITA é
decisão comercial**, não de código: a instância ainda custa, e a assinatura
ainda paga — ou não.

**Quem decide:** comercial, **antes do primeiro cancelamento real**. O
downgrade do Plano C é exatamente o que produz esse estado em massa.

### 2.4 `provider_instance_ref` virou efetivamente obrigatório em `register_instance`

**Defeito:** o campo era opcional. Sua ausência agora leva
`providerInstanceRefKnown = false` numa operação fixa `BACKFILL_EXISTING`, o
que produz `BACKFILL_WITHOUT_PROVIDER_REF` → **409**.

**Consequência:** é a semântica congelada em teste na Task 11 — *"backfill
disfarçado é rejeitado"*: registrar uma instância sem a referência da instância
real no provedor é provisionamento novo entrando por outra porta, sem passar
pelo teto. A mudança é deliberada, não acidental.

Não há caller no frontend hoje (`grep register_instance src/` = zero). **A UI
da Fase 6c precisa nascer exigindo o campo** — não como validação opcional
"melhor preencher", mas como campo obrigatório do formulário, senão o admin vai
descobrir pelo 409.

**Quem decide:** já decidido. É requisito de UI para a 6c.

### 2.5 Adapter duplicado nas duas portas do allowance

**Defeito:** `manage-whatsapp-instances` e `manage-channels` têm **cada um a
sua cópia** da query de `billing_subscriptions` + da normalização que alimenta
`resolveWhatsAppSubscription`.

**Consequência — e o limite dela:** a **decisão** é compartilhada (os dois
chamam os mesmos núcleos puros, `whatsapp-subscription-resolver-core.ts` e
`whatsapp-connection-allowance-core.ts`). O que ficou duplicado é **I/O**:
seleção de colunas, `.neq("status","canceled")`, achatamento do
`billing_plans!inner`, correlação plano↔assinatura por chave. Divergir uma
cópia não muda a política, mas pode alimentar o núcleo com fatos diferentes nas
duas portas.

Está coberto por guardrail textual
(`src/lib/whatsapp-connection-allowance-guard.test.ts`, que verifica nas duas
portas: chama o núcleo, deriva pelo resolvedor compartilhado, não usa
`maybeSingle` em `billing_subscriptions`, não reimplementa `STATUS_RANK`,
correlaciona por chave, conta por `<> 'ENDED'`).

**Recomendação:** extrair o adapter para `_shared/` no **Plano B**, com a linha
correspondente no checklist de redeploy do CLAUDE.md. Não foi feito agora
porque as duas EFs não compartilham nenhum arquivo além dos núcleos, e mover
I/O é mudança de superfície de deploy — trabalho do plano que já vai tocar as
duas.

**Quem decide:** engenharia, no Plano B.

### 2.6 Em `manage-channels` o allowance roda em TODO `create`

**Não é defeito — é decisão, registrada para não ser "corrigida" depois.**

O allowance roda em todo `create`, **não só quando a unidade tem zero canais**,
porque o teto é por **organização**: escopá-lo ao primeiro canal da unidade o
tornaria contornável criando um canal em cada unidade da mesma rede (duas
unidades com um canal cada são duas conexões).

O gate de sete estados (`resolveWhatsAppGateByUnit`) **continua onde estava** e
responde outra pergunta ("o serviço está ativo?"). O allowance foi **somado** a
ele ("o contrato inclui mais uma conexão?"), nunca em substituição.

### 2.7 Mudança de comportamento herdada do resolvedor compartilhado

A query antiga de receita filtrava `status = 'active'`. O resolvedor aceita
`active | trialing | past_due` (`FUNDING_STATUSES`).

**Consequência:** uma assinatura de WhatsApp em `trialing`/`past_due` agora
produz receita onde antes produzia `NO_ENTITLEMENT` — e, portanto, onde antes
gerava alerta de desequilíbrio econômico.

**É o ponto de compartilhar o resolvedor**, não um efeito colateral: gate de
envio, worker de enforcement e worker de ciclos passam a **concordar** sobre
quem financia o WhatsApp. Discordar sobre isso era o defeito que este trabalho
existe para matar.

---

## 3. Depende de banco real

- **Migrations 094 e 095 nunca aplicadas.** Idempotência e o `drop/add` do
  CHECK de `revenue_source` verificados **só por leitura**.
- **CHECK `included_features` nunca exercitado contra INSERT real** —
  vocabulário fechado (`<@ array['system','whatsapp','ai']`) + `array_position`
  contra NULL dentro do array. É o **teste 2 da spec** e continua não provado.
- **Duplicidade de valores dentro de `included_features` não é proibida pelo
  banco.** `array['system','system']` passa no CHECK. A normalização é
  responsabilidade do seed e do fluxo administrativo de edição (Plano B), não
  do banco — está dito no `comment on column`.
- A concorrência do limite de conexões (seção 1) é o item mais grave desta
  categoria.

## 4. Depende de deploy

Gate e enforcement compartilham o resolvedor **no código**. Que rodem com a
**mesma versão em memória** depende do redeploy das **18 consumidoras de
`whatsapp-service-gate.ts`** (lista no checklist de redeploy do CLAUDE.md),
mais `process-whatsapp-enforcement`, `process-whatsapp-instance-cycles`,
`manage-whatsapp-instances` e `manage-channels`, que importam o resolvedor
diretamente.

Edge Functions não compartilham bundle em runtime. **Redeploy parcial aqui
reintroduz exatamente a divergência que o guardrail estático prova não existir
no código.**

Ordem quando autorizado (fora deste plano): `db push` de 094/095 **antes** de
qualquer deploy → EFs que leem `included_features` via `entitlements.ts` → as
18 do gate + as 4 diretas → `process-whatsapp-instance-cycles` → conferir
`acl-estatico` na aba Checks.

## 5. Mudanças deliberadas de comportamento (não são regressão)

- **Plano com `included_features` não vazio NÃO herda IA de `system`.** A
  declaração explícita substitui a herança implícita.
- **Trial NÃO concede IA.** Passa a negar explicitamente.

Ambas seguras hoje: `entitlements_enforced` está **OFF** e não existe carteira
— nenhum caminho de produção consome `ai.allowed`. Cada uma tem teste próprio,
não um teste genérico de compatibilidade.

## 6. Fora do escopo deste plano

Seeds e catálogo (**Plano B**). Fluxos comerciais — checkout, upgrade,
downgrade (**Plano C**). IA e carteira (**Plano D**).

---

## 7. Gate comercial

**`PLAN_AUTOMACAO_CHECKOUT = NO-GO`** até o Plano D estar entregue e provado
contra banco real, incluindo a concorrência do orçamento e a deste documento
(seção 1).

Flags permanecem OFF. Nenhum plano publicado. Ren Sushi segue vitalício e
grátis — override LIFETIME em `system`, `whatsapp` e `ai` intacto.
