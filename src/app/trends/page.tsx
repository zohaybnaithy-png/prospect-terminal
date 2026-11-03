import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeading } from "@/components/ui/primitives";
import { getAflData } from "@/services/afl";
import { AflDataNotice } from "@/components/afl/data-notice";
import { RisersFallers } from "@/components/analytics/risers-fallers";
import { PerformanceMap } from "@/components/analytics/performance-map";
import { MOMENTUM_SETTINGS } from "@/analytics/config";
import { analyticsContextFor, mapSets, riserSets } from "@/analytics/views";
import { shortDate } from "@/lib/format";
import { analyticsDebugEnabled } from "@/analytics/debug";

export const metadata: Metadata = { title: "Prospect trends" };

export default function TrendsPage() {
  return (
    <>
      <PageHeading
        title="AFL prospect trends"
        description="Which prospects are changing, how they are changing, and whether the change is meaningful. Momentum compares each player's recent AFL games with their own earlier AFL games — it measures change, not overall quality."
      />
      <Suspense
        fallback={
          <p className="empty-state" aria-busy="true">
            Loading AFL trends…
          </p>
        }
      >
        <Trends />
      </Suspense>
    </>
  );
}

async function Trends() {
  const data = await getAflData();
  if (data.status !== "ok") return <AflDataNotice status={data.status} />;
  const ctx = analyticsContextFor(data.snapshot);
  if (!ctx.ds.asOf)
    return <p className="empty-state">No completed AFL games have been ingested.</p>;
  const risers = riserSets(data.snapshot);
  return (
    <div className="trends-stack">
      <p className="table-note">
        Through {shortDate(ctx.ds.asOf)} (latest completed AFL game). A window
        is shown as unavailable when players have no earlier AFL games before it
        to compare with (often 30D in the short AFL season); no change is
        estimated then.
        {analyticsDebugEnabled() && (
          <>
            {" "}
            <Link href="/analytics/models">Model comparison (development) →</Link>
          </>
        )}
      </p>
      <RisersFallers
        sets={risers}
        minRecent={MOMENTUM_SETTINGS.sample.leaderboardMinRecent}
        minBaseline={MOMENTUM_SETTINGS.sample.leaderboardMinBaseline}
        minMagnitude={MOMENTUM_SETTINGS.sample.leaderboardMinMagnitude}
      />
      <PerformanceMap sets={mapSets(data.snapshot)} comparable={risers.comparable} />
    </div>
  );
}
