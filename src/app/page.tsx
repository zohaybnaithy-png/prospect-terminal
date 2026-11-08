import { Suspense } from "react";
import { getCompetitionData } from "@/services/competition";
import {
  defaultLevel,
  levelCoverage,
  levelFallback,
  selectLevel,
  unavailableLevels,
} from "@/services/competition/model";
import { LevelFallbackNotice } from "@/components/levels/level-fallback";
import { homeTopLines, homeTrending, levelCoverageSummary } from "@/services/competition/prepare";
import { getTopProspects } from "@/services/rankings";
import { levelById } from "@/services/players/levels";
import { AflDataNotice } from "@/components/afl/data-notice";
import { RecentPerformersSection } from "@/components/afl/home-performers";
import { TrendingProspects } from "@/components/home/trending-prospects";
import {
  CoveragePanel,
  LatestLines,
  TopProspectsPanel,
} from "@/components/home/sections";
import { LevelNav } from "@/components/levels/level-nav";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function HomePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <h1 className="sr-only">
        Prospect Terminal — trending prospects, recent performance and scores
      </h1>
      <Suspense
        fallback={
          <p className="empty-state" aria-busy="true">
            Loading prospect data…
          </p>
        }
      >
        <HomeDashboard searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function HomeDashboard({ searchParams }: { searchParams: SearchParams }) {
  const [data, topProspects, params] = await Promise.all([
    getCompetitionData(),
    getTopProspects(),
    searchParams,
  ]);
  if (data.status !== "ok")
    return (
      <div className="homepage-grid">
        <div className="homepage-main">
          <section className="home-panel" aria-labelledby="trending-title">
            <div className="home-section-heading">
              <h2 id="trending-title">Trending Prospects</h2>
            </div>
            <AflDataNotice status={data.status} />
          </section>
        </div>
        <aside className="homepage-sidebar" aria-label="Rankings">
          <TopProspectsPanel result={topProspects} />
          {data.status === "empty" && (
            <CoveragePanel coverage={levelCoverage([], data.levelStatus)} />
          )}
        </aside>
      </div>
    );
  const requested = typeof params.level === "string" ? params.level : undefined;
  const ls = selectLevel(data.levels, requested)!;
  const level = levelById(ls.level);
  const available = data.levels.map((l) => l.level);
  return (
    <>
      <LevelNav
        basePath="/"
        current={ls.level}
        available={available}
        unavailable={unavailableLevels(data.levelStatus)}
        label={
          ls.level === defaultLevel(data.levels) ? "Level (latest)" : "Level"
        }
      />
      <LevelFallbackNotice
        fallback={levelFallback(requested, ls.level, data.levelStatus)}
        shown={ls.level}
      />
      <div className="homepage-grid">
        <div className="homepage-main">
          <TrendingProspects
            sets={homeTrending(ls.snapshot)}
            level={ls.level}
            levelLabel={level.label}
          />
          <LatestLines
            {...homeTopLines(ls.snapshot)}
            level={ls.level}
            levelLabel={level.label}
          />
        </div>
        <aside
          className="homepage-sidebar"
          aria-label="Performance and rankings"
        >
          <RecentPerformersSection snapshot={ls.snapshot} level={ls.level} />
          <TopProspectsPanel result={topProspects} />
          <CoveragePanel coverage={levelCoverage(data.levels, data.levelStatus, levelCoverageSummary)} />
        </aside>
      </div>
    </>
  );
}
