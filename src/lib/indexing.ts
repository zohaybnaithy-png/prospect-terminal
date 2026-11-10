/**
 * Whether search engines may index this deployment. A staging (or any non-public) deployment sets
 * `PT_INDEXING=off`: robots.txt then disallows everything, the sitemap is empty, every response
 * carries `X-Robots-Tag: noindex, nofollow` (src/proxy.ts) and pages a noindex meta tag. Indexing
 * is on only when the variable is unset or exactly "on"; any other value (a typo included) turns it
 * off, so a mistake can only hide a site, never expose staging to search engines.
 * Read at request time (the build has no environment).
 */
export function indexingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.PT_INDEXING;
  return v === undefined || v.trim() === "" || v.trim() === "on";
}

export const NOINDEX_HEADER = "noindex, nofollow";
