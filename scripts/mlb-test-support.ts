import fixture from "../src/ingestion/fixtures/mlb/afl-2026.synthetic.json";
export const syntheticMlb = () => structuredClone(fixture);
export function mockMlbFetch(data = syntheticMlb()) {
  const urls: string[] = [];
  let active = 0,
    maxActive = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.href);
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    let body: unknown;
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    if (path === "league/119") body = data.league;
    else if (path === "teams" && url.searchParams.has("leagueIds"))
      body = data.teams;
    else if (path === "teams") {
      const ids = (url.searchParams.get("teamIds") ?? "")
        .split(",")
        .map(Number);
      body = {
        teams: data.organizationTeams.teams.filter((t) => ids.includes(t.id)),
      };
    } else if (path === "people") body = data.people;
    else if (path === "schedule") body = data.schedule;
    else if (/^teams\/\d+\/roster$/.test(path))
      body = data.rosters[path.split("/")[1] as keyof typeof data.rosters];
    else if (/^game\/\d+\/boxscore$/.test(path))
      body = data.boxes[path.split("/")[1] as keyof typeof data.boxes];
    else throw new Error(`Unexpected mock endpoint ${path}`);
    active--;
    if (body === undefined)
      throw new Error(`Missing synthetic response ${path}`);
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetcher,
    urls,
    get maxActive() {
      return maxActive;
    },
  };
}

// Real schedule, paired ONLY with synthetic player/counting-stat responses.
import { gameStatus } from "../src/ingestion/sources/mlb-normalize";
import recorded from "../src/ingestion/fixtures/mlb/afl-2026.schedule-regression.json";
export const recordedSchedule = () => structuredClone(recorded.body);
export const recordedClubIds = new Set(recorded.teams.map((t) => t.id));
export function recordedScheduleFetch(schedule: unknown = recordedSchedule()) {
  const base = mockMlbFetch();
  const urls: string[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.href);
    if (url.pathname.endsWith("/schedule")) return json(schedule);
    if (url.pathname.endsWith("/teams") && url.searchParams.has("leagueIds"))
      return json({
        teams: recorded.teams.map((t, i) => ({
          ...t,
          abbreviation: `T${i}`,
          league: { id: 119 },
          sport: { id: 17 },
        })),
      });
    const match = url.pathname.match(/\/game\/(\d+)\/boxscore$/);
    if (match) {
      const rows = recorded.body.dates.flatMap((d) => d.games);
      const game = rows.find(
        (g) =>
          g.gamePk === Number(match[1]) && gameStatus(g.status) === "final",
      );
      if (!game)
        throw new Error("No completed recorded game for synthetic boxscore");
      const box = syntheticMlb().boxes["8001"];
      box.teams.home.team.id = game.teams.home.team.id;
      box.teams.away.team.id = game.teams.away.team.id;
      return json(box);
    }
    return base.fetcher(input, init);
  };
  return { fetcher, urls };
}
