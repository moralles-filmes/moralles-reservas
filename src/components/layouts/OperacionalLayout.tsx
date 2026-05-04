import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { UnitSwitcher } from "@/components/UnitSwitcher";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  CalendarIcon,
  LogOut,
  Settings,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { toast } from "sonner";

export function OperacionalLayout({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const navigate = useNavigate();

  const base = `/o/${unitSlug}`;

  const navItems = [
    { to: base,               label: "Reservas do dia", icon: CalendarIcon, end: true },
    { to: `${base}/fila`,     label: "Fila de espera",  icon: Users },
    { to: `${base}/passantes`,label: "Walk-ins",         icon: UtensilsCrossed },
  ];

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada.");
    navigate("/admin/login");
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar compacta */}
      <aside className="w-56 shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">
        <div className="h-14 flex items-center px-3">
          <UnitSwitcher basePath="o" />
        </div>
        <Separator className="bg-sidebar-border" />

        <div className="px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-3">
            Painel Operacional
          </p>
        </div>

        <nav className="flex-1 px-3 space-y-0.5">
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

        <div className="px-3 py-2">
          <NavLink
            to={`/g/${unitSlug}`}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-sidebar-accent transition-colors"
          >
            <Settings className="h-4 w-4 shrink-0" />
            Painel de Gestão
          </NavLink>
        </div>

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

      {/* Main content — mais denso, sem padding excessivo */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-4">{children}</div>
      </main>
    </div>
  );
}
