/**
 * Player comparison view model (server-side; pure over loaded level snapshots, no I/O).
 *
 * Everything comes from ONE level's snapshot and existing code paths, so no formula lives here:
 * - season lines and the default-window Momentum cell: `levelDirectoryRows` (the Players
 *   directory's memoized / precomputed rows);
 * - ISO, BB%, K%, K−BB%, ERA, WHIP values and their better-direction: the analytics metric
 *   registry (`metricValue`, `metricDefinition().direction`);
 * - percentile categories: the profile's `fingerprint` (PERCENTILE_CATEGORIES, same population).
 * Rows without direction metadata (counting stats, Momentum) never get a "best" marker.
 */
import { DEFAULT_MOMENTUM_MODEL, DEFAULT_MOMENTUM_WINDOW, MOMENTUM_WINDOWS, type Role } from "@/analytics/config";
import { fingerprint, type Fingerprint } from "@/analytics/engine";
import { formatMetric, metricDefinition, metricValue } from "@/analytics/metrics";
import { analyticsContextFor, requestContext } from "@/analytics/views";
import { aflAsOf, inningsFromOuts } from "@/services/afl/read-model";
import type { LevelSnapshot } from "@/services/competition/types";
import { levelDirectoryRows } from "@/services/players/adapter";
import type { EntityRef, MomentumCell, PlayerDirectoryRow } from "@/services/players/directory";
import { levelById, type LevelId } from "@/services/players/levels";
import { COMPARE_MIN, type CompareQuery } from "./query";

export interface CompareCell {
  text: string;
  /** Raw value used for the best-value comparison (null = missing). */
  value: number | null;
  best: boolean;
  /** Extra context (e.g. the Momentum sample), shown under the value. */
  detail?: string;
}

export interface CompareRow {
  id: string;
  label: string;
  title?: string;
  /** +1 higher is better, −1 lower is better, null = no direction (never emphasized). */
  direction: 1 | -1 | null;
  /** One cell per player column; null where the player has no line at this level and role. */
  cells: (CompareCell | null)[];
}

export interface CompareGroup {
  id: "season" | "percentiles" | "momentum";
  label: string;
  rows: CompareRow[];
}

export interface ComparePlayer {
  id: string;
  /** Null when the id is not a player anywhere in the loaded data. */
  name: string | null;
  position: string | null;
  age: number | null;
  team: EntityRef | null;
  organization: EntityRef | null;
  /** True when the player has a line for the role at this level (has a column of values). */
  available: boolean;
  /** Why there are no values (e.g. "No Double-A batting line"), when not available. */
  notice: string | null;
  /** PA (hitters) or BF (pitchers) at this level; the sample size every value rests on. */
  opportunities: number | null;
  /** Below the percentile population's minimum sample. */
  percentileQualified: boolean | null;
}

export type CompareView =
  | { status: "no-level"; query: CompareQuery }
  | { status: "level-unavailable"; query: CompareQuery; level: LevelId }
  | { status: "too-few"; query: CompareQuery; level: LevelId; players: ComparePlayer[] }
  | {
      status: "ok";
      query: CompareQuery;
      level: LevelId;
      role: Role;
      seasonName: string;
      asOf: string | null;
      players: ComparePlayer[];
      groups: CompareGroup[];
      percentilePopulation: { size: number; minOpportunities: number } | null;
      momentumWindowLabel: string;
    };

/** Digits a value is shown with, so a "best" marker never separates values that display equal. */
const DIGITS = { rate3: 3, pct1: 1, fixed2: 2, ratio2: 2 } as const;

/**
 * Indexes of the best value in a row. Only when at least two players have a value and they are
 * not all equal (after rounding to the displayed precision); ties for best are all marked.
 */
export function bestIndexes(values: (number | null)[], direction: 1 | -1 | null, digits = 3): Set<number> {
  const out = new Set<number>();
  if (direction === null) return out;
  const scale = 10 ** digits;
  const rounded = values.map((v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * scale) / scale));
  const present = rounded.filter((v): v is number => v !== null);
  if (present.length < 2) return out;
  const best = direction === 1 ? Math.max(...present) : Math.min(...present);
  if (present.every((v) => v === best)) return out;
  rounded.forEach((v, i) => v === best && out.add(i));
  return out;
}

const ordinal = (n: number) => {
  const r = Math.round(n);
  const s = r % 100 >= 11 && r % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[r % 10] ?? "th";
  return `${r}${s}`;
};
const count = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));
const signedScore = (s: number) => `${s > 0 ? "+" : s < 0 ? "−" : ""}${Math.abs(s)}`;

type Sample = NonNullable<PlayerDirectoryRow["batting"]> | NonNullable<PlayerDirectoryRow["pitching"]>;
interface RowSpec {
  id: string;
  label: string;
  title?: string;
  /** Analytics metric id: value, format and direction come from the registry. */
  metric?: string;
  /** Counting / sample rows (no direction metadata). */
  raw?: (s: Sample) => { text: string; value: number | null };
}

