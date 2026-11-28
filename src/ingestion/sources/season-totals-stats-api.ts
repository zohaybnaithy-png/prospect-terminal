/**
 * Player season totals per level from the MLB Stats API season-stats endpoint (D-030, T-503): MiLB history
 * (Triple-A to Single-A) and MLB outcomes for the Prospect Grade (docs/GRADE-METHOD.md, D-029).
 *
 * One capture = one season and one scope ("milb": the four full-season levels; "mlb": sportId 1). Per level and
 * group (hitting / pitching) the provider returns one row per player, already combined across teams and leagues at
 * that level. Sport names are verified at runtime (historical names included, src/domain/levels.ts). A response whose
 * row count disagrees with its own `totalSplits` (truncated page) fails the capture. Player records are emitted only
 * for players not already stored (`knownPlayers`), from the people endpoint; stored players are referenced, never
 * rewritten from a historical capture. No team or league entities are emitted, so current team and league
 * attributes are never overwritten with historical ones.
 */
import { z } from "zod";
import { recordSchema, type NormalizedBatch, type SourceAdapter, type SourceSnapshot } from "../contracts";
import { MILB_LEVELS, MILB_LEVEL_IDS, milbSeasonExternalId, type MilbLevelId } from "@/domain/levels";
import { fingerprint } from "../plan";
import { beginStage } from "../progress";
import { MlbClient } from "./mlb-client";
import { MLB_SOURCE_ID } from "./mlb-config";
import { MlbNormalizer, battingStats, personSchema, pitchingStats } from "./mlb-normalize";

export type SeasonTotalsScope = "milb" | "mlb";
export type SeasonLevelCode = MilbLevelId | "mlb";

export interface SeasonTotalsOptions {
  season: number;
  scope: SeasonTotalsScope;
  baseUrl?: string;
  concurrency?: number;
  recordDir?: string;
}

export interface SeasonTotalsDependencies {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
  /** Source player ids already stored: referenced, not re-fetched or rewritten. */
  knownPlayers?: Set<number>;
}

export const MLB_SPORT = { sportId: 1, sportNamePattern: /^major league baseball$/i } as const;
const FIRST_SEASON = 2005;
const PEOPLE_BATCH = 50;

export const mlbSeasonExternalId = (season: number) => `mlb-${season}`;
export const seasonTotalsSnapshotKey = (o: Pick<SeasonTotalsOptions, "season" | "scope">) =>
  `season-totals:${o.scope}:${o.season}`;

export function validateSeasonTotalsOptions(o: SeasonTotalsOptions, now = new Date()): SeasonTotalsOptions {
  const current = now.getUTCFullYear();
  if (!Number.isInteger(o.season) || o.season < FIRST_SEASON || o.season > current)
    throw new Error(`season must be a year from ${FIRST_SEASON} to ${current}`);
  if (o.scope !== "milb" && o.scope !== "mlb") throw new Error("scope must be milb or mlb");
  if (o.season === 2020 && o.scope === "milb") throw new Error("there was no 2020 MiLB season");
  return o;
}

const levelsFor = (scope: SeasonTotalsScope): { code: SeasonLevelCode; sportId: number; pattern: RegExp }[] =>
  scope === "mlb"
    ? [{ code: "mlb", sportId: MLB_SPORT.sportId, pattern: MLB_SPORT.sportNamePattern }]
    : MILB_LEVEL_IDS.map((id) => ({ code: id, sportId: MILB_LEVELS[id].sportId, pattern: MILB_LEVELS[id].sportNamePattern }));

const apiId = z.number().int().positive();
const statsPage = z.object({
  stats: z
    .array(
      z.object({
        totalSplits: z.number().int().nonnegative(),
        splits: z
          .array(
            z.object({
              season: z.string().optional(),
              numTeams: z.number().int().min(1).max(30).optional(),
              player: z.object({ id: apiId }),
              sport: z.object({ id: apiId }).optional(),
              stat: z.record(z.string(), z.unknown()),
            }),
          )
          .max(20000),
      }),
    )
    .length(1),
});

/** A projected season row (only what normalization needs is kept in the payload). */
interface TotalsRow {
  playerId: number;
  numTeams: number;
  stat: Record<string, unknown>;
}

interface LevelCapture {
  code: SeasonLevelCode;
  sportId: number;
  sportName: string;
  hitting: TotalsRow[];
  pitching: TotalsRow[];
}

interface Payload {
  options: SeasonTotalsOptions;
  levels: LevelCapture[];
  people: unknown[];
}

const HITTING_KEYS = [
  "gamesPlayed", "plateAppearances", "atBats", "hits", "doubles", "triples", "homeRuns", "baseOnBalls", "strikeOuts",
  "hitByPitch", "sacFlies", "stolenBases", "runs", "rbi", "caughtStealing", "sacBunts", "catchersInterference",
];
const PITCHING_KEYS = [
  "gamesPitched", "outs", "inningsPitched", "battersFaced", "hits", "earnedRuns", "baseOnBalls", "strikeOuts",
  "homeRuns", "runs", "hitBatsmen", "numberOfPitches",
];
const project = (stat: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => stat[k] !== undefined).map((k) => [k, stat[k]]));

