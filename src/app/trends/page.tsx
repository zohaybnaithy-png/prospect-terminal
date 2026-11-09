import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeading } from "@/components/ui/primitives";
import { getCompetitionData } from "@/services/competition";
import { levelFallback, selectLevel, unavailableLevels } from "@/services/competition/model";
import { LevelFallbackNotice } from "@/components/levels/level-fallback";
import { levelById } from "@/services/players/levels";
import { AflDataNotice } from "@/components/afl/data-notice";
import { LevelNav } from "@/components/levels/level-nav";
import { RisersFallers } from "@/components/analytics/risers-fallers";
import { PerformanceMap } from "@/components/analytics/performance-map";
import { MOMENTUM_SETTINGS } from "@/analytics/config";
import { analyticsContextFor } from "@/analytics/views";
import { trendComparable, trendMapPoints, trendRiserLists } from "@/services/competition/prepare";
import { shortDate } from "@/lib/format";
import { analyticsDebugEnabled } from "@/analytics/debug";

export const metadata: Metadata = { title: "Prospect trends", alternates: { canonical: "/trends" } };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function TrendsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <PageHeading
        title="Prospect trends"
        description="Which prospects are changing, how they are changing, and whether the change is meaningful — one level at a time. Momentum compares each player's recent games with their own earlier games at the same level; it measures change, not overall quality."
      />
      <Suspense
        fallback={
          <p className="empty-state" aria-busy="true">
            Loading trends…
          </p>
        }
      >
        <Trends searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Trends({ searchParams }: { searchParams: SearchParams }) {
  const [data, params] = await Promise.all([getCompetitionData(), searchParams]);
  if (data.status !== "ok") return <AflDataNotice status={data.status} />;
  const requested = typeof params.level === "string" ? params.level : undefined;
  const ls = selectLevel(data.levels, requested)!;
  const level = levelById(ls.level);
  const nav = (
    <>
      <LevelNav
        basePath="/trends"
        current={ls.level}
        available={data.levels.map((l) => l.level)}
        unavailable={unavailableLevels(data.levelStatus)}
      />
      <LevelFallbackNotice
        fallback={levelFallback(requested, ls.level, data.levelStatus)}
        shown={ls.level}
      />
    </>
  );
  const ctx = analyticsContextFor(ls.snapshot);
  if (!ctx.ds.asOf)
    return (
      <>
        {nav}
        <p className="empty-state">
          No completed {level.label} games have been ingested.
        </p>
      </>
    );
  const comparable = trendComparable(ls.snapshot);
  return (
    <div className="trends-stack">
      {nav}
      <p className="table-note">
        {level.label}, through {shortDate(ctx.ds.asOf)} (latest completed{" "}
        {level.label} game). Rankings and percentiles are within{" "}
        {level.label} only; levels are not compared with each other. A window
        is shown as unavailable when players have no earlier games at this
        level before it to compare with (common for the 30D window in the short
        AFL season); no change is estimated then.
        {analyticsDebugEnabled() && (
          <>
            {" "}
            <Link href="/analytics/models">Model comparison (development) →</Link>
          </>
        )}
      </p>
      <RisersFallers
        initial={{ role: "hitter", window: "14d", lists: trendRiserLists(ls.snapshot, "hitter", "14d") }}
        comparable={comparable}
        level={ls.level}
        minRecent={MOMENTUM_SETTINGS.sample.leaderboardMinRecent}
        minBaseline={MOMENTUM_SETTINGS.sample.leaderboardMinBaseline}
        minMagnitude={MOMENTUM_SETTINGS.sample.leaderboardMinMagnitude}
      />
      <PerformanceMap
        initial={{ role: "hitter", window: "14d", points: trendMapPoints(ls.snapshot, "hitter", "14d") }}
        comparable={comparable}
        level={ls.level}
      />
    </div>
  );
}
