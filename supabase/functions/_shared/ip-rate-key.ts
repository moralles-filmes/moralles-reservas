/**
 * Hosted Supabase traffic enters through Cloudflare. Its CF-Connecting-IP is
 * the gateway's visitor address; X-Forwarded-For may preserve caller input.
 * There is deliberately no fallback if the gateway header is unavailable.
 */
export function trustedClientIp(headers: Headers): string | null {
  const value = headers.get("cf-connecting-ip");
  if (!value || value !== value.trim() || value.length > 64 || value.includes(",")) return null;

  // Canonicalize IPv4 so syntactic aliases cannot split a bucket.
  if (/^[0-9.]+$/.test(value)) {
    const octets = value.split(".");
    if (octets.length !== 4 || octets.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
    return octets.map(Number).join(".");
  }

  // URL's IPv6 parser rejects malformed, zone-scoped and comma-joined values.
  if (!value.includes(":")) return null;
  try {
    const host = new URL(`http://[${value}]/`).hostname;
    return host.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Chave de rate-limit por IP de uma EF pública: `<scope>-ip:<sha256 hex>` do
 * texto `<scope>:ip:<ip>`. O `scope` separa os baldes de cada função e é o
 * prefixo que a RPC de rate-limit dela exige (ex.: `public-seat-map`).
 */
export async function ipRateKeyFor(headers: Headers, scope: string): Promise<string | null> {
  const ip = trustedClientIp(headers);
  if (!ip) return null;
  const bytes = new TextEncoder().encode(`${scope}:ip:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${scope}-ip:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
