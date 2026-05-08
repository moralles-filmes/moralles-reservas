import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CreditCard, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { BreadcrumbReservas } from "./Saloes";

const SETTING_KEYS = [
  "reservation_duration_minutes",
  "booking_window_days",
  "reservation_tolerance_minutes",
  "rules_and_conditions",
  "additional_info",
] as const;

type Tab = "geral" | "pagamentos";

export default function Ajustes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const [tab, setTab] = useState<Tab>("geral");

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current="Ajustes" />
        <h1 className="text-2xl font-bold">Configurações de reserva</h1>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex border-b">
          <TabButton active={tab === "geral"} onClick={() => setTab("geral")}>
            Informações gerais
          </TabButton>
          <TabButton active={tab === "pagamentos"} onClick={() => setTab("pagamentos")}>
            Pagamentos
          </TabButton>
        </div>

        <div className="p-6">
          {tab === "geral" && <InfoTab unitId={unitId} />}
          {tab === "pagamentos" && <PaymentsTab />}
        </div>
      </Card>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Tab: Informações gerais ──────────────────────────────────────────────────

type SettingRow = { key: string; value: unknown };

function InfoTab({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings", unitId, "reserva"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("key, value")
        .eq("unit_id", unitId)
        .in("key", [...SETTING_KEYS]);
      if (error) throw error;
      return data as SettingRow[];
    },
    enabled: !!unitId,
  });

  const [duration, setDuration] = useState("");
  const [bookingWindow, setBookingWindow] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [rules, setRules] = useState("");
  const [additionalInfo, setAdditionalInfo] = useState("");

  useEffect(() => {
    if (!settings) return;
    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    setDuration(coerceNumberString(map.reservation_duration_minutes, 90));
    setBookingWindow(coerceNumberString(map.booking_window_days, 60));
    setTolerance(coerceNumberString(map.reservation_tolerance_minutes, 0));
    setRules(coerceString(map.rules_and_conditions));
    setAdditionalInfo(coerceString(map.additional_info));
  }, [settings]);

  const upsertSettings = useMutation({
    mutationFn: async (patches: Array<{ key: string; value: unknown }>) => {
      const rows = patches.map((p) => ({ unit_id: unitId, key: p.key, value: p.value }));
      const { error } = await supabase
        .from("settings")
        .upsert(rows, { onConflict: "unit_id,key" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", unitId] });
      toast.success("Ajustes salvos.");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao salvar."),
  });

  const handleSave = () => {
    const win = Number(bookingWindow);
    if (!Number.isFinite(win) || win < 1 || win > 365) {
      toast.error("Janela de reserva deve estar entre 1 e 365 dias.");
      return;
    }
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur < 15 || dur > 600) {
      toast.error("Duração padrão deve estar entre 15 e 600 minutos.");
      return;
    }
    const tol = Number(tolerance);
    if (!Number.isFinite(tol) || tol < 0 || tol > 240) {
      toast.error("Tolerância deve estar entre 0 e 240 minutos.");
      return;
    }
    upsertSettings.mutate([
      { key: "reservation_duration_minutes", value: dur },
      { key: "booking_window_days", value: win },
      { key: "reservation_tolerance_minutes", value: tol },
      { key: "rules_and_conditions", value: rules.trim() },
      { key: "additional_info", value: additionalInfo.trim() },
    ]);
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-1">
        <LabelWithHelp
          label="Janela de reserva no calendário (em dias)"
          required
          help="Quantos dias seus clientes vêem disponíveis no calendário pra reservar — sempre dias corridos. Ex: 30 = 1 mês, 45 = 1 mês e meio, 120 = 4 meses. Em 01/01 com janela 30, clientes podem reservar até 31/01."
        />
        <Input
          type="number"
          min={1}
          max={365}
          className="w-40"
          value={bookingWindow}
          onChange={(e) => setBookingWindow(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <LabelWithHelp
          label="Duração padrão da reserva (minutos)"
          required
          help="Tempo que cada reserva ocupa a mesa. Usado pelo sistema pra evitar sobreposições."
        />
        <Input
          type="number"
          min={15}
          max={600}
          step={5}
          className="w-40"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <LabelWithHelp
          label="Tolerância (minutos)"
          help="Tempo de tolerância depois do horário marcado antes da reserva ser considerada no-show."
        />
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={240}
            className="w-28"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">minutos</span>
        </div>
      </div>

      <div className="border-t pt-6 space-y-1">
        <h3 className="text-base font-semibold">Informações personalizadas</h3>
        <p className="text-sm text-muted-foreground">
          Personalize as informações abaixo de acordo com as regras e normas do restaurante. Elas
          são exibidas no widget público e em comunicações por e-mail relacionadas a novas reservas.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label className="text-sm">Regras e Condições</Label>
          <Textarea
            rows={8}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            placeholder={"Ex:\nRODÍZIO TRADICIONAL (40+ itens)\n☀ ALMOÇO de terça a sexta-feira\n…"}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-sm">Informações adicionais</Label>
          <Textarea
            rows={8}
            value={additionalInfo}
            onChange={(e) => setAdditionalInfo(e.target.value)}
            placeholder="Estacionamento, dress code, política de cancelamento…"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={upsertSettings.isPending}>
          {upsertSettings.isPending ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

// ─── Tab: Pagamentos ──────────────────────────────────────────────────────────

function PaymentsTab() {
  return (
    <div className="py-12 text-center text-muted-foreground space-y-2 max-w-md mx-auto">
      <CreditCard className="h-8 w-8 mx-auto opacity-30" />
      <p className="text-base font-medium text-foreground">Pagamentos</p>
      <p className="text-sm">
        Em breve: cobranças via Pagseguro, Stripe e MercadoPago integradas a reservas com taxa
        antecipada.
      </p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function coerceNumberString(raw: unknown, fallback: number): string {
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return String(n);
  }
  return String(fallback);
}

function coerceString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return "";
}

function LabelWithHelp({
  label,
  required,
  help,
}: {
  label: string;
  required?: boolean;
  help: string;
}) {
  return (
    <Label className="text-sm flex items-center gap-1.5">
      {required && <span className="text-destructive">*</span>}
      {label}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs whitespace-pre-line">{help}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </Label>
  );
}
