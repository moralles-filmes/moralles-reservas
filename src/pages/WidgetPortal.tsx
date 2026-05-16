import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { ReservaWizard } from "@/components/reserva/ReservaWizard";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  PublicCustomField,
  PublicHall,
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
            bookingWindowDays={bookingWindowDays}
            rulesAndConditions={rules || undefined}
            additionalInfo={additionalInfo || undefined}
            widgetInstructions={widget.client_instructions || undefined}
          />
        </div>
      </div>
    </div>
  );
}