const bat = (f: (s: NonNullable<PlayerDirectoryRow["batting"]>) => number | null) => (s: Sample) => {
  const v = f(s as NonNullable<PlayerDirectoryRow["batting"]>);
  return { text: count(v), value: v };
};
const pit = (f: (s: NonNullable<PlayerDirectoryRow["pitching"]>) => number | null) => (s: Sample) => {
  const v = f(s as NonNullable<PlayerDirectoryRow["pitching"]>);
  return { text: count(v), value: v };
};

/** Season-line rows per role (the order they are shown). */
export const SEASON_ROWS: Record<Role, RowSpec[]> = {
  hitter: [
    { id: "g", label: "G", title: "Games with a batting line", raw: bat((s) => s.gameLines) },
    { id: "pa", label: "PA", title: "Plate appearances (sample size)", raw: bat((s) => s.plateAppearances) },
    { id: "avg", label: "AVG", metric: "avg" },
    { id: "obp", label: "OBP", metric: "obp" },
    { id: "slg", label: "SLG", metric: "slg" },
    { id: "ops", label: "OPS", metric: "ops" },
    { id: "iso", label: "ISO", title: "Isolated power (SLG − AVG)", metric: "iso" },
    { id: "bbPct", label: "BB%", title: "Walks per plate appearance", metric: "hitterBbPct" },
    { id: "kPct", label: "K%", title: "Strikeouts per plate appearance", metric: "hitterKPct" },
    { id: "hr", label: "HR", title: "Home runs", raw: bat((s) => s.homeRuns) },
    { id: "sb", label: "SB", title: "Stolen bases", raw: bat((s) => s.stolenBases) },
  ],
  pitcher: [
    { id: "g", label: "G", title: "Games with a pitching line", raw: pit((s) => s.gameLines) },
    {
      id: "ip",
      label: "IP",
      title: "Innings pitched",
      raw: (s) => {
        const outs = (s as NonNullable<PlayerDirectoryRow["pitching"]>).outsRecorded;
        return { text: inningsFromOuts(outs), value: outs };
      },
    },
    { id: "bf", label: "BF", title: "Batters faced (sample size)", raw: pit((s) => s.battersFaced) },
    { id: "era", label: "ERA", metric: "era" },
    { id: "whip", label: "WHIP", metric: "whip" },
    { id: "kPct", label: "K%", title: "Strikeouts per batter faced", metric: "pitcherKPct" },
    { id: "bbPct", label: "BB%", title: "Walks per batter faced", metric: "pitcherBbPct" },
    { id: "kbb", label: "K−BB%", title: "K% minus BB%", metric: "kMinusBbPct" },
    { id: "hr", label: "HR", title: "Home runs allowed", raw: pit((s) => s.homeRunsAllowed) },
  ],
};

const ROLE_LINE: Record<Role, string> = { hitter: "batting", pitcher: "pitching" };

function sampleOf(row: PlayerDirectoryRow | undefined, role: Role): Sample | null {
  if (!row) return null;
  return role === "hitter" ? row.batting : row.pitching;
}

/** Name of a player from any loaded level (one identity across levels), for notices. */
function anyName(levels: LevelSnapshot[], id: string) {
  for (const ls of levels) {
    const p = ls.snapshot.players.find((x) => x.id === id);
    if (p) return p.name;
  }
  return null;
}

function seasonRow(spec: RowSpec, samples: (Sample | null)[]): CompareRow {
  if (spec.metric) {
    const def = metricDefinition(spec.metric);
    const values = samples.map((s) => (s ? metricValue(spec.metric!, s) : null));
    const best = bestIndexes(values, def.direction, DIGITS[def.format]);
    return {
      id: spec.id,
      label: spec.label,
      title: spec.title,
      direction: def.direction,
      cells: samples.map((s, i) => (s ? { text: formatMetric(spec.metric!, values[i]), value: values[i], best: best.has(i) } : null)),
    };
  }
  return {
    id: spec.id,
    label: spec.label,
    title: spec.title,
    direction: null,
    cells: samples.map((s) => (s ? { ...spec.raw!(s), best: false } : null)),
  };
}

