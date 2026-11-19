/**
 * Precomputed view models (docs/VERCEL.md, *Precomputed view models*): file format, pure.
 *
 * A view model is a plain-data value computed from one level snapshot by the page functions
 * (directory rows, Trending, Trends lists…). Values alone are not enough for an identical page:
 * React's RSC serializer writes an object it has already written as a back-reference, so the
 * payload depends on which objects are SHARED. A live directory row points at the snapshot's own
 * team object, and many rows share it. The encoding below therefore preserves the reference graph
 * exactly, and the build refuses (fails) whenever it cannot:
 *
 * - an object or array that belongs to the snapshot (any depth) is written as a pointer
 *   `{"$p": [path…]}` and decodes to the SAME object of the loaded snapshot;
 * - an object reachable from two different parts of the level (e.g. the Momentum `sample` that the
 *   Season and 14-day directory rows share) is stored once in the level's shared pool and written
 *   as `{"$s": id}`; the pool is decoded once per loaded level, so both parts get one object;
 * - any other object or array reachable more than once in a part is written once as
 *   `{"$d": id, "v": …}` and afterwards as `{"$r": id}`;
 * - objects that already use the reserved keys `$p`, `$d`, `$r` or `$s`, cycles, and anything
 *   packing cannot carry exactly (snapshot-format.ts) make the build fail (`ViewsEncodeError`).
 *
 * The output then goes through `packValue` (tables for same-shaped rows) and gzip.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AflSnapshot } from "@/services/afl/types";
import { LEVEL_IDS } from "@/services/players/levels";

export const VIEWS_FORMAT = "prospect-terminal/level-views";
export const VIEWS_FORMAT_VERSION = 1;
/** Subdirectory of the snapshot directory (removed with it by every new export). */
export const VIEWS_DIR = "views";
export const VIEWS_MANIFEST_FILE = "manifest.json";

export class ViewsEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewsEncodeError";
  }
}
export class ViewsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewsFormatError";
  }
}

const RESERVED = ["$p", "$d", "$r", "$s"] as const;
type Key = string | number;
type Plain = Record<string, unknown>;

const isObject = (v: unknown): v is object => v !== null && typeof v === "object";

/** Every object and array inside a snapshot, with its path from the root. */
export function snapshotPaths(s: AflSnapshot): Map<object, Key[]> {
  const paths = new Map<object, Key[]>();
  const walk = (v: unknown, path: Key[]) => {
    if (!isObject(v) || paths.has(v)) return;
    paths.set(v, path);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else for (const k of Object.keys(v)) walk((v as Plain)[k], [...path, k]);
  };
  walk(s, []);
  return paths;
}

export interface EncodedLevel {
  /** Objects reached from more than one part, each stored once (`{"$s": id}` elsewhere). */
  shared: unknown[];
  parts: [string, unknown][];
}

/**
 * Encodes every part of a level together, so that sharing ACROSS parts is preserved too: an object
 * reached from two parts goes to the level's shared pool and decodes to one object for both.
 * Sharing within one part uses `$d`/`$r`; snapshot objects are pointers. Cycles and reserved keys
 * fail with `ViewsEncodeError`.
 */
