import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { MOMENTUM_WINDOWS } from "@/analytics/config";
import { PageHeading } from "@/components/ui/primitives";
import { getAflData } from "@/services/afl";
import { aflAsOf } from "@/services/afl/read-model";
import {
  MIN_SAMPLE_OPTIONS,
  STAT_WINDOWS,
  directoryOptions,
  momentumWindowFor,
  rowsForRole,
  type PositionGroup,
} from "@/services/players/directory";
import { aflDirectoryRows } from "@/services/players/afl-adapter";
import { isLevelId } from "@/services/players/levels";
import { AflDataNotice } from "@/components/afl/data-notice";
import {
  PlayerDirectory,
  type DirectoryState,
} from "@/components/players/player-directory";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Players",
  description:
    "Search and sort every prospect in the Prospect Terminal data by level, team, organization, position and Momentum.",
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
        description="Every prospect with recorded game lines. Search, filter by level, team, organization and position, and sort any column — including Momentum, which compares each player's recent games with the player's own earlier games."
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
  const [data, params] = await Promise.all([getAflData(), searchParams]);
  if (data.status !== "ok") return <AflDataNotice status={data.status} />;
  const window = STAT_WINDOWS.find((w) => w === one(params.window)) ?? "season";
  const rows = aflDirectoryRows(data.snapshot, window);
  const options = directoryOptions(rows);
  const level = one(params.level);
  const position = one(params.pos) as PositionGroup;
  const sortKey = one(params.sort);
  const role = one(params.role) === "pitchers" ? "pitcher" : "hitter";
  const rolePositions = new Set(
    rowsForRole(rows, role).map((r) => r.positionGroup),
  );
  const initial: DirectoryState = {
    role,
    query: one(params.q).slice(0, 80),
    level: isLevelId(level) ? level : "",
    teamId: uuidOr(one(params.team)),
    organizationId: uuidOr(one(params.org)),
    position: rolePositions.has(position) ? position : "",
    minSample:
      MIN_SAMPLE_OPTIONS.find((n) => String(n) === one(params.min)) ?? 0,
    sort: SORT_KEY.test(sortKey)
      ? { key: sortKey, direction: one(params.dir) === "asc" ? "asc" : "desc" }
      : null,
  };
  const asOf = aflAsOf(data.snapshot);
  const mWindow = momentumWindowFor(window);
  return (
    <>
      <p className="table-note directory-meta">
        {data.snapshot.season.name}
        {asOf
          ? ` · stats through ${shortDate(asOf)}`
          : " · no completed games yet"}
        {" · "}Momentum window: {MOMENTUM_WINDOWS[mWindow].label.toLowerCase()}
        {" · "}affiliated MiLB levels appear when MiLB data is ingested
      </p>
      <PlayerDirectory
        rows={rows}
        initial={initial}
        window={window}
        momentumShort={MOMENTUM_WINDOWS[mWindow].short}
        teams={options.teams}
        organizations={options.organizations}
        levels={[...options.levels]}
      />
    </>
  );
}
