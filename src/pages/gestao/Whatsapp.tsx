import { useEffect, useRef } from "react";
import { Navigate } from "react-router-dom";
import QRCode from "qrcode";
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  MessageCircle,
  Power,
  QrCode,
  RefreshCw,
  RotateCw,
  Smartphone,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { WhatsappServiceBanner } from "@/components/billing/WhatsappServiceBanner";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useConnectWhatsapp,
  useDisconnectWhatsapp,
  useRefreshWhatsappQr,
  useRefreshWhatsappStatus,
  useRestartWhatsapp,
  useWhatsappConnection,
  type WhatsappConnectionSnapshot,
  type WhatsappConnectionStatus,
} from "@/hooks/useWhatsappConnection";
import { formatPhone } from "@/lib/utils";

const TRANSIENT_COPY: Partial<Record<WhatsappConnectionStatus, { title: string; text: string }>> = {
  provisioning: {
    title: "Preparando sua conexão",
    text: "Estamos configurando o canal seguro. Isso pode levar alguns instantes.",
  },
  connecting: {
    title: "Conectando o número",
    text: "Aguarde enquanto preparamos e confirmamos a conexão com o WhatsApp.",
  },
  reconnecting: {
    title: "Reconectando",
    text: "Estamos restabelecendo a conexão com o WhatsApp.",
  },
  switching_provider: {
    title: "Atualizando a conexão",
    text: "A configuração está sendo preparada sem interromper o canal atual.",
  },
};

