import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, useLocation, matchPath } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { GestaoLayout } from "@/components/layouts/GestaoLayout";
import { OperacionalLayout } from "@/components/layouts/OperacionalLayout";
import { PlatformLayout } from "@/components/layouts/PlatformLayout";
import { LegacyPlatformUnitRedirect } from "@/pages/platform/legacy-redirects";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BillingGuard } from "@/components/BillingGuard";
import { RouteThemeProvider } from "@/components/RouteThemeProvider";
import { useEffect } from "react";

// ── Public ────────────────────────────────────────────────────────────────────
const Index = lazy(() => import("./pages/Index"));
const PublicPortal = lazy(() => import("./pages/PublicPortal"));
const WidgetPortal = lazy(() => import("./pages/WidgetPortal"));
const MenuPortal = lazy(() => import("./pages/MenuPortal"));
const AcompanharReserva = lazy(() => import("./pages/AcompanharReserva"));
const Auth = lazy(() => import("./pages/Auth"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const PreferenciasMensagens = lazy(() => import("./pages/public/PreferenciasMensagens"));

// ── Gestão ────────────────────────────────────────────────────────────────────
const GDashboard = lazy(() => import("./pages/gestao/Dashboard"));
const GReservas = lazy(() => import("./pages/gestao/Reservas"));
const GCalendario = lazy(() => import("./pages/gestao/Calendario"));
const GClientes = lazy(() => import("./pages/gestao/Clientes"));
const GConversas = lazy(() => import("./pages/gestao/Conversas"));
const GConfiguracoes = lazy(() => import("./pages/gestao/Configuracoes"));
const GAuditoria = lazy(() => import("./pages/gestao/Auditoria"));
const GAutomacao = lazy(() => import("./pages/gestao/Automacao"));
const GAvaliacoes = lazy(() => import("./pages/gestao/Avaliacoes"));
const GConta = lazy(() => import("./pages/gestao/Conta"));
const GUsuarios = lazy(() => import("./pages/gestao/Usuarios"));
const GCobranca = lazy(() => import("./pages/gestao/Cobranca"));
const GWhatsapp = lazy(() => import("./pages/gestao/Whatsapp"));
const GAtendimentoIa = lazy(() => import("./pages/gestao/AtendimentoIa"));
const GMarketing = lazy(() => import("./pages/gestao/Marketing"));

// ── Gestão > Reservas (sub-abas) ──────────────────────────────────────────────
const GSaloes = lazy(() => import("./pages/gestao/reservas/Saloes"));
const GSalaoDetalhe = lazy(() => import("./pages/gestao/reservas/SalaoDetalhe"));
const GDatasEspeciais = lazy(() => import("./pages/gestao/reservas/DatasEspeciais"));
const GBloqueios = lazy(() => import("./pages/gestao/reservas/Bloqueios"));
const GWidget = lazy(() => import("./pages/gestao/reservas/Widget"));
const GFormulario = lazy(() => import("./pages/gestao/reservas/Formulario"));
const GAjustes = lazy(() => import("./pages/gestao/reservas/Ajustes"));
const GReservasComunicacao = lazy(() => import("./pages/gestao/reservas/Comunicacao"));
const GWidgetDetail = lazy(() => import("./pages/gestao/reservas/WidgetDetail"));

// ── Gestão > Fila de espera (sub-abas) ────────────────────────────────────────
const GFilaComunicacao = lazy(() => import("./pages/gestao/fila/Comunicacao"));
const GFilaAjustes = lazy(() => import("./pages/gestao/fila/Ajustes"));

// ── Gestão > Cardápios (sub-abas) ─────────────────────────────────────────────
const GMeusCardapios = lazy(() => import("./pages/gestao/cardapios/MeusCardapios"));
const GMenuDetail    = lazy(() => import("./pages/gestao/cardapios/MenuDetail"));
const GBannersCard   = lazy(() => import("./pages/gestao/cardapios/Banners"));
const GCardAjustes   = lazy(() => import("./pages/gestao/cardapios/Ajustes"));

// ── Gestão > Relatórios (sub-abas) ────────────────────────────────────────────
const GFluxoClientes = lazy(() => import("./pages/gestao/relatorios/FluxoClientes"));
const GRelVendas     = lazy(() => import("./pages/gestao/relatorios/Vendas"));
const GRelComunicacao = lazy(() => import("./pages/gestao/relatorios/Comunicacao"));
const GRelGiftback = lazy(() => import("./pages/gestao/relatorios/Giftback"));

// ── Giftback ──────────────────────────────────────────────────────────────────
const GGiftbackRegras   = lazy(() => import("./pages/gestao/giftback/Regras"));
const GGiftbackVouchers = lazy(() => import("./pages/gestao/giftback/Vouchers"));
const GGiftbackAjustes  = lazy(() => import("./pages/gestao/giftback/Ajustes"));

// ── Operacional ───────────────────────────────────────────────────────────────
const OReservasDia = lazy(() => import("./pages/operacional/ReservasDia"));
const OAgenda      = lazy(() => import("./pages/operacional/Agenda"));
const OFila        = lazy(() => import("./pages/operacional/Fila"));
const OPassantes   = lazy(() => import("./pages/operacional/Passantes"));
const OConversas   = lazy(() => import("./pages/operacional/Conversas"));
const OGiftback    = lazy(() => import("./pages/operacional/Giftback"));
const OEntregas    = lazy(() => import("./pages/operacional/Entregas"));

// ── Platform ──────────────────────────────────────────────────────────────────
const PEmpresas = lazy(() => import("./pages/platform/Empresas"));
const PUnidades = lazy(() => import("./pages/platform/Unidades"));
const PIntegracoes = lazy(() => import("./pages/platform/Integracoes"));
const PAgenteIa = lazy(() => import("./pages/platform/AgenteIa"));
const PBilling = lazy(() => import("./pages/platform/Billing"));
const PBillingPlans = lazy(() => import("./pages/platform/BillingPlans"));
const PBillingDetail = lazy(() => import("./pages/platform/BillingDetail"));
const PWhatsappImplementations = lazy(() => import("./pages/platform/WhatsappImplementations"));
const PWhatsappInstances = lazy(() => import("./pages/platform/WhatsappInstances"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
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
  const { user, loading, memberships, isPlatformAdmin } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;

  // Operador NÃO acessa o painel de Gestão. Redireciona pro Operacional da
  // mesma unit. Platform admin (super-admin) sempre passa, mesmo sem membership.
  // Sem membership na unit alvo → /admin (AuthContext decide: redireciona pra
  // outra unit, ou desloga se órfão total).
  if (!isPlatformAdmin) {
    const m = memberships.find((mm) => mm.unit_slug === unitSlug);
    if (!m) return <Navigate to="/admin" replace />;
    if (m.role === "operador") {
      return <Navigate to={`/o/${unitSlug}`} replace />;
    }
  }
  return <GestaoLayout><BillingGuard>{children}</BillingGuard></GestaoLayout>;
}

function OperacionalGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, memberships, isPlatformAdmin } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;
  if (!isPlatformAdmin) {
    const m = memberships.find((mm) => mm.unit_slug === unitSlug);
    if (!m) return <Navigate to="/admin" replace />;
  }
  return <OperacionalLayout><BillingGuard>{children}</BillingGuard></OperacionalLayout>;
}

function PlatformGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, isPlatformAdmin } = useAuth();
  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;
  if (!isPlatformAdmin) return <Navigate to="/" replace />;
  return <PlatformLayout>{children}</PlatformLayout>;
}

