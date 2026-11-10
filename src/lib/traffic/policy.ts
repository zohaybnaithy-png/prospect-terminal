import { TokenBuckets, type BucketConfig, type TakeResult } from "./token-bucket";
import { clientKey, identityConfig, type IdentityConfig } from "./client-identity";

/**
 * Per-client request budgets, by cost class. Measured on a production build with a MiLB-scale data
 * set (docs/TRAFFIC.md): a full player-profile render is ~65 ms of server time and ~155 kB; other
 * pages ~10–20 ms; a router prefetch only renders the shell (~5–15 ms, ~1 kB) and never computes a
 * profile, so it has its own, larger budget and never spends profile tokens.
 *
 * Budgets are deliberately generous so that several people behind one shared address (office,
 * campus, mobile carrier NAT) never notice them: one page view in the app issues 50–65 prefetches,
 * and a person reads a profile in far more than one second. They stop one client from issuing
 * hundreds of expensive renders per second, which is what saturates the single server.
 */
export type TrafficClass = "profile" | "page" | "prefetch";

export const LIMITS: Record<TrafficClass, BucketConfig> = {
  // Full profile renders (document or client navigation): 120 at once, then 6 per second. Generous
  // on purpose: one address can be a whole office or campus (50 people each opening a profile every
  // 10 s = 5/s). Total server load is bounded by the server-wide budget below, not by this.
  profile: { capacity: 120, refillPerSec: 6, maxKeys: 20_000 },
  // Every other page render, Trends data, image optimization: 240 at once, then 8 per second.
  page: { capacity: 240, refillPerSec: 8, maxKeys: 20_000 },
  // Router prefetches (shell only): 400 at once, then 15 per second (a page view every ~4 s).
  prefetch: { capacity: 400, refillPerSec: 15, maxKeys: 20_000 },
};

/**
 * Overload shedding for profiles (the expensive class). Per-client limits cannot see many addresses
 * that each stay under their own limit (measured: 64 addresses at ~0.25 profiles/s each saturate
 * the server and slow every visitor 50×). So profile renders also draw on one server-wide budget
 * set below measured capacity (~16 renders/s per process). When it is exhausted, a profile request
 * is still served if its client has used little recently (`fairShare`: 10 profiles, one more every
 * 10 s, spent on every profile request); only clients pulling profiles continuously are refused,
 * and only while the server is over budget. A person reading a profile every 10 s never runs out.
 * Fair-share admissions draw on a capped server-wide overflow (`fairShareOverflow`), so however
 * many addresses take part, admitted renders never exceed global + overflow.
 */
export const OVERLOAD = {
  // 6 renders/s ≈ 40% of one process (a render is ~65 ms): leaves room for readers served on their
  // fair share, every other page, and the refusals themselves. Tunable: PT_PROFILE_BUDGET_RPS.
  global: { capacity: 12, refillPerSec: 6, maxKeys: 1 } satisfies BucketConfig,
  fairShare: { capacity: 10, refillPerSec: 1 / 10, maxKeys: 20_000 } satisfies BucketConfig,
  // Hard bound on fair-share admissions server-wide. Without it, N addresses add N/30 renders/s and
  // a first wave of up to 10 × N (measured before this cap: 1,000 addresses → 100/s in the first
  // minute and 37/s steady against ~16/s of capacity). With it, admitted profile renders never exceed
  // global + overflow (6 + 4 = 10/s, bursts 12 + 8) however many addresses take part. Tradeoff: in
  // a very large attack, readers compete for these 4/s and may get a 429 with Retry-After instead
  // of a server that is slow for everyone.
  fairShareOverflow: { capacity: 8, refillPerSec: 4, maxKeys: 1 } satisfies BucketConfig,
};

/** Fair-share tokens a client must still hold (after this request) to use the shared overflow: half. */
export const fairReserve = (capacity: number) => capacity - 2;

/** `PT_PROFILE_BUDGET_RPS` (1–100) replaces the server-wide profile budget, e.g. on a larger host. */
export function overloadFromEnv(env: Record<string, string | undefined>): typeof OVERLOAD {
  const rps = Number(env.PT_PROFILE_BUDGET_RPS);
  if (!env.PT_PROFILE_BUDGET_RPS || !Number.isFinite(rps) || rps < 1 || rps > 100) return OVERLOAD;
  return { ...OVERLOAD, global: { capacity: Math.ceil(rps * 2), refillPerSec: rps, maxKeys: 1 } };
}

