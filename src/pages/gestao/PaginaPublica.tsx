import { useEffect, useRef, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useUnitPublicContent,
  useUpdateUnitPublicContent,
} from "@/hooks/useUnitPublicContent";
import { useUnitAssetUpload, type AssetKind } from "@/hooks/useUnitAssetUpload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { ExternalLink, ImagePlus, Loader2, Trash2, Upload } from "lucide-react";
import type { UnitAddress } from "@/types/reserva";

const DESCRIPTION_MAX = 800;

interface AddressFormState {
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
  cep: string;
}

const EMPTY_ADDRESS: AddressFormState = {
  street: "",
  number: "",
  neighborhood: "",
  city: "",
  state: "",
  cep: "",
};

function buildFullAddress(addr: AddressFormState): string {
  const parts: string[] = [];
  const line1 = [addr.street, addr.number].filter(Boolean).join(", ");
  if (line1) parts.push(line1);
  if (addr.neighborhood) parts.push(addr.neighborhood);
  const cityState = [addr.city, addr.state].filter(Boolean).join("-");
  if (cityState) parts.push(cityState);
  if (addr.cep) parts.push(addr.cep);
  return parts.join(", ");
}

function addressToForm(a: UnitAddress | null | undefined): AddressFormState {
  if (!a) return { ...EMPTY_ADDRESS };
  return {
    street: a.street ?? "",
    number: a.number ?? "",
    neighborhood: a.neighborhood ?? "",
    city: a.city ?? "",
    state: a.state ?? "",
    cep: a.cep ?? "",
  };
}

