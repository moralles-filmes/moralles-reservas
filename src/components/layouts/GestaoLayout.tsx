import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAwaitingHumanCount } from "@/hooks/useAwaitingHumanCount";
import { SidebarUnitProfile } from "@/components/layouts/SidebarUnitProfile";
import { AdminShell } from "@/components/layouts/AdminShell";
import {
  SidebarActionButton,
  SidebarCopyCode,
  SidebarGroup,
  SidebarLink,
  SidebarSectionTitle,
  type SidebarSubItem,
} from "@/components/layouts/SidebarNav";
import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarIcon,
  CalendarOff,
  Code2,
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
  children: SidebarSubItem[];
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
    ...(unit?.isGerente
      ? [{ to: `${base}/whatsapp`, label: "WhatsApp", icon: MessageSquare }]
      : []),
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

  return (
    <AdminShell
      sidebarWidthClass="lg:w-60"
      mainPaddingClass="p-6"
      sidebar={
        <>
          <div className="p-3">
            <SidebarUnitProfile basePath="g" />
          </div>

          <div className="px-3 pb-2">
            <SidebarSectionTitle>Painel de Gestão</SidebarSectionTitle>
          </div>

          <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto scrollbar-premium">
            {navItems.map((item) =>
              isGroup(item) ? (
                <SidebarGroup
                  key={item.label}
                  label={item.label}
                  icon={item.icon}
                  matchPrefix={item.matchPrefix}
                  items={item.children}
                />
              ) : (
                <SidebarLink
                  key={item.to}
                  to={item.to}
                  label={item.label}
                  icon={item.icon}
                  end={item.end}
                  badge={item.badge}
                />
              ),
            )}
          </nav>

          <div className="mx-3 my-1.5 h-px bg-sidebar-border/50" />

          <div className="px-3 space-y-0.5">
            <SidebarLink
              to={`/o/${unitSlug}`}
              label="Painel Operacional"
              icon={UtensilsCrossed}
              tone="muted"
            />
            {isPlatformAdmin && (
              <SidebarLink to="/platform" label="Plataforma" icon={Building2} tone="gold" />
            )}
          </div>

          <div className="mx-3 my-1.5 h-px bg-sidebar-border/50" />

          <div className="p-3 space-y-2">
            <SidebarLink
              to={`${base}/conversas`}
              label="Precisa de ajuda?"
              icon={HelpCircle}
              tone="muted"
              badge={awaitingCount}
            />
            {unit?.unit_slug && <SidebarCopyCode slug={unit.unit_slug} />}
            <SidebarActionButton icon={LogOut} label="Sair" onClick={handleSignOut} danger />
          </div>
        </>
      }
    >
      {children}
    </AdminShell>
  );
}
