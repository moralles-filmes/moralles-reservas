# Arquitetura

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao criar módulo, refatorar, criar caso de uso com mutação crítica, fila/job ou nova dependência.
> Níveis: [N1] base · [N2] operação crítica · [N3] escala (ver AGENTS.md §5).

## 1. Modelo padrão [N1]

Use **monólito modular com Ports & Adapters**.

Microserviço só entra com evidência de necessidade:

- escala independente medida;
- isolamento de falha exigido;
- cadência de deploy distinta.

A decisão vai num ADR. Dividir cedo multiplica deploy, observabilidade, transações distribuídas e custo, sem ganho para um SaaS deste porte.

## 2. Fluxo de execução não é direção de dependência [N1]

O fluxo em tempo de execução é:

```text
Interface (página, route handler, server action, tool MCP)
  → Caso de uso (application)
    → Domínio (regras puras)
    → Porta (interface definida pela aplicação/domínio)
      → Adapter (implementação: Supabase, provedor, fila, storage)
```

A direção dos **imports** aponta para dentro:

- **Domínio** não importa framework, banco, `supabase-js`, `Deno.env`, SDK de provedor nem cloud.
- **Casos de uso** importam domínio e portas. Nunca importam adapters concretos.
- **Adapters** implementam portas e são os únicos que importam SDKs.
- **Interface** chama casos de uso e não contém regra crítica.
- A ligação porta → adapter acontece num ponto de composição (factory/container simples), não espalhada pelo código.

Por quê: isso permite trocar Supabase por Cloud SQL, ou Z-API por Meta, mudando adapters, sem reescrever regra de negócio.

### Onde fica o servidor

O runtime é declarado no AGENTS.md §2 e no `framework` do tenancy-profile.

| Runtime | Interface de servidor | Casos de uso críticos rodam em |
|---|---|---|
| **Next.js (App Router)** | route handlers, server actions | Node, no próprio app; atomicidade em RPC quando há vários passos |
| **Vite (SPA)** | não há servidor próprio | Edge Functions (Deno) ou RPC Postgres (modelo B de DATABASE §4) |

Em SPA Vite, o browser fala com o Supabase direto para leituras e escritas simples protegidas por RLS, **sempre através do adapter do módulo** (`src/features/<modulo>/api.ts`). Componentes e hooks de tela chamam o adapter: não importam o cliente Supabase nem chamam `.from()`/`.rpc()` direto. Essa fronteira é o que permite trocar o Supabase por uma API própria mudando só o adapter, sem servidor novo antes da hora (GCP_MIGRATION §6). Toda mutação crítica, chamada a provedor e uso de segredo vai para Edge Function ou RPC. Domínio compartilhado entre Node e Deno fica em código sem dependência de runtime, importado pelos dois (import map no Deno).

## 3. Aplicação proporcional [N1]

A profundidade das fronteiras acompanha a complexidade do módulo.

- **CRUD simples sem regra crítica:** route handler → caso de uso → adapter basta.
- **Módulos com dinheiro, estoque, permissões, mensagens ou integrações:** estrutura completa.

Não crie camadas vazias só para "seguir o padrão". Também não coloque regra crítica em componente, hook de tela ou policy duplicada sem caso de uso.

Estrutura de referência para Next.js (adapte à stack real; reutilize o padrão existente):

```text
src/modules/<modulo>/
  domain/         entidades, value objects, regras puras
  application/    commands/, queries/, portas
  adapters/       supabase/, providers/
  presentation/   componentes e handlers específicos do módulo
  tests/
```

Variante Vite (SPA + Edge Functions):

```text
src/features/<modulo>/          páginas, componentes, hooks e api.ts (adapter: único arquivo do módulo que fala com o Supabase)
src/lib/supabase/               único createClient do browser
supabase/functions/<modulo>-*/  casos de uso com efeito: validam JWT, tenant e permissão
supabase/functions/_shared/     domínio e portas sem dependência de runtime, adapters Deno
supabase/migrations/            tabelas, policies, RPCs
```

