/**
 * CDN caching of public pages on Vercel (docs/VERCEL.md, *CDN caching*). Imported by
 * next.config.ts, so this file has no imports and no `@/` paths.
 *
 * Every public page is rendered per request (`connection()`, `searchParams`), so Next.js sends
 * `Cache-Control: private, no-store` and, by default, every page view and every navigation runs a
 * function. With a build-time snapshot (`PT_DATA_SOURCE=snapshot`), a page's content depends only
 * on its URL and the deployment, which makes it safe for a shared cache:
 *
 * - The header used is `Vercel-CDN-Cache-Control`. Per Vercel's documentation only Vercel's CDN
 *   acts on it, so browsers and any other proxy keep Next.js's `Cache-Control: private, no-store`
 *   (no browser caching; no other shared cache). Next.js never sets or overrides it (checked
 *   against `next start`; Vercel's behaviour is confirmed on a preview, docs/VERCEL.md).
 * - Vercel scopes its CDN cache to a deployment, so a new deployment (= new data) starts empty.
 * - `max-age` is short (5 minutes) and `stale-while-revalidate` long: visitors almost always get a
 *   cached page, a page is re-rendered at most about every 5 minutes per URL and region, and an
 *   unexpected bad render (e.g. a level shown as "temporarily unavailable" after a failed load)
 *   is replaced within minutes instead of being pinned for hours.
 * - Status codes: next.config `headers()` cannot condition on the status, so the rule applies to
 *   every response of a listed route. Vercel documents that its CDN caches only GET/HEAD responses
 *   with cacheable statuses (200, 404, redirects; never 5xx). Answers that depend on data state
 *   override the rule with `no-store`: the proxy's 429 (src/lib/traffic/policy.ts) and
 *   `/trends/data`'s 503/404 (both measured to win over the rule, scripts/cdn-cache.e2e.ts). A
 *   404 for an unknown player and a 400 for malformed parameters are deterministic per
 *   deployment, so caching them is correct.
 * - Only plain document/data requests are cached; React Server Component (RSC) router requests
 *   never are. RSC payloads and HTML share a pathname. Next.js normally keeps them apart by
 *   validating the router's `_rsc` cache-key parameter against the router headers (a mismatch
 *   gets a 307), but it skips that validation in minimal mode, which is how Vercel runs it
 *   (next/dist/server/base-server.js). So a forged RSC request carrying a real `_rsc` value
 *   could store a wrong payload under a key that real visitors use. The rule therefore requires
 *   the absence of the `RSC` header, of every router header and of the `_rsc` parameter:
 *     - an RSC request is never cached (whatever its `_rsc`);
 *     - an HTML request with an `_rsc` parameter is not cached either, so HTML can never sit
 *       under a router URL;
 *     - a plain request (no router headers, no `_rsc`) is HTML (or JSON for `/trends/data`), and
 *       router requests always carry `_rsc`, so cached HTML is never served to the router even
 *       if a CDN ignored `Vary`.
 *   Cost: client-side navigations (one RSC request per click; prefetching is off) always reach a
 *   function. Tested with Next.js's own `has`/`missing` matcher (scripts/vercel.test.ts) and
 *   against a built server (scripts/cdn-cache.e2e.ts).
 * - Query parameters are part of the cache key. Unknown parameters are ignored by the pages, so
 *   they only create extra keys with the same content (correct, just less sharing). Varying them
 *   bypasses the cache, which the per-client rate limiter bounds.
 * - Never cached: `/health` (live readiness), `/analytics/*` (development pages), anything not
 *   listed below.
 *
 * Only a Vercel preview can confirm Vercel's side: that it honours this header on a function
 * response whose `Cache-Control` is `private`, that it applies next.config headers before its
 * cache decision, the statuses it caches, and whether Proxy runs on cache hits (docs/VERCEL.md).
 */
export const CDN_CACHE_HEADER = "Vercel-CDN-Cache-Control";
export const CDN_CACHE_VALUE = "max-age=300, stale-while-revalidate=86400";

/**
 * Public pages (path-to-regexp sources, as next.config `headers()` takes them). `/trends/data` is
 * not here: a next.config header overrides a route handler's own header of the same name (measured,
 * scripts/cdn-cache.e2e.ts), which would have cached its data-state 503/404. The route handler
 * sets the header itself, on successful answers only (`cdnHeadersFor`).
 */
export const CDN_CACHED_ROUTES = [
  "/",
  "/players",
  "/players/:id",
  "/trends",
  "/data",
  "/robots.txt",
  "/sitemap.xml",
] as const;

type Condition = { type: "header" | "query"; key: string; value?: string };
type HeaderRule = { source: string; has?: Condition[]; missing?: Condition[]; headers: { key: string; value: string }[] };

/**
 * A request is cacheable only without any of these (see above). Header names are lower-case, as
 * Next.js and Vercel compare them.
 */
export const UNCACHEABLE_WHEN_PRESENT: readonly Condition[] = [
  { type: "header", key: "rsc" },
  { type: "header", key: "next-router-prefetch" },
  { type: "header", key: "next-router-segment-prefetch" },
  { type: "header", key: "next-router-state-tree" },
  { type: "header", key: "next-url" },
  // Server-action calls (none exist today; Vercel never caches POST anyway).
  { type: "header", key: "next-action" },
  { type: "query", key: "_rsc" },
];

/** next.config `headers()` rules: one per route, plain requests only. Empty when disabled. */
export function cdnCacheRules(enabled: boolean): HeaderRule[] {
  if (!enabled) return [];
  const headers = [{ key: CDN_CACHE_HEADER, value: CDN_CACHE_VALUE }];
  return CDN_CACHED_ROUTES.map((source) => ({ source, missing: UNCACHEABLE_WHEN_PRESENT.map((c) => ({ ...c })), headers }));
}

/**
 * Request-side check with full fidelity (any value, including empty): `has`/`missing` treat an
 * empty value as absent, so `?_rsc` with no value (what Next.js redirects a bare RSC request to)
 * would still match the next.config rule. The proxy (src/proxy.ts) therefore marks every
 * non-plain request `no-store` at runtime, which wins over the rule (measured).
 */
export function cdnCacheableRequest(url: URL, headers: Headers): boolean {
  for (const c of UNCACHEABLE_WHEN_PRESENT)
    if (c.type === "header" ? headers.has(c.key) : url.searchParams.has(c.key)) return false;
  return true;
}

/** Headers for a route handler's successful answer: the CDN rule when caching is on and the request is plain. */
export function cdnHeadersFor(request: Request, env: Record<string, string | undefined> = process.env): Record<string, string> {
  return cdnCacheEnabled(env) && cdnCacheableRequest(new URL(request.url), request.headers) ? { [CDN_CACHE_HEADER]: CDN_CACHE_VALUE } : {};
}

/**
 * CDN caching is on only for a snapshot build (content fixed per deployment) and can be switched
 * off with `PT_CDN_CACHE=off`. next.config reads it at build time (its `headers()` are compiled
 * into the build's routing table); the proxy and `/trends/data` read it at request time. On Vercel
 * the same variables are present at both.
 */
export function cdnCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PT_DATA_SOURCE?.trim() === "snapshot" && env.PT_CDN_CACHE?.trim() !== "off";
}
