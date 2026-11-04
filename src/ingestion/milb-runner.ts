/**
 * Orchestrates MiLB ingestion as a sequence of independent, resumable captures:
 *
 *   1. structure  — levels/leagues/teams/organizations/rosters/people (one capture)
 *   2. games      — schedule + completed boxscores in consecutive date chunks (one capture,
 *                   one snapshot and ONE transaction per chunk)
 *
 * Chunking bounds memory, request bursts and transaction size for a full-season backfill, and
 * makes failures resumable: every chunk is idempotent, so a failed run is resumed with
 * `--from=<resumeFrom>`. Incremental runs start a few days before the latest complete game
 * already stored and skip boxscores of games already complete (outside a short refetch window).
 *
 * This module is framework-free and used by the CLI and tests; it never schedules itself.
 */
import { milbLevelExternalIdPrefix, milbSeasonExternalId, MILB_LEVELS } from "@/domain/levels";
import type { MilbLevelId } from "@/domain/levels";
import type { IngestionReport, IngestionSink } from "./runner";
import { ingest } from "./runner";
import { MilbStatsApiSource } from "./sources/milb-stats-api";
import type { MilbGameType } from "./sources/milb-config";
import { MLB_SOURCE_ID } from "./sources/mlb-config";
import { beginStage, progress } from "./progress";

export interface MilbRunOptions {
  season: number;
  levels: MilbLevelId[];
  league?: number;
  team?: number;
  from?: string;
  to?: string;
  mode: "all" | "structure" | "games";
  apply: boolean;
  incremental: boolean;
  refetchComplete: boolean;
  chunkDays: number;
  concurrency: number;
  lookbackDays: number;
  refetchWindowDays: number;
  rosterType: "fullSeason" | "active";
  gameTypes: MilbGameType[];
  recordDir?: string;
}

/** The subset of PostgresIngestionSink the orchestrator uses (read-only helpers + apply). */
export interface MilbSink extends IngestionSink {
  completedGameIds(provider: string, candidates?: string[]): Promise<Set<string>>;
  knownExternalIds(provider: string, kind: "player"): Promise<Set<string>>;
  latestCompleteGameDate(
    provider: string,
    seasonExternalId: string,
    levelPrefixes?: string[],
  ): Promise<string | null>;
}

