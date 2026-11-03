/**
 * MLB Stats API adapter for the four full-season affiliated MiLB levels.
 *
 * Same contract, provider namespace ("mlb-stats-api"), identity rules, planner and sink as the
 * AFL adapter: a player, organization or game keeps ONE internal identity across AFL and MiLB.
 *
 * Hierarchy (discovered per season, verified at runtime — nothing below is assumed):
 *   sport (level: 11 AAA, 12 AA, 13 High-A, 14 Single-A)  ← sports/{id} name is checked
 *     → league   (league?sportId=…, plus each team's league)
 *       → team   (teams?sportId=…; parentOrgId → MLB organization, sportId 1)
 *         → roster observations / games / boxscore lines
 */
import { z } from "zod";
import type {
  IngestionNotice,
  NormalizedBatch,
  SourceAdapter,
  SourceSnapshot,
} from "../contracts";
import { fingerprint } from "../plan";
import { beginStage, updateStage } from "../progress";
import { MlbClient } from "./mlb-client";
import { MLB_SOURCE_ID } from "./mlb-config";
import {
  apiId,
  gameStatus,
  MlbNormalizer,
  normalizeBoxscore,
  personSchema,
  projectBoxscore,
  type ApiPerson,
} from "./mlb-normalize";
import {
  parseScheduleGroups,
  reconcileScheduleGroup,
  type ScheduleGame,
  type ScheduleRow,
} from "./mlb-schedule";
import {
  DEFAULT_MILB_GAME_TYPES,
  validateMilbOptions,
  type MilbOptions,
} from "./milb-config";
import {
  MILB_LEVELS,
  milbLevelExternalId,
  milbSeasonExternalId,
  type MilbLevelId,
} from "@/domain/levels";

export const MLB_SPORT_ID = 1;

const label = z.string().min(1);
const milbTeamSchema = z.object({
  id: apiId,
  name: label,
  abbreviation: label.optional(),
  teamCode: label.optional(),
  league: z.object({ id: apiId, name: label.optional() }).optional(),
  sport: z.object({ id: apiId }).optional(),
  parentOrgId: apiId.optional(),
  active: z.boolean().optional(),
});
type MilbTeam = z.infer<typeof milbTeamSchema>;
const leagueSchema = z.object({
  id: apiId,
  name: label,
  sport: z.object({ id: apiId }).optional(),
});
const rosterEntry = z.object({
  person: personSchema,
  position: z.object({ abbreviation: z.string() }).optional(),
  status: z
    .object({ code: z.string().optional(), description: z.string().optional() })
    .optional(),
});
const list = (body: unknown, key: string) =>
  z.object({ [key]: z.array(z.unknown()).max(20000) }).parse(body)[key];
const chunks = <T>(values: T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) =>
    values.slice(i * size, (i + 1) * size),
  );
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

interface Part {
  id: number;
  body?: unknown;
  error?: string;
}
interface LevelPayload {
  level: MilbLevelId;
  sportId: number;
  sport: unknown;
  leagues: unknown;
  teams: unknown;
  schedule?: unknown;
  scheduleError?: string;
}
interface Payload {
  options: MilbOptions;
  captureDate: string;
  levels: LevelPayload[];
  organizations: unknown;
  rosters: Part[];
  /** Projected boxscores (see projectBoxscore). */
  boxes: Part[];
  people: unknown[];
  /** Final games whose stored complete boxscore was reused instead of re-fetched. */
  reusedBoxscores: number[];
}

/** Level context resolved from discovery; shared by capture and normalization. */
interface LevelContext {
  level: MilbLevelId;
  sportId: number;
  leagues: Map<number, string>;
  teams: Map<number, MilbTeam>;
  /** True when league names came from the teams response because league discovery failed. */
  leaguesFromTeams: boolean;
}

