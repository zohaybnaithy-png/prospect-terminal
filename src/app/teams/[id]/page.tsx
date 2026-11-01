import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeading, SectionTitle } from "@/components/ui/primitives";
import { OrganizationLink, ContextLink } from "@/components/ui/entity-links";
import { PerformanceExplorer } from "@/components/discovery/performance-explorer";
import { NewsList } from "@/components/market/news-list";
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
  const catalog = await prospectRepository.catalog();
  const team = catalog.teams.find((t) => t.id === id);
  if (!team) notFound();
  const context = catalog.contexts.find((c) => c.id === team.contextId)!;
  const org = catalog.organizations.find((o) => o.id === team.organizationId);
  return (
    <>
      <Link className="back-link" href="/teams">
        ← Affiliates & fall teams
      </Link>
      <PageHeading
        title={team.name}
        eyebrow="Fictional team"
        description="Current playing roster and recent performance. Historical affiliations and concurrent fall assignments are retained on individual player pages."
      />
      <div className="context-line">
        <ContextLink context={context} />
        {org ? (
          <OrganizationLink organization={org} full />
        ) : (
          <span>Fall roster · multiple parent organizations</span>
        )}
      </div>
      <PerformanceExplorer
        catalog={{
          ...catalog,
          players: catalog.players.filter((p) => p.teamId === id),
        }}
        initial={{ context: context.slug }}
        lockedContext
        title="Current playing roster"
      />
      <section className="page-section">
        <SectionTitle title="Team news" />
        <NewsList
          items={catalog.news.filter((n) => n.teamIds.includes(id))}
          catalog={catalog}
        />
      </section>
    </>
  );
}
