import { z } from "zod";
import {
  MILB_LEVEL_IDS,
  MILB_LEVELS,
  type MilbLevelId,
} from "@/domain/levels";

/** Game types ingested by default: regular season only (postseason opt-in via gameTypes). */
export const DEFAULT_MILB_GAME_TYPES = ["R"] as const;
/** gameType codes the adapter accepts: regular season plus MiLB postseason rounds. */
export const MILB_GAME_TYPES = ["R", "F", "D", "L", "W"] as const;
export type MilbGameType = (typeof MILB_GAME_TYPES)[number];

export interface MilbOptions {
  season: number;
  levels: MilbLevelId[];
  /** Restrict rosters/schedule to one discovered league (teams are still discovered level-wide). */
  league?: number;
  /** Restrict rosters/schedule to one discovered team. */
  team?: number;
  from?: string;
  to?: string;
  /** all = structure + games; structure = teams/orgs/rosters/people; games = schedule/boxscores. */
  mode?: "all" | "structure" | "games";
  rosterType?: "fullSeason" | "active";
  gameTypes?: MilbGameType[];
  /** Source game IDs already stored final + complete; their boxscores are not re-fetched … */
  knownComplete?: number[];
  /** … unless their official date is within this many days of the capture date (default 3). */
  refetchWindowDays?: number;
  concurrency?: number;
  baseUrl?: string;
  recordDir?: string;
}

export function validateMilbOptions(options: MilbOptions): MilbOptions {
  const result = z
    .object({
      season: z.number().int().min(2005).max(2200),
      levels: z.array(z.enum(MILB_LEVEL_IDS as [MilbLevelId, ...MilbLevelId[]])).min(1),
      league: z.number().int().positive().optional(),
      team: z.number().int().positive().optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      mode: z.enum(["all", "structure", "games"]).optional(),
      rosterType: z.enum(["fullSeason", "active"]).optional(),
      gameTypes: z.array(z.enum(MILB_GAME_TYPES)).min(1).optional(),
      knownComplete: z.array(z.number().int().positive()).optional(),
      refetchWindowDays: z.number().int().min(0).max(60).optional(),
      concurrency: z.number().int().min(1).max(8).optional(),
      baseUrl: z.url().optional(),
      recordDir: z.string().min(1).optional(),
    })
    .strict()
    .parse(options);
  if (new Set(result.levels).size !== result.levels.length)
    throw new Error("Duplicate MiLB level");
  if (result.from && result.to && result.from > result.to)
    throw new Error("--from must not be after --to");
  for (const date of [result.from, result.to])
    if (date && Number(date.slice(0, 4)) !== result.season)
      throw new Error("Date bounds must belong to the selected season");
  return result;
}

export const sportIdsFor = (levels: MilbLevelId[]) =>
  levels.map((l) => MILB_LEVELS[l].sportId);