/** Validates discovery responses for one level. Throws when the level cannot be trusted. */
export function resolveLevel(p: LevelPayload): LevelContext {
  const def = MILB_LEVELS[p.level];
  const sport = z
    .object({ sports: z.array(z.object({ id: apiId, name: label })) })
    .parse(p.sport)
    .sports.find((s) => s.id === p.sportId);
  if (!sport || !def.sportNamePattern.test(sport.name))
    throw new Error(
      `Sport ${p.sportId} is not ${def.label} in this season (got ${sport?.name ?? "nothing"})`,
    );
  const leagues = new Map<number, string>();
  let leaguesFromTeams = false;
  try {
    for (const raw of list(p.leagues, "leagues")) {
      const l = leagueSchema.safeParse(raw);
      if (l.success && (!l.data.sport || l.data.sport.id === p.sportId))
        leagues.set(l.data.id, l.data.name);
    }
  } catch {
    leaguesFromTeams = true;
  }
  const teams = new Map<number, MilbTeam>();
  for (const raw of list(p.teams, "teams")) {
    const t = milbTeamSchema.safeParse(raw);
    if (
      t.success &&
      t.data.sport?.id === p.sportId &&
      t.data.league &&
      t.data.active !== false
    )
      teams.set(t.data.id, t.data);
  }
  if (!teams.size) throw new Error(`No ${def.label} teams discovered`);
  // Fallback: the league endpoint failed, but every team names its league.
  if (leaguesFromTeams)
    for (const t of teams.values())
      if (t.league?.name) leagues.set(t.league.id, t.league.name);
  return { level: p.level, sportId: p.sportId, leagues, teams, leaguesFromTeams };
}

function milbGame(
  g: ScheduleGame,
  date: string,
  season: number,
  league: number,
) {
  return {
    kind: "game" as const,
    externalId: String(g.gamePk),
    season: milbSeasonExternalId(season),
    league: String(league),
    officialDate: g.officialDate ?? date,
    homeTeam: String(g.teams.home.team.id),
    awayTeam: String(g.teams.away.team.id),
    startsAt: new Date(g.gameDate).toISOString(),
    status: gameStatus(g.status),
    ...(g.teams.home.score !== undefined ? { homeScore: g.teams.home.score } : {}),
    ...(g.teams.away.score !== undefined ? { awayScore: g.teams.away.score } : {}),
    ...(g.venue ? { venue: g.venue.name } : {}),
  };
}

/**
 * Selects the games of one level's schedule response. Shared by capture (to decide which
 * boxscores to fetch) and normalization, so both always agree.
 */
export function selectMilbSchedule(
  body: unknown,
  ctx: LevelContext,
  options: MilbOptions,
) {
  const notices: IngestionNotice[] = [];
  const games = new Map<number, { row: ScheduleRow; record: ReturnType<typeof milbGame> }>();
  const parsed = parseScheduleGroups(body);
  const issues = parsed.issues;
  if (!parsed.valid) return { games, issues, notices };
  const gameTypes: string[] = options.gameTypes ?? [...DEFAULT_MILB_GAME_TYPES];
  const leagueOf = (g: ScheduleGame) => {
    if (g.leagueId !== undefined) {
      if (!ctx.leagues.has(g.leagueId) && !ctx.teams.has(g.teams.home.team.id))
        return undefined;
      return g.leagueId;
    }
    return ctx.teams.get(g.teams.home.team.id)?.league?.id;
  };
  const identity = (r: ScheduleRow) =>
    milbGame(r.game, r.date, options.season, leagueOf(r.game) ?? 0);
  for (const [id, rows] of parsed.groups) {
    if (parsed.blocked.has(id)) continue;
    try {
      const g0 = rows[0].game;
      if (g0.gameType !== undefined && !gameTypes.includes(g0.gameType)) {
        notices.push({
          recordKey: `game:${id}`,
          reason: "outside-scope",
          message: `gameType ${g0.gameType} is outside the selected game types`,
        });
        continue;
      }
      const sides = [g0.teams.home.team.id, g0.teams.away.team.id];
      const members = sides.map((t) => ctx.teams.has(t));
      const foreignSport = rows.some(
        (r) => r.game.sportId !== undefined && r.game.sportId !== ctx.sportId,
      );
      if (foreignSport && members.every((m) => !m)) {
        notices.push({
          recordKey: `game:${id}`,
          reason: "outside-scope",
          message: "Explicit foreign sport; neither participant is a team of this level",
        });
        continue;
      }
      if (foreignSport) throw new Error("Contradictory sport context for a level game");
      const { chosen, reconciled } = reconcileScheduleGroup(rows, identity, {
        allowSuspensions: true,
      });
      const g = chosen.game;
      const date = g.officialDate ?? chosen.date;
      // A lone postponed row that already points to a later reschedule is superseded by that
      // representation (which may fall in a different capture window). Never store it as the game.
      if (
        gameStatus(g.status) === "postponed" &&
        g.rescheduleGameDate &&
        g.rescheduleGameDate !== date
      ) {
        notices.push({
          recordKey: `game:${id}`,
          reason: "outside-scope",
          message: `Postponed representation superseded by reschedule on ${g.rescheduleGameDate}`,
        });
        continue;
      }
      if (reconciled)
        notices.push({
          recordKey: `game:${id}`,
          reason: "reconciled-reschedule",
          message:
            reconciled === "suspension"
              ? "Suspended representation reconciled to its resumed game"
              : "Linked postponed representation reconciled to current game",
        });
      if (
        rows.some(
          (r) =>
            r.game.season !== undefined &&
            String(r.game.season) !== String(options.season),
        ) ||
        Number(date.slice(0, 4)) !== options.season
      )
        throw new Error("Game season/date outside selected MiLB season");
      if (
        (options.from && date < options.from) ||
        (options.to && date > options.to) ||
        (options.team && !sides.includes(options.team))
      )
        continue;
      if (!members.every(Boolean))
        throw new Error("Unrecognized participants for this level");
      if (sides[0] === sides[1]) throw new Error("Game opponents must differ");
      const league = leagueOf(g);
      if (league === undefined || !ctx.leagues.has(league))
        throw new Error("Game league is not a discovered league of this level");
      if (
        options.league &&
        !sides.some((t) => ctx.teams.get(t)?.league?.id === options.league)
      )
        continue;
      games.set(id, { row: chosen, record: milbGame(g, date, options.season, league) });
    } catch (error) {
      issues.push({
        recordKey: `game:${id}`,
        code: "invalid-record",
        message: message(error, "Invalid MiLB game"),
      });
    }
  }
  return { games, issues, notices };
}

