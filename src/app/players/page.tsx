import type { Metadata } from "next";
import { Suspense } from "react";
import { MOMENTUM_WINDOWS } from "@/analytics/config";
import { PageHeading } from "@/components/ui/primitives";
import { getCompetitionData } from "@/services/competition";
import { levelAsOf, levelFallback, unavailableLevels } from "@/services/competition/model";
import { LevelFallbackNotice } from "@/components/levels/level-fallback";
import { directoryOptions, momentumWindowFor } from "@/services/players/directory";
import {
  parseDirectoryScope,
  parseDirectoryState,
  queryDirectory,
} from "@/services/players/directory-query";
import { directoryRows } from "@/services/players/adapter";
import { LEVELS, levelById } from "@/services/players/levels";
import { AflDataNotice } from "@/components/afl/data-notice";
import { PlayerDirectory } from "@/components/players/player-directory";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Players",
  // Filters, sorts and pages are views of one directory: one canonical URL (src/lib/crawl-policy.ts).
  alternates: { canonical: "/players" },
  description:
    "Search and sort prospects at Triple-A, Double-A, High-A, Single-A and the Arizona Fall League by level, team, organization, position and Momentum.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function PlayersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <PageHeading
        title="Players"
        description="Every prospect with recorded 2026 game lines at Triple-A, Double-A, High-A, Single-A and the Arizona Fall League. Search, filter and sort any column — including Momentum, which compares a player's recent games with their own earlier games at the same level."
      />
      <Suspense
        fallback={
          <div className="explorer directory" aria-busy="true">
            <p className="empty-state">Loading players…</p>
          </div>
        }
      >
        <Directory searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Directory({ searchParams }: { searchParams: SearchParams }) {
  const [data, params] = await Promise.all([
    getCompetitionData(),
    searchParams,
  ]);
  if (data.status !== "ok") return <AflDataNotice status={data.status} />;
  const available = data.levels.map((l) => l.level);
  const scope = parseDirectoryScope(params, available);
  const { role, level, window } = scope;
  const rows = directoryRows(data.levels, { level, window, role });
  const options = directoryOptions(rows);
  const state = parseDirectoryState(params, scope, options);
  // Filter, sort and paginate here: only one page of rows is sent to the browser.
  const result = queryDirectory(rows, state);
  const mWindow = momentumWindowFor(window);
  const scoped = level ? data.levels.filter((l) => l.level === level) : data.levels;
  const through = scoped.map((ls) => {
    const asOf = levelAsOf(ls);
    return `${levelById(ls.level).short} ${asOf ? shortDate(asOf) : "no completed games"}`;
  });
  return (
    <>
      <LevelFallbackNotice
        fallback={levelFallback(scope.requestedLevel, level, data.levelStatus)}
        shown={level}
      />
      <p className="table-note directory-meta">
        {level
          ? `${levelById(level).label} · ${scoped[0].snapshot.season.name}`
          : `All levels · ${data.levels.length} of ${LEVELS.length} loaded`}
        {" · "}stats through {through.join(", ")}
        {" · "}Momentum window:{" "}
        {MOMENTUM_WINDOWS[mWindow].label.toLowerCase()}
      </p>
      {!level && data.levels.length > 1 && (
        <p className="mixed-level-note">
          <strong>All levels:</strong> each player appears once, with statistics
          and Momentum from the level of their most recent game (Lvl column).
          Statistics are not adjusted for level of competition — choose a level
          for like-for-like comparison.
        </p>
      )}
      <PlayerDirectory
        state={state}
        rows={result.rows}
        offset={result.offset}
        matched={result.matched}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        sort={result.sort}
        momentumShort={MOMENTUM_WINDOWS[mWindow].short}
        teams={options.teams}
        organizations={options.organizations}
        positions={options.positions}
        levels={available}
        unavailableLevels={unavailableLevels(data.levelStatus)}
      />
    </>
  );
}
