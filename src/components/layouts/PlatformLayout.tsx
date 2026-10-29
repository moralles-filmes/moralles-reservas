import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AdminShell } from "@/components/layouts/AdminShell";
import { BrandMark } from "@/components/layouts/BrandMark";
import {
  SidebarActionButton,
  SidebarDisabledItem,
  SidebarFootnote,
  SidebarLink,
  SidebarSectionTitle,
} from "@/components/layouts/SidebarNav";
import { PLATFORM_NAV, isPlatformNavItemActive } from "@/components/layouts/platform-nav";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

export function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada.");
    navigate("/admin/login");
  };

  return (
    <AdminShell
      sidebarWidthClass="lg:w-64"
      mainPaddingClass="p-6"
      sidebar={
        <>
          <div className="flex items-center px-4 h-14">
            <BrandMark label="Plataforma" />
          </div>

          <nav className="flex-1 px-3 pb-2 overflow-y-auto scrollbar-premium">
            {PLATFORM_NAV.map((section) => (
              <div key={section.title} className="pt-3 space-y-0.5">
                <div className="pb-1">
                  <SidebarSectionTitle>{section.title}</SidebarSectionTitle>
                </div>
                {section.items.map((item) => (
                  <SidebarLink
                    key={item.to}
                    to={item.to}
                    label={item.label}
                    icon={item.icon}
                    isActive={isPlatformNavItemActive(pathname, item)}
                  />
                ))}
                {section.disabledItems?.map((disabled) => (
                  <SidebarDisabledItem key={disabled.label} icon={disabled.icon} label={disabled.label} />
                ))}
              </div>
            ))}
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
