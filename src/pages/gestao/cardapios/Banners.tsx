import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useCreateMenuBanner,
  useMenuBanners,
  useReorderMenuBanners,
} from "@/hooks/useMenuBanners";
import { useUnitAssetUpload } from "@/hooks/useUnitAssetUpload";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Image as ImageIcon, Plus } from "lucide-react";
import { MenuBannerEditor } from "@/components/menus/MenuBannerEditor";
import type { MenuBannerType } from "@/types/reserva";
import { toast } from "sonner";

type Tab = MenuBannerType;

const TAB_LABELS: Record<Tab, string> = {
  home: "Banners da home",
  content: "Banners de conteúdo",
};

export default function Banners() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const [tab, setTab] = useState<Tab>("home");

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbCardapios current="Banners" />
        <h1 className="text-2xl font-bold">Banners do cardápio</h1>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex border-b">
          <TabButton active={tab === "home"} onClick={() => setTab("home")}>
            {TAB_LABELS.home}
          </TabButton>
          <TabButton active={tab === "content"} onClick={() => setTab("content")}>
            {TAB_LABELS.content}
          </TabButton>
        </div>

        <div className="p-6">
          <BannersList unitId={unitId} type={tab} />
        </div>
      </Card>
    </div>
  );
}

// ─── Lista de banners ──────────────────────────────────────────────────────────

function BannersList({ unitId, type }: { unitId: string; type: MenuBannerType }) {
  const { data: banners, isLoading } = useMenuBanners(unitId, type);
  const create = useCreateMenuBanner(unitId, type);
  const reorder = useReorderMenuBanners(unitId, type);
  const upload = useUnitAssetUpload();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const handleAddBanner = async (file: File) => {
    try {
      const { publicUrl } = await upload.mutateAsync({
        unitId,
        kind: type === "home" ? "menu_banner_home" : "menu_banner_content",
        file,
      });
      const sortOrder = banners?.length ?? 0;
      await create.mutateAsync({
        image_url: publicUrl,
        sort_order: sortOrder,
        active: false,
      });
      toast.success("Banner adicionado. Ative quando estiver pronto.");
    } catch {
      // toast já mostrado pelo hook
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId || !banners) {
      setDragId(null);
      return;
    }
    const oldIdx = banners.findIndex((b) => b.id === dragId);
    const newIdx = banners.findIndex((b) => b.id === targetId);
    if (oldIdx < 0 || newIdx < 0) {
      setDragId(null);
      return;
    }
    const next = [...banners];
    const [moved] = next.splice(oldIdx, 1);
    next.splice(newIdx, 0, moved);
    try {
      await reorder.mutateAsync(next.map((b) => b.id));
    } catch {
      toast.error("Falha ao reordenar. Tente novamente.");
    } finally {
      setDragId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          className="gap-2"
          onClick={() => fileRef.current?.click()}
          disabled={upload.isPending || create.isPending}
        >
          <Plus className="h-4 w-4" />
          {upload.isPending || create.isPending
            ? "Adicionando…"
            : "Adicionar banner"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleAddBanner(file);
            e.target.value = "";
          }}
        />
      </div>

      {banners && banners.length > 1 && (
        <p className="text-xs text-muted-foreground">
          Arraste os banners para reordenar — a ordem aparece igual no carrossel
          do cardápio público.
        </p>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-80 w-full" />
          ))}
        </div>
      ) : !banners?.length ? (
        <Card className="py-12 text-center text-sm text-muted-foreground">
          <ImageIcon className="h-8 w-8 mx-auto opacity-30 mb-2" />
          Nenhum banner ainda. Adicione um pra começar.
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {banners.map((b) => (
            <div
              key={b.id}
              draggable
              onDragStart={() => setDragId(b.id)}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(b.id)}
              onDragEnd={() => setDragId(null)}
              className={`transition-opacity ${
                dragId === b.id ? "opacity-50" : ""
              }`}
            >
              <MenuBannerEditor banner={b} unitId={unitId} type={type} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function BreadcrumbCardapios({ current }: { current: string }) {
  const unit = useCurrentUnit();
  const unitSlug = unit?.unit_slug ?? "";
  return (
    <nav className="text-xs text-muted-foreground flex items-center gap-1.5">
      <Link to={`/g/${unitSlug}`} className="hover:text-foreground">
        {unit?.unit_name ?? "Unidade"}
      </Link>
      <span>/</span>
      <span>Cardápios</span>
      <span>/</span>
      <span className="text-foreground">{current}</span>
    </nav>
  );
}
