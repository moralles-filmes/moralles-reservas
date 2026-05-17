import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { GripVertical, Image as ImageIcon, Trash2, Upload } from "lucide-react";
import { useUnitAssetUpload } from "@/hooks/useUnitAssetUpload";
import {
  useAddMenuPage,
  useDeleteMenuPage,
  useMenuPages,
  useReorderMenuPages,
} from "@/hooks/useMenuPages";
import { toast } from "sonner";

export interface MenuPagesEditorProps {
  menuId: string;
  unitId: string;
}

export function MenuPagesEditor({ menuId, unitId }: MenuPagesEditorProps) {
  const { data: pages, isLoading } = useMenuPages(menuId);
  const upload = useUnitAssetUpload();
  const addPage = useAddMenuPage(menuId);
  const deletePage = useDeleteMenuPage(menuId);
  const reorder = useReorderMenuPages(menuId);

  const fileRef = useRef<HTMLInputElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const baseOrder = pages?.length ?? 0;
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const { publicUrl } = await upload.mutateAsync({
          unitId,
          kind: "menu_page",
          file,
        });
        await addPage.mutateAsync({
          image_url: publicUrl,
          sort_order: baseOrder + okCount,
        });
        okCount++;
      } catch {
        // hook de upload (ou addPage) já dispara toast.error específico
        failCount++;
      }
    }
    if (fileRef.current) fileRef.current.value = "";
    if (okCount > 0 && failCount === 0) {
      toast.success(`${okCount} ${okCount === 1 ? "imagem adicionada" : "imagens adicionadas"}.`);
    } else if (okCount > 0 && failCount > 0) {
      toast.warning(`${okCount} adicionada${okCount === 1 ? "" : "s"}, ${failCount} falharam.`);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId || !pages) {
      setDragId(null);
      return;
    }
    const oldIdx = pages.findIndex((p) => p.id === dragId);
    const newIdx = pages.findIndex((p) => p.id === targetId);
    if (oldIdx < 0 || newIdx < 0) {
      setDragId(null);
      return;
    }
    const next = [...pages];
    const [moved] = next.splice(oldIdx, 1);
    next.splice(newIdx, 0, moved);
    try {
      await reorder.mutateAsync(next.map((p) => p.id));
    } catch {
      toast.error("Falha ao reordenar. Tente novamente.");
    } finally {
      setDragId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Galeria do cardápio</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Suba as páginas do cardápio em ordem. Arraste para reordenar. Limite 8MB
            por imagem.
          </p>
        </div>
        <Button
          onClick={() => fileRef.current?.click()}
          disabled={upload.isPending || addPage.isPending}
          className="gap-2 shrink-0"
        >
          <Upload className="h-4 w-4" />
          {upload.isPending ? "Enviando…" : "Adicionar imagens"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="aspect-[3/4] w-full rounded-md" />
          ))}
        </div>
      ) : !pages?.length ? (
        <Card className="py-12 text-center text-sm text-muted-foreground">
          <ImageIcon className="h-8 w-8 mx-auto opacity-30 mb-2" />
          Nenhuma página adicionada ainda. Comece subindo as imagens do cardápio.
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {pages.map((p, idx) => (
            <Card
              key={p.id}
              draggable
              onDragStart={() => setDragId(p.id)}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(p.id)}
              onDragEnd={() => setDragId(null)}
              className={`relative overflow-hidden cursor-move group transition-opacity ${
                dragId === p.id ? "opacity-50" : ""
              }`}
            >
              <div className="aspect-[3/4] bg-muted">
                <img
                  src={p.image_url}
                  alt={`Página ${idx + 1}`}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="absolute top-2 left-2 bg-background/90 rounded-full px-2 py-0.5 text-[10px] font-bold flex items-center gap-1">
                <GripVertical className="h-3 w-3" />
                {idx + 1}
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className="absolute top-2 right-2 bg-background/90 hover:bg-destructive hover:text-destructive-foreground rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Remover"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remover esta página?</AlertDialogTitle>
                    <AlertDialogDescription>
                      A imagem será removida do cardápio público.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => deletePage.mutate(p.id)}
                    >
                      Remover
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
