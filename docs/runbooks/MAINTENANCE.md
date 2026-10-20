# Manutenção contínua

> Calendário de OPERATIONS §8. Ajuste itens e responsáveis ao projeto. Registre cada execução no histórico.

| Cadência | Item | Como | Responsável |
|---|---|---|---|
| Semanal | Advisors de segurança e desempenho | painel do Supabase ou `supabase db advisors` | {{...}} |
| Semanal | Dead-letter e itens em `UNKNOWN` | {{consulta}} | {{...}} |
| Semanal | Alertas silenciados ou ruidosos | {{ferramenta}} | {{...}} |
| Mensal | Dependências | PRs do Dependabot/Renovate, agrupados, com pipeline verde | {{...}} |
| Mensal | Revisão de acessos (Supabase, Vercel, GitHub, Business Manager, Z-API) | lista de quem tem acesso a produção | {{...}} |
| Mensal | Custo por serviço | faturas e painéis | {{...}} |
| Trimestral | Teste de restauração | `docs/runbooks/RECOVERY.md` | {{...}} |
| Trimestral | Rotação de chaves | {{lista de credenciais}} | {{...}} |
| Trimestral | Versão de API dos provedores | provider docs (`Última verificação`) | {{...}} |
| Trimestral | Flags mortas e jobs de retenção | DATABASE §10 | {{...}} |
| Anual | Inventário LGPD e operadores | SECURITY §10 | {{...}} |
| Anual | Threat model dos módulos críticos | SECURITY §7 | {{...}} |

## Histórico

| Data | Item | Achados | Ação |
|---|---|---|---|
