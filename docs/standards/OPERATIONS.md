# Operações

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia em tarefas de Git, ambientes, deploy, produção, logs, monitoramento, incidentes ou configuração das ferramentas de agentes.

## 1. Git [N1]

**Antes de alterar:** confira `git status`, branch, diff e arquivos não commitados. Trabalho alheio é preservado.

**Livre, sem pedir:** commit local numa branch de trabalho (nunca direto em `main`/`master`). Commit é reversível e é o ponto de verificação do trabalho.

**Exigem autorização explícita:**

- push, merge e rebase de histórico compartilhado;
- descartar alterações (`git checkout -- …`, `git restore`, `git stash drop`, `git reset --hard`, `git clean`), force push;
- apagar branch ou trabalho de outra pessoa.

**Commits:**

- pequenos e coerentes, com mensagem clara;
- diff revisado;
- sem segredo, sem arquivos temporários, sem `.tasks/` (salvo política contrária do projeto).

## 2. Ambientes [N1]

- Desenvolvimento, staging (quando existir) e produção são separados: projetos Supabase distintos, ambientes Vercel distintos, segredos distintos.
- Dados de produção não são copiados para desenvolvimento sem anonimização (SECURITY §10).
- O AGENTS.md registra as **referências** dos projetos (ref do Supabase, nome do projeto Vercel), nunca as chaves.
- **Preview deployments** usam o banco de desenvolvimento ou uma branch do Supabase, e credenciais de sandbox. Token real de provedor (Z-API, Meta, gateway, e-mail) nunca fica no escopo Preview: um PR não pode mandar mensagem a cliente final.

## 3. Deploy e mudanças em produção [N1]

- Deploy, promoção, alteração de variáveis de ambiente, migration remota e mudança destrutiva exigem autorização explícita.
- Uma autorização vale para o mesmo escopo e ambiente até a tarefa terminar. Ela não é pedida de novo a cada fase, e não se estende a escopo ou ambiente diferente.
- Siga a checklist de DATABASE §9 antes de qualquer alteração de banco.
- **[N2]** Feature flags para mudanças arriscadas: liga gradualmente e desliga sem deploy.
- **[N2]** Runbooks em `docs/runbooks/` (`DEPLOY.md`, `ROLLBACK.md`, `RECOVERY.md`, `INCIDENTS.md`), executáveis passo a passo. Crie cada um quando houver conteúdo real.

## 4. Observabilidade

### Logs [N1]

Logs estruturados (JSON). Campos:

- `service`, `environment`, `version`/commit;
- `request_id`, `trace_id`;
- `company_id`, usuário pseudonimizado;
- módulo, operação, latência, status, `error_code`.

Nunca registre:

- token, cookie, senha, segredo, header `Authorization`;
- dados de cartão;
- URL com credencial;
- body privado completo;
- dado pessoal desnecessário.

A redaction é central (um único módulo), não feita caso a caso.

### Métricas e alertas [N2]

- Defina SLI/SLO dos fluxos críticos.
- Crie alertas acionáveis (cada alerta aponta para um runbook).
- Defina retenção de logs e orçamento de cardinalidade: não use id de usuário como label de métrica.

### Traces [N3]

Distribuídos entre API, workers e provedores.

### Falha silenciosa [N2]

Integrações costumam parar sem erro. Além de alertar sobre erros:

- error tracking (Sentry ou equivalente) com scrubbing de dados pessoais e de URLs com credencial;
- verificação de uptime no health check;
- **alerta de silêncio de negócio**: nenhum evento esperado num intervalo em que ele deveria ocorrer (nenhuma mensagem enviada em 1 h de horário comercial, nenhum webhook do gateway em 24 h, fila parada).

## 5. Backup e recuperação

Siga DATABASE §8. Lembre que o Storage tem estratégia própria e que backup nunca restaurado é hipótese.

## 6. Incidentes [N2]

`docs/runbooks/INCIDENTS.md` cobre:

- severidade;
- quem é acionado;
- como conter (kill switch de integração, feature flag, revogar credencial);
- comunicação;
- postmortem sem culpados.

Em incidente com dados pessoais, avalie a comunicação à ANPD e aos titulares (SECURITY §10).

