import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
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
import { formatDateBR, formatPhone } from "@/lib/utils";
import type { Customer } from "@/types/reserva";
import { AlertTriangle, BellOff, Phone, Search, ShieldAlert, Sparkles } from "lucide-react";
import {
  useAnonymizeCustomer,
  useCustomerStats,
  useUpdateCustomer,
} from "@/hooks/useCustomers";
import { toast } from "sonner";

interface CustomerWithCount extends Customer {
  reservations_count: number;
}

export default function Clientes() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CustomerWithCount | null>(null);

  const { data: customers, isLoading } = useQuery({
    queryKey: ["customers", search],
    queryFn: async () => {
      let query = supabase
        .from("customers")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (search) {
        query = query.or(
          `name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
        );
      }

      const { data, error } = await query;
      if (error) throw error;

      const ids = data.map((c) => c.id);
      if (ids.length === 0) return [];

      const { data: counts } = await supabase
        .from("reservations")
        .select("customer_id")
        .in("customer_id", ids);

      const countMap = (counts || []).reduce<Record<string, number>>((acc, r) => {
        acc[r.customer_id] = (acc[r.customer_id] || 0) + 1;
        return acc;
      }, {});

      return data.map((c) => ({
        ...c,
        reservations_count: countMap[c.id] || 0,
      })) as CustomerWithCount[];
    },
  });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Clientes</h1>

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
      ) : !customers?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhum cliente encontrado.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {customers.map((c) => (
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
                  <div className="flex items-center gap-3 text-sm text-muted-foreground mt-0.5">
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {formatPhone(c.phone)}
                    </span>
                    {c.email && <span className="truncate">{c.email}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <Badge variant="outline" className="text-xs">
                    {c.reservations_count} {c.reservations_count === 1 ? "reserva" : "reservas"}
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-1">
                    desde {formatDateBR(c.created_at)}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CustomerDetailsDialog
        customer={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

// ─── Drawer: detalhes + preferências + stats ──────────────────────────────────

function CustomerDetailsDialog({
  customer,
  onClose,
}: {
  customer: Customer | null;
  onClose: () => void;
}) {
  const update = useUpdateCustomer();
  const anonymize = useAnonymizeCustomer();
  const { data: stats, isLoading: loadingStats } = useCustomerStats(customer?.id);

  if (!customer) return null;
  return (
    <Dialog open={!!customer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{customer.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 mt-2">
          <div className="text-sm text-muted-foreground">
            {formatPhone(customer.phone)}
            {customer.email && <span className="ml-2">· {customer.email}</span>}
          </div>

          {/* Stats */}
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
                  value={`${Math.round((stats.no_show_rate ?? 0) * 100)}%`}
                  highlight={stats.no_show_rate >= 0.3 && stats.confirmed + stats.no_shows >= 3}
                />
              </div>
            ) : null}
            {stats?.last_visit && (
              <p className="text-xs text-muted-foreground mt-3 text-center">
                Última presença: {formatDateBR(stats.last_visit)}
              </p>
            )}
          </div>

          {/* Preferences */}
          <CustomerPreferencesForm
            customer={customer}
            onSave={(updates) =>
              update.mutate(
                { id: customer.id, updates },
                {
                  onSuccess: () => {
                    toast.success("Preferências atualizadas.");
                    onClose();
                  },
                  onError: () => toast.error("Erro ao salvar."),
                }
              )
            }
            saving={update.isPending}
          />

          {/* LGPD: anonimização */}
          <div className="rounded-lg border border-destructive/30 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Anonimizar cliente (LGPD)</p>
                <p className="text-xs text-muted-foreground">
                  Remove nome, telefone, e-mail e preferências. As reservas continuam no
                  histórico do restaurante, mas sem identificar a pessoa. Não dá pra desfazer.
                </p>
              </div>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive border-destructive/30">
                  Anonimizar este cliente
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Anonimizar {customer.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Os dados pessoais (nome, telefone, e-mail, alergias, notas) serão
                    apagados permanentemente. Reservas históricas continuam para fins
                    fiscais e estatísticos. <strong>Esta ação não pode ser desfeita.</strong>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      anonymize.mutate(customer.id, {
                        onSuccess: () => {
                          toast.success("Cliente anonimizado.");
                          onClose();
                        },
                        onError: () => toast.error("Erro ao anonimizar."),
                      })
                    }
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Anonimizar
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

function CustomerPreferencesForm({
  customer,
  onSave,
  saving,
}: {
  customer: Customer;
  onSave: (
    updates: Partial<
      Pick<
        Customer,
        | "allergies"
        | "dietary_restrictions"
        | "vip_notes"
        | "preferred_table_location"
        | "do_not_contact"
      >
    >
  ) => void;
  saving: boolean;
}) {
  const [allergies, setAllergies] = useState(customer.allergies ?? "");
  const [dietary, setDietary] = useState(customer.dietary_restrictions ?? "");
  const [vipNotes, setVipNotes] = useState(customer.vip_notes ?? "");
  const [preferredLocation, setPreferredLocation] = useState<string>(
    customer.preferred_table_location ?? "none"
  );
  const [doNotContact, setDoNotContact] = useState(customer.do_not_contact ?? false);

  return (
    <div className="space-y-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Preferências</p>

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

      <Button
        className="w-full"
        disabled={saving}
        onClick={() =>
          onSave({
            allergies: allergies.trim() || null,
            dietary_restrictions: dietary.trim() || null,
            vip_notes: vipNotes.trim() || null,
            preferred_table_location:
              preferredLocation === "none"
                ? null
                : (preferredLocation as "internal" | "external"),
            do_not_contact: doNotContact,
          })
        }
      >
        Salvar preferências
      </Button>
    </div>
  );
}
