# Pendências da Fase 6c — não declaráveis por teste unitário

Painel de instâncias completo + ledger de observações + runbook. Repo ligado
à produção. **Nada aplicado no Supabase, nenhuma Edge Function deployada,
nenhuma flag alterada, nenhum merge, nenhum push.**

A migration 096 **foi aplicada verbatim num Postgres 18.4 local e descartável**
(`scoop`, sem Docker, `127.0.0.1:55432`, sem `pg_cron`/`pg_net`) — o venue que a
spec §11 prescreve e o mesmo que validou a 089 real
([FASE-6B-ROLLOUT-2026-08-02.md §1](FASE-6B-ROLLOUT-2026-08-02.md)). Banco local
não é Supabase e não é produção; os casos `NOTE-A..NOTE-D` rodaram lá, 19/19,
com dois controles positivos. Ver §2.

**Gates desta entrega (execução real, 2026-08-03):**

| Gate | Resultado |
|---|---|
| `npm run test` | 806 testes, 34 arquivos — todos passando |
| `npm run typecheck` (`tsc -b --noEmit`) | zero erros |
| `npm run lint` | 0 erros, 22 warnings (baseline pré-existente, nenhum novo em arquivo desta entrega) |
| `npx eslint supabase/functions --max-warnings=0` | zero erros, zero warnings |
| `npm run build` | concluiu (`✓ built in 8.51s`); único aviso é o de chunk >500 kB, pré-existente |

Os cinco gates rodaram nesta sessão, na raiz do worktree `fase-6c`, e foram
**reexecutados depois da onda de correção** do review whole-branch — os números
acima são os de depois. Nenhum gate falhou em nenhuma das duas passadas.

A onda de correção mudou código: o review encontrou duas conversões
reais→centavos inline sobreviventes no painel (`set_cost` e simulação de
parceiro), que liam `99.90` como R$ 9.990,00 — erro de 100× num campo que
alimenta `gross_margin_cents` e o alerta `ECONOMIC_IMBALANCE`. As duas passaram
a usar `parseCostReais`, e os dois testes novos (806 − 804) cobrem os casos que
a §7 tinha deixado descobertos.

---

## 1. CLAUDE.md a consolidar

**Esta frente NÃO editou `CLAUDE.md`** — três frentes (6c, Plano B, Plano D)
tocam o mesmo arquivo e a consolidação é um commit único no fim, fora deste
trabalho. O que entra, quando chegar a hora:

### 1.1 Checklist de redeploy — linha nova

```
- **`whatsapp-instance-notes-core.ts`** (núcleo puro, testado em
  [src/lib/whatsapp-instance-notes-core.test.ts](src/lib/whatsapp-instance-notes-core.test.ts))
  → `manage-whatsapp-instances` (único consumidor de runtime). Carrega o
  vocabulário das sete ações do ledger; o mesmo teste verifica, nas duas
  direções, que ele e o CHECK da migration 096 não divergiram. O FRONTEND
  também importa daqui (`src/lib/whatsapp-instance-format.ts`, rótulos PT-BR)
  — cross-boundary deliberado, mesmo motivo do `whatsapp-implementation-core.ts`.
```

Conferido contra o código real (não só contra o rascunho do brief): o único
import de runtime é `supabase/functions/manage-whatsapp-instances/index.ts:51`
(`import type { InstanceNoteAction } from "../_shared/whatsapp-instance-notes-core.ts"`),
e o único import de frontend é `src/lib/whatsapp-instance-format.ts:3`
(`import { INSTANCE_NOTE_ACTIONS } from "../../supabase/functions/_shared/whatsapp-instance-notes-core"`).
A linha do rascunho do brief nomeava os consumidores certos — não precisou de
correção.

### 1.2 Invariantes novos

