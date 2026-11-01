import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { PlayerExplorer } from "@/components/market/player-explorer";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "Players" };
export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const [players, teams, params] = await Promise.all([
    prospectRepository.listPlayers(),
    prospectRepository.listTeams(),
    searchParams,
  ]);
  const sort = ["grade", "momentum", "falling"].includes(params.sort ?? "")
    ? params.sort
    : "grade";
  return (
    <>
      <PageHeading
        title="The next wave"
        description="Explore the development player universe. Every name, stat, and score below is fictional."
      />
      <PlayerExplorer
        key={`${params.q}-${sort}`}
        players={players}
        teams={teams}
        initialQuery={typeof params.q === "string" ? params.q : ""}
        initialSort={sort}
      />
    </>
  );
}
