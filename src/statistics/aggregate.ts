import { z } from "zod";
export interface BattingCounts {
  plateAppearances: number;
  atBats: number;
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  walks: number;
  strikeouts: number;
  hitByPitch: number;
  sacrificeFlies: number;
  stolenBases: number;
  runs?: number | null;
  rbi?: number | null;
  caughtStealing?: number | null;
}
export interface PitchingCounts {
  outsRecorded: number;
  battersFaced: number;
  hitsAllowed: number;
  earnedRuns: number;
  walks: number;
  strikeouts: number;
  homeRunsAllowed: number;
  runs?: number | null;
  hitBatters?: number | null;
  pitches?: number | null;
}
const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
const total = <T>(rows: T[], get: (row: T) => number) =>
  rows.reduce((sum, row) => sum + get(row), 0);
const optionalTotal = <T>(
  rows: T[],
  get: (row: T) => number | null | undefined,
) =>
  rows.some((r) => get(r) == null) ? null : total(rows, (r) => get(r) ?? 0);
export function aggregateBatting(rows: BattingCounts[]) {
  const sum = (key: keyof BattingCounts) => total(rows, (r) => r[key] ?? 0);
  const counts = {
    plateAppearances: sum("plateAppearances"),
    atBats: sum("atBats"),
    hits: sum("hits"),
    doubles: sum("doubles"),
    triples: sum("triples"),
    homeRuns: sum("homeRuns"),
    walks: sum("walks"),
    strikeouts: sum("strikeouts"),
    hitByPitch: sum("hitByPitch"),
    sacrificeFlies: sum("sacrificeFlies"),
    stolenBases: sum("stolenBases"),
    runs: optionalTotal(rows, (r) => r.runs),
    rbi: optionalTotal(rows, (r) => r.rbi),
    caughtStealing: optionalTotal(rows, (r) => r.caughtStealing),
  };
  const avg = ratio(counts.hits, counts.atBats),
    obp = ratio(
      counts.hits + counts.walks + counts.hitByPitch,
      counts.atBats + counts.walks + counts.hitByPitch + counts.sacrificeFlies,
    ),
    slg = ratio(
      counts.hits + counts.doubles + 2 * counts.triples + 3 * counts.homeRuns,
      counts.atBats,
    );
  return {
    ...counts,
    gameLines: rows.length,
    avg,
    obp,
    slg,
    ops: obp !== null && slg !== null ? obp + slg : null,
    bbPct: counts.plateAppearances
      ? (100 * counts.walks) / counts.plateAppearances
      : null,
    kPct: counts.plateAppearances
      ? (100 * counts.strikeouts) / counts.plateAppearances
      : null,
  };
}
export function aggregatePitching(rows: PitchingCounts[]) {
  const sum = (key: keyof PitchingCounts) => total(rows, (r) => r[key] ?? 0);
  const counts = {
    outsRecorded: sum("outsRecorded"),
    battersFaced: sum("battersFaced"),
    hitsAllowed: sum("hitsAllowed"),
    earnedRuns: sum("earnedRuns"),
    walks: sum("walks"),
    strikeouts: sum("strikeouts"),
    homeRunsAllowed: sum("homeRunsAllowed"),
    runs: optionalTotal(rows, (r) => r.runs),
    hitBatters: optionalTotal(rows, (r) => r.hitBatters),
    pitches: optionalTotal(rows, (r) => r.pitches),
  };
  return {
    ...counts,
    gameLines: rows.length,
    era: ratio(27 * counts.earnedRuns, counts.outsRecorded),
    whip: ratio(3 * (counts.hitsAllowed + counts.walks), counts.outsRecorded),
    kPct: counts.battersFaced
      ? (100 * counts.strikeouts) / counts.battersFaced
      : null,
    bbPct: counts.battersFaced
      ? (100 * counts.walks) / counts.battersFaced
      : null,
  };
}
export interface StatWindow {
  season: number;
  asOf: string;
  window: "7d" | "14d" | "30d" | "season" | { from: string; to: string };
  leagueId: string;
  teamId?: string;
}
export function windowBounds(options: StatWindow) {
  z.number().int().min(1900).max(2200).parse(options.season);
  z.iso.date().parse(options.asOf);
  z.uuid().parse(options.leagueId);
  if (options.teamId) z.uuid().parse(options.teamId);
  if (Number(options.asOf.slice(0, 4)) !== options.season)
    throw new Error("asOf must be in the selected season");
  let from: string,
    to = options.asOf;
  if (typeof options.window === "object") {
    from = z.iso.date().parse(options.window.from);
    to = z.iso.date().parse(options.window.to);
    if (to > options.asOf) throw new Error("Window extends beyond asOf");
  } else if (options.window === "season") from = `${options.season}-01-01`;
  else {
    const days = { "7d": 7, "14d": 14, "30d": 30 }[options.window];
    if (!days) throw new Error("Unsupported stat window");
    const date = new Date(`${options.asOf}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (days - 1));
    from = date.toISOString().slice(0, 10);
    if (from < `${options.season}-01-01`) from = `${options.season}-01-01`;
  }
  if (
    from > to ||
    Number(from.slice(0, 4)) !== options.season ||
    Number(to.slice(0, 4)) !== options.season
  )
    throw new Error("Invalid season window");
  return { from, to };
}
