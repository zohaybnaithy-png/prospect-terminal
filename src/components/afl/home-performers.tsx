import {
  aflAsOf,
  recentPerformers,
  RECENT_HITTER_MIN_PA,
} from "@/services/afl/read-model";
import type { AflSnapshot } from "@/services/afl/types";
import { levelById, type LevelId } from "@/services/players/levels";
import { shortDate } from "@/lib/format";
import {
  AflRecentPerformers,
  type RecentPerformerSets,
} from "./recent-performers";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="home-panel" aria-labelledby="performers-title">
      <div className="home-section-heading">
        <h2 id="performers-title">Recent Leaders</h2>
      </div>
      {children}
    </section>
  );
}

/** Server-side: computes the small per-window lists so only display rows reach the client. */
export function RecentPerformersSection({
  snapshot,
  level,
}: {
  snapshot: AflSnapshot;
  level: LevelId;
}) {
  const asOf = aflAsOf(snapshot);
  if (!asOf)
    return (
      <Shell>
        <p className="empty-state">
          No completed {levelById(level).label} games have been ingested.
        </p>
      </Shell>
    );
  const sets = Object.fromEntries(
    (["7d", "14d", "30d"] as const).map((w) => [
      w,
      {
        hitters: recentPerformers(snapshot, w, "hitters"),
        pitchers: recentPerformers(snapshot, w, "pitchers"),
      },
    ]),
  ) as RecentPerformerSets;
  return (
    <AflRecentPerformers
      sets={sets}
      minPa={RECENT_HITTER_MIN_PA}
      asOf={`${levelById(level).short} · ${shortDate(asOf)}`}
      level={level}
    />
  );
}
