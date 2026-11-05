import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { MOMENTUM_WINDOWS } from "@/analytics/config";
import { PageHeading } from "@/components/ui/primitives";
import { getCompetitionData } from "@/services/competition";
import { levelAsOf } from "@/services/competition/model";
import {
  MIN_SAMPLE_OPTIONS,
  STAT_WINDOWS,
  directoryOptions,
  momentumWindowFor,
  type PositionGroup,
} from "@/services/players/directory";
import { directoryRows } from "@/services/players/adapter";
import { isLevelId, levelById, type LevelId } from "@/services/players/levels";
import { AflDataNotice } from "@/components/afl/data-notice";
import {
  PlayerDirectory,
  type DirectoryState,
} from "@/components/players/player-directory";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Players",
  description:
    "Search and sort prospects at Triple-A, Double-A, High-A, Single-A and the Arizona Fall League by level, team, organization, position and Momentum.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) =>
  typeof v === "string" ? v : "";
const uuidOr = (v: string) => (z.uuid().safeParse(v).success ? v : "");
const SORT_KEY = /^[a-z0-9]{1,8}$/;

export default function PlayersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <PageHeading
        title="Players"
        description="Every prospect with recorded game lines at Triple-A, Double-A, High-A, Single-A and the Arizona Fall League. Search, filter by level, team, organization and position, and sort any column — including Momentum, which compares each player's recent games with the player's own earlier games at the same level."
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
  const window = STAT_WINDOWS.find((w) => w === one(params.window)) ?? "season";
  const role = one(params.role) === "pitchers" ? "pitcher" : "hitter";
  const available = data.levels.map((l) => l.level);
  const requested = one(params.level);
  const level: LevelId | "" =
    isLevelId(requested) && available.includes(requested) ? requested : "";
  const rows = directoryRows(data.levels, { level, window, role });
  const options = directoryOptions(rows);
  const position = one(params.pos) as PositionGroup;
  const sortKey = one(params.sort);
  const teamId = uuidOr(one(params.team));
  const organizationId = uuidOr(one(params.org));
  const initial: DirectoryState = {
    role,
    query: one(params.q).slice(0, 80),
    level,
    // Context filters only apply when they occur in this scope (e.g. a team from another level).
    teamId: options.teams.some((t) => t.id === teamId) ? teamId : "",
    organizationId: options.organizations.some((o) => o.id === organizationId)
      ? organizationId
      : "",
    position: options.positions.includes(position) ? position : "",
    minSample:
      MIN_SAMPLE_OPTIONS.find((n) => String(n) === one(params.min)) ?? 0,
    sort: SORT_KEY.test(sortKey)
      ? { key: sortKey, direction: one(params.dir) === "asc" ? "asc" : "desc" }
      : null,
  };
  const mWindow = momentumWindowFor(window);
  const scoped = level ? data.levels.filter((l) => l.level === level) : data.levels;
  const through = scoped.map((ls) => {
    const asOf = levelAsOf(ls);
    return `${levelById(ls.level).short} ${asOf ? shortDate(asOf) : "no completed games"}`;
  });
  return (
    <>
      <p className="table-note directory-meta">
        {level
          ? `${levelById(level).label} · ${scoped[0].snapshot.season.name}`
          : `All levels · ${data.levels.length} of 5 ingested`}
        {" · "}stats through {through.join(", ")}
        {" · "}Momentum window:{" "}
        {MOMENTUM_WINDOWS[mWindow].label.toLowerCase()}
      </p>
      {!level && data.levels.length > 1 && (
        <p className="mixed-level-note">
          All levels: each player appears once, with statistics and Momentum
          from the level of their most recent game (Lvl column; other levels
          are listed beside it). Statistics are not adjusted for level of
          competition and windows end on each level&apos;s own latest game —
          choose a level for like-for-like comparison.
        </p>
      )}
      <PlayerDirectory
        // Role, level and window are server scopes: remount so client state starts from them.
        key={`${role}|${level}|${window}`}
        rows={rows}
        initial={initial}
        window={window}
        momentumShort={MOMENTUM_WINDOWS[mWindow].short}
        teams={options.teams}
        organizations={options.organizations}
        positions={options.positions}
        levels={available}
      />
    </>
  );
}
