import { onVercel, vercelEnvironment } from "./platform";

/**
 * Whether search engines may index this deployment. A staging (or any non-public) deployment sets
 * `PT_INDEXING=off`: robots.txt then disallows everything, the sitemap is empty, every response
 * carries `X-Robots-Tag: noindex, nofollow` (src/proxy.ts) and pages a noindex meta tag.
 *
 * - Single server (Lightsail + Caddy): indexing is on only when the variable is unset or exactly
 *   "on"; any other value (a typo included) turns it off, so a mistake can only hide a site.
 * - Vercel (docs/VERCEL.md): indexing is OFF by default and turns on only with an explicit
 *   `PT_INDEXING=on` on the **production** environment. Preview and development deployments are
 *   never indexed, whatever the variable says, so a copied variable cannot expose staging, and a
 *   forgotten variable cannot make the public launch happen early (data licensing is still an
 *   open launch blocker, docs/DATA-LICENSING.md).
 *
 * Read at request time.
 */
export function indexingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.PT_INDEXING?.trim();
  if (onVercel(env)) return vercelEnvironment(env) === "production" && v === "on";
  return v === undefined || v === "" || v === "on";
}

export const NOINDEX_HEADER = "noindex, nofollow";
