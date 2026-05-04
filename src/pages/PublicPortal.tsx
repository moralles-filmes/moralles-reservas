import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Link } from "react-router-dom";
import { ReservaForm } from "@/components/reserva/ReservaForm";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useReservaByCode } from "@/hooks/useReservas";
import { CalendarIcon, Search } from "lucide-react";

interface PublicUnit {
  id: string;
  name: string;
  slug: string;
  organization_id: string;
}

export default function PublicPortal() {
  const { slug } = useParams<{ slug: string }>();
  const [code, setCode] = useState("");
  const [searchCode, setSearchCode] = useState("");

  const { data: unit, isLoading, error } = useQuery({
    queryKey: ["public-unit", slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units")
        .select("id, name, slug, organization_id")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      return data as PublicUnit | null;
    },
    enabled: !!slug,
  });

  const { data: reserva, isLoading: loadingReserva } = useReservaByCode(
    searchCode,
    unit?.id
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Skeleton className="h-12 w-48" />
      </div>
    );
  }

  if (error || !unit) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <p className="text-lg font-semibold">Restaurante não encontrado.</p>
        <p className="text-sm text-muted-foreground">Verifique o link e tente novamente.</p>
        <Link to="/">
          <Button variant="outline" size="sm">Página inicial</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-5 w-5 text-primary" />
            <span className="font-semibold text-lg">{unit.name}</span>
          </div>
          <Link to="/admin/login">
            <Button variant="ghost" size="sm">Área Admin</Button>
          </Link>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="grid lg:grid-cols-2 gap-12 items-start">
          <div>
            <div className="mb-8">
              <h1 className="text-3xl font-bold mb-2">Faça sua reserva</h1>
              <p className="text-muted-foreground">
                Reserve sua mesa com facilidade. A confirmação será enviada via WhatsApp.
              </p>
            </div>
            <ReservaForm unit={unit} />
          </div>

          <div className="lg:pt-16">
            <Card>
              <CardContent className="pt-6">
                <h2 className="font-semibold text-lg mb-1">Consultar reserva</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Informe o código para ver sua reserva.
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Ex: AB1C2DEF"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    className="font-mono"
                    maxLength={8}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => setSearchCode(code)}
                    disabled={code.length < 4}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>

                {loadingReserva && (
                  <p className="text-sm text-muted-foreground mt-3">Buscando...</p>
                )}
                {searchCode && !loadingReserva && !reserva && (
                  <p className="text-sm text-destructive mt-3">
                    Reserva não encontrada. Verifique o código.
                  </p>
                )}
                {reserva && (
                  <div className="mt-4">
                    <ReservaCard reserva={reserva} />
                    {(reserva.status === "confirmed" || reserva.status === "pending") && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Para alterar ou cancelar, envie uma mensagem no WhatsApp com o código #{reserva.reservation_code}.
                      </p>
                    )}
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
