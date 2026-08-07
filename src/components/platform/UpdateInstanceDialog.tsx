import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { toast } from "sonner";
import { useAllUnits } from "@/hooks/useAllUnits";
import { useWhatsAppChannels } from "@/hooks/useWhatsAppChannels";
import {
  useWhatsappInstanceAction,
  type WhatsappInstance,
} from "@/hooks/useWhatsappInstances";
import {
  buildUpdatePatch,
  type InstanceLinkFields,
} from "@/lib/whatsapp-instance-form-core";

const MIN_REASON_LENGTH = 5;
const NO_CHANNEL = "__none__";

/**
 * Tela B — corrigir o vínculo de uma instância já registrada.
 *
 * A RESTRIÇÃO QUE DEFINE ESTE COMPONENTE: a EF decide o que gravar por
 * `"campo" in body`. Mandar uma chave significa *escreva isto, inclusive
 * `null`*. Um formulário ingênuo, que enviasse o objeto inteiro, APAGARIA o
 * canal de quem só quis corrigir o identificador. Por isso o corpo sai de
 * `buildUpdatePatch` — função pura, testada — e nunca do estado bruto.
 */
export function UpdateInstanceDialog({
  open,
  onOpenChange,
  instance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instance: WhatsappInstance | null;
}) {
  const unitsQuery = useAllUnits();
  const action = useWhatsappInstanceAction();

  const original: InstanceLinkFields = useMemo(
    () => ({
      unit_id: instance?.unit_id ?? null,
      channel_id: instance?.channel_id ?? null,
      provider_instance_ref: instance?.provider_instance_ref ?? null,
      planned_provision_on: instance?.planned_provision_on ?? null,
    }),
    [instance],
  );

  const [unitId, setUnitId] = useState("");
  const [channelId, setChannelId] = useState(NO_CHANNEL);
  const [ref, setRef] = useState("");
  const [plannedOn, setPlannedOn] = useState("");
  const [reason, setReason] = useState("");

  /**
   * 409 de unidade ocupada NÃO é erro terminal: é uma pergunta. Mover uma
   * segunda instância para a mesma unidade continua possível — como ATO
   * CONSCIENTE. Mesmo fluxo do `RegisterInstanceDialog`.
   */
  const [unitConflicts, setUnitConflicts] = useState<
    { id: string; lifecycle_state: string; provider_instance_ref: string | null }[] | null
  >(null);

  // Reabrir o diálogo em OUTRA instância precisa recarregar o formulário — sem
  // isto, o estado da instância anterior viraria "mudança" na próxima.
  useEffect(() => {
    if (!open) return;
    setUnitId(original.unit_id ?? "");
    setChannelId(original.channel_id ?? NO_CHANNEL);
    setRef(original.provider_instance_ref ?? "");
    setPlannedOn(original.planned_provision_on ?? "");
    setReason("");
    setUnitConflicts(null);
  }, [open, original]);

  const channelsQuery = useWhatsAppChannels(unitId);

  // Só as unidades da MESMA organização: mover a instância para outra rede não é
  // correção de vínculo, e a trigger de tenant recusaria com 409.
  const units = useMemo(
    () => (unitsQuery.data ?? []).filter((u) => u.organization_id === instance?.organization_id),
    [unitsQuery.data, instance?.organization_id],
  );

  const form: InstanceLinkFields = {
    unit_id: unitId,
    channel_id: channelId === NO_CHANNEL ? null : channelId,
    provider_instance_ref: ref,
    planned_provision_on: plannedOn,
  };
  const patch = buildUpdatePatch(original, form);
  const hasChanges = Object.keys(patch).length > 0;
  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;

  function submit(acknowledgeConflict = false) {
    if (!instance || !hasChanges) return;
    action.mutate(
      {
        action: "update_instance",
        instance_id: instance.id,
        ...patch,
        ...(acknowledgeConflict ? { acknowledge_unit_conflict: true } : {}),
        reason,
      },
      {
        onSuccess: () => {
          toast.success("Vínculo corrigido.");
          setUnitConflicts(null);
          onOpenChange(false);
        },
        onError: (e: Error & { code?: string; body?: Record<string, unknown> }) => {
          // 409 de unidade ocupada não é erro terminal: a tela mostra o que já
          // existe lá e oferece a confirmação explícita.
          if (e.code === "UNIT_ALREADY_HAS_INSTANCE") {
            setUnitConflicts(
              (e.body?.conflicts as {
                id: string;
                lifecycle_state: string;
                provider_instance_ref: string | null;
              }[]) ?? [],
            );
            return;
          }
          toast.error(e.message);
        },
      },
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Corrigir vínculo</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Só os campos que você alterar são enviados. Campo esvaziado desvincula de propósito.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="upd-unit">Unidade</Label>
            <Select
              value={unitId}
              onValueChange={(v) => {
                // Repor aqui, não num `useEffect([unitId])`: o efeito de recarga
                // acima chama `setUnitId` DIRETO, então este handler só vê a
                // troca deliberada do operador — a carga inicial preserva o
                // canal salvo. Sem repor, `channel_id` fica de fora do patch
                // (não mudou) mas `unit_id` entra; a trigger de tenant
                // (`whatsapp_instances_tenant_guard`) dispara por causa do
                // `unit_id` e recusa o `channel_id` antigo contra a unidade
                // nova — erro determinístico com mensagem de "outra
                // organização" que aqui está sempre errada, porque a lista já
                // é filtrada pela mesma organização.
                setUnitId(v);
                setChannelId(NO_CHANNEL);
                // Trocar a unidade de destino invalida o conflito já mostrado:
                // ele era sobre a unidade anterior.
                setUnitConflicts(null);
              }}
            >
              <SelectTrigger id="upd-unit" className="h-12 sm:h-10">
                <SelectValue placeholder="Escolha a unidade" />
              </SelectTrigger>
              <SelectContent>
                {units.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.organization_name} · {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-channel">Canal</Label>
            <Select value={channelId} onValueChange={setChannelId} disabled={!unitId}>
              <SelectTrigger id="upd-channel" className="h-12 sm:h-10">
                <SelectValue placeholder={unitId ? "Sem canal" : "Escolha a unidade primeiro"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>Sem canal</SelectItem>
                {(channelsQuery.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.provider} · {c.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {channelsQuery.isError && (
              <p className="text-xs text-destructive">
                Não foi possível carregar os canais desta unidade.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-ref">Identificador da instância no fornecedor</Label>
            <Input
              id="upd-ref"
              className="h-12 sm:h-10 font-mono"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
            <p className="text-xs text-warning">
              Apenas o identificador, <strong>nunca a URL</strong> — ela contém o token.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-planned">Data prevista de provisionamento (opcional)</Label>
            <Input
              id="upd-planned"
              type="date"
              className="h-12 sm:h-10"
              value={plannedOn}
              onChange={(e) => setPlannedOn(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-reason">Motivo (fica registrado no histórico)</Label>
            <Textarea
              id="upd-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          {unitConflicts && unitConflicts.length > 0 && (
            <div className="rounded-md border border-warning bg-warning/10 p-3 space-y-2 text-sm">
              <p className="font-medium">A unidade de destino já tem instância registrada.</p>
              <ul className="space-y-1 text-xs">
                {unitConflicts.map((c) => (
                  <li key={c.id}>
                    <span className="font-mono">
                      {c.provider_instance_ref ?? "sem identificador"}
                    </span>
                    {" — "}
                    {c.lifecycle_state === "CANCELLATION_REQUESTED"
                      ? "cancelamento solicitado (ainda custa)"
                      : "ativa"}
                  </li>
                ))}
              </ul>
              <p className="text-xs">
                Mover esta instância para lá significa que a unidade passa a ter duas. Confirme só
                se for isso mesmo.
              </p>
            </div>
          )}

          {!hasChanges && (
            <p className="text-xs text-muted-foreground">
              Nada foi alterado ainda. Sem mudança não há requisição.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!hasChanges || reasonTooShort || action.isPending}
              onClick={() => submit(unitConflicts !== null && unitConflicts.length > 0)}
            >
              {unitConflicts && unitConflicts.length > 0 ? "Mover mesmo assim" : "Salvar correção"}
            </Button>
          </div>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
