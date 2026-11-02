import { fetchJson } from "../src/ingestion/http";
import { z } from "zod";
import { mlbBaseUrl, AFL } from "../src/ingestion/sources/mlb-config";
/** Metadata-only research probe. Candidate league ID 119 is not a validated adapter contract. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length)
    throw new Error("Usage: npm run ingest:probe:afl (no arguments)");
  const url = new URL(`league/${AFL.leagueId}`, mlbBaseUrl());
  const body = await fetchJson(url, { attempts: 1 });
  const result = z
    .object({
      leagues: z.array(z.object({ id: z.number().int(), name: z.string() })),
    })
    .parse(body);
  if (!result.leagues.some((l) => l.id === 119 && /arizona fall/i.test(l.name)))
    throw new Error(
      "Candidate endpoint did not confirm the Arizona Fall League",
    );
  console.log(
    JSON.stringify(
      {
        source: url.origin,
        path: url.pathname,
        status: "metadata-reachable",
        league: result.leagues.map((l) => ({ id: l.id, name: l.name })),
        notice:
          "Connectivity is not permission to ingest or redistribute. Live adapter and rights/coverage review remain pending.",
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(
    `Official-source metadata probe failed: ${error instanceof Error ? error.message : "unknown error"}. Fixture ingestion remains available; no live data was written.`,
  );
  process.exitCode = 1;
});
