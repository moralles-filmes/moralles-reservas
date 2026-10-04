import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createPreferencesHandler, type PreferenceView } from '../_shared/whatsapp-message-preferences-handler.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {auth:{persistSession:false,autoRefreshToken:false}});
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const {data,error} = await supabase.rpc(name,args);
  if (error) throw new Error('preference_unavailable');
  return data as T;
}
// Exact configured web origins only; absent configuration closes public mutation.
const allowedOrigins = (Deno.env.get('WHATSAPP_PREFERENCE_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
});
Deno.serve(createPreferencesHandler({
  allowedOrigins,
  lookup: hash => rpc<PreferenceView | null>('lookup_whatsapp_preference_token',{p_token_hash:hash}),
  optOut: hash => rpc<boolean>('revoke_whatsapp_promotion',{p_token_hash:hash}),
  rateGate: hash => rpc<boolean>('check_whatsapp_preference_rate',{p_bucket_hash:hash,p_limit:30,p_window_seconds:60}),
}));
