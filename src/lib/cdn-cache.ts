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
 * - Vercel's CDN caches only GET/HEAD responses with cacheable statuses (200, 404, redirects; not
 *   5xx). The proxy's 429 overrides the header with `no-store` (src/lib/traffic/policy.ts), and so
 *   does `/trends/data` for its error answers.
 * - Cache poisoning: React Server Component (RSC) payloads and HTML share a pathname. Next.js
 *   router requests carry an `_rsc` query parameter (a hash of the router headers), which gives
 *   them their own cache key. A request with an `RSC` header but WITHOUT `_rsc` (a hand-made one;
 *   the router never sends it) gets no CDN header, so it can never store an RSC payload under a
 *   page's HTML URL. Tested in scripts/vercel.test.ts and against `next start`.
 * - Never cached: `/health` (live readiness), `/analytics/*` (development pages), anything not
 *   listed below.
 */
export const CDN_CACHE_HEADER = "Vercel-CDN-Cache-Control";
export const CDN_CACHE_VALUE = "max-age=300, stale-while-revalidate=86400";

/** Public, data-only routes (path-to-regexp sources, as next.config `headers()` takes them). */
export const CDN_CACHED_ROUTES = [
  "/",
  "/players",
  "/players/:id",
  "/trends",
  "/trends/data",
  "/data",
  "/robots.txt",
  "/sitemap.xml",
] as const;

type HeaderRule = {
  source: string;
  has?: { type: "header" | "query"; key: string; value?: string }[];
  missing?: { type: "header" | "query"; key: string; value?: string }[];
  headers: { key: string; value: string }[];
};

/**
 * next.config `headers()` rules: for each route, cache plain requests (no `RSC` header) and router
 * requests that carry `_rsc`. Empty when disabled.
 */
export function cdnCacheRules(enabled: boolean): HeaderRule[] {
  if (!enabled) return [];
  const headers = [{ key: CDN_CACHE_HEADER, value: CDN_CACHE_VALUE }];
  return CDN_CACHED_ROUTES.flatMap((source) => [
    { source, missing: [{ type: "header" as const, key: "rsc" }], headers },
    { source, has: [{ type: "query" as const, key: "_rsc" }], headers },
  ]);
}

/**
 * CDN caching is on only for a snapshot build (content fixed per deployment) and can be switched
 * off with `PT_CDN_CACHE=off`. Read at build time: next.config `headers()` is compiled into the
 * build's routing table.
 */
export function cdnCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PT_DATA_SOURCE?.trim() === "snapshot" && env.PT_CDN_CACHE?.trim() !== "off";
}
