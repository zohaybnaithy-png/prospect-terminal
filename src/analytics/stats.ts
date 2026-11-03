/** Small pure numeric helpers. All functions are total: empty input yields null, never NaN. */

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export function mean(values: number[]): number | null {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Sample standard deviation (n − 1); null for fewer than two finite values. */
export function standardDeviation(values: number[]): number | null {
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(
    xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1),
  );
}

/**
 * Percentile rank (0–100) of `value` within `population` using the mid-rank convention:
 * (count below + ½·count equal) / n. `direction` −1 ranks lower values higher (K% for hitters).
 */
export function percentileRank(
  value: number,
  population: number[],
  direction: 1 | -1 = 1,
): number | null {
  const xs = population.filter(Number.isFinite);
  if (!xs.length || !Number.isFinite(value)) return null;
  let below = 0,
    equal = 0;
  for (const x of xs) {
    const d = direction * (x - value);
    if (d < 0) below++;
    else if (d === 0) equal++;
  }
  return (100 * (below + equal / 2)) / xs.length;
}

export const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Whole days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string) {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
