# Enxugar o contexto de agentes (Padrão SaaS)

**Objetivo:** reduzir o contexto carregado em toda sessão sem perder invariante. Decisões aprovadas em 2026-10-16: arquitetura do Padrão SaaS (AGENTS.md fonte única; CLAUDE.md = `@AGENTS.md`; detalhe em `.claude/rules/` por caminho), checklist de redeploy substituída por script, escopo só de contexto (instalação de `docs/standards/` e scripts de verificação fica para outra rodada).

**Antes:** CLAUDE.md 191K caracteres (carregado inteiro) + AGENTS.md 63K (acima do limite de 32 KiB que o Codex lê), mantidos em par manual.

## Tarefas

- [x] `scripts/ef-import-graph.mjs` + teste com controle positivo (`import type` desligado reprova 3 casos).
- [x] Mover o CLAUDE.md para `.claude/rules/<assunto>.md` por faixas de linha (script de conferência: nenhuma linha não-vazia sem destino).
- [x] AGENTS.md novo (< 200 linhas, ~11 KB) com regras globais e índice assunto → arquivo; CLAUDE.md = `@AGENTS.md` + skills/agentes do Claude Code.
- [x] Condensar `whatsapp.md` e `billing.md`; remover histórico dos demais.
- [x] `.gitignore`: `!.claude/rules/`. Ponteiros `supabase/AGENTS.md` e `src/AGENTS.md` para o Codex.
- [x] Revisão de cobertura independente (antigo × novo) e correção dos achados.

## Fora desta rodada

- Instalar `docs/standards/`, `check-padrao.mjs`, `check-portabilidade.mjs` e o gate de CI do Padrão SaaS.
- Atualizar os ~30 comentários de código que dizem "ver CLAUDE.md" (seguem válidos: o conteúdo foi para `.claude/rules/`).
- Atualizar a "matriz transitiva" do runbook de templates para apontar ao script.
