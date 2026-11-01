import type { Metadata } from "next";
import Link from "next/link";
import { PageHeading } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/data-table";
import { OrganizationLink, PlayerLink } from "@/components/ui/entity-links";
import { prospectRepository } from "@/services/prospects";
import { discoverDemoPlayers, defaultFilters } from "@/services/discovery";
export const metadata: Metadata = { title: "Organizations" };
export default async function OrganizationsPage() {
  const catalog = await prospectRepository.catalog();
  return (
    <>
      <PageHeading
        title="Organizations"
        description="Farm-system context for the players you discover. These three invented parent organizations stand in for future MLB organizations; no real club is represented."
      />
      <div className="section-heading">
        <h2>Demo farm systems</h2>
        <Link href="/teams">All affiliates & fall teams →</Link>
      </div>
      <DataTable
        rows={catalog.organizations}
        rowKey={(o) => o.id}
        caption="Fictional parent organizations"
        columns={[
          {
            key: "organization",
            label: "Organization",
            render: (o) => <OrganizationLink organization={o} full />,
          },
          {
            key: "affiliates",
            label: "Affiliates",
            numeric: true,
            render: (o) =>
              catalog.teams.filter((t) => t.organizationId === o.id).length,
          },
          {
            key: "players",
            label: "Demo players",
            numeric: true,
            render: (o) =>
              catalog.players.filter((p) => p.organizationId === o.id).length,
          },
          {
            key: "watch",
            label: "14D player to watch",
            render: (o) => {
              const p = discoverDemoPlayers(catalog, {
                ...defaultFilters,
                organization: o.id,
              })[0];
              return p ? <PlayerLink player={p} /> : "—";
            },
          },
        ]}
      />
      <p className="table-note">
        Organization membership follows the player across affiliates and
        fall-league assignments. Organization pages are context, not the
        starting point for discovery.
      </p>
    </>
  );
}
