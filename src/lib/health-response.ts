import { identityConfig } from "@/lib/traffic/client-identity";
import type { HealthReport } from "@/services/competition/health";
import type { TrafficHealthStatus } from "@/lib/traffic/health";
import { trafficBlocksHealth } from "@/lib/traffic/health";
import { healthHttpStatus } from "@/services/competition/health";

/**
 * What /health tells whom. The endpoint is public: Caddy proxies it in production, and the staging
 * site exempts it from basic auth so external uptime checks work. Through the proxy it therefore
 * answers only `{"status":"ready"}` (200) or `{"status":"unavailable"}` (503). The HTTP status is all
 * a deploy gate or an uptime check needs. Nothing else goes out: no memory or uptime figures, no
 * configuration reasons (environment or header names), no per-level or database state, and not
 * whether traffic protection is switched off.
 *
 * The full report is for a **direct local request** only: the deploy health gate and the monitor
 * call `http://127.0.0.1:3000/health` on the same host (the app listens on 127.0.0.1 only). A
 * request counts as local only if nothing marks it as proxied:
 * - X-Forwarded-For is absent or loopback. Next.js fills it with the socket address for direct
 *   requests, and Caddy sets it to the real client;
 * - the client-identity header (the default `x-pt-client-ip` and any configured name) is absent or
 *   a single loopback address. Caddy OVERWRITES it with the connection's address on every proxied
 *   request, so a client cannot forge a loopback value through it;
 * - no `Forwarded` or `X-Real-IP` header.
 * Two independent signals therefore have to agree. A forged X-Forwarded-For alone unlocks nothing.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_IDENTITY_HEADER = "x-pt-client-ip";

export function isLocalHealthRequest(headers: Headers, env: Record<string, string | undefined>): boolean {
  if (headers.has("forwarded") || headers.has("x-real-ip")) return false;
  const xff = headers.get("x-forwarded-for");
  if (xff !== null && !xff.split(",").every((v) => LOOPBACK.has(v.trim()))) return false;
  const names = new Set([DEFAULT_IDENTITY_HEADER]);
  const id = identityConfig(env);
  if (id.header) names.add(id.header);
  for (const name of names) {
    const v = headers.get(name);
    if (v !== null && !LOOPBACK.has(v.trim())) return false;
  }
  return true;
}

export interface HealthExtras {
  indexing: "on" | "off";
  process: { uptimeSeconds: number; rssMB: number; heapUsedMB: number; heapLimitMB: number };
}

export function buildHealthResponse(
  report: HealthReport,
  traffic: { status: TrafficHealthStatus; reason?: string },
  extras: HealthExtras,
  local: boolean,
): { status: 200 | 503; body: Record<string, unknown> } {
  const blocked = trafficBlocksHealth(traffic.status);
  const status = healthHttpStatus(report) === 200 && !blocked ? 200 : 503;
  if (!local) return { status, body: { status: status === 200 ? "ready" : "unavailable" } };
  return {
    status,
    body: {
      ...report,
      ...(blocked && report.status === "ready" ? { status: "misconfigured" } : {}),
      traffic,
      ...extras,
    },
  };
}