```
- **`whatsapp_instances` NÃO usa o trigger genérico `audit_trigger_func()` —
  o histórico vive em `whatsapp_instance_notes`.** `audit_log` tem a policy
  `unit_member_read_audit`, que libera leitura para membro da organização;
  auditar a instância ali entregaria `current_monthly_cost_cents` (o que a
  plataforma paga ao fornecedor) para os membros do próprio cliente — exatamente
  o que o FORCE RLS da tabela existe para impedir.
  [migration 096](supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql).

- **`whatsapp_instance_notes` é `FORCE RLS` COM policy `platform_admin_all_*`,
  não sem policies.** "FORCE RLS sem policies" é o padrão das tabelas de
  CREDENCIAL; este é um ledger irmão de `whatsapp_instance_cycles`/`_alerts` e
  segue o padrão delas (087/088/089).

- **O ledger de observações é escrito DEPOIS da mutação e é best-effort.**
  `notes` continua sendo o resumo ("última observação") e a tabela nova é o
  histórico; as duas saem do mesmo `reason`, na mesma operação. Falha do insert
  não derruba operação já concluída — devolver erro depois do efeito faria o
  operador repetir uma ação já feita. A divergência entre as duas é detectável
  pela telemetria `wa_instance_note_write_failed` com `needsAdminAction`.
  [manage-whatsapp-instances/index.ts](supabase/functions/manage-whatsapp-instances/index.ts).

- **A EF decide o que gravar em `update_instance` por `"campo" in body`** —
  mandar uma chave significa *escreva isto, inclusive `null`*. Formulário que
  envie o objeto inteiro APAGA o canal de quem só quis corrigir o identificador.
  O corpo sai de `buildUpdatePatch`, função pura testada.
  [src/lib/whatsapp-instance-form-core.ts](src/lib/whatsapp-instance-form-core.ts).

- **A trigger `whatsapp_instance_note_guard()` (096) é deliberadamente MAIS
  ESTRITA que a trigger irmã `whatsapp_alert_subject_guard()` (089) na guarda
  de `instance_id`.** A 089 usa `<>` puro
  (`old.instance_id is not null and new.instance_id is not null and
  new.instance_id <> old.instance_id`), que só barra `uuid → outro uuid` e
  DEIXA PASSAR `NULL → uuid` — um alerta/observação já órfão pode ser reatado
  a uma instância viva da mesma organização, porque a guarda de tenant só
  confere a organização, não a ausência de vínculo anterior. A 096 usa
  `is distinct from`, que barra as DUAS direções (`uuid → outro uuid` E
  `NULL → uuid`). Achado da revisão da Task 1 desta fase, adjudicado pelo dono
  do projeto: apertar a 096, não afrouxar; não tocar na 089 nesta fase
  (reescrever uma migration já aplicada exige análise de impacto e migration
  própria, fora do escopo); registrar que a 089 TEM esse defeito latente e que
  a correção futura APERTA a 089 para igualar a 096, nunca afrouxa a 096 para
  igualar a 089. Verificado só estaticamente (leitura do texto SQL + simulação
  da fórmula em JS) — ver §2 abaixo e o caso `NOTE-C` estendido em
  [supabase/tests/whatsapp-instances.integration.md](supabase/tests/whatsapp-instances.integration.md).
```

### 1.3 Tabela de workers — sem mudança

Nenhum worker novo, nenhum cron novo, nenhuma flag nova.

---

## 2. Casos NOTE-A..NOTE-D — EXECUTADOS. NOTE-E segue pendente

`NOTE-A` a `NOTE-D` **rodaram contra Postgres real** em 2026-08-03, no venue
que a spec §11 prescreve: PostgreSQL 18.4 local (`scoop`, sem Docker,
`127.0.0.1:55432`, sem `pg_cron`/`pg_net`), o mesmo onde a 089 real rodou
verbatim na 6b ([FASE-6B-ROLLOUT-2026-08-02.md §1](FASE-6B-ROLLOUT-2026-08-02.md)).

```
19 casos · 19 PASS · 0 FAIL
```

**A 096 foi aplicada verbatim**, não transcrita, sobre 087 e 088 também
verbatim, com um bootstrap mínimo do que elas referenciam. Harness completo e
instruções em
[supabase/tests/local-preflight/](../../supabase/tests/local-preflight/README.md)
— a 6b fez este mesmo trabalho e não deixou nada commitado; a 6c teve de
reconstruir o ambiente do zero.

**Nada disso tocou Supabase nem produção.** Banco local descartável, apagado ao
fim.