## 4. Módulos [N1]

Um módulo complexo define:

- responsabilidade;
- invariantes;
- commands e queries;
- permissões;
- eventos;
- integrações;
- tabelas que possui;
- limites.

Esse conteúdo vai em `docs/modules/<modulo>.md` (modelo em `docs/modules/_TEMPLATE.md`). Criação, alteração e remoção de módulo seguem MODULES.md; submódulos e ações viram chaves de permissão (ACCESS_CONTROL §2).

- Um módulo não lê nem escreve tabela interna de outro sem contrato explícito (função, view ou caso de uso exposto).
- Não duplique helpers ou padrões que já existem no projeto.

## 5. Commands — mutações críticas [N1]

Mutações críticas incluem financeiro, estoque, aprovações, cancelamentos, estornos, permissões, importações, envios, ações de IA e tools MCP de escrita. Elas seguem esta ordem, com a **fronteira transacional explícita**.

**Antes da transação:**

1. Autenticar.
2. Resolver o tenant pela sessão e verificar membership ativa.
3. Autorizar a ação: `can(ctx, '<modulo>.<submodulo>.<acao>', locationId)` (ACCESS_CONTROL §4).
4. Validar a **estrutura** do input com schema em runtime.

**Dentro da mesma transação:**

5. Garantir as invariantes que dependem do estado persistido (saldo, estoque, status, limite) com constraint, escrita condicional, lock, versão ou isolamento adequado. Ler, validar e depois gravar em passos separados **não** protege contra duas requisições simultâneas.
6. Registrar a chave de idempotência.
7. Aplicar a mutação.
8. Gravar a auditoria transacional.
9. Gravar o evento na outbox, quando houver efeito externo ou evento para outro módulo.

**Depois do commit:**

10. Publicar, chamar o provedor ou enfileirar.
11. Retornar o contrato tipado.

Exemplo de invariante garantida na própria escrita:

```sql
update public.products
   set stock = stock - $1
 where id = $2
   and company_id = $3
   and stock >= $1
returning stock;
-- 0 linhas = estoque insuficiente ou produto de outro tenant → conflito, nada foi alterado
```

No Supabase, o `supabase-js` não abre transação entre chamadas. Operação de vários passos que precisa ser atômica vira **função Postgres (RPC)** chamada pelo servidor (exemplo em DATABASE §4).

## 6. Queries [N1]

Toda query define:

- tenant e autorização;
- projeção explícita (sem `select *` em tabela grande);
- filtros;
- ordenação estável (com desempate por id);
- paginação (cursor em conjuntos grandes);
- limite máximo;
- política de cache;
- campos sensíveis excluídos.

Lista, dashboard e exportação têm queries próprias. Uma consulta gigante reaproveitada para os três degrada todos.

## 7. Filas, jobs e trabalho assíncrono

**[N1]** Use processamento assíncrono para:

- operação lenta;
- chamada a provedor com efeito externo;
- importação ou exportação;
- envio em massa;
- IA;
- reconciliação;
- geração de documento;
- mídia.

**[N1]** O runner canônico do projeto é declarado no AGENTS.md §3. Não invente um mecanismo diferente por feature.

**[N1]** Em serverless (Vercel), `after()`/`waitUntil` continuam o trabalho depois da resposta, mas **não são duráveis**: se a função cair, o trabalho some sem retry. Use-os só para trabalho descartável (métrica, log). Trabalho que não pode se perder vai para uma tabela ou fila persistente com consumidor. Opções em ordem de simplicidade:

1. Tabela (outbox/jobs) + pg_cron ou Vercel Cron acionando um endpoint/Edge Function consumidor.
2. Supabase Queues (pgmq).
3. Cloud Tasks / Pub/Sub, após migração para GCP.

**[N1]** Todo job tem:

