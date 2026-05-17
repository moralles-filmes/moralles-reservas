import { useRef, useState } from "react";
import {
  useUnitAssetUpload,
  type UploadAssetResult,
} from "@/hooks/useUnitAssetUpload";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, ImagePlus, Loader2, Trash2, Upload } from "lucide-react";

const MAX_PHOTOS = 5;

export interface GalleryEditorProps {
  unitId: string;
  value: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
  // Notifica o parent de cada upload bem-sucedido (path interno + publicUrl),
  // permitindo rastrear arquivos enviados na sessão para limpar órfãos
  // no save (ver Conta.tsx handleSave).
  onUploaded?: (result: UploadAssetResult) => void;
}

export function GalleryEditor({
  unitId,
  value,
  onChange,
  disabled,
  onUploaded,
}: GalleryEditorProps) {
  const upload = useUnitAssetUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);

  const canAddMore = value.length < MAX_PHOTOS && !disabled;
  const isBusy = upload.isPending;

  const openPicker = () => {
    if (!canAddMore || isBusy) return;
    inputRef.current?.click();
  };

  const handleFile = async (file: File) => {
    if (!unitId) return;
    const localPreview = URL.createObjectURL(file);
    setPendingPreview(localPreview);
    try {
      const result = await upload.mutateAsync({ unitId, kind: "gallery_photo", file });
      onChange([...value, result.publicUrl]);
      onUploaded?.(result);
    } finally {
      URL.revokeObjectURL(localPreview);
      setPendingPreview(null);
    }
  };

  const removeAt = (idx: number) => {
    if (disabled) return;
    onChange(value.filter((_, i) => i !== idx));
  };

  const moveUp = (idx: number) => {
    if (disabled || idx <= 0) return;
    const next = [...value];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  };

  const moveDown = (idx: number) => {
    if (disabled || idx >= value.length - 1) return;
    const next = [...value];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {value.map((url, idx) => (
          <div
            key={url}
            className="relative aspect-square rounded-md overflow-hidden bg-muted/30 border border-border group"
          >
            <img
              src={url}
              alt={`Foto ${idx + 1}`}
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
            {!disabled && (
              <>
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  className="absolute top-1.5 right-1.5 h-9 w-9 rounded-full bg-background/90 hover:bg-destructive hover:text-destructive-foreground text-foreground flex items-center justify-center shadow-sm transition-colors"
                  title="Remover foto"
                  aria-label="Remover foto"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <div className="absolute bottom-1.5 left-1.5 flex gap-1">
                  <button
                    type="button"
                    onClick={() => moveUp(idx)}
                    disabled={idx === 0}
                    className="h-9 w-9 rounded-full bg-background/90 hover:bg-primary hover:text-primary-foreground text-foreground flex items-center justify-center shadow-sm transition-colors disabled:opacity-40 disabled:hover:bg-background/90 disabled:hover:text-foreground"
                    title="Mover para trás"
                    aria-label="Mover para trás"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDown(idx)}
                    disabled={idx === value.length - 1}
                    className="h-9 w-9 rounded-full bg-background/90 hover:bg-primary hover:text-primary-foreground text-foreground flex items-center justify-center shadow-sm transition-colors disabled:opacity-40 disabled:hover:bg-background/90 disabled:hover:text-foreground"
                    title="Mover para frente"
                    aria-label="Mover para frente"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
                {idx === 0 && (
                  <span className="absolute top-1.5 left-1.5 text-[10px] uppercase tracking-wider bg-background/90 text-foreground rounded px-1.5 py-0.5 shadow-sm">
                    Capa
                  </span>
                )}
              </>
            )}
          </div>
        ))}

        {pendingPreview && (
          <div className="relative aspect-square rounded-md overflow-hidden bg-muted/30 border border-border">
            <img
              src={pendingPreview}
              alt="Enviando..."
              className="absolute inset-0 w-full h-full object-cover opacity-60"
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          </div>
        )}

        {canAddMore && !pendingPreview && (
          <button
            type="button"
            onClick={openPicker}
            disabled={isBusy}
            className="relative aspect-square rounded-md border-2 border-dashed border-border bg-muted/20 hover:bg-muted/40 hover:border-primary/50 transition-colors flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ImagePlus className="h-7 w-7 opacity-60" />
            <span className="text-xs">Adicionar foto</span>
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          {value.length} de {MAX_PHOTOS} fotos.
          {value.length >= MAX_PHOTOS && !disabled && " Remova uma para adicionar outra."}
        </p>
        {canAddMore && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openPicker}
            disabled={isBusy}
            className="gap-2"
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Enviar foto
          </Button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        className="hidden"
        aria-label="Enviar foto para a galeria"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
