"use client";
import Link from "next/link";
import { useState } from "react";
import type { Catalog, TimeWindow, PerformanceLine } from "@/types/baseball";
import { discoverDemoPlayers, defaultFilters } from "@/services/discovery";
import {
  PlayerLink,
  OrganizationLink,
  ContextLink,
} from "@/components/ui/entity-links";
import { Momentum } from "@/components/ui/primitives";
import { average, era } from "@/lib/format";
export function PerformanceSummary({ sample }: { sample: PerformanceLine }) {
  if (sample.pitching && !sample.batting)
    return (
      <>
        {era(sample.pitching.earnedRuns, sample.pitching.outsRecorded)} ERA ·{" "}
        {sample.pitching.strikeouts} K
      </>
    );
  if (sample.batting) {
    const b = sample.batting;
    const pa = b.atBats + b.walks + b.hitByPitch + b.sacrificeFlies;
    return (
      <>
        {average(b.hits, b.atBats)}/
        {average(b.hits + b.walks + b.hitByPitch, pa)}/
        {average(b.hits + b.doubles + 2 * b.triples + 3 * b.homeRuns, b.atBats)}
      </>
    );
  }
  return <>No sample available</>;
}
export function TrendingProspects({ catalog }: { catalog: Catalog }) {
  const [window, setWindow] = useState<Exclude<TimeWindow, "season">>("14d");
  const [context, setContext] = useState("all");
  const players = discoverDemoPlayers(catalog, {
    ...defaultFilters,
    window,
    context,
  }).slice(0, 5);
  return (
    <section className="trending-widget" aria-labelledby="trending-title">
      <div className="home-section-heading">
        <h2 id="trending-title">Trending Prospects</h2>
      </div>
      <div className="trending-controls">
        <div
          className="button-group"
          role="group"
          aria-label="Trending timeframe"
        >
          {(["7d", "14d", "30d"] as const).map((w) => (
            <button
              key={w}
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
            >
              {w.toUpperCase()}
            </button>
          ))}
        </div>
        <select
          aria-label="Trending level or league"
          value={context}
          onChange={(e) => setContext(e.target.value)}
        >
          <option value="all">All levels</option>
          {catalog.contexts.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.shortName}
            </option>
          ))}
        </select>
      </div>
      <ol className="trending-list" aria-live="polite">
        {players.map((p, i) => {
          const team = catalog.teams.find((t) => t.id === p.teamId)!;
          return (
            <li key={p.id}>
              <span className="list-rank">{i + 1}</span>
              <div>
                <div className="trending-player-line">
                  <PlayerLink player={p} />
                  <span className="trending-context">
                    <OrganizationLink
                      organization={catalog.organizations.find(
                        (o) => o.id === p.organizationId,
                      )!}
                    />
                    <ContextLink
                      context={catalog.contexts.find(
                        (c) => c.id === team.contextId,
                      )!}
                    />
                  </span>
                </div>
                <div className="performance-summary">
                  <PerformanceSummary sample={p.performance[window]} />{" "}
                  <span>· Last {window.toUpperCase()}</span>
                </div>
              </div>
              <span
                className="trend-value"
                title="Illustrative snapshot Momentum; not recalculated by timeframe"
              >
                <span aria-hidden="true">{p.momentum >= 0 ? "↑" : "↓"}</span>
                <Momentum value={p.momentum} />
              </span>
            </li>
          );
        })}
      </ol>
      <div className="widget-bottom">
        <Link href="/players">Explore all players →</Link>
        <span>Fictional samples</span>
      </div>
    </section>
  );
}
