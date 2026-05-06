import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAwaitingHumanCount } from "@/hooks/useAwaitingHumanCount";
import { UnitSwitcher } from "@/components/UnitSwitcher";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Building2,
  CalendarIcon,
  Globe,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  ScrollText,
  Settings,
  Star,
  Table2,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { toast } from "sonner";

export function GestaoLayout({ children }: { children: React.ReactNode }) {
  const { signOut, isPlatformAdmin } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const unit = useCurrentUnit();
  const navigate = useNavigate();

  const base = `/g/${unitSlug}`;
  const awaitingCount = useAwaitingHumanCount(unit?.unit_id ?? "");

  const navItems = [
    { to: base,                    label: "Dashboard",    icon: LayoutDashboard, end: true },
    { to: `${base}/reservas`,      label: "Reservas",     icon: UtensilsCrossed },
    { to: `${base}/calendario`,    label: "Calendário",   icon: CalendarIcon },
    { to: `${base}/clientes`,      label: "Clientes",     icon: Users },
    { to: `${base}/conversas`,     label: "Conversas",    icon: MessageCircle, badge: awaitingCount },
    { to: `${base}/mesas`,         label: "Mesas",        icon: Table2 },
    { to: `${base}/avaliacoes`,    label: "Avaliações",   icon: Star },
    { to: `${base}/pagina-publica`,label: "Página pública",icon: Globe },
    { to: `${base}/auditoria`,     label: "Auditoria",    icon: ScrollText },
    { to: `${base}/configuracoes`, label: "Configurações",icon: Settings },
  ] as const;

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada.");
    navigate("/admin/login");
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">
        <div className="h-14 flex items-center px-3">
          <UnitSwitcher basePath="g" />
        </div>
        <Separator className="bg-sidebar-border" />

        <div className="px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-3">
            Painel de Gestão
          </p>
        </div>

        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {navItems.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-sidebar-accent text-primary font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {!!badge && (
                <span className="ml-auto h-4 min-w-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <Separator className="bg-sidebar-border" />

        {/* Link para Painel Operacional */}
        <div className="px-3 py-2">
          <NavLink
            to={`/o/${unitSlug}`}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-sidebar-accent transition-colors"
          >
            <UtensilsCrossed className="h-4 w-4 shrink-0" />
            Painel Operacional
          </NavLink>
        </div>

        {isPlatformAdmin && (
          <div className="px-3 pb-1">
            <NavLink
              to="/platform"
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-primary hover:bg-sidebar-accent transition-colors font-medium"
            >
              <Building2 className="h-4 w-4 shrink-0" />
              Plataforma
            </NavLink>
          </div>
        )}

        <Separator className="bg-sidebar-border" />
        <div className="p-3">
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

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
