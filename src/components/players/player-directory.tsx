"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Role } from "@/analytics/config";
import {
  MIN_SAMPLE_OPTIONS,
  POSITION_GROUP_LABELS,
  STAT_WINDOWS,
  STAT_WINDOW_LABELS,
  filterDirectory,
  rowsForRole,
  sortPositionGroups,
  type EntityRef,
  type PlayerDirectoryRow,
  type PositionGroup,
  type StatWindow,
} from "@/services/players/directory";
import { LEVELS, type LevelId } from "@/services/players/levels";
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
import { MomentumValue } from "@/components/analytics/momentum-parts";
import { sortByValue } from "@/lib/table-sort";

export interface DirectoryState {
  role: Role;
  query: string;
  level: LevelId | "";
  teamId: string;
  organizationId: string;
  position: PositionGroup | "";
  /** Minimum PA (hitters) or BF (pitchers); a display filter, not a qualification model. */
  minSample: number;
  sort: TableSort | null;
}

type Row = PlayerDirectoryRow;

/** Momentum desc (unavailable last), then playing time — trending players first. */
const DEFAULT_SORT: TableSort = { key: "mom", direction: "desc" };

const confidenceText = { low: "low", medium: "medium", high: "high" } as const;

function momentumColumn(role: Role, short: string): Column<Row> {
  return {
    key: "mom",
    label: `Mom. ${short}`,
    title: `Momentum (${short}): recent performance vs. the player's own earlier games, −100 to +100. Not a quality grade.`,
    numeric: true,
    render: (r) => {
      const m = r.momentum[role];
      return (
        <span
          title={
            m?.score != null
              ? `${m.band} · ${confidenceText[m.confidence!]} confidence (${m.sample!.recent} recent vs ${m.sample!.baseline} earlier ${m.sample!.unit})`
              : "Not enough recent and earlier games to compare"
          }
        >
          <MomentumValue score={m?.score ?? null} />
        </span>
      );
    },
    sortValue: (r) => r.momentum[role]?.score ?? null,
  };
}

