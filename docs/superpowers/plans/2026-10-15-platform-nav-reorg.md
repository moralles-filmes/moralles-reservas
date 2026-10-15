# Plano — reorganização do painel `/platform`

Spec: [2026-10-15-platform-nav-reorg-design.md](../specs/2026-10-15-platform-nav-reorg-design.md). Frontend apenas. Não tocar `supabase/`.

## Task 1 — Núcleo do menu: `src/components/layouts/platform-nav.ts` (novo)

```ts
import type { ComponentType } from "react";
import { Building2, CreditCard, KeyRound, Layers, MessageSquare, Smartphone, Store } from "lucide-react";

type IconType = ComponentType<{ className?: string }>;

export type PlatformNavItem = {
  to: string;
  label: string;
  icon: IconType;
  /** Sub-rotas que têm item próprio no menu e por isso NÃO acendem este. */
  excludePrefixes?: string[];
};

export type PlatformNavSection = { title: string; items: PlatformNavItem[] };

export const PLATFORM_NAV: PlatformNavSection[] = [
  { title: "Clientes", items: [
    { to: "/platform/empresas", label: "Empresas", icon: Building2 },
    { to: "/platform/unidades", label: "Unidades (WhatsApp e IA)", icon: Store },
  ] },
  { title: "Financeiro", items: [
    { to: "/platform/billing", label: "Cobranças", icon: CreditCard,
      excludePrefixes: ["/platform/billing/planos", "/platform/billing/implementacoes"] },
    { to: "/platform/billing/planos", label: "Planos", icon: Layers },
    { to: "/platform/billing/implementacoes", label: "Implantações WhatsApp", icon: MessageSquare },
  ] },
  { title: "WhatsApp", items: [
    { to: "/platform/instancias-whatsapp", label: "Instâncias e custos", icon: Smartphone },
  ] },
  { title: "Configurações", items: [
    { to: "/platform/integracoes", label: "Integrações e chaves", icon: KeyRound },
  ] },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPlatformNavItemActive(
  pathname: string,
  item: Pick<PlatformNavItem, "to" | "excludePrefixes">,
): boolean {
  if (!matchesPrefix(pathname, item.to)) return false;
  return !(item.excludePrefixes ?? []).some((prefix) => matchesPrefix(pathname, prefix));
}
```

## Task 2 — `SidebarLink` aceita estado ativo explícito (`src/components/layouts/SidebarNav.tsx`)

Adicionar prop opcional `isActive?: boolean` em `SidebarLinkProps` (comentário: "sobrepõe o casamento por prefixo do NavLink quando o layout decide o ativo"). No `className` do `NavLink`, usar `const active = isActiveOverride ?? isActive;` (renomear a prop desestruturada para `isActive: isActiveOverride`). Nenhum outro layout passa a prop — comportamento deles inalterado.

## Task 3 — `PlatformLayout.tsx`

Trocar o array `navItems` e o título único "Administração" por iteração sobre `PLATFORM_NAV`: para cada seção, `<SidebarSectionTitle>{title}</SidebarSectionTitle>` (com o mesmo espaçamento usado hoje, `px-3 pt-3 pb-1` ou equivalente) e os `SidebarLink` com `isActive={isPlatformNavItemActive(pathname, item)}` (`pathname` de `useLocation()`). O `SidebarDisabledItem` "Admins da plataforma" fica dentro da seção "Configurações", logo após "Integrações e chaves". Remover o comentário sobre a rota de instâncias (o item segue no menu). Imports de ícones não usados saem.

## Task 4 — Redirect legado: `src/pages/platform/legacy-redirects.tsx` (novo)

```tsx
import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/platform/automacao/:unitSlug` virou `/platform/unidades/:unitSlug`.
 * A query precisa sobreviver: o retorno do onboarding Stripe Connect é montado
 * no servidor (`manage-stripe-accounts`) como `/platform/automacao/<slug>?stripe=complete`.
 */
