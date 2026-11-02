import { z } from "zod";
import { fingerprint } from "../plan";
import type {
  SourceAdapter,
  SourceSnapshot,
  NormalizedBatch,
  IngestionRecord,
} from "../contracts";
import { recordSchema, recordKey } from "../contracts";
import { selectAflSchedule, normalizedGame } from "./mlb-schedule";
import type { ScheduleGame } from "./mlb-schedule";
import { MlbClient } from "./mlb-client";
import { beginStage, updateStage } from "../progress";
import { AFL, MLB_SOURCE_ID, validateMlbOptions } from "./mlb-config";
import type { MlbOptions } from "./mlb-config";
import {
  apiId,
  teamSchema,
  personSchema,
  MlbNormalizer,
  foundationalRecords,
  gameStatus,
  battingStats,
  pitchingStats,
} from "./mlb-normalize";
import type { ApiPerson } from "./mlb-normalize";
interface Part {
  id: number;
  body?: unknown;
  error?: string;
}
interface Payload {
  options: MlbOptions;
  league: unknown;
  teams: unknown;
  rosters: Part[];
  people: unknown[];
  organizationTeams: unknown[];
  schedule?: unknown;
  scheduleError?: string;
  boxes: Part[];
  documents: unknown[];
}
const list = (body: unknown, key: string) =>
  z.object({ [key]: z.array(z.unknown()).max(10000) }).parse(body)[key];
const rosterEntry = z.object({
  person: personSchema,
  position: z.object({ abbreviation: z.string() }).optional(),
  status: z
    .object({ code: z.string().optional(), description: z.string().optional() })
    .optional(),
});
const chunks = <T>(values: T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) =>
    values.slice(i * size, (i + 1) * size),
  );
