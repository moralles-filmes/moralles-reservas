export type AlertDelivery = { delivered: boolean; reason?: string };
/** Shared transport; never returns/logs endpoint or upstream response content. */
export function createOpsAlertSender(endpoint: string | undefined, fetchImpl: typeof fetch = fetch) {
  return async (payload: object): Promise<AlertDelivery> => {
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
