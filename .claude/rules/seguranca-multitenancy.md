---
paths:
  - "supabase/functions/**"
  - "src/contexts/AuthContext.tsx"
  - "src/lib/supabase.ts"
  - "src/lib/authz*"
  - "src/hooks/**"
  - "src/App.tsx"
  - "**/*member*"
---

# Segurança, acesso e multi-tenancy — ao tocar auth, membros, queries de tela ou código de servidor

Antes de alterar, leia `docs/standards/SECURITY.md`, `docs/standards/MULTI_TENANCY.md` e `docs/standards/ACCESS_CONTROL.md`, inclusive as Particularidades: este projeto é arquétipo B (`.claude/tenancy-profile.yml`). Onde o padrão diz empresa/`company_id` e permissão `<modulo>.<sub>.<acao>`, aqui é unidade/`unit_id` (ou organização/`organization_id`) e papel `owner > gerente > operador`.

Pontos que mais causam vazamento entre unidades ou escalada de privilégio:

- Autenticação, autorização e resolução de tenant são três verificações independentes.
- Na EF, valide o usuário com `getUser()`/`getClaims()`, que conferem o token no Supabase Auth; não confie em sessão decodificada localmente.
- A unidade da URL (`/g/:unitSlug`, `/o/:unitSlug`) só indica. O servidor resolve a unidade pelo próprio recurso e confere a membership com `hasUnitAccess` (`supabase/functions/_shared/authz.ts`), que já tem o paralelo de `app_private.is_platform_admin`. Nunca use claim, body ou payload como tenant.
- A RLS libera todas as unidades do usuário: toda query de tela filtra pela unidade ativa (ou pela organização, em `customers`), e a chave do TanStack Query inclui esse id (padrão `[entidade, unitId, …]`). Trocar de unidade ou sair descarta o cache privado.
- Campos de tenant, papel, preço, total e status vindos do cliente são ignorados ou revalidados. Nunca espalhe o body num insert/update.
- Transição de estado de negócio (cancelar reserva, baixar ou cancelar voucher, cobrança) é garantida no banco, por trigger ou RPC. Esconder o botão por papel é só UX.
- Membros só pela EF `manage-members`: só `owner` adiciona, remove ou muda papel; o `owner` não é removido nem rebaixado; a mudança fica no `audit_log` (trigger em `unit_members`).
- Service role ignora RLS: só depois de autenticar o caller e validar o recurso, filtrando `unit_id`/`organization_id` em toda query (AGENTS.md §8).
- Testes cobrem o bloqueio **e** o acesso legítimo: outra unidade, outra organização, papel insuficiente, membership removida, super-admin.
