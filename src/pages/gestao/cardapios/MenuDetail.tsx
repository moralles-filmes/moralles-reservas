import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useDeleteMenu,
  useMenu,
  useUpdateMenu,
} from "@/hooks/useMenus";
import { useUnitAssetUpload } from "@/hooks/useUnitAssetUpload";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Camera, Trash2 } from "lucide-react";
import { ShareCard } from "@/components/share/ShareCard";
import { MenuPagesEditor } from "@/components/menus/MenuPagesEditor";
import { ThemeEditor } from "@/components/menus/ThemeEditor";
import {
  DEFAULT_MENU_THEME,
  type MenuTheme,
} from "@/types/reserva";
import { toast } from "sonner";
import { BreadcrumbCardapios } from "./Banners";

type Tab = "compartilhamento" | "galeria" | "personalizacao";

export default function MenuDetail() {
  const { menuId } = useParams<{ menuId: string }>();
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const navigate = useNavigate();

  const { data: menu, isLoading } = useMenu(menuId);
  const updateMenu = useUpdateMenu(unitId);
  const deleteMenu = useDeleteMenu(unitId);

  const [tab, setTab] = useState<Tab>("galeria");

  if (isLoading || !menu) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const publicUrl = `${window.location.origin}/m/${menu.slug}`;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbCardapios current={menu.name} />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild>
              <Link
                to={`/g/${unitSlug}/cardapios/meus-cardapios`}
                aria-label="Voltar"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="text-2xl font-bold">{menu.name}</h1>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                menu.active
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {menu.active ? "Ativo" : "Inativo"}
            </span>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" /> Excluir cardápio
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir cardápio?</AlertDialogTitle>
                <AlertDialogDescription>
                  O link público <code>/m/{menu.slug}</code> deixará de funcionar e
                  todas as páginas serão removidas.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() =>
                    deleteMenu.mutate(menu.id, {
                      onSuccess: () => {
                        toast.success("Cardápio excluído.");
                        navigate(`/g/${unitSlug}/cardapios/meus-cardapios`);
                      },
                    })
                  }
                >
                  Excluir
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex border-b">
          <TabButton
            active={tab === "compartilhamento"}
            onClick={() => setTab("compartilhamento")}
          >
            Compartilhamento
          </TabButton>
          <TabButton active={tab === "galeria"} onClick={() => setTab("galeria")}>
            Galeria
          </TabButton>
          <TabButton
            active={tab === "personalizacao"}
            onClick={() => setTab("personalizacao")}
          >
            Personalização
          </TabButton>
        </div>

        <div className="p-6">
          {tab === "compartilhamento" && (
            <ShareTab
              publicUrl={publicUrl}
              menu={menu}
              onSave={(payload) =>
                updateMenu.mutate(
                  { id: menu.id, ...payload },
                  {
                    onSuccess: () => toast.success("Cardápio atualizado."),
                    onError: (err: Error) =>
                      toast.error(err.message ?? "Erro ao salvar."),
                  },
                )
              }
              saving={updateMenu.isPending}
              unitId={unitId}
            />
          )}
          {tab === "galeria" && (
            <MenuPagesEditor menuId={menu.id} unitId={unitId} />
          )}
          {tab === "personalizacao" && (
            <PersonalizationTab
              theme={menu.theme}
              onSave={(theme) =>
                updateMenu.mutate(
                  { id: menu.id, theme },
                  {
                    onSuccess: () => toast.success("Cores salvas."),
                    onError: (err: Error) =>
                      toast.error(err.message ?? "Erro ao salvar."),
                  },
                )
              }
              saving={updateMenu.isPending}
            />
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── Tab: Compartilhamento ────────────────────────────────────────────────────

function ShareTab({
  publicUrl,
  menu,
  onSave,
  saving,
  unitId,
}: {
  publicUrl: string;
  menu: { name: string; cover_image_url: string | null; active: boolean };
  onSave: (payload: {
    name?: string;
    cover_image_url?: string | null;
    active?: boolean;
  }) => void;
  saving: boolean;
  unitId: string;
}) {
  const upload = useUnitAssetUpload();
  const [name, setName] = useState(menu.name);
  const [coverUrl, setCoverUrl] = useState<string | null>(menu.cover_image_url);
  const [active, setActive] = useState(menu.active);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(menu.name);
    setCoverUrl(menu.cover_image_url);
    setActive(menu.active);
  }, [menu]);

  const dirty =
    name.trim() !== menu.name ||
    coverUrl !== menu.cover_image_url ||
    active !== menu.active;

  const handleUpload = async (file: File) => {
    try {
      const { publicUrl } = await upload.mutateAsync({
        unitId,
        kind: "menu_cover",
        file,
      });
      setCoverUrl(publicUrl);
    } catch {
      // toast já mostrado pelo hook
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <ShareCard
        url={publicUrl}
        description="Utilize o link abaixo para compartilhar o cardápio."
      />

      <div className="border-t pt-6 space-y-4">
        <h3 className="text-base font-semibold">Detalhes do cardápio</h3>

        <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4 items-start">
          <div className="space-y-1">
            <Label className="text-xs">Capa</Label>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full aspect-[2/1] bg-muted rounded-md border-2 border-dashed border-border hover:border-primary/40 transition-colors flex flex-col items-center justify-center text-muted-foreground overflow-hidden"
            >
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt="Cover"
                  className="w-full h-full object-cover"
                />
              ) : (
                <>
                  <Camera className="h-6 w-6 mb-1" />
                  <span className="text-[10px]">400 × 200 px</span>
                </>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = "";
              }}
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="active-switch"
                checked={active}
                onCheckedChange={setActive}
              />
              <Label htmlFor="active-switch" className="text-sm">
                Cardápio ativo (visível no link público)
              </Label>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() =>
              onSave({
                name: name.trim(),
                cover_image_url: coverUrl,
                active,
              })
            }
            disabled={!dirty || saving || upload.isPending || !name.trim()}
          >
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Personalização ──────────────────────────────────────────────────────

function PersonalizationTab({
  theme,
  onSave,
  saving,
}: {
  theme: MenuTheme;
  onSave: (theme: MenuTheme) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<MenuTheme>(theme ?? DEFAULT_MENU_THEME);

  useEffect(() => {
    setDraft(theme ?? DEFAULT_MENU_THEME);
  }, [theme]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(theme);

  return (
    <div className="space-y-6">
      <ThemeEditor value={draft} onChange={setDraft} />

      <div className="flex justify-end">
        <Button onClick={() => onSave(draft)} disabled={!dirty || saving}>
          {saving ? "Salvando…" : "Salvar alterações"}
        </Button>
      </div>
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
