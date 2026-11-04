import type {
  AflPlayerProfile,
  BattingAggregate,
  GameLogEntry,
  PitchingAggregate,
} from "@/services/afl/read-model";
import {
  formatFixed,
  formatPct,
  formatRate,
  inningsFromOuts,
} from "@/services/afl/format";
import { DataTable, type Column } from "@/components/ui/data-table";
import { shortDate } from "@/lib/format";
import { AflOrganizationLink, AflTeamLink } from "./links";
import type { LevelId } from "@/services/players/levels";

interface WindowRow<T> {
  id: string;
  label: string;
  stats: T | null;
}
const dash = "—";
const num =
  <T,>(get: (s: T) => number | null) =>
  (r: WindowRow<T>) =>
    r.stats ? (get(r.stats) ?? dash) : dash;

export function BattingWindowTable({
  rows,
}: {
  rows: WindowRow<BattingAggregate>[];
}) {
  const columns: Column<WindowRow<BattingAggregate>>[] = [
    { key: "sample", label: "Sample", render: (r) => r.label },
    ...(
      [
        ["g", "G", (s) => s.gameLines],
        ["pa", "PA", (s) => s.plateAppearances],
        ["ab", "AB", (s) => s.atBats],
        ["r", "R", (s) => s.runs],
        ["h", "H", (s) => s.hits],
        ["2b", "2B", (s) => s.doubles],
        ["3b", "3B", (s) => s.triples],
        ["hr", "HR", (s) => s.homeRuns],
        ["rbi", "RBI", (s) => s.rbi],
        ["bb", "BB", (s) => s.walks],
        ["so", "SO", (s) => s.strikeouts],
        ["sb", "SB", (s) => s.stolenBases],
        ["cs", "CS", (s) => s.caughtStealing],
      ] as [string, string, (s: BattingAggregate) => number | null][]
    ).map(([key, label, get]) => ({
      key,
      label,
      numeric: true,
      render: num(get),
    })),
    ...(
      [
        ["avg", "AVG", (s) => formatRate(s.avg)],
        ["obp", "OBP", (s) => formatRate(s.obp)],
        ["slg", "SLG", (s) => formatRate(s.slg)],
        ["ops", "OPS", (s) => formatRate(s.ops)],
        ["bbp", "BB%", (s) => formatPct(s.bbPct)],
        ["kp", "K%", (s) => formatPct(s.kPct)],
      ] as [string, string, (s: BattingAggregate) => string][]
    ).map(([key, label, get]) => ({
      key,
      label,
      numeric: true,
      render: (r: WindowRow<BattingAggregate>) =>
        r.stats ? get(r.stats) : dash,
    })),
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      caption="Batting by window, from ingested complete box scores"
      emptyMessage="No batting lines at this level."
    />
  );
}

export function PitchingWindowTable({
  rows,
}: {
  rows: WindowRow<PitchingAggregate>[];
}) {
  const columns: Column<WindowRow<PitchingAggregate>>[] = [
    { key: "sample", label: "Sample", render: (r) => r.label },
    {
      key: "g",
      label: "G",
      numeric: true,
      render: num((s) => s.gameLines),
    },
    {
      key: "ip",
      label: "IP",
      numeric: true,
      render: (r) => (r.stats ? inningsFromOuts(r.stats.outsRecorded) : dash),
    },
    ...(
      [
        ["bf", "BF", (s) => s.battersFaced],
        ["h", "H", (s) => s.hitsAllowed],
        ["r", "R", (s) => s.runs],
        ["er", "ER", (s) => s.earnedRuns],
        ["hr", "HR", (s) => s.homeRunsAllowed],
        ["bb", "BB", (s) => s.walks],
        ["k", "K", (s) => s.strikeouts],
        ["np", "NP", (s) => s.pitches],
      ] as [string, string, (s: PitchingAggregate) => number | null][]
    ).map(([key, label, get]) => ({
      key,
      label,
      numeric: true,
      render: num(get),
    })),
    ...(
      [
        ["era", "ERA", (s) => formatFixed(s.era, 2)],
        ["whip", "WHIP", (s) => formatFixed(s.whip, 2)],
        ["kp", "K%", (s) => formatPct(s.kPct)],
        ["bbp", "BB%", (s) => formatPct(s.bbPct)],
      ] as [string, string, (s: PitchingAggregate) => string][]
    ).map(([key, label, get]) => ({
      key,
      label,
      numeric: true,
      render: (r: WindowRow<PitchingAggregate>) =>
        r.stats ? get(r.stats) : dash,
    })),
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      caption="Pitching by window, from ingested complete box scores"
      emptyMessage="No pitching lines at this level."
    />
  );
}

