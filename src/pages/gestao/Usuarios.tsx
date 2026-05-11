import { useMemo, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAuth } from "@/hooks/useAuth";
import {
  useCreateUnitMember,
  useDeleteUnitMember,
  useUnitMembers,
  useUpdateMemberName,
  useUpdateMemberRole,
  type UnitMemberRow,
} from "@/hooks/useUnitMembers";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MoreHorizontal, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import type { UnitRole } from "@/types/reserva";

type Tab = "gerentes" | "operadores";

const ROLE_LABELS: Record<UnitRole, string> = {
  owner: "Proprietário",
  gerente: "Gerente",
  operador: "Operador",
};

/** Deriva nome a partir do e-mail quando o membro não tem `name` salvo. */
function deriveDisplayName(email: string | null, name: string | null): string {
  if (name && name.trim()) return name.trim();
  if (!email) return "—";
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

/** Username = parte antes do @ (usado na tab Operadores como na Get In). */
function deriveUsername(email: string | null): string {
  if (!email) return "—";
  return email.split("@")[0] ?? email;
}

export default function Usuarios() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const { user, isPlatformAdmin } = useAuth();
  const isOwner = !!unit?.isOwner || isPlatformAdmin;

  const [tab, setTab] = useState<Tab>("gerentes");
  const [createOpen, setCreateOpen] = useState(false);

  const { data: members, isLoading } = useUnitMembers(unitId);

  const filtered = useMemo(() => {
    if (!members) return [];
    if (tab === "gerentes") {
      return members.filter((m) => m.role === "owner" || m.role === "gerente");
    }
    return members.filter((m) => m.role === "operador");
  }, [members, tab]);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Usuários</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Gerencie quem tem acesso ao painel desta unidade.
        </p>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex border-b">
          <TabButton active={tab === "gerentes"} onClick={() => setTab("gerentes")}>
            Gerentes
          </TabButton>
          <TabButton active={tab === "operadores"} onClick={() => setTab("operadores")}>
            Operadores
          </TabButton>
        </div>

        <div className="p-4 sm:p-6 space-y-4">
          <div className="flex justify-end">
            <Button
              size="sm"
              className="gap-2"
              onClick={() => setCreateOpen(true)}
              disabled={!isOwner}
              title={isOwner ? undefined : "Apenas o proprietário pode adicionar membros"}
            >
              <Plus className="h-4 w-4" />
              {tab === "gerentes" ? "Adicionar gerente" : "Adicionar operador"}
            </Button>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !filtered.length ? (
            <div className="py-12 text-center text-sm text-muted-foreground space-y-2">
              <Users className="h-8 w-8 mx-auto opacity-30" />
              <p>
                {tab === "gerentes"
                  ? "Nenhum gerente cadastrado."
                  : "Nenhum operador cadastrado."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>{tab === "gerentes" ? "E-mail" : "Usuário"}</TableHead>
                  {tab === "gerentes" && <TableHead className="w-32">Função</TableHead>}
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    tab={tab}
                    isOwner={isOwner}
                    isSelf={m.user_id === user?.id}
                    unitId={unitId}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          <p className="text-xs text-muted-foreground text-center pt-2">
            Total de {filtered.length}{" "}
            {tab === "gerentes" ? "gerentes" : "operadores"}
          </p>
        </div>
      </Card>

      <CreateMemberDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        unitId={unitId}
        defaultRole={tab === "gerentes" ? "gerente" : "operador"}
        showRolePicker={tab === "gerentes"}
      />
    </div>
  );
}

// ─── Row + actions ────────────────────────────────────────────────────────────

function MemberRow({
  member,
  tab,
  isOwner,
  isSelf,
  unitId,
}: {
  member: UnitMemberRow;
  tab: Tab;
  isOwner: boolean;
  isSelf: boolean;
  unitId: string;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const updateRole = useUpdateMemberRole(unitId);
  const removeMember = useDeleteUnitMember(unitId);

  const displayName = deriveDisplayName(member.email, member.name);
  const username = deriveUsername(member.email);

  const isOwnerRow = member.role === "owner";
  const canEdit = isOwner && !isOwnerRow && !isSelf;
  const canEditSelfName = isSelf;

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{displayName}</span>
            {isSelf && (
              <Badge variant="outline" className="text-[10px]">
                você
              </Badge>
            )}
            {isOwnerRow && (
              <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/30">
                Proprietário
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground font-mono truncate max-w-xs">
          {tab === "gerentes" ? member.email ?? "—" : username}
        </TableCell>
        {tab === "gerentes" && (
          <TableCell>
            <span className="text-sm">{ROLE_LABELS[member.role]}</span>
          </TableCell>
        )}
        <TableCell>
          {(canEdit || canEditSelfName) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  Editar nome
                </DropdownMenuItem>
                {canEdit && (
                  <>
                    <DropdownMenuItem
                      onSelect={() => {
                        const next: UnitRole =
                          member.role === "gerente" ? "operador" : "gerente";
                        updateRole.mutate({ memberId: member.id, role: next });
                      }}
                    >
                      Tornar {member.role === "gerente" ? "operador" : "gerente"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => setRemoveOpen(true)}
                    >
                      Remover
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </TableCell>
      </TableRow>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        member={member}
        unitId={unitId}
      />

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta pessoa perderá acesso ao painel desta unidade imediatamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => removeMember.mutate(member.id)}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Modal: criar membro ──────────────────────────────────────────────────────

function CreateMemberDialog({
  open,
  onOpenChange,
  unitId,
  defaultRole,
  showRolePicker,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  unitId: string;
  defaultRole: UnitRole;
  showRolePicker: boolean;
}) {
  const create = useCreateUnitMember(unitId);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UnitRole>(defaultRole);

  const reset = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRole(defaultRole);
  };

  const handleSubmit = () => {
    const trimEmail = email.trim().toLowerCase();
    if (!trimEmail || !password) {
      toast.error("Preencha e-mail e senha.");
      return;
    }
    if (password.length < 6) {
      toast.error("A senha deve ter pelo menos 6 caracteres.");
      return;
    }
    create.mutate(
      {
        email: trimEmail,
        password,
        role: showRolePicker ? role : "operador",
        name: name.trim() || null,
      },
      {
        onSuccess: (data) => {
          const reused = (data as { reused?: boolean } | null)?.reused === true;
          if (reused) {
            toast.success(
              "Usuário já existia no sistema e foi vinculado a esta unidade. A senha original foi mantida.",
            );
          } else {
            toast.success("Membro cadastrado.");
          }
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {showRolePicker ? "Adicionar gerente" : "Adicionar operador"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Nome</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Maria Costa"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">
              <span className="text-destructive">*</span> E-mail
            </Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@exemplo.com"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">
              <span className="text-destructive">*</span> Senha (mín. 6
              caracteres)
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••"
            />
          </div>

          {showRolePicker && (
            <div className="space-y-1">
              <Label className="text-xs">Papel</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as UnitRole)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gerente">Gerente</SelectItem>
                  <SelectItem value="operador">Operador</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={create.isPending}>
            {create.isPending ? "Cadastrando…" : "Cadastrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Modal: editar nome ───────────────────────────────────────────────────────

function RenameDialog({
  open,
  onOpenChange,
  member,
  unitId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  member: UnitMemberRow;
  unitId: string;
}) {
  const update = useUpdateMemberName(unitId);
  const [name, setName] = useState(
    member.name ?? deriveDisplayName(member.email, null),
  );

  const handleSave = () => {
    update.mutate(
      { memberId: member.id, name: name.trim() || null },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar nome</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Nome</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Maria Costa"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              {member.email ?? "Sem e-mail"}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
