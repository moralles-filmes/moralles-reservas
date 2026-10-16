import { useState } from "react";
import { Check, Copy, CreditCard, Info, KeyRound, MessageSquare, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { toast } from "sonner";
import {
  usePlatformSecrets,
  useUpsertPlatformSecret,
  useDeletePlatformSecret,
  type PlatformSecret,
} from "@/hooks/usePlatformSecrets";

const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/stripe-webhook`.replace(/\/+$/, "");

const SECRET_LABELS: Record<string, string> = {
  datafy_account_token: "Token da conta Datafy",
  stripe_secret_key: "Chave secreta (Secret Key)",
  stripe_webhook_secret: "Webhook Signing Secret",
  asaas_api_key: "Chave da API (Access Token)",
  asaas_webhook_token: "Token de autenticação do webhook",
};

const SECRET_PLACEHOLDERS: Record<string, string> = {
  datafy_account_token: "sk_acct_...",
  stripe_secret_key: "sk_test_... ou sk_live_...",
  stripe_webhook_secret: "whsec_...",
  asaas_api_key: "$aact_hmlg_... ou $aact_prod_...",
  asaas_webhook_token: "Token do header asaas-access-token",
};

const KEY_PROVIDER: Record<string, "datafy" | "stripe" | "asaas"> = {
  datafy_account_token: "datafy",
  stripe_secret_key: "stripe",
  stripe_webhook_secret: "stripe",
  asaas_api_key: "asaas",
  asaas_webhook_token: "asaas",
};

const PROVIDER_LABELS: Record<"stripe" | "asaas", string> = {
  stripe: "Stripe",
  asaas: "Asaas",
};

export default function PlatformIntegracoes() {
  const { data: secrets, isLoading, isError, error, refetch } = usePlatformSecrets();
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

  const byProvider = (provider: "datafy" | "stripe" | "asaas") =>
    (secrets ?? []).filter((secret) => KEY_PROVIDER[secret.key] === provider);
  // Chave que a EF conhece (VALID_KEYS) mas que esta tela ainda não mapeou em
  // KEY_PROVIDER cai aqui — visível num cartão próprio em vez de sumir sem aviso.
  const otherSecrets = (secrets ?? []).filter((secret) => !KEY_PROVIDER[secret.key]);

  const removalDescription = (key: string) => {
    const provider = KEY_PROVIDER[key];
    if (provider === "datafy") {
      return "Ao remover, a conexão oficial de novas lojas fica indisponível até um novo token ser cadastrado.";
    }
    const label = provider ? PROVIDER_LABELS[provider] : key;
    return `As funcionalidades de pagamento ${label} ficarão inativas até um novo valor ser cadastrado. Esta ação não pode ser desfeita.`;
  };

  const renderSecretRow = (secret: PlatformSecret) => (
    <div key={secret.key} className="rounded-lg border p-4 space-y-3 bg-muted/30">
      <Label htmlFor={`platform-secret-${secret.key}`} className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4 text-primary shrink-0" />
        {SECRET_LABELS[secret.key] ?? secret.key}
      </Label>

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
          <Badge variant="outline" className="text-[10px] text-success border-success/20 bg-success/10">
            Configurada
          </Badge>
        </div>
      ) : (
        <div className="rounded border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          Não configurada. Cole o valor abaixo.
        </div>
      )}

      <div className="flex gap-2">
        <Input
          id={`platform-secret-${secret.key}`}
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
              <Button variant="outline" size="icon" disabled={deleteSecret.isPending} title="Remover">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remover {SECRET_LABELS[secret.key] ?? secret.key}?</AlertDialogTitle>
                <AlertDialogDescription>{removalDescription(secret.key)}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteSecret.mutate(secret.key)}>Remover</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Integrações e chaves</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Credenciais globais da plataforma. Ficam criptografadas no banco e só as Edge Functions as
          leem; o painel mostra apenas os últimos 4 caracteres.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {!isLoading && isError && (
        <Card>
          <CardContent className="py-8 text-center space-y-3">
            <p className="text-sm text-destructive">
              {error?.message ?? "Não foi possível carregar as chaves."}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-primary" />
                <CardTitle className="text-base">WhatsApp oficial (Datafy)</CardTitle>
              </div>
              <p className="text-sm text-muted-foreground">
                Token da conta parceira usado para preparar a conexão oficial de novas lojas.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">{byProvider("datafy").map(renderSecretRow)}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-primary" />
                <CardTitle className="text-base">Stripe</CardTitle>
              </div>
              <p className="text-sm text-muted-foreground">
                Conta principal, usada na cobrança das mensalidades. Cada restaurante conecta sua
                própria conta Stripe (Connect) em Unidades › Configurar › Pagamentos, mas essa conexão
                e o checkout de caução de reserva dependem da chave secreta abaixo — ela não é
                exclusiva da cobrança.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {byProvider("stripe").map(renderSecretRow)}

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
                  <Button size="sm" variant="ghost" className="h-7 px-2 shrink-0" onClick={handleCopyWebhook}>
                    {copiedWebhook ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Após criar o endpoint, copie o <span className="font-medium">Signing secret</span> (começa com{" "}
                  <code className="text-[10px] bg-muted px-1 rounded">whsec_</code>) e cole no campo "Webhook
                  Signing Secret" acima.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-primary" />
                <CardTitle className="text-base">Asaas</CardTitle>
              </div>
              <p className="text-sm text-muted-foreground">
                Chave da API e token de autenticação do webhook da conta Asaas da plataforma.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">{byProvider("asaas").map(renderSecretRow)}</CardContent>
          </Card>

          {otherSecrets.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Outras chaves</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Chaves existentes no servidor sem provedor mapeado nesta tela ainda. Configuráveis
                  normalmente abaixo — avise o time de dev para classificá-las.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">{otherSecrets.map(renderSecretRow)}</CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
