import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireInternalAuth } from '../_shared/security.ts';
import { runAutomationWork } from '../_shared/whatsapp-automation-worker-core.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error('automation_worker_dependency_unavailable');
  return data;
};
serve(async req => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (!requireInternalAuth(req)) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return json({ error: 'invalid_body' }, 400);
  const deadline = Date.now() + 50_000;
  try {
    const work = await runAutomationWork({
      now: Date.now,
      select: () => rpc('maintain_and_select_whatsapp_automation_work', { p_limit: 20 }),
      claimExpiredPosting: jobId => rpc('claim_whatsapp_automation', { p_job_id: jobId }),
      repair: jobId => rpc('reconcile_whatsapp_automation_receipts', { p_job_id: jobId, p_limit: 20 }),
      dispatchExisting: async jobId => {
        // One internal hop, no retry or abort: the real dispatcher must finish its POST classification.
        const response = await fetch(`${url}/functions/v1/send-scheduled-whatsapp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': Deno.env.get('INTERNAL_API_KEY') ?? '' },
          body: JSON.stringify({ action: 'dispatch_existing', job_id: jobId }),
        });
        if (!response.ok) throw new Error('automation_dispatch_unavailable');
        const result: unknown = await response.json();
        // The dispatcher reports a failed ledger lookup with HTTP200 and this closed result.
        if (result !== null && typeof result === 'object' && 'state' in result && result.state === 'not_enqueued'
          && 'reason' in result && result.reason === 'dependency_unavailable') throw new Error('automation_dispatch_unavailable');
      },
    }, deadline);
    const retention = await rpc('purge_whatsapp_automation_workers', { p_receipt_limit: 500, p_job_limit: 20 });
    return json({ work, retention });
  } catch { return json({ error: 'automation_worker_dependency_unavailable' }, 503); }
});