export function encodeLevelGraph(parts: [string, unknown][], paths: Map<object, Key[]>): EncodedLevel {
  const firstPart = new Map<object, number>();
  const cross = new Set<object>();
  const counts: Map<object, number>[] = parts.map(() => new Map());
  parts.forEach(([name, value], pi) => {
    const count = counts[pi];
    const onStack = new Set<object>();
    const scan = (v: unknown, at: string) => {
      if (!isObject(v) || paths.has(v)) return;
      if (onStack.has(v)) throw new ViewsEncodeError(`${name}: view model contains a cycle at ${at}`);
      const n = (count.get(v) ?? 0) + 1;
      count.set(v, n);
      if (n > 1) return;
      const first = firstPart.get(v);
      if (first === undefined) firstPart.set(v, pi);
      else if (first !== pi) cross.add(v);
      if (!Array.isArray(v))
        for (const k of RESERVED) if (Object.hasOwn(v, k)) throw new ViewsEncodeError(`${name}: uses the reserved key ${k} at ${at}`);
      onStack.add(v);
      if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${at}[${i}]`));
      else for (const k of Object.keys(v)) scan((v as Plain)[k], `${at}.${k}`);
      onStack.delete(v);
    };
    scan(value, "$");
  });
  const sharedIds = new Map<object, number>();
  const shared: unknown[] = [];
  const body = (v: object, enc: (x: unknown) => unknown): unknown => {
    if (Array.isArray(v)) return v.map(enc);
    const out: Plain = {};
    for (const k of Object.keys(v)) out[k] = enc((v as Plain)[k]);
    return out;
  };
  // Pool entries: everything below a cross-part object is reached from the same parts, so it is
  // itself in the pool (or a snapshot object, or a primitive).
  const poolRef = (v: object): unknown => {
    let id = sharedIds.get(v);
    if (id === undefined) {
      id = shared.length;
      sharedIds.set(v, id);
      shared.push(null);
      shared[id] = body(v, encShared);
    }
    return { $s: id };
  };
  const encShared = (v: unknown): unknown => {
    if (!isObject(v)) return v;
    const p = paths.get(v);
    if (p) return { $p: p };
    return poolRef(v);
  };
  const encoded = parts.map(([name, value], pi): [string, unknown] => {
    const count = counts[pi];
    const ids = new Map<object, number>();
    const enc = (v: unknown): unknown => {
      if (!isObject(v)) return v;
      const p = paths.get(v);
      if (p) return { $p: p };
      if (cross.has(v)) return poolRef(v);
      if (count.get(v)! > 1) {
        const id = ids.get(v);
        if (id !== undefined) return { $r: id };
        const fresh = ids.size;
        ids.set(v, fresh);
        return { $d: fresh, v: body(v, enc) };
      }
      return body(v, enc);
    };
    return [name, enc(value)];
  });
  return { shared, parts: encoded };
}

/** A pointer `{"$p": path}` resolved in the loaded snapshot. */
function resolvePointer(o: Plain, s: AflSnapshot): object {
  if (Object.keys(o).length !== 1 || !Array.isArray(o.$p)) throw new ViewsFormatError("malformed pointer");
  let t: unknown = s;
  for (const k of o.$p) {
    if (!isObject(t) || (typeof k !== "string" && typeof k !== "number") || !Object.hasOwn(t, k))
      throw new ViewsFormatError("pointer does not resolve in the snapshot");
    t = (t as Plain)[k as string];
  }
  if (!isObject(t)) throw new ViewsFormatError("pointer does not resolve to an object");
  return t;
}

const sharedId = (o: Plain) => {
  if (Object.keys(o).length !== 1 || !Number.isInteger(o.$s) || (o.$s as number) < 0) throw new ViewsFormatError("malformed shared reference");
  return o.$s as number;
};

/**
 * The decoded shared pool of a level: `get(id)` builds entries on first use (an entry may refer
 * to a later one) and always returns the same object for an id.
 */
export function decodeShared(raw: unknown, s: AflSnapshot): { get: (id: number) => object } {
  if (!Array.isArray(raw)) throw new ViewsFormatError("malformed shared pool");
  const built = new Map<number, object>();
  const get = (id: number): object => {
    const hit = built.get(id);
    if (hit) return hit;
    if (id >= raw.length) throw new ViewsFormatError("reference to an unknown shared object");
    const b = raw[id];
    if (!isObject(b)) throw new ViewsFormatError("malformed shared object");
    const container: unknown[] | Plain = Array.isArray(b) ? [] : {};
    built.set(id, container);
    const dec = (v: unknown): unknown => {
      if (!isObject(v)) return v;
      if (Array.isArray(v)) throw new ViewsFormatError("malformed shared object");
      const o = v as Plain;
      if ("$p" in o) return resolvePointer(o, s);
      if ("$s" in o) return get(sharedId(o));
      throw new ViewsFormatError("malformed shared object");
    };
    if (Array.isArray(b)) for (const x of b) (container as unknown[]).push(dec(x));
    else for (const k of Object.keys(b)) (container as Plain)[k] = dec((b as Plain)[k]);
    return container;
  };
  return { get };
}

/**
 * Inverse of one part of `encodeLevelGraph` against the loaded snapshot and the level's shared
 * pool (`shared` is called only when the part refers to it). Throws `ViewsFormatError` on
 * anything unexpected.
 */
export function decodeGraph(value: unknown, s: AflSnapshot, shared: () => { get: (id: number) => object } = () => {
  throw new ViewsFormatError("part refers to a shared pool that is not available");
}): unknown {
  // Definitions are collected first: packing can reorder the keys of table rows, so a `$r` may be
  // met before its `$d`.
  const raw = new Map<number, unknown>();
  const collect = (v: unknown) => {
    if (!isObject(v)) return;
    if (Array.isArray(v)) return v.forEach(collect);
    const o = v as Plain;
    if ("$d" in o) {
      if (Object.keys(o).length !== 2 || !("v" in o) || !Number.isInteger(o.$d) || raw.has(o.$d as number))
        throw new ViewsFormatError("malformed definition");
      raw.set(o.$d as number, o.v);
      return collect(o.v);
    }
    if ("$p" in o || "$r" in o || "$s" in o) return;
    for (const k of Object.keys(o)) collect(o[k]);
  };
  collect(value);
  const built = new Map<number, unknown>();
  const define = (id: number): unknown => {
    if (built.has(id)) return built.get(id);
    if (!raw.has(id)) throw new ViewsFormatError("reference to an unknown definition");
    const body = raw.get(id);
    if (!isObject(body)) throw new ViewsFormatError("malformed definition body");
    const container: unknown[] | Plain = Array.isArray(body) ? [] : {};
    built.set(id, container);
    if (Array.isArray(body)) for (const x of body) (container as unknown[]).push(dec(x));
    else for (const k of Object.keys(body)) (container as Plain)[k] = dec((body as Plain)[k]);
    return container;
  };
  let pool: { get: (id: number) => object } | undefined;
  const dec = (v: unknown): unknown => {
    if (!isObject(v)) return v;
    if (Array.isArray(v)) return v.map(dec);
    const o = v as Plain;
    if ("$p" in o) return resolvePointer(o, s);
    if ("$s" in o) return (pool ??= shared()).get(sharedId(o));
    if ("$r" in o) {
      if (Object.keys(o).length !== 1 || !Number.isInteger(o.$r)) throw new ViewsFormatError("malformed reference");
      return define(o.$r as number);
    }
    if ("$d" in o) return define(o.$d as number);
    const out: Plain = {};
    for (const k of Object.keys(o)) out[k] = dec(o[k]);
    return out;
  };
  return dec(value);
}

// ---- manifest --------------------------------------------------------------------------------

const partEntry = z.object({
  file: z.string().regex(/^[a-z0-9_.-]+\.json\.gz$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});
export type ViewsPartEntry = z.infer<typeof partEntry>;

/** Inputs whose results are implementation-defined in JavaScript (`Math.tanh` is used by Momentum). */
export const MATH_PROBE_INPUTS = [-3.7, -1.25, -0.5, -1e-9, 0.1, 0.3333333333333333, 0.75, 1, 2.5, 7] as const;
export const mathProbes = () => MATH_PROBE_INPUTS.map((x) => [Math.tanh(x), Math.sqrt(Math.abs(x))]);

export const viewsManifestSchema = z
  .object({
    format: z.literal(VIEWS_FORMAT),
    formatVersion: z.literal(VIEWS_FORMAT_VERSION),
    /** The data snapshot these views were computed from (snapshot manifest `snapshotId`). */
    snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
    /** Hash of the source tree that computed them (views-fingerprint.ts). */
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    node: z.string().min(1),
    v8: z.string().min(1),
    mathProbes: z.array(z.array(z.number())),
    createdAt: z.iso.datetime(),
    levels: z.record(z.string(), z.record(z.string(), partEntry)),
  })
  .strict();
export type ViewsManifest = z.infer<typeof viewsManifestSchema>;

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** File name of a part ("directory-rows|aa|season" → "directory-rows.aa.season.json.gz"). */
export const partFileName = (part: string) => `${part.replace(/\|/g, ".")}.json.gz`;

/** `major.minor` of a V8 version string. */
export const v8MajorMinor = (v: string) => v.split(".").slice(0, 2).join(".");

export type ViewsCompatibility = { ok: true } | { ok: false; reason: "v8-mismatch" | "math-mismatch" };

/** Whether this runtime would compute exactly what the build computed. */
export function runtimeCompatible(m: Pick<ViewsManifest, "v8" | "mathProbes">, v8 = process.versions.v8, probes = mathProbes()): ViewsCompatibility {
  if (v8MajorMinor(m.v8) !== v8MajorMinor(v8)) return { ok: false, reason: "v8-mismatch" };
  const same =
    m.mathProbes.length === probes.length &&
    m.mathProbes.every((row, i) => row.length === probes[i].length && row.every((x, j) => Object.is(x, probes[i][j])));
  return same ? { ok: true } : { ok: false, reason: "math-mismatch" };
}

/** Levels listed in a views manifest must be site levels. */
export function validLevelKeys(m: ViewsManifest) {
  return Object.keys(m.levels).every((l) => (LEVEL_IDS as readonly string[]).includes(l));
}
