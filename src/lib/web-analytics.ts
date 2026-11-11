import { onVercel } from "./platform";

/**
 * Vercel Web Analytics (docs/VERCEL.md, *Visitor analytics*): on only when the site runs on Vercel
 * (the script and beacon endpoint, `/_vercel/insights/*`, exist only there) and not switched off
 * with `PT_WEB_ANALYTICS=off`. Cookieless, same-origin (no CSP change), no personal data: page
 * paths only, with query strings removed before sending (src/components/layout/web-analytics.tsx).
 * Read at request time.
 */
export function webAnalyticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return onVercel(env) && env.PT_WEB_ANALYTICS?.trim() !== "off";
}

/**
 * What a page view reports: the path only. Query strings can hold free text typed into the player
 * search (`?q=`) and filter state; neither is needed to count visits. Fragments are dropped too.
 * Returns null (event not sent) for a URL that cannot be parsed.
 */
export function analyticsUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
