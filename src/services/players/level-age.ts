/**
 * Age relative to level (T-401, owner-approved 2026-11-26, D-020).
 *
 * For one level snapshot: the median age of every player with at least one completed-game line
 * (batting or pitching) at the level this season and a known birth date, measured in decimal years
 * on the level's "as of" date (its latest completed game). A player's value is their own decimal
 * age on that date minus the median: positive = older than the level median, negative = younger.
 *
 * Descriptive context only, from the snapshot alone: not adjusted for role, position or level of
 * competition, and nothing is combined across levels. Below MIN_LEVEL_AGE_SAMPLE players the
 * median is not shown (null), rather than shown on a tiny group.
 */
import type { AflSnapshot } from "@/services/afl/types";
import { aflAsOf, completedGames } from "@/services/afl/read-model";
import { processWeakMap } from "@/lib/process-memo";

export const MIN_LEVEL_AGE_SAMPLE = 20;
const DAYS_PER_YEAR = 365.2425;
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Decimal age in years on `asOf` (both YYYY-MM-DD); null for unusable dates or a negative age. */
export function decimalAge(birthDate: string, asOf: string): number | null {
  if (!ISO_DATE.test(birthDate) || !ISO_DATE.test(asOf.slice(0, 10))) return null;
  const days = (Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - Date.parse(`${birthDate}T00:00:00Z`)) / DAY_MS;
  return Number.isFinite(days) && days >= 0 ? days / DAYS_PER_YEAR : null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface LevelAgeContext {
  asOf: string | null;
  /** Median decimal age, or null when fewer than MIN_LEVEL_AGE_SAMPLE players qualify. */
  median: number | null;
  /** Players with a line at the level and a known birth date. */
  sample: number;
}

const memo = processWeakMap<AflSnapshot, LevelAgeContext>("level-age");

/** The level's median-age context (memoized per loaded snapshot object). */
export function levelAgeContext(s: AflSnapshot): LevelAgeContext {
  const hit = memo.get(s);
  if (hit) return hit;
  const asOf = aflAsOf(s);
  const complete = new Set(completedGames(s).map((g) => g.id));
  const withLines = new Set<string>();
  for (const l of s.batting) if (complete.has(l.gameId)) withLines.add(l.playerId);
  for (const l of s.pitching) if (complete.has(l.gameId)) withLines.add(l.playerId);
  const ages: number[] = [];
  if (asOf)
    for (const p of s.players) {
      if (!withLines.has(p.id) || !p.birthDate) continue;
      const a = decimalAge(p.birthDate, asOf);
      if (a !== null) ages.push(a);
    }
  const ctx: LevelAgeContext = {
    asOf,
    median: ages.length >= MIN_LEVEL_AGE_SAMPLE ? median(ages) : null,
    sample: ages.length,
  };
  memo.set(s, ctx);
  return ctx;
}

/** Player's age minus the level median, in years rounded to 0.1; null when either is unknown. */
export function ageVsLevel(birthDate: string | null, ctx: LevelAgeContext): number | null {
  if (!birthDate || !ctx.asOf || ctx.median === null) return null;
  const a = decimalAge(birthDate, ctx.asOf);
  if (a === null) return null;
  const d = Math.round((a - ctx.median) * 10) / 10;
  return Object.is(d, -0) ? 0 : d;
}

export { formatAgeVsLevel } from "./level-age-format";
