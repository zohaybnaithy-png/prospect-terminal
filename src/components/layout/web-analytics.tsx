"use client";

import { Analytics } from "@vercel/analytics/next";
import { analyticsUrl } from "@/lib/web-analytics";

/**
 * Vercel Web Analytics page views, rendered only on Vercel (src/lib/web-analytics.ts). Loads
 * `/_vercel/insights/script.js` from the site's own origin, sets no cookies, and sends the page
 * path without its query string.
 */
export function WebAnalytics() {
  return (
    <Analytics
      mode="production"
      beforeSend={(event) => {
        const url = analyticsUrl(event.url);
        return url ? { ...event, url } : null;
      }}
    />
  );
}
