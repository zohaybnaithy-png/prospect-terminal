import { z } from "zod";
export const MLB_SOURCE_ID = "mlb-stats-api";
export const AFL = { leagueId: 119, sportId: 17, defaultSeason: 2026 } as const;
export const DEFAULT_MLB_BASE_URL = "https://statsapi.mlb.com/api/v1/";
export interface MlbOptions {
  season: number;
  from?: string;
  to?: string;
  team?: number;
  mode?: "all" | "rosters" | "games";
  baseUrl?: string;
  recordDir?: string;
}
export function validateMlbOptions(options: MlbOptions): MlbOptions {
  const schema = z
    .object({
      season: z.number().int().min(1900).max(2200),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      team: z.number().int().positive().optional(),
      mode: z.enum(["all", "rosters", "games"]).optional(),
      baseUrl: z.url().optional(),
      recordDir: z.string().min(1).optional(),
    })
    .strict();
  const result = schema.parse(options);
  if (result.from && result.to && result.from > result.to)
    throw new Error("--from must not be after --to");
  for (const date of [result.from, result.to])
    if (date && Number(date.slice(0, 4)) !== result.season)
      throw new Error("Date bounds must belong to the selected season");
  return result;
}
export function mlbBaseUrl(override?: string): URL {
  const url = new URL(
    override ?? process.env.MLB_STATS_API_BASE_URL ?? DEFAULT_MLB_BASE_URL,
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "MLB API base must be HTTPS without credentials, query, or fragment",
    );
  url.pathname = url.pathname.replace(/\/?$/, "/");
  return url;
}
