/**
 * Player comparison URL state (pure, client-safe): `/compare?level=<id>&ids=<uuid,…>&role=<…>`.
 *
 * A comparison is always at ONE level: statistics, percentiles and Momentum are per level and are
 * never blended across levels. Bad input never errors or 404s; it is dropped with a notice the
 * page shows, so a shared link with one stale id still compares the rest.
 */
import type { Role } from "@/analytics/config";
import { isLevelId, type LevelId } from "@/services/players/levels";
import { PLAYER_UUID_IN_TEXT, ignoredIdsNotice, parseIdTokens, splitIdList } from "@/services/players/id-list";

export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

type Params = Record<string, string | string[] | undefined>;
/** Caps the work done on a hostile `ids` value before validation. */
const MAX_TOKENS = 32;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
/**
 * `ids` as one comma list, also when repeated: the directory's no-JavaScript compare form submits
 * one `ids` field per checked row (`ids=a&ids=b`). Other parameters keep taking a single value.
 */
const idList = (v: string | string[] | undefined) => (Array.isArray(v) ? v.slice(0, MAX_TOKENS).join(",") : one(v));

export interface CompareQuery {
  /** A level from the registry, or null when missing / unknown (`levelProblem` says which). */
  level: LevelId | null;
  levelProblem: "missing" | "unknown" | null;
  role: Role;
  /** Unique, valid ids in URL order, at most COMPARE_MAX. */
  ids: string[];
  /** Input problems to show the visitor (never fatal). */
  notices: string[];
}

/**
 * Parses the comparison URL. `add` (the page's add-a-player form) may hold a pasted profile link
 * or a bare player id; its first UUID is appended to `ids`.
 */
export function parseCompareQuery(params: Params): CompareQuery {
  const notices: string[] = [];
  const requested = one(params.level).trim();
  const level = isLevelId(requested) ? requested : null;
  const levelProblem = level ? null : requested ? "unknown" : "missing";
  if (levelProblem === "unknown") notices.push("That level is not recognised — choose a level below.");
  const role: Role = one(params.role) === "pitchers" ? "pitcher" : "hitter";

  const tokens = splitIdList(idList(params.ids), MAX_TOKENS);
  const addText = one(params.add).trim();
  if (addText) {
    const found = addText.match(PLAYER_UUID_IN_TEXT)?.[0];
    if (found) tokens.push(found);
    else notices.push("Couldn't find a player id in what was entered — paste a player profile link.");
  }
  const { ids, invalid, duplicate, extra } = parseIdTokens(tokens, COMPARE_MAX);
  if (invalid) notices.push(ignoredIdsNotice(invalid, "invalid"));
  if (duplicate) notices.push(ignoredIdsNotice(duplicate, "duplicate"));
  if (extra) notices.push(`Up to ${COMPARE_MAX} players can be compared; ${extra} more ${extra === 1 ? "was" : "were"} left out.`);
  return { level, levelProblem, role, ids, notices };
}

/** Canonical comparison URL; defaults (hitters) are omitted. */
export function compareHref({ level, ids, role = "hitter" }: { level: LevelId | null; ids: string[]; role?: Role }) {
  const q = new URLSearchParams();
  if (level) q.set("level", level);
  if (ids.length) q.set("ids", ids.join(","));
  if (role === "pitcher") q.set("role", "pitchers");
  // Commas are safe in a query value; keep them readable instead of %2C.
  const s = q.toString().replace(/%2C/gi, ",");
  return s ? `/compare?${s}` : "/compare";
}

/** Players already chosen, from a page's own `ids` parameter (e.g. a profile opened from a comparison). */
export function existingCompareIds(params: Params): string[] {
  return parseCompareQuery({ ids: idList(params.ids) }).ids;
}

/**
 * The profile's "Add to compare" link: this player at the profile's level, appended to an
 * existing `ids` list when the profile URL carries one. `full` when no room is left.
 */
export function addToCompareLink(
  playerId: string,
  level: LevelId,
  role: Role,
  existing: string[] = [],
): { href: string; included: boolean; full: boolean } {
  const id = playerId.toLowerCase();
  const included = existing.includes(id);
  const full = !included && existing.length >= COMPARE_MAX;
  const ids = included || full ? existing : [...existing, id];
  return { href: compareHref({ level, ids, role }), included, full };
}
