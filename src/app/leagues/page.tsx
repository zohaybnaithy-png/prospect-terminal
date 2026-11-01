import type { Metadata } from "next";
import Link from "next/link";
import { PageHeading } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/data-table";
import { PlayerLink } from "@/components/ui/entity-links";
import { prospectRepository } from "@/services/prospects";
import { discoverDemoPlayers, defaultFilters } from "@/services/discovery";
export const metadata: Metadata = { title: "Leagues & levels" };
export default async function LeaguesPage() {
  const catalog = await prospectRepository.catalog();
  return (
    <>
      <PageHeading
        title="Leagues & levels"
        description="Find performers within a developmental context. AFL is a fall-league assignment, not a replacement for a player’s parent organization or a rung above Triple-A."
      />
      <DataTable
        rows={catalog.contexts}
        rowKey={(c) => c.id}
        caption="Development levels and fall-league context"
        columns={[
          {
            key: "name",
            label: "Level / league",
            render: (c) => <Link href={`/leagues/${c.slug}`}>{c.name}</Link>,
          },
          {
            key: "kind",
            label: "Context",
            render: (c) =>
              c.kind === "league" ? "Fall league" : "Affiliated level",
          },
          {
            key: "players",
            label: "Current demo players",
            numeric: true,
            render: (c) =>
              catalog.players.filter(
                (p) =>
                  catalog.teams.find((t) => t.id === p.teamId)?.contextId ===
                  c.id,
              ).length,
          },
          {
            key: "watch",
            label: "14D player to watch",
            render: (c) => {
              const p = discoverDemoPlayers(catalog, {
                ...defaultFilters,
                context: c.slug,
              })[0];
              return p ? <PlayerLink player={p} /> : "—";
            },
          },
        ]}
      />
    </>
  );
}
