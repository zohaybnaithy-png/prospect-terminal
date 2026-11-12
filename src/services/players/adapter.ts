/**
 * Level snapshot → PlayerDirectoryRow adapter (server-side; uses the V1 analytics engine
 * unchanged). The AFL and every MiLB level go through the same function: aggregates come from
 * the level's read model and Momentum is computed against that level's own population and the
 * player's own earlier games at that level. Nothing is compared or combined across levels.
 */
import type { Role } from "@/analytics/config";
import { DEFAULT_MOMENTUM_MODEL } from "@/analytics/config";
import { momentum, playerRoles } from "@/analytics/engine";
import { analyticsContextFor } from "@/analytics/views";
import { aflAsOf, buildPlayerRows } from "@/services/afl/read-model";
import type { AflSnapshot } from "@/services/afl/types";
import type { LevelSnapshot } from "@/services/competition/types";
import {
  momentumWindowFor,
  positionGroup,
  type PlayerDirectoryRow,
  type StatWindow,
} from "./directory";
import { levelOrder, type LevelId } from "./levels";
import { processWeakMap } from "@/lib/process-memo";
import { precomputedPart } from "@/services/competition/views-store";

const memo = processWeakMap<AflSnapshot, Map<string, PlayerDirectoryRow[]>>("directory-rows");

/** Rows for one level and stat window (memoized per loaded snapshot object). */
export function levelDirectoryRows(
  snapshot: AflSnapshot,
  level: LevelId,
  window: StatWindow = "season",
): PlayerDirectoryRow[] {
  let byKey = memo.get(snapshot);
  if (!byKey) memo.set(snapshot, (byKey = new Map()));
  const key = `${level}|${window}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  // Precomputed at snapshot build (views-store.ts) when available; otherwise computed below.
  const pre = precomputedPart<PlayerDirectoryRow[]>(snapshot, `directory-rows|${key}`);
  if (pre) {
    byKey.set(key, pre);
    return pre;
  }
  const ctx = analyticsContextFor(snapshot);
  const mWindow = momentumWindowFor(window);
  const asOf = aflAsOf(snapshot);
  const primary = new Map(snapshot.players.map((p) => [p.id, p.primaryPosition]));
  const lastDate = (id: string) => {
    const b = ctx.ds.batting.get(id)?.at(-1)?.date ?? null;
    const p = ctx.ds.pitching.get(id)?.at(-1)?.date ?? null;
    return b && p ? (b > p ? b : p) : (b ?? p);
  };
  const rows = buildPlayerRows(snapshot, window).map((r) => {
    const cells: PlayerDirectoryRow["momentum"] = {};
    for (const role of playerRoles(ctx.ds, r.id)) {
      const m = momentum(ctx, r.id, role, mWindow, DEFAULT_MOMENTUM_MODEL);
      cells[role] = {
        score: m.score,
        band: m.band?.label ?? null,
        direction: m.band?.direction ?? null,
        confidence: m.status === "ok" ? m.confidence : null,
        sample: m.status === "ok" ? m.sample : null,
      };
    }
    return {
      id: r.id,
      name: r.name,
      position: r.position,
      positionGroup: positionGroup(primary.get(r.id) ?? ""),
      age: r.age,
      level,
      levels: [level],
      asOf,
      lastGame: lastDate(r.id),
      team: r.team,
      organization: r.organization,
      batting: r.batting,
      pitching: r.pitching,
      momentum: cells,
    };
  });
  byKey.set(key, rows);
  return rows;
}

/** Real AFL rows (kept for callers and tests that address the AFL directly). */
export const aflDirectoryRows = (snapshot: AflSnapshot, window: StatWindow = "season") =>
  levelDirectoryRows(snapshot, "afl", window);

const opportunities = (r: PlayerDirectoryRow, role: Role) =>
  role === "hitter" ? (r.batting?.plateAppearances ?? 0) : (r.pitching?.battersFaced ?? 0);

/**
 * Directory rows for one role. With a level, that level's rows. Without one ("All levels"), ONE
 * row per player identity: the row from the level of the player's most recent completed game
 * (ties: more playing time in the window, then ladder order), with `levels` listing every level
 * where the player has lines in the window. Statistics in that row are from that level only.
 * Only the role's aggregate and Momentum cell are kept to keep the client payload small.
 */
export function directoryRows(
  levels: LevelSnapshot[],
  { level, window, role }: { level?: LevelId | ""; window: StatWindow; role: Role },
): PlayerDirectoryRow[] {
  const scoped = level ? levels.filter((l) => l.level === level) : levels;
  const byPlayer = new Map<string, PlayerDirectoryRow[]>();
  for (const ls of scoped)
    for (const row of levelDirectoryRows(ls.snapshot, ls.level, window)) {
      if (role === "hitter" ? !row.batting : !row.pitching) continue;
      const list = byPlayer.get(row.id);
      if (list) list.push(row);
      else byPlayer.set(row.id, [row]);
    }
  const out: PlayerDirectoryRow[] = [];
  for (const rows of byPlayer.values()) {
    const [best] = [...rows].sort(
      (a, b) =>
        (b.lastGame ?? "").localeCompare(a.lastGame ?? "") ||
        opportunities(b, role) - opportunities(a, role) ||
        levelOrder(a.level) - levelOrder(b.level),
    );
    out.push({
      ...best,
      levels: rows.map((r) => r.level).sort((a, b) => levelOrder(a) - levelOrder(b)),
      batting: role === "hitter" ? best.batting : null,
      pitching: role === "pitcher" ? best.pitching : null,
      momentum: { [role]: best.momentum[role] },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
