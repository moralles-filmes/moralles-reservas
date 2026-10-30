import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";
import { BreadcrumbCardapios } from "./Banners";

export default function CardapiosAjustes() {
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbCardapios current="Ajustes" />
        <h1 className="text-2xl font-bold">Configurações de cardápio</h1>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex border-b">
          <div className="px-5 py-3 text-sm font-medium border-b-2 -mb-px border-primary text-primary">
            Integrações
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-2xl">
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Google Menu</h2>
            <p className="text-sm text-muted-foreground">
              Sincronize automaticamente seus cardápios com o Google Business Profile —
              clientes que pesquisarem seu restaurante no Google verão o cardápio direto
              nos resultados.
            </p>

            <div className="flex items-center gap-2 pt-1">
              <Switch id="cardapios-google-menu" checked={false} disabled />
              <Label htmlFor="cardapios-google-menu" className="text-sm flex items-center gap-1.5 text-muted-foreground">
                Habilitar Google Menu
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Em breve. Vamos conectar com a API do Google Business Profile pra
                      espelhar seus cardápios automaticamente.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <span className="ml-auto text-[10px] uppercase tracking-wider text-warning bg-warning/10 border border-warning/20 rounded-full px-2 py-0.5">
                Em breve
              </span>
            </div>
          </section>

          <div className="border-t pt-4 flex justify-end">
            <Button disabled>Salvar</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