## 7. Ferramentas de agentes de desenvolvimento [N1]

- `.claude/settings.json` define o que o Claude Code não pode fazer (`deny`) e o que exige confirmação (`ask`): push, deploy, migration remota, secrets, `.env` locais, descarte de trabalho e ferramentas MCP de escrita. Para o Codex, use os modos de aprovação e sandbox equivalentes.
- As regras de `.claude/rules/` só existem no Claude Code. Para o Codex, os mesmos pontos são gerados em `AGENTS.md` aninhados (ex.: `supabase/AGENTS.md`) por `scripts/check-padrao.mjs --write-nested`; o CI acusa quando ficam desatualizados.
- Quando o ai-router-br delega tarefa a um worker (Codex, DeepSeek), o pacote da tarefa inclui os padrões relevantes e nenhum dado pessoal real, segredo ou dump de produção.
- Essas regras são aplicadas pelo cliente, não pelo modelo. Mesmo assim:
  - regras de leitura de arquivo não bloqueiam todo comando de shell;
  - a proteção real é **não ter segredo de produção na máquina de desenvolvimento**.
- **Servidores MCP usados pelos agentes:**
  - Supabase MCP aponta para o projeto de **desenvolvimento**, preferencialmente em modo somente leitura e restrito a um projeto (confira as opções na documentação do Supabase MCP);
  - nunca deixe um agente com MCP de escrita ligado à produção.
- Instruções globais e pessoais (`~/.claude/`, `~/.codex/`) são do desenvolvedor. A configuração do projeto não depende delas e não as altera.

## 8. Manutenção contínua [N1]

O sistema é mantido por calendário, não por lembrança. O calendário do projeto fica em `docs/runbooks/MAINTENANCE.md` (modelo no kit) e cada execução registra data, responsável e achados.

| Cadência | Item |
|---|---|
| Semanal | Advisors de segurança e desempenho; dead-letter e itens em `UNKNOWN`; alertas silenciados |
| Mensal | Dependências (Dependabot/Renovate, atualizações agrupadas e testadas); revisão de acessos a Supabase, Vercel, GitHub e contas de provedor (Business Manager, Z-API); custo por serviço |
| Trimestral | Teste de restauração (DATABASE §8); rotação de chaves; versão de API dos provedores (deprecações da Graph API); flags mortas; jobs de retenção (DATABASE §10) |
| Anual | Inventário LGPD e operadores; threat model dos módulos críticos; revisão dos planos e limites |

## 9. Atualização de plataforma [N1]

Major de Next.js, React, Node, Postgres, supabase-js, Supabase CLI e runtime Deno das Edge Functions:

1. Leia as notas de versão e o guia de migração oficiais da versão **instalada** para a nova.
2. Atualize numa branch isolada, uma plataforma por vez.
3. Rode o pipeline inteiro e o smoke E2E num preview.
4. Postgres major: teste num branch/projeto clonado, com os Advisors antes e depois; confira extensões.
5. Registre o que mudou de comportamento em ADR quando afetar padrões (ex.: semântica de cache do Next).
6. Tenha rollback: versão anterior do deploy e, no banco, plano de roll-forward.

## Particularidades deste projeto

- Ambientes: produção Supabase `gbabxcrntkwgblgqsiit` (sa-east-1) e projeto Vercel `moralles-reservas`. Não há staging nem projeto Supabase de desenvolvimento.
- Deploy: push em `main` → Vercel; Edge Function por `supabase functions deploy <nome>`, depois das migrations (`supabase db push`), flags e segredos (AGENTS.md §9).
- Runbooks: `docs/RUNBOOK-ROTACAO-CREDENCIAIS.md`, `docs/whatsapp-multiprovider-uazapi.md`, `docs/datafy-parceiro-runbook.md`, `docs/whatsapp-templates-programados-runbook.md`, `docs/whatsapp-ops-alert-email-runbook.md`, `docs/billing-asaas/`.
- MCPs disponíveis aos agentes: conectores claude.ai Supabase e Vercel, ambos com ferramentas de escrita em produção; `.claude/settings.json` exige confirmação nelas.
