import Link from "next/link";
import { notFound } from "next/navigation";
import {
  PageHeading,
  SectionTitle,
  Momentum,
} from "@/components/ui/primitives";
import { PerformanceExplorer } from "@/components/discovery/performance-explorer";
import { TeamTable } from "@/components/data/team-table";
import { NewsList } from "@/components/market/news-list";
import { PlayerLink, TeamLink } from "@/components/ui/entity-links";
import { prospectRepository } from "@/services/prospects";
export async function generateStaticParams() {
  return (await prospectRepository.listOrganizations()).map((o) => ({
    id: o.id,
  }));
}
export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const catalog = await prospectRepository.catalog();
  const org = catalog.organizations.find((o) => o.id === id);
  if (!org) notFound();
  const players = catalog.players.filter((p) => p.organizationId === id);
  const scoped = { ...catalog, players };
  const events = catalog.memberships
    .filter(
      (m) =>
        players.some((p) => p.id === m.playerId) &&
        m.assignmentType !== "assignment",
    )
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  return (
    <>
      <Link className="back-link" href="/organizations">
        ← Organizations
      </Link>
      <PageHeading
        title={org.name}
        eyebrow="Fictional parent organization"
        description="Affiliates, recent performers, and development context. AFL assignments retain this organization membership."
      />
      <PerformanceExplorer catalog={scoped} title="Organization performers" />
      <section className="page-section">
        <SectionTitle title="Affiliates" />
        <TeamTable
          teams={catalog.teams.filter((t) => t.organizationId === id)}
          catalog={catalog}
        />
      </section>
      <div className="two-columns">
        <section>
          <SectionTitle title="Demo risers" />
          <ul className="compact-player-list">
            {[...players]
              .sort((a, b) => b.momentum - a.momentum)
              .slice(0, 4)
              .map((p) => (
                <li key={p.id}>
                  <PlayerLink player={p} />
                  <span>{p.position}</span>
                  <Momentum value={p.momentum} />
                </li>
              ))}
          </ul>
        </section>
        <section>
          <SectionTitle title="Recent development movement" />
          {events.length ? (
            <ul className="transaction-list">
              {events.map((m) => (
                <li key={m.id}>
                  <time>{m.startsOn}</time>
                  <div>
                    <PlayerLink
                      player={players.find((p) => p.id === m.playerId)!}
                    />
                    <p>
                      {m.assignmentType === "afl-assignment"
                        ? "Fall assignment"
                        : "Promotion"}{" "}
                      ·{" "}
                      <TeamLink
                        team={catalog.teams.find((t) => t.id === m.teamId)!}
                        full
                      />
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">
              No promotion examples for this organization.
            </p>
          )}
        </section>
      </div>
      <section className="page-section">
        <SectionTitle title="Organization news" />
        <NewsList
          items={catalog.news.filter((n) => n.organizationIds.includes(id))}
          catalog={catalog}
        />
      </section>
      <p className="table-note">
        Roster samples are intentionally small. Organizational depth charts
        require complete, verified rosters and are not inferred from these demo
        records.
      </p>
    </>
  );
}
