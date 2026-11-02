import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  games,
  seasons,
  playerBattingGames,
  playerPitchingGames,
} from "../db/schema";
import { aggregateBatting, aggregatePitching, windowBounds } from "./aggregate";
import type { StatWindow } from "./aggregate";
/** Read stored, validated game lines only. No API requests or season-total double counting. */
export class GameStatisticsRepository {
  constructor(private readonly db: Pick<NodePgDatabase, "select">) {}
  async getPlayerBattingStats(playerId: string, options: StatWindow) {
    z.uuid().parse(playerId);
    const bounds = windowBounds(options);
    const gameDate = sql<string>`coalesce(${games.officialDate},(${games.startsAt} AT TIME ZONE 'UTC')::date)`;
    const rows = await this.db
      .select({ line: playerBattingGames })
      .from(playerBattingGames)
      .innerJoin(games, eq(games.id, playerBattingGames.gameId))
      .innerJoin(seasons, eq(seasons.id, games.seasonId))
      .where(
        and(
          eq(playerBattingGames.playerId, playerId),
          eq(games.leagueId, options.leagueId),
          eq(seasons.year, options.season),
          eq(games.status, "final"),
          eq(games.boxscoreComplete, true),
          gte(gameDate, bounds.from),
          lte(gameDate, bounds.to),
          options.teamId
            ? eq(playerBattingGames.teamId, options.teamId)
            : undefined,
        ),
      );
    return {
      ...aggregateBatting(rows.map((r) => r.line)),
      ...bounds,
      season: options.season,
      leagueId: options.leagueId,
      coverage: "ingested-complete-games-only" as const,
    };
  }
  async getPlayerPitchingStats(playerId: string, options: StatWindow) {
    z.uuid().parse(playerId);
    const bounds = windowBounds(options);
    const gameDate = sql<string>`coalesce(${games.officialDate},(${games.startsAt} AT TIME ZONE 'UTC')::date)`;
    const rows = await this.db
      .select({ line: playerPitchingGames })
      .from(playerPitchingGames)
      .innerJoin(games, eq(games.id, playerPitchingGames.gameId))
      .innerJoin(seasons, eq(seasons.id, games.seasonId))
      .where(
        and(
          eq(playerPitchingGames.playerId, playerId),
          eq(games.leagueId, options.leagueId),
          eq(seasons.year, options.season),
          eq(games.status, "final"),
          eq(games.boxscoreComplete, true),
          gte(gameDate, bounds.from),
          lte(gameDate, bounds.to),
          options.teamId
            ? eq(playerPitchingGames.teamId, options.teamId)
            : undefined,
        ),
      );
    return {
      ...aggregatePitching(rows.map((r) => r.line)),
      ...bounds,
      season: options.season,
      leagueId: options.leagueId,
      coverage: "ingested-complete-games-only" as const,
    };
  }
}
