import { useState } from "react";
import { Bot } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { StoreTextCounter } from "@/components/ai/StoreTextCounter";
import {
  useAiStoreSettings,
  useSaveAiStoreSettings,
  type AgentMode,
  type AiStoreTexts,
} from "@/hooks/useAiStoreSettings";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { AI_STORE_SETTING_KEYS, type AiStoreSettingKey } from "@/lib/ai-store-settings";
import { isValidStoreText, settingsWriteErrorMessage, storeTextDescribedBy } from "@/lib/store-text";
import { normalizeNewlines } from "@/lib/text-normalize";

const FIELDS: Record<AiStoreSettingKey, { label: string; rows: number; placeholder: string; hint?: string }> = {
  restaurant_menu: {
    label: "Cardápio",
    rows: 8,
    placeholder: "https://seurestaurante.com/cardapio — ou cole o cardápio em texto simples",
    hint: "Deixe em branco para a IA não citar o cardápio.",
  },
  delivery_response: {
    label: "Delivery/retirada",
    rows: 4,
    placeholder: "Não fazemos delivery. Para pedidos fora do restaurante, sugerimos os apps iFood e Rappi.",
    hint: "Se a loja não faz delivery ou retirada, deixe claro aqui para a IA orientar o cliente.",
  },
  restaurant_extra_info: {
    label: "Outras informações",
    rows: 6,
    placeholder: "Estacionamento gratuito na rua X. Aceitamos pets na área externa. Dress code às sextas.",
    hint: "Estacionamento, contatos, regras da casa.",
  },
};

const MODE_LABEL: Record<AgentMode, string> = {
  reservations: "Apenas reservas",
  reservations_faq: "Reservas + dúvidas",
};

function LoadingState() {
  return (
    <div className="space-y-4" data-testid="atendimento-ia-loading">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

interface StoreTextsFormProps {
  initial: AiStoreTexts;
  agentMode: AgentMode;
  unitId: string;
}

function StoreTextsForm({ initial, agentMode, unitId }: StoreTextsFormProps) {
  const save = useSaveAiStoreSettings(unitId);
  // Só o que o usuário editou; o resto vem do dado salvo e acompanha a releitura depois de salvar.
  const [edits, setEdits] = useState<Partial<AiStoreTexts>>({});
  const raw: AiStoreTexts = { ...initial, ...edits };
  // O que o banco vai medir: com as quebras já normalizadas.
  const prepared = Object.fromEntries(AI_STORE_SETTING_KEYS.map((k) => [k, normalizeNewlines(raw[k])])) as AiStoreTexts;
  const allValid = AI_STORE_SETTING_KEYS.every((k) => isValidStoreText(k, prepared[k]));

  const handleSave = () => {
    if (!allValid || save.isPending) return;
    save.mutate(prepared, {
      onSuccess: () => {
        setEdits({});
        toast.success("Textos do atendimento salvos.");
      },
      onError: (err) => toast.error(settingsWriteErrorMessage(err)),
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="py-4 space-y-1">
          <p className="text-sm font-medium">Modo atual: {MODE_LABEL[agentMode]}</p>
          <p className="text-sm text-muted-foreground">
            Estes textos só são usados quando o atendimento está no modo reservas + dúvidas. O modo é mudado pela
            plataforma.
          </p>
        </CardContent>
      </Card>

      <div className="space-y-1 text-sm text-muted-foreground">
        <p>Escreva informações, não ordens para a IA.</p>
        <p>Promoções e preços por dia vão em Reservas → Ajustes → Preços e condições.</p>
      </div>

      {AI_STORE_SETTING_KEYS.map((key) => {
        const field = FIELDS[key];
        const invalid = !isValidStoreText(key, prepared[key]);
        return (
          <div key={key} className="space-y-2">
            <Label htmlFor={`store-${key}`}>{field.label}</Label>
            <Textarea
              id={`store-${key}`}
              rows={field.rows}
              value={raw[key]}
              onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder={field.placeholder}
              disabled={save.isPending}
              aria-invalid={invalid}
              aria-describedby={storeTextDescribedBy(`store-${key}`, invalid)}
              className="text-sm"
            />
            {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
            <StoreTextCounter id={`store-${key}`} storeKey={key} value={prepared[key]} />
          </div>
        );
      })}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!allValid || save.isPending}>
          {save.isPending ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

export default function AtendimentoIa() {
  const unit = useCurrentUnit();
  const canEdit = !!unit?.isGerente;
  // Só lê quando pode editar: operador nem chega à Gestão, mas a tela não confia só na rota.
  const settings = useAiStoreSettings(canEdit ? unit.unit_id : "");

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Atendimento por IA</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Informações da loja que o agente de WhatsApp usa para responder dúvidas dos clientes.
        </p>
      </div>

      {!unit && <LoadingState />}

      {unit && !canEdit && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Só o dono ou o gerente da loja edita o atendimento por IA.
          </CardContent>
        </Card>
      )}

      {canEdit && settings.isLoading && <LoadingState />}

      {canEdit && !settings.isLoading && settings.isError && (
        <Card>
          <CardContent className="py-8 text-center space-y-3">
            <p className="text-sm text-destructive">Não foi possível carregar os textos do atendimento.</p>
            <Button variant="outline" size="sm" onClick={() => settings.refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {canEdit && !settings.isLoading && !settings.isError && settings.data && (
        <StoreTextsForm
          // Troca de unidade zera as edições.
          key={unit.unit_id}
          initial={settings.data.texts}
          agentMode={settings.data.agentMode}
          unitId={unit.unit_id}
        />
      )}
    </div>
  );
}
