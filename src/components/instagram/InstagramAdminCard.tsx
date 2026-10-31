import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  useInstagramAccount,
  useInstagramDiagnostics,
  useInstagramModule,
  useSetUnitModule,
} from "@/hooks/useInstagram";
import type { InstagramAccount, InstagramDiagnostics } from "@/features/instagram/types";

function formatDate(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("pt-BR") : "Não disponível";
}
function formatDateTime(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("pt-BR") : "Não disponível";
}

/** Nunca expõe a mensagem crua do Postgres/EF no toast. */
function grantErrorMessage(error: unknown, active: boolean) {
  const raw = error instanceof Error ? error.message : "";
  const code = (error as { code?: string } | null)?.code;
  const verb = active ? "liberar" : "revogar";
  if (code === "42501" || raw.includes("module_grant_forbidden")) {
    return `Não foi possível ${verb} o Instagram: você não tem permissão para esta unidade.`;
  }
  return `Não foi possível ${verb} o Instagram. Tente novamente.`;
}

function RetryLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <p role="alert">{text}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Tentar de novo</Button>
    </div>
  );
}

function AccountSection({ unitId }: { unitId: string }) {
  const query = useInstagramAccount(unitId);
  return (
    <section className="space-y-2" aria-label="Conta do Instagram">
      <h3 className="text-sm font-medium">Conta</h3>
      {query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">Carregando conta…</p>
      ) : query.isError ? (
        <RetryLine text="Não foi possível carregar a conta do Instagram." onRetry={() => query.refetch()} />
      ) : query.data ? (
        <AccountDetails account={query.data} />
      ) : (
        <p className="text-sm text-muted-foreground">Nenhuma conta do Instagram conectada.</p>
      )}
    </section>
  );
}

function AccountDetails({ account }: { account: InstagramAccount }) {
  const reauth = account.status === "reauth_required";
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{account.username ? `@${account.username}` : "Conta sem nome de usuário"}</span>
        {reauth ? (
          <Badge variant="destructive">Reconectar necessário</Badge>
        ) : account.status === "connected" ? (
          <Badge variant="secondary">Conectada</Badge>
        ) : (
          <Badge variant="outline">Desconectada</Badge>
        )}
      </div>
      {account.token_expires_at && <p>Token válido até {formatDate(account.token_expires_at)}</p>}
      <p className="text-muted-foreground">Conectada em {formatDate(account.connected_at)}</p>
      <p className="text-muted-foreground">Recebimento de eventos: {account.subscribed ? "ativo" : "inativo"}</p>
    </div>
  );
}

function DiagnosticsSection({ unitId }: { unitId: string }) {
  const query = useInstagramDiagnostics(unitId);
  return (
    <section className="space-y-2" aria-label="Diagnóstico do Instagram">
      <h3 className="text-sm font-medium">Diagnóstico</h3>
      {query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">Carregando diagnóstico…</p>
      ) : query.isError ? (
        <RetryLine text="Não foi possível carregar o diagnóstico do Instagram." onRetry={() => query.refetch()} />
      ) : query.data ? (
        <DiagnosticsDetails data={query.data} />
      ) : (
        <p className="text-sm text-muted-foreground">Sem dados de diagnóstico.</p>
      )}
    </section>
  );
}

// Só contagens e horários: nunca conteúdo de mensagem.
function DiagnosticsDetails({ data }: { data: InstagramDiagnostics }) {
  const outcomes = Object.entries(data.outcomes_24h ?? {});
  return (
    <div className="space-y-2 text-sm">
      <p>Último evento: {formatDateTime(data.last_event_at)}</p>
      <ul className="space-y-1">
        <li>Recebidas: {data.queue.received}</li>
        <li>Em processamento: {data.queue.processing}</li>
        <li>Concluídas em 24 h: {data.queue.done_24h}</li>
        <li>Com falha definitiva: {data.queue.dead}</li>
      </ul>
      {data.oldest_pending_received_at && (
        <p className="text-muted-foreground">Pendência mais antiga: {formatDateTime(data.oldest_pending_received_at)}</p>
      )}
      {outcomes.length > 0 && (
        <ul className="text-muted-foreground">
          {outcomes.map(([outcome, count]) => <li key={outcome}>Resultado {outcome} (24 h): {count}</li>)}
        </ul>
      )}
    </div>
  );
}

export function InstagramAdminCard({ unitId }: { unitId: string }) {
  const module = useInstagramModule(unitId);
  const setModule = useSetUnitModule(unitId);
  const active = module.data?.instagram.active === true;

  function toggle() {
    const next = !active;
    setModule.mutate(next, {
      onSuccess: () => toast.success(next ? "Instagram liberado para a unidade." : "Liberação do Instagram revogada."),
      onError: (error) => toast.error(grantErrorMessage(error, next)),
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle>Instagram Direct</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {module.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">Carregando liberação…</p>
        ) : module.isError ? (
          <RetryLine text="Não foi possível carregar a liberação do Instagram." onRetry={() => module.refetch()} />
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              {active
                ? `Módulo liberado em ${formatDate(module.data?.instagram.granted_at)}. A loja conecta a conta e ativa as conversas.`
                : "Módulo não liberado. A loja não vê o Instagram até a liberação."}
            </p>
            <Button variant={active ? "outline" : "default"} disabled={setModule.isPending} onClick={toggle}>
              {active ? "Revogar liberação" : "Liberar Instagram"}
            </Button>
          </div>
        )}
        {active && <AccountSection unitId={unitId} />}
        {active && <DiagnosticsSection unitId={unitId} />}
      </CardContent>
    </Card>
  );
}
