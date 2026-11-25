/**
 * Watchlist URL state (pure, client-safe): `/watchlist?ids=<uuid,…>`.
 *
 * The starred players live only in this browser (src/lib/watchlist-storage.ts). The server never
 * sees that storage: the page renders from the query string alone, so every visitor gets the same
 * page for the same URL and it can be CDN-cached. A small client component puts the stored ids
 * into the URL (sorted, so one set of players has one URL). Bad input never errors or 404s; it is
 * dropped with a notice.
 */
import { ignoredIdsNotice, parseIdTokens, splitIdList } from "@/services/players/id-list";

/** Most players a watchlist holds (and a URL may name). */
export const WATCHLIST_MAX = 50;
/** Caps the work done on a hostile `ids` value before validation. */
const MAX_TOKENS = WATCHLIST_MAX * 2;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export interface WatchlistQuery {
  /** Unique, valid, lower-cased ids, sorted, at most WATCHLIST_MAX. */
  ids: string[];
  /** Input problems to show the visitor (never fatal). */
  notices: string[];
}

export function parseWatchlistQuery(params: Params): WatchlistQuery {
  const { ids, invalid, duplicate, extra } = parseIdTokens(splitIdList(one(params.ids), MAX_TOKENS), WATCHLIST_MAX);
  const notices: string[] = [];
  if (invalid) notices.push(ignoredIdsNotice(invalid, "invalid"));
  if (duplicate) notices.push(ignoredIdsNotice(duplicate, "duplicate"));
  if (extra) notices.push(`A watchlist shows up to ${WATCHLIST_MAX} players; ${extra} more ${extra === 1 ? "was" : "were"} left out.`);
  return { ids: ids.sort(), notices };
}

/**
 * Canonical watchlist URL for a set of ids: validated, de-duplicated, capped and sorted, so the
 * same players always give the same URL (one CDN cache entry, no loop when the client compares it
 * with the current URL).
 */
export function watchlistHref(ids: readonly string[]): string {
  const valid = parseIdTokens(ids, WATCHLIST_MAX).ids.sort();
  return valid.length ? `/watchlist?ids=${valid.join(",")}` : "/watchlist";
}
