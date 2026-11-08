/**
 * Client-side cache of on-demand Trends data (one store per mounted view component), kept free of
 * React so it can be tested directly.
 *
 * Every entry is keyed by level × role × window. The Trends page keeps its client components
 * mounted when the level changes (only the search params change), so a key without the level would
 * show the previous level's lists or points. Each response is written only under the key it was
 * requested for, so a slow response that arrives after the selection moved on cannot replace what
 * is shown: it only fills its own entry. The page-embedded selection (`initial`) is never cached:
 * it is read from the current props, so a new level's server data is used as soon as it arrives.
 */
import type { MomentumWindow, Role } from "@/analytics/config";
import type { LevelId } from "@/services/players/levels";

export type TrendView = "map" | "risers";

export interface TrendSelection {
  level: LevelId;
  role: Role;
  window: MomentumWindow;
}

export type TrendDataState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; retry: () => void };

type Entry<T> = { ok: true; data: T } | { ok: false };

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetch: FetchJson = (url) =>
  fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

export const trendKey = ({ level, role, window }: TrendSelection) => `${level}|${role}|${window}`;

export class TrendDataStore<T> {
  private entries = new Map<string, Entry<T>>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly view: TrendView,
    private readonly fetchJson: FetchJson = defaultFetch,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever an entry is written (useSyncExternalStore snapshot). */
  getVersion = () => this.version;

  /** What to show for `sel`. `initial` is the selection embedded in the current page. */
  state(sel: TrendSelection, initial: TrendSelection & { data: T }, skip = false): TrendDataState<T> {
    if (trendKey(sel) === trendKey(initial)) return { status: "ok", data: initial.data };
    const entry = skip ? undefined : this.entries.get(trendKey(sel));
    if (!entry) return { status: "loading" };
    if (entry.ok) return { status: "ok", data: entry.data };
    return { status: "error", retry: () => this.retry(sel) };
  }

  /** Requests `sel` unless it is embedded, cached (including a failure) or already in flight. */
  ensure(sel: TrendSelection, initial: TrendSelection) {
    const key = trendKey(sel);
    if (key === trendKey(initial) || this.entries.has(key) || this.inflight.has(key)) return;
    this.inflight.add(key);
    const q = new URLSearchParams({ view: this.view, level: sel.level, role: sel.role, window: sel.window });
    this.fetchJson(`/trends/data?${q}`).then(
      (data) => this.settle(key, { ok: true, data: data as T }),
      () => this.settle(key, { ok: false }),
    );
  }

  /** Forgets a failed entry so the next ensure() requests it again. */
  retry(sel: TrendSelection) {
    const key = trendKey(sel);
    if (this.entries.get(key)?.ok !== false) return;
    this.entries.delete(key);
    this.emit();
  }

  private settle(key: string, entry: Entry<T>) {
    this.inflight.delete(key);
    this.entries.set(key, entry);
    this.emit();
  }

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }
}
