# supabase/ — regras deste diretório

Além do [AGENTS.md](../AGENTS.md) da raiz, leia antes de editar:

- `migrations/`, `tests/` → `.claude/rules/banco-de-dados.md`
- `functions/` → `.claude/rules/edge-functions.md`, `.claude/rules/integracoes.md`, `.claude/rules/seguranca-multitenancy.md` e a regra do assunto: `whatsapp.md`, `agente-ia.md`, `datafy.md`, `whatsapp-templates.md`, `billing.md` ou `reservas.md` (tabela no AGENTS.md raiz §2).

Mudou `functions/_shared/X.ts`? Redeploy de todas as consumidoras: `node scripts/ef-import-graph.mjs supabase/functions/_shared/X.ts`.
