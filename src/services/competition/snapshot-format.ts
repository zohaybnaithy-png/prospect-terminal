/**
 * Serialized form of a level snapshot (`AflSnapshot`) for build-time data snapshots
 * (docs/VERCEL.md, *Build-time data snapshot*). Pure, so it is unit-tested without files.
 *
 * A level snapshot is plain JSON data (strings, finite numbers, booleans, null, arrays, objects),
 * but it holds ~40k stat-line objects per MiLB level that all repeat the same keys. `packValue`
 * writes every array of same-shaped objects as a table: the keys once, then one array of values
 * per object. That roughly halves the JSON the server has to parse at start. `unpackValue` turns
 * it back into exactly the objects that were packed.
 *
 * Exactness is enforced, not assumed:
 * - packing refuses anything JSON cannot carry exactly: NaN/Infinity (JSON writes them as null),
 *   bigint, Date, Map, Set, functions, class instances, `undefined` inside arrays, and objects
 *   that use the reserved table key;
 * - an object property whose value is `undefined` is dropped (JSON has no undefined). Readers use
 *   property access, for which a missing and an undefined property are the same;
 *   `snapshotsEqual` compares under exactly that rule;
 * - unpacking validates every table (key list, row arity) and the snapshot's top-level shape;
 * - the export script round-trips every level and compares it with `snapshotsEqual` before it
 *   writes anything (scripts/export-snapshot.ts).
 */
import { isDeepStrictEqual } from "node:util";
import type { AflSnapshot } from "@/services/afl/types";

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

/** Reserved key marking a packed table. Source data may never use it. */
const TABLE = "$t";
const ROWS = "r";

type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Own keys whose value is not undefined, in insertion order. */
const definedKeys = (o: Plain) => Object.keys(o).filter((k) => o[k] !== undefined);

function sameKeys(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((k) => s.has(k));
}

export function packValue(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SnapshotFormatError(`${path}: non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (v === undefined) throw new SnapshotFormatError(`${path}[${i}]: undefined array element`);
    });
    if (value.length >= 2 && value.every(isPlainObject)) {
      const keys = definedKeys(value[0] as Plain);
      if (value.every((o) => sameKeys(keys, definedKeys(o as Plain)))) {
        if (keys.includes(TABLE)) throw new SnapshotFormatError(`${path}: reserved key ${TABLE}`);
        return {
          [TABLE]: keys,
          [ROWS]: value.map((o, i) => keys.map((k) => packValue((o as Plain)[k], `${path}[${i}].${k}`))),
        };
      }
    }
    return value.map((v, i) => packValue(v, `${path}[${i}]`));
  }
  if (isPlainObject(value)) {
    if (TABLE in value) throw new SnapshotFormatError(`${path}: reserved key ${TABLE}`);
    const out: Plain = {};
    for (const k of definedKeys(value)) out[k] = packValue(value[k], `${path}.${k}`);
    return out;
  }
  throw new SnapshotFormatError(`${path}: unsupported ${value === undefined ? "undefined" : typeof value === "object" ? (value as object).constructor?.name ?? "object" : typeof value} value`);
}

export function unpackValue(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SnapshotFormatError(`${path}: non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => unpackValue(v, `${path}[${i}]`));
  if (isPlainObject(value)) {
    if (TABLE in value) {
      const keys = value[TABLE];
      const rows = value[ROWS];
      if (Object.keys(value).length !== 2 || !Array.isArray(keys) || !Array.isArray(rows))
        throw new SnapshotFormatError(`${path}: malformed table`);
      if (!keys.every((k) => typeof k === "string") || new Set(keys).size !== keys.length)
        throw new SnapshotFormatError(`${path}: malformed table keys`);
      return rows.map((row, i) => {
        if (!Array.isArray(row) || row.length !== keys.length)
          throw new SnapshotFormatError(`${path}[${i}]: row has the wrong number of values`);
        const o: Plain = {};
        keys.forEach((k: string, j) => (o[k] = unpackValue(row[j], `${path}[${i}].${k}`)));
        return o;
      });
    }
    const out: Plain = {};
    for (const k of Object.keys(value)) out[k] = unpackValue(value[k], `${path}.${k}`);
    return out;
  }
  throw new SnapshotFormatError(`${path}: unsupported value`);
}

/** Recursively drops properties whose value is undefined (the only normalization packing does). */
function withoutUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutUndefined);
  if (isPlainObject(v)) {
    const out: Plain = {};
    for (const k of definedKeys(v)) out[k] = withoutUndefined(v[k]);
    return out;
  }
  return v;
}

/** Deep equality of two snapshots, treating an undefined property as absent. */
export const snapshotsEqual = (a: unknown, b: unknown) => isDeepStrictEqual(withoutUndefined(a), withoutUndefined(b));

const ARRAYS = ["teams", "organizations", "players", "games", "rosterStints", "batting", "pitching"] as const;

/** Top-level shape check after unpacking (the file's hash already proved it is the exported file). */
export function assertSnapshotShape(v: unknown, expectedYear: number): asserts v is AflSnapshot {
  if (!isPlainObject(v)) throw new SnapshotFormatError("snapshot is not an object");
  const league = v.league as Plain | undefined;
  const season = v.season as Plain | undefined;
  if (!isPlainObject(league) || typeof league.id !== "string" || typeof league.name !== "string")
    throw new SnapshotFormatError("snapshot.league is malformed");
  if (!isPlainObject(season) || typeof season.id !== "string" || typeof season.name !== "string" || typeof season.year !== "number")
    throw new SnapshotFormatError("snapshot.season is malformed");
  if (season.year !== expectedYear)
    throw new SnapshotFormatError(`snapshot is for season ${season.year}, expected ${expectedYear}`);
  for (const key of ARRAYS) {
    const a = v[key];
    if (!Array.isArray(a) || !a.every(isPlainObject)) throw new SnapshotFormatError(`snapshot.${key} is malformed`);
  }
  if (v.lastIngestedAt !== null && typeof v.lastIngestedAt !== "string")
    throw new SnapshotFormatError("snapshot.lastIngestedAt is malformed");
}

export const packSnapshot = (snapshot: AflSnapshot) => packValue(snapshot);

export function unpackSnapshot(packed: unknown, expectedYear: number): AflSnapshot {
  const v = unpackValue(packed);
  assertSnapshotShape(v, expectedYear);
  return v;
}
