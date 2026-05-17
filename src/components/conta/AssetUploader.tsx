import { useRef, useState } from "react";
import { useUnitAssetUpload, type AssetKind } from "@/hooks/useUnitAssetUpload";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ImagePlus, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

export interface AssetUploaderProps {
  kind: AssetKind;
  label: string;
  helper: string;
  aspect: string;
  unitId: string;
  value: string | null;
  onChange: (url: string | null) => void;
  rounded?: boolean;
}

export function AssetUploader({
  kind,
  label,
  helper,
  aspect,
  unitId,
  value,
  onChange,
  rounded,
}: AssetUploaderProps) {
  const upload = useUnitAssetUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const onPick = () => inputRef.current?.click();

  const onFile = async (file: File) => {
    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);
    try {
      const result = await upload.mutateAsync({ unitId, kind, file });
      onChange(result.publicUrl);
      toast.success("Imagem enviada.");
    } finally {
      URL.revokeObjectURL(localPreview);
      setPreview(null);
    }
  };

  const displayed = preview ?? value;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label>{label}</Label>
        {value && !upload.isPending && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-destructive hover:underline inline-flex items-center gap-1"
          >
            <Trash2 className="h-3 w-3" /> Remover
          </button>
        )}
      </div>
      <div
        className={`relative ${aspect} ${
          rounded ? "rounded-full" : "rounded-lg"
        } border-2 border-dashed border-border bg-muted/30 overflow-hidden flex items-center justify-center`}
      >
        {displayed ? (
          <img
            src={displayed}
            alt={label}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="text-center text-muted-foreground space-y-1 p-4">
            <ImagePlus className="h-8 w-8 mx-auto opacity-50" />
            <p className="text-xs">Nenhuma imagem</p>
          </div>
        )}
        {upload.isPending && (
          <div className="absolute inset-0 bg-background/70 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">{helper}</p>
        <Button
          variant="default"
          size="sm"
          onClick={onPick}
          disabled={upload.isPending}
          className="gap-2"
        >
          <Upload className="h-3.5 w-3.5" />
          {value ? "Trocar" : "Enviar imagem"}
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        className="hidden"
        aria-label={`Enviar ${label}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
