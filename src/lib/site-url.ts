import { onVercel, vercelEnvironment } from "./platform";

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

/**
 * On Vercel without `PT_SITE_URL`, the deployment's own hostname, from the platform's system
 * variables (set by Vercel per deployment, never derived from a request): the production domain
 * for production, the branch URL (else the deployment URL) for previews. Elsewhere: none.
 */
function vercelOrigin(env: Record<string, string | undefined>): string | undefined {
  if (!onVercel(env)) return undefined;
  const host =
    vercelEnvironment(env) === "production"
      ? env.VERCEL_PROJECT_PRODUCTION_URL
      : (env.VERCEL_BRANCH_URL ?? env.VERCEL_URL);
  const h = host?.trim();
  return h && /^[a-z0-9.-]+$/i.test(h) ? `https://${h}` : undefined;
}

export function siteOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[SITE_URL_ENV]?.trim() || vercelOrigin(env);
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
