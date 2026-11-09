/**
 * The public origin of the site (e.g. https://prospectterminal.example), from `PT_SITE_URL` at
 * request time (the build has no environment). Used for canonical URLs, robots.txt and the
 * sitemap, which need absolute URLs. Never derived from the request's Host header, which a client
 * controls.
 *
 * Only an origin is accepted (scheme + host + optional port, no path, query or credentials), and
 * only http(s). Anything else is treated as unset: canonical links then resolve against
 * localhost, and robots.txt/sitemap.xml omit absolute URLs rather than publish a wrong one.
 */
export const SITE_URL_ENV = "PT_SITE_URL";
const FALLBACK = "http://localhost:3000";

export function siteOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[SITE_URL_ENV]?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Base for Next's `metadataBase` (relative canonical URLs need one). */
export const metadataBase = (env?: Record<string, string | undefined>) => new URL(siteOrigin(env) ?? FALLBACK);