export default function PaginaPublica() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";

  const { data: content, isLoading } = useUnitPublicContent(unitId);
  const update = useUpdateUnitPublicContent(unitId);

  const [description, setDescription] = useState("");
  const [priceMin, setPriceMin] = useState<string>("");
  const [priceMax, setPriceMax] = useState<string>("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  const [address, setAddress] = useState<AddressFormState>(EMPTY_ADDRESS);

  useEffect(() => {
    if (!content) return;
    setDescription(content.description ?? "");
    setPriceMin(content.price_range_min != null ? String(content.price_range_min) : "");
    setPriceMax(content.price_range_max != null ? String(content.price_range_max) : "");
    setLogoUrl(content.logo_url);
    setHeroUrl(content.hero_image_url);
    setAddress(addressToForm(content.address));
  }, [content]);

  const handleSave = () => {
    const min = priceMin.trim() ? Number(priceMin.replace(",", ".")) : null;
    const max = priceMax.trim() ? Number(priceMax.replace(",", ".")) : null;
    if (min != null && Number.isNaN(min)) return toast.error("Preço mínimo inválido.");
    if (max != null && Number.isNaN(max)) return toast.error("Preço máximo inválido.");
    if (min != null && max != null && min > max) {
      return toast.error("Preço mínimo não pode ser maior que o máximo.");
    }

    const fullAddress: UnitAddress | null = (() => {
      const hasAny = Object.values(address).some((v) => v.trim().length > 0);
      if (!hasAny) return null;
      return {
        street: address.street.trim() || null,
        number: address.number.trim() || null,
        neighborhood: address.neighborhood.trim() || null,
        city: address.city.trim() || null,
        state: address.state.trim().toUpperCase() || null,
        cep: address.cep.trim() || null,
        full: buildFullAddress(address),
      };
    })();

    update.mutate({
      description: description.trim() || null,
      price_range_min: min,
      price_range_max: max,
      hero_image_url: heroUrl,
      logo_url: logoUrl,
      address: fullAddress,
    });
  };

  if (!unit) return null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Página pública</h1>
          <p className="text-sm text-muted-foreground">
            Personalize como o {unit.unit_name} aparece para os clientes em
            <code className="mx-1 text-xs">/r/{unitSlug}</code>.
          </p>
        </div>
        <a
          href={`/r/${unitSlug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex"
        >
          <Button variant="outline" size="sm" className="gap-2">
            <ExternalLink className="h-4 w-4" />
            Ver página pública
          </Button>
        </a>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Identidade visual</CardTitle>
              <p className="text-sm text-muted-foreground">
                A foto principal aparece como hero da página. O logo aparece sobre o hero e
                em cards.
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              <AssetUploader
                kind="hero"
                label="Foto principal"
                helper="Recomendado 16:9, mínimo 1200×675px. Até 4MB."
                aspect="aspect-[16/9]"
                unitId={unitId}
                value={heroUrl}
                onChange={setHeroUrl}
              />
              <Separator />
              <AssetUploader
                kind="logo"
                label="Logo"
                helper="Quadrado, fundo transparente. Até 1MB."
                aspect="aspect-square w-32"
                unitId={unitId}
                value={logoUrl}
                onChange={setLogoUrl}
                rounded
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sobre o restaurante</CardTitle>
              <p className="text-sm text-muted-foreground">
                Conte em poucas linhas o que torna o lugar especial — tipo de cozinha,
                ambiente, diferenciais.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
                rows={6}
                placeholder="Ex: Casa de massas artesanais com forno a lenha, menu degustação aos sábados e carta de vinhos italianos selecionada pelo sommelier..."
              />
              <p className="text-xs text-muted-foreground text-right">
                {description.length}/{DESCRIPTION_MAX}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Faixa de preço</CardTitle>
              <p className="text-sm text-muted-foreground">
                Ticket médio por pessoa. Aparece como “de R$ X até R$ Y” na página.
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 max-w-sm">
                <div className="space-y-1">
                  <Label>Mínimo (R$)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={priceMin}
                    onChange={(e) => setPriceMin(e.target.value)}
                    placeholder="80"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Máximo (R$)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={priceMax}
                    onChange={(e) => setPriceMax(e.target.value)}
                    placeholder="150"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Endereço</CardTitle>
              <p className="text-sm text-muted-foreground">
                Usado em “Como chegar” e no mapa do Google Maps.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1">
                  <Label>Rua / Avenida</Label>
                  <Input
                    value={address.street}
                    onChange={(e) => setAddress({ ...address, street: e.target.value })}
                    placeholder="Avenida Paulista"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Número</Label>
                  <Input
                    value={address.number}
                    onChange={(e) => setAddress({ ...address, number: e.target.value })}
                    placeholder="1000"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Bairro</Label>
                  <Input
                    value={address.neighborhood}
                    onChange={(e) => setAddress({ ...address, neighborhood: e.target.value })}
                    placeholder="Bela Vista"
                  />
                </div>
                <div className="space-y-1">
                  <Label>CEP</Label>
                  <Input
                    value={address.cep}
                    onChange={(e) => setAddress({ ...address, cep: e.target.value })}
                    placeholder="01310-100"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1">
                  <Label>Cidade</Label>
                  <Input
                    value={address.city}
                    onChange={(e) => setAddress({ ...address, city: e.target.value })}
                    placeholder="São Paulo"
                  />
                </div>
                <div className="space-y-1">
                  <Label>UF</Label>
                  <Input
                    maxLength={2}
                    value={address.state}
                    onChange={(e) =>
                      setAddress({ ...address, state: e.target.value.toUpperCase() })
                    }
                    placeholder="SP"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="sticky bottom-0 -mx-6 px-6 py-4 bg-background/90 backdrop-blur border-t flex items-center justify-end gap-2">
            <Button onClick={handleSave} disabled={update.isPending} size="lg">
              {update.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Salvando...
                </>
              ) : (
                "Salvar alterações"
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

interface AssetUploaderProps {
  kind: AssetKind;
  label: string;
  helper: string;
  aspect: string;
  unitId: string;
  value: string | null;
  onChange: (url: string | null) => void;
  rounded?: boolean;
}

function AssetUploader({
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
          variant="secondary"
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
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
