/** Explicit opt-in seed. Uses only isolated fictional fixtures; never called at startup. */
import { eq } from "drizzle-orm";
import { getDatabase, closeDatabase } from "../src/db/client";
import * as s from "../src/db/schema";
import {
  players,
  teams,
  news,
  organizations,
  contexts,
  memberships,
  organizationMemberships,
  demoId,
  DEMO_AS_OF,
} from "../src/data/demo";
const seasonId = (year: number) =>
  year === 2026 ? demoId(203) : demoId(700 + year - 2020);
async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Fictional seed is restricted to development databases.");
  if (process.env.ALLOW_DEMO_SEED !== "true")
    throw new Error(
      "Set ALLOW_DEMO_SEED=true after checking DATABASE_URL points to a disposable development database.",
    );
  const db = getDatabase();
  await db.transaction(async (tx) => {
    // Never silently relabel the previous NCAA demo's historical statistics.
    const legacy = await tx
      .select({ id: s.leagues.id })
      .from(s.leagues)
      .where(eq(s.leagues.slug, "demo-ncaa"));
    if (legacy.length)
      throw new Error(
        "Legacy NCAA demo found. Use a fresh disposable development database for the MiLB fixtures; existing records have not been changed.",
      );
    await tx
      .insert(s.organizations)
      .values(
        organizations.map((o) => ({
          ...o,
          slug: `demo-${o.abbreviation.toLowerCase()}`,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.leagues)
      .values([
        {
          id: demoId(601),
          name: "MiLB (fictional development universe)",
          slug: "demo-milb",
        },
        {
          id: demoId(602),
          name: "Arizona Fall League (fictional rosters)",
          slug: "demo-afl",
        },
      ])
      .onConflictDoNothing();
    await tx
      .insert(s.levels)
      .values(
        contexts.map((c) => ({
          id: c.id,
          name: c.kind === "league" ? "Fall developmental assignment" : c.name,
          slug: `demo-${c.slug}`,
          leagueId: demoId(c.slug === "afl" ? 602 : 601),
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.seasons)
      .values(
        [2024, 2025, 2026].map((year) => ({
          id: seasonId(year),
          year,
          name: "Fictional development season",
          startsOn: `${year}-01-01`,
          endsOn: `${year}-12-31`,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.teams)
      .values(
        teams.map((t) => ({
          id: t.id,
          name: t.name,
          abbreviation: t.abbreviation,
          slug: `demo-${t.abbreviation.toLowerCase()}`,
          levelId: t.contextId,
          organizationId: t.organizationId,
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
          birthDate: p.birthDate,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(s.playerOrganizationMemberships)
      .values(organizationMemberships)
      .onConflictDoNothing();
    await tx
      .insert(s.playerTeamMemberships)
      .values(
        memberships.map(({ season, ...m }) => ({
          ...m,
          seasonId: seasonId(season),
        })),
      )
      .onConflictDoNothing();
    const batting = players.flatMap((p) =>
      p.seasonStats
        .filter((line) => line.batting)
        .map((line) => ({
          playerId: p.id,
          teamId: line.teamId,
          seasonId: seasonId(line.season),
          ...line.batting!,
          plateAppearances:
            line.batting!.atBats +
            line.batting!.walks +
            line.batting!.hitByPitch +
            line.batting!.sacrificeFlies,
        })),
    );
    const pitching = players.flatMap((p) =>
      p.seasonStats
        .filter((line) => line.pitching)
        .map((line) => ({
          playerId: p.id,
          teamId: line.teamId,
          seasonId: seasonId(line.season),
          ...line.pitching!,
          battersFaced:
            line.pitching!.outsRecorded +
            line.pitching!.hitsAllowed +
            line.pitching!.walks,
        })),
    );
    await tx
      .insert(s.playerBattingSeasons)
      .values(batting)
      .onConflictDoNothing();
    await tx
      .insert(s.playerPitchingSeasons)
      .values(pitching)
      .onConflictDoNothing();
    await tx
      .insert(s.prospectScores)
      .values(
        players.map((p) => ({
          playerId: p.id,
          prospectGrade: String(p.grade),
          momentum: String(p.momentum),
          modelVersion: "fictional-milb-demo-v1",
          explanation: p.note,
          observedAt: new Date(`${DEMO_AS_OF}T12:00:00Z`),
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
            modelVersion: "fictional-milb-demo-v1",
            observedAt: new Date(`${h.date}T12:00:00Z`),
          })),
        ),
      )
      .onConflictDoNothing();
    const storyIds = news.map((_, i) => demoId(301 + i));
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
    `Fictional MiLB seed complete: ${organizations.length} organizations, ${teams.length} teams, ${players.length} players, dated organization/team memberships, team-stint statistics, score history, and ${news.length} stories. Repeated execution preserves existing records.`,
  );
}
main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "Seed failed");
    process.exitCode = 1;
  })
  .finally(closeDatabase);