function percentileRows(prints: (Fingerprint | null)[], role: Role): CompareRow[] {
  const first = prints.find((f): f is Fingerprint => f !== null);
  if (!first) return [];
  const unit = role === "hitter" ? "PA" : "BF";
  const sampleRow: CompareRow = {
    id: "pct-sample",
    label: "Percentile sample",
    title: `Percentiles are stable only at or above the population minimum (${first.minOpportunities} ${unit})`,
    direction: null,
    cells: prints.map((f) =>
      f
        ? {
            text: f.qualified ? "Qualified" : `Below ${f.minOpportunities} ${unit}`,
            value: null,
            best: false,
            detail: `${f.playerOpportunities} ${unit}`,
          }
        : null,
    ),
  };
  const categories = first.categories.map((cat, ci) => {
    const values = prints.map((f) => f?.categories[ci]?.percentile ?? null);
    // Percentiles are already oriented so that higher = better for the player (engine.fingerprint
    // ranks each metric with its registry direction), so the highest percentile is the best.
    const best = bestIndexes(values, 1, 0);
    return {
      id: `pct-${cat.id}`,
      label: cat.label,
      title: `${cat.label} percentile among qualified ${role}s at this level (${cat.metrics.map((m) => m.label).join(", ")})`,
      direction: 1 as const,
      cells: prints.map((f, i) =>
        f
          ? {
              text: values[i] === null ? "—" : ordinal(values[i]!),
              value: values[i],
              best: best.has(i),
              detail: f.categories[ci]?.metrics.map((m) => `${m.label} ${formatMetric(m.metric, m.value)}`).join(" · "),
            }
          : null,
      ),
    };
  });
  return [...categories, sampleRow];
}

function momentumRows(cells: (MomentumCell | null)[], available: boolean[]): CompareRow[] {
  const label = MOMENTUM_WINDOWS[DEFAULT_MOMENTUM_WINDOW].short;
  const confidence = { low: "Low", medium: "Medium", high: "High" } as const;
  return [
    {
      id: "momentum",
      label: `Momentum (${label})`,
      title: "Change vs. the player's own earlier games at this level (−100 to +100). Not a talent rating.",
      direction: null,
      cells: cells.map((m, i) =>
        available[i]
          ? {
              text: m?.score === null || m?.score === undefined ? "—" : signedScore(m.score),
              value: m?.score ?? null,
              best: false,
              detail: m?.band ?? "Not enough data",
            }
          : null,
      ),
    },
    {
      id: "confidence",
      label: "Confidence",
      title: "How much data supports the Momentum signal (recent vs. earlier sample)",
      direction: null,
      cells: cells.map((m, i) =>
        available[i]
          ? {
              text: m?.confidence ? confidence[m.confidence] : "—",
              value: null,
              best: false,
              detail: m?.sample ? `${m.sample.recent} recent / ${m.sample.baseline} earlier ${m.sample.unit}` : undefined,
            }
          : null,
      ),
    },
  ];
}

/** The comparison for one parsed URL over the loaded levels. */
export function compareView(levels: LevelSnapshot[], query: CompareQuery): CompareView {
  const { level, role, ids } = query;
  if (!level) return { status: "no-level", query };
  const ls = levels.find((l) => l.level === level);
  if (!ls) return { status: "level-unavailable", query, level };
  const lvl = levelById(level);
  const rows = new Map(levelDirectoryRows(ls.snapshot, level, "season").map((r) => [r.id, r]));
  const ctx = requestContext(analyticsContextFor(ls.snapshot));
  const prints: (Fingerprint | null)[] = [];
  const momentum: (MomentumCell | null)[] = [];
  const samples: (Sample | null)[] = [];
  const players: ComparePlayer[] = ids.map((id) => {
    const row = rows.get(id);
    const sample = sampleOf(row, role);
    samples.push(sample);
    momentum.push(sample ? (row!.momentum[role] ?? null) : null);
    const fp = sample ? fingerprint(ctx, id, role, DEFAULT_MOMENTUM_WINDOW, DEFAULT_MOMENTUM_MODEL) : null;
    prints.push(fp);
    const name = row?.name ?? anyName(levels, id);
    return {
      id,
      name,
      position: row?.position ?? null,
      age: row?.age ?? null,
      team: row?.team ?? null,
      organization: row?.organization ?? null,
      available: sample !== null,
      notice: sample
        ? null
        : name === null
          ? "Player not found in the 2026 data"
          : `No ${lvl.label} ${ROLE_LINE[role]} line`,
      opportunities: sample ? (role === "hitter" ? (sample as NonNullable<PlayerDirectoryRow["batting"]>).plateAppearances : (sample as NonNullable<PlayerDirectoryRow["pitching"]>).battersFaced) : null,
      percentileQualified: fp ? fp.qualified : null,
    };
  });
  if (ids.length < COMPARE_MIN) return { status: "too-few", query, level, players };
  const firstPrint = prints.find((f): f is Fingerprint => f !== null) ?? null;
  return {
    status: "ok",
    query,
    level,
    role,
    seasonName: ls.snapshot.season.name,
    asOf: aflAsOf(ls.snapshot),
    players,
    groups: [
      { id: "season", label: `${lvl.label} season`, rows: SEASON_ROWS[role].map((spec) => seasonRow(spec, samples)) },
      { id: "percentiles", label: `${lvl.label} percentiles`, rows: percentileRows(prints, role) },
      { id: "momentum", label: "Momentum", rows: momentumRows(momentum, players.map((p) => p.available)) },
    ],
    percentilePopulation: firstPrint ? { size: firstPrint.populationSize, minOpportunities: firstPrint.minOpportunities } : null,
    momentumWindowLabel: MOMENTUM_WINDOWS[DEFAULT_MOMENTUM_WINDOW].label,
  };
}
