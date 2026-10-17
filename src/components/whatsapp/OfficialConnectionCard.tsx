import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOfficialConnection } from "@/hooks/useOfficialConnection";
import { useWhatsappConnection } from "@/hooks/useWhatsappConnection";
import { officialConnectionErrorMessage } from "@/features/whatsapp/official-connection-api";
import { classifyConnectMessage } from "../../../supabase/functions/_shared/datafy-onboarding-core";
import { OFFICIAL_ITEM_COPY } from "@/features/whatsapp/official-checklist-copy";

// Keyed session isolates warnings, locks and late responses when the unit changes.
export function OfficialConnectionCard({ unitId }: { unitId: string }) {
  return <OfficialConnectionSession key={unitId} unitId={unitId} />;
}

function OfficialConnectionHealth({ unitId }: { unitId: string }) {
  const health = useWhatsappConnection(unitId);
  if (health.isLoading || health.isFetching) return <p role="status">Consultando saúde atual do WhatsApp…</p>;
  if (health.isError || !health.data?.channel_id || health.data.status === "not_configured") return <div className="space-y-2">
    <p role="alert">Saúde atual do WhatsApp indisponível.</p>
    <Button className="min-h-11" variant="outline" onClick={() => void health.refetch()}>Consultar saúde novamente</Button>
  </div>;
  if (health.data.status === "connected") return <p role="status" className="font-medium text-success">WhatsApp conectado.</p>;
  if (health.data.status === "disconnected") return <p role="alert">WhatsApp desconectado.</p>;
  if (health.data.status === "provider_error" || health.data.status === "error") return <p role="alert">Não foi possível verificar a conexão com o provedor.</p>;
  if (health.data.status === "suspended") return <p role="alert">Conexão do WhatsApp suspensa.</p>;
  return <p role="status">Conexão do WhatsApp em andamento.</p>;
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
  const beforeConnect = state.step === "ready_to_connect" || state.step === "connecting";
  return <Card>
    <CardHeader><CardTitle>WhatsApp oficial</CardTitle></CardHeader>
    <CardContent className="space-y-5">
      {state.step === "not_granted" ? <p>Esta conexão precisa de liberação. Fale com o suporte.</p> : <>
        <p className="text-sm text-muted-foreground">Antes de conectar, mantenha o número no app WhatsApp Business no celular e tenha acesso de administrador à sua conta empresarial Meta.</p>
        <ul className="space-y-2 text-sm" aria-label="Progresso da conexão">
          {state.items.map((item) => <li key={item.id}><span className={item.done ? "text-success" : "text-muted-foreground"}>{item.done ? "Concluído" : "Pendente"}: {OFFICIAL_ITEM_COPY[item.id]}</span></li>)}
        </ul>
        {state.step === "active" ? <>
          <p className="font-medium">Ativação concluída.</p>
          <OfficialConnectionHealth unitId={unitId} />
        </> : state.step === "awaiting_cutover" ? (
          // Corte é do suporte (`begin_switch`): a loja não tem ação aqui.
          <p role="status" className="font-medium">Canal oficial pronto. A troca será feita pelo suporte.</p>
        ) : <>
          {state.migration && beforeConnect && <p role="note" className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm">Ao conectar, o WhatsApp desconecta os aparelhos vinculados, inclusive a automação atual. Logo depois, gere um novo QR Code em Conexão atual e escaneie para a automação voltar. Faça num horário de pouco movimento.</p>}
          {(state.step === "awaiting_echo" || state.step === "subscription_pending") && <p>Envie uma mensagem pelo app WhatsApp Business no celular para qualquer contato</p>}
          <div className="flex flex-col gap-2 sm:flex-row">
            {beforeConnect && <Button className="min-h-11" disabled={pending} onClick={() => void start()}>Conectar WhatsApp oficial</Button>}
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
