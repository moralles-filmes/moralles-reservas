import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AdminShell } from "@/components/layouts/AdminShell";
import { SidebarActionButton, SidebarBrand, SidebarLink } from "@/components/layouts/SidebarNav";
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
    <AdminShell
      themeAdmin={false}
      sidebarWidthClass="lg:w-60"
      mainPaddingClass="p-6"
      sidebar={
        <>
          <SidebarBrand icon={UtensilsCrossed} label="Moralles Reservas" />

          <div className="mx-3 my-1.5 h-px bg-sidebar-border/50" />

          <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto scrollbar-premium">
            {navItems.map((item) => (
              <SidebarLink
                key={item.to}
                to={item.to}
                label={item.label}
                icon={item.icon}
                end={item.end}
              />
            ))}
          </nav>

          <div className="mx-3 my-1.5 h-px bg-sidebar-border/50" />
          <div className="p-3">
            <SidebarActionButton icon={LogOut} label="Sair" onClick={handleSignOut} danger />
          </div>
        </>
      }
    >
      {children}
    </AdminShell>
  );
}
