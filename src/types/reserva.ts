export type ReservaStatus = "pending" | "confirmed" | "cancelled" | "no_show";

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  created_at: string;
}

export interface Mesa {
  id: string;
  number: number;
  capacity: number;
  location: "internal" | "external";
  active: boolean;
}

export interface Reserva {
  id: string;
  customer_id: string;
  table_id: string | null;
  date: string;
  time: string;
  party_size: number;
  status: ReservaStatus;
  notes: string | null;
  reservation_code: string;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  table?: Mesa;
}

export interface Conversation {
  id: string;
  customer_id: string;
  reservation_id: string | null;
  messages: ConversationMessage[];
  created_at: string;
  updated_at: string;
  customer?: Customer;
  reservation?: Reserva;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface BusinessHour {
  id: string;
  day_of_week: number;
  open_time: string;
  close_time: string;
  max_party_size: number;
  is_closed: boolean;
}

export interface ReservaFormData {
  name: string;
  phone: string;
  email?: string;
  date: string;
  time: string;
  party_size: number;
  notes?: string;
}

export interface AvailabilitySlot {
  time: string;
  available: boolean;
  available_tables: number;
}

export const STATUS_LABELS: Record<ReservaStatus, string> = {
  pending: "Pendente",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
  no_show: "Não compareceu",
};

export const STATUS_COLORS: Record<ReservaStatus, string> = {
  pending: "bg-warning/15 text-warning border-warning/20",
  confirmed: "bg-success/15 text-success border-success/20",
  cancelled: "bg-destructive/15 text-destructive border-destructive/20",
  no_show: "bg-muted text-muted-foreground border-border",
};

export const DAY_NAMES = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
];
