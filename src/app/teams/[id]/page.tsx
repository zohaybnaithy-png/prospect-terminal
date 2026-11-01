import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeading } from "@/components/ui/primitives";
import { PlayerTable } from "@/components/market/player-table";
import { prospectRepository } from "@/services/prospects";
export async function generateStaticParams() {
  return (await prospectRepository.listTeams()).map((t) => ({ id: t.id }));
}
export default async function TeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const team = await prospectRepository.findTeam(id);
  if (!team) notFound();
  const [players, teams] = await Promise.all([
    prospectRepository.listPlayers(),
    prospectRepository.listTeams(),
  ]);
  return (
    <>
      <Link href="/teams" className="back-link">
        <ArrowLeft size={14} /> All teams
      </Link>
      <PageHeading
        title={team.name}
        eyebrow="FICTIONAL TEAM / 2026"
        description={`${team.conference} · ${team.level} · Development roster only, not a complete real-world roster.`}
      />
      <section className="panel">
        <PlayerTable
          players={players.filter((p) => p.teamId === id)}
          teams={teams}
        />
      </section>
    </>
  );
}
