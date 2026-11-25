import type { Role } from "@/analytics/config";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PlayerLink } from "@/components/ui/entity-links";
import { MomentumValue } from "@/components/analytics/momentum-parts";
import { formatFixed, formatPct, formatRate, inningsFromOuts } from "@/services/afl/format";
import { levelById } from "@/services/players/levels";
import { shortDate } from "@/lib/format";
import type { WatchlistEntry } from "@/services/watchlist/model";
import { WatchlistStar } from "./star-button";

type Row = WatchlistEntry & { row: NonNullable<WatchlistEntry["row"]> };
const CONFIDENCE = { low: "Low", medium: "Medium", high: "High" } as const;

function contextColumns(role: Role, momentumShort: string): Column<Row>[] {
  const unit = role === "hitter" ? "PA" : "BF";
  return [
    {
      key: "star",
      label: "Watch",
      title: "Starred in this browser; choose the star to remove",
      render: (e) => <WatchlistStar playerId={e.id} name={e.row.name} />,
    },
    { key: "player", label: "Player", render: (e) => <PlayerLink player={e.row} level={e.row.level} /> },
    {
      key: "lvl",
      label: "Lvl",
      title: "Level of the player's most recent game: the row's statistics and Momentum come from this level only",
      render: (e) => {
        const others = e.levels.filter((l) => l !== e.row.level);
        return (
          <>
            <span className="level-tag" title={levelById(e.row.level).label}>
              {levelById(e.row.level).short}
            </span>
            {others.length > 0 && (
              <span className="level-also" title={`Also played at: ${others.map((o) => levelById(o).label).join(", ")}`}>
                {" "}+ {others.map((o) => levelById(o).short).join(", ")}
                <span className="sr-only"> (also played at {others.map((o) => levelById(o).label).join(", ")})</span>
              </span>
            )}
          </>
        );
      },
    },
    { key: "team", label: "Team", render: (e) => (e.row.team ? <span title={e.row.team.name}>{e.row.team.abbreviation}</span> : "—") },
    {
      key: "org",
      label: "Org",
      title: "MLB parent organization from the latest source roster observation",
      render: (e) => (e.row.organization ? <span title={e.row.organization.name}>{e.row.organization.abbreviation}</span> : "—"),
    },
    { key: "pos", label: "Pos", render: (e) => e.row.position },
    { key: "age", label: "Age", numeric: true, render: (e) => e.row.age ?? "—" },
    {
      key: "last",
      label: "Last G",
      title: "Date of the player's latest completed game at this level",
      render: (e) => (e.row.lastGame ? shortDate(e.row.lastGame) : "—"),
    },
    {
      key: "mom",
      label: `Mom. ${momentumShort}`,
      title: `Momentum (${momentumShort}): recent games vs. the player's own earlier games at this level, −100 to +100. Not a quality grade.`,
      numeric: true,
      render: (e) => <MomentumValue score={e.row.momentum[role]?.score ?? null} />,
    },
    {
      key: "conf",
      label: "Conf.",
      title: `How much data supports the Momentum signal: recent / earlier ${unit}`,
      render: (e) => {
        const m = e.row.momentum[role];
        if (!m?.confidence || !m.sample) return <span className="placeholder-value">Not enough data</span>;
        return (
          <>
            {CONFIDENCE[m.confidence]}
            <span className="watch-sample">
              {" "}
              {m.sample.recent}/{m.sample.baseline} {m.sample.unit}
            </span>
          </>
        );
      },
    },
  ];
}

const num = (key: string, label: string, get: (e: Row) => number | string | null, title?: string): Column<Row> => ({
  key,
  label,
  title,
  numeric: true,
  render: (e) => get(e) ?? "—",
});

function hitterColumns(momentumShort: string): Column<Row>[] {
  const b = (e: Row) => e.row.batting!;
  return [
    ...contextColumns("hitter", momentumShort),
    num("g", "G", (e) => b(e).gameLines, "Games with a batting line"),
    num("pa", "PA", (e) => b(e).plateAppearances, "Plate appearances (sample size)"),
    num("avg", "AVG", (e) => formatRate(b(e).avg)),
    num("obp", "OBP", (e) => formatRate(b(e).obp)),
    num("slg", "SLG", (e) => formatRate(b(e).slg)),
    num("ops", "OPS", (e) => formatRate(b(e).ops)),
    num("hr", "HR", (e) => b(e).homeRuns),
    num("sb", "SB", (e) => b(e).stolenBases),
    num("bbp", "BB%", (e) => formatPct(b(e).bbPct)),
    num("kp", "K%", (e) => formatPct(b(e).kPct)),
  ];
}

function pitcherColumns(momentumShort: string): Column<Row>[] {
  const p = (e: Row) => e.row.pitching!;
  return [
    ...contextColumns("pitcher", momentumShort),
    num("g", "G", (e) => p(e).gameLines, "Games with a pitching line"),
    num("ip", "IP", (e) => inningsFromOuts(p(e).outsRecorded)),
    num("bf", "BF", (e) => p(e).battersFaced, "Batters faced (sample size)"),
    num("era", "ERA", (e) => formatFixed(p(e).era, 2)),
    num("whip", "WHIP", (e) => formatFixed(p(e).whip, 2)),
    num("kp", "K%", (e) => formatPct(p(e).kPct)),
    num("bbp", "BB%", (e) => formatPct(p(e).bbPct)),
    num("kbb", "K−BB%", (e) => {
      const { kPct, bbPct } = p(e);
      return kPct !== null && bbPct !== null ? formatPct(kPct - bbPct) : null;
    }),
    num("hr", "HR", (e) => p(e).homeRunsAllowed, "Home runs allowed"),
  ];
}

/** Starred players with a line for the role, each at their own latest level (one row per player). */
export function WatchlistTable({
  role,
  entries,
  momentumShort,
}: {
  role: Role;
  entries: WatchlistEntry[];
  momentumShort: string;
}) {
  const rows = entries.filter((e): e is Row => e.row !== null);
  return (
    <DataTable
      rows={rows}
      columns={role === "hitter" ? hitterColumns(momentumShort) : pitcherColumns(momentumShort)}
      rowKey={(e) => e.id}
      caption={`Watchlist ${role === "hitter" ? "hitters" : "pitchers"}: season ${role === "hitter" ? "batting" : "pitching"} line and Momentum at each player's latest level`}
    />
  );
}
