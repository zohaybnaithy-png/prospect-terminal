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
 *  - bounds every load (`loadTimeoutMs`): a load that has not finished is abandoned and counts as
 *    a failure, so no request and no refresh can wait on it indefinitely;
 *  - never reuses a failed first load, but backs off (`retryBaseMs`, doubling up to `retryMaxMs`)
 *    before trying again; requests in the backoff window fail fast instead of each starting a load,
 *    so a database outage cannot turn traffic into a retry storm. Background refreshes are
 *    naturally spaced by `checkMs`.
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
  /** Upper bound for one load (probe + level read + prepare). Default 90 s; 0 disables. */
  loadTimeoutMs?: number;
  /** Backoff after a failed first load: first wait, doubling per consecutive failure, capped. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export class LevelLoadTimeoutError extends Error {
  constructor(level: LevelId, ms: number) {
    super(`${level} load did not finish within ${Math.round(ms / 1000)}s`);
    this.name = "LevelLoadTimeoutError";
  }
}

interface Entry {
  value?: { snapshot: AflSnapshot | null; version: string };
  checkedAt: number;
  /** Load in progress (first load or reload). */
  inflight?: Promise<AflSnapshot | null>;
  /** Consecutive failed first loads, the last error, and when the next attempt may start. */
  failures: number;
  lastError?: unknown;
  retryAt: number;
}

export interface LevelCache {
  /** Resolves to the level snapshot (null = not ingested); rejects only when no snapshot exists yet. */
  get(level: LevelId): Promise<AflSnapshot | null>;
  /** Starts loading levels that have no snapshot yet (fire-and-forget warm-up). */
  warm(levels: readonly LevelId[]): void;
  /** For tests and diagnostics. */
  state(level: LevelId): {
    loaded: boolean;
    version: string | null;
    loading: boolean;
    failures: number;
    retryInMs: number;
  };
}

export function createLevelCache(opts: LevelCacheOptions): LevelCache {
  const now = opts.now ?? Date.now;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 90_000;
  const retryBaseMs = opts.retryBaseMs ?? 5_000;
  const retryMaxMs = opts.retryMaxMs ?? 60_000;
  const entries = new Map<LevelId, Entry>();
  const entry = (level: LevelId) => {
    let e = entries.get(level);
    if (!e) entries.set(level, (e = { checkedAt: 0, failures: 0, retryAt: 0 }));
    return e;
  };

  const bounded = <T>(level: LevelId, work: Promise<T>): Promise<T> => {
    if (!loadTimeoutMs) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LevelLoadTimeoutError(level, loadTimeoutMs)), loadTimeoutMs);
      timer.unref?.();
    });
    work.catch(() => {}); // an abandoned load may still fail later; that is not unhandled
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
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
    const promise = bounded(
      level,
      (async () => {
        const v = knownVersion ?? (await version());
        const snapshot = await opts.load(level);
        return { snapshot, v };
      })(),
    ).then(
      ({ snapshot, v }) => {
        // Only a load that finished in time is applied (an abandoned one never overwrites).
        opts.prepare?.(level, snapshot);
        e.value = { snapshot, version: v };
        e.checkedAt = now();
        e.failures = 0;
        e.lastError = undefined;
        return snapshot;
      },
      (error: unknown) => {
        if (!e.value) {
          e.failures++;
          e.lastError = error;
          e.retryAt = now() + Math.min(retryBaseMs * 2 ** (e.failures - 1), retryMaxMs);
        }
        throw error;
      },
    );
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
      if (e.inflight) return e.inflight;
      if (e.failures && now() < e.retryAt) return Promise.reject(e.lastError);
      return load(level, e);
    },
    warm(levels) {
      for (const level of levels) {
        const e = entry(level);
        if (!e.value && !e.inflight && !(e.failures && now() < e.retryAt))
          load(level, e).catch(() => {});
      }
    },
    state(level) {
      const e = entries.get(level);
      return {
        loaded: !!e?.value,
        version: e?.value?.version ?? null,
        loading: !!e?.inflight,
        failures: e?.failures ?? 0,
        retryInMs: e && e.failures ? Math.max(0, e.retryAt - now()) : 0,
      };
    },
  };
}
