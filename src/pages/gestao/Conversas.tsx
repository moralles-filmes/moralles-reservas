import { useState, useRef, useEffect, useMemo, Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useConversations, useConversationActions } from "@/hooks/useConversations";
import { useSendManualMessage } from "@/hooks/useSendManualMessage";
import { useDebounce } from "@/hooks/useDebounce";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cn,
  formatDateBR,
  formatMessageTime,
  formatPhone,
  getConversationDisplayName,
  getMessageDayKey,
  humanDateLabel,
  sanitizeSearchTerm,
} from "@/lib/utils";
import { toast } from "sonner";
import { ArrowLeft, MessageCircle, UserCheck, Bot, CheckCircle, Send, Loader2, Search } from "lucide-react";
import type {
  Conversation,
  ConversationMessage,
  ConversationStatus,
  OutboundMessageKind,
} from "@/types/reserva";

const OUTBOUND_KIND_LABEL: Record<OutboundMessageKind, string> = {
  confirmation: "Confirmação",
  reminder_d1: "Lembrete",
  survey_d1: "Pesquisa",
  cancellation: "Cancelamento",
  voucher_issued: "Voucher",
  waitlist_entered: "Fila — entrada",
  waitlist_table_ready: "Fila — mesa pronta",
  waitlist_feedback: "Fila — feedback",
};

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

type FilterValue = "all" | ConversationStatus;

const FILTER_CHIPS: { value: FilterValue; label: string; activeClasses: string; countStatus?: ConversationStatus }[] = [
  { value: "all", label: "Todas", activeClasses: "bg-foreground text-background border-foreground" },
  { value: "awaiting_human", label: "Aguardando", activeClasses: "bg-amber-100 text-amber-700 border-amber-300", countStatus: "awaiting_human" },
  { value: "human_active", label: "Em atendimento", activeClasses: "bg-blue-100 text-blue-700 border-blue-300", countStatus: "human_active" },
  { value: "ai_active", label: "IA ativa", activeClasses: "bg-emerald-100 text-emerald-700 border-emerald-300", countStatus: "ai_active" },
];

// ── Message bubble ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ConversationMessage }) {
  const isBot = msg.role === "assistant";
  const isHuman = msg.role === "human";
  const isUser = msg.role === "user";
  const kindLabel = msg.kind ? (OUTBOUND_KIND_LABEL[msg.kind] ?? msg.kind) : undefined;

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
        {isBot && kindLabel && (
          <p className="text-[10px] font-semibold uppercase tracking-wide opacity-80 mb-0.5">
            {kindLabel}
          </p>
        )}
        <p className="whitespace-pre-wrap">{msg.content}</p>
        <p
          className={`text-[10px] mt-1 ${
            isUser ? "text-muted-foreground" : "text-white/60"
          }`}
        >
          {formatMessageTime(msg.timestamp)}
        </p>
      </div>
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex justify-center my-3">
      <span className="text-[11px] bg-muted text-muted-foreground px-3 py-1 rounded-full">
        {label}
      </span>
    </div>
  );
}

// ── Conversation detail panel ──────────────────────────────────────────────────

