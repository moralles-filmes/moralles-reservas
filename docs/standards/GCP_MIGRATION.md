# Portabilidade e migração para Google Cloud

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia em tarefas de infraestrutura, Docker, workers dedicados ou quando uma decisão possa prender o projeto ao Supabase/Vercel.

## 1. Princípio

Não migre antecipadamente. Preserve a **possibilidade** de migrar sem reescrever domínio e casos de uso, e verifique essa possibilidade com critérios objetivos (§6), não só como intenção.

Portabilidade é obrigatória desde o primeiro módulo; a migração de infraestrutura só acontece com gatilho objetivo (custo, limite medido, contrato ou compliance). Este padrão não pode ser marcado como "não adotado".

```text
Vercel + Supabase  →  Cloud Run + Supabase  →  Cloud Run + Cloud SQL
```

## 2. Matriz de dependências [N1]

Mantenha em "Particularidades" uma tabela **só com as capacidades que o projeto usa**:

| Capacidade usada | O que precisa estar definido |
|---|---|
| Postgres e extensões | Extensões em uso; compatibilidade com o destino (Cloud SQL tem lista própria de extensões suportadas); procedimento de migração |
| Identidade e RLS | Policies e helpers chamam `private.current_user_id()`, nunca `auth.uid()` direto; FKs de usuário apontam para `public.app_users`. Só o adapter de identidade conhece o provedor: `00_identidade_supabase.sql` hoje; no destino, `00_identidade_postgres.sql`, em que a API abre a transação, faz `set local role authenticated` e `set_config('app.user_id', …, true)` (ACCESS_CONTROL §9) |
| Supabase Auth | Mapeamento de ids de usuário; plano para Identity Platform ou manutenção do Supabase Auth |
| API de dados (PostgREST/RPC) | Quais contratos o cliente usa diretamente; qual adapter ou serviço os atenderá |
| Storage | Objetos, paths, referências no banco e policies de acesso; destino (Cloud Storage) |
| Filas e cron (pgmq, pg_cron) | Execução, retries, recuperação e limites no destino (Cloud Tasks, Cloud Scheduler, Pub/Sub) |
| Realtime | Contrato mantido para o cliente e a alternativa no destino |
| Edge Functions (Deno) | Código portável para Node/Cloud Run; uso de APIs específicas do runtime |

## 3. Backend pronto para container [N1, quando houver backend dedicado ou worker]

- Processo stateless.
- Escuta em `0.0.0.0` na porta definida por `PORT`.
- Dockerfile versionado, com imagem base fixada.
- Configuração validada no boot, com erro claro se faltar variável.
- Health checks de liveness e readiness separados.
- Graceful shutdown: termina requisições em andamento e devolve trabalho não concluído à fila.
- Sem filesystem persistente. Logs estruturados no stdout.
- Timeouts e concorrência configuráveis.
- Pool de conexões limitado.
- Migrations fora do startup.
- Artefato imutável promovido entre ambientes.

## 4. Orçamento agregado de conexões [N2]

O limite do banco é dividido entre **todos** os consumidores ao mesmo tempo:

```text
(instâncias máx. da API × pool por instância)
+ (instâncias de workers × pool)
+ jobs/cron concorrentes
+ revisões simultâneas durante deploy
+ conexões administrativas
≤ limite do banco − reserva
```

Use pooler (Supavisor ou equivalente) e dimensione o pool por instância a partir dessa conta, não por instância isolada.

## 5. Modelo de execução de workers [N2]

Antes de mover trabalho assíncrono, defina onde ele roda e por quanto tempo:

- **Cloud Run:** a configuração de alocação/cobrança de CPU determina se há CPU fora de uma requisição. Trabalho iniciado depois da resposta pode ser interrompido. Prefira Cloud Tasks entregando HTTP ao worker, com retries e rate control.
- **Lotes longos:** Cloud Run Jobs.
- **Fan-out de eventos:** Pub/Sub.

## 6. Critérios verificáveis de portabilidade [N1]

- `node scripts/check-portabilidade.mjs` roda no CI e acusa, fora dos adapters:
  - import de `@supabase/*` ou do cliente Supabase do projeto (`@/integrations/supabase/client`, `@/lib/supabase`); tipos podem vir com `import type`;
  - chamada direta ao banco ou à plataforma (`.from()`, `.rpc()`, `.functions.invoke()`, `.storage.from()`, `.channel()`), mesmo com o cliente vindo de contexto ou hook;
  - `Deno.*` fora do `index.ts` da Edge Function;
  - empresa ativa lida de `app_metadata`/`user_metadata` quando o tenancy-profile declara `active_source: url`.
- Adapters permitidos por padrão: `adapters/`, `integrations/providers/`, `src/lib/supabase/`, `src/integrations/supabase/`, `src/features/*/api.ts` e o `index.ts` de cada Edge Function. Exceções vão em `.claude/padrao.json` → `portabilidade`.
- Projeto legado grava a dívida atual com `--write-baseline` (`.claude/portabilidade-baseline.json`). O CI barra só o aumento; cada módulo migrado reduz a linha de base, que é regravada para travar o ganho.
- Policies e helpers usam `private.current_user_id()`; FKs de usuário apontam para `public.app_users`.
- Toda tabela, view e função tem grant explícito; nada depende dos default privileges do Supabase (DATABASE §5).
- Domínio e casos de uso testáveis sem Supabase (portas falsas).
- Nenhuma regra de negócio existe **apenas** dentro de Edge Function ou policy sem equivalente no caso de uso.
- A matriz de §2 está atualizada.

## 7. Serviços-alvo (referência)

| Serviço | Uso |
|---|---|
| Cloud Run | API e workers |
| Cloud Tasks | Jobs HTTP, retries, rate control |
| Pub/Sub | Eventos fan-out |
| Cloud SQL | Postgres, quando houver gatilho |
| Secret Manager · Cloud KMS | Segredos · criptografia em envelope |
| Cloud Storage | Objetos |
| Cloud Logging · Cloud Monitoring | Logs · métricas e alertas |
| Artifact Registry | Imagens |

Redis/Memorystore só com necessidade medida e ADR.

## 8. Ordem de migração [N3]

1. Fronteiras (§6) em dia.
2. Containerizar API e worker.
3. Mover compute para Cloud Run, mantendo Supabase como banco e auth. A API valida o JWT do Supabase e atende os mesmos casos de uso; o adapter de cada módulo na tela troca `supabase-js` por HTTP, um módulo por vez.
4. Medir.
5. Migrar jobs e filas.
6. Migrar Storage, se necessário.
7. Migrar o Postgres somente com gatilho objetivo (custo, limite, compliance).
8. Migrar auth separadamente, se necessário.

Nunca mova frontend, API, banco, auth, storage e integrações numa única mudança. Cada etapa tem rollback e critério de sucesso medido.

## Particularidades deste projeto

- Dependências fortes do Supabase: Auth (FKs para `auth.users` e `auth.uid()` direto em policies e funções), Edge Functions Deno, `pg_cron` + `pg_net`, Vault, Storage (bucket público `unit-assets`). Vercel só serve o SPA.
- Linha de base de portabilidade em `.claude/portabilidade-baseline.json`; nenhum gatilho de migração registrado.
