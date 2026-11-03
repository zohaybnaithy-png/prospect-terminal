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
  // Suspended games resumed on a later date keep their gamePk (MiLB).
  resumeDate: z.iso.datetime({ offset: true }).optional(),
  resumeGameDate: z.iso.date().optional(),
  resumedFrom: z.iso.datetime({ offset: true }).optional(),
  resumedFromDate: z.iso.date().optional(),
  doubleHeader: z.string().optional(),
  gameNumber: z.number().int().positive().optional(),
});
export type ScheduleGame = z.infer<typeof scheduleGame>;
export interface ScheduleRow {
  game: ScheduleGame;
  date: string;
}
type Row = ScheduleRow;
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
/**
 * Parses a schedule envelope into per-gamePk groups. Malformed rows block their gamePk (it is
 * never partially selected) and are reported.
 */
export function parseScheduleGroups(body: unknown) {
  const issues: IngestionIssue[] = [];
  const groups = new Map<number, Row[]>();
  const blocked = new Set<number>();
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
    return { groups, blocked, issues, valid: false };
  }
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
      const list = groups.get(g.gamePk);
      if (list) list.push({ game: g, date: d.date });
      else groups.set(g.gamePk, [{ game: g, date: d.date }]);
    }
  return { groups, blocked, issues, valid: true };
}

/**
 * AFL policy: chooses the single current representation of one gamePk. Identical
 * representations collapse; differing ones are accepted only when every superseded row is a
 * postponed row with reciprocal reschedule linkage DIRECTLY to one unique current row. Anything
 * else throws so the caller quarantines the game. Never last-row-wins. (Unchanged AFL behavior;
 * MiLB uses reconcileLinkedChain below.)
 */
export function reconcileScheduleGroup(
  rows: Row[],
  identity: (row: Row) => unknown,
): { chosen: Row; reconciled: "reschedule" | null } {
  assertConsistentContext(rows);
  const key = (r: Row) => fingerprint(identity(r));
  if (new Set(rows.map(key)).size <= 1) return { chosen: rows[0], reconciled: null };
  const active = rows.filter((r) => gameStatus(r.game.status) !== "postponed");
  if (!active.length || new Set(active.map(key)).size !== 1)
    throw new Error(
      "Conflicting schedule representations without a unique current game",
    );
  const chosen = active[0];
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
  return { chosen, reconciled: "reschedule" };
}

function assertConsistentContext(rows: Row[]) {
  for (const field of ["gameType", "season", "leagueId", "sportId"] as const) {
    const values = new Set(
      rows
        .map((r) => r.game[field])
        .filter((v) => v !== undefined)
        .map(String),
    );
    if (values.size > 1) throw new Error(`Conflicting schedule ${field} context`);
  }
}

const instant = (value: string | undefined) =>
  value === undefined ? Number.NaN : Date.parse(value);
const sameMatchup = (a: ScheduleGame, b: ScheduleGame) =>
  a.teams.home.team.id === b.teams.home.team.id &&
  a.teams.away.team.id === b.teams.away.team.id;

/**
 * Reschedule edge from → to: `from` is postponed and BOTH rows point at each other —
 * from.rescheduleDate is to's start, to.rescheduledFrom is from's start, to.rescheduledFromDate
 * is from's schedule date, and from.rescheduleGameDate (when present) names to's schedule date
 * or official date. Intermediate postponed rows of a chain are valid targets (live MiLB data:
 * Postponed → Postponed → Final, where the first row's officialDate is already the final date).
 */
export function rescheduleEdge(from: Row, to: Row): boolean {
  const a = from.game,
    b = to.game;
  return (
    gameStatus(a.status) === "postponed" &&
    sameMatchup(a, b) &&
    a.rescheduleDate !== undefined &&
    b.rescheduledFrom !== undefined &&
    instant(a.rescheduleDate) === instant(b.gameDate) &&
    instant(b.rescheduledFrom) === instant(a.gameDate) &&
    b.rescheduledFromDate === from.date &&
    (a.rescheduleGameDate === undefined ||
      a.rescheduleGameDate === to.date ||
      a.rescheduleGameDate === b.officialDate)
  );
}

/**
 * Resumption edge from → to: a started game (not postponed/cancelled) continued on a later
 * date under the same gamePk. Reciprocal: from.resumeDate is to's start, to.resumedFrom is
 * from's start, to.resumedFromDate is from's schedule date, from.resumeGameDate (when present)
 * is to's schedule date, and both rows carry the SAME official date (a resumed game keeps the
 * date it began). Live MiLB shape: the origin row already reads Final once the game is done.
 */
export function resumeEdge(from: Row, to: Row): boolean {
  const a = from.game,
    b = to.game;
  const sa = gameStatus(a.status),
    sb = gameStatus(b.status);
  return (
    sa !== "postponed" &&
    sa !== "cancelled" &&
    sb !== "postponed" &&
    sb !== "cancelled" &&
    sameMatchup(a, b) &&
    a.resumeDate !== undefined &&
    b.resumedFrom !== undefined &&
    instant(a.resumeDate) === instant(b.gameDate) &&
    instant(b.resumedFrom) === instant(a.gameDate) &&
    b.resumedFromDate === from.date &&
    (a.resumeGameDate === undefined || a.resumeGameDate === to.date) &&
    (a.officialDate ?? from.date) === (b.officialDate ?? from.date)
  );
}

