import { Card } from "@/components/ui/card";
import { KpiStat, type KpiCardProps } from "./KpiStat";

export type { KpiCardProps };
export { formatValue } from "./KpiStat";

export function KpiCard(props: KpiCardProps) {
  return (
    <Card>
      <KpiStat {...props} />
    </Card>
  );
}