export function LegacyPlatformUnitRedirect() {
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: `/platform/unidades/${unitSlug ?? ""}`, search, hash }} />;
}
```

## Task 5 — Rotas (`src/App.tsx`)

- Remover `const PAutomacao = lazy(...)`; adicionar `PUnidades` (`./pages/platform/Unidades`) e `PIntegracoes` (`./pages/platform/Integracoes`); importar `LegacyPlatformUnitRedirect`.
- Bloco `/platform/*`:
  - `/platform` → `<Navigate to="/platform/empresas" replace />`
  - `/platform/empresas` (como hoje)
  - `/platform/unidades` → `<PlatformGuard><PUnidades /></PlatformGuard>`
  - `/platform/unidades/:unitSlug` → `<PlatformGuard><GAutomacao /></PlatformGuard>`
  - `/platform/integracoes` → `<PlatformGuard><PIntegracoes /></PlatformGuard>`
  - `/platform/automacao` → `<Navigate to="/platform/unidades" replace />`
  - `/platform/automacao/:unitSlug` → `<LegacyPlatformUnitRedirect />`
  - rotas `/platform/billing*` e `/platform/instancias-whatsapp` inalteradas (manter o comentário M-9).

## Task 6 — `src/pages/platform/Integracoes.tsx` (novo) e remoção de `Automacao.tsx`

- Mover de `platform/Automacao.tsx` as constantes (`WEBHOOK_URL`, `SECRET_LABELS`, `SECRET_PLACEHOLDERS`, `KEY_PROVIDER`, `PROVIDER_LABELS`) e a lógica de `PlatformSecretsCard` (estado dos inputs, salvar, copiar webhook, `renderSecretRow` com o AlertDialog de remoção — textos idênticos).
- `export default function PlatformIntegracoes()`. Cabeçalho: ícone `KeyRound`, `h1` "Integrações e chaves", parágrafo "Credenciais globais da plataforma. Ficam criptografadas no banco e só as Edge Functions as leem; o painel mostra apenas os últimos 4 caracteres."
- Estados: `isLoading` → skeleton simples ou texto "Carregando…"; `isError` → mensagem + botão "Tentar novamente" (`refetch`).
- Cartões separados, nesta ordem: **WhatsApp oficial (Datafy)** (texto atual + linhas Datafy); **Stripe** (texto atual, trocando "via a aba \"Pagamentos\" da unidade" por "em Unidades › Configurar › Pagamentos", linhas Stripe e o bloco da URL do webhook); **Asaas** (texto atual + linhas Asaas); **Outras chaves** (só se houver).
- Apagar `src/pages/platform/Automacao.tsx`.

## Task 7 — `src/pages/platform/Unidades.tsx` (novo)

- `export default function PlatformUnidades()`. Usa `useAllUnits()` e `useSearchParams()`; `empresa = searchParams.get("empresa")`.
- Cabeçalho: ícone `Store`, `h1` "Unidades", parágrafo "Configure WhatsApp, IA, instruções do agente e pagamentos de cada unidade."
- Se `empresa` presente: aviso `Unidades de <nome da empresa>` (nome da primeira unidade filtrada; se nenhuma, "desta empresa") + `Link` "Ver todas" → `/platform/unidades`.
- Tabela (mesmas colunas da antiga): Empresa, Unidade, Slug, botão "Configurar" → `/platform/unidades/${u.slug}`.
- Quatro ramos: carregando, erro (`error.message` ou "Falha ao carregar unidades." + "Tentar novamente"), vazio ("Nenhuma unidade cadastrada ainda." ou, com filtro, "Nenhuma unidade para esta empresa."), lista.

## Task 8 — Ajustes em páginas existentes

- `src/pages/gestao/Automacao.tsx`: os dois links "Voltar para unidades" → `/platform/unidades`. Cabeçalho: `h1` = `{unit.name}`; parágrafo abaixo = `WhatsApp e IA · <span className="font-medium text-foreground">{unit.organization_name}</span>`; descrição = "Configure os canais de WhatsApp, o provedor de IA, as instruções do agente e os pagamentos." Nada mais muda no arquivo.
- `src/pages/platform/Empresas.tsx`: no `DropdownMenuContent`, após "Editar", adicionar `DropdownMenuItem asChild` com `Link to={`/platform/billing/${org.id}`}` ("Ver cobrança", ícone `CreditCard`) e `Link to={`/platform/unidades?empresa=${org.id}`}` ("Unidades (WhatsApp e IA)", ícone `Store`). "Acessar painel" permanece por último.
- `src/pages/platform/Billing.tsx`: remover o `div` dos dois botões de topo (e o comentário M-10); remover `Settings2`/`MessageSquare` do import se ficarem sem uso.
- `src/pages/platform/BillingPlans.tsx`: remover o `Link`+`Button` voltar do cabeçalho; remover `ArrowLeft` do import.
- `src/pages/gestao/relatorios/Comunicacao.tsx`: trocar `/platform/automacao` por `/platform/unidades` e "→ Diagnóstico" por "→ Configurar → Diagnóstico".

## Task 9 — Testes

- `src/components/layouts/platform-nav.test.ts` (novo):
  - `isPlatformNavItemActive`: Cobranças ativo em `/platform/billing` e `/platform/billing/<uuid>`; inativo em `/platform/billing/planos` e `/platform/billing/implementacoes`; Planos ativo em `/platform/billing/planos`; Unidades ativo em `/platform/unidades` e `/platform/unidades/ren-sushi`; Empresas inativo em `/platform/empresas-x` (prefixo de segmento, não de string).
  - Guarda estática: ler `src/App.tsx` (via `fs.readFileSync` + `path.resolve(__dirname, ...)`, padrão de `src/lib/whatsapp-inbound-reentry.test.ts`) e afirmar que cada `item.to` de `PLATFORM_NAV` aparece como `path="<to>"`.
- `src/pages/platform/legacy-redirects.test.tsx` (novo, `// @vitest-environment jsdom`): `MemoryRouter initialEntries={["/platform/automacao/ren-sushi?stripe=complete#topo"]}` com `Routes` contendo a rota legada e `/platform/unidades/:unitSlug` renderizando um componente que imprime `pathname`, `search` e `hash` de `useLocation()`. Esperar `/platform/unidades/ren-sushi`, `?stripe=complete`, `#topo`.
- `src/pages/platform/Integracoes.test.tsx`: transferir `Automacao.datafy.test.tsx` (apagar o antigo), importando `./Integracoes`, sem mock de `useAllUnits`; o cartão do Datafy (`label.closest('[class*="rounded"]')`) não contém "Stripe" nem "Asaas". Adicionar caso: com `isError` o botão "Tentar novamente" aparece.
- `src/pages/platform/Unidades.test.tsx` (novo, jsdom): mock de `useAllUnits` com 3 unidades em 2 empresas; sem filtro mostra as 3; com `?empresa=<org-a>` mostra só as de A, o aviso "Unidades de A" e o link "Ver todas"; "Configurar" aponta para `/platform/unidades/<slug>`.

## Task 10 — Documentação (principal, não worker)

`CLAUDE.md` linhas com `/platform/automacao` → novos endereços; regra nova em "Roteamento (gotchas)": redirect legado preserva query por causa do retorno do Stripe Connect. Espelho em `AGENTS.md`.

## Verificação

`npm run typecheck`, `npm run lint`, `npm test`. Controle positivo do redirect: remover `search` do `Navigate` e ver o teste falhar; restaurar. Controle positivo do ativo: remover `excludePrefixes` de Cobranças e ver o teste falhar; restaurar. Conferência visual no app (`npm run dev`).
