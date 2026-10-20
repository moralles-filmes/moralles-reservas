@AGENTS.md

# Específico do Claude Code

- As regras de `.claude/rules/*.md` carregam sozinhas quando você lê arquivos que casam com o `paths:` de cada uma. Se a tarefa atravessa um assunto cujo arquivo você ainda não abriu (ex.: planejar billing antes de ler código), leia a regra do assunto explicitamente (tabela do AGENTS.md §2).
- Fluxo do AGENTS.md §4: `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development`. Os gates de segurança do §4 são os agentes `saas-shield-br:*` de mesmo nome; construção especializada, `saas-builder-br:*`.
- `.claude/settings.json` pede confirmação em ações irreversíveis e de produção, inclusive nas ferramentas de escrita dos MCPs Supabase e Vercel. Não contorne por outro comando ou ferramenta: diga o que precisa e peça autorização.
- Se o `/doctor` sugerir enxugar este arquivo ou o AGENTS.md, não aceite cortes em segurança, tenancy e invariantes.
