import type { TemplateProvisionJob } from './whatsapp-template-sync.ts';
export interface TemplateWorkerJob extends TemplateProvisionJob { account_id: string; operation: string; }
export interface TemplatePipelineHealth { failed: number; uncertain: number; oldest_age_seconds: number; oldest_id?: string | null; }
export interface TemplatePipelineAlert extends TemplatePipelineHealth { type: 'whatsapp_template_pipeline'; }
export interface TemplateWorkerDependencies {
  authenticate(request: Request): boolean;
  now(): number;
  selectAccounts(): Promise<{ id: string }[]>;
  requestSync(accountId: string): Promise<string | null>;
  listJobs(accountId: string): Promise<{ id: string }[]>;
  claim(jobId: string): Promise<TemplateWorkerJob | null>;
  sync(accountId: string): Promise<{ state: string; processed: number; reason?: string }>;
  provision(accountId: string, job: TemplateProvisionJob): Promise<{ state: string; processed: number }>;
  complete(job: TemplateWorkerJob, success: boolean, reason: string): Promise<boolean>;
  purge(): Promise<unknown>;
  health(): Promise<TemplatePipelineHealth>;
  alert(payload: TemplatePipelineAlert): Promise<{ delivered: boolean; reason?: string }>;
}

/** Backoff ladder 85min plus five cron intervals and five leases; a generous stall signal. */
export const TEMPLATE_BACKLOG_ALERT_SECONDS = (1 + 4 + 16 + 64 + 5 * 5) * 60 + 5 * 90;

export function createTemplateAlertSender(endpoint: string | undefined, fetchImpl: typeof fetch = fetch) {
  return async (payload: TemplatePipelineAlert): Promise<{ delivered: boolean; reason?: string }> => {
    if (!endpoint) return { delivered: false, reason: 'unconfigured' };
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) return { delivered: false, reason: 'unconfigured' };
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return response.ok ? { delivered: true } : { delivered: false, reason: 'delivery_failed' };
    } catch { return { delivered: false, reason: 'delivery_failed' }; }
  };
}

export function createTemplateWorker(deps: TemplateWorkerDependencies) {
  return {
    async handle(request: Request): Promise<Response> {
      if (!deps.authenticate(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      const deadline = deps.now() + 50_000;
      let claims = 0, completed = 0, failures = 0;
      try {
        const accounts = await deps.selectAccounts();
        for (const account of accounts) {
          if (claims >= 20 || deps.now() >= deadline) break;
          const currentSync = await deps.requestSync(account.id);
          const pending = await deps.listJobs(account.id);
          // A current GET can settle older queued revisions; old claims cannot
          // impersonate the newest revision and must not starve it.
          const jobs = currentSync ? [{ id: currentSync }, ...pending.filter(j => j.id !== currentSync)] : pending;
          for (const item of jobs) {
            if (claims >= 20 || deps.now() >= deadline) break;
            claims++;
            const job = await deps.claim(item.id);
            if (!job) continue;
            try {
              if (job.operation === 'provision') {
                const result = await deps.provision(job.account_id, job);
                if (['failed', 'stale', 'conflict'].includes(result.state)) failures++;
              } else {
                const result = await deps.sync(job.account_id);
                const success = result.state === 'synced';
                const reason = success ? 'template_synced' : result.reason ?? 'template_get_failed';
                if (!await deps.complete(job, success, reason) || !success) failures++;
              }
              completed++;
            } catch {
              failures++;
              if (job.operation !== 'provision') await deps.complete(job, false, 'template_get_failed');
            }
          }
        }
        await deps.purge();
        const health = await deps.health();
        if (failures || health.failed || health.uncertain || health.oldest_age_seconds > TEMPLATE_BACKLOG_ALERT_SECONDS) {
          const alert = await deps.alert({ type: 'whatsapp_template_pipeline', ...health });
          return Response.json({ claims, completed, failures, health, alert }, { status: 503 });
        }
        return Response.json({ claims, completed, failures, health });
      } catch { return Response.json({ error: 'template_worker_failed', claims, completed }, { status: 503 }); }
    },
  };
}
