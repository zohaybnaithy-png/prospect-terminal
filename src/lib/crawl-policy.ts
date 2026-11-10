import type { MetadataRoute } from "next";
import { indexingEnabled } from "./indexing";

/**
 * What search engines may crawl (docs/TRAFFIC.md). robots.txt is ADVISORY: well-behaved crawlers
 * follow it, abusive ones ignore it. It manages crawl budget and duplicate URLs; it is not access
 * control. Protection against excessive requests is the rate limiter in src/proxy.ts.
 *
 * - Every public page and every player profile is crawlable at its canonical, query-free URL
 *   (`/`, `/players`, `/trends`, `/data`, `/players/{id}`), and all of them are in the sitemap.
 * - URLs with a query string are not crawled: directory filters, sorts and pages, `?level=` views
 *   and profile level variants multiply into thousands of URLs with the same or overlapping
 *   content, and each costs a full server render. Each such page also declares its query-free
 *   canonical URL, so links to them consolidate there.
 * - Internal endpoints (`/trends/data` JSON, `/health`) and development pages (`/analytics/`) are
 *   not for crawlers.
 * - `/_next/` (scripts, styles, images) stays allowed: crawlers that render pages need them.
 */
export const DISALLOW = ["/*?", "/trends/data", "/health", "/analytics/"];
export const ALLOW = ["/", "/_next/"];

export function robotsPolicy(origin: string | null): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ALLOW, disallow: DISALLOW }],
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}

/** robots.txt for this deployment: the public policy, or disallow everything when not indexed. */
export function robotsFor(origin: string | null, env: Record<string, string | undefined> = process.env): MetadataRoute.Robots {
  return indexingEnabled(env) ? robotsPolicy(origin) : { rules: [{ userAgent: "*", disallow: "/" }] };
}

/** Public pages listed in the sitemap besides player profiles. */
export const STATIC_PAGES = ["/", "/players", "/trends", "/data"] as const;

/**
 * Google-style robots.txt matching (longest matching rule wins; Allow wins a tie; `*` matches any
 * run of characters, `$` anchors the end). Used by tests to check real URLs against the policy.
 */
export function isCrawlAllowed(pathAndQuery: string, allow = ALLOW, disallow = DISALLOW): boolean {
  const match = (rule: string) => {
    const anchored = rule.endsWith("$");
    const body = anchored ? rule.slice(0, -1) : rule;
    const re = new RegExp("^" + body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
    return re.test(pathAndQuery) ? body.length : -1;
  };
  const a = Math.max(-1, ...allow.map(match));
  const d = Math.max(-1, ...disallow.map(match));
  return d < 0 || a >= d;
}
