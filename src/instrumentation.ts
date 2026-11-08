/**
 * Runs once when a Next.js server instance starts. Starts loading every competition level in the
 * background so the first visitor does not wait for the initial database load. It is not awaited:
 * the server starts serving immediately, and requests that arrive before the load finishes share
 * the same in-flight load. Skipped during `next build` and on the edge runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { PHASE_PRODUCTION_BUILD } = await import("next/constants");
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD || !process.env.DATABASE_URL) return;
  const { warmCompetitionData } = await import("@/services/competition");
  warmCompetitionData();
}
