import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { PlayerExplorer } from "@/components/market/player-explorer";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "Screener" };
export default async function ScreenerPage() {
  const [players, teams] = await Promise.all([
    prospectRepository.listPlayers(),
    prospectRepository.listTeams(),
  ]);
  return (
    <>
      <PageHeading
        title="Find your signal"
        eyebrow="PROSPECT SCREENER / PREVIEW"
        description="An initial set of filters for the fictional dataset. Advanced screening will follow verified data ingestion."
      />
      <PlayerExplorer players={players} teams={teams} screener />
    </>
  );
}
