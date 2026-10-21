import { useState } from "react";
import { Bot, History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useActivateAiPromptVersion,
  useAiPromptSlot,
  useAiPromptVersionList,
  usePublishAiPromptVersion,
  type AiPromptVersion,
} from "@/hooks/useAiPromptVersions";
import { useAuth } from "@/hooks/useAuth";
import { promptErrorMessage } from "@/lib/ai-prompt-errors";
import { diffLines } from "@/lib/text-line-diff";
import { normalizeNewlines } from "@/lib/text-normalize";
import { cn } from "@/lib/utils";
import {
  GLOBAL_PROMPT_MAX_CHARS,
  GLOBAL_PROMPT_NOTE_MAX_CHARS,
  GLOBAL_PROMPT_PLACEHOLDERS,
  charLength,
  isValidGlobalPromptBody,
  isValidGlobalPromptNote,
  renderGlobalLayer,
} from "../../../supabase/functions/_shared/agent/global-prompt-core";

const PREVIEW_NAMES = { agentName: "Yumi", restaurantName: "Restaurante Exemplo" };
const PLACEHOLDER_TOKENS = GLOBAL_PROMPT_PLACEHOLDERS.map((p) => `{{${p}}}`);

const formatDateTime = (iso: string) => new Date(iso).toLocaleString("pt-BR");

/** Autor de uma versão: "Você", o sistema (seed, sem autor) ou o início do uuid do admin. */
function authorLabel(createdBy: string | null, userId: string | undefined): string {
  if (createdBy === null) return "Sistema (versão inicial)";
  if (createdBy === userId) return "Você";
  return `Admin ${createdBy.slice(0, 8)}`;
}

