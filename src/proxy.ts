import { NextResponse, type NextRequest } from "next/server";
import { createLimiter, tooManyRequests, type Limiter } from "@/lib/traffic/policy";
import { clientKey } from "@/lib/traffic/client-identity";
import { recordIdentity, sharedTrafficState } from "@/lib/traffic/health";
import { holdDecision, refusalDelayMs } from "@/lib/traffic/hold";
import { indexingEnabled, NOINDEX_HEADER } from "@/lib/indexing";

/**
 * Traffic protection (docs/TRAFFIC.md). Runs before any page or route renders, so a refused request
 * costs no database work, no data access and no render: only a hash-map lookup.
 *
 * One limiter per server process. The limiter lives in process memory, which is correct for the
 * single-server deployment; with several servers each would count separately (see the doc).
 *
 * On Vercel (docs/VERCEL.md, *Traffic protection*) each function instance has its own limiter, the
 * client identity is the platform-set `x-vercel-forwarded-for` (src/lib/traffic/client-identity.ts)
 * and refusals are answered immediately (src/lib/traffic/hold.ts). Limits then hold per instance:
 * a single abusive address is still refused, while a distributed flood is bounded by Vercel's
 * free-tier caps (which pause, never bill) and its included DDoS mitigation.
 */
const KEY = Symbol.for("prospect-terminal.rate-limiter");
const g = globalThis as typeof globalThis & { [KEY]?: { limiter: Limiter; loggedAt: number; warnedAt: number } };

function state() {
  return (g[KEY] ??= { limiter: createLimiter(), loggedAt: Date.now(), warnedAt: 0 });
}

/** Refusals currently being held (see src/lib/traffic/hold.ts for why and the bounds). */
const heldByClient = new Map<string, number>();
let heldTotal = 0;
export const REFUSAL_DELAY_MS = refusalDelayMs();

async function refuse(response: Response, key: string | null) {
  if (REFUSAL_DELAY_MS === 0 || holdDecision(heldByClient, key, heldTotal) === "immediate") return response;
  heldTotal++;
  if (key) heldByClient.set(key, (heldByClient.get(key) ?? 0) + 1);
  try {
    await new Promise((r) => setTimeout(r, REFUSAL_DELAY_MS));
  } finally {
    heldTotal--;
    if (key) {
      const n = (heldByClient.get(key) ?? 1) - 1;
      if (n > 0) heldByClient.set(key, n);
      else heldByClient.delete(key);
    }
  }
  return response;
}

/** For tests and diagnostics. */
export const heldRefusals = () => ({ total: heldTotal, clients: heldByClient.size });

export async function proxy(request: NextRequest) {
  const response = await decide(request);
  // Non-public deployment (PT_INDEXING=off, e.g. staging): every response says noindex.
  if (!indexingEnabled()) response.headers.set("X-Robots-Tag", NOINDEX_HEADER);
  return response;
}

async function decide(request: NextRequest): Promise<Response> {
  const s = state();
  const key = clientKey(request.headers, s.limiter.identity);
  // Proxied requests without a valid identity mean Caddy's header_up is missing: /health reports it.
  recordIdentity(sharedTrafficState(), request.headers, key !== null);
  const decision = s.limiter.decide(request.nextUrl.pathname, request.headers);
  if (decision.action === "allow" && decision.reason === "no-identity" && process.env.NODE_ENV === "production" && Date.now() - s.warnedAt >= 600_000) {
    s.warnedAt = Date.now();
    const id = s.limiter.identity;
    console.error(
      "reason" in id
        ? `[traffic] PT_CLIENT_IP_HEADER is ${id.reason}; per-client rate limiting is OFF`
        : `[traffic] requests arrive without a valid ${id.header} header; per-client rate limiting is OFF (check the Caddy header_up line)`,
    );
  }
  // At most one summary line a minute, only when something was refused. Never logs addresses.
  if (Date.now() - s.loggedAt >= 60_000) {
    s.loggedAt = Date.now();
    const { rejected, shed, keys } = s.limiter.stats();
    const total = rejected.profile + rejected.page + rejected.prefetch;
    if (total)
      console.error(
        `[traffic] refused ${total} requests in the last minute (profile ${rejected.profile} of which ${shed} for server overload, page ${rejected.page}, prefetch ${rejected.prefetch}); tracked clients ${keys.profile}/${keys.page}/${keys.prefetch}`,
      );
  }
  if (decision.action === "reject") return refuse(tooManyRequests(decision.result), key);
  return NextResponse.next();
}

export const config = {
  // Everything except build assets (hashed, immutable, served without rendering), the image
  // optimizer and Vercel's own endpoints (Web Analytics script and beacons under /_vercel/), which
  // never render a page and on Vercel would otherwise each cost a proxy invocation.
  matcher: ["/((?!_next/static/|_next/image|_vercel/).*)"],
};
