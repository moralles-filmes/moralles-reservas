import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR } from "@/lib/utils";
import { instanceNoteActionLabel } from "@/lib/whatsapp-instance-format";
import { useWhatsappInstanceNotes } from "@/hooks/useWhatsappInstances";

/**
 * Histórico de observações — o que `whatsapp_instances.notes` não guardava.
 *
 * `notes` é sobrescrita a cada ação e cada uma apagava a justificativa da
 * anterior. Ela continua existindo como RESUMO ("última observação"); esta
 * seção é o histórico, e as duas saem do mesmo `reason`, na mesma operação.
 */
export function InstanceNotesPanel({ instanceId }: { instanceId: string }) {
  const notes = useWhatsappInstanceNotes(instanceId);

  if (notes.isLoading) return <Skeleton className="h-20 w-full" />;

  // Branch PRÓPRIO: silenciar erro como "sem histórico" leria como "nunca houve
  // decisão registrada" sobre uma instância que tem custo correndo.
  if (notes.isError) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Não foi possível carregar o histórico.</span>
        <Button variant="outline" size="sm" onClick={() => notes.refetch()}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  const rows = notes.data ?? [];
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhuma observação registrada. Toda ação com motivo passa a registrar uma linha aqui.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((n) => (
        <div key={n.id} className="rounded-md border p-3 space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{instanceNoteActionLabel(n.action)}</Badge>
            <span className="text-xs text-muted-foreground">
              {formatDateBR(n.created_at.slice(0, 10))} ·{" "}
              {/* Autor não resolvido é dito, não escondido: a informação existe
                  na linha, só não foi traduzida em nome. */}
              {n.created_by_email ?? "autor não identificado"}
            </span>
          </div>
          <p className="whitespace-pre-wrap">{n.note}</p>
        </div>
      ))}
    </div>
  );
}