@AGENTS.md

# Específico do Claude Code

- As regras de `.claude/rules/*.md` carregam sozinhas quando você lê arquivos que casam com o `paths:` de cada uma. Se a tarefa atravessa um assunto cujo arquivo você ainda não abriu (ex.: planejar uma mudança de billing antes de ler código), leia a regra do assunto explicitamente — a tabela do AGENTS.md §2 diz qual.
- Fluxo do AGENTS.md §4 com skills: `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (implementador novo + review de spec e qualidade por tarefa; review da branch inteira no fim).
- Construção especializada: agentes `saas-builder-br:*` (`arquiteto-chefe` orquestra; `db-schema-designer`, `backend-supabase`, `frontend-react`, `design-ux`, `integrador-apis`, `qa-testes`, `devops-ci`).
- Gates de segurança: agentes `saas-shield-br:*` — `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`, `migration-validator`, `secret-hunter`, `integration-reliability-auditor`.
- `.claude/settings.json` bloqueia ou pede confirmação para ações irreversíveis e de produção (git destrutivo, `supabase db push`/`functions deploy`/`secrets`, Vercel `--prod`, e as ferramentas de escrita dos MCPs Supabase e Vercel). Não contorne por outro comando ou ferramenta: se uma ação foi bloqueada, diga o que precisa e peça autorização.
- Se o `/doctor` sugerir enxugar este arquivo ou o AGENTS.md, não aceite cortes nas seções de segurança, tenancy e invariantes.