export interface MilbDependencies {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
  /** Source player IDs already stored; box-only players among them need no people lookup. */
  knownPlayers?: Set<number>;
}

export class MilbStatsApiSource implements SourceAdapter {
  readonly id = MLB_SOURCE_ID;
  readonly version = "milb-1";
  readonly options: MilbOptions;
  private capturing = false;
  constructor(
    options: MilbOptions,
    private readonly dependencies: MilbDependencies = {},
  ) {
    this.options = validateMilbOptions(options);
  }

  private newClient() {
    return new MlbClient({
      fetcher: this.dependencies.fetcher,
      sleep: this.dependencies.sleep,
      baseUrl: this.options.baseUrl,
      recordDir: this.options.recordDir,
      concurrency: this.options.concurrency ?? 4,
      // Only projected boxscores and small discovery bodies are kept; raw bodies are dropped.
      retainBodies: false,
    });
  }

  async load(): Promise<SourceSnapshot> {
    if (this.capturing)
      throw new Error("Concurrent captures require separate source instances");
    this.capturing = true;
    try {
      return await this.capture(this.newClient());
    } finally {
      this.capturing = false;
    }
  }

  private async capture(client: MlbClient): Promise<SourceSnapshot> {
    const o = this.options;
    const now = (this.dependencies.clock?.() ?? new Date()).toISOString();
    const captureDate = now.slice(0, 10);
    const season = { season: o.season };
    const mode = o.mode ?? "all";

    // Discovery is required for every mode; a failure aborts the capture (no unreliable scope).
    beginStage("acquire:milb-discovery", { levels: o.levels.join(",") });
    const levels: LevelPayload[] = [];
    for (const level of o.levels) {
      const sportId = MILB_LEVELS[level].sportId;
      const [sport, leagues, teams] = await Promise.all([
        client.get(`sports/${sportId}`),
        // Optional: league names can also be taken from each team's league reference.
        client
          .get("league", { sportId, ...season })
          .catch((error: unknown) => ({ error: message(error, "League request failed") })),
        client.get("teams", { sportId, ...season }),
      ]);
      levels.push({ level, sportId, sport, leagues, teams });
    }
    const organizations = await client.get("teams", {
      sportId: MLB_SPORT_ID,
      ...season,
    });
    const contexts = levels.map(resolveLevel);
    const allTeams = new Map<number, MilbTeam>();
    for (const ctx of contexts) for (const [id, t] of ctx.teams) allTeams.set(id, t);
    if (o.team && !allTeams.has(o.team))
      throw new Error("Selected --team is not a team of the selected levels");
    if (o.league && !contexts.some((c) => c.leagues.has(o.league!)))
      throw new Error("Selected --league is not a league of the selected levels");
    const scoped = (t: MilbTeam) =>
      (!o.team || t.id === o.team) && (!o.league || t.league?.id === o.league);

    const rosters: Part[] = [];
    if (mode !== "games") {
      const targets = [...allTeams.values()].filter(scoped);
      beginStage("acquire:rosters", { done: 0, total: targets.length });
      await Promise.all(
        targets.map(async (team) => {
          try {
            rosters.push({
              id: team.id,
              body: await client.get(`teams/${team.id}/roster`, {
                ...season,
                rosterType: o.rosterType ?? "fullSeason",
                hydrate: "person",
              }),
            });
          } catch (error) {
            rosters.push({ id: team.id, error: message(error, "Roster request failed") });
          }
          updateStage({ done: rosters.length });
        }),
      );
      rosters.sort((a, b) => a.id - b.id);
    }

    const boxes: Part[] = [];
    const reusedBoxscores: number[] = [];
    if (mode !== "structure") {
      const known = new Set(o.knownComplete ?? []);
      const refetchFrom = new Date(`${captureDate}T00:00:00Z`);
      refetchFrom.setUTCDate(refetchFrom.getUTCDate() - (o.refetchWindowDays ?? 3));
      const refetchSince = refetchFrom.toISOString().slice(0, 10);
      const toFetch: number[] = [];
      for (const [i, payload] of levels.entries()) {
        beginStage("acquire:schedule", { level: payload.level });
        try {
          payload.schedule = await client.get("schedule", {
            sportId: payload.sportId,
            ...season,
            startDate: o.from ?? `${o.season}-01-01`,
            endDate: o.to ?? `${o.season}-12-31`,
            ...(o.league ? { leagueId: o.league } : {}),
            ...(o.team ? { teamId: o.team } : {}),
          });
          for (const [id, { record }] of selectMilbSchedule(
            payload.schedule,
            contexts[i],
            o,
          ).games) {
            if (record.status !== "final") continue;
            // Unchanged completed games are not re-fetched, except recent ones (late corrections).
            if (known.has(id) && record.officialDate < refetchSince) reusedBoxscores.push(id);
            else toFetch.push(id);
          }
        } catch (error) {
          payload.scheduleError = message(error, "Schedule request failed");
        }
      }
      beginStage("acquire:boxscores", { done: 0, total: toFetch.length });
      await Promise.all(
        toFetch.map(async (id) => {
          try {
            boxes.push({ id, body: projectBoxscore(await client.get(`game/${id}/boxscore`)) });
          } catch (error) {
            boxes.push({ id, error: message(error, "Boxscore request failed") });
          }
          updateStage({ done: boxes.length });
        }),
      );
      boxes.sort((a, b) => a.id - b.id);
      reusedBoxscores.sort((a, b) => a - b);
    }

    // Players seen only in boxscores need their primary position/handedness from `people`
    // (a boxscore position is the game position, e.g. "PH"), unless already stored.
    const rosterPeople = new Set<number>();
    for (const part of rosters)
      if (part.body)
        try {
          for (const row of list(part.body, "roster")) {
            const r = rosterEntry.safeParse(row);
            if (r.success) rosterPeople.add(r.data.person.id);
          }
        } catch {
          /* normalization reports it */
        }
    const boxOnly = new Set<number>();
    for (const part of boxes)
      for (const person of boxPersonIds(part.body))
        if (!rosterPeople.has(person) && !this.dependencies.knownPlayers?.has(person))
          boxOnly.add(person);
    const people: unknown[] = [];
    beginStage("acquire:people", { players: boxOnly.size });
    await Promise.all(
      chunks([...boxOnly].sort((a, b) => a - b), 50).map(async (ids) => {
        try {
          people.push(await client.get("people", { personIds: ids.join(",") }));
        } catch (error) {
          people.push({ error: message(error, "People request failed") });
        }
      }),
    );

    const manifest = client.documents
      .map((d) => ({ url: d.url, fetchedAt: d.fetchedAt, contentHash: d.contentHash }))
      .sort((a, b) => a.url.localeCompare(b.url));
    const payload: Payload = {
      options: o,
      captureDate,
      levels,
      organizations,
      rosters,
      boxes,
      people,
      reusedBoxscores,
    };
    return {
      provider: this.id,
      adapterVersion: this.version,
      key: milbSnapshotKey(o),
      observedAt: now,
      fetchedAt: now,
      sourceUrl: manifest[0]?.url ?? "https://statsapi.mlb.com/api/v1/",
      storedPayload: {
        format: "mlb-response-manifest-v1",
        scope: "milb",
        season: o.season,
        levels: o.levels,
        sportIds: levels.map((l) => l.sportId),
        documents: manifest,
      },
      // The capture identity is the manifest (url + body hash), not a re-serialization of
      // every projected body.
      rawContentHash: fingerprint(manifest.map((d) => [d.url, d.contentHash])),
      payload,
    };
  }

