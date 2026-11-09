import { connection } from "next/server";
import { competitionHealth } from "@/services/competition";
import { healthHttpStatus } from "@/services/competition/health";

/**
 * Health check for the host / load balancer: 200 once every level's data is loaded, 503 while
 * starting or when a first load failed. Never queries the database (in-memory state only), never
 * includes error details, and is never cached. See docs/DEPLOYMENT.md.
 */
export async function GET() {
  await connection();
  const report = competitionHealth();
  return Response.json(report, {
    status: healthHttpStatus(report),
    headers: { "Cache-Control": "no-store" },
  });
}
