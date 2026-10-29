import type { ComponentType } from "react";
import { Bot, Building2, CreditCard, KeyRound, Layers, MessageSquare, Smartphone, Store, Users } from "lucide-react";

type IconType = ComponentType<{ className?: string }>;

export type PlatformNavItem = {
  to: string;
  label: string;
  icon: IconType;
  /** Sub-rotas que têm item próprio no menu e por isso NÃO acendem este. */
  excludePrefixes?: string[];
};

export type PlatformNavSection = {
  title: string;
  items: PlatformNavItem[];
  /** Placeholders "em breve": aparecem desativados, sem rota. */
  disabledItems?: { label: string; icon: IconType }[];
};

export const PLATFORM_NAV: PlatformNavSection[] = [
  {
    title: "Clientes",
    items: [
      { to: "/platform/empresas", label: "Empresas", icon: Building2 },
      { to: "/platform/unidades", label: "Unidades (WhatsApp e IA)", icon: Store },
    ],
  },
  {
    title: "Financeiro",
    items: [
      {
        to: "/platform/billing",
        label: "Cobranças",
        icon: CreditCard,
        // O detalhe `/platform/billing/:organizationId` continua acendendo Cobranças.
        excludePrefixes: ["/platform/billing/planos", "/platform/billing/implementacoes"],
      },
      { to: "/platform/billing/planos", label: "Planos", icon: Layers },
      { to: "/platform/billing/implementacoes", label: "Implantações WhatsApp", icon: MessageSquare },
    ],
  },
  {
    title: "WhatsApp",
    items: [{ to: "/platform/instancias-whatsapp", label: "Instâncias e custos", icon: Smartphone }],
  },
  {
    title: "Configurações",
    items: [
      { to: "/platform/agente-ia", label: "Agente de IA", icon: Bot },
      { to: "/platform/integracoes", label: "Integrações e chaves", icon: KeyRound },
    ],
    disabledItems: [{ label: "Admins da plataforma", icon: Users }],
  },
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
