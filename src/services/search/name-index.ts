/**
 * Header typeahead (T-205): a compact per-level player name index, the matcher the browser runs
 * over it, and the short-key resolution the server does when a suggestion is picked. Pure and
 * client-safe (no server imports).
 *
 * Size: a full 36-character UUID per player is most of the bytes and compresses badly (random),
 * so the largest level (~2,000 players) would be ~55 kB gzipped. The index instead carries the
 * shortest hex prefix of each UUID that is unique within that level (never shorter than
 * `KEY_MIN_LENGTH`), and picking a suggestion opens `/search/player`, which resolves the key against
 * the same level and redirects to the canonical profile URL. A key from an index of an older
 * deployment that no longer resolves falls back to the directory search for the name.
 */
import type { LevelId } from "@/services/players/levels";

export const NAME_INDEX_VERSION = 1;
/** 10 hex digits = 40 bits: a collision among a level's players is already unlikely; longer when needed. */
export const KEY_MIN_LENGTH = 10;
export const SUGGESTION_LIMIT = 8;
export const QUERY_MIN_LENGTH = 2;

/** `[key, name, position, team index or -1]` */
export type NameIndexEntry = [key: string, name: string, position: string, team: number];

export interface NameIndex {
  v: typeof NAME_INDEX_VERSION;
  level: LevelId;
  /** `[team abbreviation, organization abbreviation or ""]`, referenced by index from `players`. */
  teams: [team: string, org: string][];
  /** Sorted by name. */
  players: NameIndexEntry[];
}

export interface NameIndexSource {
  id: string;
  name: string;
  position: string;
  team: { abbreviation: string } | null;
  organization: { abbreviation: string } | null;
}

const hex = (id: string) => id.replace(/-/g, "").toLowerCase();

/**
 * Shortest prefix length (≥ KEY_MIN_LENGTH) at which every id's hex form is unique. Sorting puts
 * the closest pair next to each other, so the longest common prefix between neighbours decides it.
 */
export function uniqueKeyLength(ids: string[]): number {
  const sorted = [...new Set(ids.map(hex))].sort();
  let longest = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    let n = 0;
    while (n < a.length && a[n] === b[n]) n++;
    if (n > longest) longest = n;
  }
  return Math.min(32, Math.max(KEY_MIN_LENGTH, longest + 1));
}

export function buildNameIndex(rows: NameIndexSource[], level: LevelId): NameIndex {
  const length = uniqueKeyLength(rows.map((r) => r.id));
  const teams: [string, string][] = [];
  const teamIndex = new Map<string, number>();
  const players: NameIndexEntry[] = [...rows]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((r) => {
      let t = -1;
      if (r.team) {
        const k = `${r.team.abbreviation}|${r.organization?.abbreviation ?? ""}`;
        t = teamIndex.get(k) ?? -1;
        if (t < 0) {
          t = teams.push([r.team.abbreviation, r.organization?.abbreviation ?? ""]) - 1;
          teamIndex.set(k, t);
        }
      }
      return [hex(r.id).slice(0, length), r.name, r.position, t];
    });
  return { v: NAME_INDEX_VERSION, level, teams, players };
}

export const isNameKey = (key: string) => /^[0-9a-f]{10,32}$/.test(key);

/** The one id in `ids` whose hex form starts with `key`, or null (malformed, no match, or ambiguous). */
export function resolveNameKey(ids: Iterable<string>, key: string): string | null {
  if (!isNameKey(key)) return null;
  let found: string | null = null;
  for (const id of ids)
    if (hex(id).startsWith(key)) {
      if (found) return null;
      found = id;
    }
  return found;
}

/** Lower-case, accents removed ("José Ramírez" → "jose ramirez"), whitespace collapsed. */
export const foldName = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export interface Suggestion {
  key: string;
  name: string;
  position: string;
  team: string | null;
  org: string | null;
  level: LevelId;
}

/**
 * Suggestions for `query` across the given indexes: names starting with the query first, then a
 * later word starting with it, then any other substring match; ties by name, then ladder order of
 * the indexes as given. Folded names are computed once per index (`foldedNames`).
 */
export function suggest(indexes: NameIndex[], query: string, limit = SUGGESTION_LIMIT): Suggestion[] {
  const q = foldName(query);
  if (q.length < QUERY_MIN_LENGTH) return [];
  const hits: { rank: number; order: number; s: Suggestion }[] = [];
  indexes.forEach((index, order) => {
    const folded = foldedNames(index);
    index.players.forEach(([key, name, position, t], i) => {
      const f = folded[i];
      const at = f.indexOf(q);
      if (at < 0) return;
      const rank = at === 0 ? 0 : f[at - 1] === " " || f[at - 1] === "-" || f[at - 1] === "'" ? 1 : 2;
      const team = t >= 0 ? index.teams[t] : null;
      hits.push({ rank, order, s: { key, name, position, team: team?.[0] ?? null, org: team?.[1] || null, level: index.level } });
    });
  });
  return hits
    .sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name) || a.order - b.order)
    .slice(0, limit)
    .map((h) => h.s);
}

const folds = new WeakMap<NameIndex, string[]>();
function foldedNames(index: NameIndex) {
  let f = folds.get(index);
  if (!f) folds.set(index, (f = index.players.map((p) => foldName(p[1]))));
  return f;
}

/** Where a picked suggestion goes: resolved by the server, falling back to the directory search. */
export const suggestionHref = (s: Pick<Suggestion, "key" | "level" | "name">) =>
  `/search/player?${new URLSearchParams({ level: s.level, id: s.key, q: s.name })}`;

/** Shape check for an index fetched by the browser (never trust a response blindly). */
export function isNameIndex(v: unknown, level: LevelId): v is NameIndex {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<NameIndex>;
  return (
    o.v === NAME_INDEX_VERSION &&
    o.level === level &&
    Array.isArray(o.teams) &&
    Array.isArray(o.players) &&
    o.players.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 4 &&
        typeof p[0] === "string" &&
        typeof p[1] === "string" &&
        typeof p[2] === "string" &&
        Number.isInteger(p[3]) &&
        p[3] >= -1 &&
        p[3] < o.teams!.length,
    )
  );
}