// ── Redirect rotas legadas dentro de /g/:unitSlug ─────────────────────────────

function LegacyGestaoRedirect({ to }: { to: string }) {
  const { unitSlug } = useParams<{ unitSlug: string }>();
  return <Navigate to={`/g/${unitSlug}/${to}`} replace />;
}

// ── Redirect /admin/* → correct destination based on auth state ──────────────

function AdminRedirect({ to }: { to: string }) {
  const { user, loading, defaultUnitSlug, isPlatformAdmin, memberships } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate("/admin/login", { replace: true });
      return;
    }
    if (defaultUnitSlug) {
      // Operador vai direto pro Painel Operacional. Owner/gerente vão pra Gestão.
      const defaultMembership = memberships.find(
        (m) => m.unit_slug === defaultUnitSlug,
      );
      const isOperator =
        defaultMembership?.role === "operador" && !isPlatformAdmin;
      const target = isOperator ? `/o/${defaultUnitSlug}` : `/g/${defaultUnitSlug}${to}`;
      navigate(target, { replace: true });
      return;
    }
    if (isPlatformAdmin) {
      navigate("/platform", { replace: true });
      return;
    }
    // Caso restante: user autenticado, sem memberships e sem platform_admin.
    // O auto-logout global em AuthContext já cuidou disso (toast + signOut +
    // navigate login). Só renderiza Skeleton enquanto a transição acontece.
  }, [loading, user, defaultUnitSlug, isPlatformAdmin, memberships, navigate, to]);

  return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
}

function PreferenceAuthBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const isPreferenceRoute = !!matchPath({ path: "/preferencias/mensagens/:token", end: true, caseSensitive: true }, pathname);
  return isPreferenceRoute ? <>{children}</> : <AuthProvider>{children}</AuthProvider>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
        <RouteThemeProvider>
        <PreferenceAuthBoundary>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* ── Public ─────────────────────────────────────────────── */}
              <Route path="/" element={<Index />} />
              <Route path="/r/:slug" element={<PublicPortal />} />
              <Route path="/w/:slug" element={<WidgetPortal />} />
              <Route path="/m/:slug" element={<MenuPortal />} />
              <Route path="/acompanhar/:token" element={<AcompanharReserva />} />
              <Route path="/preferencias/mensagens/:token" caseSensitive element={<PreferenciasMensagens />} />
              <Route path="/admin/login" element={<Auth />} />
              <Route path="/reset-password" element={<ResetPassword />} />

              {/* ── Gestão /g/:unitSlug ─────────────────────────────────── */}
              <Route path="/g/:unitSlug" element={<GestaoGuard><GDashboard /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas" element={<GestaoGuard><GReservas /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/calendario" element={<GestaoGuard><GCalendario /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/saloes" element={<GestaoGuard><GSaloes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/saloes/:hallId" element={<GestaoGuard><GSalaoDetalhe /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/datas-especiais" element={<GestaoGuard><GDatasEspeciais /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/bloqueios" element={<GestaoGuard><GBloqueios /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/widget" element={<GestaoGuard><GWidget /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/widget/:widgetId" element={<GestaoGuard><GWidgetDetail /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/formulario" element={<GestaoGuard><GFormulario /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/comunicacao" element={<GestaoGuard><GReservasComunicacao /></GestaoGuard>} />
              <Route path="/g/:unitSlug/reservas/ajustes" element={<GestaoGuard><GAjustes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/fila" element={<Navigate to="comunicacao" replace />} />
              <Route path="/g/:unitSlug/fila/comunicacao" element={<GestaoGuard><GFilaComunicacao /></GestaoGuard>} />
              <Route path="/g/:unitSlug/fila/ajustes" element={<GestaoGuard><GFilaAjustes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/cardapios" element={<Navigate to="meus-cardapios" replace />} />
              <Route path="/g/:unitSlug/cardapios/meus-cardapios" element={<GestaoGuard><GMeusCardapios /></GestaoGuard>} />
              <Route path="/g/:unitSlug/cardapios/meus-cardapios/:menuId" element={<GestaoGuard><GMenuDetail /></GestaoGuard>} />
              <Route path="/g/:unitSlug/cardapios/banners" element={<GestaoGuard><GBannersCard /></GestaoGuard>} />
              <Route path="/g/:unitSlug/cardapios/ajustes" element={<GestaoGuard><GCardAjustes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/giftback" element={<Navigate to="regras" replace />} />
              <Route path="/g/:unitSlug/giftback/regras" element={<GestaoGuard><GGiftbackRegras /></GestaoGuard>} />
              <Route path="/g/:unitSlug/giftback/vouchers" element={<GestaoGuard><GGiftbackVouchers /></GestaoGuard>} />
              <Route path="/g/:unitSlug/giftback/ajustes" element={<GestaoGuard><GGiftbackAjustes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/marketing" element={<Navigate to="campanhas" replace />} />
              <Route path="/g/:unitSlug/marketing/:section" element={<GestaoGuard><GMarketing /></GestaoGuard>} />
              <Route path="/g/:unitSlug/clientes" element={<GestaoGuard><GClientes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/conversas" element={<GestaoGuard><GConversas /></GestaoGuard>} />
              <Route path="/g/:unitSlug/whatsapp" element={<GestaoGuard><GWhatsapp /></GestaoGuard>} />
              <Route path="/g/:unitSlug/atendimento-ia" element={<GestaoGuard><GAtendimentoIa /></GestaoGuard>} />
              <Route path="/g/:unitSlug/configuracoes" element={<GestaoGuard><GConfiguracoes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/auditoria" element={<GestaoGuard><GAuditoria /></GestaoGuard>} />
              <Route path="/g/:unitSlug/relatorios" element={<Navigate to="fluxo-clientes" replace />} />
              <Route path="/g/:unitSlug/relatorios/fluxo-clientes" element={<GestaoGuard><GFluxoClientes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/relatorios/vendas" element={<GestaoGuard><GRelVendas /></GestaoGuard>} />
              <Route path="/g/:unitSlug/relatorios/comunicacao" element={<GestaoGuard><GRelComunicacao /></GestaoGuard>} />
              <Route path="/g/:unitSlug/relatorios/avaliacoes" element={<GestaoGuard><GAvaliacoes /></GestaoGuard>} />
              <Route path="/g/:unitSlug/relatorios/giftback" element={<GestaoGuard><GRelGiftback /></GestaoGuard>} />
              {/* Legacy: /avaliacoes redireciona pra dentro de /relatorios */}
              <Route path="/g/:unitSlug/avaliacoes" element={<LegacyGestaoRedirect to="relatorios/avaliacoes" />} />
              <Route path="/g/:unitSlug/cobranca" element={<GestaoGuard><GCobranca /></GestaoGuard>} />
              <Route path="/g/:unitSlug/conta" element={<GestaoGuard><GConta /></GestaoGuard>} />
              {/* Legacy: /pagina-publica redireciona pra /conta (preserva QR codes / links antigos) */}
              <Route path="/g/:unitSlug/pagina-publica" element={<LegacyGestaoRedirect to="conta" />} />
              <Route path="/g/:unitSlug/usuarios" element={<GestaoGuard><GUsuarios /></GestaoGuard>} />
              {/* Legacy redirects */}
              <Route path="/g/:unitSlug/calendario" element={<LegacyGestaoRedirect to="reservas/calendario" />} />
              <Route path="/g/:unitSlug/mesas" element={<LegacyGestaoRedirect to="reservas/saloes" />} />

              {/* ── Operacional /o/:unitSlug ────────────────────────────── */}
              <Route path="/o/:unitSlug" element={<OperacionalGuard><OReservasDia /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/reservas" element={<OperacionalGuard><OReservasDia /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/agenda" element={<OperacionalGuard><OAgenda /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/fila" element={<OperacionalGuard><OFila /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/passantes" element={<OperacionalGuard><OPassantes /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/conversas" element={<OperacionalGuard><OConversas /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/giftback" element={<OperacionalGuard><OGiftback /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/entregas" element={<OperacionalGuard><OEntregas /></OperacionalGuard>} />
              <Route path="/o/:unitSlug/whatsapp" element={<OperacionalGuard><GWhatsapp /></OperacionalGuard>} />

              {/* ── Platform /platform/* ───────────────────────────────── */}
              <Route path="/platform" element={<Navigate to="/platform/empresas" replace />} />
              <Route path="/platform/empresas" element={<PlatformGuard><PEmpresas /></PlatformGuard>} />
              <Route path="/platform/unidades" element={<PlatformGuard><PUnidades /></PlatformGuard>} />
              <Route path="/platform/unidades/:unitSlug" element={<PlatformGuard><GAutomacao /></PlatformGuard>} />
              <Route path="/platform/integracoes" element={<PlatformGuard><PIntegracoes /></PlatformGuard>} />
              <Route path="/platform/agente-ia" element={<PlatformGuard><PAgenteIa /></PlatformGuard>} />
              {/* Endereços antigos: o retorno do Stripe Connect (manage-stripe-accounts)
                  ainda aponta para /platform/automacao/:slug?stripe=complete. */}
              <Route path="/platform/automacao" element={<Navigate to="/platform/unidades" replace />} />
              <Route path="/platform/automacao/:unitSlug" element={<LegacyPlatformUnitRedirect />} />
              <Route path="/platform/billing" element={<PlatformGuard><PBilling /></PlatformGuard>} />
              <Route path="/platform/billing/planos" element={<PlatformGuard><PBillingPlans /></PlatformGuard>} />
              {/* M-9 (Rodada de correção 1): a ordem de declaração aqui NÃO é o que
                  resolve a rota certa — React Router v6 rankeia por especificidade
                  (segmento estático sempre vence dinâmico), então "implementacoes"
                  bateria em ":organizationId" mesmo se esta linha viesse depois.
                  Mantida perto de "planos" (mesmo padrão estático-antes-de-dinâmico)
                  só por legibilidade de quem lê o arquivo de cima pra baixo. */}
              <Route path="/platform/billing/implementacoes" element={<PlatformGuard><PWhatsappImplementations /></PlatformGuard>} />
              <Route path="/platform/instancias-whatsapp" element={<PlatformGuard><PWhatsappInstances /></PlatformGuard>} />
              <Route path="/platform/billing/:organizationId" element={<PlatformGuard><PBillingDetail /></PlatformGuard>} />

              {/* ── Legacy /admin → redirect ─────────────────────────────── */}
              <Route path="/admin" element={<AdminRedirect to="" />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </PreferenceAuthBoundary>
        <Toaster richColors position="top-right" />
        </RouteThemeProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
