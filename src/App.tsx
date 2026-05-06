import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { GestaoLayout } from "@/components/layouts/GestaoLayout";
import { OperacionalLayout } from "@/components/layouts/OperacionalLayout";
import { PlatformLayout } from "@/components/layouts/PlatformLayout";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
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
const GPaginaPublica = lazy(() => import("./pages/gestao/PaginaPublica"));

// ── Operacional ───────────────────────────────────────────────────────────────
const OReservasDia = lazy(() => import("./pages/operacional/ReservasDia"));
const OFila        = lazy(() => import("./pages/operacional/Fila"));
const OPassantes   = lazy(() => import("./pages/operacional/Passantes"));
const OConversas   = lazy(() => import("./pages/operacional/Conversas"));

// ── Platform ──────────────────────────────────────────────────────────────────
const PEmpresas = lazy(() => import("./pages/platform/Empresas"));
const PAutomacao = lazy(() => import("./pages/platform/Automacao"));

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

// ── Redirect /admin/* → correct destination based on auth state ──────────────

function AdminRedirect({ to }: { to: string }) {
  const { user, loading, defaultUnitSlug, isPlatformAdmin } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate("/admin/login", { replace: true });
      return;
    }
    if (defaultUnitSlug) {
      navigate(`/g/${defaultUnitSlug}${to}`, { replace: true });
      return;
    }
    if (isPlatformAdmin) {
      navigate("/platform", { replace: true });
      return;
    }
  }, [loading, user, defaultUnitSlug, isPlatformAdmin, navigate, to]);

  if (!loading && user && !defaultUnitSlug && !isPlatformAdmin) {
    return (
      <div className="p-6 max-w-md mx-auto mt-12 text-center space-y-3">
        <h1 className="text-xl font-semibold">Sem acesso a nenhuma unidade</h1>
        <p className="text-muted-foreground">
          Sua conta não está vinculada a nenhum restaurante. Peça ao administrador para te adicionar.
        </p>
      </div>
    );
  }
  return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
        <AuthProvider>
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
              <Route path="/g/:unitSlug/avaliacoes" element={<GestaoGuard><GAvaliacoes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/pagina-publica" element={<GestaoGuard><GPaginaPublica /></GestaoGuard>} />

              {/* ── Operacional /o/:unitSlug ────────────────────────────── */}
              <Route path="/o/:unitSlug" element={<OperacionalGuard><OReservasDia /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/reservas" element={<OperacionalGuard><OReservasDia /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/fila" element={<OperacionalGuard><OFila /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/passantes" element={<OperacionalGuard><OPassantes /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/conversas" element={<OperacionalGuard><OConversas /></OperacionalGuard>} />

              {/* ── Platform /platform/* ───────────────────────────────── */}
              <Route path="/platform" element={<PlatformGuard><PEmpresas /></PlatformGuard>} />
              <Route path="/platform/empresas" element={<PlatformGuard><PEmpresas /></PlatformGuard>} />
              <Route path="/platform/automacao" element={<PlatformGuard><PAutomacao /></PlatformGuard>} />
              <Route path="/platform/automacao/:unitSlug" element={<PlatformGuard><GAutomacao /></PlatformGuard>} />

              {/* ── Legacy /admin → redirect ─────────────────────────────── */}
              <Route path="/admin" element={<AdminRedirect to="" />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
        </BrowserRouter>
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
