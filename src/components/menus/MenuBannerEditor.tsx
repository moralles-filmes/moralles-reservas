import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { Camera, GripVertical, Trash2 } from "lucide-react";
import { useUnitAssetUpload } from "@/hooks/useUnitAssetUpload";
import {
  useUpdateMenuBanner,
  useDeleteMenuBanner,
} from "@/hooks/useMenuBanners";
import type { MenuBanner, MenuBannerType } from "@/types/reserva";
import { toast } from "sonner";

const DIMENSION_HINT: Record<MenuBannerType, string> = {
  home: "1080 × 1919 px",
  content: "1080 × 1080 px",
};

const ASPECT: Record<MenuBannerType, string> = {
  home: "aspect-[9/16]",
  content: "aspect-square",
};

export interface MenuBannerEditorProps {
  banner: MenuBanner;
  unitId: string;
  type: MenuBannerType;
}

export function MenuBannerEditor({ banner, unitId, type }: MenuBannerEditorProps) {
  const update = useUpdateMenuBanner(unitId, type);
  const remove = useDeleteMenuBanner(unitId, type);
  const upload = useUnitAssetUpload();
  const fileRef = useRef<HTMLInputElement>(null);

  const [imageUrl, setImageUrl] = useState(banner.image_url);
  const [linkUrl, setLinkUrl] = useState(banner.link_url ?? "");
  const [active, setActive] = useState(banner.active);

  useEffect(() => {
    setImageUrl(banner.image_url);
    setLinkUrl(banner.link_url ?? "");
    setActive(banner.active);
  }, [banner]);

  const dirty =
    imageUrl !== banner.image_url ||
    (linkUrl || null) !== banner.link_url ||
    active !== banner.active;

  const handleUpload = async (file: File) => {
    try {
      const { publicUrl } = await upload.mutateAsync({
        unitId,
        kind: type === "home" ? "menu_banner_home" : "menu_banner_content",
        file,
      });
      setImageUrl(publicUrl);
    } catch {
      // toast já mostrado pelo hook
    }
  };

  const handleSave = () => {
    if (!imageUrl) {
      toast.error("Adicione uma imagem ao banner.");
      return;
    }
    update.mutate(
      {
        id: banner.id,
        image_url: imageUrl,
        link_url: linkUrl.trim() || null,
        active,
      },
      {
        onSuccess: () => toast.success("Banner salvo."),
        onError: (err: Error) => toast.error(err.message ?? "Erro ao salvar."),
      },
    );
  };

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GripVertical className="h-3.5 w-3.5" />
          <span>Banner</span>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive"
              aria-label="Remover banner"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remover este banner?</AlertDialogTitle>
              <AlertDialogDescription>
                O banner será removido permanentemente.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => remove.mutate(banner.id)}
              >
                Remover
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className={`w-full ${ASPECT[type]} bg-muted rounded-md border-2 border-dashed border-border hover:border-primary/40 transition-colors flex flex-col items-center justify-center text-muted-foreground overflow-hidden`}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Banner"
            className="w-full h-full object-cover"
          />
        ) : (
          <>
            <Camera className="h-6 w-6 mb-1.5" />
            <span className="text-xs">{DIMENSION_HINT[type]}</span>
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

      <div className="space-y-1">
        <Label className="text-xs">Link</Label>
        <Input
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder="https://google.com"
          className="text-sm"
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor={`active-${banner.id}`} className="text-xs">
          Ativo
        </Label>
        <Switch
          id={`active-${banner.id}`}
          checked={active}
          onCheckedChange={setActive}
        />
      </div>

      <Button
        size="sm"
        onClick={handleSave}
        disabled={!dirty || update.isPending || upload.isPending}
        className="w-full"
      >
        {update.isPending ? "Salvando…" : "Salvar"}
      </Button>
    </Card>
  );
}
