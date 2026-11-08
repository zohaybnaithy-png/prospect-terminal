"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MomentumWindow, Role } from "@/analytics/config";
import type { LevelId } from "@/services/players/levels";
import { TrendDataStore, type TrendDataState, type TrendView } from "./trend-data-store";

export type { TrendDataState } from "./trend-data-store";

/**
 * One level × role × window of a Trends view. The page embeds the initial selection for its level;
 * other selections are fetched once from /trends/data and kept for the rest of the visit (see
 * trend-data-store.ts). `skip` (e.g. a window with no comparable players) avoids a request whose
 * answer is known to be empty.
 */
export function useTrendData<T>(
  view: TrendView,
  level: LevelId,
  role: Role,
  window: MomentumWindow,
  initial: { role: Role; window: MomentumWindow; data: T },
  skip = false,
): TrendDataState<T> {
  const [store] = useState(() => new TrendDataStore<T>(view));
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const sel = { level, role, window };
  const embedded = { level, role: initial.role, window: initial.window, data: initial.data };
  const state = store.state(sel, embedded, skip);
  const missing = !skip && state.status === "loading";
  useEffect(() => {
    if (missing) store.ensure({ level, role, window }, { level, role: initial.role, window: initial.window });
  }, [store, missing, level, role, window, initial.role, initial.window]);
  return state;
}
