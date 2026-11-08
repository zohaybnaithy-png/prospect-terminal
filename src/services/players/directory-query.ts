/**
 * Player directory query: URL state ⇄ filters, sort and pagination (pure, client-safe).
 *
 * The directory used to send every row of a scope to the browser (2,483 hitters ≈ 2.3 MB of HTML)
 * and filter there. The server now runs the query and sends one page; the URL carries the whole
 * state, so every view is shareable and works without JavaScript. Filtering and ordering are the
 * same as before: filters from ./directory, then playing time and name as the base order, then a
 * stable sort on the chosen column with unavailable values last.
 */
import type { Role } from "@/analytics/config";
import { sortByValue } from "@/lib/table-sort";
import {
  MIN_SAMPLE_OPTIONS,
  STAT_WINDOWS,
  filterDirectory,
  type EntityRef,
  type PlayerDirectoryRow,
  type PositionGroup,
  type StatWindow,
} from "./directory";
import { LEVELS, isLevelId, type LevelId } from "./levels";

type Row = PlayerDirectoryRow;

export interface DirectorySort {
  key: string;
  direction: "asc" | "desc";
}

export interface DirectoryState {
  role: Role;
  level: LevelId | "";
  window: StatWindow;
  query: string;
  teamId: string;
  organizationId: string;
  position: PositionGroup | "";
  /** Minimum PA (hitters) or BF (pitchers); a display filter, not a qualification model. */
  minSample: number;
  /** null = default order (Momentum, then playing time). */
  sort: DirectorySort | null;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export const DIRECTORY_PAGE_SIZES = [50, 100, 250] as const;
export const DEFAULT_PAGE_SIZE = 100;
export const QUERY_MAX_LENGTH = 80;

/** Momentum desc (unavailable last), then playing time — trending players first. */
export const DEFAULT_SORT: DirectorySort = { key: "mom", direction: "desc" };

type SortValue = (r: Row) => string | number | null;

const levelIndex = (id: LevelId) => LEVELS.findIndex((l) => l.id === id);

const CONTEXT_SORTS: Record<string, SortValue> = {
  player: (r) => r.name,
  pos: (r) => r.position,
  age: (r) => r.age,
  lvl: (r) => levelIndex(r.level),
  team: (r) => r.team?.abbreviation ?? null,
  org: (r) => r.organization?.abbreviation ?? null,
};

const bat = (get: (b: NonNullable<Row["batting"]>) => number | null): SortValue => (r) =>
  r.batting ? get(r.batting) : null;
const pit = (get: (p: NonNullable<Row["pitching"]>) => number | null): SortValue => (r) =>
  r.pitching ? get(r.pitching) : null;

/** Column key → sort value, per role. The table's sortable columns are exactly these keys. */
export const DIRECTORY_SORTS: Record<Role, Record<string, SortValue>> = {
  hitter: {
    ...CONTEXT_SORTS,
    mom: (r) => r.momentum.hitter?.score ?? null,
    g: bat((b) => b.gameLines),
    pa: bat((b) => b.plateAppearances),
    ab: bat((b) => b.atBats),
    h: bat((b) => b.hits),
    "2b": bat((b) => b.doubles),
    "3b": bat((b) => b.triples),
    hr: bat((b) => b.homeRuns),
    r: bat((b) => b.runs),
    rbi: bat((b) => b.rbi),
    bb: bat((b) => b.walks),
    so: bat((b) => b.strikeouts),
    sb: bat((b) => b.stolenBases),
    avg: bat((b) => b.avg),
    obp: bat((b) => b.obp),
    slg: bat((b) => b.slg),
    ops: bat((b) => b.ops),
    bbp: bat((b) => b.bbPct),
    kp: bat((b) => b.kPct),
  },
  pitcher: {
    ...CONTEXT_SORTS,
    mom: (r) => r.momentum.pitcher?.score ?? null,
    g: pit((p) => p.gameLines),
    ip: pit((p) => p.outsRecorded),
    bf: pit((p) => p.battersFaced),
    h: pit((p) => p.hitsAllowed),
    er: pit((p) => p.earnedRuns),
    hr: pit((p) => p.homeRunsAllowed),
    bb: pit((p) => p.walks),
    k: pit((p) => p.strikeouts),
    era: pit((p) => p.era),
    whip: pit((p) => p.whip),
    kp: pit((p) => p.kPct),
    bbp: pit((p) => p.bbPct),
    kbb: pit((p) => (p.kPct !== null && p.bbPct !== null ? p.kPct - p.bbPct : null)),
  },
};

export const opportunities = (r: Row, role: Role) =>
  role === "hitter" ? (r.batting?.plateAppearances ?? 0) : (r.pitching?.battersFaced ?? 0);

/** The sort actually applied: an unknown key (e.g. a hitter column on pitchers) falls back. */
export const resolveSort = (state: Pick<DirectoryState, "role" | "sort">): DirectorySort =>
  state.sort && DIRECTORY_SORTS[state.role][state.sort.key] ? state.sort : DEFAULT_SORT;

export interface DirectoryResult {
  /** The requested page only. */
  rows: Row[];
  /** Rank of the first row on the page minus one. */
  offset: number;
  /** Rows matching the filters. */
  matched: number;
  /** Rows in the scope (role, level, window) before filters. */
  total: number;
  page: number;
  pageCount: number;
  sort: DirectorySort;
}

export function queryDirectory(rows: Row[], state: DirectoryState): DirectoryResult {
  const filtered = filterDirectory(rows, state).filter(
    (r) => opportunities(r, state.role) >= state.minSample,
  );
  const sort = resolveSort(state);
  // Secondary order: playing time, then name — so ties and unavailable values stay sensible.
  const base = [...filtered].sort(
    (a, b) =>
      opportunities(b, state.role) - opportunities(a, state.role) || a.name.localeCompare(b.name),
  );
  const sorted = sortByValue(base, DIRECTORY_SORTS[state.role][sort.key], sort.direction);
  const pageCount = Math.max(1, Math.ceil(sorted.length / state.pageSize));
  const page = Math.min(Math.max(1, state.page), pageCount);
  const offset = (page - 1) * state.pageSize;
  return {
    rows: sorted.slice(offset, offset + state.pageSize),
    offset,
    matched: sorted.length,
    total: rows.length,
    page,
    pageCount,
    sort,
  };
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORT_KEY = /^[a-z0-9]{1,8}$/;

/** Role, level and window: they choose which rows are built, so they are parsed first. */
export function parseDirectoryScope(params: Params, available: LevelId[]) {
  const requested = one(params.level);
  return {
    role: (one(params.role) === "pitchers" ? "pitcher" : "hitter") as Role,
    level: (isLevelId(requested) && available.includes(requested) ? requested : "") as LevelId | "",
    requestedLevel: requested,
    window: STAT_WINDOWS.find((w) => w === one(params.window)) ?? ("season" as StatWindow),
  };
}

/**
 * Full state. Context filters only apply when they occur in the scope (e.g. a team from another
 * level is dropped); malformed values fall back to defaults instead of erroring.
 */
export function parseDirectoryState(
  params: Params,
  scope: ReturnType<typeof parseDirectoryScope>,
  options: { teams: EntityRef[]; organizations: EntityRef[]; positions: PositionGroup[] },
): DirectoryState {
  const teamId = UUID.test(one(params.team)) ? one(params.team) : "";
  const organizationId = UUID.test(one(params.org)) ? one(params.org) : "";
  const position = one(params.pos) as PositionGroup;
  const sortKey = one(params.sort);
  const size = DIRECTORY_PAGE_SIZES.find((n) => String(n) === one(params.size));
  const page = Number.parseInt(one(params.page), 10);
  return {
    role: scope.role,
    level: scope.level,
    window: scope.window,
    query: one(params.q).trim().slice(0, QUERY_MAX_LENGTH),
    teamId: options.teams.some((t) => t.id === teamId) ? teamId : "",
    organizationId: options.organizations.some((o) => o.id === organizationId)
      ? organizationId
      : "",
    position: options.positions.includes(position) ? position : "",
    minSample: MIN_SAMPLE_OPTIONS.find((n) => String(n) === one(params.min)) ?? 0,
    sort: SORT_KEY.test(sortKey)
      ? { key: sortKey, direction: one(params.dir) === "asc" ? "asc" : "desc" }
      : null,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: size ?? DEFAULT_PAGE_SIZE,
  };
}

/** Canonical query string ("" or "?…"); defaults are omitted so URLs stay short. */
export function directorySearch(state: DirectoryState) {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.role === "pitcher") params.set("role", "pitchers");
  if (state.level) params.set("level", state.level);
  if (state.teamId) params.set("team", state.teamId);
  if (state.organizationId) params.set("org", state.organizationId);
  if (state.position) params.set("pos", state.position);
  if (state.minSample) params.set("min", String(state.minSample));
  if (state.window !== "season") params.set("window", state.window);
  if (state.sort) {
    params.set("sort", state.sort.key);
    params.set("dir", state.sort.direction);
  }
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(state.pageSize));
  if (state.page > 1) params.set("page", String(state.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const hasActiveFilters = (s: DirectoryState) =>
  Boolean(s.query || s.teamId || s.organizationId || s.position || s.minSample);

/**
 * Page numbers to show: first, last, and two either side of the current page (null = gap). A gap
 * that would hide a single page shows that page instead.
 */
export function pageList(page: number, count: number): (number | null)[] {
  const shown = (p: number) => p === 1 || p === count || Math.abs(p - page) <= 2;
  const out: (number | null)[] = [];
  for (let p = 1; p <= count; p++) {
    if (shown(p) || (shown(p - 1) && shown(p + 1) && p > 1 && p < count)) out.push(p);
    else if (out.at(-1) !== null) out.push(null);
  }
  return out;
}
