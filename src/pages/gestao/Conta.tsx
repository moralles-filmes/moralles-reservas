import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabase";
import {
  useUnitPublicContent,
  useUpdateUnitPublicContent,
  type UnitPublicContent,
} from "@/hooks/useUnitPublicContent";
import type { UploadAssetResult } from "@/hooks/useUnitAssetUpload";
import { AssetUploader } from "@/components/conta/AssetUploader";
import { GalleryEditor } from "@/components/conta/GalleryEditor";
import { FACILITY_GROUPS } from "@/lib/facilities";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { slugify, formatCnpj, extractStoragePath } from "@/lib/utils";
import { toast } from "sonner";
import { ExternalLink, Loader2, Plus, X } from "lucide-react";
import type { UnitAddress } from "@/types/reserva";

// Slug aceita letras minúsculas/dígitos, separados por hífen — sem hífen
// no início/fim e sem hífens duplos. saveIdentity() exibe toast adequado
// quando o usuário tenta salvar algo fora desse padrão.
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DESCRIPTION_MAX = 800;

const BR_STATES = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO",
  "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI",
  "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

const CUISINE_SUGGESTIONS = [
  "Japonesa", "Italiana", "Brasileira", "Francesa", "Mexicana",
  "Árabe", "Chinesa", "Tailandesa", "Indiana", "Mediterrânea",
  "Vegetariana", "Vegana", "Pizzaria", "Hamburgueria", "Churrascaria",
  "Frutos do mar", "Bar", "Cafeteria", "Contemporânea", "Boteco",
];

const BR_TIMEZONES = [
  { value: "America/Sao_Paulo", label: "São Paulo (UTC-3)" },
  { value: "America/Manaus", label: "Manaus (UTC-4)" },
  { value: "America/Rio_Branco", label: "Rio Branco (UTC-5)" },
  { value: "America/Belem", label: "Belém (UTC-3)" },
  { value: "America/Fortaleza", label: "Fortaleza (UTC-3)" },
  { value: "America/Recife", label: "Recife (UTC-3)" },
  { value: "America/Bahia", label: "Salvador (UTC-3)" },
  { value: "America/Campo_Grande", label: "Campo Grande (UTC-4)" },
  { value: "America/Cuiaba", label: "Cuiabá (UTC-4)" },
  { value: "America/Noronha", label: "Fernando de Noronha (UTC-2)" },
];

interface FormState {
  is_public: boolean;
  name: string;
  slug: string;
  cnpj: string;
  description: string;
  phone: string;
  website: string;
  instagram: string;
  cuisine_types: string[];
  opening_hours_text: string;
  timezone: string;
  ticket_medio: string;
  payment_methods: string;
  financial_email: string;
  address: {
    cep: string;
    street: string;
    number: string;
    neighborhood: string;
    complement: string;
    state: string;
    city: string;
    lat: string;
    lng: string;
  };
  showCoords: boolean;
  hero_image_url: string | null;
  logo_url: string | null;
  gallery_photos: string[];
  facilities: string[];
}

const emptyForm: FormState = {
  is_public: true,
  name: "",
  slug: "",
  cnpj: "",
  description: "",
  phone: "",
  website: "",
  instagram: "",
  cuisine_types: [],
  opening_hours_text: "",
  timezone: "America/Sao_Paulo",
  ticket_medio: "",
  payment_methods: "",
  financial_email: "",
  address: {
    cep: "",
    street: "",
    number: "",
    neighborhood: "",
    complement: "",
    state: "",
    city: "",
    lat: "",
    lng: "",
  },
  showCoords: false,
  hero_image_url: null,
  logo_url: null,
  gallery_photos: [],
  facilities: [],
};

function ticketRange(ticketCents: number | null): string {
  if (ticketCents == null) return "";
  if (ticketCents < 50) return "$";
  if (ticketCents < 100) return "$$";
  if (ticketCents < 200) return "$$$";
  return "$$$$";
}

