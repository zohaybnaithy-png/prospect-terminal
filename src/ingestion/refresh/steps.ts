import { parseMilbArgs } from "../cli-options";
import { runMilbIngestion, type MilbRunSummary } from "../milb-runner";
import { PostgresIngestionSink } from "../postgres-sink";
import { ingest, type IngestionReport } from "../runner";
import { MLBStatsApiSource } from "../sources/mlb-stats-api";
import type { StepName, StepOutcome } from "./job";

/**
 * The job's steps, wired to the existing pipeline. MiLB options come from the same parser as
 * `ingest:milb`, so a scheduled capture is exactly `ingest:milb --incremental --games-only --apply`
 * (and `--rosters-only --roster-type=active --apply` for structure): same defaults, same validation.
 * Each attempt opens its own sink (connection pool) bound to the job's abort signal and closes it.
 */
export interface StepDeps {
  url: string;
  season: number;
  apply: boolean;
  /** Injected for tests / local mocks; production uses the real fetch. */
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

const milbArgs = (d: StepDeps, extra: string[]) =>
  parseMilbArgs([`--season=${d.season}`, d.apply ? "--apply" : "--dry-run", ...extra]);

export function milbOutcome(s: MilbRunSummary): StepOutcome {
  const detail = {
    range: s.range,
    chunks: s.chunks.length,
    records: s.totals.records,
    changed: s.totals.changed,
    unchanged: s.totals.unchanged,
    issues: s.totals.issues,
    ...(s.resumeFrom ? { resumeFrom: s.resumeFrom } : {}),
  };
  if (s.status === "failed") return { status: "failed", detail, error: s.chunks.find((c) => c.status === "failed")?.error ?? "failed" };
  return { status: s.status === "ok-with-quarantine" ? "ok-with-quarantine" : "ok", detail };
}

export function aflOutcome(r: IngestionReport): StepOutcome {
  const detail = { records: r.records, changed: r.changed, unchanged: r.unchanged, issues: r.issues, runId: r.runId };
  if (r.status === "quarantined") return { status: "quarantined", detail, error: `${r.issues} issue(s); nothing applied` };
  if (r.status === "applied-with-quarantine" || r.status === "dry-run-with-quarantine") return { status: "ok-with-quarantine", detail };
  return { status: "ok", detail };
}

export function pipelineSteps(d: StepDeps): Record<StepName, (signal: AbortSignal) => Promise<StepOutcome>> {
  const withSink = async <T>(signal: AbortSignal, fn: (sink: PostgresIngestionSink) => Promise<T>) => {
    const sink = new PostgresIngestionSink(d.url, { signal });
    try {
      return await fn(sink);
    } finally {
      await sink.close();
    }
  };
  const sourceDeps = { fetcher: d.fetcher, sleep: d.sleep, clock: d.clock };
  return {
    "milb-structure": (signal) =>
      withSink(signal, async (sink) =>
        milbOutcome(await runMilbIngestion(milbArgs(d, ["--rosters-only", "--roster-type=active"]), { sink, ...sourceDeps })),
      ),
    "milb-games": (signal) =>
      withSink(signal, async (sink) =>
        milbOutcome(await runMilbIngestion(milbArgs(d, ["--incremental", "--games-only"]), { sink, ...sourceDeps })),
      ),
    afl: (signal) =>
      withSink(signal, async (sink) =>
        aflOutcome(
          await ingest(new MLBStatsApiSource({ season: d.season, mode: "all" }, sourceDeps), sink, { dryRun: !d.apply }),
        ),
      ),
  };
}