| Caso | O que provou |
|---|---|
| **NOTE-A** | Migration aplicada **três vezes**; a contagem do backfill fica em 1. Instância com `notes` nulo e instância com `notes` só de espaços continuam de fora (`btrim`). |
| **NOTE-B** | `DELETE` da instância **conclui**; a observação sobrevive com `instance_id` nulo e `instance_ref` intacto. |
| **NOTE-C 1-3** | `note`, `action` e `instance_ref` recusam `UPDATE` — append-only. |
| **NOTE-C 4-7** | As quatro transições de `instance_id`: inalterado **aceito**, `uuid → NULL` **aceito**, `uuid → outro uuid` **recusado**, `NULL → uuid` **recusado**. A divergência deliberada contra a 089 deixou de ser afirmação estática. |
| **NOTE-D 1-4** | INSERT com `instance_id` nulo, com `instance_ref <> instance_id`, com organização alheia (guarda de tenant da 088) e com `note` em branco — os quatro recusados. |
| **NOTE-D5** | Controle negativo: o INSERT **legítimo** passa. Sem ele, "tudo foi recusado" não distinguiria rigor de tabela quebrada. |

### Os dois controles positivos

Sem eles, "passou" não distingue *a guarda funciona* de *o teste não testa nada*.

- **CONTROLE-1 — o defeito F-01 foi REPRODUZIDO.** Reintroduzido o CHECK
  `instance_id is not null` (a forma da 089), o `DELETE` da instância **aborta**
  com `check_violation`. Removido o CHECK, **o mesmo `DELETE` conclui**. É a
  prova de que o conflito FK × CHECK que a 089 pagou não voltou nesta tabela —
  e de que o NOTE-B não passou por acidente.
- **CONTROLE-2 — o defeito latente da 089 foi DEMONSTRADO.** Trocada a condição
  de `instance_id` pela da 089 (`<>` puro), a transição `NULL → uuid`
  **passa**. Reaplicada a 096, o mesmo `UPDATE` volta a ser recusado. A
  afirmação do bloco "DIVERGÊNCIA DELIBERADA" da 096 — e a decisão de apertar a
  089 no futuro em vez de afrouxar a 096 — deixou de ser leitura de código.

### O que continua pendente

- ~~**`NOTE-E` (RLS pelo client SDK).**~~ **EXECUTADO e APROVADO em produção
  (07/08/2026).** Sessão real de `gerente` (não `platform_admin`), chamada
  direta ao PostgREST com a anon key do bundle e o JWT da sessão. As três
  tabelas responderam **HTTP 200 com lista vazia** — que é o resultado certo:
  a policy é `is_platform_admin(auth.uid())` sob FORCE RLS, e RLS filtra
  LINHA, não recusa a chamada. A afirmação "membro da organização não lê o
  custo do fornecedor" está provada.
- ~~**A 096 não foi aplicada em produção.**~~ Aplicada em 04/08/2026 junto com
  as outras nove pendentes.
- ~~**Nenhum registro de sucesso foi feito pela UI.**~~ Feito em 07/08 — e o
  caminho de sucesso revelou o achado da seção 2.1 abaixo.

### 2.1 Achado do primeiro registro de sucesso pela UI — backfill sob cortesia vitalícia não tem teto

Um `register_instance` com intent `BACKFILL_EXISTING` criou uma **segunda
instância ativa** para a mesma unidade do Ren Sushi, com referência de
fornecedor inventada (`13218dasdsa88dsa`). **Não é defeito de código** —
`checkConnectionAllowance` fez exatamente o que a regra 4 manda: para
`fundingSource: LIFETIME_OVERRIDE`, backfill é `OVERRIDE_OPERATIONAL` e
passa. O `activeInstanceCount` **só é consultado no ramo `PLAN_DECLARED`**
(regra 6); no ramo do vitalício ele nunca entra na conta.

