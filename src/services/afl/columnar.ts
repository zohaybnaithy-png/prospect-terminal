/**
 * Compact transfer format for per-game stat lines.
 *
 * Reading a full MiLB level as ordinary rows sends three 36-character UUIDs plus per-column
 * framing for every line (~40k batting lines per level), which made the site's level load
 * network-bound (about 4-10 MB per level). The loader instead asks PostgreSQL for ONE row of
 * parallel arrays: dictionaries of the distinct player/game/team UUIDs, integer indexes into them,
 * and one integer array per statistic. This module decodes that row back into exactly the line
 * objects the row query produced. It is pure and validates everything, because a malformed
 * payload must fail the level load rather than yield wrong statistics.
 */

export class ColumnarDecodeError extends Error {}

type DecodedLine<K extends string> = { playerId: string; gameId: string; teamId: string } & Record<
  K,
  number | null
>;

const isIndexIn = (dict: string[]) => (i: unknown) =>
  Number.isInteger(i) && (i as number) >= 0 && (i as number) < dict.length;

/**
 * Decodes one columnar payload. `columns` are the statistic keys, in any order; `required` are
 * the NOT NULL ones. Throws ColumnarDecodeError when arrays are missing, have different lengths,
 * hold an out-of-range index, a statistic is neither an integer nor null, or a required statistic
 * is null.
 */
export function decodeColumnarLines<K extends string>(
  payload: Record<string, unknown> | undefined,
  columns: readonly K[],
  required: readonly K[] = [],
): DecodedLine<K>[] {
  if (!payload) throw new ColumnarDecodeError("missing payload");
  const arr = (key: string) => {
    const v = payload[key];
    if (!Array.isArray(v)) throw new ColumnarDecodeError(`column ${key} is not an array`);
    return v as unknown[];
  };
  const players = arr("players");
  const games = arr("games");
  const teams = arr("teams");
  for (const [name, dict] of [
    ["players", players],
    ["games", games],
    ["teams", teams],
  ] as const)
    if (!dict.every((id) => typeof id === "string" && id.length > 0))
      throw new ColumnarDecodeError(`dictionary ${name} holds a non-string id`);
  const p = arr("p");
  const g = arr("g");
  const t = arr("t");
  const n = p.length;
  const stats = columns.map((c) => [c, arr(c)] as const);
  for (const [name, a] of [["g", g], ["t", t], ...stats] as const)
    if (a.length !== n) throw new ColumnarDecodeError(`column ${name} has ${a.length} values, expected ${n}`);
  if (!p.every(isIndexIn(players as string[])) || !g.every(isIndexIn(games as string[])) || !t.every(isIndexIn(teams as string[])))
    throw new ColumnarDecodeError("index out of range");
  for (const [name, a] of stats)
    if (!a.every((v) => v === null || Number.isInteger(v)))
      throw new ColumnarDecodeError(`column ${name} holds a non-integer value`);
  for (const [name, a] of stats)
    if (required.includes(name) && a.includes(null))
      throw new ColumnarDecodeError(`required column ${name} holds a null`);

  const out: DecodedLine<K>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const line = {
      playerId: players[p[i] as number],
      gameId: games[g[i] as number],
      teamId: teams[t[i] as number],
    } as DecodedLine<K>;
    for (const [name, a] of stats) (line as Record<string, unknown>)[name] = a[i];
    out[i] = line;
  }
  return out;
}