function contextColumns(): Column<Row>[] {
  return [
    {
      key: "player",
      label: "Player",
      render: (r) => <PlayerLink player={r} />,
      sortValue: (r) => r.name,
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
    {
      key: "lvl",
      label: "Lvl",
      render: (r) => LEVELS.find((l) => l.id === r.level)?.short ?? "—",
      sortValue: (r) => LEVELS.findIndex((l) => l.id === r.level),
    },
    {
      key: "team",
      label: "Team",
      render: (r) =>
        r.team ? <span title={r.team.name}>{r.team.abbreviation}</span> : "—",
      sortValue: (r) => r.team?.abbreviation ?? null,
    },
    {
      key: "org",
      label: "Org",
      title:
        "MLB parent organization from the latest source roster observation",
      render: (r) =>
        r.organization ? (
          <span title={r.organization.name}>{r.organization.abbreviation}</span>
        ) : (
          "—"
        ),
      sortValue: (r) => r.organization?.abbreviation ?? null,
    },
  ];
}

const num = (
  key: string,
  label: string,
  get: (r: Row) => number | null,
  format: (v: number | null) => string | number = (v) => v ?? "—",
  title?: string,
): Column<Row> => ({
  key,
  label,
  title,
  numeric: true,
  render: (r) => format(get(r)),
  sortValue: get,
});
const fx2 = (v: number | null) => formatFixed(v, 2);

function hitterColumns(short: string): Column<Row>[] {
  const b = (r: Row) => r.batting!;
  return [
    ...contextColumns(),
    momentumColumn("hitter", short),
    num(
      "g",
      "G",
      (r) => b(r).gameLines,
      undefined,
      "Games with a batting line",
    ),
    num("pa", "PA", (r) => b(r).plateAppearances),
    num("ab", "AB", (r) => b(r).atBats),
    num("h", "H", (r) => b(r).hits),
    num("2b", "2B", (r) => b(r).doubles),
    num("3b", "3B", (r) => b(r).triples),
    num("hr", "HR", (r) => b(r).homeRuns),
    num("r", "R", (r) => b(r).runs),
    num("rbi", "RBI", (r) => b(r).rbi),
    num("bb", "BB", (r) => b(r).walks),
    num("so", "SO", (r) => b(r).strikeouts),
    num("sb", "SB", (r) => b(r).stolenBases),
    num("avg", "AVG", (r) => b(r).avg, formatRate),
    num("obp", "OBP", (r) => b(r).obp, formatRate),
    num("slg", "SLG", (r) => b(r).slg, formatRate),
    num("ops", "OPS", (r) => b(r).ops, formatRate),
    num("bbp", "BB%", (r) => b(r).bbPct, formatPct),
    num("kp", "K%", (r) => b(r).kPct, formatPct),
  ];
}

function pitcherColumns(short: string): Column<Row>[] {
  const p = (r: Row) => r.pitching!;
  const kbb = (r: Row) =>
    p(r).kPct !== null && p(r).bbPct !== null ? p(r).kPct! - p(r).bbPct! : null;
  return [
    ...contextColumns(),
    momentumColumn("pitcher", short),
    num(
      "g",
      "G",
      (r) => p(r).gameLines,
      undefined,
      "Games with a pitching line",
    ),
    {
      key: "ip",
      label: "IP",
      numeric: true,
      render: (r) => inningsFromOuts(p(r).outsRecorded),
      sortValue: (r) => p(r).outsRecorded,
    },
    num("bf", "BF", (r) => p(r).battersFaced),
    num("h", "H", (r) => p(r).hitsAllowed),
    num("er", "ER", (r) => p(r).earnedRuns),
    num("hr", "HR", (r) => p(r).homeRunsAllowed),
    num("bb", "BB", (r) => p(r).walks),
    num("k", "SO", (r) => p(r).strikeouts),
    num("era", "ERA", (r) => p(r).era, fx2),
    num("whip", "WHIP", (r) => p(r).whip, fx2),
    num("kp", "K%", (r) => p(r).kPct, formatPct),
    num("bbp", "BB%", (r) => p(r).bbPct, formatPct),
    num("kbb", "K−BB%", kbb, formatPct),
  ];
}

const opportunities = (r: Row, role: Role) =>
  role === "hitter"
    ? (r.batting?.plateAppearances ?? 0)
    : (r.pitching?.battersFaced ?? 0);

function toSearch(state: DirectoryState, window: StatWindow) {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.role === "pitcher") params.set("role", "pitchers");
  if (state.level) params.set("level", state.level);
  if (state.teamId) params.set("team", state.teamId);
  if (state.organizationId) params.set("org", state.organizationId);
  if (state.position) params.set("pos", state.position);
  if (state.minSample) params.set("min", String(state.minSample));
  if (window !== "season") params.set("window", window);
  if (state.sort) {
    params.set("sort", state.sort.key);
    params.set("dir", state.sort.direction);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function PlayerDirectory({
  rows,
  initial,
  window,
  momentumShort,
  teams,
  organizations,
  levels,
}: {
  rows: Row[];
  initial: DirectoryState;
  window: StatWindow;
  momentumShort: string;
  teams: EntityRef[];
  organizations: EntityRef[];
  levels: LevelId[];
}) {
  const router = useRouter();
  const [state, setState] = useState<DirectoryState>(initial);
  const update = (patch: Partial<DirectoryState>) =>
    setState((s) => ({ ...s, ...patch }));

  // Keep the URL shareable without a server round trip for client-side filters.
  useEffect(() => {
    const next = `/players${toSearch(state, window)}`;
    if (next !== `${location.pathname}${location.search}`)
      history.replaceState(null, "", next);
  }, [state, window]);

  const columns = useMemo(
    () =>
      state.role === "hitter"
        ? hitterColumns(momentumShort)
        : pitcherColumns(momentumShort),
    [state.role, momentumShort],
  );
  const sort =
    state.sort && columns.some((c) => c.key === state.sort!.key)
      ? state.sort
      : DEFAULT_SORT;
  const roleRows = rowsForRole(rows, state.role);
  const rolePositions = sortPositionGroups(
    roleRows.map((r) => r.positionGroup),
  );
  const filtered = filterDirectory(roleRows, state).filter(
    (r) => opportunities(r, state.role) >= state.minSample,
  );
  const column = columns.find((c) => c.key === sort.key)!;
  // Secondary order: playing time, then name — so ties and unavailable values stay sensible.
  const base = [...filtered].sort(
    (a, b) =>
      opportunities(b, state.role) - opportunities(a, state.role) ||
      a.name.localeCompare(b.name),
  );
  const sorted = sortByValue(base, column.sortValue!, sort.direction);
  const position = new Map(sorted.map((r, i) => [r.id, i + 1]));
  const ranked: Column<Row>[] = [
    {
      key: "rank",
      label: "#",
      numeric: true,
      render: (r) => position.get(r.id),
    },
    ...columns,
  ];
  const activeFilters = Boolean(
    state.query ||
    state.level ||
    state.teamId ||
    state.organizationId ||
    state.position ||
    state.minSample,
  );
  const clear = () =>
    update({
      query: "",
      level: "",
      teamId: "",
      organizationId: "",
      position: "",
      minSample: 0,
    });

  return (
    <section className="explorer directory" aria-label="Player directory">
      <div className="directory-controls">
        <div
          className="button-group"
          role="group"
          aria-label="Hitters or pitchers"
        >
          {(["hitter", "pitcher"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={state.role === r}
              onClick={() =>
                setState((s) => {
                  const next = rowsForRole(rows, r).map((x) => x.positionGroup);
                  return {
                    ...s,
                    role: r,
                    position:
                      s.position && next.includes(s.position) ? s.position : "",
                  };
                })
              }
            >
              {r === "hitter" ? "Hitters" : "Pitchers"}
            </button>
          ))}
        </div>
        <label className="search-label directory-search">
          <span className="sr-only">Search</span>
          <input
            type="search"
            value={state.query}
            onChange={(e) => update({ query: e.target.value.slice(0, 80) })}
            placeholder="Search player, team, organization"
            aria-label="Search player, team, or organization"
          />
        </label>
        <label className="filter-group">
          <span>Level</span>
          <select
            value={state.level}
            onChange={(e) => update({ level: e.target.value as LevelId | "" })}
          >
            <option value="">All levels</option>
            {LEVELS.map((l) => (
              <option key={l.id} value={l.id} disabled={!levels.includes(l.id)}>
                {l.short}
                {levels.includes(l.id) ? "" : " — data pending"}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-group">
          <span>Team</span>
          <select
            value={state.teamId}
            onChange={(e) => update({ teamId: e.target.value })}
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-group">
          <span>Organization</span>
          <select
            value={state.organizationId}
            onChange={(e) => update({ organizationId: e.target.value })}
          >
            <option value="">All organizations</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-group">
          <span>Position</span>
          <select
            value={state.position}
            onChange={(e) =>
              update({ position: e.target.value as PositionGroup | "" })
            }
          >
            <option value="">All positions</option>
            {rolePositions.map((p) => (
              <option key={p} value={p}>
                {POSITION_GROUP_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-group">
          <span>Min. {state.role === "hitter" ? "PA" : "BF"}</span>
          <select
            value={state.minSample}
            onChange={(e) => update({ minSample: Number(e.target.value) })}
          >
            {MIN_SAMPLE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n ? `${n}+` : "Any"}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-group">
          <span>Stats</span>
          <select
            value={window}
            onChange={(e) =>
              router.push(
                `/players${toSearch(state, e.target.value as StatWindow)}`,
                { scroll: false },
              )
            }
          >
            {STAT_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {STAT_WINDOW_LABELS[w]}
              </option>
            ))}
          </select>
        </label>
        {activeFilters && (
          <button type="button" className="reset-button" onClick={clear}>
            Clear filters
          </button>
        )}
      </div>
      <p className="directory-count" aria-live="polite">
        <strong>{filtered.length}</strong>{" "}
        {state.role === "hitter" ? "hitters" : "pitchers"}
        {filtered.length !== roleRows.length && ` of ${roleRows.length}`} ·{" "}
        {STAT_WINDOW_LABELS[window]} · sorted by {column.label}
        {sort.direction === "desc" ? " ↓" : " ↑"}
      </p>
      <DataTable
        rows={sorted}
        columns={ranked}
        rowKey={(r) => r.id}
        caption={`${state.role === "hitter" ? "Batting" : "Pitching"} statistics and Momentum`}
        sort={sort}
        onSort={(key) =>
          update({
            sort: {
              key,
              direction:
                sort.key === key && sort.direction === "desc" ? "asc" : "desc",
            },
          })
        }
        emptyMessage={
          activeFilters
            ? "No players match these filters. Clear a filter or broaden the search."
            : "No players have game lines in this timeframe."
        }
      />
    </section>
  );
}
