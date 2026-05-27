import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, Building2, Check, Copy, CreditCard, Info, KeyRound, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { useAllUnits } from "@/hooks/useAllUnits";
import {
  usePlatformSecrets,
  useUpsertPlatformSecret,
  useDeletePlatformSecret,
} from "@/hooks/usePlatformSecrets";

const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/stripe-webhook`.replace(/\/+$/, "");

const SECRET_LABELS: Record<string, string> = {
  stripe_secret_key: "Chave secreta (Secret Key)",
  stripe_webhook_secret: "Webhook Signing Secret",
};

const SECRET_PLACEHOLDERS: Record<string, string> = {
  stripe_secret_key: "sk_test_... ou sk_live_...",
  stripe_webhook_secret: "whsec_...",
};

export default function PlatformAutomacao() {
  const { data: units, isLoading } = useAllUnits();

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Automação</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Configure a plataforma de pagamentos e selecione unidades para WhatsApp e IA.
        </p>
      </div>

      <StripeConfigCard />

      <div>
        <h2 className="text-lg font-semibold mb-3">Unidades</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa</TableHead>
                <TableHead>Unidade</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead className="w-[160px] text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Carregando…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && (!units || units.length === 0) && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    <Building2 className="mx-auto h-8 w-8 mb-2 opacity-30" />
                    Nenhuma unidade cadastrada ainda.
                  </TableCell>
                </TableRow>
              )}
              {units?.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.organization_name}</TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {u.slug}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline" className="gap-1">
                      <Link to={`/platform/automacao/${u.slug}`}>
                        Configurar
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function StripeConfigCard() {
  const { data: secrets, isLoading } = usePlatformSecrets();
  const upsertSecret = useUpsertPlatformSecret();
  const deleteSecret = useDeletePlatformSecret();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  const handleSave = (key: string) => {
    const value = inputs[key]?.trim();
    if (!value || value.length < 10) {
      toast.error("Valor muito curto.");
      return;
    }
    upsertSecret.mutate(
      { key, value },
      { onSuccess: () => setInputs((prev) => ({ ...prev, [key]: "" })) },
    );
  };

  const handleCopyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
      setCopiedWebhook(true);
      toast.success("URL do webhook copiada.");
      setTimeout(() => setCopiedWebhook(false), 2000);
    } catch {
      toast.error("Não foi possível copiar.");
    }
  };

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Stripe — Configuração da Plataforma</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Chaves globais da plataforma Moralles. Cada restaurante conecta sua própria conta Stripe
          via a aba "Pagamentos" da unidade.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {(secrets ?? []).map((secret) => (
          <div key={secret.key} className="rounded-lg border p-4 space-y-3 bg-muted/30">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-primary shrink-0" />
              {SECRET_LABELS[secret.key] ?? secret.key}
            </div>

            {secret.configured ? (
              <div className="flex items-center justify-between rounded bg-background border px-3 py-2">
                <div className="space-y-0.5">
                  <p className="font-mono text-sm">••••••••{secret.last4}</p>
                  {secret.updated_at && (
                    <p className="text-[11px] text-muted-foreground">
                      Atualizada em {new Date(secret.updated_at).toLocaleString("pt-BR")}
                    </p>
                  )}
                </div>
                <Badge variant="outline" className="text-[10px] text-green-700 border-green-200 bg-green-50">
                  Configurada
                </Badge>
              </div>
            ) : (
              <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Não configurada. Cole o valor abaixo.
              </div>
            )}

            <div className="flex gap-2">
              <Input
                type="password"
                autoComplete="off"
                placeholder={SECRET_PLACEHOLDERS[secret.key] ?? "Valor do secret"}
                value={inputs[secret.key] ?? ""}
                onChange={(e) => setInputs((prev) => ({ ...prev, [secret.key]: e.target.value }))}
                disabled={upsertSecret.isPending || deleteSecret.isPending}
              />
              <Button
                onClick={() => handleSave(secret.key)}
                disabled={!(inputs[secret.key]?.trim()) || upsertSecret.isPending}
              >
                {upsertSecret.isPending ? "Salvando…" : "Salvar"}
              </Button>
              {secret.configured && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={deleteSecret.isPending}
                      title="Remover"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Remover {SECRET_LABELS[secret.key]}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        As funcionalidades de pagamento Stripe ficarão inativas até um
                        novo valor ser cadastrado. Esta ação não pode ser desfeita.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction onClick={() => deleteSecret.mutate(secret.key)}>
                        Remover
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        ))}

        <div className="rounded-lg border p-4 space-y-2 bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Info className="h-4 w-4 text-primary shrink-0" />
            URL do Webhook Stripe
          </div>
          <p className="text-xs text-muted-foreground">
            Configure esta URL no{" "}
            <span className="font-medium">Stripe Dashboard &gt; Developers &gt; Webhooks &gt; Add endpoint</span>.
            Selecione os eventos <code className="text-[10px] bg-muted px-1 rounded">checkout.session.completed</code> e{" "}
            <code className="text-[10px] bg-muted px-1 rounded">checkout.session.expired</code>.
          </p>
          <div className="flex items-center gap-1.5">
            <code className="font-mono bg-background border px-2 py-1 rounded text-xs truncate flex-1 min-w-0">
              {WEBHOOK_URL}
            </code>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 shrink-0"
              onClick={handleCopyWebhook}
            >
              {copiedWebhook ? (
                <Check className="h-3 w-3 text-green-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Após criar o endpoint, copie o <span className="font-medium">Signing secret</span> (começa com <code className="text-[10px] bg-muted px-1 rounded">whsec_</code>)
            e cole no campo "Webhook Signing Secret" acima.
          </p>
        </div>

        <div className="flex items-start gap-2 text-[11px] text-muted-foreground rounded bg-background border border-dashed p-2">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            As chaves ficam criptografadas no banco e nunca são expostas no frontend — apenas
            as Edge Functions do servidor as leem para processar pagamentos. O painel mostra
            apenas os últimos 4 caracteres.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
