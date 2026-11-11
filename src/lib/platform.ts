/**
 * Which hosting platform this server runs on (docs/VERCEL.md).
 *
 * Vercel sets `VERCEL=1` and `VERCEL_ENV` (`production`, `preview` or `development`) in every
 * build and function. Neither can be set by a visitor: they are environment variables of the
 * deployment, not request data. Everything platform-specific (client identity header, default
 * refusal delay, indexing default, site-origin fallback, Web Analytics) keys off these two
 * variables, so the single-server (Lightsail + Caddy) deployment is unchanged when they are absent.
 */
type Env = Record<string, string | undefined>;

export const onVercel = (env: Env = process.env) => env.VERCEL === "1";

/** `production` | `preview` | `development` on Vercel; null elsewhere. */
export function vercelEnvironment(env: Env = process.env): "production" | "preview" | "development" | null {
  if (!onVercel(env)) return null;
  const v = env.VERCEL_ENV;
  return v === "production" || v === "preview" || v === "development" ? v : "preview";
}
