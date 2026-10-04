// Existing Deno runtime wiring; decisions live in the import-safe factory.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendOutbound, tryGetWhatsAppProvider } from "./whatsapp-providers.ts";
import { jsonLog } from "./security.ts";
import {
  clearWhatsAppGateCache,
  resolveWhatsAppGateByUnit,
} from "./whatsapp-service-gate.ts";
import { resolveChannelCredentials } from "./whatsapp-channel-credentials.ts";
import {
  type ChannelDatabase,
  type ChannelReadQuery,
  createWhatsAppChannelService,
} from "./whatsapp-channel-service.ts";

export interface SendMessagePayload {
  phone: string;
  message: string;
  channel_id?: string;
  unit_id?: string;
}
export type { SendResult } from "./whatsapp-providers.ts";
export type {
  ScheduledChannel,
  ScheduledChannelPins,
  ScheduledChannelResult,
} from "./whatsapp-channel-service.ts";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
// Delegate the actual builder without altering its predicates. Unknown result
// data avoids pretending SDK array SELECT and singular SELECT have one shape.
const db: ChannelDatabase = {
  from(table) {
    return {
      select(columns, options) {
        let actual = supabase.from(table).select(columns, options);
        const query: ChannelReadQuery = {
          eq(key, value) {
            actual = actual.eq(key, value);
            return query;
          },
          is(key, value) {
            actual = actual.is(key, value);
            return query;
          },
          order(key, options) {
            actual = actual.order(key, options);
            return query;
          },
          limit(count) {
            actual = actual.limit(count);
            return query;
          },
          maybeSingle: () => actual.maybeSingle(),
          then: (fulfilled, rejected) =>
            Promise.resolve(actual).then(fulfilled, rejected),
        };
        return query;
      },
    };
  },
  rpc: (name, args) => supabase.rpc(name, args),
};
const service = createWhatsAppChannelService({
  db,
  resolveCredentials: (_db, channel) => {
    const adapter = tryGetWhatsAppProvider(channel.provider);
    if (!adapter) return Promise.resolve({ ...channel.credentials });
    return resolveChannelCredentials(supabase, {
      ...channel,
      provider: adapter.name,
    });
  },
  resolveServiceGate: (_db, unitId) =>
    resolveWhatsAppGateByUnit(supabase, unitId),
  clearServiceGateCache: clearWhatsAppGateCache,
  getProvider: tryGetWhatsAppProvider,
  sendOutbound,
  now: Date.now,
  log: jsonLog,
});
export const {
  sendWhatsApp,
  clearChannelConnectivityCache,
  resolveScheduledChannel,
  prepareScheduledChannel,
} = service;
