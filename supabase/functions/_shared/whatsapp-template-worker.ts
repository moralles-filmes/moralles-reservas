import type { TemplateProvisionJob } from './whatsapp-template-sync.ts';
import type { TemplatePreparationClaim } from './whatsapp-template-preparation.ts';
export interface TemplateWorkerJob extends TemplateProvisionJob { account_id: string; operation: string; }
export interface TemplatePipelineHealth { failed: number; uncertain: number; oldest_age_seconds: number; oldest_id?: string | null; }
export interface TemplatePipelineAlert extends TemplatePipelineHealth { type: 'whatsapp_template_pipeline'; }
export interface TemplateWorkerDependencies {
  authenticate(request: Request): boolean;
  now(): number;
  selectPreparations?(): Promise<TemplatePreparationClaim[]>;
  prepareChannel?(claim: TemplatePreparationClaim): Promise<{ state: 'ready' | 'pending' | 'needs_review' | 'skipped' }>;
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

export { createOpsAlertSender as createTemplateAlertSender } from './ops-alert-sender.ts';

export function createTemplateWorker(deps: TemplateWorkerDependencies) {
  return {
    async handle(request: Request): Promise<Response> {
      if (!deps.authenticate(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      const startedAt = deps.now();
      const deadline = startedAt + 50_000;
      // Cron runs every five minutes. Alternating priority gives both existing
      // jobs and connection recovery a first slot under a sustained backlog.
      const preparationFirst = Math.floor(startedAt / 300_000) % 2 === 0;
      let claims = 0, completed = 0, failures = 0, preparations = 0;
      const prepareOne = async () => {
        // One preparation can perform two independently bounded Datafy GETs.
        // Start it only with room for both; never cancel an in-flight call.
        if (!deps.selectPreparations || !deps.prepareChannel || deps.now() >= deadline - 30_000) return;
        try {
          const due = await deps.selectPreparations();
          const item = due[0];
          if (!item || deps.now() >= deadline - 30_000) return;
          preparations++;
          try {
            const result = await deps.prepareChannel(item);
            if (result.state === 'pending' || result.state === 'needs_review') failures++;
          } catch { failures++; }
        } catch { failures++; }
      };
      try {
        if (preparationFirst) await prepareOne();
        const accounts = await deps.selectAccounts();
        for (const account of accounts) {
          if (claims >= 20 || deps.now() >= deadline) break;
          const currentSync = await deps.requestSync(account.id);
          const pending = await deps.listJobs(account.id);
          // A current GET can settle older queued/expired syncs; old claims cannot
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
        if (!preparationFirst) await prepareOne();
        await deps.purge();
        const health = await deps.health();
        if (failures || health.failed || health.uncertain || health.oldest_age_seconds > TEMPLATE_BACKLOG_ALERT_SECONDS) {
          const alert = await deps.alert({ type: 'whatsapp_template_pipeline', ...health });
          return Response.json({ claims, completed, preparations, failures, health, alert }, { status: 503 });
        }
        return Response.json({ claims, completed, preparations, failures, health });
      } catch { return Response.json({ error: 'template_worker_failed', claims, completed, preparations }, { status: 503 }); }
    },
  };
}
