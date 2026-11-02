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
