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
  complement?: string | null;
  city?: string | null;
  state?: string | null;
  cep?: string | null;
  lat?: number | null;
  lng?: number | null;
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
  cnpj: string | null;
  financial_email: string | null;
  cuisine_types: string[];
  opening_hours_text: string | null;
  payment_methods: string | null;
  facilities: string[];
  phone: string | null;
  instagram: string | null;
  website: string | null;
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

export type WhatsAppProvider = "zapi" | "uazapi" | "waha" | "official" | "datafy";
export type ChannelStatus =
  | "not_configured"
  | "provisioning"
  | "waiting_qr"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "suspended"
  | "provider_error"
  | "switching_provider"
  | "error";

export interface WhatsAppChannel {
  ingestion_mode_effective?: "sync" | "async" | "unknown";
  provider_subscribed_at?: string | null;
  provider_paused_at?: string | null;
  provider_subscription_canceled_at?: string | null;
  external_instance_id?: string | null;
  id: string;
  unit_id: string;
  provider: WhatsAppProvider;
  status: ChannelStatus;
  display_phone: string | null;
  last_event_at: string | null;
  last_error: string | null;
  webhook_secret: string;
  is_active: boolean | null;
  connected_at: string | null;
  last_health_check_at: string | null;
  activation_requested_at: string | null;
  manual_echo_verified_at: string | null;
  manual_echo_verification_source: "provider_callback" | "managed_configuration" | null;
  capabilities?: WhatsAppProviderCapabilities;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppProviderCapabilities {
  manualCredentials: boolean;
  automaticProvisioning: boolean;
  qrConnection: boolean;
  pairCode: boolean;
  automaticWebhook: boolean;
  disconnect: boolean;
  restart: boolean;
  deliveryReceipts: boolean;
  /** Envio de templates aprovados pela Meta. */
  templateMessages: boolean;
  /** Envio de imagem, áudio, vídeo, documento ou sticker. */
  mediaMessages: boolean;
  /** Download da mídia recebida do cliente. */
  inboundMediaDownload: boolean;
  /** Botões, listas e demais formatos interativos. */
  interactiveMessages: boolean;
  /** Entrega o objeto referral de anúncio Click-to-WhatsApp no payload. */
  adReferral: boolean;
  /** Requisição de baixo nível a endpoints da Cloud API. */
  rawCloudApiProxy: boolean;
  manualDeviceEcho: "supported" | "conditional" | "unsupported";
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
  /** Mesa liberada na planta. O status fica `seated` para as métricas. */
  released_at?: string | null;
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
  /** Mesa em que a entrada da fila foi sentada pela planta. */
  table_id?: string | null;
  seated_at?: string | null;
  released_at?: string | null;
  created_at: string;
  updated_at: string;
}

// ── Core domain ───────────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  organization_id: string;
  name: string;
  phone: string;
  /** Espelho de emails[0], sincronizado por trigger no banco (migration 054). */
  email: string | null;
  /** Lista de e-mails associados ao cliente. emails[0] é o principal e é refletido em customers.email. */
  emails?: string[];
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
  /** Null quando o denominador (confirmed + no_shows) é 0 — não há dado para calcular taxa. */
  no_show_rate: number | null;
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
  /** Planta do salão, em cm: centro, tamanho e giro. Todas nulas = mesa fora da planta. */
  plan_x?: number | null;
  plan_y?: number | null;
  plan_w?: number | null;
  plan_h?: number | null;
  plan_rotation?: number | null;
  plan_shape?: "round" | "square" | "rect" | null;
}

export type PlanWall = "top" | "right" | "bottom" | "left";

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

/** Horário público de um hall (vindo das RPCs `get_unit_public_full` / `get_widget_public`). */
export interface PublicHallSchedule {
  day_of_week: number;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_advance_minutes: number;
  /** % de desconto no horário. 0/null = sem desconto. */
  discount_percent?: number | null;
  /** Caução habilitada neste horário. */
  charge_enabled?: boolean;
  /** Valor da caução em centavos. Presente quando `charge_enabled=true`. */
  charge_amount_cents?: number | null;
}

/** Hall público (vindo das RPCs `get_unit_public_full` / `get_widget_public`). */
export interface PublicHall {
  id: string;
  name: string;
  description: string | null;
  /** Quando true, aceita `party_size >= min_capacity - 1` (uma cadeira vazia). */
  allow_empty_seat?: boolean;
  /** MIN(tables.min_capacity) entre mesas ativas do hall. NULL = sem mesas configuradas. */
  min_capacity?: number | null;
  /** MAX(tables.max_capacity) entre mesas ativas do hall. NULL = sem mesas configuradas. */
  max_capacity?: number | null;
  schedules: PublicHallSchedule[];
}

/** Special date pública — vindo das RPCs `get_unit_public_full` / `get_widget_public`.
 *  Range `[date, end_date]` inclusivo. `hall_id != null` = override só naquele salão. */
export interface PublicSpecialDate {
  date: string;
  end_date: string;
  hall_id: string | null;
  name: string;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
  charge_enabled?: boolean;
  charge_amount_cents?: number | null;
}

/** Bloqueio macro (table_blocks com `table_id IS NULL`) exposto pela RPC pública.
 *  Datas já convertidas pro fuso BRT na RPC — usar como YYYY-MM-DD direto. */
export interface PublicBlockedDate {
  date_from: string;
  date_to: string;
  title: string;
  /** Quando não-nulo, bloqueio afeta apenas um salão específico — UI normalmente
   *  ignora pra não bloquear o dia inteiro indevidamente, mas pode mostrar
   *  tooltip informativo. */
  hall_id: string | null;
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
  /** Planta do salão, em cm. Nulas = tamanho padrão. */
  plan_width_cm?: number | null;
  plan_depth_cm?: number | null;
  plan_entrance_wall?: PlanWall | null;
  plan_entrance_offset_cm?: number | null;
  plan_window_walls?: PlanWall[];
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
  applied_discount_percent?: number | null;
  payment_status?: "not_required" | "pending_payment" | "paid" | "failed" | "refunded" | "expired" | null;
  payment_amount_cents?: number | null;
  stripe_checkout_session_id?: string | null;
  stripe_payment_intent_id?: string | null;
  /** Carimbos de presença da planta: chegada e mesa liberada. Não mudam o status. */
  arrived_at?: string | null;
  released_at?: string | null;
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
  contact_name: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  reservation?: Reserva;
}

export type OutboundMessageKind =
  | "confirmation"
  | "reminder_d1"
  | "survey_d1"
  | "cancellation"
  | "voucher_issued"
  | "waitlist_entered"
  | "waitlist_table_ready"
  | "waitlist_feedback";

export type ConversationMessageAuthor = "customer" | "ai" | "automation" | "human";

export interface ConversationMessage {
  /** Identidade idempotente dos writers novos; ausente no histórico legado. */
  event_id?: string;
  role: "user" | "assistant" | "human";
  content: string;
  timestamp: string;
  /** Ausente em mensagens legadas, cuja autoria precisa ser inferida pelo role/kind. */
  author?: ConversationMessageAuthor;
  /** Instante de chegada usado pelo debounce; separado do horário original do provider. */
  received_at?: string;
  human_user_id?: string;
  kind?: OutboundMessageKind;
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
  pending: "bg-status-pending/15 text-status-pending border-status-pending/25",
  confirmed: "bg-status-reserved/15 text-status-reserved border-status-reserved/25",
  cancelled: "bg-destructive/15 text-destructive border-destructive/25",
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