const gameContext = (level?: LevelId): Column<GameLogEntry>[] => [
  {
    key: "date",
    label: "Date",
    render: (g) => <time dateTime={g.date}>{shortDate(g.date)}</time>,
  },
  {
    key: "team",
    label: "Team",
    render: (g) => (g.team ? <AflTeamLink team={g.team} level={level} /> : dash),
  },
  {
    key: "opp",
    label: "Opp",
    render: (g) =>
      g.opponent ? (
        <>
          {g.home ? "vs " : "@ "}
          <AflTeamLink team={g.opponent} level={level} />
        </>
      ) : (
        dash
      ),
  },
  { key: "result", label: "Result", render: (g) => g.result ?? dash },
];

export function BattingGameLog({
  entries,
  level,
}: {
  entries: GameLogEntry[];
  level?: LevelId;
}) {
  const b =
    (get: (s: BattingAggregate) => number | null) => (g: GameLogEntry) =>
      g.batting ? (get(g.batting) ?? dash) : dash;
  const columns: Column<GameLogEntry>[] = [
    ...gameContext(level),
    {
      key: "pa",
      label: "PA",
      numeric: true,
      render: b((s) => s.plateAppearances),
    },
    { key: "ab", label: "AB", numeric: true, render: b((s) => s.atBats) },
    { key: "r", label: "R", numeric: true, render: b((s) => s.runs) },
    { key: "h", label: "H", numeric: true, render: b((s) => s.hits) },
    { key: "2b", label: "2B", numeric: true, render: b((s) => s.doubles) },
    { key: "3b", label: "3B", numeric: true, render: b((s) => s.triples) },
    { key: "hr", label: "HR", numeric: true, render: b((s) => s.homeRuns) },
    { key: "rbi", label: "RBI", numeric: true, render: b((s) => s.rbi) },
    { key: "bb", label: "BB", numeric: true, render: b((s) => s.walks) },
    { key: "so", label: "SO", numeric: true, render: b((s) => s.strikeouts) },
    { key: "sb", label: "SB", numeric: true, render: b((s) => s.stolenBases) },
  ];
  return (
    <DataTable
      rows={entries.filter((g) => g.batting)}
      columns={columns}
      rowKey={(g) => `b-${g.gameId}`}
      caption="Batting game log"
      emptyMessage="No batting game lines at this level."
    />
  );
}

export function PitchingGameLog({
  entries,
  level,
}: {
  entries: GameLogEntry[];
  level?: LevelId;
}) {
  const p =
    (get: (s: PitchingAggregate) => number | null) => (g: GameLogEntry) =>
      g.pitching ? (get(g.pitching) ?? dash) : dash;
  const columns: Column<GameLogEntry>[] = [
    ...gameContext(level),
    {
      key: "ip",
      label: "IP",
      numeric: true,
      render: (g) =>
        g.pitching ? inningsFromOuts(g.pitching.outsRecorded) : dash,
    },
    { key: "bf", label: "BF", numeric: true, render: p((s) => s.battersFaced) },
    { key: "h", label: "H", numeric: true, render: p((s) => s.hitsAllowed) },
    { key: "r", label: "R", numeric: true, render: p((s) => s.runs) },
    { key: "er", label: "ER", numeric: true, render: p((s) => s.earnedRuns) },
    {
      key: "hr",
      label: "HR",
      numeric: true,
      render: p((s) => s.homeRunsAllowed),
    },
    { key: "bb", label: "BB", numeric: true, render: p((s) => s.walks) },
    { key: "k", label: "K", numeric: true, render: p((s) => s.strikeouts) },
    { key: "np", label: "NP", numeric: true, render: p((s) => s.pitches) },
  ];
  return (
    <DataTable
      rows={entries.filter((g) => g.pitching)}
      columns={columns}
      rowKey={(g) => `p-${g.gameId}`}
      caption="Pitching game log"
      emptyMessage="No pitching game lines at this level."
    />
  );
}

export function RosterHistoryTable({
  rows,
  level,
}: {
  rows: AflPlayerProfile["rosterHistory"];
  level?: LevelId;
}) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => `${r.teamId}-${r.organizationId}-${r.rosterStatus}`}
      caption="Source roster observations for this level and season"
      emptyMessage="No source roster observations recorded for this player."
      columns={[
        {
          key: "first",
          label: "First observed",
          render: (r) => (
            <time dateTime={r.firstObservedAt}>
              {shortDate(r.firstObservedAt.slice(0, 10))}
            </time>
          ),
        },
        {
          key: "last",
          label: "Last observed",
          render: (r) => (
            <time dateTime={r.lastObservedAt}>
              {shortDate(r.lastObservedAt.slice(0, 10))}
            </time>
          ),
        },
        {
          key: "team",
          label: "Team",
          render: (r) =>
            r.team ? <AflTeamLink team={r.team} full level={level} /> : dash,
        },
        {
          key: "org",
          label: "Observed organization",
          render: (r) =>
            r.organization ? (
              <AflOrganizationLink organization={r.organization} full />
            ) : (
              "Unresolved"
            ),
        },
        {
          key: "status",
          label: "Roster status",
          render: (r) => r.rosterStatus ?? dash,
        },
      ]}
    />
  );
}
