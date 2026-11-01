/** Explicit opt-in seed for a development database; never called by app startup. */
import { getDatabase, closeDatabase } from "../src/db/client";
import * as s from "../src/db/schema";
import { players, teams, news, DEMO_SEASON } from "../src/data/demo";
const leagueId = "00000000-0000-4000-8000-000000000201";
const levelId = "00000000-0000-4000-8000-000000000202";
const seasonId = "00000000-0000-4000-8000-000000000203";
const conferenceIds = [
  "00000000-0000-4000-8000-000000000204",
  "00000000-0000-4000-8000-000000000205",
];
async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Fictional seed is restricted to development databases.");
  if (process.env.ALLOW_DEMO_SEED !== "true")
    throw new Error(
      "Set ALLOW_DEMO_SEED=true after verifying DATABASE_URL points to a disposable development database.",
    );
  const db = getDatabase();
  await db.transaction(async (tx) => {
    await tx
      .insert(s.leagues)
      .values({
        id: leagueId,
        name: "NCAA (fictional development universe)",
        slug: "demo-ncaa",
      })
      .onConflictDoNothing();
    await tx
      .insert(s.levels)
      .values({ id: levelId, leagueId, name: "NCAA D1", slug: "demo-ncaa-d1" })
      .onConflictDoNothing();
    await tx
      .insert(s.conferences)
      .values(
        conferenceIds.map((id, i) => ({
          id,
          leagueId,
          name: ["Aurora Conference", "Horizon Conference"][i],
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.seasons)
      .values({
        id: seasonId,
        year: DEMO_SEASON,
        name: "Fictional development season",
        startsOn: "2026-02-01",
        endsOn: "2026-06-30",
      })
      .onConflictDoNothing();
    await tx
      .insert(s.teams)
      .values(
        teams.map((team, i) => ({
          id: team.id,
          levelId,
          conferenceId: conferenceIds[i < 2 ? 0 : 1],
          name: team.name,
          slug: team.abbreviation.toLowerCase(),
          abbreviation: team.abbreviation,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.players)
      .values(
        players.map((p) => ({
          id: p.id,
          name: p.name,
          primaryPosition: p.position === "RHP / DH" ? "RHP" : p.position,
          secondaryPosition: p.position === "RHP / DH" ? "DH" : null,
          bats: p.bats,
          throws: p.throws,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.playerTeamMemberships)
      .values(
        players.map((p) => ({
          playerId: p.id,
          teamId: p.teamId,
          seasonId,
          startsOn: "2026-02-01",
        })),
      )
      .onConflictDoNothing();
    const hitters = players.filter((p) => p.batting);
    await tx
      .insert(s.playerBattingSeasons)
      .values(
        hitters.map((p) => ({
          playerId: p.id,
          teamId: p.teamId,
          seasonId,
          ...p.batting!,
          plateAppearances: p.batting!.atBats + p.batting!.walks,
        })),
      )
      .onConflictDoNothing();
    const pitchers = players.filter((p) => p.pitching);
    await tx
      .insert(s.playerPitchingSeasons)
      .values(
        pitchers.map((p) => ({
          playerId: p.id,
          teamId: p.teamId,
          seasonId,
          ...p.pitching!,
          battersFaced: p.pitching!.outsRecorded + p.pitching!.walks,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.prospectScores)
      .values(
        players.map((p) => ({
          playerId: p.id,
          prospectGrade: String(p.grade),
          momentum: String(p.momentum),
          modelVersion: "fictional-demo-v1",
          explanation: p.note,
          observedAt: new Date("2026-04-18T12:00:00Z"),
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.prospectScoreHistory)
      .values(
        players.flatMap((p) =>
          p.history.map((h) => ({
            playerId: p.id,
            prospectGrade: String(h.grade),
            momentum: String(h.momentum),
            modelVersion: "fictional-demo-v1",
            observedAt: new Date(`${h.date}T12:00:00Z`),
          })),
        ),
      )
      .onConflictDoNothing();
    const storyIds = news.map(
      (_, i) => `00000000-0000-4000-8000-${String(301 + i).padStart(12, "0")}`,
    );
    await tx
      .insert(s.newsItems)
      .values(
        news.map((n, i) => ({
          id: storyIds[i],
          title: n.title,
          summary: n.summary,
          source: "FICTIONAL DEMO CONTENT",
          publishedAt: new Date(`${n.date}T12:00:00Z`),
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.newsItemPlayers)
      .values(
        news.flatMap((n, i) =>
          n.playerIds.map((playerId) => ({
            newsItemId: storyIds[i],
            playerId,
          })),
        ),
      )
      .onConflictDoNothing();
  });
  console.log(
    "Fictional demo seed complete: 4 teams, 18 players, season stats, 108 score observations, 3 news stories. Existing demo records preserved.",
  );
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Seed failed");
    process.exitCode = 1;
  })
  .finally(closeDatabase);
