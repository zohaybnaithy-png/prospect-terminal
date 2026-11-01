import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeading, SectionTitle } from "@/components/ui/primitives";
import { PerformanceExplorer } from "@/components/discovery/performance-explorer";
import { NewsList } from "@/components/market/news-list";
import { TeamTable } from "@/components/data/team-table";
import { prospectRepository } from "@/services/prospects";
export async function generateStaticParams() {
  return (await prospectRepository.listContexts()).map((c) => ({
    slug: c.slug,
  }));
}
export default async function LeaguePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const catalog = await prospectRepository.catalog();
  const context = catalog.contexts.find((c) => c.slug === slug);
  if (!context) notFound();
  const teams = catalog.teams.filter((t) => t.contextId === context.id);
  const playerIds = catalog.players
    .filter((p) => teams.some((t) => t.id === p.teamId))
    .map((p) => p.id);
  return (
    <>
      <Link className="back-link" href="/leagues">
        ← Leagues & levels
      </Link>
      <PageHeading
        title={context.name}
        description={
          slug === "afl"
            ? "Fictional AFL-style assignments across multiple organizations. Players retain their underlying parent organization and affiliate membership."
            : "Recent performers and development context within this level. All players, statistics, and ordering are fictional."
        }
      />
      <PerformanceExplorer
        catalog={catalog}
        initial={{ context: slug }}
        lockedContext
        title={`${context.shortName} performers`}
      />
      <section className="page-section">
        <SectionTitle title="Teams in this context" />
        <TeamTable teams={teams} catalog={catalog} />
      </section>
      <section className="page-section">
        <SectionTitle title="Related news" />
        <NewsList
          items={catalog.news.filter((n) =>
            n.playerIds.some((id) => playerIds.includes(id)),
          )}
          catalog={catalog}
        />
      </section>
    </>
  );
}
