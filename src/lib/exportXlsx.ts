import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { formatDateBR, formatPhone, sanitizeSearchTerm, todayLocalISO } from "@/lib/utils";

const TABLE_LOCATION_PT: Record<string, string> = {
  internal: "Interna",
  external: "Externa/Varanda",
};

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  emails: string[] | null;
  birthday: string | null;
  allergies: string | null;
  dietary_restrictions: string | null;
  vip_notes: string | null;
  preferred_table_location: string | null;
  do_not_contact: boolean | null;
  created_at: string;
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

/**
 * Exporta toda a base de clientes da organização em XLSX, com 16 colunas
 * cobrindo identidade + preferências + estatísticas + última visita.
 *
 * Filtra por `search` se fornecido (mesma lógica do filtro visível em Clientes.tsx).
 * Soft-deleted (deleted_at != null) são sempre excluídos.
 *
 * Performance: uma única chamada `get_customer_stats_bulk` traz stats de todos
 * os customers (migration 060). Substitui o antigo N+1.
 *
 * Ordenação: `created_at DESC` — espelha a listagem em Clientes.tsx para que
 * o usuário não veja uma ordem na tela e outra no arquivo exportado.
 */
export async function exportClientesXlsx(
  orgId: string,
  unitId: string,
  search?: string,
): Promise<{ count: number }> {
  // Paginação explícita: o PostgREST aplica db-max-rows (default 1000 no Supabase)
  // quando não há .range(). Sem isso, exports de orgs com >1000 customers ficam
  // truncados silenciosamente. Buscamos em chunks até a página retornar < PAGE.
  const PAGE = 1000;
  const safeSearch = search ? sanitizeSearchTerm(search) : "";
  const customers: CustomerRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("customers")
      .select(
        "id, name, phone, email, emails, birthday, allergies, dietary_restrictions, vip_notes, preferred_table_location, do_not_contact, created_at",
      )
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (safeSearch) {
      q = q.or(
        `name.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`,
      );
    }
    const { data, error } = await q;
    if (error) throw error;
    const chunk = (data ?? []) as CustomerRow[];
    customers.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  if (customers.length === 0) return { count: 0 };

  const { data: statsData, error: statsError } = await supabase.rpc(
    "get_customer_stats_bulk",
    {
      p_customer_ids: customers.map((c) => c.id),
      p_unit_id: unitId,
    },
  );
  if (statsError) throw statsError;

  const statsById = new Map<string, CustomerStatsBulkRow>();
  for (const row of (statsData ?? []) as CustomerStatsBulkRow[]) {
    statsById.set(row.customer_id, row);
  }

  const rows = customers.map((c) => {
    const s = statsById.get(c.id);
    const emailsArr: string[] = Array.isArray(c.emails)
      ? c.emails
      : c.email
      ? [c.email]
      : [];
    return {
      Nome: c.name,
      Telefone: formatPhone(c.phone),
      "E-mail principal": emailsArr[0] ?? "",
      "E-mails adicionais": emailsArr.slice(1).join("; "),
      "Aniversário": c.birthday ? formatDateBR(c.birthday) : "",
      Alergias: c.allergies ?? "",
      "Restrições alimentares": c.dietary_restrictions ?? "",
      "Observações VIP": c.vip_notes ?? "",
      "Mesa preferida": c.preferred_table_location
        ? TABLE_LOCATION_PT[c.preferred_table_location] ?? ""
        : "",
      "Não contatar": c.do_not_contact ? "Sim" : "Não",
      "Cadastrado em": formatDateBR(c.created_at),
      "Total reservas (rede)": s?.total_org ?? 0,
      "Reservas nesta unidade": s?.total_unit ?? 0,
      Confirmadas: s?.confirmed ?? 0,
      "Não compareceu": s?.no_shows ?? 0,
      "Taxa no-show (%)":
        s?.no_show_rate != null ? Math.round(s.no_show_rate * 100) : "",
      "Última visita": s?.last_visit ? formatDateBR(s.last_visit) : "",
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 28 }, // Nome
    { wch: 18 }, // Telefone
    { wch: 30 }, // E-mail principal
    { wch: 36 }, // E-mails adicionais
    { wch: 12 }, // Aniversário
    { wch: 28 }, // Alergias
    { wch: 22 }, // Restrições
    { wch: 30 }, // VIP
    { wch: 18 }, // Mesa preferida
    { wch: 12 }, // Não contatar
    { wch: 14 }, // Cadastrado em
    { wch: 16 }, // Total reservas (rede)
    { wch: 18 }, // Reservas nesta unidade
    { wch: 12 }, // Confirmadas
    { wch: 14 }, // Não compareceu
    { wch: 14 }, // Taxa no-show %
    { wch: 14 }, // Última visita
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Clientes");
  XLSX.writeFile(wb, `clientes_${todayLocalISO()}.xlsx`);

  return { count: rows.length };
}
