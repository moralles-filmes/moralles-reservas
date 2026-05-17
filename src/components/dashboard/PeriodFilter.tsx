import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type Period = "today" | "7d" | "30d" | "90d";

const OPTIONS: { value: Period; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "90d", label: "90 dias" },
];

const PERIOD_VALUES: readonly string[] = OPTIONS.map((o) => o.value);

function isPeriod(v: string): v is Period {
  return PERIOD_VALUES.includes(v);
}

interface PeriodFilterProps {
  value: Period;
  onChange: (period: Period) => void;
}

export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => {
        if (isPeriod(v)) onChange(v);
      }}
    >
      <TabsList>
        {OPTIONS.map((opt) => (
          <TabsTrigger key={opt.value} value={opt.value}>
            {opt.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
