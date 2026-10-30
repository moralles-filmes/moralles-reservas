import { ThemeProvider } from "next-themes";
import { useLocation } from "react-router-dom";
import { isLightOnlyRoute } from "@/lib/theme-routes";

export function RouteThemeProvider({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  // Rota pública força Dia sem apagar a escolha salva; painel sem escolha abre em Noite.
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="moralles-theme"
      disableTransitionOnChange
      forcedTheme={isLightOnlyRoute(pathname) ? "light" : undefined}
    >
      {children}
    </ThemeProvider>
  );
}
