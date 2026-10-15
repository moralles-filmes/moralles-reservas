import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOfficialConnection } from "@/hooks/useOfficialConnection";
import { officialConnectionErrorMessage } from "@/features/whatsapp/official-connection-api";
import { classifyConnectMessage, type OfficialChecklistItemId } from "../../../supabase/functions/_shared/datafy-onboarding-core";

const ITEM_COPY: Record<OfficialChecklistItemId, string> = {
  granted: "Conexão liberada",
  channel_created: "Canal preparado",
  webhook_ready: "Recebimento de mensagens configurado",
  number_connected: "Número conectado",
  subscribed: "Assinatura confirmada",
  echo_verified: "Mensagem do app verificada",
  active: "Canal ativado",
};

// Keyed session isolates warnings, locks and late responses when the unit changes.
export function OfficialConnectionCard({ unitId }: { unitId: string }) {
  return <OfficialConnectionSession key={unitId} unitId={unitId} />;
}

function OfficialConnectionSession({ unitId }: { unitId: string }) {
  const connection = useOfficialConnection(unitId);
  const confirmConnection = connection.confirm;
  const busy = useRef(false);
  const alive = useRef(false);
  const popupRef = useRef<Window | null>(null);
  const [pending, setPending] = useState(false);
  const [withoutApp, setWithoutApp] = useState(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Close before the next unit can reuse the named window.
      popupRef.current?.close();
      popupRef.current = null;
    };
  }, []);

  const allowed = !!connection.data && connection.data.step !== "not_granted";
  const confirm = useCallback(async () => {
    if (!allowed || busy.current || !alive.current) return;
    busy.current = true;
    setPending(true);
    try { await confirmConnection(); }
    catch (error) { if (alive.current) toast.error(officialConnectionErrorMessage(error, "Não foi possível confirmar a conexão. Tente novamente.")); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  }, [allowed, confirmConnection]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      switch (classifyConnectMessage(event)) {
        case "connected": void confirm(); break;
        case "connected_without_app": setWithoutApp(true); break;
        case "error": toast.error("A conexão não foi concluída. Tente de novo na janela da Datafy."); break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [confirm]);

  const start = async () => {
    if (!allowed || busy.current) return;
    const popup = window.open("about:blank", "datafy-conexao", "width=600,height=760");
    if (!popup) { toast.error("Permita abrir a janela de conexão no navegador e tente novamente."); return; }
    popupRef.current = popup;
    busy.current = true;
    setPending(true);
    try {
      const next = await connection.start(popup, () => alive.current);
      if (next === "confirm" && alive.current) {
        popup.close();
        await confirmConnection();
      }
    } catch (error) {
      popup.close();
      if (alive.current) toast.error(officialConnectionErrorMessage(error, "Não foi possível iniciar a conexão. Tente novamente."));
    } finally { busy.current = false; if (alive.current) setPending(false); }
  };

  if (connection.isLoading) return <Skeleton aria-label="Carregando conexão oficial" className="h-80 w-full" />;
  if (connection.isError) return <Card><CardContent className="space-y-4 py-6">
    <p role="alert">Não foi possível consultar a conexão oficial.</p>
    <Button className="min-h-11" variant="outline" onClick={() => connection.refetch()}>Tentar novamente</Button>
  </CardContent></Card>;
  if (!connection.data) return <Card><CardContent className="py-6">Nenhuma conexão oficial disponível.</CardContent></Card>;
  const state = connection.data;
  return <Card>
    <CardHeader><CardTitle>WhatsApp oficial</CardTitle></CardHeader>
    <CardContent className="space-y-5">
      {state.step === "not_granted" ? <p>Esta conexão precisa de liberação. Fale com o suporte.</p> : <>
        <p className="text-sm text-muted-foreground">Antes de conectar, mantenha o número no app WhatsApp Business no celular e tenha acesso de administrador à sua conta empresarial Meta.</p>
        <ul className="space-y-2 text-sm" aria-label="Progresso da conexão">
          {state.items.map((item) => <li key={item.id}><span className={item.done ? "text-success" : "text-muted-foreground"}>{item.done ? "Concluído" : "Pendente"}: {ITEM_COPY[item.id]}</span></li>)}
        </ul>
        {state.step === "active" ? <p className="font-medium text-success">Conexão oficial ativada.</p> : <>
          {(state.step === "awaiting_echo" || state.step === "subscription_pending") && <p>Envie uma mensagem pelo app WhatsApp Business no celular para qualquer contato</p>}
          <div className="flex flex-col gap-2 sm:flex-row">
            {(state.step === "ready_to_connect" || state.step === "connecting") && <Button className="min-h-11" disabled={pending} onClick={() => void start()}>Conectar WhatsApp oficial</Button>}
            <Button className="min-h-11" variant="outline" disabled={pending} onClick={() => void confirm()}>Já concluí a conexão</Button>
          </div>
        </>}
      </>}
      {withoutApp && <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">Este número foi conectado sem o app WhatsApp Business. O sistema só funciona com o número no app (Coexistence): sem ele, o canal não entra no ar. Fale com o suporte antes de continuar.</p>}
      <div className="space-y-2 rounded-lg border p-4 text-sm">
        <p className="font-medium">Cadastre o cartão na sua conta Meta</p>
        <ol className="list-decimal space-y-1 pl-5"><li>Abra as Configurações do negócio na Meta.</li><li>Acesse Contas → Contas do WhatsApp e selecione sua conta.</li><li>Em Configurações de pagamento, adicione uma forma de pagamento.</li></ol>
        {state.templatesPending && <p>Os templates de mensagens ainda estão em preparação. Aguarde a liberação antes de usar as automações com templates.</p>}
        <p>Abra o app WhatsApp Business ao menos a cada 14 dias</p>
      </div>
    </CardContent>
  </Card>;
}