function formatTimestamp(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isSafeInlineQrImage(value: string) {
  return /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(value);
}

function looksLikePngBase64(value: string) {
  return value.length > 100 && /^iVBOR[a-z0-9+/=]+$/i.test(value);
}

function ConnectionQr({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageSource = isSafeInlineQrImage(value)
    ? value
    : looksLikePngBase64(value)
      ? `data:image/png;base64,${value}`
      : null;

  useEffect(() => {
    if (!canvasRef.current || imageSource) return;
    QRCode.toCanvas(canvasRef.current, value, {
      width: 240,
      margin: 2,
      color: { dark: "#0f172a", light: "#ffffff" },
    }).catch(() => undefined);
  }, [imageSource, value]);

  return (
    <div className="flex justify-center rounded-xl border bg-white p-3">
      {imageSource ? (
        <img
          src={imageSource}
          alt="QR Code para conectar o WhatsApp"
          className="h-60 w-60 object-contain"
        />
      ) : (
        <canvas
          ref={canvasRef}
          aria-label="QR Code para conectar o WhatsApp"
          className="h-60 w-60 max-w-full"
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: WhatsappConnectionStatus }) {
  if (status === "connected") return <Badge variant="success">Online</Badge>;
  if (["provider_error", "error", "suspended"].includes(status)) {
    return <Badge variant="destructive">Atenção</Badge>;
  }
  if (["not_configured", "disconnected"].includes(status)) {
    return <Badge variant="secondary">Desconectado</Badge>;
  }
  return <Badge variant="info">Em andamento</Badge>;
}

function WaitingQrState({
  snapshot,
  refreshing,
  onRefresh,
}: {
  snapshot: WhatsappConnectionSnapshot;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <CardContent className="space-y-5">
      <div className="rounded-lg border border-info/20 bg-info/10 p-4">
        <div className="flex items-start gap-3">
          <QrCode className="mt-0.5 h-5 w-5 shrink-0 text-info" />
          <div>
            <p className="font-medium">Leia o QR Code no celular</p>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
              <li>Abra o WhatsApp e acesse Aparelhos conectados.</li>
              <li>Toque em Conectar um aparelho.</li>
              <li>Aponte a câmera para o código abaixo.</li>
            </ol>
          </div>
        </div>
      </div>

      {snapshot.qr_code ? (
        <ConnectionQr value={snapshot.qr_code} />
      ) : (
        <div className="flex min-h-60 items-center justify-center rounded-xl border bg-muted/30">
          <LoaderCircle className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          O código é temporário e pode levar alguns segundos para aparecer.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 gap-2"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Renovar QR Code
        </Button>
      </div>
    </CardContent>
  );
}

export default function Whatsapp() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const lifecycleUnitId = unit?.isGerente ? unitId : "";
  const connection = useWhatsappConnection(lifecycleUnitId);
  const connect = useConnectWhatsapp(lifecycleUnitId);
  const refreshQr = useRefreshWhatsappQr(lifecycleUnitId);
  const disconnect = useDisconnectWhatsapp(lifecycleUnitId);
  const restart = useRestartWhatsapp(lifecycleUnitId);
  const refreshStatus = useRefreshWhatsappStatus(lifecycleUnitId);
  const snapshot = connection.data;

  const actionPending =
    connect.isPending ||
    refreshQr.isPending ||
    disconnect.isPending ||
    restart.isPending ||
    refreshStatus.isPending;

  if (!unit || connection.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  if (!unit.isGerente) {
    return <Navigate to={`/g/${unit.unit_slug}/reservas`} replace />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <MessageCircle className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">WhatsApp</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Conecte o número usado pela automação e acompanhe o estado da conexão.
        </p>
      </div>

      <WhatsappServiceBanner
        organizationId={unit.organization_id}
        unitSlug={unit.unit_slug}
      />

      {connection.isError || !snapshot ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <AlertCircle className="h-10 w-10 text-destructive" />
            <div>
              <p className="font-semibold">Não foi possível consultar a conexão</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Tente novamente. Se o problema continuar, fale com o suporte.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2"
              onClick={() => connection.refetch()}
              disabled={connection.isFetching}
            >
              <RefreshCw className={connection.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle>Conexão do número</CardTitle>
              <CardDescription className="mt-1">
                Apenas proprietários e gerentes podem alterar esta conexão.
              </CardDescription>
            </div>
            <StatusBadge status={snapshot.status} />
          </CardHeader>

          {snapshot.status === "waiting_qr" && snapshot.qr_available ? (
            <WaitingQrState
              snapshot={snapshot}
              refreshing={refreshQr.isPending}
              onRefresh={() => refreshQr.mutate(snapshot.channel_id)}
            />
          ) : snapshot.status === "connected" ? (
            <CardContent className="space-y-5">
              <div className="flex items-start gap-4 rounded-xl border border-success/20 bg-success/10 p-4">
                <CheckCircle2 className="mt-0.5 h-7 w-7 shrink-0 text-success" />
                <div>
                  <p className="font-semibold text-success">WhatsApp conectado</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    A automação está pronta para receber e enviar mensagens.
                  </p>
                </div>
              </div>

              <dl className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Número conectado
                  </dt>
                  <dd className="mt-1 flex items-center gap-2 font-medium">
                    <Smartphone className="h-4 w-4 text-muted-foreground" />
                    {snapshot.display_phone ? formatPhone(snapshot.display_phone) : "Conectado"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Última conexão
                  </dt>
                  <dd className="mt-1 font-medium">{formatTimestamp(snapshot.connected_at)}</dd>
                </div>
              </dl>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 gap-2"
                  onClick={() => refreshStatus.mutate(snapshot.channel_id)}
                  disabled={actionPending}
                >
                  <RefreshCw className={refreshStatus.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                  Atualizar estado
                </Button>
                {snapshot.restart_available && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 gap-2"
                    onClick={() => restart.mutate(snapshot.channel_id)}
                    disabled={actionPending}
                  >
                    <RotateCw className={restart.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    Reiniciar conexão
                  </Button>
                )}
                {snapshot.disconnect_available && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="destructive"
                        className="min-h-11 gap-2"
                        disabled={actionPending}
                      >
                        <Power className="h-4 w-4" />
                        Desconectar
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Desconectar o WhatsApp?</AlertDialogTitle>
                        <AlertDialogDescription>
                          A automação deixará de receber e enviar mensagens até uma nova conexão.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => disconnect.mutate(snapshot.channel_id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Desconectar
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </CardContent>
          ) : ["not_configured", "disconnected"].includes(snapshot.status) ? (
            <CardContent className="space-y-5">
              <div className="flex items-start gap-4 rounded-xl border bg-muted/30 p-4">
                <WifiOff className="mt-0.5 h-7 w-7 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-semibold">Nenhum número conectado</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Inicie a conexão para gerar um QR Code e vincular o aparelho.
                  </p>
                </div>
              </div>
              {snapshot.qr_available ? (
                <Button
                  type="button"
                  className="min-h-11 gap-2"
                  onClick={() => connect.mutate(snapshot.channel_id)}
                  disabled={actionPending}
                >
                  <Smartphone className="h-4 w-4" />
                  {connect.isPending ? "Preparando…" : "Conectar WhatsApp"}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Este tipo de conexão é administrado sem pareamento por QR Code.
                </p>
              )}
            </CardContent>
          ) : ["provider_error", "error", "suspended"].includes(snapshot.status) ? (
            <CardContent className="space-y-5">
              <div className="flex items-start gap-4 rounded-xl border border-destructive/20 bg-destructive/10 p-4">
                <AlertCircle className="mt-0.5 h-7 w-7 shrink-0 text-destructive" />
                <div>
                  <p className="font-semibold">A conexão precisa de atenção</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Tente reconectar. Se o problema continuar, fale com o suporte.
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                {snapshot.restart_available ? (
                  <Button
                    type="button"
                    className="min-h-11 gap-2"
                    onClick={() => restart.mutate(snapshot.channel_id)}
                    disabled={actionPending}
                  >
                    <RotateCw className={restart.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    Tentar reconectar
                  </Button>
                ) : snapshot.qr_available ? (
                  <Button
                    type="button"
                    className="min-h-11 gap-2"
                    onClick={() => connect.mutate(snapshot.channel_id)}
                    disabled={actionPending}
                  >
                    <QrCode className="h-4 w-4" />
                    {connect.isPending ? "Preparando…" : "Gerar novo QR Code"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 gap-2"
                  onClick={() => refreshStatus.mutate(snapshot.channel_id)}
                  disabled={actionPending}
                >
                  <RefreshCw className={refreshStatus.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                  Atualizar estado
                </Button>
              </div>
              {!snapshot.restart_available && !snapshot.qr_available && (
                <p className="text-sm text-muted-foreground">
                  Esta conexão exige uma etapa adicional no provedor. Fale com o suporte.
                </p>
              )}
            </CardContent>
          ) : (
            <CardContent>
              <div className="flex items-start gap-4 rounded-xl border border-info/20 bg-info/10 p-4">
                <LoaderCircle className="mt-0.5 h-7 w-7 shrink-0 animate-spin text-info" />
                <div>
                  <p className="font-semibold">
                    {TRANSIENT_COPY[snapshot.status]?.title ?? "Conexão em andamento"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {TRANSIENT_COPY[snapshot.status]?.text ??
                      "Aguarde enquanto atualizamos o estado da conexão."}
                  </p>
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
