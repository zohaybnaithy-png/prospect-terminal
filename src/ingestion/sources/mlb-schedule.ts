import { z } from "zod";
import { fingerprint } from "../plan";
import type { IngestionIssue, IngestionNotice } from "../contracts";
import { AFL } from "./mlb-config";
import type { MlbOptions } from "./mlb-config";
import { apiId, gameStatus } from "./mlb-normalize";

const participant = z.object({
  team: z.object({ id: apiId, name: z.string().optional() }),
  score: z.number().int().nonnegative().optional(),
});
const scheduleGame = z.object({
  gamePk: apiId,
  gameType: z.string().optional(),
  gameDate: z.iso.datetime({ offset: true }),
  officialDate: z.iso.date().optional(),
  season: z.union([z.string(), z.number()]).optional(),
  leagueId: apiId.optional(),
  sportId: apiId.optional(),
  status: z.object({
    abstractGameState: z.string().optional(),
    detailedState: z.string().optional(),
    codedGameState: z.string().optional(),
  }),
  teams: z.object({ home: participant, away: participant }),
  venue: z.object({ name: z.string() }).optional(),
  rescheduleDate: z.iso.datetime({ offset: true }).optional(),
  rescheduleGameDate: z.iso.date().optional(),
  rescheduledFrom: z.iso.datetime({ offset: true }).optional(),
  rescheduledFromDate: z.iso.date().optional(),
});
export type ScheduleGame = z.infer<typeof scheduleGame>;
interface Row {
  game: ScheduleGame;
  date: string;
}
export function normalizedGame(g: ScheduleGame, date: string, season: number) {
  return {
    kind: "game" as const,
    externalId: String(g.gamePk),
    season: `afl-${season}`,
    league: "119",
    officialDate: g.officialDate ?? date,
    homeTeam: String(g.teams.home.team.id),
    awayTeam: String(g.teams.away.team.id),
    startsAt: new Date(g.gameDate).toISOString(),
    status: gameStatus(g.status),
    ...(g.teams.home.score !== undefined
      ? { homeScore: g.teams.home.score }
      : {}),
    ...(g.teams.away.score !== undefined
      ? { awayScore: g.teams.away.score }
      : {}),
    ...(g.venue ? { venue: g.venue.name } : {}),
  };
}
function linkedPostponement(old: Row, current: Row): boolean {
  const a = old.game,
    b = current.game;
  return (
    gameStatus(a.status) === "postponed" &&
    gameStatus(b.status) !== "postponed" &&
    a.gameType === b.gameType &&
    a.season === b.season &&
    a.leagueId === b.leagueId &&
    a.sportId === b.sportId &&
    a.teams.home.team.id === b.teams.home.team.id &&
    a.teams.away.team.id === b.teams.away.team.id &&
    a.rescheduleDate !== undefined &&
    b.rescheduledFrom !== undefined &&
    Date.parse(a.rescheduleDate) === Date.parse(b.gameDate) &&
    Date.parse(b.rescheduledFrom) === Date.parse(a.gameDate) &&
    a.rescheduleGameDate === (b.officialDate ?? current.date) &&
    b.rescheduledFromDate === old.date
  );
}
/** One shared selection for boxscore fetching and normalization. No last-row-wins policy. */
export function selectAflSchedule(
  body: unknown,
  teamIds: Set<number>,
  options: MlbOptions,
) {
  const issues: IngestionIssue[] = [],
    notices: IngestionNotice[] = [];
  const games = new Map<number, Row>();
  const groups = new Map<number, Row[]>();
  const issue = (key: string, message: string) =>
    issues.push({ recordKey: key, code: "invalid-record", message });
  const envelope = z
    .object({
      dates: z
        .array(z.object({ date: z.iso.date(), games: z.array(z.unknown()) }))
        .max(400),
    })
    .safeParse(body);
  if (!envelope.success) {
    issue("schedule", "Malformed schedule envelope");
    return { games, issues, notices };
  }
  const blocked = new Set<number>();
  for (const d of envelope.data.dates)
    for (const raw of d.games) {
      const parsed = scheduleGame.safeParse(raw);
      if (!parsed.success) {
        const id = z.object({ gamePk: apiId }).safeParse(raw);
        if (id.success) blocked.add(id.data.gamePk);
        issue(
          id.success ? `game:${id.data.gamePk}` : "schedule",
          "Malformed game record",
        );
        continue;
      }
      const g = parsed.data;
      groups.set(g.gamePk, [
        ...(groups.get(g.gamePk) ?? []),
        { game: g, date: d.date },
      ]);
    }
  for (const [id, rows] of groups) {
    if (blocked.has(id)) continue;
    try {
      for (const field of [
        "gameType",
        "season",
        "leagueId",
        "sportId",
      ] as const) {
        const values = new Set(
          rows
            .map((r) => r.game[field])
            .filter((v) => v !== undefined)
            .map(String),
        );
        if (values.size > 1)
          throw new Error(`Conflicting schedule ${field} context`);
      }
      // Collapse equivalent normalized representations; retain their linkage evidence.
      const active = rows.filter(
        (r) => gameStatus(r.game.status) !== "postponed",
      );
      let chosen = rows[0];
      if (
        new Set(
          rows.map((r) =>
            fingerprint(normalizedGame(r.game, r.date, options.season)),
          ),
        ).size > 1
      ) {
        if (
          !active.length ||
          new Set(
            active.map((r) =>
              fingerprint(normalizedGame(r.game, r.date, options.season)),
            ),
          ).size !== 1
        )
          throw new Error(
            "Conflicting schedule representations without a unique current game",
          );
        chosen = active[0];
        if (
          rows.some(
            (r) =>
              gameStatus(r.game.status) === "postponed" &&
              !active.some((a) => linkedPostponement(r, a)),
          )
        )
          throw new Error(
            "Conflicting schedule representations lack reciprocal reschedule linkage",
          );
        notices.push({
          recordKey: `game:${id}`,
          reason: "reconciled-reschedule",
          message: "Linked postponed representation reconciled to current game",
        });
      }
      const g = chosen.game,
        date = g.officialDate ?? chosen.date;
      const members = [g.teams.home.team.id, g.teams.away.team.id].map((t) =>
        teamIds.has(t),
      );
      const wrongLeague = rows.some(
        (r) =>
          r.game.leagueId !== undefined && r.game.leagueId !== AFL.leagueId,
      );
      const wrongSport = rows.some(
        (r) => r.game.sportId !== undefined && r.game.sportId !== AFL.sportId,
      );
      // Only positive, mutually consistent foreign context is silently outside selection.
      if (wrongLeague && wrongSport && members.every((m) => !m)) {
        notices.push({
          recordKey: `game:${id}`,
          reason: "outside-scope",
          message:
            "Explicit foreign league and sport; neither participant is an AFL club",
        });
        continue;
      }
      if (wrongLeague || wrongSport)
        throw new Error("Contradictory AFL league/sport context");
      if (
        rows.some(
          (r) =>
            r.game.season !== undefined &&
            String(r.game.season) !== String(options.season),
        ) ||
        Number(date.slice(0, 4)) !== options.season
      )
        throw new Error("Game season/date outside selected AFL season");
      if (
        (options.from && date < options.from) ||
        (options.to && date > options.to) ||
        (options.team &&
          ![g.teams.home.team.id, g.teams.away.team.id].includes(options.team))
      )
        continue;
      // Recorded AFL Fall Stars uses special exhibition teams, never club-team identities.
      if (
        g.gameType === "A" &&
        [g.teams.home.team.id, g.teams.away.team.id]
          .sort((a, b) => a - b)
          .join(",") === "1310,1311"
      ) {
        notices.push({
          recordKey: `game:${id}`,
          reason: "excluded-exhibition",
          message:
            "AFL Fall Stars exhibition excluded from six-club game statistics",
        });
        continue;
      }
      const sides = [g.teams.home, g.teams.away];
      const placeholder = sides.some(
        (s) => s.team.id === 55 && s.team.name === "To Be Determined",
      );
      if (
        placeholder &&
        ["D", "L", "W"].includes(g.gameType ?? "") &&
        gameStatus(g.status) === "scheduled" &&
        sides.every(
          (s) =>
            teamIds.has(s.team.id) ||
            (s.team.id === 55 && s.team.name === "To Be Determined"),
        )
      ) {
        notices.push({
          recordKey: `game:${id}`,
          reason: "deferred-participants",
          message:
            "AFL postseason game deferred until actual club opponents are assigned",
        });
        continue;
      }
      if (!members.every(Boolean))
        throw new Error("Unrecognized participants in AFL schedule");
      if (g.teams.home.team.id === g.teams.away.team.id)
        throw new Error("AFL game opponents must differ");
      games.set(id, chosen);
    } catch (error) {
      issue(
        `game:${id}`,
        error instanceof Error ? error.message : "Invalid AFL game",
      );
    }
  }
  return { games, issues, notices };
}
