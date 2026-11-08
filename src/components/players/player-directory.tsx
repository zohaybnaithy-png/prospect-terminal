"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition, type MouseEvent } from "react";
import type { Role } from "@/analytics/config";
import {
  MIN_SAMPLE_OPTIONS,
  POSITION_GROUP_LABELS,
  STAT_WINDOWS,
  STAT_WINDOW_LABELS,
  type EntityRef,
  type PlayerDirectoryRow,
  type PositionGroup,
  type StatWindow,
} from "@/services/players/directory";
import {
  DIRECTORY_PAGE_SIZES,
  DIRECTORY_SORTS,
  QUERY_MAX_LENGTH,
  directorySearch,
  hasActiveFilters,
  pageList,
  type DirectorySort,
  type DirectoryState,
} from "@/services/players/directory-query";
import { LEVELS, type LevelId } from "@/services/players/levels";
import {
  formatFixed,
  formatPct,
  formatRate,
  inningsFromOuts,
} from "@/services/afl/format";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PlayerLink } from "@/components/ui/entity-links";
import { MomentumValue } from "@/components/analytics/momentum-parts";

export type { DirectoryState } from "@/services/players/directory-query";

type Row = PlayerDirectoryRow;

const confidenceText = { low: "low", medium: "medium", high: "high" } as const;

const levelDef = (id: LevelId) => LEVELS.find((l) => l.id === id);

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
  };
}

