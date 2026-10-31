import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useConnectInstagramStart,
  useDisconnectInstagram,
  useInstagramAccount,
  useInstagramModule,
  useInstagramSettings,
  useResubscribeInstagram,
  useUpdateInstagramDm,
} from "@/hooks/useInstagram";
import { redirectToAuthorize, saveOauthState } from "@/features/instagram/oauth";
import type { InstagramAccount } from "@/features/instagram/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";

const DM_NOTICE =
  "Respostas enviadas pelo app do Instagram não pausam a IA. Para atender você mesmo, use Assumir em Conversas.";

function formatDate(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("pt-BR") : "Não disponível";
}

/** Mensagem do backend (PT-BR) quando existe; nunca texto técnico cru. */
function actionError(error: unknown, fallback: string) {
  const name = (error as { name?: string } | null)?.name;
  const message = error instanceof Error ? error.message : "";
  return name === "InstagramApiError" && message ? message : fallback;
}

function RetryLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <p role="alert">{text}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Tentar de novo</Button>
    </div>
  );
}

export default function Instagram() {
  const unit = useCurrentUnit();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  if (!unit || unit.unit_slug !== unitSlug) return <Skeleton className="h-32 w-full" />;
  // Operador não vê a tela nem chama `status` (a EF nega a ele).
  if (!unit.isGerente) return <Navigate to={`/g/${unit.unit_slug}/reservas`} replace />;
  return <InstagramUnit key={unit.unit_id} unitId={unit.unit_id} />;
}

function InstagramUnit({ unitId }: { unitId: string }) {
  const grant = useInstagramModule(unitId);
  return (
    <div className="min-w-0 space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Instagram</h1>
        <p className="mt-1 text-sm text-muted-foreground">Conecte a conta da loja e controle o atendimento por Direct.</p>
      </header>
      {grant.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : grant.isError ? (
        <RetryLine text="Não foi possível verificar a liberação do Instagram." onRetry={() => grant.refetch()} />
      ) : !grant.data?.instagram.active ? (
        <p className="text-sm text-muted-foreground">Módulo não liberado para esta unidade.</p>
      ) : (
        <Tabs defaultValue="conexao">
          <TabsList>
            <TabsTrigger value="conexao">Conexão</TabsTrigger>
            <TabsTrigger value="direct">Direct</TabsTrigger>
          </TabsList>
          <TabsContent value="conexao" className="mt-4"><ConnectionTab unitId={unitId} /></TabsContent>
          <TabsContent value="direct" className="mt-4"><DirectTab unitId={unitId} /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function ConnectionTab({ unitId }: { unitId: string }) {
  const query = useInstagramAccount(unitId);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Conta conectada</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">Carregando conta…</p>
        ) : query.isError ? (
          <RetryLine text="Não foi possível carregar a conta do Instagram." onRetry={() => query.refetch()} />
        ) : (
          <AccountPanel unitId={unitId} account={query.data ?? null} />
        )}
      </CardContent>
    </Card>
  );
}

function AccountPanel({ unitId, account }: { unitId: string; account: InstagramAccount | null }) {
  const start = useConnectInstagramStart(unitId);
  const disconnect = useDisconnectInstagram(unitId);
  const resubscribe = useResubscribeInstagram(unitId);
  const [confirming, setConfirming] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  const reauth = account?.status === "reauth_required";

  async function connect() {
    try {
      const { authorize_url, state } = await start.mutateAsync();
      // O state vai ao sessionStorage ANTES do redirecionamento.
      if (!saveOauthState(state)) {
        toast.error("Seu navegador bloqueou o armazenamento necessário para conectar. Libere-o e tente de novo.");
        return;
      }
      setRedirecting(true);
      if (!redirectToAuthorize(authorize_url)) {
        setRedirecting(false);
        toast.error("Não foi possível iniciar a conexão com o Instagram. Tente novamente.");
      }
    } catch (e) {
      toast.error(actionError(e, "Não foi possível iniciar a conexão com o Instagram. Tente novamente."));
    }
  }

  async function doResubscribe() {
    try {
      await resubscribe.mutateAsync();
      toast.success("Recebimento de eventos reativado.");
    } catch (e) {
      toast.error(actionError(e, "Não foi possível reativar o recebimento de eventos. Tente novamente."));
    }
  }

  async function doDisconnect() {
    try {
      await disconnect.mutateAsync();
      setConfirming(false);
      toast.success("Instagram desconectado.");
    } catch (e) {
      toast.error(actionError(e, "Não foi possível desconectar o Instagram. Tente novamente."));
    }
  }

  if (!account || account.status === "disconnected") {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">Nenhuma conta do Instagram conectada.</p>
        <Button onClick={connect} disabled={start.isPending || redirecting}>Conectar Instagram</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{account.username ? `@${account.username}` : "Conta sem nome de usuário"}</span>
          {reauth ? <Badge variant="destructive">Reconectar necessário</Badge> : <Badge variant="secondary">Conectada</Badge>}
        </div>
        {account.token_expires_at && <p>Acesso válido até {formatDate(account.token_expires_at)}</p>}
        {reauth && <p className="text-muted-foreground">O acesso expirou ou foi revogado. Reconecte para voltar a receber mensagens.</p>}
        {!account.subscribed && !reauth && (
          <p className="text-muted-foreground">O recebimento de mensagens está inativo.</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {reauth && <Button onClick={connect} disabled={start.isPending || redirecting}>Reconectar Instagram</Button>}
        {!account.subscribed && !reauth && (
          <Button variant="outline" onClick={doResubscribe} disabled={resubscribe.isPending}>Assinar de novo</Button>
        )}
        <Button variant="outline" onClick={() => setConfirming(true)}>Desconectar</Button>
      </div>
      <ResponsiveDialog open={confirming} onOpenChange={(open) => !disconnect.isPending && setConfirming(open)}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Desconectar o Instagram?</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              A loja deixa de receber e responder mensagens do Instagram até conectar de novo.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody />
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={disconnect.isPending}>Cancelar</Button>
            <Button variant="destructive" onClick={doDisconnect} disabled={disconnect.isPending}>Confirmar desconexão</Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}

function DirectTab({ unitId }: { unitId: string }) {
  const query = useInstagramSettings(unitId);
  const update = useUpdateInstagramDm(unitId);
  // Estado otimista: sobrepõe o valor do servidor enquanto a mutation corre.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const checked = optimistic ?? query.data?.dm_enabled === true;

  async function toggle(next: boolean) {
    setOptimistic(next);
    try {
      await update.mutateAsync(next);
      await query.refetch();
    } catch (e) {
      toast.error(actionError(e, "Não foi possível salvar a configuração do Direct. Tente novamente."));
    } finally {
      // Falha: volta ao valor do servidor. Sucesso: o refetch já trouxe o novo.
      setOptimistic(null);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Atendimento por Direct</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">Carregando configuração…</p>
        ) : query.isError ? (
          <RetryLine text="Não foi possível carregar a configuração do Direct." onRetry={() => query.refetch()} />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="instagram-dm-enabled" className="text-sm font-medium">Responder mensagens do Direct</label>
              <Switch id="instagram-dm-enabled" checked={checked} onCheckedChange={toggle} disabled={update.isPending} />
            </div>
            <p className="text-sm text-muted-foreground">{DM_NOTICE}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
