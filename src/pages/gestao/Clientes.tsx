import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useDebounce } from "@/hooks/useDebounce";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateBR, formatPhone, sanitizeSearchTerm } from "@/lib/utils";
import type { Customer } from "@/types/reserva";
import {
  AlertTriangle,
  BellOff,
  Download,
  Phone,
  Search,
  ShieldAlert,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import {
  useAnonymizeCustomer,
  useCustomerStats,
  useUpdateCustomer,
} from "@/hooks/useCustomers";
import { exportClientesXlsx } from "@/lib/exportXlsx";
import { toast } from "sonner";

interface CustomerWithCount extends Customer {
  /** Reservas do customer SÓ nesta unidade. */
  reservations_unit: number;
  /** Reservas do customer em toda a organização (todas as units da rede). */
  reservations_org: number;
}

interface CustomerStatsBulkRow {
  customer_id: string;
  total_unit: number;
  total_org: number;
  confirmed: number;
  no_shows: number;
  cancelled: number;
  no_show_rate: number | null;
  last_visit: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_SIZE = 50;

function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

function getEmailsArray(c: Pick<Customer, "emails" | "email">): string[] {
  if (Array.isArray(c.emails) && c.emails.length > 0) return c.emails;
  return c.email ? [c.email] : [];
}

export default function Clientes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const orgId = unit?.organization_id ?? "";

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim(), 300);
  const [selected, setSelected] = useState<CustomerWithCount | null>(null);
  const [exporting, setExporting] = useState(false);

  const customersQuery = useInfiniteQuery({
    queryKey: ["customers", orgId, unitId, debouncedSearch],
    enabled: !!orgId && !!unitId,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const from = pageParam * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = supabase
        .from("customers")
        .select("*")
        .eq("organization_id", orgId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .range(from, to);

      const safeSearch = sanitizeSearchTerm(debouncedSearch);
      if (safeSearch) {
        q = q.or(
          `name.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`
        );
      }

      const { data, error } = await q;
      if (error) throw error;

      const ids = (data ?? []).map((c) => c.id);
      const statsById = new Map<string, CustomerStatsBulkRow>();
      if (ids.length > 0) {
        const { data: stats, error: statsError } = await supabase.rpc(
          "get_customer_stats_bulk",
          { p_customer_ids: ids, p_unit_id: unitId }
        );
        if (statsError) throw statsError;
        for (const row of (stats ?? []) as CustomerStatsBulkRow[]) {
          statsById.set(row.customer_id, row);
        }
      }

      const items: CustomerWithCount[] = (data ?? []).map((c) => ({
        ...c,
        reservations_unit: statsById.get(c.id)?.total_unit ?? 0,
        reservations_org: statsById.get(c.id)?.total_org ?? 0,
      }));

      return {
        items,
        nextPage: items.length === PAGE_SIZE ? pageParam + 1 : undefined,
      };
    },
    getNextPageParam: (lastPage) => lastPage.nextPage,
  });

  const customers = customersQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const isLoading = customersQuery.isLoading;

  // Total real de clientes (head:true → só conta, não traz dados). Espelha os
  // mesmos filtros da lista, então sem busca mostra o total geral e com busca
  // mostra o total filtrado — consistente com o que está em tela.
  const countQuery = useQuery({
    queryKey: ["customers-count", orgId, unitId, debouncedSearch],
    enabled: !!orgId && !!unitId,
    staleTime: 30_000,
    queryFn: async () => {
      let q = supabase
        .from("customers")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .is("deleted_at", null);

      const safeSearch = sanitizeSearchTerm(debouncedSearch);
      if (safeSearch) {
        q = q.or(
          `name.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`
        );
      }

      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });
  const totalCount = countQuery.data;

  // IntersectionObserver pra auto-carregar próxima página quando a sentinela
  // entra no viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          customersQuery.hasNextPage &&
          !customersQuery.isFetchingNextPage
        ) {
          customersQuery.fetchNextPage();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [customersQuery]);

  async function handleExport() {
    if (!orgId || !unitId) {
      toast.error("Aguarde o carregamento da unidade.");
      return;
    }
    setExporting(true);
    try {
      const { count } = await exportClientesXlsx(
        orgId,
        unitId,
        debouncedSearch || undefined
      );
      if (count === 0) {
        toast.info("Nenhum cliente para exportar.");
      } else {
        toast.success(
          `${count} cliente${count === 1 ? "" : "s"} exportado${count === 1 ? "" : "s"}.`
        );
      }
    } catch (err) {
      console.error("exportClientesXlsx error:", { orgId, unitId, search: debouncedSearch, err });
      toast.error("Falha ao exportar.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Clientes</h1>
          {totalCount != null && (
            <Badge variant="secondary" className="text-sm font-medium">
              {totalCount.toLocaleString("pt-BR")}{" "}
              {totalCount === 1 ? "cliente" : "clientes"}
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={exporting || !customers.length}
        >
          <Download className="h-4 w-4 mr-2" />
          {exporting ? "Exportando..." : "Exportar Excel"}
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar nome, telefone ou e-mail..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : customersQuery.isError ? (
        <Card className="border-destructive/30">
          <CardContent className="py-10 text-center space-y-3">
            <p className="text-sm font-medium text-destructive">
              Não foi possível carregar os clientes.
            </p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              {customersQuery.error instanceof Error
                ? customersQuery.error.message
                : "Erro desconhecido ao consultar o banco."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => customersQuery.refetch()}
              disabled={customersQuery.isFetching}
            >
              {customersQuery.isFetching ? "Tentando..." : "Tentar novamente"}
            </Button>
          </CardContent>
        </Card>
      ) : !customers.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhum cliente encontrado.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3">
            {customers.map((c) => {
              const emailsArr = getEmailsArray(c);
              const primaryEmail = emailsArr[0];
              const extraEmails = emailsArr.length - 1;
              const totalReservas = c.reservations_org;
              const inUnit = c.reservations_unit;
              const showUnitHint = totalReservas > 0 && inUnit !== totalReservas;
              return (
                <Card
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(c);
                    }
                  }}
                  className="hover:shadow-sm transition-shadow cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <CardContent className="py-3 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{c.name}</p>
                        {c.vip_notes && (
                          <Badge className="text-[10px] gap-1 bg-amber-100 text-amber-900 border-amber-200 hover:bg-amber-100">
                            <Sparkles className="h-2.5 w-2.5" />
                            VIP
                          </Badge>
                        )}
                        {c.allergies && (
                          <Badge variant="outline" className="text-[10px] gap-1 text-destructive border-destructive/30">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            Alergia
                          </Badge>
                        )}
                        {c.do_not_contact && (
                          <Badge variant="outline" className="text-[10px] gap-1">
                            <BellOff className="h-2.5 w-2.5" />
                            Não contatar
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground mt-0.5 flex-wrap">
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {formatPhone(c.phone)}
                        </span>
                        {primaryEmail && <span className="truncate">{primaryEmail}</span>}
                        {extraEmails > 0 && (
                          <Badge variant="outline" className="text-[10px]">
                            +{extraEmails} e-mail{extraEmails === 1 ? "" : "s"}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <Badge variant="outline" className="text-xs">
                        {totalReservas} {totalReservas === 1 ? "reserva" : "reservas"}
                        {showUnitHint && (
                          <span className="ml-1 text-muted-foreground">({inUnit} aqui)</span>
                        )}
                      </Badge>
                      <p className="text-xs text-muted-foreground mt-1">
                        desde {formatDateBR(c.created_at)}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div ref={sentinelRef} className="h-8 flex items-center justify-center">
            {customersQuery.isFetchingNextPage && (
              <p className="text-xs text-muted-foreground">Carregando mais...</p>
            )}
            {!customersQuery.hasNextPage && customers.length > PAGE_SIZE && (
              <p className="text-xs text-muted-foreground">Fim da lista.</p>
            )}
          </div>
        </>
      )}

      <CustomerDetailsDialog
        customer={selected}
        unitId={unitId}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function CustomerDetailsDialog({
  customer,
  unitId,
  onClose,
}: {
  customer: Customer | null;
  unitId: string;
  onClose: () => void;
}) {
  const update = useUpdateCustomer(unitId);
  const anonymize = useAnonymizeCustomer(unitId);
  const { data: stats, isLoading: loadingStats } = useCustomerStats(customer?.id, unitId);

  if (!customer) return null;
  const emailsArr = getEmailsArray(customer);
  const noShowRate = stats?.no_show_rate ?? null;
  const hasShowDecision =
    stats != null && stats.confirmed + stats.no_shows >= 3 && noShowRate != null;
  return (
    <Dialog open={!!customer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{customer.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 mt-2">
          <div className="text-sm text-muted-foreground">
            {formatPhone(customer.phone)}
            {emailsArr[0] && <span className="ml-2">· {emailsArr[0]}</span>}
          </div>

          <div className="rounded-lg border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-3">
              Histórico
            </p>
            {loadingStats ? (
              <Skeleton className="h-12 w-full" />
            ) : stats ? (
              <div className="grid grid-cols-4 gap-3 text-center">
                <Stat label="Reservas" value={stats.total} />
                <Stat label="Confirmadas" value={stats.confirmed} />
                <Stat label="Não vieram" value={stats.no_shows} />
                <Stat
                  label="Taxa no-show"
                  value={noShowRate != null ? `${Math.round(noShowRate * 100)}%` : "—"}
                  highlight={hasShowDecision && noShowRate! >= 0.3}
                />
              </div>
            ) : null}
            {stats?.last_visit && (
              <p className="text-xs text-muted-foreground mt-3 text-center">
                Última presença: {formatDateBR(stats.last_visit)}
              </p>
            )}
          </div>

          <CustomerEditForm
            customer={customer}
            onSave={(updates) =>
              update.mutate(
                { id: customer.id, updates },
                {
                  onSuccess: () => {
                    toast.success("Cliente atualizado.");
                    onClose();
                  },
                  onError: (err: unknown) => {
                    // 23505 = unique_violation no Postgres (customers_org_phone_unique)
                    const msg =
                      typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "23505"
                        ? "Já existe outro cliente com este telefone."
                        : "Erro ao salvar.";
                    toast.error(msg);
                  },
                }
              )
            }
            saving={update.isPending}
          />

          <div className="rounded-lg border border-destructive/30 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Excluir cliente</p>
                <p className="text-xs text-muted-foreground">
                  Remove nome, telefone, e-mails e preferências. As reservas continuam no
                  histórico do restaurante, mas sem identificar a pessoa (exigência LGPD). Não dá pra desfazer.
                </p>
              </div>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive border-destructive/30">
                  Excluir este cliente
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Excluir {customer.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Os dados pessoais (nome, telefone, e-mails, alergias, notas) serão
                    apagados permanentemente. Reservas históricas continuam para fins
                    fiscais e estatísticos. <strong>Esta ação não pode ser desfeita.</strong>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={anonymize.isPending}>
                    Cancelar
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={anonymize.isPending}
                    onClick={(e) => {
                      e.preventDefault();
                      anonymize.mutate(customer.id, {
                        onSuccess: () => {
                          toast.success("Cliente excluído.");
                          onClose();
                        },
                        onError: () => toast.error("Erro ao excluir."),
                      });
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {anonymize.isPending ? "Excluindo..." : "Excluir"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className={`text-xl font-bold ${highlight ? "text-destructive" : ""}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

type CustomerEditFormUpdates = Partial<
  Pick<
    Customer,
    | "name"
    | "phone"
    | "emails"
    | "birthday"
    | "allergies"
    | "dietary_restrictions"
    | "vip_notes"
    | "preferred_table_location"
    | "do_not_contact"
  >
>;

function CustomerEditForm({
  customer,
  onSave,
  saving,
}: {
  customer: Customer;
  onSave: (updates: CustomerEditFormUpdates) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone);
  const [emails, setEmails] = useState<string[]>(getEmailsArray(customer));
  const [newEmail, setNewEmail] = useState("");
  const [birthday, setBirthday] = useState(customer.birthday ?? "");
  const [allergies, setAllergies] = useState(customer.allergies ?? "");
  const [dietary, setDietary] = useState(customer.dietary_restrictions ?? "");
  const [vipNotes, setVipNotes] = useState(customer.vip_notes ?? "");
  const [preferredLocation, setPreferredLocation] = useState<string>(
    customer.preferred_table_location ?? "none"
  );
  const [doNotContact, setDoNotContact] = useState(customer.do_not_contact ?? false);

  function handleAddEmail() {
    const candidate = normalizeEmail(newEmail);
    if (!candidate) return;
    if (!EMAIL_RE.test(candidate)) {
      toast.error("E-mail inválido.");
      return;
    }
    if (emails.some((e) => e.toLowerCase() === candidate)) {
      toast.info("E-mail já cadastrado.");
      setNewEmail("");
      return;
    }
    setEmails([...emails, candidate]);
    setNewEmail("");
  }

  function handleRemoveEmail(idx: number) {
    setEmails(emails.filter((_, i) => i !== idx));
  }

  function handleMakePrimary(idx: number) {
    if (idx === 0) return;
    const next = [...emails];
    const [picked] = next.splice(idx, 1);
    next.unshift(picked);
    setEmails(next);
  }

  function handleSave() {
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 13) {
      toast.error("Telefone inválido. Use DDD + número.");
      return;
    }
    if (!name.trim()) {
      toast.error("Nome obrigatório.");
      return;
    }
    onSave({
      name: name.trim(),
      phone: phoneDigits,
      emails,
      birthday: birthday || null,
      allergies: allergies.trim() || null,
      dietary_restrictions: dietary.trim() || null,
      vip_notes: vipNotes.trim() || null,
      preferred_table_location:
        preferredLocation === "none"
          ? null
          : (preferredLocation as "internal" | "external"),
      do_not_contact: doNotContact,
    });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Identidade</p>

        <div className="space-y-1">
          <Label className="text-xs">Nome</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Telefone</Label>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="11999990000"
          />
          <p className="text-[11px] text-muted-foreground">
            Só dígitos (DDD + número). Mostrado como {formatPhone(phone.replace(/\D/g, "") || customer.phone)}.
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">E-mails</Label>
          {emails.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Nenhum e-mail cadastrado.</p>
          ) : (
            <div className="space-y-1.5">
              {emails.map((e, i) => (
                <div
                  key={`${e}-${i}`}
                  className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
                >
                  {i === 0 ? (
                    <Badge variant="outline" className="text-[10px] gap-1 border-amber-300 text-amber-900 bg-amber-50">
                      <Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" />
                      Principal
                    </Badge>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleMakePrimary(i)}
                      className="text-[10px] underline text-muted-foreground hover:text-foreground"
                    >
                      Tornar principal
                    </button>
                  )}
                  <span className="flex-1 truncate">{e}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveEmail(i)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remover ${e}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <Input
              type="email"
              placeholder="adicionar@email.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddEmail();
                }
              }}
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={handleAddEmail}>
              Adicionar
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            O e-mail "Principal" é usado para enviar confirmação de reserva.
          </p>
        </div>
      </div>

      <div className="space-y-4 pt-2 border-t">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Preferências</p>

        <div className="space-y-1">
          <Label className="text-xs">Data de nascimento</Label>
          <Input
            type="date"
            value={birthday}
            onChange={(e) => setBirthday(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            Usada por regras de Giftback do tipo "Aniversário".
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Alergias</Label>
          <Textarea
            rows={2}
            value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
            placeholder="Ex: amendoim, frutos do mar"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Restrições alimentares</Label>
          <Textarea
            rows={2}
            value={dietary}
            onChange={(e) => setDietary(e.target.value)}
            placeholder="Ex: vegetariano, sem glúten"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Notas VIP</Label>
          <Textarea
            rows={2}
            value={vipNotes}
            onChange={(e) => setVipNotes(e.target.value)}
            placeholder="Ex: cliente fiel, oferece prosecco de cortesia"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Mesa preferida</Label>
          <Select value={preferredLocation} onValueChange={setPreferredLocation}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sem preferência</SelectItem>
              <SelectItem value="internal">Interna</SelectItem>
              <SelectItem value="external">Externa / Varanda</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Não enviar mensagens</p>
            <p className="text-xs text-muted-foreground">
              Pula esse cliente em campanhas e lembretes.
            </p>
          </div>
          <Switch checked={doNotContact} onCheckedChange={setDoNotContact} />
        </div>
      </div>

      <Button className="w-full" disabled={saving} onClick={handleSave}>
        {saving ? "Salvando..." : "Salvar alterações"}
      </Button>
    </div>
  );
}
