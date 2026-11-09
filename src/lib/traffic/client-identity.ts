import { isIP } from "node:net";

/**
 * Who is the client? In production the app listens on 127.0.0.1 only, so every request arrives
 * from Caddy on the same machine. Caddy is configured to OVERWRITE one dedicated header with the
 * address of the TCP connection it accepted (`header_up X-PT-Client-IP {remote_host}`, see
 * deploy/Caddyfile). A value a client sends in that header is replaced, never appended to, so it
 * cannot be forged from the internet.
 *
 * Deliberately NOT used: X-Forwarded-For, X-Real-IP, Forwarded, CF-Connecting-IP, True-Client-IP.
 * Any client can send those, and proxies append to X-Forwarded-For rather than replace it, so
 * "first entry" or "last entry" logic is only safe with an exact, known proxy chain. One header
 * that one proxy we control always overwrites is the simplest thing that is correct.
 *
 * The header name comes from `PT_CLIENT_IP_HEADER`. When it is unset (development, tests, a
 * misconfigured server) there is no trustworthy identity and the caller must not rate limit per
 * client: guessing would either let spoofed headers through or put every visitor in one bucket.
 */
export const CLIENT_IP_HEADER_ENV = "PT_CLIENT_IP_HEADER";

/** Header names we never accept as the identity source, even if configured by mistake. */
const SPOOFABLE = new Set([
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "fastly-client-ip",
]);

export type IdentityConfig = { header: string } | { header: null; reason: "unset" | "refused" | "invalid" };

export function identityConfig(env: Record<string, string | undefined> = process.env): IdentityConfig {
  const raw = env[CLIENT_IP_HEADER_ENV]?.trim().toLowerCase();
  if (!raw) return { header: null, reason: "unset" };
  if (!/^[a-z0-9-]{1,64}$/.test(raw)) return { header: null, reason: "invalid" };
  if (SPOOFABLE.has(raw)) return { header: null, reason: "refused" };
  return { header: raw };
}

/**
 * The rate-limit key for a request, or null when there is no trustworthy identity.
 * - The header must hold exactly one IP literal (a list, port, or anything else is rejected).
 * - IPv4-mapped IPv6 (::ffff:1.2.3.4) is treated as the IPv4 address.
 * - IPv6 is keyed by its /64 prefix: a single subscriber normally holds a whole /64 and could
 *   otherwise rotate through 2^64 addresses to get a fresh bucket for every request.
 */
export function clientKey(headers: Headers, config: IdentityConfig): string | null {
  if (!config.header) return null;
  const values = headers.get(config.header);
  if (!values) return null;
  const value = values.trim();
  if (value.includes(",")) return null; // more than one value: not set by our proxy alone
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  const ip = mapped ? mapped[1] : value;
  const family = isIP(ip);
  if (family === 4) return `4:${ip}`;
  if (family === 6) return `6:${ipv6Prefix64(ip)}`;
  return null;
}

/** First four 16-bit groups of an IPv6 address, normalized (e.g. 2001:db8:0:0::/64 → 2001:db8:0:0). */
export function ipv6Prefix64(ip: string): string {
  const zone = ip.indexOf("%");
  const addr = (zone >= 0 ? ip.slice(0, zone) : ip).toLowerCase();
  const [head, tail = ""] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = addr.includes("::") ? (tail ? tail.split(":") : []) : [];
  // An embedded IPv4 tail occupies two groups; it never reaches the first four groups that matter
  // here unless the address is mostly zeros, which the zero-fill below handles.
  const tailGroups = t.flatMap((g) => (g.includes(".") ? ["0", "0"] : [g]));
  const groups = addr.includes("::")
    ? [...h, ...Array(Math.max(0, 8 - h.length - tailGroups.length)).fill("0"), ...tailGroups]
    : h.flatMap((g) => (g.includes(".") ? ["0", "0"] : [g]));
  return groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(":");
}
