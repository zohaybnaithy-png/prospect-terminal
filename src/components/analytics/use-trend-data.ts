"use client";
import { useEffect, useState } from "react";
import type { MomentumWindow, Role } from "@/analytics/config";
import type { LevelId } from "@/services/players/levels";

export type TrendDataState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; retry: () => void };

/**
 * One role × window of a Trends view. The page embeds the initial selection; other selections
 * are fetched once from /trends/data and kept for the rest of the visit. `skip` (e.g. a window
 * with no comparable players) avoids a request whose answer is known to be empty.
 */
export function useTrendData<T>(
  view: "map" | "risers",
  level: LevelId,
  role: Role,
  window: MomentumWindow,
  initial: { role: Role; window: MomentumWindow; data: T },
  skip = false,
): TrendDataState<T> {
  const key = `${role}|${window}`;
  const [loaded, setLoaded] = useState<Record<string, { ok: true; data: T } | { ok: false }>>(
    () => ({ [`${initial.role}|${initial.window}`]: { ok: true, data: initial.data } }),
  );
  const current = loaded[key];
  useEffect(() => {
    if (skip || current) return;
    let cancelled = false;
    const q = new URLSearchParams({ view, level, role, window });
    fetch(`/trends/data?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: T) => {
        if (!cancelled) setLoaded((l) => ({ ...l, [key]: { ok: true, data } }));
      })
      .catch(() => {
        if (!cancelled) setLoaded((l) => ({ ...l, [key]: { ok: false } }));
      });
    return () => {
      cancelled = true;
    };
  }, [view, level, role, window, key, skip, current]);
  if (!current) return { status: "loading" };
  if (current.ok) return { status: "ok", data: current.data };
  return {
    status: "error",
    retry: () =>
      setLoaded((l) => {
        const next = { ...l };
        delete next[key];
        return next;
      }),
  };
}
