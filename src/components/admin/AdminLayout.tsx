import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  CalendarIcon,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  ScrollText,
  Settings,
  Table2,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { toast } from "sonner";

const navItems = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/admin/reservas", label: "Reservas", icon: UtensilsCrossed },
  { to: "/admin/calendario", label: "Calendário", icon: CalendarIcon },
  { to: "/admin/clientes", label: "Clientes", icon: Users },
  { to: "/admin/conversas", label: "Conversas", icon: MessageCircle },
  { to: "/admin/mesas", label: "Mesas", icon: Table2 },
  { to: "/admin/auditoria", label: "Auditoria", icon: ScrollText },
  { to: "/admin/configuracoes", label: "Configurações", icon: Settings },
];

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada.");
    navigate("/admin/login");
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">
        <div className="h-16 flex items-center px-5">
          <Link to="/admin" className="flex items-center gap-2">
            <UtensilsCrossed className="h-5 w-5 text-primary" />
            <span className="font-semibold text-sidebar-foreground">
              Moralles Reservas
            </span>
          </Link>
        </div>
        <Separator className="bg-sidebar-border" />

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {navItems.map(({ to, label, icon: Icon, end }) => (
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
              {label}
            </NavLink>
          ))}
        </nav>

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
