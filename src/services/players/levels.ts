/**
 * Level registry for the UI (client-safe). Derived from the domain level definitions in
 * `src/domain/levels.ts`, which the MiLB ingestion also uses, so labels and ladder order have one
 * source of truth. Whether a level has data is decided at runtime from what the database holds —
 * never assumed.
 */
import {
  COMPETITION_LEVEL_LABELS,
  MILB_LEVELS,
  MILB_LEVEL_IDS,
  type CompetitionLevelId,
} from "@/domain/levels";

export type LevelId = CompetitionLevelId;

export interface LevelDefinition {
  id: LevelId;
  label: string;
  short: string;
  kind: "affiliated" | "fall-league";
}

/** Highest affiliated level first; the AFL is a fall assignment, not a rung above Triple-A. */
export const LEVELS: LevelDefinition[] = [
  ...[...MILB_LEVEL_IDS]
    .sort((a, b) => MILB_LEVELS[a].rank - MILB_LEVELS[b].rank)
    .map((id) => ({
      id,
      label: MILB_LEVELS[id].label,
      short: MILB_LEVELS[id].shortLabel,
      kind: "affiliated" as const,
    })),
  {
    id: "afl",
    label: COMPETITION_LEVEL_LABELS.afl,
    short: "AFL",
    kind: "fall-league",
  },
];

export const LEVEL_IDS: LevelId[] = LEVELS.map((l) => l.id);

export const levelById = (id: LevelId) => LEVELS.find((l) => l.id === id)!;

export const isLevelId = (v: string): v is LevelId =>
  LEVELS.some((l) => l.id === v);

/** Ladder position (0 = Triple-A … 4 = AFL), for stable sorting. */
export const levelOrder = (id: LevelId) => LEVEL_IDS.indexOf(id);