export interface MilbRunDependencies {
  sink?: MilbSink;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

export interface ChunkSummary {
  phase: "structure" | "games";
  from?: string;
  to?: string;
  status: IngestionReport["status"] | "failed";
  records?: number;
  issues?: number;
  changed?: number;
  unchanged?: number;
  notices?: number;
  reusedBoxscores?: number;
  operations?: Record<string, number>;
  databaseComparison?: IngestionReport["databaseComparison"];
  diagnostics?: IngestionReport["diagnostics"];
  error?: string;
}

export interface MilbRunSummary {
  provider: string;
  season: number;
  levels: MilbLevelId[];
  mode: MilbRunOptions["mode"];
  apply: boolean;
  incremental: boolean;
  range?: { from: string; to: string };
  chunks: ChunkSummary[];
  totals: { records: number; issues: number; changed: number; unchanged: number; notices: number };
  status: "ok" | "ok-with-quarantine" | "failed";
  /** Set when a games chunk failed: re-run with --from=<resumeFrom> to continue. */
  resumeFrom?: string;
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Consecutive inclusive date windows of at most `days` days covering [from, to]. */
export function planDateChunks(from: string, to: string, days: number) {
  if (from > to) return [];
  const chunks: { from: string; to: string }[] = [];
  for (let start = from; start <= to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    chunks.push({ from: start, to: end < to ? end : to });
  }
  return chunks;
}

/** Default season window: MiLB regular seasons run April–September (spring/fall excluded). */
export const defaultSeasonWindow = (season: number) => ({
  from: `${season}-03-01`,
  to: `${season}-10-31`,
});

/** Resolves the games date range for a run (explicit, incremental, or default season window). */
export async function resolveGamesRange(
  o: MilbRunOptions,
  deps: MilbRunDependencies,
): Promise<{ from: string; to: string }> {
  const window = defaultSeasonWindow(o.season);
  const today = (deps.clock?.() ?? new Date()).toISOString().slice(0, 10);
  const cap = (d: string) => (d > window.to ? window.to : d);
  let from = o.from ?? window.from;
  let to = o.to ?? (today.slice(0, 4) === String(o.season) ? cap(today) : window.to);
  if (o.incremental) {
    if (!deps.sink) throw new Error("--incremental needs a database (INGESTION_DATABASE_URL)");
    const latest = await deps.sink.latestCompleteGameDate(
      MLB_SOURCE_ID,
      milbSeasonExternalId(o.season),
      o.levels.map((l) => milbLevelExternalIdPrefix(MILB_LEVELS[l].sportId)),
    );
    from = latest ? addDays(latest, -o.lookbackDays) : window.from;
    if (from < `${o.season}-01-01`) from = `${o.season}-01-01`;
  }
  if (to < from) to = from;
  return { from, to };
}

function summarize(phase: ChunkSummary["phase"], r: IngestionReport, range?: { from: string; to: string }): ChunkSummary {
  return {
    phase,
    ...(range ?? {}),
    status: r.status,
    records: r.records,
    issues: r.issues,
    ...(r.changed !== undefined ? { changed: r.changed, unchanged: r.unchanged } : {}),
    notices: r.notices?.length ?? 0,
    reusedBoxscores: Number(
      r.notices?.find((n) => n.reason === "reused-boxscores")?.message.match(/^\d+/)?.[0] ?? 0,
    ),
    ...(r.operations ? { operations: r.operations } : {}),
    ...(r.databaseComparison ? { databaseComparison: r.databaseComparison } : {}),
    ...(r.diagnostics?.length ? { diagnostics: r.diagnostics.slice(0, 25) } : {}),
  };
}

export async function runMilbIngestion(
  o: MilbRunOptions,
  deps: MilbRunDependencies = {},
): Promise<MilbRunSummary> {
  if (o.apply && !deps.sink) throw new Error("--apply requires a database sink");
  const chunks: ChunkSummary[] = [];
  const summary: MilbRunSummary = {
    provider: MLB_SOURCE_ID,
    season: o.season,
    levels: o.levels,
    mode: o.mode,
    apply: o.apply,
    incremental: o.incremental,
    chunks,
    totals: { records: 0, issues: 0, changed: 0, unchanged: 0, notices: 0 },
    status: "ok",
  };
  const base = {
    season: o.season,
    levels: o.levels,
    ...(o.league ? { league: o.league } : {}),
    ...(o.team ? { team: o.team } : {}),
    concurrency: o.concurrency,
    rosterType: o.rosterType,
    gameTypes: o.gameTypes,
    refetchWindowDays: o.refetchWindowDays,
    ...(o.recordDir ? { recordDir: o.recordDir } : {}),
  };
  const sourceDeps = { fetcher: deps.fetcher, sleep: deps.sleep, clock: deps.clock };
  const run = async (adapter: MilbStatsApiSource) =>
    ingest(adapter, deps.sink, { dryRun: !o.apply });

  if (o.mode !== "games") {
    beginStage("milb:structure");
    try {
      const report = await run(
        new MilbStatsApiSource({ ...base, mode: "structure" }, sourceDeps),
      );
      chunks.push(summarize("structure", report));
    } catch (error) {
      chunks.push({ phase: "structure", status: "failed", error: errorText(error) });
      summary.status = "failed";
      return finish(summary);
    }
  }

  if (o.mode !== "structure") {
    const range = await resolveGamesRange(o, deps);
    summary.range = range;
    const known =
      deps.sink && !o.refetchComplete
        ? [...(await deps.sink.completedGameIds(MLB_SOURCE_ID))].map(Number)
        : [];
    for (const chunk of planDateChunks(range.from, range.to, o.chunkDays)) {
      beginStage("milb:games-chunk", chunk);
      try {
        // Players stored by earlier chunks need no people lookup when they reappear.
        const knownPlayers = deps.sink
          ? new Set([...(await deps.sink.knownExternalIds(MLB_SOURCE_ID, "player"))].map(Number))
          : undefined;
        const report = await run(
          new MilbStatsApiSource(
            { ...base, mode: "games", from: chunk.from, to: chunk.to, knownComplete: known },
            { ...sourceDeps, knownPlayers },
          ),
        );
        chunks.push(summarize("games", report, chunk));
      } catch (error) {
        chunks.push({ phase: "games", ...chunk, status: "failed", error: errorText(error) });
        summary.status = "failed";
        summary.resumeFrom = chunk.from;
        progress("milb:resume-hint", { from: chunk.from });
        return finish(summary);
      }
    }
  }
  return finish(summary);
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function finish(summary: MilbRunSummary): MilbRunSummary {
  for (const c of summary.chunks) {
    summary.totals.records += c.records ?? 0;
    summary.totals.issues += c.issues ?? 0;
    summary.totals.changed += c.changed ?? 0;
    summary.totals.unchanged += c.unchanged ?? 0;
    summary.totals.notices += c.notices ?? 0;
  }
  if (summary.status !== "failed" && summary.totals.issues)
    summary.status = "ok-with-quarantine";
  return summary;
}
