/**
 * Watchlist (/watchlist, T-202): URL parsing, the per-browser storage helper with missing,
 * throwing and full storage, the view model over fictional multi-level fixtures, and the star /
 * table markup (server render = neutral state). No database, no real players.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WATCHLIST_MAX, parseWatchlistQuery, watchlistHref } from "../src/services/watchlist/query";
import { watchlistView } from "../src/services/watchlist/model";
import {
  UNAVAILABLE,
  WATCHLIST_STORAGE_KEY,
  browserStorage,
  decodeWatchlist,
  readWatchlist,
  resetBrowserStorageProbe,
  toggleWatchlist,
  watchlistSnapshot,
  writeWatchlist,
  type StorageLike,
} from "../src/lib/watchlist-storage";
import { WatchlistStar } from "../src/components/watchlist/star-button";
import { WatchlistTable } from "../src/components/watchlist/watchlist-table";
import type { LevelSnapshot } from "../src/services/competition/types";
import { levelDirectoryRows } from "../src/services/players/adapter";
import { IDS, trajectorySnapshot, u } from "./analytics-test-support";
import { playerId, scaleSnapshot } from "./milb-scale-support";

const A = u(31),
  B = u(32),
  C = u(33);
const ids = (n: number) => Array.from({ length: n }, (_, i) => u(5000 + i));

describe("parseWatchlistQuery / watchlistHref", () => {
  test("ids are validated, lower-cased, de-duplicated and sorted", () => {
    const q = parseWatchlistQuery({ ids: ` ${C.toUpperCase()},${A},,${C},not-a-uuid,${B}` });
    assert.deepEqual(q.ids, [A, B, C]);
    assert.deepEqual(q.notices, ["1 invalid player id was ignored.", "1 duplicate player id was ignored."]);
  });

  test(`at most ${WATCHLIST_MAX} players; the rest are left out with a notice`, () => {
    const many = ids(WATCHLIST_MAX + 2);
    const q = parseWatchlistQuery({ ids: many.join(",") });
    assert.equal(q.ids.length, WATCHLIST_MAX);
    assert.deepEqual(q.ids, many.slice(0, WATCHLIST_MAX).sort());
    assert.deepEqual(q.notices, [`A watchlist shows up to ${WATCHLIST_MAX} players; 2 more were left out.`]);
  });

  test("missing, empty and repeated (array) parameters give an empty list, no notice", () => {
    for (const p of [{}, { ids: "" }, { ids: [A, B] }]) assert.deepEqual(parseWatchlistQuery(p), { ids: [], notices: [] });
  });

  test("hostile input is bounded and never fatal", () => {
    const q = parseWatchlistQuery({ ids: `${"x,".repeat(10_000)}${A}` });
    assert.deepEqual(q.ids, [], "tokens beyond the cap are not even looked at");
    assert.match(q.notices[0], /^100 invalid player ids were ignored\.$/);
  });

  test("watchlistHref is canonical (sorted, valid, capped) and round-trips", () => {
    assert.equal(watchlistHref([]), "/watchlist");
    assert.equal(watchlistHref([C, A.toUpperCase(), "junk", A]), `/watchlist?ids=${A},${C}`);
    assert.equal(watchlistHref([C, B, A]), watchlistHref([A, B, C]), "order does not matter");
    const href = watchlistHref([C, A, B]);
    const q = parseWatchlistQuery(Object.fromEntries(new URL(href, "https://x.test").searchParams));
    assert.deepEqual([q.ids, q.notices], [[A, B, C], []]);
    assert.equal(watchlistHref(ids(WATCHLIST_MAX + 5)).split(",").length, WATCHLIST_MAX);
  });
});

// ---- storage ------------------------------------------------------------------------------------

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  writes = 0;
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.writes++;
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
const throwing: StorageLike = {
  getItem() {
    throw new Error("SecurityError: storage is disabled");
  },
  setItem() {
    throw new Error("SecurityError: storage is disabled");
  },
  removeItem() {
    throw new Error("SecurityError: storage is disabled");
  },
};

describe("watchlist storage (localStorage only, every access guarded)", () => {
  test("decode re-validates untrusted stored data", () => {
    assert.deepEqual(decodeWatchlist(null), []);
    assert.deepEqual(decodeWatchlist("{not json"), []);
    assert.deepEqual(decodeWatchlist('{"ids":[]}'), []);
    assert.deepEqual(decodeWatchlist(JSON.stringify([B, 7, "x", A.toUpperCase(), B, null])), [B, A], "starring order kept");
    assert.equal(decodeWatchlist(JSON.stringify(ids(WATCHLIST_MAX + 3))).length, WATCHLIST_MAX);
  });

  test("missing or throwing storage is 'unavailable', never an exception", () => {
    assert.equal(readWatchlist(null), UNAVAILABLE);
    assert.equal(readWatchlist(throwing), UNAVAILABLE);
    assert.equal(writeWatchlist(null, [A]), false);
    assert.equal(writeWatchlist(throwing, [A]), false);
    assert.equal(toggleWatchlist(null, A), "unavailable");
    assert.equal(toggleWatchlist(throwing, A), "unavailable");
  });

  test("toggle adds, removes, and clears the key when the list is empty", () => {
    const s = new MemoryStorage();
    assert.deepEqual(readWatchlist(s), { status: "ready", ids: [] });
    assert.equal(toggleWatchlist(s, B), "added");
    assert.equal(toggleWatchlist(s, A.toUpperCase()), "added");
    assert.deepEqual(readWatchlist(s), { status: "ready", ids: [B, A] });
    assert.equal(s.getItem(WATCHLIST_STORAGE_KEY), JSON.stringify([B, A]));
    assert.equal(toggleWatchlist(s, B), "removed");
    assert.equal(toggleWatchlist(s, A), "removed");
    assert.equal(s.map.has(WATCHLIST_STORAGE_KEY), false);
    assert.equal(toggleWatchlist(s, "not-a-uuid"), "invalid");
    assert.equal(s.writes, 3, "add, add, remove-one; the last removal clears the key; an invalid id writes nothing");
  });

  test(`a full list (${WATCHLIST_MAX}) refuses another player but still allows removal`, () => {
    const s = new MemoryStorage();
    const full = ids(WATCHLIST_MAX);
    writeWatchlist(s, full);
    assert.equal(toggleWatchlist(s, A), "full");
    assert.equal(toggleWatchlist(s, full[0]), "removed");
    assert.equal(toggleWatchlist(s, A), "added");
  });

  test("a refused write (quota) reports unavailable and leaves the stored list as it was", () => {
    const s = new MemoryStorage();
    writeWatchlist(s, [A]);
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    assert.equal(toggleWatchlist(s, B), "unavailable");
    assert.deepEqual(readWatchlist(s), { status: "ready", ids: [A] });
  });
});

describe("browser store", () => {
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    delete g.window;
    resetBrowserStorageProbe();
  });

  test("on the server (no window) there is no storage", () => {
    resetBrowserStorageProbe();
    assert.equal(browserStorage(), null);
    assert.equal(watchlistSnapshot(), UNAVAILABLE);
  });

  test("blocked site data: reading window.localStorage throws → unavailable, no crash", () => {
    resetBrowserStorageProbe();
    g.window = Object.defineProperty({}, "localStorage", {
      get() {
        throw new Error("SecurityError: The operation is insecure.");
      },
    });
    assert.equal(browserStorage(), null);
    assert.equal(watchlistSnapshot(), UNAVAILABLE);
  });

  test("storage that cannot be written (some private modes) counts as unavailable", () => {
    resetBrowserStorageProbe();
    const s = new MemoryStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    g.window = { localStorage: s };
    assert.equal(browserStorage(), null);
  });

  test("working storage: the snapshot is stable until the stored value changes", () => {
    resetBrowserStorageProbe();
    const s = new MemoryStorage();
    g.window = { localStorage: s };
    const first = watchlistSnapshot();
    assert.deepEqual(first, { status: "ready", ids: [] });
    assert.equal(watchlistSnapshot(), first, "same object (useSyncExternalStore compares identity)");
    assert.equal(toggleWatchlist(browserStorage(), A), "added");
    const second = watchlistSnapshot();
    assert.notEqual(second, first);
    assert.deepEqual(second, { status: "ready", ids: [A] });
    assert.equal(watchlistSnapshot(), second);
    assert.equal(s.map.has(`${WATCHLIST_STORAGE_KEY}.probe`), false, "the probe leaves nothing behind");
  });
});

// ---- view model ---------------------------------------------------------------------------------

const afl = trajectorySnapshot(); // October (2026-10-06 onwards)
const ROSTER_ONLY = u(950);
afl.players.push({ ...afl.players[0], id: ROSTER_ONLY, name: "Roster Only" });
// IDS.star also played at Double-A in spring (earlier than the AFL) …
const aaSpring = scaleSnapshot({ ns: 2, level: "aa", teams: 4, days: 20, seed: 2, sharedPlayers: [{ id: IDS.star, name: "Steady Star", role: "hitter" }] });
// … and IDS.improver at High-A in November (later than the AFL).
const highALate = scaleSnapshot({
  ns: 3,
  level: "high-a",
  teams: 4,
  days: 10,
  seed: 3,
  start: "2026-11-02",
  sharedPlayers: [{ id: IDS.improver, name: "Steady Improver", role: "hitter" }],
});
const LEVELS: LevelSnapshot[] = [
  { level: "aa", snapshot: aaSpring },
  { level: "high-a", snapshot: highALate },
  { level: "afl", snapshot: afl },
];
const AA_PITCHER = playerId(2, 50);
const MISSING = "00000000-0000-4000-8000-00000000dead";
const view = (list: string[]) => watchlistView(LEVELS, parseWatchlistQuery({ ids: list.join(",") }));
const rowAt = (snap: LevelSnapshot, id: string) => levelDirectoryRows(snap.snapshot, snap.level, "season").find((r) => r.id === id)!;

describe("watchlistView", () => {
  test("each player is shown at the level of their most recent game, with that level's season row", () => {
    const v = view([IDS.star, IDS.improver, IDS.decliner]);
    const by = Object.fromEntries(v.entries.map((e) => [e.id, e]));
    // Star: AA in spring, AFL in October → AFL; AA listed beside it, not merged.
    assert.equal(by[IDS.star].row!.level, "afl");
    assert.deepEqual(by[IDS.star].levels, ["aa", "afl"]);
    assert.deepEqual(by[IDS.star].row, rowAt(LEVELS[2], IDS.star), "exactly the AFL directory row (season line + Momentum)");
    assert.equal(by[IDS.star].seasonName, "Arizona Fall League 2026");
    // Improver: AFL in October, High-A in November → High-A.
    assert.equal(by[IDS.improver].row!.level, "high-a");
    assert.deepEqual(by[IDS.improver].levels, ["high-a", "afl"]);
    assert.deepEqual(by[IDS.improver].row, rowAt(LEVELS[1], IDS.improver));
    assert.equal(by[IDS.decliner].row!.level, "afl");
    assert.deepEqual(by[IDS.decliner].levels, ["afl"]);
  });

  test("statistics stay per level: the line is the latest level's alone, not a sum across levels", () => {
    const e = view([IDS.star]).entries[0];
    const aflPa = rowAt(LEVELS[2], IDS.star).batting!.plateAppearances;
    const aaPa = rowAt(LEVELS[0], IDS.star).batting!.plateAppearances;
    assert.ok(aaPa > 0);
    assert.equal(e.row!.batting!.plateAppearances, aflPa);
    assert.notEqual(e.row!.batting!.plateAppearances, aflPa + aaPa);
    assert.deepEqual(e.row!.momentum, rowAt(LEVELS[2], IDS.star).momentum, "Momentum from the same level");
  });

  test("hitters and pitchers tables, by name; a two-way player is in both", () => {
    const v = view([IDS.twoWay, IDS.pSteady, AA_PITCHER, IDS.star]);
    assert.deepEqual(new Set(v.hitters.map((e) => e.id)), new Set([IDS.star, IDS.twoWay]));
    const hitterNames = v.hitters.map((e) => e.name!);
    assert.deepEqual(hitterNames, [...hitterNames].sort((a, b) => a.localeCompare(b)));
    assert.ok(v.pitchers.some((e) => e.id === IDS.twoWay));
    assert.ok(v.pitchers.some((e) => e.id === AA_PITCHER && e.row!.level === "aa"));
    const names = v.pitchers.map((e) => e.name!);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  test("a rostered player without a game line and an unknown id are notices, not errors", () => {
    const v = view([ROSTER_ONLY, MISSING, IDS.star]);
    assert.deepEqual(v.noLines.map((e) => [e.id, e.name, e.status]), [[ROSTER_ONLY, "Roster Only", "no-lines"]]);
    assert.deepEqual(v.notFound.map((e) => [e.id, e.name, e.status]), [[MISSING, null, "not-found"]]);
    assert.deepEqual(v.hitters.map((e) => e.id), [IDS.star]);
  });

  test("empty list → empty view", () => {
    const v = view([]);
    assert.deepEqual([v.entries, v.hitters, v.pitchers, v.noLines, v.notFound], [[], [], [], [], []]);
  });
});

// ---- markup -------------------------------------------------------------------------------------

describe("markup", () => {
  test("the star renders a neutral, unpressed toggle on the server (identical for every visitor)", () => {
    const icon = renderToStaticMarkup(createElement(WatchlistStar, { playerId: A, name: "Fixture Player" }));
    assert.match(icon, /^<button type="button" class="watch-star icon" aria-pressed="false" data-state="pending">/);
    assert.match(icon, /<svg[^>]*aria-hidden="true"/);
    assert.match(icon, /<span class="sr-only">Add Fixture Player to watchlist<\/span><\/button>$/);
    const labelled = renderToStaticMarkup(createElement(WatchlistStar, { playerId: A, name: "Fixture Player", variant: "labelled" }));
    assert.match(labelled, /<span>Add<span class="sr-only"> Fixture Player<\/span> to watchlist<\/span><\/button>$/, "visible label is part of the accessible name");
  });

  test("the watchlist table: named region, a level column, sample sizes and Momentum", () => {
    const v = view([IDS.star, IDS.improver]);
    const html = renderToStaticMarkup(createElement(WatchlistTable, { role: "hitter", entries: v.hitters, momentumShort: "14D" }));
    assert.match(html, /role="region" aria-label="Watchlist hitters: season batting line and Momentum at each player&#x27;s latest level"/);
    for (const head of ["Watch", "Player", "Lvl", "PA", "OPS", "Mom. 14D", "Conf."]) assert.match(html, new RegExp(`<th scope="col"[^>]*>${head}</th>`));
    assert.match(html, /Remove Steady Star from watchlist|Add Steady Star to watchlist/);
    assert.match(html, new RegExp(`href="/players/${IDS.improver}\\?level=high-a"`), "profile opens at the row's level");
    assert.match(html, /\(also played at Double-A\)/);
  });
});
