import { Card, CardContent } from "@/components/ui/card";
import { DollarSign } from "lucide-react";
import { BreadcrumbRelatorios } from "./FluxoClientes";

export default function RelatorioVendas() {
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbRelatorios current="Vendas" />
        <h1 className="text-2xl font-bold">Vendas</h1>
      </header>

      <Card>
        <CardContent className="py-16 text-center text-muted-foreground space-y-3 max-w-md mx-auto">
          <DollarSign className="h-10 w-10 mx-auto opacity-30" />
          <h2 className="text-base font-medium text-foreground">Em breve</h2>
          <p className="text-sm">
            Receita por canal (reserva, fila, walk-in), ticket médio, conversão de
            cobrança antecipada, cupons aplicados — disponíveis assim que os
            pagamentos integrados forem ativados nas configurações de reserva.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
