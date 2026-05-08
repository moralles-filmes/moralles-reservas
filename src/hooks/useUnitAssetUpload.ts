import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export type AssetKind =
  | "logo"
  | "hero"
  | "menu_cover"
  | "menu_page"
  | "menu_banner_home"
  | "menu_banner_content";

const MAX_BYTES: Record<AssetKind, number> = {
  logo: 1 * 1024 * 1024,
  hero: 4 * 1024 * 1024,
  menu_cover: 4 * 1024 * 1024,
  menu_page: 8 * 1024 * 1024,
  menu_banner_home: 4 * 1024 * 1024,
  menu_banner_content: 4 * 1024 * 1024,
};

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];

export interface UploadAssetInput {
  unitId: string;
  kind: AssetKind;
  file: File;
}

export interface UploadAssetResult {
  publicUrl: string;
  path: string;
}

export function useUnitAssetUpload() {
  return useMutation<UploadAssetResult, Error, UploadAssetInput>({
    mutationFn: async ({ unitId, kind, file }) => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        throw new Error("Formato não suportado. Use JPG, PNG, WebP ou AVIF.");
      }
      if (file.size > MAX_BYTES[kind]) {
        const limitMb = MAX_BYTES[kind] / (1024 * 1024);
        throw new Error(`Arquivo muito grande. Limite: ${limitMb}MB.`);
      }

      const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
      const path = `${unitId}/${kind}-${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from("unit-assets")
        .upload(path, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: file.type,
        });
      if (uploadErr) throw uploadErr;

      const { data } = supabase.storage.from("unit-assets").getPublicUrl(path);
      return { publicUrl: data.publicUrl, path };
    },
    onError: (err) => {
      toast.error(err.message || "Erro ao enviar imagem.");
    },
  });
}
