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

/** True when a box score stat line shows the player never appeared (every participation count is 0). */
function noParticipation(kind: "battingGame" | "pitchingGame", stats: Record<string, unknown>) {
  const fields =
    kind === "battingGame"
      ? ["gamesPlayed", "plateAppearances", "atBats"]
      : ["gamesPlayed", "gamesPitched", "battersFaced", "outs", "numberOfPitches", "pitchesThrown"];
  const present = fields.filter((f) => stats[f] !== undefined);
  return present.length > 0 && present.every((f) => stats[f] === 0) &&
    (kind === "battingGame" || stats.inningsPitched === undefined || stats.inningsPitched === "0.0");
}

/**
 * Normalizes one completed-game boxscore into batting/pitching lines plus a gameLineSet.
 * Shared by the AFL and MiLB adapters. Any malformed player or statistic holds the WHOLE
 * boxscore (no lines, no line set) so a partial boxscore can never be marked complete.
 * Returns the people seen (for player records); throws nothing — problems become issues.
 */
export function normalizeBoxscore(
  n: MlbNormalizer,
  gamePk: number,
  body: unknown,
  scheduled: { home: number; away: number },
): { person: ApiPerson; position?: string }[] {
  const boxPeople: { person: ApiPerson; position?: string }[] = [];
  try {
    const box = z
      .object({
        teams: z.object({
          home: z.object({
            team: z.object({ id: apiId }),
            players: z.record(z.string(), z.unknown()),
            batters: z.array(apiId).optional(),
            pitchers: z.array(apiId).optional(),
          }),
          away: z.object({
            team: z.object({ id: apiId }),
            players: z.record(z.string(), z.unknown()),
            batters: z.array(apiId).optional(),
            pitchers: z.array(apiId).optional(),
          }),
        }),
      })
      .parse(body);
    if (
      box.teams.home.team.id !== scheduled.home ||
      box.teams.away.team.id !== scheduled.away
    )
      throw new Error("Boxscore teams disagree with schedule");
    const lines: IngestionRecord[] = [];
    let bad = false;
    for (const side of [box.teams.home, box.teams.away])
      for (const [key, raw] of Object.entries(side.players)) {
        const entry = z
          .object({
            person: personSchema,
            position: z.object({ abbreviation: z.string() }).optional(),
            stats: z.object({
              batting: z.record(z.string(), z.unknown()).optional(),
              pitching: z.record(z.string(), z.unknown()).optional(),
            }),
          })
          .safeParse(raw);
        if (!entry.success) {
          n.issue(`boxscore:${gamePk}:${key}`, "Malformed boxscore player");
          bad = true;
          continue;
        }
        const row = entry.data;
        boxPeople.push({ person: row.person, position: row.position?.abbreviation });
        for (const kind of ["battingGame", "pitchingGame"] as const) {
          const stats = kind === "battingGame" ? row.stats.batting : row.stats.pitching;
          if (!stats || !Object.keys(stats).length) continue;
          // The API occasionally also lists a player under the OTHER club with an all-zero line
          // (e.g. MiLB gamePk 817667). Skip such a line only when that side supplies its
          // batters/pitchers list, the player is not in it, and the line records no
          // participation; anything else is emitted and still goes through conflict quarantine.
          const listed = kind === "battingGame" ? side.batters : side.pitchers;
          if (listed && !listed.includes(row.person.id) && noParticipation(kind, stats)) {
            n.notices.push({
              recordKey: `${kind}:${gamePk}:${row.person.id}`,
              reason: "unlisted-empty-line",
              message: `Empty ${kind === "battingGame" ? "batting" : "pitching"} entry for a player not in team ${side.team.id}'s ${kind === "battingGame" ? "batters" : "pitchers"} list; not stored`,
            });
            continue;
          }
          try {
            lines.push(
              recordSchema.parse({
                kind,
                key: `${gamePk}:${row.person.id}`,
                player: String(row.person.id),
                game: String(gamePk),
                team: String(side.team.id),
                stats: kind === "battingGame" ? battingStats(stats) : pitchingStats(stats),
              }),
            );
          } catch {
            n.issue(
              `${kind}:${gamePk}:${row.person.id}`,
              "Incomplete or invalid game statistics; whole boxscore held for review",
            );
            bad = true;
          }
        }
      }
    if (!bad) {
      for (const line of lines) n.add(line);
      n.add({
        kind: "gameLineSet",
        key: String(gamePk),
        game: String(gamePk),
        battingPlayers: lines
          .filter((r) => r.kind === "battingGame")
          .map((r) => ("player" in r ? r.player : ""))
          .sort(),
        pitchingPlayers: lines
          .filter((r) => r.kind === "pitchingGame")
          .map((r) => ("player" in r ? r.player : ""))
          .sort(),
        lineKeys: lines.map(recordKey).sort(),
      });
    }
  } catch (error) {
    n.issue(
      `boxscore:${gamePk}`,
      error instanceof Error ? error.message : "Malformed boxscore",
    );
  }
  return boxPeople;
}

/**
 * Minimal projection of a boxscore response: team IDs and per-player person/position/game stats.
 * Large captures keep this instead of the full body (which also carries season stats, officials,
 * notes …), cutting retained memory by an order of magnitude. Unknown shapes are returned as-is
 * so normalization still reports them.
 */
export function projectBoxscore(body: unknown): unknown {
  const side = z.object({
    team: z.object({ id: z.unknown() }).passthrough(),
    players: z.record(z.string(), z.unknown()),
  });
  const parsed = z
    .object({ teams: z.object({ home: side, away: side }) })
    .safeParse(body);
  if (!parsed.success) return body;
  const players = (record: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, raw]) => {
        if (!raw || typeof raw !== "object") return [key, raw];
        const r = raw as Record<string, unknown>;
        const stats = (r.stats ?? {}) as Record<string, unknown>;
        return [
          key,
          {
            person: r.person,
            ...(r.position !== undefined ? { position: r.position } : {}),
            stats:
              r.stats === undefined
                ? undefined
                : {
                    ...(stats.batting !== undefined ? { batting: stats.batting } : {}),
                    ...(stats.pitching !== undefined ? { pitching: stats.pitching } : {}),
                  },
          },
        ];
      }),
    );
  const t = parsed.data.teams;
  // The batters/pitchers lists are kept: normalizeBoxscore uses them to recognise empty entries
  // listed under the wrong club.
  const lists = (s: Record<string, unknown>) => ({
    ...(Array.isArray(s.batters) ? { batters: s.batters } : {}),
    ...(Array.isArray(s.pitchers) ? { pitchers: s.pitchers } : {}),
  });
  const raw = body as { teams: { home: Record<string, unknown>; away: Record<string, unknown> } };
  return {
    teams: {
      home: { team: { id: t.home.team.id }, players: players(t.home.players), ...lists(raw.teams.home) },
      away: { team: { id: t.away.team.id }, players: players(t.away.players), ...lists(raw.teams.away) },
    },
  };
}
