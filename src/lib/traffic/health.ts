import { identityConfig } from "./client-identity";
import { siteOrigin } from "@/lib/site-url";

/**
 * Is traffic protection actually on? Rate limiting deliberately fails open when there is no
 * trustworthy client identity (limiting on a guess is either spoofable or one bucket for everyone).
 * That must never happen silently in production, so `/health` reports it, and a production server
 * whose protection is not in place is NOT healthy (503 "misconfigured"): deploy.sh's health gate
 * then refuses (and rolls back) the release, and the uptime monitor alerts.
 *
 * Two failure modes are detected:
 * 1. Configuration: `PT_CLIENT_IP_HEADER` unset, invalid or a client-controlled header, or
 *    `PT_SITE_URL` unset/invalid (canonical URLs would point at localhost). An explicit
 *    `PT_RATE_LIMIT=off` is reported as "disabled", not as an error.
 * 2. Runtime: a request that came THROUGH a proxy (X-Forwarded-For names a non-loopback client;
 *    see isProxied) but lacks a valid identity header means Caddy's `header_up` line is missing.
 *    Direct local requests (deploy health checks, an operator's curl to 127.0.0.1:3000) do not count.
 *    One such request marks the server misconfigured for 10 minutes.
 *
 * Development (NODE_ENV != production) never fails on this.
 */
export const UNIDENTIFIED_WINDOW_MS = 10 * 60_000;

export interface TrafficState {
  lastProxiedUnidentifiedAt: number | null;
  proxiedUnidentified: number;
}

export const trafficState = (): TrafficState => ({ lastProxiedUnidentifiedAt: null, proxiedUnidentified: 0 });

const KEY = Symbol.for("prospect-terminal.traffic-state");
/** One state per process, shared by the proxy and the /health route (separate bundles). */
export function sharedTrafficState(): TrafficState {
  const g = globalThis as typeof globalThis & { [KEY]?: TrafficState };
  return (g[KEY] ??= trafficState());
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Did the request come through a proxy? Caddy sets X-Forwarded-For to the real client. Next.js
 * fills the header in itself for direct requests (`x-forwarded-for ??= socket.remoteAddress`,
 * next/dist/server/base-server.js), so a direct local request carries the loopback address: only a
 * non-loopback first entry means "proxied". (Detection only; never used as an identity.)
 */
export function isProxied(headers: Headers): boolean {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return !!first && !LOOPBACK.has(first);
}

export function recordIdentity(state: TrafficState, headers: Headers, identified: boolean, now = Date.now()) {
  if (identified || !isProxied(headers)) return;
  state.lastProxiedUnidentifiedAt = now;
  state.proxiedUnidentified++;
}

export type TrafficHealthStatus = "protected" | "disabled" | "misconfigured" | "development";

export function trafficHealth(
  env: Record<string, string | undefined>,
  state: TrafficState,
  now = Date.now(),
): { status: TrafficHealthStatus; reason?: string } {
  if (env.NODE_ENV !== "production") return { status: "development" };
  if (!siteOrigin(env)) return { status: "misconfigured", reason: "PT_SITE_URL is unset or not a bare http(s) origin" };
  if (env.PT_RATE_LIMIT === "off") return { status: "disabled", reason: "PT_RATE_LIMIT=off" };
  const id = identityConfig(env);
  if ("reason" in id) return { status: "misconfigured", reason: `PT_CLIENT_IP_HEADER is ${id.reason}` };
  if (state.lastProxiedUnidentifiedAt !== null && now - state.lastProxiedUnidentifiedAt <= UNIDENTIFIED_WINDOW_MS)
    return {
      status: "misconfigured",
      reason: `proxied requests arrive without the ${id.header} header (check Caddy's header_up line)`,
    };
  return { status: "protected" };
}

/** Production health must fail when protection is misconfigured. */
export const trafficBlocksHealth = (s: TrafficHealthStatus) => s === "misconfigured";
