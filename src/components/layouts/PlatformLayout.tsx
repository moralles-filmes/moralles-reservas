import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AdminShell } from "@/components/layouts/AdminShell";
import {
  SidebarActionButton,
  SidebarBrand,
  SidebarDisabledItem,
  SidebarFootnote,
  SidebarLink,
  SidebarSectionTitle,
} from "@/components/layouts/SidebarNav";
import { Bot, Building2, CreditCard, LogOut, Users } from "lucide-react";
import { toast } from "sonner";

export function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada.");
    navigate("/admin/login");
  };

  const navItems = [
    { to: "/platform/empresas", label: "Empresas", icon: Building2 },
    { to: "/platform/automacao", label: "Automação", icon: Bot },
    { to: "/platform/billing", label: "Cobranças", icon: CreditCard },
  ];

  return (
    <AdminShell
      sidebarWidthClass="lg:w-60"
      mainPaddingClass="p-6"
      sidebar={
        <>
          <SidebarBrand icon={Building2} label="Moralles Plataforma" />

          <div className="px-3 py-2">
            <SidebarSectionTitle>Administração</SidebarSectionTitle>
          </div>

          <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto scrollbar-premium">
            {navItems.map((item) => (
              <SidebarLink key={item.to} to={item.to} label={item.label} icon={item.icon} />
            ))}
            <SidebarDisabledItem icon={Users} label="Admins da Plataforma" />
          </nav>

          <div className="mx-3 my-1.5 h-px bg-sidebar-border/50" />
          <SidebarFootnote>{user?.email}</SidebarFootnote>
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
