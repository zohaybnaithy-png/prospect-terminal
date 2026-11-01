import type { Catalog, Team } from "@/types/baseball";
import { DataTable } from "@/components/ui/data-table";
import {
  TeamLink,
  OrganizationLink,
  ContextLink,
} from "@/components/ui/entity-links";
export function TeamTable({
  teams,
  catalog,
}: {
  teams: Team[];
  catalog: Catalog;
}) {
  return (
    <DataTable
      rows={teams}
      rowKey={(t) => t.id}
      caption="Fictional affiliates and fall-league teams"
      columns={[
        {
          key: "name",
          label: "Team",
          render: (t) => <TeamLink team={t} full />,
        },
        {
          key: "level",
          label: "Level / league",
          render: (t) => (
            <ContextLink
              context={catalog.contexts.find((c) => c.id === t.contextId)!}
            />
          ),
        },
        {
          key: "organization",
          label: "Parent organization",
          render: (t) =>
            t.organizationId ? (
              <OrganizationLink
                organization={catalog.organizations.find(
                  (o) => o.id === t.organizationId,
                )!}
                full
              />
            ) : (
              <span className="muted">Multi-organization fall team</span>
            ),
        },
        {
          key: "roster",
          label: "Current demo players",
          numeric: true,
          render: (t) =>
            catalog.players.filter((p) => p.teamId === t.id).length,
        },
      ]}
    />
  );
}
