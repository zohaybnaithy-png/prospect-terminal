import { Suspense } from "react";
import { getAflData } from "@/services/afl";
import { coverageSummary, latestTopLines, trendingSets } from "@/services/home";
import { getTopProspects } from "@/services/rankings";
import { AflDataNotice } from "@/components/afl/data-notice";
import {
  AflRecentPerformersFallback,
  AflRecentPerformersSection,
} from "@/components/afl/home-performers";
import { TrendingProspects } from "@/components/home/trending-prospects";
import {
  CoveragePanel,
  LatestLines,
  TopProspectsPanel,
} from "@/components/home/sections";

export default function HomePage() {
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
        <HomeDashboard />
      </Suspense>
    </>
  );
}

async function HomeDashboard() {
  const [data, topProspects] = await Promise.all([
    getAflData(),
    getTopProspects(),
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
        </aside>
      </div>
    );
  const lines = latestTopLines(data.snapshot);
  return (
    <div className="homepage-grid">
      <div className="homepage-main">
        <TrendingProspects sets={trendingSets(data.snapshot)} />
        <LatestLines {...lines} />
      </div>
      <aside className="homepage-sidebar" aria-label="Performance and rankings">
        <Suspense fallback={<AflRecentPerformersFallback />}>
          <AflRecentPerformersSection />
        </Suspense>
        <TopProspectsPanel result={topProspects} />
        <CoveragePanel coverage={coverageSummary(data.snapshot)} />
      </aside>
    </div>
  );
}
