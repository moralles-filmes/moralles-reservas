import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { ReservaWizard } from "@/components/reserva/ReservaWizard";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronRight, X } from "lucide-react";
import type {
  PublicBlockedDate,
  PublicCustomField,
  PublicHall,
  PublicSpecialDate,
  UnitAddress,
  WidgetFieldConfigMap,
} from "@/types/reserva";

interface WidgetPublicResponse {
  widget: {
    id: string;
    slug: string;
    name: string;
    field_config: WidgetFieldConfigMap;
    client_instructions: string | null;
    show_menu_banner: boolean;
  };
  unit: {
    id: string;
    name: string;
    slug: string;
    organization_id: string;
    description: string | null;
    hero_image_url: string | null;
    logo_url: string | null;
    gallery_photos?: string[] | null;
    address: UnitAddress | null;
  };
  unit_settings?: {
    booking_window_days?: number;
    rules_and_conditions?: string;
    additional_info?: string;
  } | null;
  halls: PublicHall[];
  special_dates?: PublicSpecialDate[];
  blocked_dates?: PublicBlockedDate[];
  custom_fields?: PublicCustomField[];
}

export default function WidgetPortal() {
  const { slug } = useParams<{ slug: string }>();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["widget-public", slug],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_widget_public", { p_slug: slug });
      if (error) throw error;
      return data as WidgetPublicResponse | null;
    },
    enabled: !!slug,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-muted/40 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-muted/40 flex items-center justify-center p-6 text-center">
        <div className="space-y-2">
          <p className="text-lg font-semibold">Widget não encontrado.</p>
          <p className="text-sm text-muted-foreground">
            Verifique o link e tente novamente.
          </p>
        </div>
      </div>
    );
  }

  const {
    widget,
    unit,
    halls,
    custom_fields: customFields = [],
    unit_settings: settings,
    blocked_dates: blockedDates = [],
    special_dates: specialDates = [],
  } = data;
  const rules = settings?.rules_and_conditions ?? "";
  const additionalInfo = settings?.additional_info ?? "";
  const bookingWindowDays = settings?.booking_window_days;
  const galleryPhotos = (unit.gallery_photos ?? []).filter(Boolean);

  return (
    <div className="min-h-screen bg-muted/40 flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md bg-card rounded-2xl shadow-xl overflow-hidden">
        <div className="px-6 pt-6 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Reserve com <span className="font-semibold text-foreground">moralles</span>
          </div>
        </div>

        {unit.hero_image_url && (
          <div className="px-6 pt-4">
            <div className="aspect-[16/9] w-full overflow-hidden rounded-lg bg-muted">
              <img
                src={unit.hero_image_url}
                alt={unit.name}
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        )}

        <div className="px-6 pt-4 pb-2 flex items-center gap-3">
          {unit.logo_url && (
            <img
              src={unit.logo_url}
              alt={`Logo ${unit.name}`}
              className="h-10 w-10 rounded-full object-cover ring-2 ring-background"
            />
          )}
          <h2 className="font-display text-xl">{unit.name}</h2>
        </div>

        {galleryPhotos.length > 0 && (
          <div className="px-6 pt-2 pb-1">
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory">
              {galleryPhotos.map((url, idx) => (
                <button
                  key={`${url}-${idx}`}
                  type="button"
                  onClick={() => setLightboxIndex(idx)}
                  className="relative shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted snap-start focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label={`Abrir foto ${idx + 1}`}
                >
                  <img
                    src={url}
                    alt={`Foto ${idx + 1} de ${unit.name}`}
                    loading="lazy"
                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-200 hover:scale-105"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="px-6 pt-2 pb-6">
          <ReservaWizard
            mode="embedded"
            unit={{
              id: unit.id,
              name: unit.name,
              organization_id: unit.organization_id,
            }}
            halls={halls}
            widgetConfig={widget.field_config}
            widgetId={widget.id}
            customFields={customFields}
            blockedDates={blockedDates}
            specialDates={specialDates}
            bookingWindowDays={bookingWindowDays}
            rulesAndConditions={rules || undefined}
            additionalInfo={additionalInfo || undefined}
            widgetInstructions={widget.client_instructions || undefined}
          />
        </div>
      </div>

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
