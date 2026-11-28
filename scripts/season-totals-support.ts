/**
 * Clearly fictional MLB Stats API responses for the season-totals adapter (T-503): sports, season stats and people.
 * Not real players. Used by unit tests and the database integration test.
 */
export interface FakeTotals {
  sportNames?: Record<number, string>;
  /** Rows per sportId and group. */
  hitting?: Record<number, Record<string, unknown>[]>;
  pitching?: Record<number, Record<string, unknown>[]>;
  people?: Record<number, Record<string, unknown>>;
  /** Report this many more splits than returned (a truncated page). */
  truncate?: number;
}

export const hitter = (id: number, over: Record<string, number> = {}) => ({
  player: { id },
  numTeams: 1,
  stat: {
    gamesPlayed: 100, plateAppearances: 400, atBats: 350, hits: 90, doubles: 20, triples: 2, homeRuns: 10,
    baseOnBalls: 40, strikeOuts: 90, hitByPitch: 5, sacFlies: 5, stolenBases: 12, caughtStealing: 4, runs: 50, rbi: 45,
    ...over,
  },
});

export const pitcher = (id: number, over: Record<string, number | string> = {}) => ({
  player: { id },
  numTeams: 1,
  stat: {
    gamesPitched: 25, outs: 360, inningsPitched: "120.0", battersFaced: 500, hits: 110, earnedRuns: 50, baseOnBalls: 40,
    strikeOuts: 120, homeRuns: 12, runs: 55, hitBatsmen: 6, numberOfPitches: 1900,
    ...over,
  },
});

export const person = (id: number, position = "SS") => ({
  id,
  fullName: `Fictional Player ${id}`,
  primaryPosition: { abbreviation: position },
  birthDate: "1995-06-01",
  batSide: { code: "R" },
  pitchHand: { code: "R" },
});

const DEFAULT_NAMES: Record<number, string> = { 1: "Major League Baseball", 11: "Triple-A", 12: "Double-A", 13: "Class A Advanced", 14: "Class A" };

export function fakeTotalsFetch(f: FakeTotals): typeof fetch {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const sport = /^sports\/(\d+)$/.exec(path);
    if (sport) {
      const id = Number(sport[1]);
      return json({ sports: [{ id, name: (f.sportNames ?? DEFAULT_NAMES)[id] ?? DEFAULT_NAMES[id] }] });
    }
    if (path === "stats") {
      const sportId = Number(url.searchParams.get("sportId"));
      const group = url.searchParams.get("group") === "hitting" ? f.hitting : f.pitching;
      const season = url.searchParams.get("season");
      const splits = (group?.[sportId] ?? []).map((s) => ({ season, sport: { id: sportId }, ...s }));
      return json({ stats: [{ totalSplits: splits.length + (f.truncate ?? 0), splits }] });
    }
    if (path === "people") {
      const ids = (url.searchParams.get("personIds") ?? "").split(",").map(Number);
      return json({ people: ids.map((id) => f.people?.[id] ?? person(id)) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
