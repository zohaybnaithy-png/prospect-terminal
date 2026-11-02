"use client";
import { useState } from "react";
import type {
  AflPlayerRow,
  BattingAggregate,
  PitchingAggregate,
} from "@/services/afl/read-model";
import {
  formatFixed,
  formatPct,
  formatRate,
  inningsFromOuts,
} from "@/services/afl/format";
import {
  DataTable,
  type Column,
  type TableSort,
} from "@/components/ui/data-table";
import { PlayerLink } from "@/components/ui/entity-links";
import { sortByValue } from "@/lib/table-sort";
import { AflOrganizationLink, AflTeamLink } from "./links";

type Hitter = AflPlayerRow & { batting: BattingAggregate };
type Pitcher = AflPlayerRow & { pitching: PitchingAggregate };

function contextColumns<T extends AflPlayerRow>(): Column<T>[] {
  return [
    {
      key: "player",
      label: "Player",
      render: (r) => <PlayerLink player={r} />,
      sortValue: (r) => r.name,
    },
    {
      key: "team",
      label: "AFL team",
      render: (r) => (r.team ? <AflTeamLink team={r.team} /> : "—"),
      sortValue: (r) => r.team?.abbreviation ?? null,
    },
    {
      key: "org",
      label: "Org",
      title:
        "MLB parent organization from the latest source roster observation",
      render: (r) =>
        r.organization ? (
          <AflOrganizationLink organization={r.organization} />
        ) : (
          "—"
        ),
      sortValue: (r) => r.organization?.abbreviation ?? null,
    },
    {
      key: "pos",
      label: "Pos",
      render: (r) => r.position,
      sortValue: (r) => r.position,
    },
    {
      key: "age",
      label: "Age",
      numeric: true,
      render: (r) => r.age ?? "—",
      sortValue: (r) => r.age,
    },
  ];
}

const count = <T,>(
  key: string,
  label: string,
  get: (r: T) => number | null,
  title?: string,
): Column<T> => ({
  key,
  label,
  title,
  numeric: true,
  render: (r) => get(r) ?? "—",
  sortValue: get,
});
const rate = <T,>(
  key: string,
  label: string,
  get: (r: T) => number | null,
  format: (v: number | null) => string,
  title?: string,
): Column<T> => ({
  key,
  label,
  title,
  numeric: true,
  render: (r) => format(get(r)),
  sortValue: get,
});

const hitterColumns: Column<Hitter>[] = [
  ...contextColumns<Hitter>(),
  count("g", "G", (r) => r.batting.gameLines, "Games with a batting line"),
  count("pa", "PA", (r) => r.batting.plateAppearances),
  count("ab", "AB", (r) => r.batting.atBats),
  count("r", "R", (r) => r.batting.runs),
  count("h", "H", (r) => r.batting.hits),
  count("2b", "2B", (r) => r.batting.doubles),
  count("3b", "3B", (r) => r.batting.triples),
  count("hr", "HR", (r) => r.batting.homeRuns),
  count("rbi", "RBI", (r) => r.batting.rbi),
  count("bb", "BB", (r) => r.batting.walks),
  count("so", "SO", (r) => r.batting.strikeouts),
  count("sb", "SB", (r) => r.batting.stolenBases),
  rate("avg", "AVG", (r) => r.batting.avg, formatRate),
  rate("obp", "OBP", (r) => r.batting.obp, formatRate),
  rate("slg", "SLG", (r) => r.batting.slg, formatRate),
  rate("ops", "OPS", (r) => r.batting.ops, formatRate),
  rate("bbp", "BB%", (r) => r.batting.bbPct, formatPct),
  rate("kp", "K%", (r) => r.batting.kPct, formatPct),
];

const pitcherColumns: Column<Pitcher>[] = [
  ...contextColumns<Pitcher>(),
  count("g", "G", (r) => r.pitching.gameLines, "Games with a pitching line"),
  {
    key: "ip",
    label: "IP",
    numeric: true,
    render: (r) => inningsFromOuts(r.pitching.outsRecorded),
    sortValue: (r) => r.pitching.outsRecorded,
  },
  count("bf", "BF", (r) => r.pitching.battersFaced),
  count("h", "H", (r) => r.pitching.hitsAllowed),
  count("r", "R", (r) => r.pitching.runs),
  count("er", "ER", (r) => r.pitching.earnedRuns),
  count("hr", "HR", (r) => r.pitching.homeRunsAllowed),
  count("bb", "BB", (r) => r.pitching.walks),
  count("k", "K", (r) => r.pitching.strikeouts),
  rate(
    "era",
    "ERA",
    (r) => r.pitching.era,
    (v) => formatFixed(v, 2),
  ),
  rate(
    "whip",
    "WHIP",
    (r) => r.pitching.whip,
    (v) => formatFixed(v, 2),
  ),
  rate("kp", "K%", (r) => r.pitching.kPct, formatPct),
  rate("bbp", "BB%", (r) => r.pitching.bbPct, formatPct),
];

function SortableTable<T extends AflPlayerRow>({
  rows,
  columns,
  initial,
  caption,
  emptyMessage,
}: {
  rows: T[];
  columns: Column<T>[];
  initial: TableSort;
  caption: string;
  emptyMessage: string;
}) {
  const [sort, setSort] = useState<TableSort>(initial);
  const column = columns.find((c) => c.key === sort.key);
  const sorted = column?.sortValue
    ? sortByValue(rows, column.sortValue, sort.direction)
    : rows;
  return (
    <DataTable
      rows={sorted}
      columns={columns}
      rowKey={(r) => r.id}
      caption={caption}
      sort={sort}
      emptyMessage={emptyMessage}
      onSort={(key) =>
        setSort((old) => ({
          key,
          direction:
            old.key === key && old.direction === "desc" ? "asc" : "desc",
        }))
      }
    />
  );
}

/** Column sorting orders a displayed raw statistic; it is not a prospect ranking. */
export function AflHitterTable({ rows }: { rows: AflPlayerRow[] }) {
  return (
    <SortableTable
      rows={rows.filter((r): r is Hitter => r.batting !== null)}
      columns={hitterColumns}
      initial={{ key: "pa", direction: "desc" }}
      caption="AFL batting statistics from ingested complete box scores"
      emptyMessage="No AFL hitters match these filters."
    />
  );
}
export function AflPitcherTable({ rows }: { rows: AflPlayerRow[] }) {
  return (
    <SortableTable
      rows={rows.filter((r): r is Pitcher => r.pitching !== null)}
      columns={pitcherColumns}
      initial={{ key: "ip", direction: "desc" }}
      caption="AFL pitching statistics from ingested complete box scores"
      emptyMessage="No AFL pitchers match these filters."
    />
  );
}
