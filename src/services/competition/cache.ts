/**
 * Per-level snapshot cache with stale-while-revalidate (pure: clock, loader and version probe are
 * injected, so it is unit-tested without a database).
 *
 * Ingestion writes only on explicit CLI applies, so a loaded level stays correct until a new
 * ingestion run is applied. Instead of re-reading every level on a timer (which made one request
 * per reuse window wait for a full reload), the cache:
 *  - loads a level once and keeps serving it;
 *  - at most every `checkMs`, runs a cheap version probe (the latest applied ingestion run) in the
 *    background, and reloads the level only when the version changed;
 *  - serves the previous snapshot while a reload runs, and keeps it when a probe or reload fails;
 *  - never reuses a failed first load: the next request tries again.
 *
 * The version is read BEFORE the level loads, so an apply that commits during a load is detected by
 * the next probe instead of being masked.
 */
import type { AflSnapshot } from "@/services/afl/types";
import type { LevelId } from "@/services/players/levels";

export interface LevelCacheOptions {
  load: (level: LevelId) => Promise<AflSnapshot | null>;
  /** Cheap identifier of the database's applied ingestion state. */
  version: () => Promise<string>;
  /** Minimum time between version probes for a level. */
  checkMs: number;
  now?: () => number;
  /** Runs on every freshly loaded snapshot before it is served (e.g. warm view-model caches). */
  prepare?: (level: LevelId, snapshot: AflSnapshot | null) => void;
  /** Background failures (probe or reload); the previous snapshot keeps being served. */
  onBackgroundError?: (level: LevelId, error: unknown) => void;
}

interface Entry {
  value?: { snapshot: AflSnapshot | null; version: string };
  checkedAt: number;
  /** Load in progress (first load or reload). */
  inflight?: Promise<AflSnapshot | null>;
}

export interface LevelCache {
  /** Resolves to the level snapshot (null = not ingested); rejects only when no snapshot exists yet. */
  get(level: LevelId): Promise<AflSnapshot | null>;
  /** Starts loading levels that have no snapshot yet (fire-and-forget warm-up). */
  warm(levels: readonly LevelId[]): void;
  /** For tests and diagnostics. */
  state(level: LevelId): { loaded: boolean; version: string | null; loading: boolean };
}

export function createLevelCache(opts: LevelCacheOptions): LevelCache {
  const now = opts.now ?? Date.now;
  const entries = new Map<LevelId, Entry>();
  const entry = (level: LevelId) => {
    let e = entries.get(level);
    if (!e) entries.set(level, (e = { checkedAt: 0 }));
    return e;
  };

  // Probes started at the same moment (every level after one idle period) share one query.
  let probe: { at: number; promise: Promise<string> } | undefined;
  const version = () => {
    const t = now();
    if (!probe || t - probe.at >= Math.min(opts.checkMs, 1_000)) {
      const promise = opts.version();
      probe = { at: t, promise };
      promise.catch(() => {
        if (probe?.promise === promise) probe = undefined;
      });
    }
    return probe.promise;
  };

  const load = (level: LevelId, e: Entry, knownVersion?: string) => {
    const promise = (async () => {
      const v = knownVersion ?? (await version());
      const snapshot = await opts.load(level);
      opts.prepare?.(level, snapshot);
      e.value = { snapshot, version: v };
      e.checkedAt = now();
      return snapshot;
    })();
    e.inflight = promise;
    promise
      .finally(() => {
        if (e.inflight === promise) e.inflight = undefined;
      })
      .catch(() => {});
    return promise;
  };

  const revalidate = (level: LevelId, e: Entry) => {
    e.checkedAt = now(); // one probe per window, even when it fails
    const current = e.value!;
    const promise = version().then((v) => (v === current.version ? current.snapshot : load(level, e, v)));
    if (!e.inflight) e.inflight = promise;
    promise
      .catch((error: unknown) => opts.onBackgroundError?.(level, error))
      .finally(() => {
        if (e.inflight === promise) e.inflight = undefined;
      });
  };

  return {
    get(level) {
      const e = entry(level);
      if (e.value) {
        if (!e.inflight && now() - e.checkedAt >= opts.checkMs) revalidate(level, e);
        return Promise.resolve(e.value.snapshot);
      }
      return e.inflight ?? load(level, e);
    },
    warm(levels) {
      for (const level of levels) {
        const e = entry(level);
        if (!e.value && !e.inflight) load(level, e).catch(() => {});
      }
    },
    state(level) {
      const e = entries.get(level);
      return { loaded: !!e?.value, version: e?.value?.version ?? null, loading: !!e?.inflight };
    },
  };
}
