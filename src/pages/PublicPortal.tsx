import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { ReservaWizard } from "@/components/reserva/ReservaWizard";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { WaitlistFormPublic } from "@/components/waitlist/WaitlistFormPublic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";
import { useReservaByCode } from "@/hooks/useReservas";
import type { PublicBlockedDate, PublicHall, PublicSpecialDate } from "@/types/reserva";
import {
  CalendarDays,
  ChevronRight,
  CheckCircle2,
  Clock,
  CreditCard,
  Images,
  Instagram,
  Link as LinkIcon,
  MapPin,
  Phone,
  Search,
  Smartphone,
  Sparkles,
  Tag,
  UtensilsCrossed,
  Wallet,
  X,
} from "lucide-react";
import type { UnitAddress } from "@/types/reserva";
import { FACILITY_GROUPS, getFacilityIcon, getFacilityLabel } from "@/lib/facilities";

interface PublicUnit {
  id: string;
  name: string;
  slug: string;
  organization_id: string;
  description: string | null;
  price_range_min: number | null;
  price_range_max: number | null;
  hero_image_url: string | null;
  logo_url: string | null;
  gallery_photos?: string[] | null;
  address: UnitAddress | null;
  phone?: string | null;
  instagram?: string | null;
  website?: string | null;
  cuisine_types?: string[] | null;
  opening_hours_text?: string | null;
  payment_methods?: string | null;
  facilities?: string[] | null;
}

interface UnitSettings {
  booking_window_days?: number;
  rules_and_conditions?: string;
  additional_info?: string;
  waitlist_priority_enabled?: boolean;
  waitlist_remote_entry_enabled?: boolean;
  waitlist_remote_entry_limit?: number;
  waitlist_qr_enabled?: boolean;
  waitlist_menu_link_enabled?: boolean;
}

interface UnitPublicFullResponse {
  unit: PublicUnit & { timezone: string };
  unit_settings?: UnitSettings | null;
  halls?: PublicHall[];
  business_hours: Array<{
    day_of_week: number;
    open_time: string;
    close_time: string;
    is_closed: boolean;
  }>;
  special_dates?: PublicSpecialDate[];
  blocked_dates?: PublicBlockedDate[];
  custom_fields?: Array<{
    id: string;
    label: string;
    type: "text" | "options" | "file";
    options: string[] | null;
    required: boolean;
    sort_order: number;
  }>;
}

type PortalMode = "full" | "embed";
type AutoOpenAction = "reservar" | "waitlist" | null;

export default function PublicPortal() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const mode: PortalMode = searchParams.get("mode") === "embed" ? "embed" : "full";
  const actionParam = searchParams.get("action");
  const autoOpen: AutoOpenAction =
    actionParam === "reservar" || actionParam === "waitlist" ? actionParam : null;

  const { data: payload, isLoading, error } = useQuery({
    queryKey: ["public-unit", slug],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_unit_public_full", {
        p_slug: slug,
      });
      if (error) throw error;
      return data as UnitPublicFullResponse | null;
    },
    enabled: !!slug,
  });
  const unit = payload?.unit ?? null;
  const halls = payload?.halls ?? [];
  const customFields = payload?.custom_fields ?? [];
  const settings = payload?.unit_settings ?? {};
  const blockedDates = payload?.blocked_dates ?? [];
  const specialDates = payload?.special_dates ?? [];

  if (isLoading) {
    if (mode === "embed") {
      return (
        <div className="min-h-screen bg-muted/40 flex items-center justify-center p-4 sm:p-6">
          <div className="w-full max-w-md space-y-3">
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-background">
        <div className="aspect-[16/9] w-full max-h-[520px]">
          <Skeleton className="h-full w-full rounded-none" />
        </div>
        <div className="max-w-6xl mx-auto px-4 py-12 space-y-4">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-5 w-96" />
        </div>
      </div>
    );
  }

  if (error || !unit) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">Restaurante não encontrado.</p>
        <p className="text-sm text-muted-foreground">
          Verifique o link e tente novamente.
        </p>
        <Link to="/">
          <Button variant="outline" size="sm">
            Página inicial
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <PortalContent
      unit={unit}
      halls={halls}
      customFields={customFields}
      settings={settings}
      blockedDates={blockedDates}
      specialDates={specialDates}
      mode={mode}
      autoOpen={autoOpen}
    />
  );
}