const chunks = <T>(values: T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

export class SeasonTotalsStatsApiSource implements SourceAdapter {
  readonly id = MLB_SOURCE_ID;
  readonly version = "season-totals-1";
  readonly options: SeasonTotalsOptions;
  constructor(
    options: SeasonTotalsOptions,
    private readonly dependencies: SeasonTotalsDependencies = {},
  ) {
    this.options = validateSeasonTotalsOptions(options, dependencies.clock?.() ?? new Date());
  }

  async load(): Promise<SourceSnapshot> {
    const o = this.options;
    const client = new MlbClient({
      fetcher: this.dependencies.fetcher,
      sleep: this.dependencies.sleep,
      baseUrl: o.baseUrl,
      recordDir: o.recordDir,
      concurrency: o.concurrency ?? 2,
      retainBodies: false,
    });
    const levels: LevelCapture[] = [];
    for (const l of levelsFor(o.scope)) {
      beginStage("season-totals:level", { season: o.season, level: l.code });
      const sport = z
        .object({ sports: z.array(z.object({ id: apiId, name: z.string() })).min(1) })
        .parse(await client.get(`sports/${l.sportId}`, { season: o.season })).sports[0];
      // Sport ids are verified against their names (historical names included), never assumed.
      if (sport.id !== l.sportId || !l.pattern.test(sport.name))
        throw new Error(`sportId ${l.sportId} is "${sport.name}" in ${o.season}, not the expected ${l.code} level`);
      const group = async (name: "hitting" | "pitching", keys: string[]): Promise<TotalsRow[]> => {
        const page = statsPage.parse(
          await client.get("stats", {
            stats: "season",
            group: name,
            sportId: l.sportId,
            season: o.season,
            gameType: "R",
            playerPool: "ALL",
            limit: 20000,
          }),
        ).stats[0];
        // A page shorter than its own total would silently drop players: fail the capture instead.
        if (page.splits.length !== page.totalSplits)
          throw new Error(`${l.code} ${name} ${o.season}: ${page.splits.length} rows for ${page.totalSplits} splits`);
        return page.splits.map((s) => {
          if (s.season !== undefined && s.season !== String(o.season))
            throw new Error(`${l.code} ${name}: a row for season ${s.season} in the ${o.season} response`);
          if (s.sport && s.sport.id !== l.sportId)
            throw new Error(`${l.code} ${name}: a row for sportId ${s.sport.id} in the ${l.sportId} response`);
          return { playerId: s.player.id, numTeams: s.numTeams ?? 1, stat: project(s.stat, keys) };
        });
      };
      levels.push({
        code: l.code,
        sportId: l.sportId,
        sportName: sport.name,
        hitting: await group("hitting", HITTING_KEYS),
        pitching: await group("pitching", PITCHING_KEYS),
      });
    }
    const unknown = new Set<number>();
    for (const l of levels)
      for (const r of [...l.hitting, ...l.pitching])
        if (!this.dependencies.knownPlayers?.has(r.playerId)) unknown.add(r.playerId);
    beginStage("season-totals:people", { players: unknown.size });
    const people: unknown[] = [];
    for (const ids of chunks([...unknown].sort((a, b) => a - b), PEOPLE_BATCH))
      people.push(await client.get("people", { personIds: ids.join(",") }));
    const manifest = client.documents
      .map((d) => ({ url: d.url, fetchedAt: d.fetchedAt, contentHash: d.contentHash }))
      .sort((a, b) => a.url.localeCompare(b.url));
    const now = (this.dependencies.clock?.() ?? new Date()).toISOString();
    const payload: Payload = { options: o, levels, people };
    return {
      provider: this.id,
      adapterVersion: this.version,
      key: seasonTotalsSnapshotKey(o),
      observedAt: now,
      fetchedAt: now,
      sourceUrl: manifest[0]?.url ?? "https://statsapi.mlb.com/api/v1/",
      storedPayload: {
        format: "mlb-response-manifest-v1",
        scope: `season-totals:${o.scope}`,
        season: o.season,
        sportIds: levels.map((l) => l.sportId),
        documents: manifest,
      },
      rawContentHash: fingerprint(manifest.map((d) => [d.url, d.contentHash])),
      payload,
    };
  }

  normalize(snapshot: SourceSnapshot): NormalizedBatch {
    const p = snapshot.payload as Payload;
    const o = p.options;
    const n = new MlbNormalizer();
    const season = o.scope === "mlb" ? mlbSeasonExternalId(o.season) : milbSeasonExternalId(o.season);
    n.add({
      kind: "season",
      externalId: season,
      year: o.season,
      name: o.scope === "mlb" ? `Major League Baseball ${o.season}` : `Minor League Baseball ${o.season}`,
    });
    for (const body of p.people) {
      const parsed = z.object({ people: z.array(z.unknown()) }).safeParse(body);
      if (!parsed.success) {
        n.issue("people", "People response was not usable");
        continue;
      }
      for (const raw of parsed.data.people) {
        const person = personSchema.safeParse(raw);
        if (person.success) n.person(person.data);
        else n.issue("player", "Malformed person record");
      }
    }
    for (const l of p.levels)
      for (const [kind, rows, toStats, gamesKey] of [
        ["battingSeason", l.hitting, battingStats, "gamesPlayed"],
        ["pitchingSeason", l.pitching, pitchingStats, "gamesPitched"],
      ] as const)
        for (const r of rows) {
          const player = String(r.playerId);
          const key = `${season}:${l.code}:${player}`;
          let stats: unknown;
          try {
            stats = toStats(r.stat);
          } catch (error) {
            n.issue(`${kind}:${key}`, error instanceof Error ? error.message : "Malformed season totals");
            continue;
          }
          const record = { kind, key, player, season, levelCode: l.code, games: r.stat[gamesKey], teams: r.numTeams, stats };
          const valid = recordSchema.safeParse(record);
          if (!valid.success) {
            n.issue(`${kind}:${key}`, `Season totals failed validation: ${valid.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
            continue;
          }
          n.add(valid.data);
        }
    return n.result();
  }
}
