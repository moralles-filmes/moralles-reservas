import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createOpsAlertEmailHandler, type OpsEmailDatabase } from './handler.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const db: OpsEmailDatabase = {
  reserve: async (args) => await supabase.rpc('reserve_whatsapp_ops_email_attempt', args),
  complete: async (attemptId, status, providerId) => await supabase.rpc('complete_whatsapp_ops_email_attempt', {
    p_attempt_id: attemptId, p_status: status, p_provider_id: providerId,
  }),
  checkReservationReady: async () => await supabase.rpc('check_whatsapp_ops_email_reservation_ready'),
};

const handle = createOpsAlertEmailHandler({
  db,
  config: {
    token: Deno.env.get('WHATSAPP_OPS_ALERT_TOKEN') ?? null,
    to: Deno.env.get('WHATSAPP_OPS_ALERT_TO') ?? null,
    from: Deno.env.get('RESEND_FROM_EMAIL') ?? null,
    resendKey: Deno.env.get('RESEND_API_KEY') ?? null,
    approvedHmac: Deno.env.get('WHATSAPP_OPS_ALERT_APPROVED_CONFIG_HMAC') ?? null,
  },
  log: (event) => console.log(JSON.stringify({ evt: 'whatsapp_ops_alert_email', ...event })),
});

serve(handle);
