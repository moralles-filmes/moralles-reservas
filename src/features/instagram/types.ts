export type InstagramAccountStatus = "connected" | "reauth_required" | "disconnected";

export interface InstagramAccount {
  username: string | null;
  status: InstagramAccountStatus | null;
  token_expires_at: string | null;
  connected_at: string | null;
  subscribed: boolean;
  last_error_code: string | null;
}

export interface InstagramSettings {
  unit_id: string;
  dm_enabled: boolean;
  updated_at: string | null;
}

export interface InstagramModuleState {
  instagram: { active: boolean; granted_at: string | null };
}

export interface InstagramModuleGrant {
  module: "instagram";
  active: boolean;
  granted_at: string | null;
  revoked_at: string | null;
}

export interface InstagramConnectStart {
  authorize_url: string;
  state: string;
}

export interface InstagramConnectResult {
  unit_slug: string;
  username: string | null;
  subscribed: boolean;
}

export interface InstagramDiagnostics {
  last_event_at: string | null;
  queue: { received: number; processing: number; done_24h: number; dead: number };
  oldest_pending_received_at: string | null;
  outcomes_24h: Record<string, number>;
}

/** Erro de EF com o corpo `{ error, code? }` já extraído. */
export class InstagramApiError extends Error {
  status: number | null;
  code: string | null;
  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = "InstagramApiError";
    this.status = status;
    this.code = code;
  }
}

/** Toda chave começa por ["instagram-<entidade>", unitId]. */
export const instagramKeys = {
  module: (unitId: string) => ["instagram-module", unitId] as const,
  account: (unitId: string) => ["instagram-account", unitId] as const,
  settings: (unitId: string) => ["instagram-settings", unitId] as const,
  diagnostics: (unitId: string) => ["instagram-diagnostics", unitId] as const,
  connection: (unitId: string) => ["instagram-connection", unitId] as const,
};
