/**
 * AFL → PlayerDirectoryRow adapter (server-side; uses the V1 analytics engine unchanged).
 * A MiLB adapter would live beside this one and return the same row shape.
 */
import { DEFAULT_MOMENTUM_MODEL } from "@/analytics/config";
import { momentum, playerRoles } from "@/analytics/engine";
import { analyticsContextFor } from "@/analytics/views";
import { buildPlayerRows } from "@/services/afl/read-model";
import type { AflSnapshot } from "@/services/afl/types";
import {
  momentumWindowFor,
  positionGroup,
  type PlayerDirectoryRow,
  type StatWindow,
} from "./directory";

/** Real AFL rows: season/window aggregates from the AFL read model plus V1 Momentum. */
export function aflDirectoryRows(
  snapshot: AflSnapshot,
  window: StatWindow = "season",
): PlayerDirectoryRow[] {
  const ctx = analyticsContextFor(snapshot);
  const mWindow = momentumWindowFor(window);
  const primary = new Map(
    snapshot.players.map((p) => [p.id, p.primaryPosition]),
  );
  return buildPlayerRows(snapshot, window).map((r) => {
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
      level: "afl" as const,
      team: r.team,
      organization: r.organization,
      batting: r.batting,
      pitching: r.pitching,
      momentum: cells,
    };
  });
}
