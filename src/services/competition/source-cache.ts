/**
 * The competition level cache and its analytics preparation policy (no `server-only` import, so
 * the policy is unit-tested directly; src/services/competition/index.ts wires it to the real data
 * source).
 *
 * Preparation = `prepareSnapshot`: the analytics context plus every role × window Momentum result
 * and the homepage Trending lists of a level (~0.3–0.75 s of CPU per full MiLB level).
 *
 * - Database mode (single long-running server): prepared EAGERLY on load, as before. The warm-up
 *   runs once at startup, off the request path, and a background reload swaps in a level only
 *   after it is prepared, so no visitor ever pays for it.
 * - Snapshot mode (Vercel): prepared LAZILY. Every serverless instance starts cold, and preparing
 *   all five levels on load made every first request wait for levels it does not show
 *   (docs/VERCEL.md, *Lazy analytics preparation*). Each view model is already memoized per loaded
 *   snapshot object (analyticsContextFor, memoBySnapshot, levelDirectoryRows), so the first request
 *   that needs a level computes exactly what it uses, once, and every later request reuses it.
 *   Outputs are identical either way: preparation only fills those memos earlier.
 */
import type { LevelId } from "@/services/players/levels";
import { createLevelCache, type LevelCache } from "./cache";
import type { DataSource } from "./data-source";
import { tracedLevelLoader, type LevelLoader } from "./load";
import { prepareSnapshot } from "./prepare";
import type { LoadTrace } from "@/db/instrument";

/** Whether a data source prepares analytics when a level loads (database) or on first use (snapshot). */
export const preparesOnLoad = (source: DataSource) => source.kind === "database";

export interface CompetitionCacheOptions {
  load: LevelLoader;
  version: () => Promise<string>;
  checkMs: number;
  /** Eager preparation on load (database mode) or none (snapshot mode: lazy, on first use). */
  prepareOnLoad: boolean;
  onTrace: (trace: LoadTrace, totalMs: number, ok: boolean) => void;
  onBackgroundError?: (level: LevelId, error: unknown) => void;
  /** Injectable for tests; defaults to the real warm-up. */
  prepare?: (snapshot: Parameters<typeof prepareSnapshot>[0]) => void;
}

export function competitionLevelCache(o: CompetitionCacheOptions): LevelCache {
  const prepare = o.prepare ?? prepareSnapshot;
  return createLevelCache({
    load: tracedLevelLoader(o.load, {
      prepare: o.prepareOnLoad ? (_level, snapshot) => snapshot && prepare(snapshot) : undefined,
      onTrace: o.onTrace,
    }),
    version: o.version,
    checkMs: o.checkMs,
    onBackgroundError: o.onBackgroundError,
  });
}