/** Player, then Momentum (the default sort, visible without scrolling on phones), then context. */
function contextColumns(role: Role, short: string): Column<Row>[] {
  return [
    {
      key: "player",
      label: "Player",
      render: (r) => <PlayerLink player={r} level={r.level} />,
    },
    momentumColumn(role, short),
    { key: "pos", label: "Pos", render: (r) => r.position },
    { key: "age", label: "Age", numeric: true, render: (r) => r.age ?? "—" },
    {
      key: "lvl",
      label: "Lvl",
      title:
        "Level the row's statistics and Momentum come from; other 2026 levels with games in this window are listed beside it",
      render: (r) => {
        const others = r.levels.filter((l) => l !== r.level);
        return (
          <>
            <span className="level-tag" title={levelDef(r.level)?.label}>
              {levelDef(r.level)?.short ?? "—"}
            </span>
            {others.length > 0 && (
              <span
                className="level-also"
                title={`Also played at: ${others.map((o) => levelDef(o)?.label).join(", ")}`}
              >
                + {others.map((o) => levelDef(o)?.short).join(", ")}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "team",
      label: "Team",
      render: (r) =>
        r.team ? <span title={r.team.name}>{r.team.abbreviation}</span> : "—",
    },
    {
      key: "org",
      label: "Org",
      title: "MLB parent organization from the latest source roster observation",
      render: (r) =>
        r.organization ? (
          <span title={r.organization.name}>{r.organization.abbreviation}</span>
        ) : (
          "—"
        ),
    },
  ];
}

const num = (
  key: string,
  label: string,
  get: (r: Row) => number | null,
  format: (v: number | null) => string | number = (v) => v ?? "—",
  title?: string,
): Column<Row> => ({ key, label, title, numeric: true, render: (r) => format(get(r)) });
const fx2 = (v: number | null) => formatFixed(v, 2);

function hitterColumns(short: string): Column<Row>[] {
  const b = (r: Row) => r.batting!;
  return [
    ...contextColumns("hitter", short),
    num("g", "G", (r) => b(r).gameLines, undefined, "Games with a batting line"),
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
    ...contextColumns("pitcher", short),
    num("g", "G", (r) => p(r).gameLines, undefined, "Games with a pitching line"),
    {
      key: "ip",
      label: "IP",
      numeric: true,
      render: (r) => inningsFromOuts(p(r).outsRecorded),
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

/** Plain left clicks are handled in-app (with pending feedback); modified clicks open normally. */
const plainClick = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Player directory controls and one page of rows. The server owns the query (filters, sort,
 * pagination; see services/players/directory-query): every control changes the URL, and the page
 * re-renders on the server with the new rows. The current table stays visible, dimmed and marked
 * busy, until they arrive. Links and a GET form keep it usable without JavaScript.
 */
export function PlayerDirectory({
  state,
  rows,
  offset,
  matched,
  total,
  page,
  pageCount,
  sort,
  momentumShort,
  teams,
  organizations,
  positions,
  levels,
  unavailableLevels = [],
}: {
  state: DirectoryState;
  /** The current page of rows (server-filtered and sorted). */
  rows: Row[];
  offset: number;
  matched: number;
  total: number;
  page: number;
  pageCount: number;
  sort: DirectorySort;
  momentumShort: string;
  teams: EntityRef[];
  organizations: EntityRef[];
  positions: PositionGroup[];
  /** Levels with ingested data. */
  levels: LevelId[];
  /** Levels whose data failed to load in this request (temporary). */
  unavailableLevels?: LevelId[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The search box is local while typing; the URL follows after a short pause. `sent` is the last
  // query this component asked for, so the server's echo of it never overwrites newer typing,
  // while a query from elsewhere (header search, back button) does replace the text.
  const [text, setText] = useState(state.query);
  const [sent, setSent] = useState(state.query);
  const [seen, setSeen] = useState(state.query);
  if (state.query !== seen) {
    setSeen(state.query);
    if (state.query !== sent) {
      setSent(state.query);
      setText(state.query);
    }
  }

  const href = (patch: Partial<DirectoryState>) =>
    `/players${directorySearch({ ...state, page: 1, ...patch })}`;
  const navigate = (patch: Partial<DirectoryState>, replace = false) => {
    const url = href(patch);
    startTransition(() =>
      replace ? router.replace(url, { scroll: false }) : router.push(url, { scroll: false }),
    );
  };
  const linkTo = (patch: Partial<DirectoryState>, scrollToTable = false) => ({
    href: href(patch),
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      navigate(patch);
      if (scrollToTable) e.currentTarget.closest(".directory")?.scrollIntoView({ block: "start" });
    },
  });
  const submitQuery = (value: string) => {
    clearTimeout(timer.current);
    const q = value.trim().slice(0, QUERY_MAX_LENGTH);
    if (q === state.query) return;
    setSent(q);
    navigate({ query: q }, true);
  };

  const columns = useMemo(() => {
    const cols =
      state.role === "hitter" ? hitterColumns(momentumShort) : pitcherColumns(momentumShort);
    // Sortable columns are exactly the server's sort keys.
    return cols.map((c) => ({ ...c, sortable: c.key in DIRECTORY_SORTS[state.role] }));
  }, [state.role, momentumShort]);
  const column = columns.find((c) => c.key === sort.key);
  const ranked: Column<Row>[] = [
    {
      key: "rank",
      label: "#",
      numeric: true,
      render: (r) => offset + rows.indexOf(r) + 1,
    },
    ...columns,
  ];
  const active = hasActiveFilters(state);
  const filterCount = [state.teamId, state.organizationId, state.position, state.minSample].filter(
    Boolean,
  ).length;
  const clear = () => {
    clearTimeout(timer.current);
    setText("");
    setSent("");
    navigate({ query: "", teamId: "", organizationId: "", position: "", minSample: 0 });
  };
  const roleLabel = state.role === "hitter" ? "hitters" : "pitchers";

  return (
    <section
      className={pending ? "explorer directory is-pending" : "explorer directory"}
      aria-label="Player directory"
      aria-busy={pending || undefined}
    >
      <form
        action="/players"
        method="get"
        className="directory-controls"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submitQuery(text);
        }}
      >
        {/* Server scopes not represented by a form field (for the no-JavaScript submit). */}
        {state.role === "pitcher" && <input type="hidden" name="role" value="pitchers" />}
        {state.level && <input type="hidden" name="level" value={state.level} />}
        {state.sort && (
          <>
            <input type="hidden" name="sort" value={state.sort.key} />
            <input type="hidden" name="dir" value={state.sort.direction} />
          </>
        )}
        <div className="directory-primary">
          <nav className="button-group" aria-label="Hitters or pitchers">
            {(["hitter", "pitcher"] as const).map((r) => (
              <Link
                key={r}
                className="button-link"
                aria-current={state.role === r ? "page" : undefined}
                {...linkTo({ role: r, position: "", sort: state.sort?.key === "mom" ? state.sort : null })}
              >
                {r === "hitter" ? "Hitters" : "Pitchers"}
              </Link>
            ))}
          </nav>
          <nav className="button-group directory-levels" aria-label="Level">
            <Link
              className="button-link"
              aria-current={state.level === "" ? "page" : undefined}
              {...linkTo({ level: "", teamId: "" })}
            >
              All levels
            </Link>
            {LEVELS.map((l) =>
              levels.includes(l.id) ? (
                <Link
                  key={l.id}
                  className="button-link"
                  title={l.label}
                  aria-current={state.level === l.id ? "page" : undefined}
                  {...linkTo({ level: l.id, teamId: "" })}
                >
                  {l.short}
                </Link>
              ) : (
                <span
                  key={l.id}
                  className="button-link disabled"
                  aria-disabled="true"
                  title={`${l.label} — ${unavailableLevels.includes(l.id) ? "temporarily unavailable" : "not ingested"}`}
                >
                  {l.short}
                </span>
              ),
            )}
          </nav>
          <label className="search-label directory-search">
            <span className="sr-only">Search players</span>
            <input
              type="search"
              name="q"
              value={text}
              maxLength={QUERY_MAX_LENGTH}
              autoComplete="off"
              onChange={(e) => {
                const v = e.target.value;
                setText(v);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => submitQuery(v), SEARCH_DEBOUNCE_MS);
              }}
              placeholder="Search player, team, organization"
              aria-label="Search player, team, or organization"
            />
          </label>
          <button
            type="button"
            className="filters-toggle"
            aria-expanded={filtersOpen}
            aria-controls="directory-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            Filters{filterCount ? ` (${filterCount})` : ""}
          </button>
        </div>
        <div
          id="directory-filters"
          className={filtersOpen ? "directory-filters is-open" : "directory-filters"}
        >
          <label className="filter-group">
            <span>Team</span>
            <select
              name="team"
              value={state.teamId}
              onChange={(e) => navigate({ teamId: e.target.value })}
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
              name="org"
              value={state.organizationId}
              onChange={(e) => navigate({ organizationId: e.target.value })}
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
              name="pos"
              value={state.position}
              onChange={(e) => navigate({ position: e.target.value as PositionGroup | "" })}
            >
              <option value="">All positions</option>
              {positions.map((p) => (
                <option key={p} value={p}>
                  {POSITION_GROUP_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-group">
            <span>Min. {state.role === "hitter" ? "PA" : "BF"}</span>
            <select
              name="min"
              value={state.minSample}
              onChange={(e) => navigate({ minSample: Number(e.target.value) })}
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
              name="window"
              value={state.window}
              onChange={(e) => navigate({ window: e.target.value as StatWindow })}
            >
              {STAT_WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {STAT_WINDOW_LABELS[w]}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-group">
            <span>Rows</span>
            <select
              name="size"
              value={state.pageSize}
              onChange={(e) => navigate({ pageSize: Number(e.target.value) })}
            >
              {DIRECTORY_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </select>
          </label>
          <noscript>
            <button type="submit" className="apply-button">
              Apply
            </button>
          </noscript>
          {active && (
            <button type="button" className="reset-button" onClick={clear}>
              Clear filters
            </button>
          )}
        </div>
      </form>
      <p className="directory-count" aria-live="polite">
        {matched ? (
          <>
            <strong>
              {(offset + 1).toLocaleString()}–{(offset + rows.length).toLocaleString()}
            </strong>{" "}
            of <strong>{matched.toLocaleString()}</strong> {roleLabel}
            {matched !== total && ` (filtered from ${total.toLocaleString()})`}
          </>
        ) : (
          <>
            <strong>0</strong> {roleLabel}
          </>
        )}
        {" · "}
        {state.level ? levelDef(state.level)?.label : "all levels"} ·{" "}
        {STAT_WINDOW_LABELS[state.window]} · sorted by {column?.label ?? "Momentum"}
        {sort.direction === "desc" ? " ↓" : " ↑"}
        {pending && <span className="updating"> · updating…</span>}
      </p>
      <DataTable
        rows={rows}
        columns={ranked}
        rowKey={(r) => r.id}
        caption={`${state.role === "hitter" ? "Batting" : "Pitching"} statistics and Momentum, page ${page} of ${pageCount}`}
        sort={sort}
        onSort={(key) =>
          navigate({
            sort: {
              key,
              direction: sort.key === key && sort.direction === "desc" ? "asc" : "desc",
            },
          })
        }
        emptyMessage={
          active
            ? "No players match these filters. Clear a filter or broaden the search."
            : "No players have game lines in this timeframe."
        }
      />
      {pageCount > 1 && (
        <nav className="pagination" aria-label="Pages">
          {page > 1 ? (
            <Link {...linkTo({ page: page - 1 }, true)} rel="prev">
              ← Previous
            </Link>
          ) : (
            <span aria-disabled="true">← Previous</span>
          )}
          <span className="pagination-pages">
            {pageList(page, pageCount).map((p, i) =>
              p === null ? (
                <span key={`gap-${i}`} aria-hidden="true">
                  …
                </span>
              ) : p === page ? (
                <span key={p} aria-current="page">
                  {p}
                </span>
              ) : (
                <Link key={p} {...linkTo({ page: p }, true)} aria-label={`Page ${p}`}>
                  {p}
                </Link>
              ),
            )}
          </span>
          {page < pageCount ? (
            <Link {...linkTo({ page: page + 1 }, true)} rel="next">
              Next →
            </Link>
          ) : (
            <span aria-disabled="true">Next →</span>
          )}
        </nav>
      )}
    </section>
  );
}
