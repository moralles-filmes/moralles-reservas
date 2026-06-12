import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AdminShell } from "@/components/layouts/AdminShell";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
    { to: "/platform/admins", label: "Admins da Plataforma", icon: Users, disabled: true },
  ];

  return (
    <AdminShell
      sidebarWidthClass="lg:w-60"
      mainPaddingClass="p-6"
      sidebar={
        <>
          <div className="h-14 flex items-center px-6 gap-2">
            <Building2 className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Moralles Plataforma</span>
        </div>
        <Separator className="bg-sidebar-border" />

        <div className="px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-3">
            Administração
          </p>
        </div>

        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {navItems.map(({ to, label, icon: Icon, disabled }) =>
            disabled ? (
              <span
                key={to}
                className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground/50 cursor-not-allowed select-none"
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </span>
            ) : (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-accent text-primary font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </NavLink>
            )
          )}
        </nav>

        <Separator className="bg-sidebar-border" />
        <div className="px-6 py-3 text-xs text-muted-foreground truncate">
          {user?.email}
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
        </>
      }
    >
      {children}
    </AdminShell>
  );
}
