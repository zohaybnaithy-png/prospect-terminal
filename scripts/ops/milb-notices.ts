/**
 * Read-only notice inspection for one MiLB capture: re-reads the Stats API with the same options
 * the CLI uses and prints every notice (reason, record key, message). No database: no sink is
 * created and no connection string is read. stdout carries only the JSON result.
 *
 *   node --import tsx scripts/ops/milb-notices.ts aaa 2026-09-15 2026-09-21
 */
import { MilbStatsApiSource } from "../../src/ingestion/sources/milb-stats-api";
import { ingest } from "../../src/ingestion/runner";
import { isMilbLevelId } from "../../src/domain/levels";

async function main() {
  const [level, from, to] = process.argv.slice(2);
  if (!level || !isMilbLevelId(level) || !/^\d{4}-\d{2}-\d{2}$/.test(from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? ""))
    throw new Error("usage: milb-notices.ts <aaa|aa|high-a|single-a> <from> <to>");
  const season = Number(from.slice(0, 4));
  const base = {
    season,
    levels: [level],
    concurrency: 4,
    rosterType: "fullSeason" as const,
    gameTypes: ["R" as const],
    refetchWindowDays: 3,
  };
  const out = [];
  for (const phase of ["structure", "games"] as const) {
    const source = new MilbStatsApiSource(
      phase === "games" ? { ...base, mode: phase, from, to } : { ...base, mode: phase },
    );
    // No sink: an offline dry run of the live capture (nothing is compared or written).
    const report = await ingest(source, undefined, { dryRun: true });
    out.push({
      phase,
      status: report.status,
      records: report.records,
      issues: report.issues,
      notices: (report.notices ?? []).map((n) => ({
        reason: n.reason,
        recordKey: n.recordKey,
        message: n.message,
      })),
    });
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
