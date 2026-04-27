// fetch com retries e exponential backoff.
// Retenta em 5xx, 429 e erros de rede (TypeError do fetch).

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  retryOn?: (status: number) => boolean;
}

const DEFAULT_RETRY_ON = (status: number) => status >= 500 || status === 429;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_ON;

  let lastResponse: Response | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!retryOn(res.status) || attempt === retries) {
        return res;
      }
      lastResponse = res;
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
    }

    const jitter = Math.random() * baseDelay;
    const delay = baseDelay * Math.pow(2, attempt) + jitter;
    await sleep(delay);
  }

  if (lastResponse) return lastResponse;
  throw lastError ?? new Error("fetchWithRetry: esgotou retries sem resposta");
}