function buildFullAddress(a: FormState["address"]): string {
  const parts: string[] = [];
  const line1 = [a.street, a.number].filter(Boolean).join(", ");
  if (line1) parts.push(line1);
  if (a.complement) parts.push(a.complement);
  if (a.neighborhood) parts.push(a.neighborhood);
  const cityState = [a.city, a.state].filter(Boolean).join("-");
  if (cityState) parts.push(cityState);
  if (a.cep) parts.push(a.cep);
  return parts.join(", ");
}

function contentToForm(c: UnitPublicContent): FormState {
  const a = c.address ?? null;
  return {
    is_public: c.is_public,
    name: c.name ?? "",
    slug: c.slug ?? "",
    cnpj: c.cnpj ?? "",
    description: c.description ?? "",
    phone: c.phone ?? "",
    website: c.website ?? "",
    instagram: c.instagram ?? "",
    cuisine_types: c.cuisine_types ?? [],
    opening_hours_text: c.opening_hours_text ?? "",
    timezone: c.timezone || "America/Sao_Paulo",
    ticket_medio: c.price_range_max != null ? String(c.price_range_max) : "",
    payment_methods: c.payment_methods ?? "",
    financial_email: c.financial_email ?? "",
    address: {
      cep: a?.cep ?? "",
      street: a?.street ?? "",
      number: a?.number ?? "",
      neighborhood: a?.neighborhood ?? "",
      complement: a?.complement ?? "",
      state: a?.state ?? "",
      city: a?.city ?? "",
      lat: a?.lat != null ? String(a.lat) : "",
      lng: a?.lng != null ? String(a.lng) : "",
    },
    showCoords: !!(a?.lat != null || a?.lng != null),
    hero_image_url: c.hero_image_url,
    logo_url: c.logo_url,
    gallery_photos: c.gallery_photos ?? [],
    facilities: c.facilities ?? [],
  };
}

