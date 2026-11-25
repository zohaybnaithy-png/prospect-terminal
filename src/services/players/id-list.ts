/**
 * Player-id lists in URLs (pure, client-safe). Shared by `/compare?ids=` and `/watchlist?ids=`:
 * players are addressed by internal UUID, and a list from a URL (or browser storage) is untrusted
 * input. Bad tokens are counted, never fatal, so a page can say what it dropped.
 */

export const PLAYER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PLAYER_UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Comma-separated tokens, trimmed, empties removed, at most `maxTokens` (caps work on hostile input). */
export function splitIdList(raw: string, maxTokens: number): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, maxTokens);
}

export interface IdListResult {
  /** Unique, valid, lower-cased ids in input order, at most `max`. */
  ids: string[];
  invalid: number;
  duplicate: number;
  /** Valid, new ids beyond `max`. */
  extra: number;
}

export function parseIdTokens(tokens: readonly unknown[], max: number): IdListResult {
  const ids: string[] = [];
  let invalid = 0,
    duplicate = 0,
    extra = 0;
  for (const t of tokens) {
    if (typeof t !== "string" || !PLAYER_UUID.test(t)) {
      invalid++;
      continue;
    }
    const id = t.toLowerCase();
    if (ids.includes(id)) duplicate++;
    else if (ids.length >= max) extra++;
    else ids.push(id);
  }
  return { ids, invalid, duplicate, extra };
}

/** "1 invalid player id was ignored." / "3 duplicate player ids were ignored." */
export const ignoredIdsNotice = (n: number, kind: "invalid" | "duplicate") =>
  `${n} ${kind} player ${n === 1 ? "id was" : "ids were"} ignored.`;
