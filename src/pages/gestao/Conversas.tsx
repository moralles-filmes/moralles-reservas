import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR, formatPhone } from "@/lib/utils";
import type { Conversation } from "@/types/reserva";
import { MessageCircle } from "lucide-react";

export default function Conversas() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [selected, setSelected] = useState<Conversation | null>(null);

  const { data: conversations, isLoading } = useQuery({
    queryKey: ["conversations", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, customer:customers(*)")
        .eq("unit_id", unitId)
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as Conversation[];
    },
    enabled: !!unitId,
  });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Conversas WhatsApp</h1>

      <div className="grid lg:grid-cols-[300px,1fr] gap-4 h-[calc(100vh-180px)]">
        <Card className="flex flex-col overflow-hidden">
          <CardHeader className="py-3 px-4 border-b">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {conversations?.length || 0} conversas
            </CardTitle>
          </CardHeader>
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="p-3 space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : conversations?.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                Nenhuma conversa ainda.
              </div>
            ) : (
              conversations?.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className={`w-full text-left px-4 py-3 border-b transition-colors hover:bg-muted/50 ${
                    selected?.id === c.id ? "bg-muted" : ""
                  }`}
                >
                  <p className="font-medium text-sm truncate">
                    {c.customer?.name || formatPhone(c.customer?.phone || "")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatPhone(c.customer?.phone || "")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDateBR(c.updated_at)}
                  </p>
                </button>
              ))
            )}
          </ScrollArea>
        </Card>

        <Card className="flex flex-col overflow-hidden">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
              <MessageCircle className="h-10 w-10 opacity-30" />
              <p className="text-sm">Selecione uma conversa para visualizar</p>
            </div>
          ) : (
            <>
              <CardHeader className="py-3 px-4 border-b">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{selected.customer?.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {formatPhone(selected.customer?.phone || "")}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {selected.messages?.length || 0} mensagens
                  </Badge>
                </div>
              </CardHeader>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-3">
                  {(selected.messages || []).map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === "assistant" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                          msg.role === "assistant"
                            ? "bg-primary text-primary-foreground rounded-br-sm"
                            : "bg-muted rounded-bl-sm"
                        }`}
                      >
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                        <p className={`text-[10px] mt-1 ${
                          msg.role === "assistant" ? "text-primary-foreground/60" : "text-muted-foreground"
                        }`}>
                          {new Date(msg.timestamp).toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
