import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { useAuth } from "@/hooks/useAuth";
import { Skeleton } from "@/components/ui/skeleton";

const Index = lazy(() => import("./pages/Index"));
const Auth = lazy(() => import("./pages/Auth"));
const Dashboard = lazy(() => import("./pages/admin/Dashboard"));
const Reservas = lazy(() => import("./pages/admin/Reservas"));
const Calendario = lazy(() => import("./pages/admin/Calendario"));
const Clientes = lazy(() => import("./pages/admin/Clientes"));
const Conversas = lazy(() => import("./pages/admin/Conversas"));
const Mesas = lazy(() => import("./pages/admin/Mesas"));
const Configuracoes = lazy(() => import("./pages/admin/Configuracoes"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;
  return <AdminLayout>{children}</AdminLayout>;
}

function PageLoader() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<Index />} />
            <Route path="/admin/login" element={<Auth />} />

            {/* Admin (protected) */}
            <Route
              path="/admin"
              element={<AdminGuard><Dashboard /></AdminGuard>}
            />
            <Route
              path="/admin/reservas"
              element={<AdminGuard><Reservas /></AdminGuard>}
            />
            <Route
              path="/admin/calendario"
              element={<AdminGuard><Calendario /></AdminGuard>}
            />
            <Route
              path="/admin/clientes"
              element={<AdminGuard><Clientes /></AdminGuard>}
            />
            <Route
              path="/admin/conversas"
              element={<AdminGuard><Conversas /></AdminGuard>}
            />
            <Route
              path="/admin/mesas"
              element={<AdminGuard><Mesas /></AdminGuard>}
            />
            <Route
              path="/admin/configuracoes"
              element={<AdminGuard><Configuracoes /></AdminGuard>}
            />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