export default function Conta() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshMemberships } = useAuth();
  const canEdit = unit?.isOwner || unit?.isGerente;

  const { data: content, isLoading } = useUnitPublicContent(unitId);
  const update = useUpdateUnitPublicContent(unitId);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [slugTouched, setSlugTouched] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);
  // Mantém referência ao último `content` aplicado no form. Comparar por
  // referência (e não por id) permite que o form re-absorva dados após
  // refetch da mutation — incluindo normalizações server-side (trim/lower).
  const lastSyncedRef = useRef<UnitPublicContent | null>(null);
  // Rastreia paths uploadados durante a sessão (publicUrl → path interno do
  // bucket). Usado no save pra remover do bucket os arquivos que o usuário
  // enviou mas decidiu não usar (substituiu, removeu, ou trocou de novo).
  // Sem isso, cada upload-then-replace deixa órfão no bucket pra sempre.
  const uploadedRef = useRef<Map<string, string>>(new Map());

  const handleUploaded = (result: UploadAssetResult) => {
    uploadedRef.current.set(result.publicUrl, result.path);
  };

  const isSaving = update.isPending || savingIdentity;

  useEffect(() => {
    if (!content) return;
    if (lastSyncedRef.current === content) return;
    // Não atropela edição em curso: se há save em andamento, espera concluir.
    if (update.isPending || savingIdentity) return;
    lastSyncedRef.current = content;
    setForm(contentToForm(content));
    setSlugTouched(false);
  }, [content, update.isPending, savingIdentity]);

  const ticketCents = useMemo(() => {
    const n = form.ticket_medio.trim() ? Number(form.ticket_medio.replace(",", ".")) : null;
    return n != null && !Number.isNaN(n) ? n : null;
  }, [form.ticket_medio]);
  const faixa = ticketRange(ticketCents);

  if (!unit) return null;

  // Estado vazio: unit existe na URL/membership mas a query devolveu null
  // (unit deletada por outro admin, ou unitId inválido). Sem este guard,
  // o form renderia com emptyForm e o user poderia tentar "salvar" em cima.
  if (!isLoading && !content) {
    return (
      <div className="space-y-6 max-w-4xl">
        <PageHeader
          breadcrumb={[
            { label: "Início", to: `/g/${unitSlug}` },
            { label: "Conta" },
          ]}
          title="Conta"
        />
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <p className="text-base font-medium">Unidade não encontrada.</p>
            <p className="text-sm text-muted-foreground">
              Pode ter sido removida ou o link está incorreto. Volte para a
              listagem e selecione uma unidade válida.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const setAddressField = <K extends keyof FormState["address"]>(
    key: K,
    value: FormState["address"][K],
  ) => setForm((f) => ({ ...f, address: { ...f.address, [key]: value } }));

  const saveIdentity = async () => {
    const trimmedName = form.name.trim();
    const normalizedSlug = form.slug.trim().toLowerCase();
    if (!trimmedName) {
      toast.error("Nome não pode ficar vazio.");
      return false;
    }
    if (!normalizedSlug) {
      toast.error("Slug não pode ficar vazio.");
      return false;
    }
    if (!SLUG_REGEX.test(normalizedSlug)) {
      toast.error("Slug aceita apenas letras minúsculas, números e hífens.");
      return false;
    }
    const oldSlug = unit.unit_slug;
    const nameChanged = trimmedName !== unit.unit_name;
    const slugChanged = normalizedSlug !== oldSlug;
    if (!nameChanged && !slugChanged) return true;

    setSavingIdentity(true);
    try {
      const patch: { name?: string; slug?: string } = {};
      if (nameChanged) patch.name = trimmedName;
      if (slugChanged) patch.slug = normalizedSlug;
      const { error } = await supabase.from("units").update(patch).eq("id", unitId);
      if (error) {
        if (error.code === "23505") {
          toast.error("Esse slug já está em uso por outra unidade.");
        } else {
          toast.error(error.message || "Erro ao atualizar identidade.");
        }
        return false;
      }
      if (nameChanged) {
        // Limpa setting legado pra emails passarem a usar units.name
        await supabase
          .from("settings")
          .delete()
          .eq("unit_id", unitId)
          .eq("key", "restaurant_name");
      }
      await refreshMemberships();
      queryClient.invalidateQueries({ queryKey: ["all-units"] });
      queryClient.invalidateQueries({ queryKey: ["unit-public-content", unitId] });
      queryClient.invalidateQueries({ queryKey: ["public-unit"] });
      queryClient.invalidateQueries({ queryKey: ["public-units"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      if (slugChanged && oldSlug) {
        const nextPath = location.pathname.replace(`/g/${oldSlug}`, `/g/${normalizedSlug}`);
        navigate(nextPath, { replace: true });
      }
      return true;
    } finally {
      setSavingIdentity(false);
    }
  };

  const handleSave = async () => {
    // 1) Identidade (name + slug) — pode falhar com 23505
    const idOk = await saveIdentity();
    if (!idOk) return;

    // 2) Endereço estruturado
    const a = form.address;
    const hasAny = Object.entries(a).some(([k, v]) => k !== "lat" && k !== "lng" && v.trim().length > 0);
    const hasCoords = form.showCoords && (a.lat.trim() || a.lng.trim());
    let addressPayload: UnitAddress | null = null;
    if (hasAny || hasCoords) {
      const lat = hasCoords && a.lat.trim() ? Number(a.lat.replace(",", ".")) : null;
      const lng = hasCoords && a.lng.trim() ? Number(a.lng.replace(",", ".")) : null;
      if (hasCoords && lat != null && Number.isNaN(lat)) {
        toast.error("Latitude inválida.");
        return;
      }
      if (hasCoords && lng != null && Number.isNaN(lng)) {
        toast.error("Longitude inválida.");
        return;
      }
      addressPayload = {
        cep: a.cep.trim() || null,
        street: a.street.trim() || null,
        number: a.number.trim() || null,
        neighborhood: a.neighborhood.trim() || null,
        complement: a.complement.trim() || null,
        city: a.city.trim() || null,
        state: a.state.trim().toUpperCase() || null,
        lat: lat,
        lng: lng,
        full: buildFullAddress(a),
      };
    }

    // 3) Ticket
    const tm = form.ticket_medio.trim() ? Number(form.ticket_medio.replace(",", ".")) : null;
    if (tm != null && Number.isNaN(tm)) {
      toast.error("Ticket médio inválido.");
      return;
    }

    // 4) CNPJ — vazio é ok; quando preenchido, exige 14 dígitos.
    let cnpjFmt: string | null = null;
    if (form.cnpj.trim()) {
      cnpjFmt = formatCnpj(form.cnpj.trim());
      if (!cnpjFmt) {
        toast.error("CNPJ deve ter 14 dígitos.");
        return;
      }
    }

    // 5) E-mail financeiro — vazio é ok; preenchido tem que parecer e-mail.
    const emailRaw = form.financial_email.trim();
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      toast.error("E-mail financeiro inválido.");
      return;
    }

    // 6) Instagram — tira @ inicial pra ficar consistente no banco; portal
    //    público já normaliza no render, mas salvar normalizado evita drift.
    const instagramNorm = form.instagram.trim().replace(/^@+/, "").trim() || null;

    // 7) Website — garante protocolo. "moralles.com.br" → "https://moralles.com.br".
    let websiteNorm: string | null = null;
    const wsRaw = form.website.trim();
    if (wsRaw) {
      websiteNorm = /^https?:\/\//i.test(wsRaw) ? wsRaw : `https://${wsRaw}`;
    }

    // 8) Snapshot dos assets antes de salvar — usado para cleanup pós-mutação.
    const prevHero = content?.hero_image_url ?? null;
    const prevLogo = content?.logo_url ?? null;
    const prevGallery = content?.gallery_photos ?? [];

    try {
      await update.mutateAsync({
        is_public: form.is_public,
        description: form.description.trim() || null,
        cnpj: cnpjFmt,
        phone: form.phone.trim() || null,
        website: websiteNorm,
        instagram: instagramNorm,
        cuisine_types: form.cuisine_types,
        opening_hours_text: form.opening_hours_text.trim() || null,
        timezone: form.timezone,
        // Form tem um único campo "Ticket médio" — gravamos só em
        // price_range_max e deixamos price_range_min nulo. Formatters do
        // portal público (PublicPortal/Index) já tratam esse caso como
        // "até R$ X" em vez de "de R$ X até R$ X".
        price_range_max: tm,
        price_range_min: null,
        payment_methods: form.payment_methods.trim() || null,
        financial_email: emailRaw || null,
        facilities: form.facilities,
        address: addressPayload,
        hero_image_url: form.hero_image_url,
        logo_url: form.logo_url,
        gallery_photos: form.gallery_photos,
      });
    } catch {
      // onError do hook já mostrou toast.
      return;
    }

    // 9) Cleanup best-effort de arquivos órfãos no bucket unit-assets.
    //    Compara URLs antes/depois E inclui arquivos uploadados nesta
    //    sessão que NÃO ficaram no estado final salvo (substituídos,
    //    removidos, ou trocados sem chegar ao save anterior). Falha de
    //    storage não bloqueia UX nem invalida o save bem-sucedido.
    const finalUrls = new Set<string>([
      ...(form.hero_image_url ? [form.hero_image_url] : []),
      ...(form.logo_url ? [form.logo_url] : []),
      ...form.gallery_photos,
    ]);
    const toRemoveSet = new Set<string>();
    const tryAdd = (url: string | null | undefined) => {
      const p = extractStoragePath(url);
      if (p && p.startsWith(`${unitId}/`)) toRemoveSet.add(p);
    };
    // (a) Antigos do DB que sumiram do form
    if (prevHero && prevHero !== form.hero_image_url) tryAdd(prevHero);
    if (prevLogo && prevLogo !== form.logo_url) tryAdd(prevLogo);
    for (const url of prevGallery) {
      if (!finalUrls.has(url)) tryAdd(url);
    }
    // (b) Arquivos uploadados nesta sessão que não chegaram ao estado salvo
    for (const [publicUrl, path] of uploadedRef.current.entries()) {
      if (finalUrls.has(publicUrl)) continue;
      if (path.startsWith(`${unitId}/`)) toRemoveSet.add(path);
    }
    // Limpa o tracker: tudo que ficou salvo agora é "estado oficial" do DB;
    // tudo que não ficou já foi pra fila de remoção.
    uploadedRef.current.clear();

    const toRemove = Array.from(toRemoveSet);
    if (toRemove.length > 0) {
      try {
        const { error: removeErr } = await supabase.storage
          .from("unit-assets")
          .remove(toRemove);
        if (removeErr) {
          // Não interrompe o fluxo — o save no banco já foi OK.
          console.warn(
            "[Conta] falha ao remover assets antigos:",
            removeErr.message,
            { paths: toRemove },
          );
        }
      } catch (err) {
        // Falha de rede / exceção inesperada. Save permanece válido.
        console.warn("[Conta] exceção ao remover assets antigos:", err);
      }
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader
        breadcrumb={[
          { label: "Início", to: `/g/${unitSlug}` },
          { label: "Conta" },
        ]}
        title="Conta"
        description="Dados da unidade que aparecem para clientes, em e-mails e no portal público."
      >
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
      </PageHeader>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (
        <Tabs defaultValue="geral" className="space-y-4">
          <TabsList>
            <TabsTrigger value="geral">Geral</TabsTrigger>
            <TabsTrigger value="endereco">Endereço</TabsTrigger>
            <TabsTrigger value="fotos">Fotos</TabsTrigger>
            <TabsTrigger value="facilidades">Facilidades</TabsTrigger>
          </TabsList>

          {/* ─────────────────── GERAL ─────────────────── */}
          <TabsContent value="geral" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Visibilidade pública</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-3">
                  <Switch
                    aria-label="Exibir na listagem pública"
                    checked={form.is_public}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, is_public: v }))}
                    disabled={!canEdit}
                  />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Exibir na listagem pública</p>
                    <p className="text-xs text-muted-foreground">
                      Quando desligado, o restaurante some da página de descoberta e do portal público.
                      O painel administrativo continua acessível.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Identificação</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Nome aparece em e-mails, WhatsApp e portal. Slug é a URL pública — alterar
                  invalida QR codes impressos e links já enviados.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Nome da unidade</Label>
                    <Input
                      value={form.name}
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm((f) => ({
                          ...f,
                          name: v,
                          slug: slugTouched ? f.slug : slugify(v),
                        }));
                      }}
                      placeholder="Ex: Moralles Centro"
                      disabled={!canEdit || isSaving}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Slug (URL pública)</Label>
                    <Input
                      value={form.slug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setForm((f) => ({
                          ...f,
                          slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                        }));
                      }}
                      placeholder="moralles-centro"
                      disabled={!canEdit || isSaving}
                      className="font-mono"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label>CNPJ</Label>
                  <Input
                    value={form.cnpj}
                    onChange={(e) => setForm((f) => ({ ...f, cnpj: e.target.value }))}
                    placeholder="00.000.000/0000-00"
                    disabled={!canEdit}
                  />
                </div>

                <div className="space-y-1">
                  <Label>Descrição</Label>
                  <Textarea
                    value={form.description}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, description: e.target.value.slice(0, DESCRIPTION_MAX) }))
                    }
                    rows={4}
                    placeholder="O que torna o lugar especial — ambiente, especialidades, diferenciais..."
                    disabled={!canEdit}
                  />
                  <p className="text-xs text-muted-foreground text-right">
                    {form.description.length}/{DESCRIPTION_MAX}
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contato</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Telefone</Label>
                    <Input
                      value={form.phone}
                      onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                      placeholder="(11) 3000-0000"
                      disabled={!canEdit}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Instagram</Label>
                    <Input
                      value={form.instagram}
                      onChange={(e) => setForm((f) => ({ ...f, instagram: e.target.value }))}
                      placeholder="@morallesrestaurante"
                      disabled={!canEdit}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>Website</Label>
                  <Input
                    value={form.website}
                    onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                    placeholder="https://moralles.com.br"
                    disabled={!canEdit}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Categoria e operação</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Tipo de cozinha</Label>
                  <CuisineMultiSelect
                    value={form.cuisine_types}
                    onChange={(v) => setForm((f) => ({ ...f, cuisine_types: v }))}
                    disabled={!canEdit}
                  />
                </div>

                <div className="space-y-1">
                  <Label>Horário de funcionamento</Label>
                  <Textarea
                    value={form.opening_hours_text}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, opening_hours_text: e.target.value }))
                    }
                    rows={4}
                    placeholder={"Seg a Sex: 11h-15h, 19h-23h\nSáb e Dom: 12h-23h"}
                    disabled={!canEdit}
                  />
                  <p className="text-xs text-muted-foreground">
                    Texto livre exibido no portal público. Os horários de reserva são configurados
                    em Reservas → Salões.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Fuso horário</Label>
                    <Select
                      value={form.timezone}
                      onValueChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
                      disabled={!canEdit}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione" />
                      </SelectTrigger>
                      <SelectContent>
                        {BR_TIMEZONES.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>
                            {tz.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Ticket médio (R$)</Label>
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={form.ticket_medio}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, ticket_medio: e.target.value }))
                        }
                        placeholder="150"
                        disabled={!canEdit}
                      />
                      <span className="font-mono text-base text-primary min-w-[3.5rem]">
                        {faixa || "—"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Aparece como faixa $ no portal público.
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label>Formas de pagamento</Label>
                  <Textarea
                    value={form.payment_methods}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, payment_methods: e.target.value }))
                    }
                    rows={2}
                    placeholder="Dinheiro, Pix, Visa, Mastercard, Vale-refeição..."
                    disabled={!canEdit}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Financeiro</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Usado para envio de NF-e e cobrança da plataforma. Não aparece para clientes.
                </p>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  <Label>E-mail financeiro</Label>
                  <Input
                    type="email"
                    value={form.financial_email}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, financial_email: e.target.value }))
                    }
                    placeholder="financeiro@empresa.com"
                    disabled={!canEdit}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─────────────────── ENDEREÇO ─────────────────── */}
          <TabsContent value="endereco" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Endereço</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Usado em "Como chegar", no mapa e nos e-mails de confirmação.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1 max-w-xs">
                  <Label>CEP</Label>
                  <Input
                    value={form.address.cep}
                    onChange={(e) => setAddressField("cep", e.target.value)}
                    placeholder="01310-100"
                    disabled={!canEdit}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2 space-y-1">
                    <Label>Endereço</Label>
                    <Input
                      value={form.address.street}
                      onChange={(e) => setAddressField("street", e.target.value)}
                      placeholder="Avenida Paulista"
                      disabled={!canEdit}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Número</Label>
                    <Input
                      value={form.address.number}
                      onChange={(e) => setAddressField("number", e.target.value)}
                      placeholder="1000"
                      disabled={!canEdit}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Bairro</Label>
                    <Input
                      value={form.address.neighborhood}
                      onChange={(e) => setAddressField("neighborhood", e.target.value)}
                      placeholder="Bela Vista"
                      disabled={!canEdit}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Complemento</Label>
                    <Input
                      value={form.address.complement}
                      onChange={(e) => setAddressField("complement", e.target.value)}
                      placeholder="Sala 102 — térreo"
                      disabled={!canEdit}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label>Estado</Label>
                    <Select
                      value={form.address.state}
                      onValueChange={(v) => setAddressField("state", v)}
                      disabled={!canEdit}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="UF" />
                      </SelectTrigger>
                      <SelectContent>
                        {BR_STATES.map((uf) => (
                          <SelectItem key={uf} value={uf}>
                            {uf}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-2 space-y-1">
                    <Label>Cidade</Label>
                    <Input
                      value={form.address.city}
                      onChange={(e) => setAddressField("city", e.target.value)}
                      placeholder="São Paulo"
                      disabled={!canEdit}
                    />
                  </div>
                </div>

                <Separator className="my-2" />

                <div className="flex items-start gap-3">
                  <Switch
                    aria-label="Ajustar coordenadas manualmente"
                    checked={form.showCoords}
                    onCheckedChange={(v) =>
                      setForm((f) => ({ ...f, showCoords: v }))
                    }
                    disabled={!canEdit}
                  />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Ajustar coordenadas manualmente</p>
                    <p className="text-xs text-muted-foreground">
                      Use quando o pino automático do mapa ficar impreciso.
                    </p>
                  </div>
                </div>
                {form.showCoords && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Latitude</Label>
                      <Input
                        value={form.address.lat}
                        onChange={(e) => setAddressField("lat", e.target.value)}
                        placeholder="-23.561414"
                        disabled={!canEdit}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Longitude</Label>
                      <Input
                        value={form.address.lng}
                        onChange={(e) => setAddressField("lng", e.target.value)}
                        placeholder="-46.655881"
                        disabled={!canEdit}
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─────────────────── FOTOS ─────────────────── */}
          <TabsContent value="fotos" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Imagens da unidade</CardTitle>
                <p className="text-sm text-muted-foreground">
                  A foto principal aparece como hero da página pública. O logo aparece sobre o
                  hero e em cards.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <AssetUploader
                  kind="hero"
                  label="Foto de capa"
                  helper="Recomendado 16:9, mínimo 1200×675px. Até 4MB."
                  aspect="aspect-[16/9]"
                  unitId={unitId}
                  value={form.hero_image_url}
                  onChange={(url) => setForm((f) => ({ ...f, hero_image_url: url }))}
                  onUploaded={handleUploaded}
                  disabled={!canEdit || isSaving}
                />
                <Separator />
                <AssetUploader
                  kind="logo"
                  label="Logo"
                  helper="Quadrado, fundo transparente. Até 1MB."
                  aspect="aspect-square w-32"
                  unitId={unitId}
                  value={form.logo_url}
                  onChange={(url) => setForm((f) => ({ ...f, logo_url: url }))}
                  onUploaded={handleUploaded}
                  disabled={!canEdit || isSaving}
                  rounded
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Álbum de fotos</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Até 5 fotos do salão, pratos ou ambiente. Aparecem na sua página
                  pública. JPG, PNG, WebP ou AVIF. Até 5MB cada.
                </p>
              </CardHeader>
              <CardContent>
                <GalleryEditor
                  unitId={unitId}
                  value={form.gallery_photos}
                  onChange={(urls) =>
                    setForm((f) => ({ ...f, gallery_photos: urls }))
                  }
                  onUploaded={handleUploaded}
                  disabled={!canEdit || isSaving}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─────────────────── FACILIDADES ─────────────────── */}
          <TabsContent value="facilidades" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Facilidades</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Marque as facilidades oferecidas. Aparecem como ícones na página pública.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                {FACILITY_GROUPS.map((group) => (
                  <div key={group.group} className="space-y-3">
                    <p className="font-semibold text-sm">{group.group}</p>
                    <div className="space-y-2 pl-1">
                      {group.items.map((item) => {
                        const checked = form.facilities.includes(item.code);
                        return (
                          <label
                            key={item.code}
                            className="flex items-center gap-2 text-sm cursor-pointer"
                          >
                            <Checkbox
                              checked={checked}
                              disabled={!canEdit}
                              onCheckedChange={(v) => {
                                setForm((f) => ({
                                  ...f,
                                  facilities: v
                                    ? Array.from(new Set([...f.facilities, item.code]))
                                    : f.facilities.filter((c) => c !== item.code),
                                }));
                              }}
                            />
                            <span>{item.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {!isLoading && canEdit && (
        <div className="sticky bottom-0 -mx-6 px-6 py-4 bg-background/90 backdrop-blur border-t flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Tudo pronto? É só salvar!</p>
          <Button onClick={handleSave} disabled={isSaving} size="lg">
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Salvando...
              </>
            ) : (
              "Salvar alterações"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CuisineMultiSelect

interface CuisineMultiSelectProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

function CuisineMultiSelect({ value, onChange, disabled }: CuisineMultiSelectProps) {
  const [input, setInput] = useState("");

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (value.some((c) => c.toLowerCase() === v.toLowerCase())) return;
    onChange([...value, v]);
    setInput("");
  };

  const remove = (code: string) =>
    onChange(value.filter((c) => c !== code));

  const suggestions = CUISINE_SUGGESTIONS.filter(
    (s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()),
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(input);
            }
          }}
          placeholder="Adicione uma categoria e tecle Enter"
          disabled={disabled}
          list="cuisine-suggestions"
        />
        <datalist id="cuisine-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label="Adicionar categoria"
          onClick={() => add(input)}
          disabled={disabled || !input.trim()}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((c) => (
            <Badge key={c} variant="secondary" className="gap-1 pl-2 pr-1">
              {c}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(c)}
                  className="hover:bg-background/60 rounded-sm"
                  aria-label={`Remover ${c}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      {!disabled && suggestions.length > 0 && value.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
