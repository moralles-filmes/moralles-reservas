import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAwaitingHumanCount } from "@/hooks/useAwaitingHumanCount";
import { SidebarUnitProfile } from "@/components/layouts/SidebarUnitProfile";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarIcon,
  CalendarOff,
  ChevronDown,
  Code2,
  Copy,
  CreditCard,
  DollarSign,
  FormInput,
  Gift,
  HelpCircle,
  Image as ImageIcon,
  LayoutDashboard,
  List,
  Lock,
  LogOut,
  MessageCircle,
  MessageSquare,
  ScrollText,
  Sliders,
  SquareStack,
  Star,
  Store,
  TrendingUp,
  UserCircle,
  UserCog,
  UserPlus,
  UtensilsCrossed,
  Users,
} from "lucide-react";
import { toast } from "sonner";

type LeafItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: number;
};

type GroupItem = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Path prefix to match for active/auto-expand. */
  matchPrefix: string;
  children: LeafItem[];
};

type NavItem = LeafItem | GroupItem;

const isGroup = (item: NavItem): item is GroupItem => "children" in item;

export function GestaoLayout({ children }: { children: React.ReactNode }) {
  const { signOut, isPlatformAdmin } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const unit = useCurrentUnit();
  const navigate = useNavigate();

  const base = `/g/${unitSlug}`;
  const awaitingCount = useAwaitingHumanCount(unit?.unit_id ?? "");

  const navItems: NavItem[] = [
    { to: base, label: "Dashboard", icon: LayoutDashboard, end: true },
    {
      label: "Relatórios",
      icon: BarChart3,
      matchPrefix: `${base}/relatorios`,
      children: [
        { to: `${base}/relatorios/fluxo-clientes`, label: "Fluxo de clientes", icon: TrendingUp },
        { to: `${base}/relatorios/vendas`,         label: "Vendas",            icon: DollarSign },
        { to: `${base}/relatorios/comunicacao`,    label: "Comunicação",       icon: MessageSquare },
        { to: `${base}/relatorios/avaliacoes`,     label: "Avaliações",        icon: Star },
        { to: `${base}/relatorios/giftback`,       label: "Giftback",          icon: Gift },
      ],
    },
    {
      label: "Reservas",
      icon: UtensilsCrossed,
      matchPrefix: `${base}/reservas`,
      children: [
        { to: `${base}/reservas`,                  label: "Lista",                icon: List, end: true },
        { to: `${base}/reservas/calendario`,       label: "Calendário",           icon: CalendarIcon },
        { to: `${base}/reservas/saloes`,           label: "Salões",               icon: SquareStack },
        { to: `${base}/reservas/datas-especiais`,  label: "Datas especiais",      icon: CalendarOff },
        { to: `${base}/reservas/bloqueios`,        label: "Bloqueios",            icon: Lock },
        { to: `${base}/reservas/widget`,           label: "Widget de reserva",    icon: Code2 },
        { to: `${base}/reservas/formulario`,       label: "Personalizar form.",   icon: FormInput },
        { to: `${base}/reservas/comunicacao`,      label: "Comunicação",          icon: MessageSquare },
        { to: `${base}/reservas/ajustes`,          label: "Ajustes",              icon: Sliders },
      ],
    },
    {
      label: "Fila de espera",
      icon: UserPlus,
      matchPrefix: `${base}/fila`,
      children: [
        { to: `${base}/fila/comunicacao`, label: "Comunicação", icon: MessageSquare },
        { to: `${base}/fila/ajustes`,     label: "Ajustes",     icon: Sliders },
      ],
    },
    {
      label: "Cardápios",
      icon: BookOpen,
      matchPrefix: `${base}/cardapios`,
      children: [
        { to: `${base}/cardapios/meus-cardapios`, label: "Meus Cardápios", icon: List },
        { to: `${base}/cardapios/banners`,        label: "Banners",        icon: ImageIcon },
        { to: `${base}/cardapios/ajustes`,        label: "Ajustes",        icon: Sliders },
      ],
    },
    {
      label: "Giftback",
      icon: Gift,
      matchPrefix: `${base}/giftback`,
      children: [
        { to: `${base}/giftback/regras`,   label: "Regras",   icon: List },
        { to: `${base}/giftback/vouchers`, label: "Vouchers", icon: Gift },
        { to: `${base}/giftback/ajustes`,  label: "Ajustes",  icon: Sliders },
      ],
    },
    { to: `${base}/clientes`,       label: "Clientes",       icon: Users },
    { to: `${base}/conversas`,      label: "Conversas",      icon: MessageCircle, badge: awaitingCount },
    { to: `${base}/conta`,          label: "Conta",          icon: Store },
    { to: `${base}/cobranca`,       label: "Cobrança",       icon: CreditCard },
    { to: `${base}/auditoria`,      label: "Auditoria",      icon: ScrollText },
    { to: `${base}/usuarios`,       label: "Usuários",       icon: UserCog },
    { to: `${base}/configuracoes`,  label: "Minha conta",    icon: UserCircle },
  ];

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada.");
    navigate("/admin/login");
  };

  const handleCopyCode = async () => {
    if (!unit?.unit_slug) return;
    try {
      await navigator.clipboard.writeText(unit.unit_slug);
      toast.success("Código copiado");
    } catch {
      toast.error("Não foi possível copiar");
    }
  };

  return (
    <div className="theme-admin flex h-screen bg-background">
      <aside className="w-60 shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">
        <div className="p-3">
          <SidebarUnitProfile basePath="g" />
        </div>

        <div className="px-3 pb-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-3">
            Painel de Gestão
          </p>
        </div>

        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) =>
            isGroup(item) ? (
              <NavGroup key={item.label} group={item} />
            ) : (
              <NavLeaf key={item.to} item={item} />
            ),
          )}
        </nav>

        <Separator className="bg-sidebar-border" />

        <div className="px-3 py-2">
          <NavLink
            to={`/o/${unitSlug}`}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-sidebar-accent/50 transition-colors"
          >
            <UtensilsCrossed className="h-4 w-4 shrink-0" />
            Painel Operacional
          </NavLink>
        </div>

        {isPlatformAdmin && (
          <div className="px-3 pb-1">
            <NavLink
              to="/platform"
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-primary hover:bg-sidebar-accent/50 transition-colors font-medium"
            >
              <Building2 className="h-4 w-4 shrink-0" />
              Plataforma
            </NavLink>
          </div>
        )}

        <Separator className="bg-sidebar-border" />

        <div className="p-3 space-y-2">
          <NavLink
            to={`${base}/conversas`}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors"
          >
            <HelpCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1">Precisa de ajuda?</span>
            {awaitingCount > 0 && (
              <span className="h-4 min-w-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
                {awaitingCount > 99 ? "99+" : awaitingCount}
              </span>
            )}
          </NavLink>

          {unit?.unit_slug && (
            <button
              type="button"
              onClick={handleCopyCode}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground bg-muted hover:bg-muted/70 transition-colors group"
            >
              <Copy className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
              <span className="flex-1 text-left">Copiar código</span>
              <span className="font-mono text-[11px] text-foreground/80 truncate max-w-[100px]">
                {unit.unit_slug}
              </span>
            </button>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive"
            onClick={handleSignOut}
          >
            <LogOut className="h-4 w-4" />
            Sair
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}

function NavLeaf({ item }: { item: LeafItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
          isActive
            ? "bg-sidebar-accent text-primary font-medium"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50",
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{item.label}</span>
      {!!item.badge && (
        <span className="ml-auto h-4 min-w-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </NavLink>
  );
}

function NavGroup({ group }: { group: GroupItem }) {
  const location = useLocation();
  const isInside = location.pathname.startsWith(group.matchPrefix);
  const [open, setOpen] = useState(isInside);

  useEffect(() => {
    if (isInside) setOpen(true);
  }, [isInside]);

  const Icon = group.icon;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
          isInside
            ? "bg-sidebar-accent text-primary font-medium"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50",
        )}
        aria-expanded={open}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="mt-0.5 ml-3 pl-3 border-l border-sidebar-border space-y-0.5">
          {group.children.map((child) => {
            const ChildIcon = child.icon;
            return (
              <NavLink
                key={child.to}
                to={child.to}
                end={child.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-primary font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                  )
                }
              >
                <ChildIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">{child.label}</span>
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