  normalize(snapshot: SourceSnapshot): NormalizedBatch {
    const p = snapshot.payload as Payload;
    const o = p.options;
    const n = new MlbNormalizer();
    const seasonId = milbSeasonExternalId(o.season);
    n.add({
      kind: "season",
      externalId: seasonId,
      year: o.season,
      name: `Minor League Baseball ${o.season}`,
    });

    // MLB parent organizations (sportId 1). Discovery failure was fatal at capture.
    const orgs = new Map<number, { name: string; abbreviation: string }>();
    try {
      for (const raw of list(p.organizations, "teams")) {
        const t = milbTeamSchema.safeParse(raw);
        const abbreviation = t.success ? (t.data.abbreviation ?? t.data.teamCode) : undefined;
        if (t.success && t.data.sport?.id === MLB_SPORT_ID && abbreviation)
          orgs.set(t.data.id, { name: t.data.name, abbreviation });
      }
    } catch {
      n.issue("organizations", "Malformed MLB organization response");
    }

    const contexts: LevelContext[] = [];
    const teamOrg = new Map<number, string | null>();
    for (const levelPayload of p.levels) {
      let ctx: LevelContext;
      try {
        ctx = resolveLevel(levelPayload);
      } catch (error) {
        n.issue(`level:${levelPayload.sportId}`, message(error, "Malformed level discovery"));
        continue;
      }
      contexts.push(ctx);
      if (ctx.leaguesFromTeams)
        n.notices.push({
          recordKey: `level:${ctx.sportId}`,
          reason: "discovery-fallback",
          message: "League discovery failed; league names taken from team league references",
        });
      const label = MILB_LEVELS[ctx.level].label;
      const usedLeagues = new Set<number>();
      for (const team of ctx.teams.values()) {
        const leagueId = team.league!.id;
        if (!ctx.leagues.has(leagueId)) {
          n.issue(`team:${team.id}`, "Team league is not a discovered league of its level");
          continue;
        }
        const abbreviation = team.abbreviation ?? team.teamCode;
        if (!abbreviation) {
          n.issue(`team:${team.id}`, "Team has no abbreviation or team code");
          continue;
        }
        usedLeagues.add(leagueId);
        const parent = team.parentOrgId ? orgs.get(team.parentOrgId) : undefined;
        if (parent) {
          n.add({
            kind: "organization",
            externalId: String(team.parentOrgId),
            name: parent.name,
            abbreviation: parent.abbreviation,
          });
        } else
          n.notices.push({
            recordKey: `team:${team.id}`,
            reason: "unresolved-affiliation",
            message: team.parentOrgId
              ? "parentOrgId is not a verified MLB (sportId 1) organization; affiliation left unresolved"
              : "No parent organization supplied; affiliation left unresolved",
          });
        const organization = parent ? String(team.parentOrgId) : null;
        teamOrg.set(team.id, organization);
        n.add({
          kind: "team",
          externalId: String(team.id),
          name: team.name,
          abbreviation,
          level: milbLevelExternalId(ctx.sportId, leagueId),
          organization,
        });
      }
      for (const leagueId of usedLeagues) {
        n.add({ kind: "league", externalId: String(leagueId), name: ctx.leagues.get(leagueId)! });
        n.add({
          kind: "level",
          externalId: milbLevelExternalId(ctx.sportId, leagueId),
          league: String(leagueId),
          name: label,
        });
      }
    }

    // Rosters: hydrated people + observation rows. A failed roster is an issue, never "empty".
    const persons = new Map<number, { person: ApiPerson; position?: string; fromRoster: boolean }>();
    const observations: { teamId: number; entry: z.infer<typeof rosterEntry> }[] = [];
    for (const part of p.rosters) {
      if (part.error) {
        n.issue(`roster:${part.id}`, part.error);
        continue;
      }
      try {
        for (const raw of list(part.body, "roster")) {
          const entry = rosterEntry.safeParse(raw);
          if (!entry.success) {
            n.issue(`roster:${part.id}`, "Malformed roster entry");
            continue;
          }
          persons.set(entry.data.person.id, {
            person: entry.data.person,
            position: entry.data.position?.abbreviation,
            fromRoster: true,
          });
          observations.push({ teamId: part.id, entry: entry.data });
        }
      } catch {
        n.issue(`roster:${part.id}`, "Malformed roster response");
      }
    }

    // Schedules and boxscores.
    const selected = new Map<number, ScheduleGame>();
    for (const levelPayload of p.levels) {
      const ctx = contexts.find((c) => c.sportId === levelPayload.sportId);
      if (!ctx) continue;
      if (levelPayload.scheduleError) n.issue(`schedule:${ctx.sportId}`, levelPayload.scheduleError);
      if (levelPayload.schedule === undefined) continue;
      const result = selectMilbSchedule(levelPayload.schedule, ctx, o);
      n.issues.push(...result.issues);
      n.notices.push(...result.notices);
      for (const [id, { row, record }] of result.games)
        if (n.add(record)) selected.set(id, row.game);
    }
    if (p.reusedBoxscores.length)
      n.notices.push({
        recordKey: "boxscores",
        reason: "reused-boxscores",
        message: `${p.reusedBoxscores.length} final games already stored with complete boxscores were not re-fetched`,
      });
    for (const part of p.boxes) {
      if (part.error) {
        n.issue(`boxscore:${part.id}`, part.error);
        continue;
      }
      const game = selected.get(part.id);
      if (!game) continue;
      for (const seen of normalizeBoxscore(n, part.id, part.body, {
        home: game.teams.home.team.id,
        away: game.teams.away.team.id,
      }))
        if (!persons.has(seen.person.id))
          persons.set(seen.person.id, { person: seen.person, fromRoster: false });
    }

    // People enrichment for box-only players (primary position, handedness, birth date …).
    for (const body of p.people)
      try {
        for (const raw of list(body, "people")) {
          const person = personSchema.safeParse(raw);
          if (!person.success) {
            n.issue("person-enrichment", "Malformed person enrichment");
            continue;
          }
          const prior = persons.get(person.data.id);
          if (prior && !prior.fromRoster)
            persons.set(person.data.id, { person: person.data, fromRoster: false });
        }
      } catch {
        n.issue("person-enrichment", "People enrichment failed for a batch");
      }
    for (const { person, position, fromRoster } of persons.values()) {
      // A box-only player without a primary position emits no player record: if the identity is
      // already stored the lines still apply; otherwise the planner quarantines them. A game
      // position (PH/PR) is never written as a primary position.
      if (!fromRoster && !person.primaryPosition) continue;
      n.person(person, fromRoster ? position : undefined);
    }
    for (const { teamId, entry } of observations)
      n.add({
        kind: "rosterObservation",
        key: `milb:${o.season}:${teamId}:${entry.person.id}`,
        season: seasonId,
        player: String(entry.person.id),
        team: String(teamId),
        // The observed affiliate's verified parent at capture time; historical rows keep theirs.
        organization: teamOrg.get(teamId) ?? null,
        ...((entry.status?.description ?? entry.status?.code)
          ? { rosterStatus: entry.status?.description ?? entry.status?.code }
          : {}),
      });
    return n.result();
  }
}

function boxPersonIds(body: unknown): number[] {
  const parsed = z
    .object({
      teams: z.object({
        home: z.object({ players: z.record(z.string(), z.unknown()) }),
        away: z.object({ players: z.record(z.string(), z.unknown()) }),
      }),
    })
    .safeParse(body);
  if (!parsed.success) return [];
  const ids: number[] = [];
  for (const side of [parsed.data.teams.home, parsed.data.teams.away])
    for (const row of Object.values(side.players)) {
      const p = z.object({ person: z.object({ id: apiId }) }).safeParse(row);
      if (p.success) ids.push(p.data.person.id);
    }
  return ids;
}

export function milbSnapshotKey(o: MilbOptions) {
  return [
    "milb",
    o.season,
    [...o.levels].sort().join("+"),
    o.mode ?? "all",
    o.from ?? "season",
    o.to ?? "end",
    o.league ? `league-${o.league}` : "all-leagues",
    o.team ? `team-${o.team}` : "all-teams",
  ].join(":");
}
