/**
 * Serializable view models for pages. Server components build these and pass them to client
 * components, so formulas never live in presentation code.
 */
import type { AflSnapshot } from "@/services/afl/types";
import {
  COMPONENTS_BY_ROLE,
  MAP_PERFORMANCE_METRICS,
  MOMENTUM_MODELS,
  MOMENTUM_WINDOW_IDS,
  DEFAULT_MOMENTUM_MODEL,
  type ModelId,
  type MomentumWindow,
  type Role,
} from "./config";
import {
  createAnalyticsContext,
  fingerprint,
  identity,
  momentum,
  performanceMap,
  playerMomentumByWindow,
  playerRoles,
  playerTimeline,
  risersAndFallers,
  type AnalyticsContext,
  type Fingerprint,
  type MapPoint,
  type MomentumResult,
  type PlayerTimeline,
  type RankedEntry,
  type RiserCategory,
} from "./engine";
import { COMPONENT_LABELS } from "./explain";
import { processWeakMap } from "@/lib/process-memo";

const contexts = processWeakMap<AflSnapshot, AnalyticsContext>("analytics-context");
/** One analytics context per loaded snapshot object (the AFL data layer reuses snapshots). */
export function analyticsContextFor(snapshot: AflSnapshot): AnalyticsContext {
  let ctx = contexts.get(snapshot);
  if (!ctx) {
    ctx = createAnalyticsContext(snapshot);
    contexts.set(snapshot, ctx);
  }
  return ctx;
}

export interface RoleAnalyticsView {
  role: Role;
  momentum: Record<MomentumWindow, MomentumResult>;
  timelines: Record<MomentumWindow, PlayerTimeline>;
  fingerprint: Fingerprint;
}
export interface PlayerAnalyticsView {
  asOf: string | null;
  model: { id: ModelId; label: string };
  roles: RoleAnalyticsView[];
}

/** Primary role first: pitchers (position P) lead with the pitcher view. */
export function playerAnalyticsView(
  snapshot: AflSnapshot,
  playerId: string,
  modelId: ModelId = DEFAULT_MOMENTUM_MODEL,
): PlayerAnalyticsView {
  const ctx = analyticsContextFor(snapshot);
  const player = snapshot.players.find((p) => p.id === playerId);
  const roles = playerRoles(ctx.ds, playerId);
  if (player?.primaryPosition === "P") roles.reverse();
  return {
    asOf: ctx.ds.asOf,
    model: { id: modelId, label: MOMENTUM_MODELS[modelId].label },
    roles: roles.map((role) => ({
      role,
      momentum: playerMomentumByWindow(ctx, playerId, role, modelId),
      timelines: Object.fromEntries(
        MOMENTUM_WINDOW_IDS.map((w) => [
          w,
          playerTimeline(ctx, playerId, role, w, modelId),
        ]),
      ) as Record<MomentumWindow, PlayerTimeline>,
      fingerprint: fingerprint(ctx, playerId, role, "14d", modelId),
    })),
  };
}

export interface RiserSets {
  lists: Record<
    Role,
    Record<
      MomentumWindow,
      Partial<Record<RiserCategory, { risers: RankedEntry[]; fallers: RankedEntry[] }>>
    >
  >;
  /** Players with a valid recent-vs-earlier comparison; 0 means the window is unavailable. */
  comparable: Record<Role, Record<MomentumWindow, number>>;
}

/** Risers / Fallers for the V1 model (alternative weightings live only in dev tooling). */
export function riserSets(
  snapshot: AflSnapshot,
  limit = 10,
  modelId: ModelId = DEFAULT_MOMENTUM_MODEL,
): RiserSets {
  const ctx = analyticsContextFor(snapshot);
  const out: RiserSets = {
    lists: { hitter: {}, pitcher: {} } as RiserSets["lists"],
    comparable: { hitter: {}, pitcher: {} } as RiserSets["comparable"],
  };
  for (const role of ["hitter", "pitcher"] as const)
    for (const w of MOMENTUM_WINDOW_IDS) {
      const sets: RiserSets["lists"][Role][MomentumWindow] = {};
      for (const cat of ["overall", ...COMPONENTS_BY_ROLE[role]] as RiserCategory[])
        sets[cat] = risersAndFallers(ctx, role, w, modelId, cat, limit);
      out.lists[role][w] = sets;
      out.comparable[role][w] = comparableCount(ctx, role, w, modelId);
    }
  return out;
}

/** Number of players in a role whose window has a valid earlier baseline. */
export function comparableCount(
  ctx: AnalyticsContext,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId = DEFAULT_MOMENTUM_MODEL,
) {
  const ids = role === "hitter" ? ctx.ds.batting.keys() : ctx.ds.pitching.keys();
  let n = 0;
  for (const id of ids) if (momentum(ctx, id, role, window, modelId).status === "ok") n++;
  return n;
}

export interface MapPointView extends Omit<MapPoint, "x" | "xValue" | "quadrant"> {
  /** x-metric id → [AFL percentile, season value]. */
  xs: Record<string, [number, number]>;
}
export type MapSets = Record<Role, Record<MomentumWindow, MapPointView[]>>;

/** Map points for the V1 model with every selectable x-axis statistic attached. */
export function mapSets(
  snapshot: AflSnapshot,
  modelId: ModelId = DEFAULT_MOMENTUM_MODEL,
): MapSets {
  const ctx = analyticsContextFor(snapshot);
  const out = { hitter: {}, pitcher: {} } as MapSets;
  for (const role of ["hitter", "pitcher"] as const)
    for (const w of MOMENTUM_WINDOW_IDS) {
      const byId = new Map<string, MapPointView>();
      for (const metric of MAP_PERFORMANCE_METRICS[role])
        for (const p of performanceMap(ctx, role, w, modelId, metric)) {
          const { x, xValue, quadrant: _quadrant, ...rest } = p;
          void _quadrant;
          const view = byId.get(p.playerId) ?? { ...rest, xs: {} };
          view.xs[metric] = [x, xValue];
          byId.set(p.playerId, view);
        }
      out[role][w] = [...byId.values()];
    }
  return out;
}

export const componentLabel = (c: string) =>
  COMPONENT_LABELS[c as keyof typeof COMPONENT_LABELS]?.label ?? c;

export { identity, momentum };
