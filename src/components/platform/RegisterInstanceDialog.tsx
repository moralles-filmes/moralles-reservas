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
import { parseCostReais } from "@/lib/whatsapp-instance-form-core";
import { COST_SOURCE_OPTIONS } from "@/lib/whatsapp-instance-format";

const MIN_REASON_LENGTH = 5;
const NO_CHANNEL = "__none__";

/**
 * Tela A — registrar no inventário uma instância que JÁ EXISTE na Z-API.
 *
 * TODO O REGISTRO É BACKFILL, e por isso não há seletor de intenção: a instância
 * nasce no painel do fornecedor e só depois é registrada aqui. Registrar antes
 * de provisionar não protegeria custo nenhum — o custo começa no clique dentro
 * da Z-API, não no registro — e a fila de "pedido pendente" já existe em
 * `whatsapp_implementations`.
 */
export function RegisterInstanceDialog({
  open,
  onOpenChange,
  prefill,
  onRegistered,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Vindo do card do alerta CHANNEL_WITHOUT_INSTANCE, que carrega os dois. */
  prefill?: { organizationId: string; channelId: string | null } | null;
  onRegistered: (instance: WhatsappInstance) => void;
}) {
  const unitsQuery = useAllUnits();
  const action = useWhatsappInstanceAction();

  const [unitId, setUnitId] = useState("");
  const [channelId, setChannelId] = useState(NO_CHANNEL);
  const [ref, setRef] = useState("");
  const [costReais, setCostReais] = useState("");
  const [costSource, setCostSource] = useState(COST_SOURCE_OPTIONS[0].value);
  const [reason, setReason] = useState("");

  const channelsQuery = useWhatsAppChannels(unitId);

  // Aberto pelo card do alerta: só as unidades da organização do alerta entram
  // na lista. Sem o filtro, o operador escolheria uma unidade de OUTRA rede e a
  // trigger de tenant recusaria com 409 depois — erro tardio para uma pergunta
  // que a interface já sabia responder.
  const units = useMemo(() => {
    const all = unitsQuery.data ?? [];
    if (!prefill?.organizationId) return all;
    return all.filter((u) => u.organization_id === prefill.organizationId);
  }, [unitsQuery.data, prefill?.organizationId]);

  // Uma unidade só na organização do alerta: escolher por ela é seguro.
  useEffect(() => {
    if (!open) return;
    if (prefill?.organizationId && units.length === 1) setUnitId(units[0].id);
  }, [open, prefill?.organizationId, units]);

  // O canal pertence à UNIDADE, não à organização: canal escolhido para a
  // unidade anterior sobrevivendo à troca é vínculo cruzado que só o banco
  // pega (trigger `whatsapp_instances_tenant_guard`, 23514) — tarde demais, e
  // a mensagem que a EF traduz fala em "outra organização" quando o problema
  // real é outra unidade da MESMA organização. Repor aqui evita a viagem.
  // Roda ANTES do efeito de pré-seleção abaixo (mesma ordem de declaração):
  // numa troca de unidade que também reaplica o prefill, o reset acontece
  // primeiro e a pré-seleção decide por último — sem disputa nem laço, porque
  // nenhum dos dois efeitos depende de `channelId`.
  useEffect(() => {
    setChannelId(NO_CHANNEL);
  }, [unitId]);

  // O alerta carrega `channel_id` mas não `unit_id`: o canal só pode ser
  // pré-selecionado depois de a lista da unidade escolhida carregar E conter o
  // id. Se não contiver, a escolha do operador continua livre — nada é chutado.
  useEffect(() => {
    if (!open || !prefill?.channelId) return;
    const found = (channelsQuery.data ?? []).some((c) => c.id === prefill.channelId);
    if (found) setChannelId(prefill.channelId);
  }, [open, prefill?.channelId, channelsQuery.data]);

  function reset() {
    setUnitId("");
    setChannelId(NO_CHANNEL);
    setRef("");
    setCostReais("");
    setCostSource(COST_SOURCE_OPTIONS[0].value);
    setReason("");
  }

  const selectedUnit = units.find((u) => u.id === unitId) ?? null;
  const cost = parseCostReais(costReais);
  const costInvalid = cost.ok === false;
  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;
  const canSubmit =
    !!selectedUnit && ref.trim().length > 0 && !costInvalid && !reasonTooShort && !action.isPending;

  function submit() {
    if (!selectedUnit) return;
    const parsed = parseCostReais(costReais);
    if (parsed.ok === false) return;
    const hasCost = parsed.unknownCost === false;

    action.mutate(
      {
        action: "register_instance",
        // Fixos: a fase inteira registra o que já existe no fornecedor, e o
        // único provedor do inventário é a Z-API.
        intent: "BACKFILL_EXISTING",
        provider: "zapi",
        organization_id: selectedUnit.organization_id,
        unit_id: selectedUnit.id,
        channel_id: channelId === NO_CHANNEL ? null : channelId,
        provider_instance_ref: ref.trim(),
        current_monthly_cost_cents: hasCost ? parsed.cents : null,
        // Procedência só faz sentido quando existe número. Mandá-la com custo
        // nulo afirmaria a origem de um valor que não foi informado.
        ...(hasCost ? { cost_source: costSource } : {}),
        reason,
      },
      {
        onSuccess: (data: unknown) => {
          const instance = (data as { instance: WhatsappInstance }).instance;
          toast.success("Instância registrada.");
          reset();
          onOpenChange(false);
          onRegistered(instance);
        },
        // A EF devolve mensagem curta em PT-BR (409 de duplicata, 409 de tenant,
        // 400 do identificador com URL); o hook já a extraiu do corpo non-2xx
        // que o `invoke` mascara.
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Registrar instância existente</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A instância precisa ter sido criada antes no painel da Z-API. Este registro é a
            afirmação da plataforma sobre o que existe lá — ele não cria nada no fornecedor.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="reg-unit">Unidade</Label>
            <Select value={unitId} onValueChange={setUnitId}>
              <SelectTrigger id="reg-unit" className="h-12 sm:h-10">
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
            <p className="text-xs text-muted-foreground">
              Obrigatória. Instância sem unidade não é alcançada por nenhum alerta do worker e
              vira órfã silenciosa.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="reg-channel">Canal (opcional)</Label>
            <Select value={channelId} onValueChange={setChannelId} disabled={!unitId}>
              <SelectTrigger id="reg-channel" className="h-12 sm:h-10">
                <SelectValue placeholder={unitId ? "Sem canal por enquanto" : "Escolha a unidade primeiro"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>Sem canal por enquanto</SelectItem>
                {(channelsQuery.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.provider} · {c.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {channelsQuery.isError && (
              <p className="text-xs text-destructive">
                Não foi possível carregar os canais desta unidade. Você pode registrar sem canal e
                corrigir o vínculo depois.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              É normal a instância existir antes de o canal estar configurado. O vínculo pode ser
              corrigido depois.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="reg-ref">Identificador da instância no fornecedor</Label>
            <Input
              id="reg-ref"
              className="h-12 sm:h-10 font-mono"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="Ex.: 3D1A2B4C5D6E"
            />
            {/* A advertência vem ANTES do erro, não só depois: colar a URL de
                envio inteira aqui vazaria o token para uma tabela que a spec
                declara livre de segredo. */}
            <p className="text-xs text-warning">
              Apenas o identificador da instância, <strong>nunca a URL</strong> — ela contém o
              token.
            </p>
            <p className="text-xs text-muted-foreground">
              Obrigatório. Sem ele o registro é recusado: backfill sem referência da instância real
              é conexão nova entrando por outra porta.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="reg-cost">Custo mensal (R$)</Label>
              <Input
                id="reg-cost"
                inputMode="decimal"
                className="h-12 sm:h-10"
                value={costReais}
                onChange={(e) => setCostReais(e.target.value)}
                placeholder="Ex.: 99,90"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-cost-source">Procedência do custo</Label>
              <Select
                value={costSource}
                onValueChange={setCostSource}
                disabled={cost.ok === false || cost.unknownCost === true}
              >
                <SelectTrigger id="reg-cost-source" className="h-12 sm:h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COST_SOURCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {costInvalid ? (
            <p className="text-sm text-destructive">{cost.message}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Vazio grava <strong>desconhecido</strong>, nunca zero — e o ciclo fica pendente de
              revisão até o número existir.
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="reg-reason">Motivo (fica registrado no histórico)</Label>
            <Textarea
              id="reg-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Ex.: instância criada na Z-API em 03/08 para a contratação da rede X."
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Cancelar
            </Button>
            <Button disabled={!canSubmit} onClick={submit}>
              Registrar
            </Button>
          </div>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