- id;
- `company_id`;
- tipo;
- payload versionado;
- chave de idempotência;
- status;
- tentativas;
- agendamento;
- timeout;
- backoff.

**[N2]** Também tem lease/lock, dead-letter, auditoria e cancelamento quando aplicável.

**[N2]** Consumidores concorrentes pegam trabalho com `select … for update skip locked` (ou o equivalente da fila), para dois workers não processarem o mesmo item.

**[N1]** O job revalida tenant e permissão no momento da execução. Ele não confia que o estado do momento do enfileiramento continua válido.

**[N1]** "Entrou na fila" não é "concluído". O status só muda para concluído após processamento confirmado.

**[N1]** Estado compartilhado entre execuções (rate limit, lock, circuit breaker, contador) fica no Postgres. Memória de função serverless não sobrevive entre invocações. Redis/Memorystore só com necessidade medida e ADR.

## 8. Eventos internos [N2]

Eventos têm nome com versão (`estoque.baixado.v1`), owner, payload versionado e consumidores idempotentes. A entrega é no mínimo uma vez, e duplicata é o caso normal.

## 9. Erros [N1]

Classifique os erros:

```text
ValidationError · AuthenticationError · AuthorizationError · ConflictError · NotFoundError
RateLimitError · ExternalProviderError · TransientError · UnknownOutcomeError · InternalError
```

- Proibido `catch {}` silencioso.
- O erro é tratado ou propagado com contexto, observado no log com redaction e apresentado ao usuário sem revelar implementação, SQL ou segredo.

## 10. TypeScript e contratos [N1]

- `strict` ligado; sem `any` novo; sem cast para silenciar erro.
- Input externo (body, query, headers, resposta de provedor, webhook, tool input) é validado em runtime com a biblioteca de schema do projeto. Os tipos derivam do schema. Type assertion não valida nada.
- O typecheck é o **comando oficial do projeto** (AGENTS.md §7). Não invente outro.
- Exceção a qualquer regra desta seção exige comentário com motivo, risco, escopo e plano de remoção.

## 11. Dependências [N1]

Antes de adicionar uma dependência, avalie:

- necessidade real e alternativa nativa;
- manutenção e licença;
- CVEs;
- tamanho e árvore de dependências;
- compatibilidade.

Não atualize todas as dependências dentro de uma tarefa não relacionada.

## 12. ADR [N1]

Registre em `docs/adr/ADR-NNNN-<decisao>.md` decisões que um agente futuro poderia desfazer por não conhecer o motivo:

- troca de padrão;
- exceção a este documento;
- escolha de runner;
- uso de Redis;
- microserviço;
- provedor.

Formato: contexto, decisão, alternativas consideradas, consequências.

## Particularidades deste projeto

- Runtime: Vite SPA (React 18, React Router 7, modo declarativo) na Vercel; servidor = Supabase Edge Functions (Deno) + RPCs `SECURITY DEFINER`. Não há Next.js nem route handlers.
- Não existe `src/modules/` nem adapter por módulo (`src/features/<m>/api.ts`). O acesso ao Supabase no frontend está espalhado em `src/hooks/`, `src/pages/`, `src/contexts/` e `src/lib/`; é dívida registrada em `.claude/portabilidade-baseline.json` (§3 deste padrão), reduzida módulo a módulo quando o módulo já for alterado.
- No servidor, a lógica compartilhada fica em `supabase/functions/_shared/`, com núcleos puros `*-core.ts` testados em Vitest; cada EF é um bundle próprio (redeploy das consumidoras ao mudar `_shared`, ver `.claude/rules/edge-functions.md`).
- Trabalho assíncrono durável: outbox/filas em tabelas Postgres + `pg_cron` → `pg_net` → Edge Function worker autenticada por `x-internal-key` (`.claude/rules/edge-functions.md`).
- Regras por assunto: `.claude/rules/*.md` (tabela no AGENTS.md §2).
