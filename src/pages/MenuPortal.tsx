import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DEFAULT_MENU_THEME, type MenuTheme } from "@/types/reserva";
import { cn, isSafeHttpUrl } from "@/lib/utils";

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_RE.test(value) ? value : fallback;
}

interface MenuPublicResponse {
  menu: {
    id: string;
    slug: string;
    name: string;
    cover_image_url: string | null;
    theme: MenuTheme;
  };
  unit: {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
  };
  pages: Array<{ id: string; image_url: string; sort_order: number }>;
  banners: {
    home: Array<{ id: string; image_url: string; link_url: string | null }>;
    content: Array<{ id: string; image_url: string; link_url: string | null }>;
  };
}

export default function MenuPortal() {
  const { slug } = useParams<{ slug: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ["menu-public", slug],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_menu_public", {
        p_slug: slug,
      });
      if (error) throw error;
      return data as MenuPublicResponse | null;
    },
    enabled: !!slug,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen ambient bg-background text-foreground p-6">
        <div className="surface rounded-panel p-4 max-w-3xl mx-auto space-y-4">
          <Skeleton className="aspect-[2/1] w-full rounded-card" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="aspect-[3/4] w-full rounded-block" />
          <Skeleton className="aspect-[3/4] w-full rounded-block" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen ambient bg-background text-foreground flex items-center justify-center p-6 text-center">
        <div className="surface rounded-panel max-w-md p-8 space-y-2">
          <p className="text-xl font-semibold tracking-tight">Cardápio não encontrado.</p>
          <p className="text-sm text-muted-foreground">
            Verifique o link e tente novamente.
          </p>
        </div>
      </div>
    );
  }

  const { menu, unit, pages, banners } = data;
  // Theme JSONB pode vir corrompido (insert via SQL, migração antiga, etc).
  // Aplicar fallback por campo para o portal nunca quebrar visualmente.
  const rawTheme = (menu.theme ?? {}) as Partial<MenuTheme>;
  const theme: MenuTheme = {
    font_primary: safeColor(rawTheme.font_primary, DEFAULT_MENU_THEME.font_primary),
    font_secondary: safeColor(rawTheme.font_secondary, DEFAULT_MENU_THEME.font_secondary),
    bg_primary: safeColor(rawTheme.bg_primary, DEFAULT_MENU_THEME.bg_primary),
    bg_secondary: safeColor(rawTheme.bg_secondary, DEFAULT_MENU_THEME.bg_secondary),
    accent: safeColor(rawTheme.accent, DEFAULT_MENU_THEME.accent),
  };

  // CSS variables — paleta aplicada apenas dentro deste portal.
  const themeStyle: React.CSSProperties = {
    "--menu-font-primary": theme.font_primary,
    "--menu-font-secondary": theme.font_secondary,
    "--menu-bg-primary": theme.bg_primary,
    "--menu-bg-secondary": theme.bg_secondary,
    "--menu-accent": theme.accent,
    backgroundColor: theme.bg_primary,
    color: theme.font_primary,
  } as React.CSSProperties;

  return (
    <div style={themeStyle} className="min-h-screen py-3 sm:py-6">
      {/* Banners da home (carrossel/grid no topo) */}
      {banners.home.length > 0 && (
        <div className="px-4 sm:px-6">
          <BannerCarousel banners={banners.home} aspect="aspect-[9/16]" />
        </div>
      )}

      {/* Hero — cover + nome */}
      <header
        className="px-4 sm:px-6 pt-4 pb-6 max-w-3xl mx-auto"
        style={{ backgroundColor: theme.bg_primary }}
      >
        {menu.cover_image_url && (
          <div className="aspect-[2/1] w-full rounded-panel overflow-hidden">
            <img
              src={menu.cover_image_url}
              alt={menu.name}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        <div className={cn(
          "surface rounded-card relative p-5 flex items-center gap-3",
          menu.cover_image_url && "-mt-6 mx-3",
        )} style={{ backgroundColor: theme.bg_primary }}>
          {unit.logo_url && (
            <img
              src={unit.logo_url}
              alt={`Logo ${unit.name}`}
              className="h-14 w-14 shrink-0 rounded-full object-cover ring-2 ring-background"
              style={{ outline: `2px solid ${theme.accent}` }}
            />
          )}
          <div className="min-w-0">
            <h1
              className="text-3xl font-display font-semibold tracking-tight break-words"
              style={{ color: theme.font_primary }}
            >
              {menu.name}
            </h1>
            <p
              className="text-sm mt-1 break-words"
              style={{ color: theme.font_secondary }}
            >
              {unit.name}
            </p>
          </div>
        </div>
      </header>

      {/* Galeria de páginas */}
      <main
        className="px-4 sm:px-6 max-w-3xl mx-auto pb-8 pt-4 space-y-4 rounded-panel"
        style={{ backgroundColor: theme.bg_secondary }}
      >
        {pages.length === 0 ? (
          <div
            className="surface rounded-card text-center px-6 py-16 text-sm leading-relaxed"
            style={{ backgroundColor: theme.bg_primary, color: theme.font_secondary }}
          >
            Cardápio em preparação. Volte em breve.
          </div>
        ) : (
          pages.map((p, idx) => (
            <div
              key={p.id}
              className="surface rounded-card overflow-hidden"
              style={{ backgroundColor: theme.bg_primary }}
            >
              <img
                src={p.image_url}
                alt={`Página ${idx + 1} de ${menu.name}`}
                className="w-full h-auto"
                loading={idx > 1 ? "lazy" : "eager"}
              />
            </div>
          ))
        )}

        {/* Banners de conteúdo (rodapé) */}
        {banners.content.length > 0 && (
          <div className="pt-4">
            <BannerCarousel banners={banners.content} aspect="aspect-square" />
          </div>
        )}
      </main>

      <footer
        className="border-t px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-xs"
        style={{
          borderColor: theme.bg_secondary,
          color: theme.font_secondary,
        }}
      >
        {unit.name} · cardápio digital
      </footer>
    </div>
  );
}

// ─── Banner carousel ──────────────────────────────────────────────────────────

function BannerCarousel({
  banners,
  aspect,
}: {
  banners: Array<{ id: string; image_url: string; link_url: string | null }>;
  aspect: string;
}) {
  const [idx, setIdx] = useState(0);

  // Auto-rotação a cada 6s quando há mais de 1 banner
  useEffect(() => {
    if (banners.length <= 1) return;
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % banners.length);
    }, 6000);
    return () => clearInterval(t);
  }, [banners.length]);

  if (banners.length === 0) return null;
  const current = banners[idx];

  const inner = (
    <div className={cn("relative w-full rounded-card bg-muted overflow-hidden", aspect)}>
      <img
        src={current.image_url}
        alt={`Banner ${idx + 1}`}
        className="w-full h-full object-cover"
      />
      {banners.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setIdx((idx - 1 + banners.length) % banners.length);
            }}
            className="surface absolute left-2 top-1/2 -translate-y-1/2 bg-card hover:bg-muted text-foreground rounded-full h-9 w-9 coarse:h-11 coarse:w-11 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Banner anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setIdx((idx + 1) % banners.length);
            }}
            className="surface absolute right-2 top-1/2 -translate-y-1/2 bg-card hover:bg-muted text-foreground rounded-full h-9 w-9 coarse:h-11 coarse:w-11 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Próximo banner"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <div className="surface absolute bottom-3 left-1/2 -translate-x-1/2 flex justify-center gap-1.5 rounded-full bg-card p-2">
            {banners.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 rounded-full",
                  i === idx ? "w-6 bg-primary" : "w-1.5 bg-foreground/30",
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );

  // Só renderiza <a> se a URL for http(s). Bloqueia javascript:/data:/etc
  // mesmo que algum banner antigo tenha entrado no banco antes da validação.
  if (current.link_url && isSafeHttpUrl(current.link_url)) {
    return (
      <a
        href={current.link_url}
        target="_blank"
        rel="noopener noreferrer"
        className="block max-w-3xl mx-auto rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {inner}
      </a>
    );
  }

  return <div className="max-w-3xl mx-auto">{inner}</div>;
}
