/**
 * CLEARLY FICTIONAL MLB-Stats-API-shaped responses for the MiLB adapter.
 *
 * Every organization, team, league, player and statistic here is invented (IDs 9100–9999,
 * "Fixture"/"Synthetic" names). Only the sport IDs 11–14 / 1 and their level names mirror the
 * real API hierarchy, because the adapter verifies them. Used by tests and by the offline
 * `ingest:milb --source=fixture` dry run; it must never be applied to a real database.
 */

type Json = Record<string, unknown>;
const sport = (id: number, name: string) => ({ sports: [{ id, name }] });

export const FIXTURE_IDS = {
  orgs: { epc: 9101, sbc: 9102, notMlb: 9999 },
  leagues: { aaaEast: 9201, aaaWest: 9202, aa: 9211, highA: 9221, singleA: 9231 },
  teams: {
    aaa1: 9301,
    aaa2: 9302,
    aaa3: 9303,
    aa1: 9311,
    aa2: 9312,
    highA1: 9321,
    highA2: 9322,
    singleA1: 9331,
    singleA2: 9332,
  },
  players: {
    riser: 9501, // AA → AAA promotion
    aaaBat: 9502,
    aaaArm: 9503,
    aaa2Bat: 9504,
    aaa2Arm: 9505,
    aaa3Bat: 9506,
    aaa3Arm: 9507,
    aaBat: 9508,
    aaArm: 9509,
    aa2Bat: 9510,
    aa2Arm: 9511,
    hiBat: 9512,
    hiArm: 9513,
    hi2Bat: 9514,
    hi2Arm: 9515,
    loBat: 9516,
    loArm: 9517,
    lo2Bat: 9518,
    lo2Arm: 9519,
    callup: 9599, // appears only in a boxscore; needs people enrichment
  },
  games: {
    single: 9601,
    dh1: 9602,
    dh2: 9603,
    interleague: 9604,
    rescheduled: 9605,
    suspended: 9606,
    cancelled: 9607,
    scheduled: 9608,
    exhibition: 9609,
    conflicting: 9610,
    aaEarly: 9611,
    aaLate: 9612,
    highA: 9621,
    singleA: 9631,
  },
};
const T = FIXTURE_IDS.teams,
  P = FIXTURE_IDS.players,
  G = FIXTURE_IDS.games,
  L = FIXTURE_IDS.leagues,
  O = FIXTURE_IDS.orgs;

const team = (
  id: number,
  name: string,
  abbreviation: string,
  sportId: number,
  leagueId: number,
  parentOrgId?: number,
) => ({
  id,
  name,
  abbreviation,
  sport: { id: sportId },
  league: { id: leagueId, name: `League ${leagueId}` },
  ...(parentOrgId ? { parentOrgId } : {}),
  active: true,
});

const person = (
  id: number,
  fullName: string,
  position: string,
  extra: Json = {},
) => ({
  id,
  fullName,
  primaryPosition: { abbreviation: position },
  birthDate: "2003-04-05",
  batSide: { code: "R" },
  pitchHand: { code: "R" },
  ...extra,
});

const PEOPLE: Record<number, ReturnType<typeof person>> = {
  [P.riser]: person(P.riser, "Fixture Riser", "SS", { batSide: { code: "L" } }),
  [P.aaaBat]: person(P.aaaBat, "Synthetic Slugger", "1B"),
  [P.aaaArm]: person(P.aaaArm, "Synthetic Starter", "P"),
  [P.aaa2Bat]: person(P.aaa2Bat, "Example Catcher", "C"),
  [P.aaa2Arm]: person(P.aaa2Arm, "Example Reliever", "P", { pitchHand: { code: "L" } }),
  [P.aaa3Bat]: person(P.aaa3Bat, "Sample Centerfielder", "CF"),
  [P.aaa3Arm]: person(P.aaa3Arm, "Sample Closer", "P"),
  [P.aaBat]: person(P.aaBat, "Fixture Second Baseman", "2B"),
  [P.aaArm]: person(P.aaArm, "Fixture Lefty", "P", { pitchHand: { code: "L" } }),
  [P.aa2Bat]: person(P.aa2Bat, "Fixture Third Baseman", "3B"),
  [P.aa2Arm]: person(P.aa2Arm, "Fixture Righty", "P"),
  [P.hiBat]: person(P.hiBat, "Synthetic Leftfielder", "LF"),
  [P.hiArm]: person(P.hiArm, "Synthetic Swingman", "P"),
  [P.hi2Bat]: person(P.hi2Bat, "Example Rightfielder", "RF"),
  [P.hi2Arm]: person(P.hi2Arm, "Example Long Man", "P"),
  [P.loBat]: person(P.loBat, "Sample Shortstop", "SS"),
  [P.loArm]: person(P.loArm, "Sample Opener", "P"),
  [P.lo2Bat]: person(P.lo2Bat, "Sample Designated Hitter", "DH"),
  [P.lo2Arm]: person(P.lo2Arm, "Sample Setup Man", "P"),
  [P.callup]: person(P.callup, "Fixture Callup", "OF"),
};

