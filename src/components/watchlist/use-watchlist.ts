"use client";
import { useSyncExternalStore } from "react";
import {
  serverWatchlistSnapshot,
  subscribeWatchlist,
  watchlistSnapshot,
  type WatchlistState,
} from "@/lib/watchlist-storage";

/**
 * This browser's watchlist, or null on the server and during hydration (so server-rendered,
 * CDN-cached HTML is identical for everyone and hydration never mismatches).
 */
export function useWatchlist(): WatchlistState | null {
  return useSyncExternalStore(subscribeWatchlist, watchlistSnapshot, serverWatchlistSnapshot);
}
