import { useEffect, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useGiftbackSettings,
  useUpdateGiftbackSettings,
  renderGiftbackTemplate,
  DEFAULT_GIFTBACK_TEMPLATE,
} from "@/hooks/useGiftbackSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Gift, RotateCcw } from "lucide-react";

const VARIABLE_CHIPS = [
  { var: "{{discount}}", desc: "Percentual do desconto" },
  { var: "{{codigo}}", desc: "Código do voucher (ex: ABC12345)" },
  { var: "{{validade}}", desc: "Data de validade (DD/MM/AAAA)" },
  { var: "{{unidade}}", desc: "Nome da unidade" },
];

export default function Ajustes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const { data, isLoading } = useGiftbackSettings(unitId);
  const update = useUpdateGiftbackSettings(unitId);

  const [whatsapp, setWhatsapp] = useState(true);
  const [email, setEmail] = useState(false);
  const [template, setTemplate] = useState("");

  useEffect(() => {
    if (data) {
      setWhatsapp(data.giftback_whatsapp_enabled);
      setEmail(data.giftback_email_enabled);
      setTemplate(data.giftback_message_template);
    }
  }, [data]);

  const dirty =
    !!data &&
    (whatsapp !== data.giftback_whatsapp_enabled ||
      email !== data.giftback_email_enabled ||
      template !== data.giftback_message_template);

  const save = () => {
    update.mutate({
      giftback_whatsapp_enabled: whatsapp,
      giftback_email_enabled: email,
      giftback_message_template: template,
    });
  };

  const preview = renderGiftbackTemplate(template || DEFAULT_GIFTBACK_TEMPLATE, {
    discount: 15,
    codigo: "ABC12345",
    validade: "30/06/2026",
    unidade: unit?.unit_name ?? "Restaurante",
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5 text-gold" />
          <h1 className="text-2xl font-bold">Ajustes do Giftback</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Configure por onde o cliente recebe o voucher e como a mensagem é apresentada.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Canais de envio</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">WhatsApp</Label>
              <p className="text-xs text-muted-foreground">
                Envia o código do voucher pela conversa do WhatsApp ativa.
              </p>
            </div>
            <Switch checked={whatsapp} onCheckedChange={setWhatsapp} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3 opacity-60">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">E-mail</Label>
              <p className="text-xs text-muted-foreground">
                Envio por e-mail (Resend) chega em uma fase futura.
              </p>
            </div>
            <Switch checked={email} onCheckedChange={setEmail} disabled />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Template da mensagem</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTemplate(DEFAULT_GIFTBACK_TEMPLATE)}
            className="gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restaurar padrão
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={8}
            className="font-mono text-sm"
          />
          <div>
            <p className="text-xs font-medium mb-1.5">Variáveis disponíveis:</p>
            <div className="flex flex-wrap gap-1.5">
              {VARIABLE_CHIPS.map((chip) => (
                <button
                  key={chip.var}
                  type="button"
                  onClick={() => setTemplate((t) => `${t}${chip.var}`)}
                  className="text-[11px] font-mono px-2 py-1 bg-muted hover:bg-muted/70 rounded border"
                  title={chip.desc}
                >
                  {chip.var}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-md bg-success/10 border border-success/20 p-3 text-sm whitespace-pre-wrap">
            <p className="text-[11px] uppercase tracking-wider text-success font-medium mb-1.5">
              Pré-visualização
            </p>
            {preview}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending ? "Salvando…" : "Salvar alterações"}
        </Button>
      </div>
    </div>
  );
}