function ConversationDetail({
  conv,
  unitId,
  onUpdate,
  onBack,
}: {
  conv: Conversation;
  unitId: string;
  onUpdate: (updated: Conversation) => void;
  onBack: () => void;
}) {
  const [replyText, setReplyText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { assumeConversation, releaseToAI, markResolved } = useConversationActions(unitId);
  const sendMessage = useSendManualMessage(unitId);

  // Live conversation data (realtime via query invalidation from useConversations hook).
  // `placeholderData` (não `initialData`): o `conv` vem da LISTA, que omite a coluna
  // `messages` (payload). placeholderData mostra nome/status na hora mas NÃO conta como
  // dado fresco — a queryFn sempre roda no mount e traz `messages`. Com `initialData` +
  // staleTime global de 30s o detalhe nunca buscava e o thread ficava em branco.
  const { data: liveConv, isError, refetch, isPlaceholderData } = useQuery({
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
    placeholderData: conv,
    staleTime: 0,
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

  // Scroll to bottom when messages change.
  // Radix ScrollArea: o nó scrollável real é o viewport interno; setar scrollTop
  // no wrapper raiz (que o ref recebe) não tem efeito. Buscar o viewport via
  // querySelector com o atributo data-radix-scroll-area-viewport.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const viewport =
      root.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]");
    const target = viewport ?? root;
    target.scrollTop = target.scrollHeight;
  }, [liveConv?.messages?.length, conv.id]);

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
      onSuccess: () => toast.success("Atendimento concluído. IA reativada."),
      onError: () => toast.error("Erro ao resolver conversa."),
    });
  }

  function handleSend() {
    if (sendMessage.isPending) return;
    const msg = replyText.trim();
    if (!msg) return;
    if (msg.length > 4096) {
      toast.error("Mensagem excede 4096 caracteres (limite do WhatsApp).");
      return;
    }
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
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="lg:hidden -ml-2"
              aria-label="Voltar para a lista"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <CardTitle className="text-base">{getConversationDisplayName(current)}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {formatPhone(current.customer?.phone || "")}
              </p>
            </div>
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

      {/* Messages — precedência: erro → carregando → vazio → lista */}
      {isError ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3 p-4">
          <MessageCircle className="h-10 w-10 opacity-30" />
          <p className="text-sm">Não foi possível carregar as mensagens.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : isPlaceholderData && !(current.messages?.length) ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-4">
          <Loader2 className="h-6 w-6 animate-spin opacity-50" />
          <p className="text-sm">Carregando mensagens...</p>
        </div>
      ) : !(current.messages?.length) ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3 p-4">
          <MessageCircle className="h-10 w-10 opacity-30" />
          <p className="text-sm">Nenhuma mensagem ainda.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1 p-4" ref={scrollRef as React.RefObject<HTMLDivElement>}>
          <div className="space-y-3">
            {current.messages.map((msg, i, arr) => {
              const prev = i > 0 ? arr[i - 1] : null;
              const showDivider =
                !prev || getMessageDayKey(msg.timestamp) !== getMessageDayKey(prev.timestamp);
              return (
                <Fragment key={i}>
                  {showDivider && <DateDivider label={humanDateLabel(msg.timestamp)} />}
                  <MessageBubble msg={msg} />
                </Fragment>
              );
            })}
          </div>
        </ScrollArea>
      )}

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
            maxLength={4096}
          />
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-[11px] ${
                replyText.length >= 4096 ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {replyText.length} / 4096
            </span>
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

  const [activeFilter, setActiveFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim(), 200);

  const { data: allConversations, isLoading, isError, refetch } = useConversations(unitId, "all");

  const statusCounts = useMemo(() => {
    if (!allConversations) return {} as Record<ConversationStatus, number>;
    const counts: Record<string, number> = {};
    for (const c of allConversations) {
      const s = c.status ?? "ai_active";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts as Record<ConversationStatus, number>;
  }, [allConversations]);

  const conversations = useMemo(() => {
    if (!allConversations) return [] as Conversation[];
    if (activeFilter === "all") return allConversations;
    return allConversations.filter((c) => c.status === activeFilter);
  }, [allConversations, activeFilter]);

  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  const filteredConversations = useMemo(() => {
    if (!conversations) return [] as Conversation[];
    const term = sanitizeSearchTerm(debouncedSearch).toLowerCase();
    if (!term) return conversations;
    const digits = debouncedSearch.replace(/\D/g, "");
    return conversations.filter((c) => {
      const name = getConversationDisplayName(c).toLowerCase();
      if (name.includes(term)) return true;
      const contactName = c.contact_name?.toLowerCase() ?? "";
      if (contactName.includes(term)) return true;
      if (digits.length >= 3) {
        const phone = c.customer?.phone ?? "";
        if (phone.includes(digits)) return true;
      }
      return false;
    });
  }, [conversations, debouncedSearch]);

  const hasActiveSearch = debouncedSearch.trim().length > 0;
  const totalCount = conversations?.length ?? 0;
  const filteredCount = filteredConversations.length;

  // Clear selection when it's no longer in the current tab
  useEffect(() => {
    if (selectedId && conversations && !conversations.find((c) => c.id === selectedId)) {
      setSelectedId(null);
    }
  }, [conversations, selectedId]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Conversas WhatsApp</h1>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por nome ou telefone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {FILTER_CHIPS.map((chip) => {
          const isActive = activeFilter === chip.value;
          const count = chip.countStatus ? (statusCounts[chip.countStatus] ?? 0) : null;
          return (
            <button
              key={chip.value}
              onClick={() => {
                setActiveFilter(isActive && chip.value !== "all" ? "all" : chip.value);
                setSelectedId(null);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors",
                isActive
                  ? chip.activeClasses
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              )}
            >
              {chip.label}
              {count !== null && count > 0 && (
                <span className={cn(
                  "inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1 text-[10px] font-semibold",
                  isActive ? "bg-white/30" : "bg-muted"
                )}>
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="grid lg:grid-cols-[320px,1fr] gap-4 h-[calc(100dvh-180px)] min-h-[480px] lg:h-[calc(100vh-220px)]">
        {/* List */}
        <Card className={cn("flex flex-col overflow-hidden", selectedId && "hidden lg:flex")}>
          <CardHeader className="py-3 px-4 border-b">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {hasActiveSearch && filteredCount !== totalCount
                ? `${filteredCount} de ${totalCount} conversa${totalCount !== 1 ? "s" : ""}`
                : `${totalCount} conversa${totalCount !== 1 ? "s" : ""}`}
            </CardTitle>
          </CardHeader>
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="p-3 space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : isError ? (
              <div className="p-6 text-center space-y-3">
                <p className="text-sm text-destructive">Erro ao carregar conversas.</p>
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Tentar de novo
                </Button>
              </div>
            ) : filteredCount === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {hasActiveSearch
                  ? "Nenhuma conversa corresponde a essa busca."
                  : "Nenhuma conversa nessa categoria."}
              </div>
            ) : (
              filteredConversations.map((c) => (
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
        <Card className={cn("flex flex-col overflow-hidden", !selectedId && "hidden lg:flex")}>
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
              onBack={() => setSelectedId(null)}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
