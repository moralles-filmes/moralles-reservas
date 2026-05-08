import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { ReservaForm } from "@/components/reserva/ReservaForm";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicCustomField, UnitAddress, WidgetFieldConfigMap } from "@/types/reserva";

interface PublicHallSchedule {
  day_of_week: number;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_advance_minutes: number;
}

interface PublicHall {
  id: string;
  name: string;
  description: string | null;
  schedules: PublicHallSchedule[];
}

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
    address: UnitAddress | null;
  };
  unit_settings?: {
    booking_window_days?: number;
    rules_and_conditions?: string;
    additional_info?: string;
  } | null;
  halls: PublicHall[];
  custom_fields?: PublicCustomField[];
}

export default function WidgetPortal() {
  const { slug } = useParams<{ slug: string }>();

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
  } = data;
  const rules = settings?.rules_and_conditions ?? "";
  const additionalInfo = settings?.additional_info ?? "";
  const bookingWindowDays = settings?.booking_window_days;

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

        {widget.client_instructions && (
          <div className="mx-6 my-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
            {widget.client_instructions}
          </div>
        )}

        {(rules || additionalInfo) && (
          <div className="mx-6 mb-3 space-y-2">
            {rules && (
              <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 whitespace-pre-line">
                <strong className="block mb-0.5">Regras e Condições</strong>
                {rules}
              </div>
            )}
            {additionalInfo && (
              <div className="rounded-md bg-muted/50 border p-3 text-xs whitespace-pre-line">
                {additionalInfo}
              </div>
            )}
          </div>
        )}

        <div className="px-6 pb-6">
          <ReservaForm
            unit={{
              id: unit.id,
              name: unit.name,
              organization_id: unit.organization_id,
            }}
            halls={halls}
            widgetConfig={widget.field_config}
            widgetId={widget.id}
            customFields={customFields}
            bookingWindowDays={bookingWindowDays}
          />
        </div>
      </div>
    </div>
  );
}
