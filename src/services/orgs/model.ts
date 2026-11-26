/**
 * Organization pages (T-204): an MLB parent organization's players, grouped by level and
 * affiliate. Built from the same per-level directory rows as /players (server-side, snapshot data
 * only). Statistics and Momentum stay per level: nothing is combined across levels.
 *
 * A row's organization and team are the player's latest source roster observation at that level,
 * so a player who changed affiliates appears under the team they were last rostered with.
 */
import type { LevelSnapshot } from "@/services/competition/types";
import type { EntityRef, PlayerDirectoryRow, StatWindow } from "@/services/players/directory";
import { levelDirectoryRows } from "@/services/players/adapter";
import { levelOrder, type LevelId } from "@/services/players/levels";
import { orgSlug } from "./slug";

export { orgHref, orgSlug } from "./slug";

export interface OrgSummary {
  org: EntityRef;
  slug: string;
  /** Distinct players with a line at each level for this organization. */
  players: Partial<Record<LevelId, number>>;
  total: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowsByOrg(levels: LevelSnapshot[], window: StatWindow) {
  const out = new Map<string, { org: EntityRef; rows: PlayerDirectoryRow[] }>();
  for (const ls of [...levels].sort((a, b) => levelOrder(a.level) - levelOrder(b.level)))
    for (const r of levelDirectoryRows(ls.snapshot, ls.level, window)) {
      if (!r.organization) continue;
      const hit = out.get(r.organization.id);
      if (hit) hit.rows.push(r);
      else out.set(r.organization.id, { org: r.organization, rows: [r] });
    }
  return out;
}

/** Every organization with at least one player line, by name. */
export function orgIndex(levels: LevelSnapshot[]): OrgSummary[] {
  const out: OrgSummary[] = [];
  for (const { org, rows } of rowsByOrg(levels, "season").values()) {
    const players: OrgSummary["players"] = {};
    for (const r of rows) players[r.level] = (players[r.level] ?? 0) + 1;
    out.push({ org, slug: orgSlug(org), players, total: new Set(rows.map((r) => r.id)).size });
  }
  return out.sort((a, b) => a.org.name.localeCompare(b.org.name) || a.org.id.localeCompare(b.org.id));
}

export type OrgLookup =
  | { kind: "ok"; org: EntityRef }
  | { kind: "ambiguous"; matches: EntityRef[] }
  | { kind: "missing" };

/** Resolves a slug (abbreviation slug or internal UUID) against the organizations in the data. */
export function findOrg(levels: LevelSnapshot[], slug: string): OrgLookup {
  const all = orgIndex(levels);
  if (UUID.test(slug)) {
    const hit = all.find((s) => s.org.id.toLowerCase() === slug.toLowerCase());
    return hit ? { kind: "ok", org: hit.org } : { kind: "missing" };
  }
  const matches = all.filter((s) => s.slug === slug.toLowerCase());
  if (matches.length === 1) return { kind: "ok", org: matches[0].org };
  if (matches.length > 1) return { kind: "ambiguous", matches: matches.map((m) => m.org) };
  return { kind: "missing" };
}

export interface OrgAffiliate {
  team: EntityRef | null;
  /** Players with a batting line, most plate appearances first. */
  hitters: PlayerDirectoryRow[];
  /** Players with a pitching line, most batters faced first. */
  pitchers: PlayerDirectoryRow[];
}

export interface OrgLevelGroup {
  level: LevelId;
  affiliates: OrgAffiliate[];
}

/** The organization's players at every loaded level (ladder order), by affiliate (team name). */
export function orgLevels(levels: LevelSnapshot[], orgId: string, window: StatWindow = "season"): OrgLevelGroup[] {
  const rows = rowsByOrg(levels, window).get(orgId)?.rows ?? [];
  const byLevel = new Map<LevelId, Map<string, OrgAffiliate>>();
  for (const r of rows) {
    let teams = byLevel.get(r.level);
    if (!teams) byLevel.set(r.level, (teams = new Map()));
    const key = r.team?.id ?? "";
    let a = teams.get(key);
    if (!a) teams.set(key, (a = { team: r.team, hitters: [], pitchers: [] }));
    if (r.batting) a.hitters.push(r);
    if (r.pitching) a.pitchers.push(r);
  }
  const byName = (a: PlayerDirectoryRow, b: PlayerDirectoryRow) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return [...byLevel.entries()]
    .sort(([a], [b]) => levelOrder(a) - levelOrder(b))
    .map(([level, teams]) => ({
      level,
      affiliates: [...teams.values()]
        .map((a) => ({
          ...a,
          hitters: a.hitters.sort((x, y) => (y.batting!.plateAppearances - x.batting!.plateAppearances) || byName(x, y)),
          pitchers: a.pitchers.sort((x, y) => (y.pitching!.battersFaced - x.pitching!.battersFaced) || byName(x, y)),
        }))
        // Unknown team last; otherwise by team name.
        .sort((a, b) => (a.team ? 0 : 1) - (b.team ? 0 : 1) || (a.team?.name ?? "").localeCompare(b.team?.name ?? "")),
    }));
}