const rosterRow = (id: number, status = "Active") => ({
  person: { ...PEOPLE[id] },
  position: { abbreviation: PEOPLE[id].primaryPosition.abbreviation },
  status: { code: status[0], description: status },
});

export function batting(
  pa: number,
  ab: number,
  h: number,
  { d = 0, hr = 0, bb = 0, k = 0 } = {},
) {
  return {
    plateAppearances: pa,
    atBats: ab,
    hits: h,
    doubles: d,
    triples: 0,
    homeRuns: hr,
    baseOnBalls: bb,
    strikeOuts: k,
    hitByPitch: 0,
    sacFlies: 0,
    stolenBases: 0,
    runs: hr,
    rbi: hr,
  };
}
export function pitching(
  ip: string,
  bf: number,
  { h = 0, er = 0, bb = 0, k = 0 } = {},
) {
  return {
    inningsPitched: ip,
    battersFaced: bf,
    hits: h,
    earnedRuns: er,
    baseOnBalls: bb,
    strikeOuts: k,
    homeRuns: 0,
    runs: er,
    numberOfPitches: 15 * bf,
  };
}

type Line = { id: number; batting?: Json; pitching?: Json; position?: string };
/** API-shaped boxscore including noise the adapter must drop (seasonStats, officials, info). */
export function boxscore(
  home: number,
  away: number,
  homeLines: Line[],
  awayLines: Line[],
) {
  const players = (lines: Line[]) =>
    Object.fromEntries(
      lines.map((l) => [
        `ID${l.id}`,
        {
          person: { id: l.id, fullName: PEOPLE[l.id].fullName, link: `/api/v1/people/${l.id}` },
          position: { abbreviation: l.position ?? PEOPLE[l.id].primaryPosition.abbreviation },
          stats: {
            batting: l.batting ?? {},
            pitching: l.pitching ?? {},
            fielding: { assists: 1 },
          },
          seasonStats: { batting: { avg: ".300", note: "x".repeat(200) } },
        },
      ]),
    );
  return {
    copyright: "fixture",
    teams: {
      home: { team: { id: home, name: "home" }, players: players(homeLines), teamStats: {} },
      away: { team: { id: away, name: "away" }, players: players(awayLines), teamStats: {} },
    },
    officials: [{ official: { fullName: "Fixture Umpire" } }],
    info: [{ label: "Weather", value: "Synthetic" }],
  };
}

