import { useState } from "react";
import { Link } from "react-router-dom";
import { ReservaForm } from "@/components/reserva/ReservaForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useReservaByCode } from "@/hooks/useReservas";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { CalendarIcon, Search } from "lucide-react";

export default function Index() {
  const [code, setCode] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const { data: reserva, isLoading } = useReservaByCode(searchCode);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-5 w-5 text-primary" />
            <span className="font-semibold text-lg">Moralles Reservas</span>
          </div>
          <Link to="/admin">
            <Button variant="ghost" size="sm">Área Admin</Button>
          </Link>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="grid lg:grid-cols-2 gap-12 items-start">
          {/* Left: Form */}
          <div>
            <div className="mb-8">
              <h1 className="text-3xl font-bold mb-2">Faça sua reserva</h1>
              <p className="text-muted-foreground">
                Reserve sua mesa com facilidade. A confirmação será enviada via WhatsApp.
              </p>
            </div>
            <ReservaForm />
          </div>

          {/* Right: Consultar reserva */}
          <div className="lg:pt-16">
            <Card>
              <CardContent className="pt-6">
                <h2 className="font-semibold text-lg mb-1">Consultar reserva</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Informe o código para ver ou cancelar sua reserva.
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Ex: AB1C2D"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    className="font-mono"
                    maxLength={6}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => setSearchCode(code)}
                    disabled={code.length < 4}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>

                {isLoading && (
                  <p className="text-sm text-muted-foreground mt-3">Buscando...</p>
                )}
                {searchCode && !isLoading && !reserva && (
                  <p className="text-sm text-destructive mt-3">
                    Reserva não encontrada. Verifique o código.
                  </p>
                )}
                {reserva && (
                  <div className="mt-4">
                    <ReservaCard reserva={reserva} />
                    {reserva.status === "confirmed" || reserva.status === "pending" ? (
                      <p className="text-xs text-muted-foreground mt-2">
                        Para alterar ou cancelar, envie uma mensagem no WhatsApp com o código #{reserva.reservation_code}.
                      </p>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
