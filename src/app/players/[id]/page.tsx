import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { prospectRepository } from "@/services/prospects";
import { getAflData } from "@/services/afl";
import { playerProfile } from "@/services/afl/read-model";
import { playerAnalyticsView } from "@/analytics/views";
import { AflDataNotice } from "@/components/afl/data-notice";
import { AflPlayerProfileView } from "@/components/player/afl-profile";
import { DemoPlayerProfile } from "@/components/player/demo-profile";

/**
 * Real AFL players (internal UUIDs from the database) render the AFL profile. Fictional demo
 * fixture IDs, still linked from demo news/highlights/Top Prospects, render the demo profile.
 */
async function resolve(id: string) {
  if (await prospectRepository.findPlayer(id)) return { kind: "demo" as const };
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
  const demo = await prospectRepository.findPlayer(id);
  if (demo) return { title: `${demo.name} — Player profile` };
  const r = await resolve(id);
  if (r.kind === "afl")
    return { title: `${r.profile.player.name} — AFL player profile` };
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
    case "demo":
      return <DemoPlayerProfile id={id} />;
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
            ← Player directory
          </Link>
          <AflDataNotice status={r.status} />
        </>
      );
    default:
      notFound();
  }
}