/** Never limited: uptime monitors, crawl policy, the app's own static assets. */
const EXEMPT = [/^\/health$/, /^\/robots\.txt$/, /^\/sitemap\.xml$/, /^\/icon\.png$/, /^\/favicon\.ico$/, /^\/_next\/static\//];

const PROFILE = /^\/players\/[^/]+\/?$/;

export function classify(pathname: string, headers: Headers): TrafficClass | null {
  if (EXEMPT.some((r) => r.test(pathname))) return null;
  // Next's router marks prefetches; a forged header only ever gets the cheap prefetch response,
  // so trusting it for classification cannot unlock an expensive render.
  if (headers.get("next-router-prefetch") === "1") return "prefetch";
  if (PROFILE.test(pathname)) return "profile";
  return "page";
}

export type Decision =
  | { action: "allow"; reason: "exempt" | "no-identity" | "disabled" | "within-limit" | "fair-share"; cls?: TrafficClass; result?: TakeResult }
  | { action: "reject"; cls: TrafficClass; result: TakeResult; reason: "client-limit" | "overload" };

export interface Limiter {
  decide(pathname: string, headers: Headers): Decision;
  readonly identity: IdentityConfig;
  readonly enabled: boolean;
  stats(): { rejected: Record<TrafficClass, number>; shed: number; keys: Record<TrafficClass, number> };
}

export function createLimiter(
  opts: {
    env?: Record<string, string | undefined>;
    now?: () => number;
    limits?: Record<TrafficClass, BucketConfig>;
    overload?: typeof OVERLOAD;
  } = {},
): Limiter {
  const env = opts.env ?? process.env;
  const identity = identityConfig(env);
  const enabled = env.PT_RATE_LIMIT !== "off";
  const limits = opts.limits ?? LIMITS;
  const buckets = {
    profile: new TokenBuckets(limits.profile, opts.now),
    page: new TokenBuckets(limits.page, opts.now),
    prefetch: new TokenBuckets(limits.prefetch, opts.now),
  };
  const overload = opts.overload ?? overloadFromEnv(env);
  const globalProfiles = new TokenBuckets(overload.global, opts.now);
  const fairShare = new TokenBuckets(overload.fairShare, opts.now);
  const fairOverflow = new TokenBuckets(overload.fairShareOverflow, opts.now);
  const rejected: Record<TrafficClass, number> = { profile: 0, page: 0, prefetch: 0 };
  let shed = 0;
  return {
    identity,
    enabled,
    decide(pathname, headers) {
      const cls = classify(pathname, headers);
      if (!cls) return { action: "allow", reason: "exempt" };
      if (!enabled) return { action: "allow", reason: "disabled", cls };
      const key = clientKey(headers, identity);
      // Fail open: without a trustworthy identity, limiting would either be bypassable or lump
      // every visitor into one bucket. The proxy logs this once (see src/proxy.ts).
      if (!key) return { action: "allow", reason: "no-identity", cls };
      const result = buckets[cls].take(key);
      if (!result.ok) {
        rejected[cls]++;
        return { action: "reject", cls, result, reason: "client-limit" };
      }
      if (cls !== "profile") return { action: "allow", reason: "within-limit", cls, result };
      // Fair share is always spent, so recent usage is tracked whether or not the server is busy.
      // "Light" = a client that has used little recently (at least fairReserve of its fair share
      // left after this request): a reader. A continuously pulling address is "heavy" within
      // seconds. Light clients have priority:
      //  - heavy clients may use the server-wide budget only while it is above GLOBAL_RESERVE, so
      //    one crawler (or many) can never take all of it;
      //  - light clients may use all of it, then the capped overflow.
      // Admitted renders never exceed global + overflow, however many addresses take part.
      const fair = fairShare.take(key);
      const light = fair.ok && fair.remaining >= fairReserve(overload.fairShare.capacity);
      const reserve = light ? 0 : Math.floor(overload.global.capacity / 2);
      const global = globalProfiles.available("*") >= reserve + 1 ? globalProfiles.take("*") : null;
      if (global?.ok) return { action: "allow", reason: "within-limit", cls, result };
      if (light) {
        const overflow = fairOverflow.take("*");
        if (overflow.ok) return { action: "allow", reason: "fair-share", cls, result };
      }
      rejected.profile++;
      shed++;
      const wait = Math.max(1, Math.ceil((reserve + 1 - globalProfiles.available("*")) / overload.global.refillPerSec));
      return { action: "reject", cls, result: { ok: false, remaining: 0, retryAfterSec: wait }, reason: "overload" };
    },
    stats() {
      const out = { ...rejected };
      const shedOut = shed;
      rejected.profile = rejected.page = rejected.prefetch = 0;
      shed = 0;
      return {
        rejected: out,
        shed: shedOut,
        keys: { profile: buckets.profile.size, page: buckets.page.size, prefetch: buckets.prefetch.size },
      };
    },
  };
}

/** The 429 response: tiny, uncacheable, built without touching data or rendering anything. */
export function tooManyRequests(result: TakeResult): Response {
  return new Response(
    "Too many requests. Please wait a moment and try again.\n",
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSec),
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": "noindex",
      },
    },
  );
}
