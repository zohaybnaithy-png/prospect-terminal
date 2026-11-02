import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { PageHeading } from "@/components/ui/primitives";
import { getAflData } from "@/services/afl";
import {
  aflAsOf,
  aflWindowLabels,
  buildPlayerRows,
  filterOptions,
  filterPlayerRows,
  type AflWindow,
} from "@/services/afl/read-model";
import { AflDataNotice } from "@/components/afl/data-notice";
import {
  AflHitterTable,
  AflPitcherTable,
} from "@/components/afl/player-tables";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = { title: "Players" };

const one = (v: string | string[] | undefined) =>
  typeof v === "string" ? v : "";
const uuidOrUndefined = (v: string) =>
  z.uuid().safeParse(v).success ? v : undefined;
const windows: AflWindow[] = ["season", "30d", "14d", "7d"];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function PlayersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <PageHeading
        title="AFL player directory"
        description="Every player in the ingested 2026 Arizona Fall League data, with batting and pitching from complete box scores. Search by player, AFL team, or MLB organization."
      />
      <Suspense
        fallback={
          <p className="empty-state" aria-busy="true">
            Loading AFL players…
          </p>
        }
      >
        <Directory searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Directory({ searchParams }: { searchParams: SearchParams }) {
  const [data, params] = await Promise.all([getAflData(), searchParams]);
  const query = one(params.q).slice(0, 80);
  const teamId = uuidOrUndefined(one(params.team));
  const organizationId = uuidOrUndefined(one(params.org));
  const window = windows.find((w) => w === one(params.window)) ?? "season";
  if (data.status !== "ok") return <AflDataNotice status={data.status} />;
  const snapshot = data.snapshot;
  const allRows = buildPlayerRows(snapshot, window);
  const rows = filterPlayerRows(allRows, { query, teamId, organizationId });
  const options = filterOptions(allRows);
  const asOf = aflAsOf(snapshot);
  const filtered = Boolean(
    query || teamId || organizationId || window !== "season",
  );
  return (
    <>
      <section className="explorer" aria-label="AFL players and statistics">
        <div className="section-heading">
          <h2>{snapshot.season.name}</h2>
          <span className="small-muted">
            {asOf ? `Stats through ${shortDate(asOf)}` : "No completed games"}
            {snapshot.lastIngestedAt &&
              ` · last ingestion ${shortDate(snapshot.lastIngestedAt.slice(0, 10))}`}
          </span>
        </div>
        <form action="/players" className="filter-bar afl-filter-form">
          <label className="search-label">
            <span>Search</span>
            <input
              name="q"
              defaultValue={query}
              placeholder="Player, team, or organization"
            />
          </label>
          <label className="filter-group">
            <span>AFL team</span>
            <select name="team" defaultValue={teamId ?? ""}>
              <option value="">All teams</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-group">
            <span>Organization</span>
            <select name="org" defaultValue={organizationId ?? ""}>
              <option value="">All organizations</option>
              {options.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-group">
            <span>Timeframe</span>
            <select name="window" defaultValue={window}>
              {windows.map((w) => (
                <option key={w} value={w}>
                  {aflWindowLabels[w]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply</button>
          {filtered && (
            <Link href="/players" className="reset-button">
              Reset
            </Link>
          )}
        </form>
        <p className="table-note">
          {rows.length} of {allRows.length} players · {aflWindowLabels[window]}
          {asOf && window !== "season" && ` ending ${shortDate(asOf)}`}. Column
          sorting orders the displayed raw statistic; it is not a prospect
          ranking. Organization is the MLB parent club from the latest source
          roster observation (— when unresolved).
        </p>
        <h3 className="table-title">Batting</h3>
        <AflHitterTable rows={rows} />
        <h3 className="table-title">Pitching</h3>
        <AflPitcherTable rows={rows} />
        <p className="table-note">
          Prospect Priority, Pure Performance, Grade and Momentum have no
          finalized formulas yet; the fictional discovery-mode preview remains
          on the <Link href="/screener">Screener</Link>.
        </p>
      </section>
    </>
  );
}
