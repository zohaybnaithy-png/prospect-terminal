/**
 * Fail-fast guard for Vercel builds (docs/VERCEL.md). The Vercel target only works as a snapshot
 * deployment: without `PT_DATA_SOURCE=snapshot` at build time, `next build` silently skips tracing
 * the snapshot into the functions and inlining the precomputed-views fingerprint, so the
 * deployment "succeeds" and then runs in database mode (on staging, `/health` answers
 * `unavailable` with views `off`). next.config.ts calls this during `next build` and fails the
 * build instead.
 *
 * Scope: only Vercel production and preview builds (`VERCEL=1` and `VERCEL_ENV` production or
 * preview, both set by Vercel itself). Local `npm run build`, `next dev`, CI and the e2e suites
 * (which build without `VERCEL`) are unaffected. The value is accepted exactly as the app reads it
 * (src/services/competition/data-source.ts: trimmed, case-sensitive `snapshot`). The message never
 * repeats the variable's value. Dependency-free so next.config.ts can import it.
 */
export function vercelBuildConfigError(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL !== "1" || (env.VERCEL_ENV !== "production" && env.VERCEL_ENV !== "preview")) return null;
  const raw = env.PT_DATA_SOURCE;
  if (raw?.trim() === "snapshot") return null;
  const state = raw === undefined || raw.trim() === "" ? "is not set" : 'is set, but not to "snapshot"';
  return (
    `Vercel ${env.VERCEL_ENV} build refused: PT_DATA_SOURCE ${state}. ` +
    `This deployment would build without the data snapshot and run in database mode. ` +
    `Set PT_DATA_SOURCE=snapshot for the ${env.VERCEL_ENV === "production" ? "Production" : "Preview"} environment ` +
    `in the Vercel project settings and redeploy (docs/VERCEL.md, deploy/vercel-env.example).`
  );
}
