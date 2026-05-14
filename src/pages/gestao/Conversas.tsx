import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useConversations, useConversationActions } from "@/hooks/useConversations";
import { useSendManualMessage } from "@/hooks/useSendManualMessage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateBR, formatPhone, getConversationDisplayName } from "@/lib/utils";
import { toast } from "sonner";
import { MessageCircle, UserCheck, Bot, CheckCircle, Send, Loader2 } from "lucide-react";
import type { Conversation, ConversationMessage, ConversationStatus } from "@/types/reserva";

// ── Status display helpers ─────────────────────────────────────────────────────

const STATUS_LABEL: Record<ConversationStatus, string> = {
  ai_active: "IA",
  awaiting_human: "Aguardando",
  human_active: "Em atendimento",
  resolved: "Resolvida",
};

const STATUS_CLASSES: Record<ConversationStatus, string> = {
  ai_active: "bg-emerald-100 text-emerald-700 border-emerald-200",
  awaiting_human: "bg-amber-100 text-amber-700 border-amber-200",
  human_active: "bg-blue-100 text-blue-700 border-blue-200",
  resolved: "bg-muted text-muted-foreground border-border",
};

type TabValue = "all" | ConversationStatus;

const TABS: { value: TabValue; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "awaiting_human", label: "Aguardando humano" },
  { value: "human_active", label: "Em atendimento" },
  { value: "resolved", label: "Resolvidas" },
];

