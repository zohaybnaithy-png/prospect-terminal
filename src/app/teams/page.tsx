import Link from "next/link";
import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import { PageHeading, TeamMark } from "@/components/ui/primitives";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "Teams" };
export default async function TeamsPage() {
  const [teams, players] = await Promise.all([
    prospectRepository.listTeams(),
    prospectRepository.listPlayers(),
  ]);
  return (
    <>
      <PageHeading
        title="Across the diamond"
        description="Four invented programs. One development universe. Explore fictional rosters and player profiles."
      />
      <div className="team-grid">
        {teams.map((team) => (
          <Link
            href={`/teams/${team.id}`}
            className="panel team-card"
            key={team.id}
          >
            <div>
              <TeamMark abbreviation={team.abbreviation} color={team.color} />
              <ArrowUpRight size={20} />
            </div>
            <p className="eyebrow">{team.level} / FICTIONAL TEAM</p>
            <h2>{team.name}</h2>
            <p>{team.conference}</p>
            <div className="team-card-bottom">
              <span>
                {players.filter((p) => p.teamId === team.id).length} demo
                prospects
              </span>
              <span>View roster →</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
