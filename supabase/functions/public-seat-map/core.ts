// Núcleo da EF pública public-seat-map: valida o pedido, aplica o rate-limit,
// resolve a unidade pelo próprio recurso (unidade pública ou link) e devolve o
// mapa de mesas sem PII. Dependências injetadas (I/O fica no index.ts).
import type { AvailabilityReason, SeatMap } from "../_shared/availability.ts";
import { hashSeatLinkToken, isSeatLinkToken } from "../_shared/seat-link-core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export interface SeatMapLink {
  unitId: string;
  hallId: string;
  channelId: string | null;
  date: string;
  time: string;
  partySize: number;
  expiresAt: string;
}

export interface SeatMapDeps {
  /** Unidade e organização públicas; null = não pública ou inexistente. Lança em erro de leitura. */
  publicUnit: (unitId: string) => Promise<{ name: string; billingStatus: string | null } | null>;
  /** true = dentro do limite. `unitId` nulo = balde do modo token (antes de ler o link). Lança em erro. */
  rateLimit: (unitId: string | null) => Promise<boolean>;
  /** Link pelo hash do token; null = inexistente. Lança em erro de leitura. */
  link: (tokenHash: string) => Promise<SeatMapLink | null>;
  seatMap: (args: { unitId: string; hallId: string; date: string; time: string; partySize: number }) => Promise<SeatMap | { error: AvailabilityReason }>;
  /** Número do canal do link, já em E.164, filtrado pela unidade; null sem número. */
  channelPhone: (channelId: string, unitId: string) => Promise<string | null>;
  now: () => Date;
  /** Diagnóstico do 503 (só código/etapa no log, nunca o texto do Postgres). */
  onError?: (err: unknown) => void;
}

export type SeatMapResponse =
  | {
      ok: true;
      unit: { name: string };
      hall_id: string;
      date: string;
      time: string;
      party_size: number;
      map: SeatMap;
      whatsapp_phone: string | null;
    }
  | { ok: false; reason: string };

type Out = { status: number; json: SeatMapResponse };

const fail = (status: number, reason: string): Out => ({ status, json: { ok: false, reason } });

function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

type Request = { unitId: string; hallId: string; date: string; time: string; partySize: number };

function parseParams(b: Record<string, unknown>): Request | null {
  if (typeof b.unit_id !== "string" || !UUID.test(b.unit_id)) return null;
  if (typeof b.hall_id !== "string" || !UUID.test(b.hall_id)) return null;
  if (typeof b.date !== "string" || !validDate(b.date)) return null;
  if (typeof b.time !== "string" || !TIME.test(b.time)) return null;
  if (!Number.isInteger(b.party_size) || (b.party_size as number) < 1 || (b.party_size as number) > 30) return null;
  return { unitId: b.unit_id, hallId: b.hall_id, date: b.date, time: b.time.slice(0, 5), partySize: b.party_size as number };
}

async function unitOk(deps: SeatMapDeps, unitId: string): Promise<{ name: string } | null> {
  const unit = await deps.publicUnit(unitId);
  if (!unit) return null;
  if (unit.billingStatus === "blocked" || unit.billingStatus === "suspended") return null;
  return { name: unit.name };
}

async function respond(deps: SeatMapDeps, req: Request, unitName: string, whatsappPhone: string | null): Promise<Out> {
  const map = await deps.seatMap(req);
  if ("error" in map) return fail(200, map.error);
  return {
    status: 200,
    json: {
      ok: true,
      unit: { name: unitName },
      hall_id: req.hallId,
      date: req.date,
      time: req.time,
      party_size: req.partySize,
      map: { hall: map.hall, tables: map.tables, options: map.options },
      whatsapp_phone: whatsappPhone,
    },
  };
}

export async function handleSeatMap(body: unknown, deps: SeatMapDeps): Promise<Out> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_input");
  const b = body as Record<string, unknown>;

  try {
    // ── Modo token (link do WhatsApp) ──────────────────────────────────────
    if ("token" in b) {
      if (typeof b.token !== "string") return fail(400, "invalid_input");
      // Rate-limit antes de qualquer leitura: tentativa de token conta igual.
      if ((await deps.rateLimit(null)) !== true) return fail(429, "rate_limited");
      // Formato inválido, inexistente, expirado e unidade fora do ar: mesma resposta.
      if (!isSeatLinkToken(b.token)) return fail(200, "link_invalid");
      const link = await deps.link(await hashSeatLinkToken(b.token));
      if (!link || !(new Date(link.expiresAt).getTime() > deps.now().getTime())) return fail(200, "link_invalid");
      const unit = await unitOk(deps, link.unitId);
      if (!unit) return fail(200, "link_invalid");
      let phone: string | null = null;
      if (link.channelId) {
        try { phone = await deps.channelPhone(link.channelId, link.unitId); }
        catch { phone = null; }
      }
      return await respond(deps, {
        unitId: link.unitId,
        hallId: link.hallId,
        date: link.date,
        time: link.time.slice(0, 5),
        partySize: link.partySize,
      }, unit.name, phone);
    }

    // ── Modo parâmetros (página online) ────────────────────────────────────
    const req = parseParams(b);
    if (!req) return fail(400, "invalid_input");
    // Balde global do IP (o mesmo do modo token) antes de qualquer leitura:
    // trocar o unit_id a cada chamada não multiplica o limite. O balde da
    // unidade só conta unidade pública real (unit_id inventado não grava linha).
    if ((await deps.rateLimit(null)) !== true) return fail(429, "rate_limited");
    const unit = await unitOk(deps, req.unitId);
    if (!unit) return fail(200, "unit_invalid");
    if ((await deps.rateLimit(req.unitId)) !== true) return fail(429, "rate_limited");
    return await respond(deps, req, unit.name, null);
  } catch (err) {
    deps.onError?.(err);
    return fail(503, "dependency_unavailable");
  }
}
