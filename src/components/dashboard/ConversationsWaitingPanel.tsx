import { Link } from "react-router-dom";
import { formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useConversations } from "@/hooks/useConversations";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getConversationDisplayName } from "@/lib/utils";

export function ConversationsWaitingPanel({ unitId, unitSlug }: { unitId: string; unitSlug: string }) {
  const { data, isLoading, isError, refetch } = useConversations(unitId, "awaiting_human");
  return (
    <section className="surface rounded-card p-5 space-y-4">
      <h3 className="font-semibold">Conversas aguardando <span className="tabular text-muted-foreground">{data?.length ?? "—"}</span></h3>
      {isLoading ? (
        <div data-testid="conversations-skeleton" className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : isError ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Não foi possível carregar as conversas</p>
          <Button variant="outline" onClick={() => refetch()}>Tentar de novo</Button>
        </div>
      ) : !data?.length ? (
        <p className="text-sm text-muted-foreground">Nenhuma conversa aguardando resposta</p>
      ) : (
        <ul className="space-y-3">
          {data.slice(0, 4).map((conversation) => (
            <li key={conversation.id} className="space-y-1">
              <p className="truncate font-medium">{getConversationDisplayName(conversation)}</p>
              <p className="text-xs text-muted-foreground">Aguardando atendente</p>
              {conversation.last_message_at && Number.isFinite(new Date(conversation.last_message_at).getTime()) && (
                <p className="text-xs text-tertiary">há {formatDistanceToNowStrict(new Date(conversation.last_message_at), { locale: ptBR })}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link className="inline-flex min-h-11 items-center text-sm text-primary hover:underline" to={`/g/${unitSlug}/conversas`}>Abrir conversas</Link>
    </section>
  );
}