// ─── Conteúdo principal ───────────────────────────────────────────────────────

function PortalContent({
  unit,
  halls,
  customFields,
  settings,
  blockedDates,
  specialDates,
  mode,
  autoOpen,
}: {
  unit: PublicUnit;
  halls: PublicHall[];
  customFields: NonNullable<UnitPublicFullResponse["custom_fields"]>;
  settings: UnitSettings;
  blockedDates: PublicBlockedDate[];
  specialDates: PublicSpecialDate[];
  mode: PortalMode;
  autoOpen: AutoOpenAction;
}) {
  const initials = useMemo(() => getInitials(unit.name), [unit.name]);
  const galleryPhotos = (unit.gallery_photos ?? []).filter(Boolean);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const fullAddress =
    unit.address?.full?.trim() ||
    [unit.address?.street, unit.address?.number, unit.address?.city]
      .filter(Boolean)
      .join(", ");

  const cityLine = [unit.address?.neighborhood, unit.address?.city]
    .filter(Boolean)
    .join(" · ");

  if (mode === "embed") {
    return (
      <div className="min-h-screen bg-muted/40 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md space-y-3">
          <ReservaCTA
            unit={unit}
            halls={halls}
            customFields={customFields}
            settings={settings}
            blockedDates={blockedDates}
            specialDates={specialDates}
            defaultOpen={autoOpen === "reservar"}
          />
          <WaitlistCTA
            unit={unit}
            settings={settings}
            defaultOpen={autoOpen === "waitlist"}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar minimal — não compete com o hero */}
      <header className="absolute top-0 inset-x-0 z-20">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link
            to="/"
            className="text-xs uppercase tracking-[0.2em] text-white/90 hover:text-white drop-shadow"
          >
            Moralles
          </Link>
          <Link
            to="/admin/login"
            className="text-xs text-white/90 hover:text-white drop-shadow"
          >
            Área Admin
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="relative aspect-[16/9] max-h-[560px] w-full overflow-hidden bg-gradient-to-br from-[hsl(24,85%,45%)] via-[hsl(28,80%,55%)] to-[hsl(38,90%,52%)]">
          {unit.hero_image_url ? (
            <img
              src={unit.hero_image_url}
              alt={unit.name}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.18) 0%, transparent 50%), radial-gradient(circle at 70% 70%, rgba(0,0,0,0.18) 0%, transparent 60%)",
              }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-black/10 to-black/55" />
        </div>

        {/* Faixa identitária — sobreposta ao hero, com logo + nome */}
        <div className="max-w-6xl mx-auto px-4">
          <div className="relative -mt-20 sm:-mt-24 flex items-end gap-5 sm:gap-7">
            <div
              className={`shrink-0 h-28 w-28 sm:h-36 sm:w-36 rounded-full overflow-hidden ring-4 ring-background bg-card shadow-xl flex items-center justify-center`}
            >
              {unit.logo_url ? (
                <img
                  src={unit.logo_url}
                  alt={`Logo ${unit.name}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="font-display text-3xl sm:text-4xl text-primary">
                  {initials}
                </span>
              )}
            </div>
            <div className="pb-3 sm:pb-4 text-white">
              <h1 className="font-display text-3xl sm:text-5xl leading-tight tracking-tight drop-shadow-md">
                {unit.name}
              </h1>
              {cityLine && (
                <p className="text-sm sm:text-base font-medium text-foreground/80 mt-2 flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 text-primary" />
                  {cityLine}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Body */}
      <section className="max-w-6xl mx-auto px-4 pt-10 sm:pt-14 pb-20">
        <div className="grid lg:grid-cols-[1fr_22rem] gap-10 lg:gap-14 items-start">
          {/* ── Coluna esquerda — conteúdo editorial ───────────────────────── */}
          <div className="space-y-12">
            {unit.description && (
              <Section icon={<UtensilsCrossed className="h-4 w-4" />} title="Sobre">
                <p className="font-display text-lg sm:text-xl leading-relaxed text-foreground/85 whitespace-pre-line">
                  {unit.description}
                </p>
              </Section>
            )}

            {galleryPhotos.length > 0 && (
              <Section icon={<Images className="h-4 w-4" />} title="Galeria">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
                  {galleryPhotos.map((url, idx) => (
                    <button
                      key={`${url}-${idx}`}
                      type="button"
                      onClick={() => setLightboxIndex(idx)}
                      className="relative aspect-square rounded-md overflow-hidden bg-muted/30 group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={`Abrir foto ${idx + 1}`}
                    >
                      <img
                        src={url}
                        alt={`Foto ${idx + 1} de ${unit.name}`}
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                    </button>
                  ))}
                </div>
              </Section>
            )}

            {unit.cuisine_types && unit.cuisine_types.length > 0 && (
              <Section icon={<Tag className="h-4 w-4" />} title="Tipo de cozinha">
                <div className="flex flex-wrap gap-2">
                  {unit.cuisine_types.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center rounded-full bg-muted px-3 py-1 text-sm text-foreground/80"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {unit.opening_hours_text && (
              <Section icon={<Clock className="h-4 w-4" />} title="Horário de funcionamento">
                <p className="text-foreground/85 leading-relaxed whitespace-pre-line">
                  {unit.opening_hours_text}
                </p>
              </Section>
            )}

            {(unit.price_range_min != null || unit.price_range_max != null) && (
              <Section icon={<Wallet className="h-4 w-4" />} title="Faixa de preço">
                <p className="font-display text-2xl sm:text-3xl">
                  {formatPriceRange(unit.price_range_min, unit.price_range_max)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Ticket médio por pessoa
                </p>
              </Section>
            )}

            {unit.payment_methods && (
              <Section icon={<CreditCard className="h-4 w-4" />} title="Formas de pagamento">
                <p className="text-foreground/85 leading-relaxed whitespace-pre-line">
                  {unit.payment_methods}
                </p>
              </Section>
            )}

            {unit.facilities && unit.facilities.length > 0 && (
              <Section icon={<CheckCircle2 className="h-4 w-4" />} title="Facilidades">
                <FacilitiesGrid codes={unit.facilities} />
              </Section>
            )}

            {(unit.phone || unit.instagram || unit.website) && (
              <Section icon={<Phone className="h-4 w-4" />} title="Contato">
                <ul className="space-y-2 text-foreground/85">
                  {unit.phone && (
                    <li className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-primary" />
                      <a
                        href={`tel:${unit.phone.replace(/\D/g, "")}`}
                        className="hover:text-primary transition-colors"
                      >
                        {unit.phone}
                      </a>
                    </li>
                  )}
                  {unit.instagram && (
                    <li className="flex items-center gap-2">
                      <Instagram className="h-4 w-4 text-primary" />
                      <a
                        href={
                          unit.instagram.startsWith("http")
                            ? unit.instagram
                            : `https://instagram.com/${unit.instagram.replace(/^@/, "")}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary transition-colors"
                      >
                        {unit.instagram}
                      </a>
                    </li>
                  )}
                  {unit.website && (
                    <li className="flex items-center gap-2">
                      <LinkIcon className="h-4 w-4 text-primary" />
                      <a
                        href={unit.website.startsWith("http") ? unit.website : `https://${unit.website}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary transition-colors break-all"
                      >
                        {unit.website}
                      </a>
                    </li>
                  )}
                </ul>
              </Section>
            )}

            {fullAddress && (
              <Section icon={<MapPin className="h-4 w-4" />} title="Como chegar">
                <p className="text-foreground/85 leading-relaxed">{fullAddress}</p>
                <div className="mt-4 rounded-xl overflow-hidden border bg-muted">
                  <iframe
                    title={`Mapa de ${unit.name}`}
                    src={`https://www.google.com/maps?q=${encodeURIComponent(
                      fullAddress
                    )}&output=embed`}
                    className="w-full h-72 border-0"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                  />
                </div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                    fullAddress
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline mt-3 inline-flex items-center gap-1"
                >
                  Abrir no Google Maps
                  <ChevronRight className="h-3.5 w-3.5" />
                </a>
              </Section>
            )}

            {/* Footer minimal — consulta por código discreta */}
            <div className="border-t pt-6">
              <ReservaCodeLookup unitId={unit.id} />
            </div>
          </div>

          {/* ── Coluna direita — CTAs sticky ────────────────────────────────── */}
          <div className="lg:sticky lg:top-8 space-y-3 order-first lg:order-none -mt-2 lg:mt-0">
            <ReservaCTA
              unit={unit}
              halls={halls}
              customFields={customFields}
              settings={settings}
              blockedDates={blockedDates}
              specialDates={specialDates}
              defaultOpen={autoOpen === "reservar"}
            />
            <WaitlistCTA
              unit={unit}
              settings={settings}
              defaultOpen={autoOpen === "waitlist"}
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-card">
        <div className="max-w-6xl mx-auto px-4 py-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>Reservas · {unit.name}</span>
          <span>Powered by Moralles</span>
        </div>
      </footer>

      {/* Lightbox da galeria */}
      <Dialog
        open={lightboxIndex !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null);
        }}
      >
        <DialogContent className="max-w-5xl p-0 bg-black/95 border-0 sm:rounded-lg overflow-hidden">
          <DialogTitle className="sr-only">
            Foto {lightboxIndex !== null ? lightboxIndex + 1 : 0} de {unit.name}
          </DialogTitle>
          {lightboxIndex !== null && galleryPhotos[lightboxIndex] && (
            <div className="relative w-full h-[min(85vh,720px)] flex items-center justify-center">
              <img
                src={galleryPhotos[lightboxIndex]}
                alt={`Foto ${lightboxIndex + 1} de ${unit.name}`}
                className="max-w-full max-h-full object-contain"
              />
              <button
                type="button"
                onClick={() => setLightboxIndex(null)}
                className="absolute top-3 right-3 h-9 w-9 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
                aria-label="Fechar"
              >
                <X className="h-5 w-5" />
              </button>
              {galleryPhotos.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setLightboxIndex((i) =>
                        i === null ? null : (i - 1 + galleryPhotos.length) % galleryPhotos.length
                      )
                    }
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
                    aria-label="Foto anterior"
                  >
                    <ChevronRight className="h-5 w-5 rotate-180" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setLightboxIndex((i) =>
                        i === null ? null : (i + 1) % galleryPhotos.length
                      )
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
                    aria-label="Próxima foto"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-white/80 bg-black/60 rounded-full px-3 py-1">
                    {lightboxIndex + 1} / {galleryPhotos.length}
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Subcomponentes ───────────────────────────────────────────────────────────

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 text-primary mb-3">
        {icon}
        <h2 className="text-xs font-medium uppercase tracking-[0.18em]">{title}</h2>
      </div>
      <div>{children}</div>
    </section>
  );
}

function FacilitiesGrid({ codes }: { codes: string[] }) {
  const grouped = FACILITY_GROUPS.map((g) => ({
    group: g.group,
    items: g.items.filter((i) => codes.includes(i.code)),
  })).filter((g) => g.items.length > 0);

  // Itens que não bateram com a lista canônica (códigos novos/desconhecidos)
  const known = new Set(FACILITY_GROUPS.flatMap((g) => g.items.map((i) => i.code)));
  const orphan = codes.filter((c) => !known.has(c));

  return (
    <div className="space-y-5">
      {grouped.map(({ group, items }) => (
        <div key={group}>
          <p className="text-xs font-semibold text-muted-foreground mb-2">{group}</p>
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            {items.map((item) => {
              const Icon = getFacilityIcon(item.code);
              return (
                <li
                  key={item.code}
                  className="flex items-center gap-2 text-foreground/85"
                >
                  {Icon ? (
                    <Icon className="h-4 w-4 text-primary shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                  )}
                  <span>{item.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {orphan.length > 0 && (
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
          {orphan.map((code) => (
            <li key={code} className="flex items-center gap-2 text-foreground/85">
              <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
              <span>{getFacilityLabel(code)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReservaCTA({
  unit,
  halls,
  customFields,
  settings,
  blockedDates,
  specialDates,
  defaultOpen = false,
}: {
  unit: PublicUnit;
  halls: PublicHall[];
  customFields: NonNullable<UnitPublicFullResponse["custom_fields"]>;
  settings: UnitSettings;
  blockedDates: PublicBlockedDate[];
  specialDates: PublicSpecialDate[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogTrigger asChild>
        <button
          type="button"
          className="w-full text-left rounded-2xl border bg-card p-5 sm:p-6 hover:shadow-lg hover:border-primary/40 transition-all group"
        >
          <div className="flex items-start gap-4">
            <div className="h-11 w-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-display text-2xl leading-tight">Reserve Agora</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Garanta sua mesa, evite filas
              </p>
              <p className="text-xs text-primary mt-3 inline-flex items-center gap-1 font-medium">
                Fazer reserva
                <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </p>
            </div>
          </div>
        </button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ReservaWizard
          mode="dialog"
          title={`Reservar em ${unit.name}`}
          unit={{
            id: unit.id,
            name: unit.name,
            organization_id: unit.organization_id,
          }}
          halls={halls}
          customFields={customFields}
          blockedDates={blockedDates}
          specialDates={specialDates}
          bookingWindowDays={
            typeof settings.booking_window_days === "number" ? settings.booking_window_days : undefined
          }
          rulesAndConditions={settings.rules_and_conditions}
          additionalInfo={settings.additional_info}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function WaitlistCTA({
  unit,
  settings,
  defaultOpen = false,
}: {
  unit: PublicUnit;
  settings: UnitSettings;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Auto-abre o modal quando o portal é acessado via QR Code (?action=waitlist)
  // ou quando o link compartilhado já vem com o dialog instruído pra abrir.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="w-full text-left rounded-2xl border bg-card/60 p-5 hover:shadow-md hover:border-secondary/40 transition-all group"
        >
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 rounded-full bg-secondary/15 text-secondary flex items-center justify-center shrink-0">
              <Smartphone className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-display text-xl leading-tight">Entrar na Fila</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                Guarde seu lugar sem sair de casa
              </p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 mt-1" />
          </div>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-secondary" />
            Entrar na fila
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Avisamos pelo WhatsApp quando sua mesa estiver pronta em {unit.name}.
          </p>
        </DialogHeader>
        <WaitlistFormPublic
          unitId={unit.id}
          priorityEnabled={settings.waitlist_priority_enabled !== false}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ReservaCodeLookup({ unitId }: { unitId: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const { data: reserva, isLoading } = useReservaByCode(searchCode, unitId);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setCode("");
          setSearchCode("");
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
        >
          <Clock className="h-3.5 w-3.5" />
          Já tem reserva? Consulte pelo código
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Consultar reserva</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Informe o código de 8 caracteres recebido no WhatsApp.
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Ex: AB1C2DEF"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="font-mono"
              maxLength={8}
            />
            <Button
              variant="secondary"
              onClick={() => setSearchCode(code)}
              disabled={code.length < 4}
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>

          {isLoading && <p className="text-sm text-muted-foreground">Buscando...</p>}
          {searchCode && !isLoading && !reserva && (
            <p className="text-sm text-destructive">
              Reserva não encontrada. Verifique o código.
            </p>
          )}
          {reserva && (
            <div className="space-y-2">
              <ReservaCard reserva={reserva} />
              {(reserva.status === "confirmed" || reserva.status === "pending") && (
                <p className="text-xs text-muted-foreground">
                  Para alterar ou cancelar, envie uma mensagem no WhatsApp com o código #
                  {reserva.reservation_code}.
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatPriceRange(min: number | null, max: number | null): string {
  const fmt = (n: number) =>
    n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  if (min != null && max != null) return `de ${fmt(min)} até ${fmt(max)}`;
  if (min != null) return `a partir de ${fmt(min)}`;
  if (max != null) return `até ${fmt(max)}`;
  return "";
}
