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

export async function ipRateKey(headers: Headers): Promise<string | null> {
  const ip = trustedClientIp(headers);
  if (!ip) return null;
  const bytes = new TextEncoder().encode(`public-waitlist:ip:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `public-waitlist-ip:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
