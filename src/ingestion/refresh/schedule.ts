/**
 * When each source produces new games, and therefore when a refresh should run and when missing
 * updates mean stale data. Dates are month-day ranges in UTC, inclusive.
 *
 * - MiLB (Triple-A … Single-A): regular season early April to mid/late September, playoffs to the
 *   end of September. The job keeps running for a grace period after the window to pick up late
 *   corrections; freshness only *expects* new games inside the window.
 * - AFL: early October to mid/late November.
 */
export type RefreshSource = "milb" | "afl";

export interface SeasonWindow {
  /** MM-DD */
  from: string;
  /** MM-DD */
  to: string;
}

export const ACTIVE_WINDOWS: Record<RefreshSource, SeasonWindow> = {
  milb: { from: "04-01", to: "09-30" },
  afl: { from: "10-01", to: "11-20" },
};

/** Days after the active window during which the job still runs (late corrections, final boxes). */
export const GRACE_DAYS = 10;

const dayOfYear = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
};

const inWindow = (date: string, w: SeasonWindow, graceDays = 0) => {
  const year = date.slice(0, 4);
  const doy = dayOfYear(date);
  return doy >= dayOfYear(`${year}-${w.from}`) && doy <= dayOfYear(`${year}-${w.to}`) + graceDays;
};

/** Games are expected (freshness checks apply). */
export const isActive = (source: RefreshSource, date: string, windows = ACTIVE_WINDOWS) =>
  inWindow(date, windows[source]);

/** The scheduled job should run this source today (active window plus grace). */
export const shouldRefresh = (source: RefreshSource, date: string, windows = ACTIVE_WINDOWS) =>
  inWindow(date, windows[source], GRACE_DAYS);

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const validMonthDay = (md: string) => {
  if (!MMDD.test(md)) return false;
  const [m, d] = md.split("-").map(Number);
  return d <= new Date(Date.UTC(2024, m, 0)).getUTCDate(); // leap year: 02-29 allowed
};

/**
 * Season windows for unusual years, from `PT_SEASON_WINDOWS`, e.g.
 * `milb=03-20..10-05,afl=10-03..11-25` (MM-DD, inclusive, UTC; either source may be omitted). Used by
 * the job (which sources run) and by check:freshness (when games are expected). Invalid values
 * throw: a silently ignored typo would make the job skip a season or freshness miss stale data.
 */
export function seasonWindowsFromEnv(env: Record<string, string | undefined> = process.env): Record<RefreshSource, SeasonWindow> {
  const raw = env.PT_SEASON_WINDOWS?.trim();
  if (!raw) return ACTIVE_WINDOWS;
  const out = { ...ACTIVE_WINDOWS };
  for (const part of raw.split(",")) {
    const m = /^(milb|afl)=([0-9-]+)\.\.([0-9-]+)$/.exec(part.trim());
    if (!m || !validMonthDay(m[2]) || !validMonthDay(m[3]) || m[2] > m[3])
      throw new Error(`PT_SEASON_WINDOWS: invalid entry "${part}" (expected e.g. milb=04-01..09-30)`);
    out[m[1] as RefreshSource] = { from: m[2], to: m[3] };
  }
  return out;
}
