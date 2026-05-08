import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";

export interface ShareCardProps {
  /** URL pública a ser compartilhada. */
  url: string;
  /** Título da seção. Default "Link para compartilhamento". */
  title?: string;
  /** Texto auxiliar abaixo do título. */
  description?: string;
}

/**
 * Bloco de compartilhamento padrão: link com ícone de link externo + botão
 * Copiar com feedback "Copiado" por 2s. Reutilizado por WidgetDetail e
 * MenuDetail.
 */
export function ShareCard({
  url,
  title = "Link para compartilhamento",
  description = "Utilize o link abaixo para compartilhar.",
}: ShareCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copiado.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar.");
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>

      <div className="flex items-center gap-2 rounded-md border p-3 bg-muted/30">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 text-primary hover:underline font-mono text-sm truncate inline-flex items-center gap-1"
        >
          {url}
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCopy}
          className="gap-2 shrink-0"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copiado" : "Copiar"}
        </Button>
      </div>
    </div>
  );
}
