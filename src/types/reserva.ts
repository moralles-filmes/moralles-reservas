export type ReservaStatus = "pending" | "confirmed" | "cancelled" | "no_show";

// ── Multi-tenant entities ──────────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface UnitAddress {
  street?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  cep?: string | null;
  full?: string | null;
}

export interface Unit {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  address: UnitAddress | null;
  timezone: string;
  is_public: boolean;
  description: string | null;
  price_range_min: number | null;
  price_range_max: number | null;
  hero_image_url: string | null;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
  organization?: Organization;
}

export type UnitRole = "owner" | "gerente" | "operador";

export interface UnitMember {
  id: string;
  user_id: string;
  unit_id: string;
  role: UnitRole;
  created_at: string;
  unit?: Unit;
}

export type WhatsAppProvider = "zapi" | "waha" | "official";
export type ChannelStatus = "connected" | "disconnected" | "error";

export interface WhatsAppChannel {
  id: string;
  unit_id: string;
  provider: WhatsAppProvider;
  status: ChannelStatus;
  display_phone: string | null;
  last_event_at: string | null;
  last_error: string | null;
  webhook_secret: string;
  created_at: string;
  updated_at: string;
}

// ── Operacional ───────────────────────────────────────────────────────────────

export type WalkInStatus = "waiting" | "seated" | "left" | "no_show";
export type WaitlistStatus = "waiting" | "notified" | "seated" | "cancelled";
export type WaitlistPriorityCategory =
  | "normal"
  | "senior"
  | "pregnant"
  | "disabled"
  | "other";
export type WaitlistTemplateEvent = "entered" | "table_ready" | "feedback";

export interface WaitlistMessageTemplate {
  id: string;
  unit_id: string;
  event: WaitlistTemplateEvent;
  customized: boolean;
  body: string;
  created_at: string;
  updated_at: string;
}

export type ReservationTemplateEvent = "reminder_d1" | "survey_d1";

