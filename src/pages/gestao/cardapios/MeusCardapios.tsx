import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useCreateMenu, useMenus } from "@/hooks/useMenus";
import { useUnitAssetUpload } from "@/hooks/useUnitAssetUpload";
import { deleteUnitAssetsByUrls } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookOpen, Camera, Loader2, Plus } from "lucide-react";
import { ShareCard } from "@/components/share/ShareCard";
import { DownloadCard } from "@/components/share/DownloadCard";
import { toast } from "sonner";
import type { Menu } from "@/types/reserva";
import { BreadcrumbCardapios } from "./Banners";

export default function MeusCardapios() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const { data: menus, isLoading } = useMenus(unitId);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);

  const activeMenus = useMemo(
    () => (menus ?? []).filter((m) => m.active),
    [menus],
  );

  // Default = primeiro cardápio ativo
  useEffect(() => {
    if (selectedMenuId) return;
    if (activeMenus.length > 0) setSelectedMenuId(activeMenus[0].id);
  }, [activeMenus, selectedMenuId]);

  const selectedMenu =
    menus?.find((m) => m.id === selectedMenuId) ?? activeMenus[0] ?? null;
  const publicUrl = selectedMenu
    ? `${window.location.origin}/m/${selectedMenu.slug}`
    : "";

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbCardapios current="Meus cardápios" />
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Cardápios</h1>
          <Button size="sm" className="gap-2" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> Adicionar Cardápio
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        <Card className="p-0 overflow-hidden">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : !menus?.length ? (
            <div className="py-16 text-center text-sm text-muted-foreground space-y-2">
              <BookOpen className="h-8 w-8 mx-auto opacity-30" />
              <p>Nenhum cardápio encontrado</p>
              <button
                className="text-primary underline"
                onClick={() => setCreateOpen(true)}
              >
                Criar o primeiro
              </button>
            </div>
          ) : (
            <div className="divide-y">
              {menus.map((m) => (
                <MenuRow key={m.id} menu={m} unitSlug={unitSlug} />
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-3">
          {!menus?.length ? (
            <Card className="p-5 space-y-2 opacity-60">
              <h3 className="text-sm font-semibold">Compartilhar cardápio</h3>
              <p className="text-xs text-muted-foreground">
                Crie um cardápio para gerar o link de compartilhamento.
              </p>
            </Card>
          ) : (
            <>
              {menus.length > 1 && (
                <Card className="p-4 space-y-2">
                  <Label className="text-xs">Cardápio selecionado</Label>
                  <Select
                    value={selectedMenuId ?? ""}
                    onValueChange={(v) => setSelectedMenuId(v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione…" />
                    </SelectTrigger>
                    <SelectContent>
                      {menus.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Card>
              )}

              {selectedMenu && (
                <Card className="p-5 space-y-2">
                  <h3 className="text-sm font-semibold">Compartilhar cardápio</h3>
                  <p className="text-xs text-muted-foreground">
                    Link público para compartilhar em redes sociais ou mensagem.
                  </p>
                  <ShareCard url={publicUrl} title="" description="" />
                </Card>
              )}

              {selectedMenu && (
                <DownloadCard
                  url={publicUrl}
                  title="Qr Code"
                  description="Divulgue seus cardápios usando o QR Code. Você também pode usar nosso modelo para gerar um display de mesa."
                  fileName={`qr-cardapio-${selectedMenu.slug}.png`}
                />
              )}
            </>
          )}
        </div>
      </div>

      <CreateMenuDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        unitId={unitId}
        unitName={unit?.unit_name ?? ""}
      />
    </div>
  );
}

// ─── Menu row ──────────────────────────────────────────────────────────────────

function MenuRow({ menu, unitSlug }: { menu: Menu; unitSlug: string }) {
  return (
    <Link
      to={`/g/${unitSlug}/cardapios/meus-cardapios/${menu.id}`}
      className="flex items-center gap-4 p-4 hover:bg-muted/40 transition-colors"
    >
      <div className="h-14 w-24 rounded-md bg-muted overflow-hidden shrink-0">
        {menu.cover_image_url ? (
          <img
            src={menu.cover_image_url}
            alt={menu.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <BookOpen className="h-5 w-5 opacity-50" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{menu.name}</p>
        <p className="text-xs text-muted-foreground font-mono">/m/{menu.slug}</p>
      </div>
      <span
        className={`text-xs ${
          menu.active ? "text-success" : "text-muted-foreground"
        }`}
      >
        {menu.active ? "Ativo" : "Inativo"}
      </span>
    </Link>
  );
}

// ─── Modal Adicionar Cardápio ──────────────────────────────────────────────────

function CreateMenuDialog({
  open,
  onOpenChange,
  unitId,
  unitName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: string;
  unitName: string;
}) {
  const createMenu = useCreateMenu(unitId);
  const upload = useUnitAssetUpload();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  // URLs upadas nesta sessão. Cleanup ocorre quando o usuário fecha o
  // dialog sem criar (cancela), ou cria com uma capa diferente da inicial
  // (caso ele troque a foto múltiplas vezes antes de finalizar).
  const uploadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      setName("");
      setCoverUrl(null);
      uploadedRef.current.clear();
    }
  }, [open]);

  const handleUpload = async (file: File) => {
    try {
      const { publicUrl } = await upload.mutateAsync({
        unitId,
        kind: "menu_cover",
        file,
      });
      uploadedRef.current.add(publicUrl);
      setCoverUrl(publicUrl);
    } catch {
      // toast já mostrado pelo hook
    }
  };

  // Apaga do bucket todas as URLs upadas que não bateram com a capa final
  // (saved). Não bloqueia close — fire-and-forget.
  const cleanupOrphans = (finalUrl: string | null) => {
    const toRemove: string[] = [];
    for (const url of uploadedRef.current) {
      if (url !== finalUrl) toRemove.push(url);
    }
    uploadedRef.current.clear();
    if (toRemove.length > 0) {
      void deleteUnitAssetsByUrls(toRemove, unitId);
    }
  };

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Informe o nome do cardápio.");
      return;
    }
    createMenu.mutate(
      { name: trimmed, cover_image_url: coverUrl },
      {
        onSuccess: () => {
          toast.success("Cardápio criado.");
          // Mantém coverUrl (capa salva), apaga intermediárias.
          cleanupOrphans(coverUrl);
          onOpenChange(false);
        },
        onError: (err: Error) => toast.error(err.message ?? "Erro ao criar."),
      },
    );
  };

  // Intercepta fechamento por X / overlay / ESC / botão Cancelar.
  // Se fechou sem ter criado (uploadedRef ainda com itens), todas são órfãs.
  const handleOpenChange = (next: boolean) => {
    if (!next && open) cleanupOrphans(null);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar Cardápio</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
            className="relative w-full aspect-[2/1] bg-muted rounded-md border-2 border-dashed border-border hover:border-primary/40 transition-colors flex flex-col items-center justify-center text-muted-foreground overflow-hidden disabled:cursor-not-allowed"
          >
            {coverUrl ? (
              <img src={coverUrl} alt="Cover" className="w-full h-full object-cover" />
            ) : (
              <>
                <Camera className="h-7 w-7 mb-1" />
                <span className="text-xs">400 × 200 px</span>
              </>
            )}
            {upload.isPending && (
              <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
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
            <Label className="text-xs">
              <span className="text-destructive">*</span> Nome do Cardápio
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Cardápio principal"
            />
          </div>

          <div className="rounded-md border p-3 bg-muted/30 text-xs text-muted-foreground space-y-1">
            <p>O cardápio será criado vinculado a:</p>
            <p className="font-medium text-foreground">{unitName || "—"}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || createMenu.isPending || upload.isPending}
          >
            {createMenu.isPending ? "Criando…" : "Criar Cardápio"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