O que falhou foi a **premissa**, não a regra. O desenho assume "registrar o
que já existe nunca piora a posição", e `providerInstanceRefKnown` significa
apenas *o admin preencheu o campo* — nunca *a instância existe no
fornecedor*. Sem a API de Parceiro da Z-API (Fase 6a), não há como verificar,
e o diálogo já diz isso ("este registro é a afirmação da plataforma sobre o
que existe lá").

**Consequência real:** organização com cortesia vitalícia aceita backfill
ilimitado, e cada linha nova entra no inventário como custo de fornecedor —
contaminando margem e alertas do worker de ciclos.

**Correção sugerida, sem mexer na regra:** avisar na UI quando a unidade
escolhida já tem instância `lifecycle_state <> 'ENDED'`, exigindo confirmação
explícita. Bloquear backfill seria errado — backfill legítimo de segunda
instância existe. A verificação de existência real é trabalho da Fase 6a.

A linha de teste foi apagada em produção no mesmo dia. **A exclusão confirmou
o NOTE-B ao vivo:** o `DELETE` concluiu, o ciclo caiu por `CASCADE` e as duas
observações sobreviveram com `instance_id` nulo e `instance_ref` intacto.

## 3. Depende de deploy

- `manage-whatsapp-instances` precisa ser redeployada para o helper e a action
  `list_instance_notes` existirem. **Enquanto não for, a seção Histórico do
  painel devolve erro** — e o branch `isError` está implementado exatamente para
  esse estado (mostra "Não foi possível carregar o histórico" com botão de
  retry, nunca painel em branco).
- **Ordem quando autorizado:** `supabase db push` da 096 → `supabase functions
  deploy manage-whatsapp-instances` → frontend (push em `main` → Vercel),
  **depois** do merge da 6b → conferir `acl-estatico` na aba Checks.
- Se a EF subir antes da migration, o insert do ledger falha, é logado com
  `needsAdminAction` e a operação principal continua correta — mas a ordem acima
  evita o buraco.
- **Nenhum arquivo de `_shared/` existente mudou**, então o checklist de
  redeploy cruzado não é afetado. O arquivo `_shared/` **novo**
  (`whatsapp-instance-notes-core.ts`) tem um consumidor só.

## 4. Riscos que permanecem (spec §12)

1. **Registrar instância que não existe na Z-API.** O inventário passa a mentir
   sobre custo. Mitigado pelo identificador obrigatório e pelo motivo
   registrado; **não eliminado.**
2. **Disciplina humana.** O fluxo inteiro depende de alguém olhar o painel.
   Mitigado pela cadência do runbook (toda segunda + entre D-7 e D-1);
   **não eliminado.** É a razão de existir da 6a.
3. **`notes` e o ledger podem divergir** se o insert best-effort falhar.
   Escolha consciente: o alternativo é derrubar uma operação já concluída.
4. **Os seis avisos `admin_zapi_*` continuam sem virar e-mail.** Pendência
   `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`, herdada da 6b. O painel é o único
   canal.
5. **A guarda mais estrita da 096 tem uma irmã mais permissiva (089) que
   continua em produção.** Não é um risco desta tabela — é um risco herdado,
   registrado aqui porque foi descoberto nesta fase. Ver §1.2 e §2.

## 5. Fora do escopo desta fase

- `NEW_PROVISION` — bloqueado por
  `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A`.
- `AWAITING_PROVISION` — a fila já vive em `whatsapp_implementations`.
- Qualquer chamada à Z-API.
- Flag nova, decisão comercial, mudança no worker ou nos núcleos de decisão.
- **Reescrever a 089 para igualar o rigor da 096.** Decidido explicitamente
  como fora de escopo pelo dono do projeto (§1.2) — não esquecido.
- A concorrência do teto de conexões
  (`FASE-DOIS-PLANOS-PENDENCIAS.md` §1) — continua em aberto e continua
  bloqueando o Plano Automação para novas contratações.

## 6. Verificação manual executada

Nenhuma tela desta fase foi verificada em navegador. O ambiente de execução
não tem ferramenta de automação de navegador disponível (sem Playwright,
Puppeteer, MCP de browser ou equivalente) nem GUI para operar um navegador
manualmente, e chamar a Edge Function de produção como substituto foi
proibido nesta entrega — vários casos (registro repetido, alterar vínculo)
tocariam a instância real do Ren Sushi em produção. As Tasks 5, 6, 7 e 8
tentaram subir `npm run dev` com sucesso (log limpo, sem erro de compilação)
e registraram, cada uma, que a interação com a UI renderizada não é possível
sem essa ferramenta. Nenhuma linha abaixo foi observada — todas são
`não executado`, nunca `OK`/`✓`/`esperado`.

**Os quatro roteiros somam 20 casos** (Task 5: 3, Task 6: 8, Task 7: 6,
Task 8: 3 — contagem conferida linha a linha contra o texto de cada brief,
não só contra os relatórios). A tabela abaixo lista os 20, agrupados por
tarefa de origem, para que nenhum fique implícito como "fora do roteiro".

### Task 5 — hooks, navegação e nome da organização (3 casos)

| Caso | Resultado |
|---|---|
| Menu lateral mostra "Instâncias WhatsApp" e o link navega para `/platform/instancias-whatsapp` | não executado — sem ferramenta de navegador no ambiente |
| Card da instância mostra o nome da organização (Ren Sushi), não o UUID | não executado — sem ferramenta de navegador no ambiente |
| Colapsar a sidebar e reabrir em largura mobile (`<lg`): a gaveta abre e o item novo aparece | não executado — sem ferramenta de navegador no ambiente |

### Task 6 — Tela A, registrar instância (8 casos)

| Caso | Resultado |
|---|---|
| URL colada no identificador → 400 `REF_LOOKS_LIKE_URL` com toast sobre o token | não executado — sem ferramenta de navegador no ambiente |
| Identificador vazio → botão Registrar desabilitado, sem viagem ao servidor | não executado — sem ferramenta de navegador no ambiente |
| Unidade não escolhida → botão Registrar desabilitado | não executado — sem ferramenta de navegador no ambiente |
| Custo `abc` → recusa na UI, procedência desabilitada, botão não submete | não executado — sem ferramenta de navegador no ambiente |
| Custo `99.90` → aceito, sem confundir com 9990 reais | não executado — sem ferramenta de navegador no ambiente |
| Registro repetido da mesma instância (ref do Ren Sushi) → 409, nenhuma linha nova | não executado — sem ferramenta de navegador no ambiente, e chamada direta à EF de produção como substituto foi explicitamente proibida |
| Card do alerta `DIVERGENCE`/`CHANNEL_WITHOUT_INSTANCE` → diálogo abre com a unidade da organização do alerta já filtrada | não executado — sem ferramenta de navegador no ambiente (também depende de haver um alerta desse tipo aberto no momento) |
| Mobile (`<640px`) → diálogo vira bottom-sheet, inputs com altura de toque, safe-area no rodapé | não executado — sem ferramenta de navegador no ambiente |

### Task 7 — Telas B e C, corrigir vínculo e reativar (6 casos)

| Caso | Resultado |
|---|---|
| Alterar só o identificador do Ren Sushi → o corpo da requisição NÃO contém `channel_id` nem `unit_id` | não executado — sem ferramenta de navegador no ambiente, e proibido contra produção até 05/08 por regra do próprio brief |
| Nada alterado → "Salvar correção" desabilitado, aviso "Sem mudança não há requisição" | não executado — sem ferramenta de navegador no ambiente |
| Canal esvaziado ("Sem canal") → botão habilita, o patch conteria `channel_id: null` | não executado — sem ferramenta de navegador no ambiente |
| Instância `ENDED` → botão Reativar ausente no card | não executado — sem ferramenta de navegador no ambiente |
| Instância `CANCELLATION_REQUESTED` → botão Reativar presente; abrir e fechar sem submeter | não executado — sem ferramenta de navegador no ambiente |
| Mobile (`<640px`) → os dois diálogos viram bottom-sheet, inputs com altura de toque | não executado — sem ferramenta de navegador no ambiente |

### Task 8 — seção Histórico (3 casos)

| Caso | Resultado |
|---|---|
| Expandir a instância do Ren Sushi → aparecem as duas subseções, "Ciclos e margem" e "Histórico" | não executado — sem ferramenta de navegador no ambiente |
| Histórico antes da 096 → branch `isError` com botão "Tentar de novo", não painel em branco | não executado — sem ferramenta de navegador no ambiente; migration 096 também não aplicada, então este caso nem tem estado de banco para observar |
| O rótulo do campo de motivo, nos cinco diálogos compartilhados, diz "fica registrado no histórico" | não executado — sem ferramenta de navegador no ambiente |

## 7. Minors adiados — para triagem do review whole-branch

Achados de severidade "minor" que os revisores de cada task decidiram
adiar em vez de corrigir na hora. Nenhum bloqueou a task correspondente.
Listados aqui para que o review final da branch decida, um a um, o que
precisa ser corrigido antes do merge — um roll-up que ninguém lê é descarte
silencioso.

| Task | Achado | Por que foi adiado |
|---|---|---|
| 2 | `parseCostReais` sem caso de teste para separador misto (`"12.34,56"`) nem para valor com espaço em volta (`" 99,90 "`) | os dois se comportam certo no trace manual do revisor — falta só cobertura, não correção de comportamento |
| 2 | Cabeçalho de `whatsapp-instance-form-core.ts` cita a conversão inline antiga do painel, que não está neste diff | prosa explicativa desatualizada, sem dependência funcional |
| 4 | `list_instance_notes` não tem `.limit()`/paginação — lista sem teto | volume realista é pequeno (ação manual de admin, não fluxo de cliente); registrado para não crescer sem controle |
| 6 | `submit()` não re-checa `reasonTooShort` como re-checa `selectedUnit` e `parsed.ok` | inalcançável hoje — o botão já fica desabilitado nesse estado |
| 6 | `parseCostReais` chamado duas vezes com a mesma entrada (render e submit) | função pura da mesma variável — não podem discordar |
| 7 | Sem opção "Sem unidade" no `Select` de unidade da Tela B (o de canal tem "Sem canal") | consistente com o desenho do plano — instância que chega à Tela B já está vinculada a uma unidade |
| 7 | "Cancelar" não desabilita durante submissão em voo; abrir o diálogo em outra instância com mutation pendente faz o `onSuccess` antigo fechar o diálogo novo e mostrar toast desencontrado | desencontro de UI/toast — a escrita em si acerta a instância certa, nenhum dado é gravado no lugar errado |
| 7 | Opção de unidade mostra "organização · unidade" mesmo com tudo já filtrado por uma única organização | redundância visual, sem efeito funcional |

### 7.1 Triagem do review whole-branch

O review triou os oito, um a um. **Sete seguem**; um foi reclassificado:

- **Reclassificado e corrigido** — o cabeçalho de `whatsapp-instance-form-core.ts`
  não era "prosa desatualizada". A conversão inline que ele descreve no pretérito
  estava **viva** em duas linhas do painel, com erro de 100×. Virou achado
  *Important* e foi corrigido na onda (ver o bloco de gates no topo). O primeiro
  minor da Task 2 (cobertura de `"12.34,56"` e `" 99,90 "`) foi fechado junto,
  porque os dois casos deixaram de ser hipotéticos.
- **Seguem sem correção** os outros seis, pelas razões já registradas acima; o
  revisor reverificou cada uma contra o código em vez de aceitar a justificativa.

O review anotou ainda dois minors que ele mesmo encontrou e que **não foram
corrigidos**, por decisão explícita:

| Achado | Por que fica |
|---|---|
| `RegisterInstanceDialog.tsx` — o efeito de prefill pode sobrepor a escolha do operador se `channelsQuery.data` mudar de referência (refetch) depois de ele escolher "Sem canal por enquanto" | probabilidade baixíssima: `refetchOnWindowFocus` é `false` global e o diálogo não muta canais. Um `useRef` de "prefill já aplicado" fecha, quando o arquivo for tocado de novo |
| `WhatsappInstances.tsx` — a data do alerta (`first_detected_at`) é calculada em UTC, o mesmo defeito que o histórico teve | é código da **6b**, não desta entrega. Corrigir aqui misturaria escopo; entra na próxima vez que a 6b for tocada |

## 8. Gate

**`FASE_6C_MERGE = aguardando`** — a branch `dois-planos/fase-6c` não é
mergeada até que a observação da 6b feche e a `billing-asaas/fase-6b` entre em
`main`. As outras duas condições estão cumpridas: `NOTE-A..NOTE-D` rodaram
contra banco (§2, 19/19 com dois controles positivos) e o review whole-branch
triou os minors da §7 (§7.1), com a onda de correção já aplicada.

**O push e o PR estão retidos de propósito, por motivo técnico.** O
`acl-estatico` só dispara em `pull_request` com base `main`
([.github/workflows/function-acl-audit.yml](../../.github/workflows/function-acl-audit.yml)).
PR contra `billing-asaas/fase-6b` **não roda o guardrail** — e a 096 cria tabela
com FORCE RLS, duas triggers e uma função nova em `public`, que é exatamente o
diff que precisa passar por ele. A ordem certa é a 6b entrar em `main` primeiro
e as três frentes abrirem PR contra `main` juntas, cada uma com o check rodando
de verdade.

Continua pendente para o merge: `NOTE-E` (RLS pelo client SDK, exige Supabase) e
os 20 casos de verificação manual de painel da §6.

Ren Sushi segue vitalício e grátis — override LIFETIME em `system`, `whatsapp` e
`ai` intacto. Nada nesta fase o toca.
