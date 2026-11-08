import type { LevelFallback } from "@/services/competition/model";
import { levelById, type LevelId } from "@/services/players/levels";

/** Says which level is shown instead of the one the URL asked for, and why. */
export function LevelFallbackNotice({
  fallback,
  shown,
}: {
  fallback: LevelFallback | null;
  /** "" = all levels. */
  shown: LevelId | "";
}) {
  if (!fallback) return null;
  const asked = levelById(fallback.requested).label;
  const instead = shown ? levelById(shown).label : "all levels";
  return (
    <p className="afl-notice compact" role="status">
      {fallback.reason === "unavailable"
        ? `${asked} data is temporarily unavailable — showing ${instead}. Please try again in a moment.`
        : `No 2026 ${asked} data has been ingested — showing ${instead}.`}
    </p>
  );
}
