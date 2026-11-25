/**
 * Watchlist view model (server-side; pure over loaded level snapshots, no I/O).
 *
 * For each starred player: the level of their most recent completed game this season (the same
 * rule a profile opens at: latest game, ties in ladder order) and that level's season row from
 * `levelDirectoryRows` — the Players directory's memoized / precomputed rows, so the season line
 * and the default-window Momentum (+ confidence and sample) are exactly what the directory and
 * profile show. Statistics and Momentum are from that one level; levels are never blended. Other
 * levels the player has lines at are listed, not merged.
 */
import { levelDirectoryRows } from "@/services/players/adapter";
import type { PlayerDirectoryRow } from "@/services/players/directory";
import { levelOrder, type LevelId } from "@/services/players/levels";
import type { LevelSnapshot } from "@/services/competition/types";
import { anyName } from "@/services/compare/model";
import type { WatchlistQuery } from "./query";

export interface WatchlistEntry {
  id: string;
  /** Null when the id is not a player anywhere in the loaded data. */
  name: string | null;
  /** "ok" = has a season line; "no-lines" = known player without a completed game line yet. */
  status: "ok" | "no-lines" | "not-found";
  /** Season row at the latest level (statistics and Momentum from that level only). */
  row: PlayerDirectoryRow | null;
  /** Season name of that level's snapshot (the AFL and MiLB seasons are separate seasons). */
  seasonName: string | null;
  /** Every level with lines this season, ladder order (includes `row.level`). */
  levels: LevelId[];
}

export interface WatchlistView {
  query: WatchlistQuery;
  entries: WatchlistEntry[];
  /** Entries with a batting line at their latest level, by name. */
  hitters: WatchlistEntry[];
  /** Entries with a pitching line at their latest level, by name (two-way players are in both). */
  pitchers: WatchlistEntry[];
  noLines: WatchlistEntry[];
  notFound: WatchlistEntry[];
}

const byIdMemo = new WeakMap<PlayerDirectoryRow[], Map<string, PlayerDirectoryRow>>();
function rowsById(rows: PlayerDirectoryRow[]) {
  let m = byIdMemo.get(rows);
  if (!m) byIdMemo.set(rows, (m = new Map(rows.map((r) => [r.id, r]))));
  return m;
}

/** Latest game first; ties in ladder order (as `playerLevels` / the profile's default level). */
const latestFirst = (a: { row: PlayerDirectoryRow }, b: { row: PlayerDirectoryRow }) =>
  (b.row.lastGame ?? "").localeCompare(a.row.lastGame ?? "") || levelOrder(a.row.level) - levelOrder(b.row.level);

const byName = (a: WatchlistEntry, b: WatchlistEntry) =>
  (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id);

export function watchlistView(levels: LevelSnapshot[], query: WatchlistQuery): WatchlistView {
  const indexed = levels.map((ls) => ({ ls, rows: rowsById(levelDirectoryRows(ls.snapshot, ls.level, "season")) }));
  const entries: WatchlistEntry[] = query.ids.map((id) => {
    const found = indexed
      .map(({ ls, rows }) => ({ ls, row: rows.get(id) }))
      // Every rostered player has a row; only rows with a completed-game line count as "played".
      .filter((x): x is { ls: LevelSnapshot; row: PlayerDirectoryRow } => !!x.row && (x.row.batting !== null || x.row.pitching !== null))
      .sort(latestFirst);
    const latest = found[0];
    if (latest)
      return {
        id,
        name: latest.row.name,
        status: "ok",
        row: latest.row,
        seasonName: latest.ls.snapshot.season.name,
        levels: found.map((f) => f.row.level).sort((a, b) => levelOrder(a) - levelOrder(b)),
      };
    const name = anyName(levels, id);
    return { id, name, status: name === null ? "not-found" : "no-lines", row: null, seasonName: null, levels: [] };
  });
  const ok = entries.filter((e) => e.status === "ok").sort(byName);
  return {
    query,
    entries,
    hitters: ok.filter((e) => e.row!.batting !== null),
    pitchers: ok.filter((e) => e.row!.pitching !== null),
    noLines: entries.filter((e) => e.status === "no-lines").sort(byName),
    notFound: entries.filter((e) => e.status === "not-found"),
  };
}
