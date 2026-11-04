/**
 * Level registry for the player directory. Level-agnostic UI reads this; whether a level has
 * data is decided at runtime from the rows a source actually provides — never assumed.
 *
 * AFL rows come from the current AFL read layer. Affiliated levels (AAA → Single-A) are listed so
 * the interface and URL contract are stable before MiLB ingestion lands; they stay disabled until
 * a source produces rows for them.
 */
export type LevelId = "aaa" | "aa" | "high-a" | "single-a" | "afl";

export interface LevelDefinition {
  id: LevelId;
  label: string;
  short: string;
  kind: "affiliated" | "fall-league";
}

/** Highest affiliated level first; the AFL is a fall assignment, not a rung above Triple-A. */
export const LEVELS: LevelDefinition[] = [
  { id: "aaa", label: "Triple-A", short: "AAA", kind: "affiliated" },
  { id: "aa", label: "Double-A", short: "AA", kind: "affiliated" },
  { id: "high-a", label: "High-A", short: "A+", kind: "affiliated" },
  { id: "single-a", label: "Single-A", short: "A", kind: "affiliated" },
  {
    id: "afl",
    label: "Arizona Fall League",
    short: "AFL",
    kind: "fall-league",
  },
];

export const levelById = (id: LevelId) => LEVELS.find((l) => l.id === id)!;

export const isLevelId = (v: string): v is LevelId =>
  LEVELS.some((l) => l.id === v);