const final = { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" };
const scheduled = { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" };
function game(
  gamePk: number,
  date: string,
  home: number,
  away: number,
  status: Json = final,
  extra: Json = {},
) {
  const done = status === final;
  return {
    gamePk,
    gameType: "R",
    season: "2026",
    gameDate: `${date}T23:05:00Z`,
    officialDate: date,
    status,
    teams: {
      home: { team: { id: home, name: `Team ${home}` }, ...(done ? { score: 5 } : {}) },
      away: { team: { id: away, name: `Team ${away}` }, ...(done ? { score: 3 } : {}) },
    },
    venue: { name: `Fixture Park ${home}` },
    ...extra,
  };
}

export interface MilbFixture {
  sports: Record<number, unknown>;
  leagues: Record<number, Json[]>;
  teams: Record<number, Json[]>;
  rosters: Record<number, Json[]>;
  people: Record<number, Json>;
  /** Schedule rows per sport: [date, game]. */
  schedule: Record<number, [string, Json][]>;
  boxes: Record<number, Json>;
}

export function buildMilbFixture(): MilbFixture {
  const leagues = {
    11: [
      { id: L.aaaEast, name: "Synthetic International League", sport: { id: 11 } },
      { id: L.aaaWest, name: "Synthetic Pacific League", sport: { id: 11 } },
    ],
    12: [{ id: L.aa, name: "Synthetic Eastern League", sport: { id: 12 } }],
    13: [{ id: L.highA, name: "Synthetic Midwest League", sport: { id: 13 } }],
    14: [{ id: L.singleA, name: "Synthetic Carolina League", sport: { id: 14 } }],
  };
  const teams = {
    1: [
      { id: O.epc, name: "Example Parent Club", abbreviation: "EPC", sport: { id: 1 }, league: { id: 103 } },
      { id: O.sbc, name: "Sample Big League Club", abbreviation: "SBC", sport: { id: 1 }, league: { id: 104 } },
    ],
    11: [
      team(T.aaa1, "Fixture Triple-A Comets", "FTC", 11, L.aaaEast, O.epc),
      team(T.aaa2, "Fixture Triple-A Rivets", "FTR", 11, L.aaaEast, O.sbc),
      team(T.aaa3, "Fixture Triple-A Canyons", "FTK", 11, L.aaaWest, O.epc),
    ],
    12: [
      team(T.aa1, "Fixture Double-A Pines", "FDP", 12, L.aa, O.epc),
      team(T.aa2, "Fixture Double-A Ferries", "FDF", 12, L.aa, O.sbc),
    ],
    13: [
      team(T.highA1, "Fixture High-A Owls", "FHO", 13, L.highA, O.epc),
      team(T.highA2, "Fixture High-A Unaffiliated", "FHU", 13, L.highA),
    ],
    14: [
      team(T.singleA1, "Fixture Single-A Crabs", "FSC", 14, L.singleA, O.epc),
      team(T.singleA2, "Fixture Single-A Mystery", "FSM", 14, L.singleA, O.notMlb),
    ],
  };
  const rosters = {
    [T.aaa1]: [rosterRow(P.riser), rosterRow(P.aaaBat), rosterRow(P.aaaArm)],
    [T.aaa2]: [rosterRow(P.aaa2Bat), rosterRow(P.aaa2Arm)],
    [T.aaa3]: [rosterRow(P.aaa3Bat), rosterRow(P.aaa3Arm)],
    [T.aa1]: [rosterRow(P.riser, "Promoted"), rosterRow(P.aaBat), rosterRow(P.aaArm)],
    [T.aa2]: [rosterRow(P.aa2Bat), rosterRow(P.aa2Arm)],
    [T.highA1]: [rosterRow(P.hiBat), rosterRow(P.hiArm)],
    [T.highA2]: [rosterRow(P.hi2Bat), rosterRow(P.hi2Arm)],
    [T.singleA1]: [rosterRow(P.loBat), rosterRow(P.loArm)],
    [T.singleA2]: [rosterRow(P.lo2Bat), rosterRow(P.lo2Arm)],
  };
  const b = batting,
    p = pitching;
  const aaa12 = (homeIsAaa1: boolean, riser = true) => {
    const one: Line[] = [
      ...(riser ? [{ id: P.riser, batting: b(4, 4, 2, { hr: 1, k: 1 }) }] : []),
      { id: P.aaaBat, batting: b(4, 3, 1, { bb: 1 }) },
      { id: P.aaaArm, pitching: p("6.0", 24, { h: 5, er: 2, bb: 1, k: 7 }) },
    ];
    const two: Line[] = [
      { id: P.aaa2Bat, batting: b(4, 4, 1, { k: 2 }) },
      { id: P.aaa2Arm, pitching: p("5.1", 23, { h: 6, er: 3, bb: 2, k: 4 }) },
    ];
    return homeIsAaa1 ? boxscore(T.aaa1, T.aaa2, one, two) : boxscore(T.aaa2, T.aaa1, two, one);
  };
  const schedule: MilbFixture["schedule"] = {
    11: [
      ["2026-05-01", game(G.single, "2026-05-01", T.aaa1, T.aaa2)],
      ["2026-05-02", game(G.dh1, "2026-05-02", T.aaa2, T.aaa1, final, { doubleHeader: "S", gameNumber: 1 })],
      ["2026-05-02", game(G.dh2, "2026-05-02", T.aaa2, T.aaa1, final, { doubleHeader: "S", gameNumber: 2, gameDate: "2026-05-03T02:10:00Z" })],
      ["2026-05-03", game(G.interleague, "2026-05-03", T.aaa3, T.aaa1)],
      // Postponed on 05-04, played 05-05 (reciprocal linkage, same gamePk).
      ["2026-05-04", game(G.rescheduled, "2026-05-04", T.aaa1, T.aaa2,
        { abstractGameState: "Final", detailedState: "Postponed", codedGameState: "D" },
        { gameDate: "2026-05-04T23:05:00Z", officialDate: "2026-05-04", rescheduleDate: "2026-05-05T23:05:00Z", rescheduleGameDate: "2026-05-05", teams: { home: { team: { id: T.aaa1 } }, away: { team: { id: T.aaa2 } } } })],
      ["2026-05-05", game(G.rescheduled, "2026-05-05", T.aaa1, T.aaa2, final,
        { rescheduledFrom: "2026-05-04T23:05:00Z", rescheduledFromDate: "2026-05-04" })],
      // Suspended on 05-06, resumed and completed 05-07.
      ["2026-05-06", game(G.suspended, "2026-05-06", T.aaa2, T.aaa1,
        { abstractGameState: "Live", detailedState: "Suspended: Rain", codedGameState: "U" },
        { resumeDate: "2026-05-07T18:05:00Z", resumeGameDate: "2026-05-07", teams: { home: { team: { id: T.aaa2 } }, away: { team: { id: T.aaa1 } } } })],
      ["2026-05-07", game(G.suspended, "2026-05-07", T.aaa2, T.aaa1, final,
        { gameDate: "2026-05-07T18:05:00Z", resumedFrom: "2026-05-06T23:05:00Z", resumedFromDate: "2026-05-06" })],
      ["2026-05-08", game(G.cancelled, "2026-05-08", T.aaa1, T.aaa3,
        { abstractGameState: "Final", detailedState: "Cancelled", codedGameState: "C" })],
      ["2026-05-20", game(G.scheduled, "2026-05-20", T.aaa3, T.aaa2, scheduled)],
      ["2026-05-09", game(G.exhibition, "2026-05-09", T.aaa1, T.aaa2, final, { gameType: "E" })],
      // Two irreconcilable final representations of one gamePk → quarantine.
      ["2026-05-10", game(G.conflicting, "2026-05-10", T.aaa3, T.aaa2)],
      ["2026-05-11", { ...game(G.conflicting, "2026-05-11", T.aaa3, T.aaa2), teams: { home: { team: { id: T.aaa3 } , score: 9 }, away: { team: { id: T.aaa2 }, score: 0 } } }],
    ],
    12: [
      ["2026-04-20", game(G.aaEarly, "2026-04-20", T.aa1, T.aa2)],
      ["2026-05-12", game(G.aaLate, "2026-05-12", T.aa2, T.aa1)],
    ],
    13: [["2026-05-01", game(G.highA, "2026-05-01", T.highA1, T.highA2)]],
    14: [["2026-05-01", game(G.singleA, "2026-05-01", T.singleA1, T.singleA2)]],
  };
  const boxes: MilbFixture["boxes"] = {
    [G.single]: (() => {
      const box = aaa12(true, false);
      // A player seen only in this boxscore (no roster row), batting as a pinch hitter.
      (box.teams.home.players as Json)[`ID${P.callup}`] = {
        person: { id: P.callup, fullName: "Fixture Callup" },
        position: { abbreviation: "PH" },
        stats: { batting: b(1, 1, 1), pitching: {} },
      };
      return box;
    })(),
    [G.dh1]: aaa12(false, false),
    [G.dh2]: aaa12(false, false),
    [G.interleague]: boxscore(
      T.aaa3,
      T.aaa1,
      [
        { id: P.aaa3Bat, batting: b(4, 4, 1) },
        { id: P.aaa3Arm, pitching: p("9.0", 34, { h: 7, er: 2, bb: 2, k: 9 }) },
      ],
      [
        { id: P.aaaBat, batting: b(4, 4, 0, { k: 2 }) },
        { id: P.aaaArm, pitching: p("8.0", 33, { h: 9, er: 5, bb: 1, k: 5 }) },
      ],
    ),
    [G.rescheduled]: aaa12(true),
    [G.suspended]: aaa12(false),
    [G.aaEarly]: boxscore(
      T.aa1,
      T.aa2,
      [
        { id: P.riser, batting: b(5, 4, 3, { d: 1, hr: 1, bb: 1 }) },
        { id: P.aaBat, batting: b(4, 4, 1, { k: 1 }) },
        { id: P.aaArm, pitching: p("7.0", 27, { h: 4, er: 1, bb: 1, k: 8 }) },
      ],
      [
        { id: P.aa2Bat, batting: b(4, 4, 1, { k: 1 }) },
        { id: P.aa2Arm, pitching: p("6.0", 28, { h: 8, er: 4, bb: 3, k: 3 }) },
      ],
    ),
    [G.aaLate]: boxscore(
      T.aa2,
      T.aa1,
      [
        { id: P.aa2Bat, batting: b(4, 3, 2, { bb: 1 }) },
        { id: P.aa2Arm, pitching: p("6.2", 26, { h: 5, er: 2, bb: 2, k: 6 }) },
      ],
      [
        { id: P.aaBat, batting: b(4, 4, 1) },
        { id: P.aaArm, pitching: p("6.0", 25, { h: 6, er: 3, bb: 2, k: 5 }) },
      ],
    ),
    [G.highA]: boxscore(
      T.highA1,
      T.highA2,
      [
        { id: P.hiBat, batting: b(4, 4, 2, { d: 1 }) },
        { id: P.hiArm, pitching: p("5.0", 21, { h: 4, er: 2, bb: 2, k: 6 }) },
      ],
      [
        { id: P.hi2Bat, batting: b(4, 4, 1, { k: 1 }) },
        { id: P.hi2Arm, pitching: p("6.0", 25, { h: 6, er: 3, bb: 1, k: 5 }) },
      ],
    ),
    [G.singleA]: boxscore(
      T.singleA1,
      T.singleA2,
      [
        { id: P.loBat, batting: b(4, 3, 1, { bb: 1 }) },
        { id: P.loArm, pitching: p("4.0", 18, { h: 4, er: 3, bb: 3, k: 4 }) },
      ],
      [
        { id: P.lo2Bat, batting: b(4, 4, 2, { hr: 1 }) },
        { id: P.lo2Arm, pitching: p("5.0", 20, { h: 3, er: 1, bb: 1, k: 6 }) },
      ],
    ),
    [G.conflicting]: boxscore(T.aaa3, T.aaa2, [], []),
  };
  return {
    sports: {
      1: sport(1, "Major League Baseball"),
      11: sport(11, "Triple-A"),
      12: sport(12, "Double-A"),
      13: sport(13, "High-A"),
      14: sport(14, "Single-A"),
    },
    leagues,
    teams,
    rosters,
    people: PEOPLE as Record<number, Json>,
    schedule,
    boxes,
  };
}

/**
 * Mock fetch serving the fixture like the Stats API (date/team/league filters on schedule).
 * Counts requests per path for request-volume assertions.
 */
export function milbFixtureFetch(data: MilbFixture = buildMilbFixture()) {
  const urls: string[] = [];
  let active = 0,
    maxActive = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.href);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const path = url.pathname.replace(/^\/api\/v1\//, "");
      const q = url.searchParams;
      const sportId = Number(q.get("sportId"));
      let m: RegExpMatchArray | null;
      if ((m = path.match(/^sports\/(\d+)$/))) {
        const body = data.sports[Number(m[1])];
        return body ? json(body) : json({ message: "not found" }, 404);
      }
      if (path === "league") return json({ leagues: data.leagues[sportId] ?? [] });
      if (path === "teams") return json({ teams: data.teams[sportId] ?? [] });
      if ((m = path.match(/^teams\/(\d+)\/roster$/)))
        return json({ roster: data.rosters[Number(m[1])] ?? [] });
      if (path === "people") {
        const ids = (q.get("personIds") ?? "").split(",").map(Number);
        return json({ people: ids.flatMap((id) => (data.people[id] ? [data.people[id]] : [])) });
      }
      if (path === "schedule") {
        const from = q.get("startDate") ?? "0000",
          to = q.get("endDate") ?? "9999";
        const teamId = q.get("teamId") ? Number(q.get("teamId")) : undefined;
        const leagueId = q.get("leagueId") ? Number(q.get("leagueId")) : undefined;
        const leagueTeams = new Set(
          (data.teams[sportId] ?? [])
            .filter((t) => (t.league as { id: number }).id === leagueId)
            .map((t) => t.id as number),
        );
        const dates = new Map<string, Json[]>();
        for (const [date, g] of data.schedule[sportId] ?? []) {
          if (date < from || date > to) continue;
          const sides = g.teams as { home: { team: { id: number } }; away: { team: { id: number } } };
          const ids = [sides.home.team.id, sides.away.team.id];
          if (teamId && !ids.includes(teamId)) continue;
          if (leagueId && !ids.some((id) => leagueTeams.has(id))) continue;
          dates.set(date, [...(dates.get(date) ?? []), g]);
        }
        return json({
          dates: [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([date, games]) => ({ date, games })),
        });
      }
      if ((m = path.match(/^game\/(\d+)\/boxscore$/))) {
        const body = data.boxes[Number(m[1])];
        return body ? json(body) : json({ message: "not found" }, 404);
      }
      return json({ message: `unexpected ${path}` }, 404);
    } finally {
      active--;
    }
  };
  return {
    fetcher,
    urls,
    count: (pattern: RegExp) => urls.filter((u) => pattern.test(new URL(u).pathname)).length,
    get maxActive() {
      return maxActive;
    },
  };
}