export type ReconciliationKind = "reschedule" | "resumption";

/**
 * MiLB policy: reconciles every representation of one gamePk through explicit reciprocal links.
 *
 * Rows must form exactly ONE chain covering all of them (after collapsing identical rows):
 *   Postponed* → (played | cancelled) → resumed*      or      Postponed+ (never played)
 * where every arrow is a reschedule or resumption edge. Each row has at most one successor and
 * one predecessor; branches, cycles, unlinked rows, or resumed rows disagreeing on the result
 * throw (the caller quarantines the game). The current game is the first non-postponed row
 * (start time, venue, official date of the game as it began) with the outcome (status, scores)
 * of the chain's last row; if nothing was played, the last postponed row.
 */
export function reconcileLinkedChain(
  rows: Row[],
  identity: (row: Row) => unknown,
): { chosen: Row; reconciled: ReconciliationKind[] | null } {
  assertConsistentContext(rows);
  // Exact duplicate listings (same date bucket, same row) carry no extra information.
  const unique = [...new Map(rows.map((r) => [fingerprint(r), r])).values()];
  const key = (r: Row) => fingerprint(identity(r));
  if (new Set(unique.map(key)).size <= 1) return { chosen: unique[0], reconciled: null };

  const next = new Map<Row, { to: Row; kind: ReconciliationKind }>();
  const predecessors = new Map<Row, number>();
  for (const from of unique) {
    const targets: { to: Row; kind: ReconciliationKind }[] = [];
    for (const to of unique) {
      if (to === from) continue;
      if (rescheduleEdge(from, to)) targets.push({ to, kind: "reschedule" });
      else if (resumeEdge(from, to)) targets.push({ to, kind: "resumption" });
    }
    if (targets.length > 1)
      throw new Error("Ambiguous schedule linkage: a representation links to several others");
    if (targets.length) {
      next.set(from, targets[0]);
      predecessors.set(targets[0].to, (predecessors.get(targets[0].to) ?? 0) + 1);
    }
  }
  const starts = unique.filter((r) => !predecessors.get(r));
  if (
    starts.length !== 1 ||
    [...predecessors.values()].some((n) => n > 1)
  )
    throw new Error(
      "Conflicting schedule representations without a single reciprocal linkage chain",
    );
  const chain: Row[] = [];
  const kinds = new Set<ReconciliationKind>();
  for (let r: Row | undefined = starts[0]; r; r = next.get(r)?.to) {
    if (chain.includes(r)) throw new Error("Cyclic schedule linkage");
    const edge = next.get(r);
    if (edge) kinds.add(edge.kind);
    chain.push(r);
  }
  if (chain.length !== unique.length)
    throw new Error(
      "Conflicting schedule representations without a single reciprocal linkage chain",
    );

  const firstPlayed = chain.findIndex((r) => gameStatus(r.game.status) !== "postponed");
  if (firstPlayed === -1)
    return { chosen: chain[chain.length - 1], reconciled: [...kinds].sort() };
  const origin = chain[firstPlayed];
  const terminal = chain[chain.length - 1];
  if (origin === terminal) return { chosen: origin, reconciled: [...kinds].sort() };
  // Every resumed representation that reports a final result must report the same one.
  const final = gameStatus(terminal.game.status) === "final";
  for (const r of chain.slice(firstPlayed))
    if (
      gameStatus(r.game.status) === "final" &&
      final &&
      (r.game.teams.home.score !== terminal.game.teams.home.score ||
        r.game.teams.away.score !== terminal.game.teams.away.score)
    )
      throw new Error("Resumed game representations disagree on the final score");
  const outcome = final ? terminal.game : origin.game;
  return {
    chosen: {
      date: origin.date,
      game: {
        ...origin.game,
        status: outcome.status,
        teams: {
          home: { ...origin.game.teams.home, score: outcome.teams.home.score },
          away: { ...origin.game.teams.away, score: outcome.teams.away.score },
        },
      },
    },
    reconciled: [...kinds].sort(),
  };
}

/** One shared selection for boxscore fetching and normalization. No last-row-wins policy. */
export function selectAflSchedule(
  body: unknown,
  teamIds: Set<number>,
  options: MlbOptions,
) {
  const notices: IngestionNotice[] = [];
  const games = new Map<number, Row>();
  const parsed = parseScheduleGroups(body);
  const issues = parsed.issues;
  const issue = (key: string, message: string) =>
    issues.push({ recordKey: key, code: "invalid-record", message });
  if (!parsed.valid) return { games, issues, notices };
  for (const [id, rows] of parsed.groups) {
    if (parsed.blocked.has(id)) continue;
    try {
      const { chosen, reconciled } = reconcileScheduleGroup(rows, (r) =>
        normalizedGame(r.game, r.date, options.season),
      );
      if (reconciled)
        notices.push({
          recordKey: `game:${id}`,
          reason: "reconciled-reschedule",
          message: "Linked postponed representation reconciled to current game",
        });
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
