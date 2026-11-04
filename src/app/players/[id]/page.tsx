import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getAflData } from "@/services/afl";
import { playerProfile } from "@/services/afl/read-model";
import { playerAnalyticsView } from "@/analytics/views";
import { AflDataNotice } from "@/components/afl/data-notice";
import { AflPlayerProfileView } from "@/components/player/afl-profile";

/** Real AFL players are addressed by internal UUID; anything else is not found. */
async function resolve(id: string) {
  if (!z.uuid().safeParse(id).success) return { kind: "missing" as const };
  const data = await getAflData();
  if (data.status !== "ok")
    return { kind: "unavailable" as const, status: data.status };
  const profile = playerProfile(data.snapshot, id);
  return profile
    ? { kind: "afl" as const, profile, snapshot: data.snapshot }
    : { kind: "missing" as const };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const r = await resolve(id);
  if (r.kind === "afl")
    return {
      title: r.profile.player.name,
      description: `${r.profile.player.name} (${r.profile.row.position}) — AFL statistics, recent games and Momentum.`,
    };
  return { title: r.kind === "missing" ? "Player not found" : "Player" };
}

export default async function PlayerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const r = await resolve(id);
  switch (r.kind) {
    case "afl":
      return (
        <AflPlayerProfileView
          profile={r.profile}
          snapshot={r.snapshot}
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