export class MLBStatsApiSource implements SourceAdapter {
  readonly id = MLB_SOURCE_ID;
  readonly version = "2";
  readonly options: MlbOptions;
  private client: MlbClient;
  private capturing = false;
  constructor(
    options: MlbOptions,
    private readonly dependencies: {
      fetcher?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      clock?: () => Date;
    } = {},
  ) {
    this.options = validateMlbOptions(options);
    this.client = new MlbClient({
      ...dependencies,
      baseUrl: options.baseUrl,
      recordDir: options.recordDir,
    });
  }
  async load(): Promise<SourceSnapshot> {
    if (this.capturing)
      throw new Error("Concurrent captures require separate source instances");
    this.capturing = true;
    this.client = new MlbClient({
      ...this.dependencies,
      baseUrl: this.options.baseUrl,
      recordDir: this.options.recordDir,
    });
    try {
      return await this.capture();
    } finally {
      this.capturing = false;
    }
  }
  private async capture(): Promise<SourceSnapshot> {
    const o = this.options;
    const params = { season: o.season };
    beginStage("acquire:league");
    const league = await this.client.get(`league/${AFL.leagueId}`, params);
    const confirmed = z
      .object({
        leagues: z.array(
          z.object({
            id: apiId,
            name: z.string(),
            sport: z.object({ id: apiId }).optional(),
          }),
        ),
      })
      .parse(league)
      .leagues.find(
        (l) => l.id === AFL.leagueId && /arizona fall/i.test(l.name),
      );
    if (!confirmed || (confirmed.sport && confirmed.sport.id !== AFL.sportId))
      throw new Error(
        "League response does not match configured AFL league 119 / sport 17",
      );
    beginStage("acquire:teams");
    const teams = await this.client.get("teams", {
      ...params,
      leagueIds: AFL.leagueId,
      sportId: AFL.sportId,
    });
    const discovered = list(teams, "teams").flatMap((raw) => {
      const p = teamSchema.safeParse(raw);
      return p.success &&
        p.data.league?.id === AFL.leagueId &&
        p.data.sport?.id === AFL.sportId
        ? [p.data]
        : [];
    });
    if (!discovered.length)
      throw new Error("No valid AFL teams discovered for selected season");
    if (o.team && !discovered.some((t) => t.id === o.team))
      throw new Error("Selected --team is not an AFL team in this season");
    const rosterTeams = o.team
      ? discovered.filter((t) => t.id === o.team)
      : discovered;
    const rosters: Part[] = [];
    if (o.mode !== "games") {
      beginStage("acquire:rosters", { done: 0, total: rosterTeams.length });
      for (const team of rosterTeams) {
        updateStage({ done: rosters.length });
        try {
          rosters.push({
            id: team.id,
            body: await this.client.get(`teams/${team.id}/roster`, {
              ...params,
              rosterType: "fullSeason",
              hydrate: "person",
            }),
          });
        } catch (error) {
          rosters.push({
            id: team.id,
            error:
              error instanceof Error ? error.message : "Roster request failed",
          });
        }
      }
    }
    let schedule: unknown;
    let scheduleError: string | undefined;
    const boxes: Part[] = [];
    if (o.mode !== "rosters") {
      try {
        beginStage("acquire:schedule");
        schedule = await this.client.get("schedule", {
          ...params,
          leagueId: AFL.leagueId,
          sportId: AFL.sportId,
          startDate: o.from ?? `${o.season}-01-01`,
          endDate: o.to ?? `${o.season}-12-31`,
          teamId: o.team,
        });
        const selected = selectAflSchedule(
          schedule,
          new Set(discovered.map((t) => t.id)),
          o,
        );
        beginStage("acquire:boxscores", { done: 0 });
        for (const { game: g } of selected.games.values()) {
          updateStage({ done: boxes.length });
          try {
            if (gameStatus(g.status) !== "final") continue;
            boxes.push({
              id: g.gamePk,
              body: await this.client.get(`game/${g.gamePk}/boxscore`),
            });
          } catch (error) {
            boxes.push({
              id: g.gamePk,
              error:
                error instanceof Error
                  ? error.message
                  : "Boxscore request failed",
            });
          }
        }
      } catch (error) {
        scheduleError =
          error instanceof Error ? error.message : "Schedule request failed";
      }
    }

    const personIds = new Set<number>();
    for (const part of rosters)
      if (part.body)
        try {
          for (const row of list(part.body, "roster")) {
            const parsed = rosterEntry.safeParse(row);
            if (parsed.success) personIds.add(parsed.data.person.id);
          }
        } catch {
          /* Normalization emits diagnostics. */
        }
    for (const part of boxes)
      if (part.body)
        try {
          const sides = z
            .object({
              teams: z.object({
                home: z.object({ players: z.record(z.string(), z.unknown()) }),
                away: z.object({ players: z.record(z.string(), z.unknown()) }),
              }),
            })
            .parse(part.body);
          for (const side of [sides.teams.home, sides.teams.away])
            for (const row of Object.values(side.players)) {
              const parsed = z.object({ person: personSchema }).safeParse(row);
              if (parsed.success) personIds.add(parsed.data.person.id);
            }
        } catch {
          /* Normalization emits diagnostics. */
        }
    const people: unknown[] = [];
    beginStage("acquire:people", { players: personIds.size });
    for (const ids of chunks(
      [...personIds].sort((a, b) => a - b),
      50,
    )) {
      try {
        people.push(
          await this.client.get("people", {
            personIds: ids.join(","),
            hydrate: "currentTeam",
          }),
        );
      } catch (error) {
        people.push({
          error:
            error instanceof Error ? error.message : "People request failed",
        });
      }
    }
    const currentTeams = new Set<number>();
    for (const response of people)
      try {
        for (const row of list(response, "people")) {
          const p = personSchema.safeParse(row);
          if (p.success && p.data.currentTeam)
            currentTeams.add(p.data.currentTeam.id);
        }
      } catch {
        /* Optional enrichment stays unresolved. */
      }
    const organizationTeams: unknown[] = [];
    beginStage("acquire:organization-teams");
    const known = new Set(discovered.map((t) => t.id));
    for (const ids of chunks(
      [...currentTeams].filter((id) => !known.has(id)),
      50,
    )) {
      try {
        const body = await this.client.get("teams", {
          teamIds: ids.join(","),
          ...params,
        });
        organizationTeams.push(body);
        for (const row of list(body, "teams")) {
          const t = teamSchema.safeParse(row);
          if (t.success) known.add(t.data.id);
        }
      } catch (error) {
        organizationTeams.push({
          error:
            error instanceof Error ? error.message : "Team enrichment failed",
        });
      }
    }
    const parentIds = new Set<number>();
    for (const response of organizationTeams)
      try {
        for (const row of list(response, "teams")) {
          const t = teamSchema.safeParse(row);
          if (
            t.success &&
            t.data.sport?.id !== AFL.sportId &&
            t.data.parentOrgId &&
            !known.has(t.data.parentOrgId)
          )
            parentIds.add(t.data.parentOrgId);
        }
      } catch {
        /* Optional enrichment. */
      }
    beginStage("acquire:parent-organizations", { teams: parentIds.size });
    for (const ids of chunks([...parentIds], 50))
      try {
        organizationTeams.push(
          await this.client.get("teams", { teamIds: ids.join(","), ...params }),
        );
      } catch (error) {
        organizationTeams.push({
          error:
            error instanceof Error
              ? error.message
              : "Parent team lookup failed",
        });
      }
    const now = (this.dependencies.clock?.() ?? new Date()).toISOString();
    const payload: Payload = {
      options: o,
      league,
      teams,
      rosters,
      people,
      organizationTeams,
      ...(schedule ? { schedule } : {}),
      boxes,
      ...(scheduleError ? { scheduleError } : {}),
      documents: this.client.documents,
    };
    return {
      provider: this.id,
      adapterVersion: this.version,
      key: `afl:${o.season}:${o.mode ?? "all"}:${o.from ?? "season"}:${o.to ?? "end"}:${o.team ?? "all"}`,
      observedAt: now,
      fetchedAt: now,
      sourceUrl: this.client.documents[0].url,
      storedPayload: {
        format: "mlb-response-manifest-v1",
        season: o.season,
        leagueId: 119,
        sportId: 17,
        documents: this.client.documents.map((d) => ({
          url: d.url,
          fetchedAt: d.fetchedAt,
          contentHash: fingerprint(d.body),
        })),
      },
      payload,
    };
  }
  normalize(snapshot: SourceSnapshot): NormalizedBatch {
    const p = snapshot.payload as Payload;
    const n = new MlbNormalizer();
    try {
      const leagues = z
        .object({ leagues: z.array(z.object({ id: apiId, name: z.string() })) })
        .parse(p.league).leagues;
      const league = leagues.find((l) => l.id === AFL.leagueId);
      if (!league) throw new Error("Missing AFL metadata");
      foundationalRecords(n, p.options.season, league.name);
    } catch {
      n.issue("league:119", "Malformed AFL discovery response");
      return n.result();
    }
    const teams = new Map<number, z.infer<typeof teamSchema>>();
    for (const raw of list(p.teams, "teams")) {
      const t = teamSchema.safeParse(raw);
      if (
        !t.success ||
        t.data.league?.id !== 119 ||
        t.data.sport?.id !== 17 ||
        !(t.data.abbreviation ?? t.data.teamCode)
      ) {
        n.issue("team", "Malformed or wrong-context AFL team");
        continue;
      }
      teams.set(t.data.id, t.data);
      n.add({
        kind: "team",
        externalId: String(t.data.id),
        name: t.data.name,
        abbreviation: t.data.abbreviation ?? t.data.teamCode,
        level: "afl-assignment",
        organization: null,
      });
    }
    const persons = new Map<number, { person: ApiPerson; position?: string }>();
    const rosterRows: { teamId: number; entry: z.infer<typeof rosterEntry> }[] =
      [];
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
          });
          rosterRows.push({ teamId: part.id, entry: entry.data });
        }
      } catch {
        n.issue(`roster:${part.id}`, "Malformed roster response");
      }
    }
    if (p.scheduleError) n.issue("schedule", p.scheduleError);
    const games = new Map<number, ScheduleGame>();
    if (p.schedule) {
      const selected = selectAflSchedule(
        p.schedule,
        new Set(teams.keys()),
        p.options,
      );
      n.issues.push(...selected.issues);
      n.notices.push(...selected.notices);
      for (const [id, { game, date }] of selected.games) {
        if (n.add(normalizedGame(game, date, p.options.season)))
          games.set(id, game);
      }
    }
    for (const part of p.boxes) {
      if (part.error) {
        n.issue(`boxscore:${part.id}`, part.error);
        continue;
      }
      const game = games.get(part.id);
      if (!game) continue;
      try {
        const box = z
          .object({
            teams: z.object({
              home: z.object({
                team: z.object({ id: apiId }),
                players: z.record(z.string(), z.unknown()),
              }),
              away: z.object({
                team: z.object({ id: apiId }),
                players: z.record(z.string(), z.unknown()),
              }),
            }),
          })
          .parse(part.body);
        if (
          box.teams.home.team.id !== game.teams.home.team.id ||
          box.teams.away.team.id !== game.teams.away.team.id
        )
          throw new Error("Boxscore teams disagree with schedule");
        const lines: IngestionRecord[] = [];
        const boxPeople: { person: ApiPerson; position?: string }[] = [];
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
              n.issue(
                `boxscore:${part.id}:${key}`,
                "Malformed boxscore player",
              );
              bad = true;
              continue;
            }
            const row = entry.data;
            boxPeople.push({
              person: row.person,
              position: row.position?.abbreviation,
            });
            for (const kind of ["battingGame", "pitchingGame"] as const) {
              const stats =
                kind === "battingGame" ? row.stats.batting : row.stats.pitching;
              if (!stats || !Object.keys(stats).length) continue;
              try {
                const record = recordSchema.parse({
                  kind,
                  key: `${part.id}:${row.person.id}`,
                  player: String(row.person.id),
                  game: String(part.id),
                  team: String(side.team.id),
                  stats:
                    kind === "battingGame"
                      ? battingStats(stats)
                      : pitchingStats(stats),
                });
                lines.push(record);
              } catch {
                n.issue(
                  `${kind}:${part.id}:${row.person.id}`,
                  "Incomplete or invalid game statistics; whole boxscore held for review",
                );
                bad = true;
              }
            }
          }
        for (const person of boxPeople)
          if (!persons.has(person.person.id))
            persons.set(person.person.id, person);
        if (!bad) {
          for (const line of lines) n.add(line);
          n.add({
            kind: "gameLineSet",
            key: String(part.id),
            game: String(part.id),
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
          `boxscore:${part.id}`,
          error instanceof Error ? error.message : "Malformed boxscore",
        );
      }
    }
    for (const body of p.people)
      try {
        for (const raw of list(body, "people")) {
          const person = personSchema.safeParse(raw);
          if (!person.success) {
            n.issue("person-enrichment", "Malformed person enrichment");
            continue;
          }
          const prior = persons.get(person.data.id);
          if (prior)
            persons.set(person.data.id, {
              person: person.data,
              position: prior.position,
            });
        }
      } catch {
        n.issue(
          "person-enrichment",
          "People enrichment failed; roster/boxscore fields retained where valid",
        );
      }
    const details = new Map(teams);
    for (const body of p.organizationTeams)
      try {
        for (const raw of list(body, "teams")) {
          const team = teamSchema.safeParse(raw);
          if (team.success) details.set(team.data.id, team.data);
        }
      } catch {
        n.issue(
          "organization-enrichment",
          "Organization enrichment failed; affiliation left unresolved",
        );
      }
    const orgByPlayer = new Map<number, string>();
    for (const [id, { person, position }] of persons) {
      if (!n.person(person, position)) continue;
      const current = person.currentTeam
        ? details.get(person.currentTeam.id)
        : undefined;
      const org =
        current?.sport?.id === 1
          ? current
          : current && current.sport?.id !== 17 && current.parentOrgId
            ? details.get(current.parentOrgId)
            : undefined;
      if (org?.sport?.id === 1 && (org.abbreviation ?? org.teamCode)) {
        n.add({
          kind: "organization",
          externalId: String(org.id),
          name: org.name,
          abbreviation: org.abbreviation ?? org.teamCode,
        });
        orgByPlayer.set(id, String(org.id));
      }
    }
    for (const { teamId, entry } of rosterRows)
      n.add({
        kind: "rosterObservation",
        key: `${p.options.season}:${teamId}:${entry.person.id}`,
        season: `afl-${p.options.season}`,
        player: String(entry.person.id),
        team: String(teamId),
        organization: orgByPlayer.get(entry.person.id) ?? null,
        ...((entry.status?.description ?? entry.status?.code)
          ? { rosterStatus: entry.status?.description ?? entry.status?.code }
          : {}),
      });
    return n.result();
  }
}
