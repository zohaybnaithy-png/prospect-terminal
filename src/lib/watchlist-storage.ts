/**
 * The watchlist's only store: this browser's `localStorage` (T-202). No cookies, no server state,
 * no tracking: the starred ids never leave the browser except as the `/watchlist?ids=` URL the
 * browser itself requests.
 *
 * Storage can be missing or throw at any access (blocked site data, some private modes, quota,
 * sandboxed frames), so every access is wrapped and a failure becomes the "unavailable" state the
 * UI explains. Stored data is untrusted: it is re-validated on every read.
 *
 * The pure functions take the storage object as a parameter (tests pass fakes); the browser store
 * below (`subscribe` / `snapshot`) feeds React's useSyncExternalStore in the star buttons and the
 * watchlist page, with `null` on the server and during hydration, so server HTML never depends on
 * a visitor's stars.
 */
import { PLAYER_UUID } from "@/services/players/id-list";
import { WATCHLIST_MAX } from "@/services/watchlist/query";

export const WATCHLIST_STORAGE_KEY = "pt.watchlist.v1";
/** Same-tab change notification (the `storage` event only fires in other tabs). */
const CHANGE_EVENT = "pt:watchlist-change";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type WatchlistState =
  | { status: "ready"; ids: readonly string[] }
  | { status: "unavailable" };

export const UNAVAILABLE: WatchlistState = Object.freeze({ status: "unavailable" });
const EMPTY: WatchlistState = Object.freeze({ status: "ready", ids: Object.freeze([]) as readonly string[] });

/** Stored value → valid, unique, lower-cased ids in starring order (at most WATCHLIST_MAX). */
export function decodeWatchlist(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const v of parsed) {
    if (typeof v !== "string" || !PLAYER_UUID.test(v)) continue;
    const id = v.toLowerCase();
    if (!out.includes(id) && out.length < WATCHLIST_MAX) out.push(id);
  }
  return out;
}

export function readWatchlist(storage: StorageLike | null): WatchlistState {
  if (!storage) return UNAVAILABLE;
  try {
    const ids = decodeWatchlist(storage.getItem(WATCHLIST_STORAGE_KEY));
    return ids.length ? { status: "ready", ids } : EMPTY;
  } catch {
    return UNAVAILABLE;
  }
}

/** Writes the list (removing the key when empty). False when storage refused. */
export function writeWatchlist(storage: StorageLike | null, ids: readonly string[]): boolean {
  if (!storage) return false;
  try {
    if (ids.length) storage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(ids));
    else storage.removeItem(WATCHLIST_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export type ToggleResult = "added" | "removed" | "full" | "unavailable" | "invalid";

/** Adds or removes one player. Never throws; a refused write leaves the stored list unchanged. */
export function toggleWatchlist(storage: StorageLike | null, playerId: string): ToggleResult {
  if (!PLAYER_UUID.test(playerId)) return "invalid";
  const id = playerId.toLowerCase();
  const state = readWatchlist(storage);
  if (state.status === "unavailable") return "unavailable";
  const has = state.ids.includes(id);
  if (!has && state.ids.length >= WATCHLIST_MAX) return "full";
  const next = has ? state.ids.filter((x) => x !== id) : [...state.ids, id];
  return writeWatchlist(storage, next) ? (has ? "removed" : "added") : "unavailable";
}

// ---- browser store -------------------------------------------------------------------------------

let probed: { storage: StorageLike | null } | undefined;

/**
 * This browser's localStorage when it can actually be written (probed once per page load), else
 * null. Reading `window.localStorage` itself throws when site data is blocked.
 */
export function browserStorage(): StorageLike | null {
  if (probed) return probed.storage;
  let storage: StorageLike | null = null;
  try {
    if (typeof window !== "undefined") {
      const s = window.localStorage;
      const probe = `${WATCHLIST_STORAGE_KEY}.probe`;
      s.setItem(probe, "1");
      s.removeItem(probe);
      storage = s;
    }
  } catch {
    storage = null;
  }
  probed = { storage };
  return storage;
}

/** Tests only: forget the probe result (a new fake `window`). */
export function resetBrowserStorageProbe() {
  probed = undefined;
  last = undefined;
}

/** Snapshot cache key for "storage could not be read". */
const BLOCKED = Symbol("blocked");
let last: { raw: string | null | typeof BLOCKED; state: WatchlistState } | undefined;

/**
 * useSyncExternalStore snapshot: the same object while the stored value is unchanged (React
 * compares snapshots by identity).
 */
export function watchlistSnapshot(): WatchlistState {
  const storage = browserStorage();
  let raw: string | null | typeof BLOCKED;
  try {
    raw = storage ? storage.getItem(WATCHLIST_STORAGE_KEY) : BLOCKED;
  } catch {
    raw = BLOCKED;
  }
  if (last && last.raw === raw) return last.state;
  const ids = raw === BLOCKED ? null : decodeWatchlist(raw);
  const state: WatchlistState = ids === null ? UNAVAILABLE : ids.length ? { status: "ready", ids } : EMPTY;
  last = { raw, state };
  return state;
}

/** Server and hydration snapshot: unknown. Server HTML never reflects a visitor's stars. */
export const serverWatchlistSnapshot = (): WatchlistState | null => null;

export function subscribeWatchlist(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === WATCHLIST_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** Toggle in this browser and notify every subscriber on the page. */
export function toggleInBrowser(playerId: string): ToggleResult {
  const result = toggleWatchlist(browserStorage(), playerId);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
  return result;
}
