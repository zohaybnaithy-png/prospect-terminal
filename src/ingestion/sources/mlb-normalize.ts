import { z } from "zod";
import { recordSchema, recordKey } from "../contracts";
import type {
  IngestionRecord,
  IngestionIssue,
  IngestionNotice,
  NormalizedBatch,
} from "../contracts";
import { AFL } from "./mlb-config";
export const apiId = z.number().int().positive();
const label = z.string().min(1);
export const teamSchema = z.object({
  id: apiId,
  name: label,
  abbreviation: label.optional(),
  teamCode: label.optional(),
  league: z.object({ id: apiId }).optional(),
  sport: z.object({ id: apiId }).optional(),
  parentOrgId: apiId.optional(),
});
export const personSchema = z.object({
  id: apiId,
  fullName: label,
  primaryPosition: z.object({ abbreviation: label }).optional(),
  birthDate: z.iso.date().optional(),
  batSide: z.object({ code: z.string() }).optional(),
  pitchHand: z.object({ code: z.string() }).optional(),
  height: label.optional(),
  weight: z.number().int().positive().optional(),
  currentTeam: z.object({ id: apiId }).optional(),
});
export type ApiPerson = z.infer<typeof personSchema>;
export function inningsToOuts(value: unknown): number {
  if (typeof value !== "string" || !/^\d+\.[012]$/.test(value))
    throw new Error("Invalid baseball innings notation");
  const [whole, partial] = value.split(".");
  const outs = Number(whole) * 3 + Number(partial);
  if (!Number.isSafeInteger(outs)) throw new Error("Invalid innings count");
  return outs;
}
const counts = z.record(z.string(), z.unknown());
export function battingStats(input: unknown): unknown {
  const s = counts.parse(input);
  return {
    plateAppearances: s.plateAppearances,
    atBats: s.atBats,
    hits: s.hits,
    doubles: s.doubles,
    triples: s.triples,
    homeRuns: s.homeRuns,
    walks: s.baseOnBalls,
    strikeouts: s.strikeOuts,
    hitByPitch: s.hitByPitch,
    sacrificeFlies: s.sacFlies,
    stolenBases: s.stolenBases,
    ...optionalCounts(s, {
      runs: "runs",
      rbi: "rbi",
      caughtStealing: "caughtStealing",
      sacrificeBunts: "sacBunts",
      catcherInterference: "catchersInterference",
    }),
  };
}
function optionalCounts(
  s: Record<string, unknown>,
  map: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(map)
      .filter(([, key]) => s[key] !== undefined)
      .map(([key, source]) => [key, s[source]]),
  );
}
export function pitchingStats(input: unknown): unknown {
  const s = counts.parse(input);
  const converted =
    s.inningsPitched === undefined
      ? undefined
      : inningsToOuts(s.inningsPitched);
  if (s.outs !== undefined && converted !== undefined && s.outs !== converted)
    throw new Error("Outs disagree with innings pitched");
  return {
    outsRecorded: s.outs ?? converted,
    battersFaced: s.battersFaced,
    hitsAllowed: s.hits,
    earnedRuns: s.earnedRuns,
    walks: s.baseOnBalls,
    strikeouts: s.strikeOuts,
    homeRunsAllowed: s.homeRuns,
    ...optionalCounts(s, {
      runs: "runs",
      hitBatters: "hitBatsmen",
      pitches: "numberOfPitches",
    }),
  };
}
export function gameStatus(status: {
  abstractGameState?: string;
  detailedState?: string;
  codedGameState?: string;
}): "final" | "scheduled" | "in-progress" | "postponed" | "cancelled" {
  const detail = status.detailedState?.toLowerCase() ?? "";
  if (detail.includes("cancel")) return "cancelled";
  if (detail.includes("postpon")) return "postponed";
  if (status.abstractGameState === "Final") return "final";
  if (status.abstractGameState === "Live") return "in-progress";
  if (status.abstractGameState === "Preview") return "scheduled";
  throw new Error("Unrecognized game status");
}
export class MlbNormalizer {
  readonly notices: IngestionNotice[] = [];
  readonly records = new Map<string, IngestionRecord>();
  readonly issues: IngestionIssue[] = [];
  issue(key: string, message: string) {
    this.issues.push({
      recordKey: key,
      code: "invalid-record",
      message: message.slice(0, 240),
    });
  }
  add(value: unknown): boolean {
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) {
      this.issue(
        typeof value === "object" &&
          value !== null &&
          "kind" in value &&
          "externalId" in value
          ? `${String(value.kind)}:${String(value.externalId)}`
          : "record",
        `Malformed normalized record: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      );
      return false;
    }
    const key = recordKey(parsed.data);
    const prior = this.records.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(parsed.data)) {
      this.records.delete(key);
      this.issue(key, "Conflicting source record quarantined for review");
      return false;
    }
    this.records.set(key, parsed.data);
    return true;
  }
  person(person: ApiPerson, fallbackPosition?: string) {
    const position = person.primaryPosition?.abbreviation ?? fallbackPosition;
    if (!position) {
      this.issue(`player:${person.id}`, "No reliable position supplied");
      return false;
    }
    return this.add({
      kind: "player",
      externalId: String(person.id),
      name: person.fullName,
      position,
      ...(person.birthDate ? { birthDate: person.birthDate } : {}),
      ...(person.batSide && ["L", "R", "S"].includes(person.batSide.code)
        ? { bats: person.batSide.code }
        : {}),
      ...(person.pitchHand && ["L", "R"].includes(person.pitchHand.code)
        ? { throws: person.pitchHand.code }
        : {}),
      ...(person.height ? { height: person.height } : {}),
      ...(person.weight ? { weight: person.weight } : {}),
    });
  }
  result(): NormalizedBatch {
    return {
      records: [...this.records.values()],
      ...(this.notices.length ? { notices: this.notices } : {}),
      issues: this.issues,
      quarantinePolicy: "records",
    };
  }
}
export function foundationalRecords(
  n: MlbNormalizer,
  season: number,
  leagueName: string,
) {
  n.add({ kind: "league", externalId: String(AFL.leagueId), name: leagueName });
  n.add({
    kind: "level",
    externalId: "afl-assignment",
    league: String(AFL.leagueId),
    name: "Fall developmental assignment",
  });
  n.add({
    kind: "season",
    externalId: `afl-${season}`,
    year: season,
    name: `Arizona Fall League ${season}`,
  });
}
