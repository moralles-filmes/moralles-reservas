import { CreditCard, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BILLING_STATUS_LABEL, type BillingStatus } from "@/types/billing";

interface Props {
  status: BillingStatus;
  blockedReason?: string | null;
}

export default function PaymentRequired({ status, blockedReason }: Props) {
  return (
    <div className="theme-admin min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-red-100 flex items-center justify-center">
            <CreditCard className="h-8 w-8 text-red-600" />
          </div>
          <CardTitle className="text-xl">Acesso suspenso</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <p className="text-muted-foreground">
            Sua conta está com status <strong>{BILLING_STATUS_LABEL[status] ?? status}</strong>.
          </p>
          {blockedReason && (
            <p className="text-sm text-muted-foreground">Motivo: {blockedReason}</p>
          )}
          <p className="text-sm">
            Regularize sua mensalidade para restaurar o acesso ao sistema.
            O acesso será reativado automaticamente após a confirmação do pagamento.
          </p>
          <div className="pt-2 space-y-2">
            <Button className="w-full" asChild>
              <a href="mailto:suporte@moralles.com.br">
                <Mail className="mr-2 h-4 w-4" /> Falar com suporte
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
