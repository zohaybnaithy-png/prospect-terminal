/**
 * Runs every candidate Momentum model over the AFL dataset and prints the comparison.
 *
 * Read-only: loads the snapshot through loadAflSnapshot (a READ ONLY, REPEATABLE READ transaction)
 * from DATABASE_URL. With --synthetic it uses the clearly fictional test snapshot instead (useful
 * where no database is reachable — the output is NOT real AFL data and says so).
 *
 *   DATABASE_URL=... npm run analytics:compare -- --window 14d [--json] [--limit 20]
 *   npm run analytics:compare -- --synthetic
 *
 * Diagnostics go to stderr; stdout carries only the report.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { loadAflSnapshot } from "../src/services/afl/queries";
import {
  MOMENTUM_WINDOW_IDS,
  compareModels,
  createAnalyticsContext,
  renderComparisonMarkdown,
  type MomentumWindow,
} from "../src/analytics";
import { trajectorySnapshot } from "./analytics-test-support";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const window = (arg("window") ?? "14d") as MomentumWindow;
  if (!MOMENTUM_WINDOW_IDS.includes(window))
    throw new Error(`--window must be one of ${MOMENTUM_WINDOW_IDS.join(", ")}`);
  const limit = Number(arg("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  let source: string;
  let snapshot;
  if (flag("synthetic")) {
    source = "SYNTHETIC fictional test snapshot (not real AFL data)";
    snapshot = trajectorySnapshot();
  } else {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Set DATABASE_URL (read-only use) or pass --synthetic");
    const pool = new Pool({ connectionString: url });
    try {
      console.error("[analytics] loading AFL snapshot (read-only transaction)…");
      snapshot = await loadAflSnapshot(drizzle(pool, { schema }));
    } finally {
      await pool.end();
    }
    if (!snapshot) throw new Error("No AFL league/season has been ingested in this database");
    source = `database AFL snapshot (${snapshot.season.name})`;
  }
  console.error("[analytics] running candidate models…");
  const cmp = compareModels(createAnalyticsContext(snapshot), window, limit);
  process.stdout.write(
    flag("json") ? JSON.stringify({ source, ...cmp }, null, 2) + "\n" : renderComparisonMarkdown(cmp, { source }) + "\n",
  );
}

main().catch((error: unknown) => {
  // Never echo connection strings: report only a message stripped of URLs.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[analytics] failed: ${message.replace(/postgres(ql)?:\/\/\S+/gi, "<redacted>")}`);
  process.exit(1);
});
