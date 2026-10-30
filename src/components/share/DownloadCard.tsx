import { useEffect, useRef } from "react";
import QRCode from "qrcode";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, MonitorPlay, QrCode } from "lucide-react";
import { toast } from "sonner";

export interface DownloadCardProps {
  /** URL pública codificada no QR. */
  url: string;
  /** Título do card. Default "Download". */
  title?: string;
  /** Texto auxiliar abaixo do título. */
  description?: string;
  /** Nome do arquivo gerado no download. Default "qr-code.png". */
  fileName?: string;
}

/**
 * Card de download de QR Code reutilizável. Usado pelo módulo Fila (link da fila),
 * Cardápios (link do cardápio público) e onde houver outro link público com QR.
 *
 * Render preview ~200x200 + botões "QR Code" (download PNG 800x800) e "Display"
 * (stub disabled "em breve").
 */
export function DownloadCard({
  url,
  title = "Download",
  description = "Faça o download do QR Code para utilizar em seu restaurante.",
  fileName = "qr-code.png",
}: DownloadCardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !url) return;
    QRCode.toCanvas(canvasRef.current, url, {
      width: 200,
      margin: 1,
      // QR fica escuro sobre branco nos dois temas: leitores falham com contraste invertido.
      color: { dark: "#0f172a", light: "#ffffff" },
    }).catch(() => {
      /* noop */
    });
  }, [url]);

  const handleDownload = async () => {
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        width: 800,
        margin: 2,
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = fileName;
      a.click();
    } catch (err) {
      console.error(err);
      toast.error("Erro ao gerar QR Code.");
    }
  };

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="flex justify-center">
        <canvas ref={canvasRef} className="rounded border border-border" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={handleDownload}
        >
          <QrCode className="h-3.5 w-3.5" />
          QR Code
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled
          title="Em breve"
        >
          <MonitorPlay className="h-3.5 w-3.5" />
          Display
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground text-center break-all">{url}</p>
    </Card>
  );
}
