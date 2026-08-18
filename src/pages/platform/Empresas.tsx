import { useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, ExternalLink, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  type CreateOrganizationInput,
  type UpdateOrganizationInput,
} from "@/lib/validators/organization";
import {
  useOrganizations,
  useCreateOrganization,
  useUpdateOrganization,
  type OrganizationRow,
} from "@/hooks/useOrganizations";

// ── Create dialog ──────────────────────────────────────────────────────────────

function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateOrganization();
  const form = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: {
      org_name: "",
      org_slug: "",
      unit_name: "",
      unit_slug: "",
      unit_timezone: "America/Sao_Paulo",
      owner_email: "",
      owner_password: "",
      tax_id: "",
      billing_email: "",
      default_whatsapp_provider: "zapi",
    },
  });

  const onSubmit = async (values: CreateOrganizationInput) => {
    await create.mutateAsync(values);
    form.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova empresa</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="org_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nome da empresa</FormLabel>
                    <FormControl>
                      <Input placeholder="Grupo Acme" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="org_slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug da empresa</FormLabel>
                    <FormControl>
                      <Input placeholder="grupo-acme" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="default_whatsapp_provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Integração padrão do WhatsApp</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="min-h-11">
                        <SelectValue placeholder="Selecione a integração" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="zapi">Z-API</SelectItem>
                      <SelectItem value="uazapi">UazAPI</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Define a preferência inicial. A conexão do número é feita separadamente.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="unit_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nome da unidade</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Centro" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="unit_slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug da unidade</FormLabel>
                    <FormControl>
                      <Input placeholder="acme-centro" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="unit_timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fuso horário</FormLabel>
                  <FormControl>
                    <Input placeholder="America/Sao_Paulo" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="owner_email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>E-mail do proprietário</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="dono@acme.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="owner_password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Senha inicial</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="mín. 10 chars" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="tax_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>CPF/CNPJ da empresa</FormLabel>
                    <FormControl>
                      <Input placeholder="11.222.333/0001-81" {...field} />
                    </FormControl>
                    <FormDescription>
                      Obrigatório para emitir cobrança. Aceita CPF ou CNPJ.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="billing_email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>E-mail de cobrança</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="financeiro@acme.com" {...field} />
                    </FormControl>
                    <FormDescription>
                      Recebe faturas e avisos. Pode ser igual ao do proprietário.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Criando…" : "Criar empresa"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit dialog ────────────────────────────────────────────────────────────────

function EditOrgDialog({
  org,
  onOpenChange,
}: {
  org: OrganizationRow | null;
  onOpenChange: (v: boolean) => void;
}) {
  const update = useUpdateOrganization();
  const form = useForm<UpdateOrganizationInput>({
    resolver: zodResolver(updateOrganizationSchema),
    // `plan` (coluna legada organizations.plan) saiu do form na Fase 3 da
    // migração billing-asaas: o plano real vive em billing_subscriptions →
    // billing_plans. A coluna continua no banco, só não é mais editável aqui.
    values: org
      ? {
          org_id: org.id,
          org_name: org.name,
          default_whatsapp_provider: org.default_whatsapp_provider,
        }
      : undefined,
  });

  const onSubmit = async (values: UpdateOrganizationInput) => {
    await update.mutateAsync(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={!!org} onOpenChange={() => onOpenChange(false)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Editar empresa</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="org_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="default_whatsapp_provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Integração padrão do WhatsApp</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="min-h-11">
                        <SelectValue placeholder="Selecione a integração" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="zapi">Z-API</SelectItem>
                      <SelectItem value="uazapi">UazAPI</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Alterar esta preferência não conecta nem desconecta o número atual.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? "Salvando…" : "Salvar"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Empresas() {
  const { data: orgs, isLoading, isError, error, refetch } = useOrganizations();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOrg, setEditOrg] = useState<OrganizationRow | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Empresas</h1>
          <p className="text-muted-foreground text-sm">
            Organizations cadastradas na plataforma.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Nova empresa
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Empresa</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>WhatsApp</TableHead>
              <TableHead className="text-center">Unidades</TableHead>
              <TableHead className="text-center">Membros</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  Carregando…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && isError && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 space-y-3">
                  <p className="text-sm text-destructive">{error?.message ?? "Falha ao carregar empresas."}</p>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !isError && (!orgs || orgs.length === 0) && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  <Building2 className="mx-auto h-8 w-8 mb-2 opacity-30" />
                  Nenhuma empresa cadastrada ainda.
                </TableCell>
              </TableRow>
            )}
            {orgs?.map((org) => (
              <TableRow key={org.id}>
                <TableCell className="font-medium">{org.name}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {org.slug}
                </TableCell>
                <TableCell>
                  {org.whatsapp_provider_source === "channels" ? (
                    org.whatsapp_provider_labels.join(" + ")
                  ) : (
                    // Sem canal, a preferencia e a unica informacao que existe —
                    // e ela nao autoriza dizer que algo esta em uso.
                    <span className="text-muted-foreground text-xs">
                      Sem canal · padrão {org.default_whatsapp_provider_label}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-center">{org.units_count}</TableCell>
                <TableCell className="text-center">{org.members_count}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditOrg(org)}>
                        <Pencil className="h-4 w-4 mr-2" />
                        Editar
                      </DropdownMenuItem>
                      {org.first_unit_slug && (
                        <DropdownMenuItem asChild>
                          <Link to={`/g/${org.first_unit_slug}`}>
                            <ExternalLink className="h-4 w-4 mr-2" />
                            Acessar painel
                          </Link>
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditOrgDialog org={editOrg} onOpenChange={(v) => !v && setEditOrg(null)} />
    </div>
  );
}
