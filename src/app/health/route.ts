import { connection } from "next/server";
import { competitionHealth } from "@/services/competition";
import { sharedTrafficState, trafficHealth } from "@/lib/traffic/health";
import { processStats } from "@/lib/process-stats";
import { indexingEnabled } from "@/lib/indexing";
import { buildHealthResponse, isLocalHealthRequest } from "@/lib/health-response";

/**
 * Health check for the host and the deploy gate: 200 once every level's data is loaded, 503 while
 * starting, when a first load failed, or when production traffic protection is misconfigured
 * (src/lib/traffic/health.ts). It never queries the database (in-memory state only), never includes
 * error details, and is never cached.
 *
 * Public requests (through Caddy) get only `ready` / `unavailable`. The full report (levels,
 * refresh failures, traffic protection, indexing, memory) is only for direct local requests: the
 * deploy script and the monitor on the same host. See src/lib/health-response.ts and
 * docs/OBSERVABILITY.md.
 */
export async function GET(request: Request) {
  await connection();
  const { status, body } = buildHealthResponse(
    competitionHealth(),
    trafficHealth(process.env, sharedTrafficState()),
    { indexing: indexingEnabled() ? "on" : "off", process: processStats() },
    isLocalHealthRequest(request.headers, process.env),
  );
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
