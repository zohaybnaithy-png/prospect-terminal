import { getAflData } from "@/services/afl";
import {
  aflAsOf,
  recentPerformers,
  RECENT_HITTER_MIN_PA,
} from "@/services/afl/read-model";
import { shortDate } from "@/lib/format";
import { AflDataNotice } from "./data-notice";
import {
  AflRecentPerformers,
  type RecentPerformerSets,
} from "./recent-performers";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="trending-widget" aria-labelledby="trending-title">
      <div className="home-section-heading">
        <h2 id="trending-title">AFL Recent Performers</h2>
      </div>
      {children}
    </section>
  );
}

export function AflRecentPerformersFallback() {
  return (
    <Shell>
      <p className="empty-state" aria-busy="true">
        Loading AFL performances…
      </p>
    </Shell>
  );
}

/** Server-side: computes the small per-window lists so only display rows reach the client. */
export async function AflRecentPerformersSection() {
  const data = await getAflData();
  if (data.status !== "ok")
    return (
      <Shell>
        <AflDataNotice status={data.status} compact />
      </Shell>
    );
  const asOf = aflAsOf(data.snapshot);
  if (!asOf)
    return (
      <Shell>
        <p className="empty-state">
          No completed AFL games have been ingested.
        </p>
      </Shell>
    );
  const sets = Object.fromEntries(
    (["7d", "14d", "30d"] as const).map((w) => [
      w,
      {
        hitters: recentPerformers(data.snapshot, w, "hitters"),
        pitchers: recentPerformers(data.snapshot, w, "pitchers"),
      },
    ]),
  ) as RecentPerformerSets;
  return (
    <AflRecentPerformers
      sets={sets}
      minPa={RECENT_HITTER_MIN_PA}
      asOf={shortDate(asOf)}
    />
  );
}
