/**
 * Level-agnostic player directory model (client-safe: types, filters, options; no analytics).
 *
 * `PlayerDirectoryRow` is the contract the Players page renders. Today the only adapter is
 * `aflDirectoryRows` in ./afl-adapter (real AFL data). When MiLB ingestion lands, an adapter that
 * maps its normalized read model onto the same row shape (with level "aaa" / "aa" / "high-a" /
 * "single-a") plugs in without changing the page. Pure functions only: no I/O.
 */
import type { MomentumWindow, Role } from "@/analytics/config";
import type { ConfidenceLevel } from "@/analytics/momentum";
import type {
  BattingAggregate,
  PitchingAggregate,
} from "@/services/afl/read-model";
import type { LevelId } from "./levels";

export type StatWindow = "7d" | "14d" | "30d" | "season";

export const STAT_WINDOWS: StatWindow[] = ["season", "30d", "14d", "7d"];
export const STAT_WINDOW_LABELS: Record<StatWindow, string> = {
  season: "Season",
  "30d": "Last 30 days",
  "14d": "Last 14 days",
  "7d": "Last 7 days",
};

/** Momentum has 7D/14D/30D windows; a season stat view pairs with the default 14D Momentum. */
export function momentumWindowFor(window: StatWindow): MomentumWindow {
  return window === "season" ? "14d" : window;
}

export interface EntityRef {
  id: string;
  name: string;
  abbreviation: string;
}

export interface MomentumCell {
  score: number | null;
  band: string | null;
  direction: "up" | "down" | "flat" | null;
  confidence: ConfidenceLevel | null;
  /** Recent / earlier sample in PA (hitters) or BF (pitchers). */
  sample: { recent: number; baseline: number; unit: string } | null;
}

export interface PlayerDirectoryRow {
  id: string;
  name: string;
  /** Display position, e.g. "SS" or "P / OF". */
  position: string;
  positionGroup: PositionGroup;
  age: number | null;
  level: LevelId;
  team: EntityRef | null;
  organization: EntityRef | null;
  batting: BattingAggregate | null;
  pitching: PitchingAggregate | null;
  momentum: Partial<Record<Role, MomentumCell>>;
}

export type PositionGroup =
  | "C"
  | "1B"
  | "2B"
  | "3B"
  | "SS"
  | "OF"
  | "DH"
  | "P"
  | "TWP"
  | "UT";

export const POSITION_GROUP_LABELS: Record<PositionGroup, string> = {
  C: "C",
  "1B": "1B",
  "2B": "2B",
  "3B": "3B",
  SS: "SS",
  OF: "OF",
  DH: "DH",
  P: "P",
  TWP: "Two-way",
  UT: "Utility",
};
const GROUP_ORDER: PositionGroup[] = [
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "OF",
  "DH",
  "UT",
  "P",
  "TWP",
];

/** Maps a source primary position abbreviation onto a filter group. */
export function positionGroup(primary: string): PositionGroup {
  const p = primary.toUpperCase();
  if (["LF", "CF", "RF", "OF"].includes(p)) return "OF";
  if (["P", "SP", "RP", "LHP", "RHP"].includes(p)) return "P";
  if (p === "TWP") return "TWP";
  if (["C", "1B", "2B", "3B", "SS", "DH"].includes(p))
    return p as PositionGroup;
  return "UT";
}

export const sortPositionGroups = (groups: Iterable<PositionGroup>) =>
  [...new Set(groups)].sort(
    (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
  );

/** Minimum PA (hitters) / BF (pitchers) display filter choices. Not a qualification model. */
export const MIN_SAMPLE_OPTIONS = [0, 10, 25, 50] as const;

export interface DirectoryFilters {
  query?: string;
  level?: LevelId | "";
  teamId?: string;
  organizationId?: string;
  position?: PositionGroup | "";
}

/** Role filter: a two-way player appears in both lists when they have lines for both. */
export function rowsForRole(rows: PlayerDirectoryRow[], role: Role) {
  return rows.filter((r) =>
    role === "hitter" ? r.batting !== null : r.pitching !== null,
  );
}

export function filterDirectory(
  rows: PlayerDirectoryRow[],
  { query = "", level, teamId, organizationId, position }: DirectoryFilters,
) {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!level || r.level === level) &&
      (!teamId || r.team?.id === teamId) &&
      (!organizationId || r.organization?.id === organizationId) &&
      (!position || r.positionGroup === position) &&
      (!q ||
        [
          r.name,
          r.team?.name,
          r.team?.abbreviation,
          r.organization?.name,
          r.organization?.abbreviation,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
}

/** Filter menus list only values that actually occur in the rows. */
export function directoryOptions(rows: PlayerDirectoryRow[]) {
  const teams = new Map<string, EntityRef>(),
    organizations = new Map<string, EntityRef>(),
    levels = new Set<LevelId>(),
    positions: PositionGroup[] = [];
  for (const r of rows) {
    if (r.team) teams.set(r.team.id, r.team);
    if (r.organization) organizations.set(r.organization.id, r.organization);
    levels.add(r.level);
    positions.push(r.positionGroup);
  }
  const byName = (a: EntityRef, b: EntityRef) => a.name.localeCompare(b.name);
  return {
    teams: [...teams.values()].sort(byName),
    organizations: [...organizations.values()].sort(byName),
    levels,
    positions: sortPositionGroups(positions),
  };
}
