import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MenuTheme } from "@/types/reserva";

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
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-2xl mx-auto space-y-4">
          <Skeleton className="aspect-[2/1] w-full rounded-md" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="aspect-[3/4] w-full" />
          <Skeleton className="aspect-[3/4] w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-muted/40 flex items-center justify-center p-6 text-center">
        <div className="space-y-2">
          <p className="text-lg font-semibold">Cardápio não encontrado.</p>
          <p className="text-sm text-muted-foreground">
            Verifique o link e tente novamente.
          </p>
        </div>
      </div>
    );
  }

  const { menu, unit, pages, banners } = data;
  const theme = menu.theme;

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
    <div style={themeStyle} className="min-h-screen">
      {/* Banners da home (carrossel/grid no topo) */}
      {banners.home.length > 0 && (
        <BannerCarousel banners={banners.home} aspect="aspect-[9/16]" />
      )}

      {/* Hero — cover + nome */}
      <header
        className="px-4 sm:px-6 py-8 max-w-3xl mx-auto"
        style={{ backgroundColor: theme.bg_primary }}
      >
        {menu.cover_image_url && (
          <div className="aspect-[2/1] w-full rounded-lg overflow-hidden mb-5">
            <img
              src={menu.cover_image_url}
              alt={menu.name}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        <div className="flex items-center gap-3">
          {unit.logo_url && (
            <img
              src={unit.logo_url}
              alt={`Logo ${unit.name}`}
              className="h-12 w-12 rounded-full object-cover ring-2"
              style={{ outline: `2px solid ${theme.accent}` }}
            />
          )}
          <div>
            <h1
              className="text-3xl font-display"
              style={{ color: theme.font_primary }}
            >
              {menu.name}
            </h1>
            <p
              className="text-sm"
              style={{ color: theme.font_secondary }}
            >
              {unit.name}
            </p>
          </div>
        </div>
      </header>

      {/* Galeria de páginas */}
      <main
        className="px-4 sm:px-6 max-w-3xl mx-auto pb-8 space-y-4"
        style={{ backgroundColor: theme.bg_secondary }}
      >
        {pages.length === 0 ? (
          <div
            className="text-center py-16 text-sm"
            style={{ color: theme.font_secondary }}
          >
            Cardápio em preparação. Volte em breve.
          </div>
        ) : (
          pages.map((p, idx) => (
            <div
              key={p.id}
              className="rounded-lg overflow-hidden"
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
        className="border-t py-4 text-center text-xs"
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
    <div className={`relative w-full ${aspect} bg-muted overflow-hidden`}>
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
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full p-1"
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
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full p-1"
            aria-label="Próximo banner"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1">
            {banners.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === idx ? "w-6 bg-white" : "w-1.5 bg-white/50"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );

  if (current.link_url) {
    return (
      <a
        href={current.link_url}
        target="_blank"
        rel="noopener noreferrer"
        className="block max-w-3xl mx-auto"
      >
        {inner}
      </a>
    );
  }

  return <div className="max-w-3xl mx-auto">{inner}</div>;
}