export interface ReservationMessageTemplate {
  id: string;
  unit_id: string;
  event: ReservationTemplateEvent;
  customized: boolean;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface WalkIn {
  id: string;
  unit_id: string;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  table_id: string | null;
  status: WalkInStatus;
  notes: string | null;
  arrived_at: string;
  seated_at: string | null;
  created_at: string;
  updated_at: string;
  table?: { number: number } | null;
}

export interface WaitlistEntry {
  id: string;
  unit_id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  requested_for_time: string | null;
  priority: number;
  priority_category: WaitlistPriorityCategory;
  code: number | null;
  status: WaitlistStatus;
  notes: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Core domain ───────────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  organization_id: string;
  name: string;
  phone: string;
  email: string | null;
  birthday?: string | null;
  created_at: string;
  allergies?: string | null;
  dietary_restrictions?: string | null;
  vip_notes?: string | null;
  preferred_table_location?: "internal" | "external" | null;
  do_not_contact?: boolean;
  deleted_at?: string | null;
}

export interface TableBlock {
  id: string;
  unit_id: string;
  hall_id: string | null;
  /** Mesa específica afetada — se null, bloqueia toda a unit/hall no intervalo (macro). */
  table_id: string | null;
  /** Título exibido na UI. `reason` é o campo legado. */
  title: string | null;
  blocked_from: string;
  blocked_to: string;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  table?: Mesa | null;
}

export interface SpecialDate {
  id: string;
  unit_id: string;
  hall_id: string | null;
  /** Início do intervalo. */
  date: string;
  /** Fim do intervalo (inclusive). Pode ser igual a `date` para single-day. */
  end_date: string;
  name: string;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
  max_party_size: number | null;
  slot_minutes: number | null;
  min_advance_minutes: number | null;
  discount_percent: number | null;
  charge_enabled: boolean;
  charge_amount_cents: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerStats {
  total: number;
  confirmed: number;
  no_shows: number;
  cancelled: number;
  no_show_rate: number;
  last_visit: string | null;
}

export type AuditAction = "INSERT" | "UPDATE" | "DELETE";

export interface AuditLogEntry {
  id: number;
  table_name: string;
  record_id: string;
  action: AuditAction;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  actor_id: string | null;
  actor_email: string | null;
  unit_id: string | null;
  organization_id: string | null;
  created_at: string;
}

export interface Mesa {
  id: string;
  unit_id: string;
  hall_id: string | null;
  number: number;
  /** Mantido por compat — sincronizado via trigger com max_capacity. Use min/max nas regras novas. */
  capacity: number;
  min_capacity: number;
  max_capacity: number;
  location: "internal" | "external";
  active: boolean;
}

export type CustomFieldType = "text" | "options" | "file";

export interface UnitCustomField {
  id: string;
  unit_id: string;
  label: string;
  type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PublicCustomField {
  id: string;
  label: string;
  type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  sort_order: number;
}

/** Campos extras opcionais que o widget pode habilitar no form público. */
export type WidgetFieldKey =
  | "experiencia"
  | "estado"
  | "ocasiao"
  | "data_nascimento"
  | "cpf"
  | "cep"
  | "codigo_promocional"
  | "observacao";

export interface WidgetFieldConfig {
  enabled: boolean;
  required: boolean;
  /** Título customizado exibido no form (override do default). */
  label?: string | null;
}

export type WidgetFieldConfigMap = Partial<Record<WidgetFieldKey, WidgetFieldConfig>>;

export interface ReservationWidget {
  id: string;
  unit_id: string;
  slug: string;
  name: string;
  field_config: WidgetFieldConfigMap;
  client_instructions: string | null;
  show_menu_banner: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// ── Cardápios (galeria de imagens) ────────────────────────────────────────────

export interface MenuTheme {
  font_primary: string;
  font_secondary: string;
  bg_primary: string;
  bg_secondary: string;
  accent: string;
}

export const DEFAULT_MENU_THEME: MenuTheme = {
  font_primary: "#141414",
  font_secondary: "#AAAAAA",
  bg_primary: "#FFFFFF",
  bg_secondary: "#EFF2F5",
  accent: "#DD4F50",
};

export interface Menu {
  id: string;
  unit_id: string;
  slug: string;
  name: string;
  cover_image_url: string | null;
  theme: MenuTheme;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface MenuPage {
  id: string;
  menu_id: string;
  image_url: string;
  sort_order: number;
  created_at: string;
}

export type MenuBannerType = "home" | "content";

export interface MenuBanner {
  id: string;
  unit_id: string;
  type: MenuBannerType;
  image_url: string;
  link_url: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Hall {
  id: string;
  unit_id: string;
  name: string;
  description: string | null;
  active: boolean;
  allow_empty_seat: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface HallSchedule {
  id: string;
  hall_id: string;
  day_of_week: number;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_advance_minutes: number;
  discount_percent: number;
  charge_enabled: boolean;
  charge_amount_cents: number | null;
  created_at: string;
}

export interface Reserva {
  id: string;
  unit_id: string;
  customer_id: string;
  table_id: string | null;
  date: string;
  time: string;
  party_size: number;
  status: ReservaStatus;
  notes: string | null;
  reservation_code: string;
  satisfaction_rating?: number | null;
  satisfaction_at?: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  table?: Mesa;
}

export type ConversationStatus = "ai_active" | "awaiting_human" | "human_active" | "resolved";

export interface Conversation {
  id: string;
  unit_id: string;
  customer_id: string;
  reservation_id: string | null;
  messages: ConversationMessage[];
  status: ConversationStatus;
  handoff_reason: string | null;
  handoff_at: string | null;
  assigned_to: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  reservation?: Reserva;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "human";
  content: string;
  timestamp: string;
  human_user_id?: string;
}

export interface BusinessHour {
  id: string;
  unit_id: string;
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
