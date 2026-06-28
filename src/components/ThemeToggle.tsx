import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Alterna entre tema claro e escuro nos painéis admin.
 * Usa next-themes (adiciona/remove `.dark` em <html>). O escuro dos painéis vive
 * em `.dark .theme-admin` (src/index.css). Público não monta este botão → fica claro.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  // Evita mismatch de ícone antes do next-themes hidratar o tema persistido.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Ativar tema claro" : "Ativar tema escuro"}
      title={isDark ? "Tema claro" : "Tema escuro"}
      className={cn(
        "p-2 rounded-md text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
    >
      {/* Sem `mounted` renderiza o ícone do claro (estado default), trocando após hidratar. */}
      {mounted && isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}
