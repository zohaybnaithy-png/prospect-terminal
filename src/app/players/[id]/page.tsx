import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getCompetitionData } from "@/services/competition";
import { playerLevels, profileLevel } from "@/services/competition/model";
import { playerProfile } from "@/services/afl/read-model";
import { levelById } from "@/services/players/levels";
import { playerAnalyticsView } from "@/analytics/views";
import { AflDataNotice } from "@/components/afl/data-notice";
import { AflPlayerProfileView } from "@/components/player/afl-profile";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Players are addressed by internal UUID — one identity across every level. `?level=` chooses
 * which level's statistics and Momentum the profile shows; by default the level of the player's
 * most recent completed game. Anything else is not found.
 */
const resolve = cache(resolveUncached);

/** Once per request: generateMetadata and the page both need it (React `cache` dedupes it). */
async function resolveUncached(id: string, requested: string | undefined) {
  if (!z.uuid().safeParse(id).success) return { kind: "missing" as const };
  const data = await getCompetitionData();
  if (data.status !== "ok")
    return { kind: "unavailable" as const, status: data.status };
  const presence = playerLevels(data.levels, id);
  const level = profileLevel(presence, requested);
  const ls = data.levels.find((l) => l.level === level);
  const profile = ls ? playerProfile(ls.snapshot, id) : null;
  return ls && profile
    ? { kind: "ok" as const, profile, snapshot: ls.snapshot, level: ls.level, presence }
    : { kind: "missing" as const };
}

const levelParam = async (searchParams: SearchParams) => {
  const v = (await searchParams).level;
  return typeof v === "string" ? v : undefined;
};

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const r = await resolve(id, await levelParam(searchParams));
  if (r.kind === "ok")
    return {
      title: r.profile.player.name,
      // One indexable URL per player: `?level=` variants consolidate on the query-free profile.
      alternates: { canonical: `/players/${id}` },
      description: `${r.profile.player.name} (${r.profile.row.position}) — ${levelById(r.level).label} statistics, recent games and Momentum.`,
    };
  return { title: r.kind === "missing" ? "Player not found" : "Player" };
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const r = await resolve(id, await levelParam(searchParams));
  switch (r.kind) {
    case "ok":
      return (
        <AflPlayerProfileView
          profile={r.profile}
          snapshot={r.snapshot}
          level={r.level}
          presence={r.presence}
          analytics={playerAnalyticsView(r.snapshot, id)}
        />
      );
    case "unavailable":
      return (
        <>
          <Link href="/players" className="back-link">
            ← Players
          </Link>
          <AflDataNotice status={r.status} />
        </>
      );
    default:
      notFound();
  }
}
