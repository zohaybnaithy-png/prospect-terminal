/**
 * Similar players for a profile (docs/SIMILARITY-METHOD.md, D-024, D-026, display D-028). Same level, role and season;
 * hitters within their position group. A browsing aid only: "similar so far this season", no predictive claim
 * (D-025, D-027). Computed from the level snapshot alone and memoized per loaded snapshot object.
 */
import { SIMILARITY_DIMS, SIMILARITY_DISPLAY, SIMILARITY_SETTINGS, type SimilarityRole } from "@/analytics/similarity/config";
import {
  isGrouped,
  population,
  roleGamesFromSnapshot,
  similarPlayers,
  splitHalfReliability,
  totals,
  type PairPart,
  type Population,
} from "@/analytics/similarity/profiles";
import type { AflSnapshot } from "@/services/afl/types";
import { processWeakMap } from "@/lib/process-memo";
import type { LevelId } from "./levels";

export interface SimilarRow {
  id: string;
  name: string;
  position: string;
  hand: string | null;
  sample: number;
  score: number;
  /** Observed (unshrunk) rates in SIMILARITY_DIMS order. */
  rates: number[];
  closest: string[];
  furthest: string[];
  /** PA/BF differs from the player's by SIMILARITY_DISPLAY.sampleGapFactor or more. */
  sampleGap: boolean;
}

export type SimilarView =
  | { role: SimilarityRole; status: "ok"; self: Omit<SimilarRow, "score" | "closest" | "furthest" | "sampleGap">; rows: SimilarRow[]; group: string | null }
  | { role: SimilarityRole; status: "no-close-match" | "not-enough-data" | "small-group" | "not-offered"; group?: string | null };

const memo = processWeakMap<AflSnapshot, Map<SimilarityRole, Population>>("similarity-population");

/** The level population for a role (full-season shrinkage constants from split-half reliability). */
export function levelPopulation(snapshot: AflSnapshot, role: SimilarityRole): Population {
  let byRole = memo.get(snapshot);
  if (!byRole) memo.set(snapshot, (byRole = new Map()));
  const hit = byRole.get(role);
  if (hit) return hit;
  const d = roleGamesFromSnapshot(snapshot, role);
  const k = SIMILARITY_DIMS[role].map((_, j) => splitHalfReliability(d, j, () => true).k);
  const pop = population(role, d.players.map((p) => totals(p, () => true)), k, d.asOf ?? "");
  byRole.set(role, pop);
  return pop;
}

const label = (role: SimilarityRole, dim: number) => (dim < 0 ? "Age vs level" : SIMILARITY_DIMS[role][dim].label);

/**
 * Display explanation (D-028): "furthest" ranks dimensions by weighted contribution w·Δz² (a barely weighted noisy
 * dimension is never called the biggest difference); "closest" names the smallest |Δz| among well-measured dimensions.
 */
export function explainPair(parts: PairPart[], role: SimilarityRole, count = 2) {
  const furthest = [...parts].filter((p) => p.w > 0).sort((a, b) => b.w * b.dz * b.dz - a.w * a.dz * a.dz).slice(0, count);
  const taken = new Set(furthest.map((p) => p.dim));
  const closest = parts
    .filter((p) => p.w >= SIMILARITY_DISPLAY.closestMinWeight && !taken.has(p.dim))
    .sort((a, b) => Math.abs(a.dz) - Math.abs(b.dz))
    .slice(0, count);
  return { closest: closest.map((p) => label(role, p.dim)), furthest: furthest.map((p) => label(role, p.dim)) };
}

/** Similar players for one player and role at one level. AFL: not offered (samples too small, §2). */
export function similarView(snapshot: AflSnapshot, level: LevelId, playerId: string, role: SimilarityRole): SimilarView {
  if (level === "afl") return { role, status: "not-offered" };
  const pop = levelPopulation(snapshot, role);
  const me = pop.byId.get(playerId);
  if (!me) return { role, status: "not-enough-data" };
  const group = isGrouped(pop, SIMILARITY_SETTINGS) ? me.group : null;
  if (group !== null && (pop.groupSizes.get(group) ?? 0) < SIMILARITY_SETTINGS.minGroupSize) return { role, status: "small-group", group };
  const players = new Map(snapshot.players.map((p) => [p.id, p]));
  const base = (id: string) => {
    const p = pop.byId.get(id)!;
    const m = players.get(id);
    return {
      id, name: m?.name ?? "Unknown player", position: m?.primaryPosition ?? "—",
      hand: (role === "hitter" ? m?.bats : m?.throws) ?? null, sample: p.n, rates: [...p.raw],
    };
  };
  const rows = similarPlayers(pop, playerId)
    .filter((n) => n.score >= SIMILARITY_DISPLAY.scoreFloor)
    .map((n) => {
      const f = SIMILARITY_DISPLAY.sampleGapFactor;
      return {
        ...base(n.id), score: Math.round(n.score), ...explainPair(n.parts, role),
        sampleGap: n.n >= f * me.n || me.n >= f * n.n,
      };
    });
  if (!rows.length) return { role, status: "no-close-match", group };
  return { role, status: "ok", self: base(playerId), rows, group };
}