// ── Message bubble ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ConversationMessage }) {
  const isBot = msg.role === "assistant";
  const isHuman = msg.role === "human";
  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
          isBot
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : isHuman
            ? "bg-emerald-600 text-white rounded-br-sm"
            : "bg-muted rounded-bl-sm"
        }`}
      >
        {isHuman && (
          <p className="text-[10px] font-semibold mb-0.5 text-emerald-100">Atendente</p>
        )}
        <p className="whitespace-pre-wrap">{msg.content}</p>
        <p
          className={`text-[10px] mt-1 ${
            isUser ? "text-muted-foreground" : "text-white/60"
          }`}
        >
          {new Date(msg.timestamp).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}

// ── Conversation detail panel ──────────────────────────────────────────────────

function ConversationDetail({
  conv,
  unitId,
  onUpdate,
}: {
  conv: Conversation;
  unitId: string;
  onUpdate: (updated: Conversation) => void;
}) {
  const [replyText, setReplyText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { assumeConversation, releaseToAI, markResolved } = useConversationActions(unitId);
  const sendMessage = useSendManualMessage(unitId);

  // Live conversation data (realtime via query invalidation from useConversations hook)
  const { data: liveConv } = useQuery({
    queryKey: ["conversation-detail", conv.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, customer:customers(*)")
        .eq("id", conv.id)
        .single();
      if (error) throw error;
      return data as Conversation;
    },
    initialData: conv,
    refetchOnWindowFocus: false,
  });

  // Realtime for the selected conversation's messages
  useEffect(() => {
    const channel = supabase
      .channel(`conversation-${conv.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${conv.id}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["conversation-detail", conv.id] });
          queryClient.invalidateQueries({ queryKey: ["conversations", unitId] });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [conv.id, unitId, queryClient]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveConv?.messages?.length]);

  const current = liveConv ?? conv;
  const isHumanMode = current.status === "human_active" || current.status === "awaiting_human";

  function handleAssume() {
    assumeConversation.mutate(current.id, {
      onSuccess: () => toast.success("Conversa assumida. A IA está silenciada."),
      onError: () => toast.error("Erro ao assumir conversa."),
    });
  }

  function handleRelease() {
    releaseToAI.mutate(current.id, {
      onSuccess: () => toast.success("Conversa devolvida à IA."),
      onError: () => toast.error("Erro ao devolver à IA."),
    });
  }

  function handleResolve() {
    markResolved.mutate(current.id, {
      onSuccess: () => toast.success("Conversa marcada como resolvida."),
      onError: () => toast.error("Erro ao resolver conversa."),
    });
  }

  function handleSend() {
    const msg = replyText.trim();
    if (!msg) return;
    sendMessage.mutate(
      { conversationId: current.id, message: msg },
      {
        onSuccess: () => {
          setReplyText("");
          toast.success("Mensagem enviada.");
        },
        onError: (e) => toast.error(`Erro: ${(e as Error).message}`),
      }
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <>
      {/* Header */}
      <CardHeader className="py-3 px-4 border-b">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base">{getConversationDisplayName(current)}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {formatPhone(current.customer?.phone || "")}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className={`text-xs ${STATUS_CLASSES[current.status ?? "ai_active"]}`}
            >
              {STATUS_LABEL[current.status ?? "ai_active"]}
            </Badge>

            {(current.status === "ai_active" || current.status === "awaiting_human") && (
              <Button size="sm" variant="outline" onClick={handleAssume} disabled={assumeConversation.isPending}>
                <UserCheck className="h-3.5 w-3.5 mr-1" />
                Assumir
              </Button>
            )}
            {current.status === "human_active" && (
              <>
                <Button size="sm" variant="outline" onClick={handleRelease} disabled={releaseToAI.isPending}>
                  <Bot className="h-3.5 w-3.5 mr-1" />
                  Devolver à IA
                </Button>
                <Button size="sm" variant="outline" onClick={handleResolve} disabled={markResolved.isPending}>
                  <CheckCircle className="h-3.5 w-3.5 mr-1" />
                  Resolver
                </Button>
              </>
            )}
            {current.status === "awaiting_human" && current.handoff_reason && (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 max-w-xs truncate">
                {current.handoff_reason}
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" ref={scrollRef as React.RefObject<HTMLDivElement>}>
        <div className="space-y-3">
          {(current.messages || []).map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}
        </div>
      </ScrollArea>

      {/* Reply box (only when human_active) */}
      {current.status === "human_active" && (
        <div className="border-t p-3 space-y-2">
          <Textarea
            rows={3}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Digite a mensagem e pressione Ctrl+Enter para enviar..."
            className="text-sm resize-none"
            disabled={sendMessage.isPending}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!replyText.trim() || sendMessage.isPending}
            >
              {sendMessage.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              Enviar
            </Button>
          </div>
        </div>
      )}

      {/* Notice when awaiting human */}
      {current.status === "awaiting_human" && (
        <div className="border-t p-3 bg-amber-50">
          <p className="text-xs text-amber-700 text-center">
            Aguardando atendente. Clique em <strong>Assumir</strong> para responder manualmente.
          </p>
        </div>
      )}
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Conversas() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [tab, setTab] = useState<TabValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: conversations, isLoading } = useConversations(unitId, tab === "all" ? "all" : tab);

  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  // Clear selection when it's no longer in the current tab
  useEffect(() => {
    if (selectedId && conversations && !conversations.find((c) => c.id === selectedId)) {
      setSelectedId(null);
    }
  }, [conversations, selectedId]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Conversas WhatsApp</h1>

      <Tabs value={tab} onValueChange={(v) => { setTab(v as TabValue); setSelectedId(null); }}>
        <TabsList className="mb-4">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="grid lg:grid-cols-[320px,1fr] gap-4 h-[calc(100vh-220px)]">
          {/* List */}
          <Card className="flex flex-col overflow-hidden">
            <CardHeader className="py-3 px-4 border-b">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {conversations?.length || 0} conversa{conversations?.length !== 1 ? "s" : ""}
              </CardTitle>
            </CardHeader>
            <ScrollArea className="flex-1">
              {isLoading ? (
                <div className="p-3 space-y-2">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : conversations?.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Nenhuma conversa nessa categoria.
                </div>
              ) : (
                conversations?.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full text-left px-4 py-3 border-b transition-colors hover:bg-muted/50 ${
                      selectedId === c.id ? "bg-muted" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm truncate">
                        {getConversationDisplayName(c)}
                      </p>
                      <Badge
                        variant="outline"
                        className={`text-[10px] shrink-0 ${STATUS_CLASSES[c.status ?? "ai_active"]}`}
                      >
                        {STATUS_LABEL[c.status ?? "ai_active"]}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatPhone(c.customer?.phone || "")}
                    </p>
                    {c.status === "awaiting_human" && c.handoff_reason && (
                      <p className="text-xs text-amber-700 truncate mt-0.5">{c.handoff_reason}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDateBR(c.last_message_at ?? c.updated_at)}
                    </p>
                  </button>
                ))
              )}
            </ScrollArea>
          </Card>

          {/* Detail */}
          <Card className="flex flex-col overflow-hidden">
            {!selected ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
                <MessageCircle className="h-10 w-10 opacity-30" />
                <p className="text-sm">Selecione uma conversa para visualizar</p>
              </div>
            ) : (
              <ConversationDetail
                key={selected.id}
                conv={selected}
                unitId={unitId}
                onUpdate={() => {}}
              />
            )}
          </Card>
        </div>
      </Tabs>
    </div>
  );
}
