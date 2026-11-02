import { createHash } from "node:crypto";
import type {
  EntityKind,
  IngestionRecord,
  IngestionIssue,
  NormalizedBatch,
} from "./contracts";
import { entityKinds, recordKey } from "./contracts";
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");
export function references(record: IngestionRecord): [EntityKind, string][] {
  switch (record.kind) {
    case "level":
      return [["league", record.league]];
    case "team":
      return [
        ["level", record.level],
        ...(record.organization
          ? [["organization", record.organization] as [EntityKind, string]]
          : []),
      ];
    case "gameLineSet":
      return [
        ["game", record.game],
        ...record.battingPlayers.map(
          (p) => ["player", p] as [EntityKind, string],
        ),
        ...record.pitchingPlayers.map(
          (p) => ["player", p] as [EntityKind, string],
        ),
      ];
    case "game":
      return [
        ...(record.league
          ? [["league", record.league] as [EntityKind, string]]
          : []),
        ["season", record.season],
        ["team", record.homeTeam],
        ["team", record.awayTeam],
      ];
    case "teamMembership":
      return [
        ["player", record.player],
        ["team", record.team],
        ["season", record.season],
      ];
    case "organizationMembership":
      return [
        ["player", record.player],
        ["organization", record.organization],
      ];
    case "rosterObservation":
      return [
        ...(record.season
          ? [["season", record.season] as [EntityKind, string]]
          : []),
        ["player", record.player],
        ["team", record.team],
        ...(record.organization
          ? [["organization", record.organization] as [EntityKind, string]]
          : []),
      ];
    case "battingGame":
    case "pitchingGame":
      return [
        ["player", record.player],
        ["team", record.team],
        ["game", record.game],
      ];
    default:
      return [];
  }
}
const priority: Record<IngestionRecord["kind"], number> = {
  league: 0,
  level: 1,
  season: 2,
  organization: 3,
  team: 4,
  player: 5,
  game: 6,
  organizationMembership: 7,
  teamMembership: 8,
  rosterObservation: 9,
  battingGame: 10,
  pitchingGame: 11,
  gameLineSet: 12,
};
/** Any issue quarantines the entire batch on apply; no partially trusted snapshot is published. */
export function buildPlan(
  batch: NormalizedBatch,
  knownIdentities: Set<string> = new Set(),
): NormalizedBatch {
  const issues: IngestionIssue[] = [...batch.issues];
  const unavailable = new Set(
    batch.issues
      .filter((i) => i.code === "invalid-record" || i.code === "duplicate-key")
      .map((i) => i.recordKey),
  );
  const records = new Map<string, IngestionRecord>();
  const conflicted = new Set<string>();
  for (const r of batch.records) {
    const key = recordKey(r);
    const previous = records.get(key);
    if (previous && fingerprint(previous) !== fingerprint(r)) {
      conflicted.add(key);
      issues.push({
        recordKey: key,
        code: "duplicate-key",
        message:
          "Conflicting records share a provider identity/key; reconciliation required",
      });
    } else records.set(key, r);
  }
  for (const key of conflicted) {
    records.delete(key);
    unavailable.add(key);
  }
  for (const key of unavailable) records.delete(key);
  // Fixed point catches records depending on another invalid/missing entity.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, r] of records) {
      const missing = references(r).find(
        ([kind, id]) =>
          unavailable.has(`${kind}:${id}`) ||
          (!records.has(`${kind}:${id}`) &&
            !knownIdentities.has(`${kind}:${id}`)),
      );
      if (missing) {
        records.delete(key);
        issues.push({
          recordKey: key,
          code: "missing-reference",
          message: `Unresolved ${missing[0]} reference`,
        });
        changed = true;
      }
    }
  }
  const rejected = new Set<string>();
  for (const r of records.values()) {
    if (r.kind === "game" && r.homeTeam === r.awayTeam)
      issues.push({
        recordKey: recordKey(r),
        code: "inconsistent-game",
        message: "A game must have distinct teams",
      });
    if (r.kind === "battingGame" || r.kind === "pitchingGame") {
      const game = records.get(`game:${r.game}`);
      if (
        game?.kind === "game" &&
        ![game.homeTeam, game.awayTeam].includes(r.team)
      )
        issues.push({
          recordKey: recordKey(r),
          code: "inconsistent-game",
          message: "Stat team did not participate in game",
        });
    }
  }
  for (const issue of issues)
    if (issue.code === "inconsistent-game") rejected.add(issue.recordKey);
  for (const key of rejected) {
    records.delete(key);
    unavailable.add(key);
  }
  let removed = true;
  while (removed) {
    removed = false;
    for (const [key, r] of records)
      if (
        references(r).some(
          ([kind, id]) =>
            unavailable.has(`${kind}:${id}`) ||
            (!records.has(`${kind}:${id}`) &&
              !knownIdentities.has(`${kind}:${id}`)),
        )
      ) {
        records.delete(key);
        issues.push({
          recordKey: key,
          code: "missing-reference",
          message: "Dependency was quarantined",
        });
        removed = true;
      }
  }
  for (const [key, r] of records)
    if (
      r.kind === "gameLineSet" &&
      r.lineKeys.some((line) => !records.has(line))
    ) {
      records.delete(key);
      issues.push({
        recordKey: key,
        code: "missing-reference",
        message: "Boxscore line set includes a quarantined/missing stat line",
      });
    }
  return {
    records: [...records.values()].sort((a, b) => {
      const order = priority[a.kind] - priority[b.kind];
      if (order) return order;
      // Close/update older stints before opening the next confirmed affiliation.
      if ("startsOn" in a && "startsOn" in b)
        return (
          a.player.localeCompare(b.player) ||
          a.startsOn.localeCompare(b.startsOn) ||
          recordKey(a).localeCompare(recordKey(b))
        );
      return recordKey(a).localeCompare(recordKey(b));
    }),
    issues,
    ...(batch.quarantinePolicy
      ? { quarantinePolicy: batch.quarantinePolicy }
      : {}),
  };
}
export const isEntityKind = (kind: string): kind is EntityKind =>
  (entityKinds as readonly string[]).includes(kind);
