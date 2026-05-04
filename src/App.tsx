import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { GestaoLayout } from "@/components/layouts/GestaoLayout";
import { OperacionalLayout } from "@/components/layouts/OperacionalLayout";
import { PlatformLayout } from "@/components/layouts/PlatformLayout";
import { useAuth } from "@/hooks/useAuth";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useEffect } from "react";

// ── Public ────────────────────────────────────────────────────────────────────
const Index = lazy(() => import("./pages/Index"));
const PublicPortal = lazy(() => import("./pages/PublicPortal"));
const Auth = lazy(() => import("./pages/Auth"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));

// ── Gestão ────────────────────────────────────────────────────────────────────
const GDashboard = lazy(() => import("./pages/gestao/Dashboard"));
const GReservas = lazy(() => import("./pages/gestao/Reservas"));
const GCalendario = lazy(() => import("./pages/gestao/Calendario"));
const GClientes = lazy(() => import("./pages/gestao/Clientes"));
const GConversas = lazy(() => import("./pages/gestao/Conversas"));
const GMesas = lazy(() => import("./pages/gestao/Mesas"));
const GConfiguracoes = lazy(() => import("./pages/gestao/Configuracoes"));
const GAuditoria = lazy(() => import("./pages/gestao/Auditoria"));
const GAutomacao = lazy(() => import("./pages/gestao/Automacao"));
const GAvaliacoes = lazy(() => import("./pages/gestao/Avaliacoes"));

// ── Operacional ───────────────────────────────────────────────────────────────
const OReservasDia = lazy(() => import("./pages/operacional/ReservasDia"));
const OFila        = lazy(() => import("./pages/operacional/Fila"));
const OPassantes   = lazy(() => import("./pages/operacional/Passantes"));

// ── Platform ──────────────────────────────────────────────────────────────────
const PEmpresas = lazy(() => import("./pages/platform/Empresas"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function PageLoader() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

// ── Auth guards ───────────────────────────────────────────────────────────────

function GestaoGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;
  return <GestaoLayout>{children}</GestaoLayout>;
}

function OperacionalGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;
  return <OperacionalLayout>{children}</OperacionalLayout>;
}

function PlatformGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, isPlatformAdmin } = useAuth();
  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;
  if (!isPlatformAdmin) return <Navigate to="/" replace />;
  return <PlatformLayout>{children}</PlatformLayout>;
}

// ── Redirect /admin/* → /g/:defaultSlug/* ────────────────────────────────────

function AdminRedirect({ to }: { to: string }) {
  const { defaultUnitSlug, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    const slug = defaultUnitSlug ?? "moralles-centro";
    navigate(`/g/${slug}${to}`, { replace: true });
  }, [loading, defaultUnitSlug, navigate, to]);

  return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* ── Public ─────────────────────────────────────────────── */}
              <Route path="/" element={<Index />} />
              <Route path="/r/:slug" element={<PublicPortal />} />
              <Route path="/admin/login" element={<Auth />} />
              <Route path="/reset-password" element={<ResetPassword />} />

              {/* ── Gestão /g/:unitSlug ─────────────────────────────────── */}
              <Route path="/g/:unitSlug" element={<GestaoGuard><GDashboard /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas" element={<GestaoGuard><GReservas /></GestaoGuard>} />
              <Route path="/g/:unitSlug/calendario" element={<GestaoGuard><GCalendario /></GestaoGuard>} />
              <Route path="/g/:unitSlug/clientes" element={<GestaoGuard><GClientes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/conversas" element={<GestaoGuard><GConversas /></GestaoGuard>} />
              <Route path="/g/:unitSlug/mesas" element={<GestaoGuard><GMesas /></GestaoGuard>} />
              <Route path="/g/:unitSlug/configuracoes" element={<GestaoGuard><GConfiguracoes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/auditoria" element={<GestaoGuard><GAuditoria /></GestaoGuard>} />
              <Route path="/g/:unitSlug/automacao" element={<GestaoGuard><GAutomacao /></GestaoGuard>} />
              <Route path="/g/:unitSlug/avaliacoes" element={<GestaoGuard><GAvaliacoes /></GestaoGuard>} />

              {/* ── Operacional /o/:unitSlug ────────────────────────────── */}
              <Route path="/o/:unitSlug" element={<OperacionalGuard><OReservasDia /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/reservas" element={<OperacionalGuard><OReservasDia /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/fila" element={<OperacionalGuard><OFila /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/passantes" element={<OperacionalGuard><OPassantes /></OperacionalGuard>} />

              {/* ── Platform /platform/* ───────────────────────────────── */}
              <Route path="/platform" element={<PlatformGuard><PEmpresas /></PlatformGuard>} />
              <Route path="/platform/empresas" element={<PlatformGuard><PEmpresas /></PlatformGuard>} />

              {/* ── Legacy /admin/* → redirect ──────────────────────────── */}
              <Route path="/admin" element={<AdminRedirect to="" />} />
              <Route path="/admin/reservas" element={<AdminRedirect to="/reservas" />} />
              <Route path="/admin/calendario" element={<AdminRedirect to="/calendario" />} />
              <Route path="/admin/clientes" element={<AdminRedirect to="/clientes" />} />
              <Route path="/admin/conversas" element={<AdminRedirect to="/conversas" />} />
              <Route path="/admin/mesas" element={<AdminRedirect to="/mesas" />} />
              <Route path="/admin/configuracoes" element={<AdminRedirect to="/configuracoes" />} />
              <Route path="/admin/auditoria" element={<AdminRedirect to="/auditoria" />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
