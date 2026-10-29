import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAwaitingHumanCount } from "@/hooks/useAwaitingHumanCount";
import { useUndeliveredNotifications } from "@/hooks/useUndeliveredNotifications";
import { SidebarUnitProfile } from "@/components/layouts/SidebarUnitProfile";
import { AdminShell } from "@/components/layouts/AdminShell";
import { BrandMark } from "@/components/layouts/BrandMark";
import {
  SidebarActionButton,
  SidebarCopyCode,
  SidebarLink,
  SidebarSectionTitle,
} from "@/components/layouts/SidebarNav";
import {
  CalendarDays,
  CalendarIcon,
  Gift,
  HelpCircle,
  LogOut,
  MailWarning,
  MessageCircle,
  Settings,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { toast } from "sonner";

export function OperacionalLayout({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const unit = useCurrentUnit();
  const navigate = useNavigate();

  const base = `/o/${unitSlug}`;
  const awaitingCount = useAwaitingHumanCount(unit?.unit_id ?? "");
  // Mesma query key da página Entregas → cache compartilhado (1 fetch só).
  const { data: undelivered } = useUndeliveredNotifications(unit?.unit_id ?? "");
  const undeliveredCount = undelivered?.length ?? 0;

  const navItems: Array<{
    to: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    end?: boolean;
    badge?: number;
  }> = [
    { to: base,                label: "Reservas do dia", icon: CalendarIcon, end: true },
    { to: `${base}/agenda`,    label: "Calendário",      icon: CalendarDays },
    { to: `${base}/fila`,      label: "Fila de espera",  icon: Users },
    { to: `${base}/passantes`, label: "Walk-ins",        icon: UtensilsCrossed },
    { to: `${base}/giftback`,  label: "Validar voucher", icon: Gift },
    { to: `${base}/entregas`,  label: "Entregas",        icon: MailWarning, badge: undeliveredCount },
    { to: `${base}/whatsapp`,  label: "WhatsApp",        icon: MessageCircle },
    { to: `${base}/conversas`, label: "Conversas",       icon: MessageCircle, badge: awaitingCount },
  ];

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada.");
    navigate("/admin/login");
  };

  return (
    <AdminShell
      sidebarWidthClass="lg:w-56"
      mainPaddingClass="p-4"
      sidebar={
        <>
          <div className="px-4 pt-2 pb-1">
            <BrandMark />
          </div>

          <div className="p-3">
            <SidebarUnitProfile basePath="o" />
          </div>

          <div className="px-3 pb-2">
            <SidebarSectionTitle>Painel Operacional</SidebarSectionTitle>
          </div>

          <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto scrollbar-premium">
            {navItems.map((item) => (
              <SidebarLink
                key={item.to}
                to={item.to}
                label={item.label}
                icon={item.icon}
                end={item.end}
                badge={item.badge}
              />
            ))}
          </nav>

          <div className="mx-3 my-1.5 h-px bg-sidebar-border/50" />

          <div className="px-3">
            <SidebarLink
              to={`/g/${unitSlug}`}
              label="Painel de Gestão"
              icon={Settings}
              tone="muted"
            />
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