/** Mensagem curta do que impede publicar; `null` quando o texto é válido. */
function bodyProblem(normalized: string): string | null {
  if (isValidGlobalPromptBody(normalized)) return null;
  if (!/\S/.test(normalized)) return "Escreva o texto do prompt.";
  if (charLength(normalized) > GLOBAL_PROMPT_MAX_CHARS) return `Passou de ${GLOBAL_PROMPT_MAX_CHARS} caracteres.`;
  return `Use só ${PLACEHOLDER_TOKENS.join(" e ")}, sem <<< ou >>> e sem caracteres de controle.`;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  if (lines.every((l) => l.kind === "same")) {
    return <p className="text-sm text-muted-foreground">Sem diferenças em relação à versão ativa.</p>;
  }
  return (
    <div className="rounded-md border bg-muted/30 font-mono text-xs overflow-x-auto" data-testid="prompt-diff">
      {lines.map((line, i) => (
        <div
          key={i}
          data-kind={line.kind}
          className={cn(
            "whitespace-pre-wrap break-words px-3 py-0.5",
            line.kind === "add" && "bg-success/10 text-success",
            line.kind === "remove" && "bg-destructive/10 text-destructive",
            line.kind === "same" && "text-muted-foreground",
          )}
        >
          {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
          {line.text}
        </div>
      ))}
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  before: string;
  after: string;
  pending: boolean;
  onConfirm: (note: string) => void;
}

/** Confirmação com motivo obrigatório e o diff contra a versão ativa. O motivo zera a cada abertura. */
function ConfirmDialog({ open, onOpenChange, ...rest }: ConfirmDialogProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ConfirmForm {...rest} onCancel={() => onOpenChange(false)} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ConfirmForm({
  title,
  description,
  confirmLabel,
  before,
  after,
  pending,
  onConfirm,
  onCancel,
}: Omit<ConfirmDialogProps, "open" | "onOpenChange"> & { onCancel: () => void }) {
  const [note, setNote] = useState("");
  const noteOk = isValidGlobalPromptNote(note);
  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>{description}</ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="prompt-note">Motivo</Label>
          <Textarea
            id="prompt-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Por que esta mudança?"
            disabled={pending}
          />
          <p className={cn("text-xs", charLength(note) > GLOBAL_PROMPT_NOTE_MAX_CHARS ? "text-destructive" : "text-muted-foreground")}>
            {charLength(note)}/{GLOBAL_PROMPT_NOTE_MAX_CHARS}
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Mudanças em relação à versão ativa</p>
          <DiffView before={before} after={after} />
        </div>
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter className="justify-end">
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button onClick={() => onConfirm(note)} disabled={!noteOk || pending}>
          {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {confirmLabel}
        </Button>
      </ResponsiveDialogFooter>
    </>
  );
}

function ActiveVersionCard({
  active,
  activatedAt,
  userId,
}: {
  active: AiPromptVersion;
  activatedAt: string;
  userId: string | undefined;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Versão ativa</CardTitle>
          <Badge variant="success">v{active.version}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>
          <span className="text-muted-foreground">Autor: </span>
          {authorLabel(active.created_by, userId)}
        </p>
        <p>
          <span className="text-muted-foreground">Criada em: </span>
          {formatDateTime(active.created_at)}
        </p>
        <p>
          <span className="text-muted-foreground">Ativada em: </span>
          {formatDateTime(activatedAt)}
        </p>
        <p>
          <span className="text-muted-foreground">Motivo: </span>
          {active.note}
        </p>
      </CardContent>
    </Card>
  );
}

type HistoryDialog = { kind: "diff" | "restore"; version: AiPromptVersion };

function HistoryCard({
  active,
  userId,
  onRestore,
}: {
  active: AiPromptVersion;
  userId: string | undefined;
  onRestore: (version: AiPromptVersion) => void;
}) {
  const list = useAiPromptVersionList();
  const [diffOf, setDiffOf] = useState<AiPromptVersion | null>(null);
  const versions = list.data?.pages.flat() ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Histórico</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {!list.isLoading && list.isError && (
          <div className="py-4 text-center space-y-3">
            <p className="text-sm text-destructive">Não foi possível carregar o histórico.</p>
            <Button variant="outline" size="sm" onClick={() => list.refetch()}>
              Tentar novamente
            </Button>
          </div>
        )}

        {!list.isLoading && !list.isError && versions.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">Nenhuma versão publicada ainda.</p>
        )}

        {!list.isLoading && !list.isError && versions.length > 0 && (
          <>
            <ul className="divide-y rounded-md border">
              {versions.map((v) => {
                const isActive = v.id === active.id;
                return (
                  <li key={v.id} className="p-3 space-y-2" data-testid={`version-${v.version}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">v{v.version}</span>
                      {isActive && <Badge variant="success">Ativa</Badge>}
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(v.created_at)} · {authorLabel(v.created_by, userId)}
                      </span>
                    </div>
                    <p className="text-sm break-words">{v.note}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => setDiffOf(v)}>
                        Ver diff
                      </Button>
                      {!isActive && (
                        <Button variant="outline" size="sm" onClick={() => onRestore(v)}>
                          Restaurar esta versão
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {list.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
              </Button>
            )}
          </>
        )}
      </CardContent>

      <ResponsiveDialog open={diffOf !== null} onOpenChange={(open) => !open && setDiffOf(null)}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Versão {diffOf?.version} contra a ativa</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Linhas com + entram e com - saem se esta versão for restaurada.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            {diffOf && <DiffView before={active.body} after={diffOf.body} />}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="justify-end">
            <Button variant="outline" onClick={() => setDiffOf(null)}>
              Fechar
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </Card>
  );
}

export default function PlatformAgenteIa() {
  const { user } = useAuth();
  const slot = useAiPromptSlot();
  const publish = usePublishAiPromptVersion();
  const activate = useActivateAiPromptVersion();
  // O que sai para a RPC e para a validação é sempre `normalized` (só \n), qualquer que seja a origem do texto.
  // `null` = sem edição: o editor mostra o corpo ativo, inclusive o novo depois de publicar.
  const [draft, setDraft] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"publish" | HistoryDialog | null>(null);

  const state = slot.data;
  const text = draft ?? state?.active.body ?? "";
  const normalized = normalizeNewlines(text);
  const problem = bodyProblem(normalized);
  const unchanged = state ? normalized === normalizeNewlines(state.active.body) : true;
  const length = charLength(normalized);

  const fail = (error: unknown) => {
    toast.error(promptErrorMessage(error));
    // 40001: a ativa mudou e a tela já recarregou; o admin revisa o diff de novo.
    if ((error as { code?: unknown } | null)?.code === "40001") setDialog(null);
  };

  const handlePublish = (note: string) => {
    if (!state) return;
    publish.mutate(
      { body: normalized, note, expectedActiveVersionId: state.activeVersionId },
      {
        onSuccess: () => {
          toast.success("Nova versão publicada. Vale para todas as lojas em até 1 minuto.");
          setDraft(null);
          setDialog(null);
        },
        onError: fail,
      },
    );
  };

  const handleRestore = (version: AiPromptVersion, note: string) => {
    if (!state) return;
    activate.mutate(
      { versionId: version.id, expectedActiveVersionId: state.activeVersionId, note },
      {
        onSuccess: () => {
          toast.success(`Versão ${version.version} restaurada. Vale para todas as lojas em até 1 minuto.`);
          setDraft(null);
          setDialog(null);
        },
        onError: fail,
      },
    );
  };

  const restoring = dialog !== null && dialog !== "publish" && dialog.kind === "restore" ? dialog.version : null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Agente de IA — prompt global</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          A mudança vale para todas as lojas em até 1 minuto. Esta camada define só a persona e o tom do
          agente; as regras de atendimento e de segurança ficam no sistema e não mudam por aqui.
        </p>
      </div>

      {slot.isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {!slot.isLoading && slot.isError && (
        <Card>
          <CardContent className="py-8 text-center space-y-3">
            <p className="text-sm text-destructive">Não foi possível carregar o prompt global.</p>
            <Button variant="outline" size="sm" onClick={() => slot.refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {!slot.isLoading && !slot.isError && !state && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            O prompt global ainda não foi inicializado neste banco. Aplique as migrations pendentes e recarregue.
          </CardContent>
        </Card>
      )}

      {!slot.isLoading && !slot.isError && state && (
        <>
          <ActiveVersionCard active={state.active} activatedAt={state.activatedAt} userId={user?.id} />

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Editor</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label htmlFor="prompt-body">Texto do prompt global</Label>
              <Textarea
                id="prompt-body"
                rows={14}
                className="font-mono text-xs"
                value={text}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <p className="text-muted-foreground">
                  Variáveis aceitas: {PLACEHOLDER_TOKENS.map((t) => (
                    <code key={t} className="mx-0.5 rounded bg-muted px-1">{t}</code>
                  ))}
                </p>
                <p
                  className={cn(length > GLOBAL_PROMPT_MAX_CHARS ? "text-destructive" : "text-muted-foreground")}
                  data-testid="prompt-counter"
                >
                  {length}/{GLOBAL_PROMPT_MAX_CHARS}
                </p>
              </div>
              {problem && (
                <p className="text-sm text-destructive" role="alert">
                  {problem}
                </p>
              )}
              <div className="flex justify-end">
                <Button onClick={() => setDialog("publish")} disabled={problem !== null || unchanged}>
                  Publicar
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pré-visualização</CardTitle>
              <p className="text-sm text-muted-foreground">
                Como o texto fica para o agente "{PREVIEW_NAMES.agentName}" do "{PREVIEW_NAMES.restaurantName}".
              </p>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs" data-testid="prompt-preview">
                {renderGlobalLayer(normalized, PREVIEW_NAMES)}
              </pre>
            </CardContent>
          </Card>

          <HistoryCard
            active={state.active}
            userId={user?.id}
            onRestore={(version) => setDialog({ kind: "restore", version })}
          />

          <ConfirmDialog
            open={dialog === "publish"}
            onOpenChange={(open) => !open && setDialog(null)}
            title="Publicar nova versão"
            description="O texto passa a valer para todas as lojas em até 1 minuto. Explique o motivo da mudança."
            confirmLabel="Publicar"
            before={state.active.body}
            after={normalized}
            pending={publish.isPending}
            onConfirm={handlePublish}
          />

          <ConfirmDialog
            open={restoring !== null}
            onOpenChange={(open) => !open && setDialog(null)}
            title={`Restaurar versão ${restoring?.version ?? ""}`}
            description="Esta versão volta a ser a ativa para todas as lojas em até 1 minuto. Explique o motivo."
            confirmLabel="Restaurar"
            before={state.active.body}
            after={restoring?.body ?? ""}
            pending={activate.isPending}
            onConfirm={(note) => restoring && handleRestore(restoring, note)}
          />
        </>
      )}
    </div>
  );
}
